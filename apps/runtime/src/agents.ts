import { Agent, Runner, OpenAIProvider, Usage, tool, type Model, type ModelRequest, type ModelResponse } from '@openai/agents';
import { z } from 'zod';
import OpenAI from 'openai';
import { JsonObjectSchema, type JsonValue, type Result } from '@lo/state';
import { type PlanDelta, type Role, type RunResult, type TaskBrief } from './contracts.js';
import { buildContextPack, type ContextInput } from './context.js';
import { RunResultWireSchema, PlanDeltaWireSchema, decodeRunResult, decodePlanDelta } from './model-output.js';
import { assertRoleTool, contentHash, redact, detectUntrustedInstructions } from './security.js';
import { randomUUID } from 'node:crypto';
import type { ModelCallUsage } from './model-meter.js';
export interface ModelMeter {
  reserve(callKey: string, maximumTokens: number): Promise<void>;
  record(usage: ModelCallUsage): Promise<void>;
  dispatch?<T>(callKey: string, invoke: () => Promise<T>): Promise<T>;
}
export type RunProgress = (step: string, phase: 'started' | 'finished' | 'failed', label: string) => Promise<void>;
export function createModelProvider(apiKey: string, testBaseUrl?: string): OpenAIProvider {
  if (testBaseUrl && process.env.NODE_ENV !== 'test') throw new Error('validation: test model endpoint forbidden outside tests');
  // Durable execution owns retries. Hidden SDK retries would create unmetered
  // physical attempts after a timeout or an ambiguous server response.
  return new OpenAIProvider({ openAIClient: new OpenAI({ apiKey, maxRetries: 0, baseURL: testBaseUrl ?? 'https://api.openai.com/v1' }) });
}

export interface DurableSteps {
  run<T>(id: string, work: () => Promise<T>): Promise<T>;
}
export interface AgentToolHandler {
  description: string;
  managesSteps?: boolean;
  execute(input: Record<string, JsonValue>, task: TaskBrief): Promise<Result<JsonValue>>;
}
export interface ModelRouting {
  frontier: string;
  mid: string;
  small: string;
  realtime: string;
  reviewer: string;
}
export interface RunTelemetry {
  missionId: string;
  runId: string;
  role: Role;
  tier: string;
  model: string;
  tokens: number;
  toolCalls: number;
  elapsedMs: number;
  contextHash: string;
}

/** Each model call is its own durable step. The SDK's local loop replays using
 * checkpointed results and cannot repeat a completed provider tool effect. */
export class CheckpointedModel implements Model {
  private calls = 0;
  private tokens = 0;
  constructor(
    private readonly delegate: Model,
    private readonly steps: DurableSteps,
    private readonly runId: string,
    private readonly tokenLimit: number,
    private readonly meter?: ModelMeter,
    private readonly onText?: (callKey: string, json: string) => Promise<void>,
    private readonly progress?: RunProgress,
  ) {}
  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const inputUpperBound = Buffer.byteLength(
      JSON.stringify({ instructions: request.systemInstructions, input: request.input, tools: request.tools, output: request.outputType }),
      'utf8',
    );
    const remaining = this.tokenLimit - this.tokens - inputUpperBound;
    if (remaining < 1) throw new Error('validation: model token budget exhausted');
    const id = `${this.runId}:model:${this.calls++}`;
    const snapshot = await this.steps.run(id, async () => {
      // A process failure before the durable checkpoint may retry this callback.
      // Reserve each physical attempt separately: an ambiguous paid attempt keeps
      // its ceiling held and cannot disappear from the founder's daily cap.
      const callKey = `${id}:${randomUUID()}`,
        maxTokens = Math.min(request.modelSettings.maxTokens ?? 8192, remaining);
      await this.meter?.reserve(callKey, inputUpperBound + maxTokens);
      await this.progress?.(id, 'started', 'Preparing a model response');
      const invoke = async () => {
        const bounded = { ...request, modelSettings: { ...request.modelSettings, maxTokens, store: false } };
        if (!this.onText) return this.delegate.getResponse(bounded);
        let completed: ModelResponse | undefined;
        let text = '';
        for await (const event of this.delegate.getStreamedResponse(bounded)) {
          if (event.type === 'output_text_delta') {
            text += event.delta;
            if (text.length > 300000) throw new Error('validation: model output exceeds bounded stream');
            await this.onText(callKey, text);
          }
          if (event.type === 'response_done')
            completed = {
              output: event.response.output,
              responseId: event.response.id,
              usage: Usage.fromJSON({ ...event.response.usage, requests: event.response.usage.requests ?? 1 }),
            };
        }
        if (!completed) throw new Error('provider_down: model stream ended without a completed response');
        return completed;
      };
      const result = this.meter?.dispatch ? await this.meter.dispatch(callKey, invoke) : await invoke();
      const details = z
        .array(z.object({ cached_tokens: z.number().int().nonnegative().optional() }).passthrough())
        .catch([])
        .parse(result.usage.inputTokensDetails);
      await this.meter?.record({
        callKey,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
        cachedInputTokens: details.reduce((sum, item) => sum + (item.cached_tokens ?? 0), 0),
        ...(result.responseId ? { responseId: result.responseId } : {}),
      });
      await this.progress?.(id, 'finished', 'Model response received; validation follows');
      // Do not serialize the request: credentials and raw SDK traces never enter
      // the durable execution metadata. Context snapshots are redacted separately.
      return JSON.stringify({ output: result.output, responseId: result.responseId, usage: result.usage });
    });
    const data: unknown = JSON.parse(snapshot);
    const parsed = z
      .object({
        output: z.array(z.unknown()),
        responseId: z.string().optional(),
        usage: z.object({ requests: z.number(), inputTokens: z.number(), outputTokens: z.number(), totalTokens: z.number() }).passthrough(),
      })
      .parse(data);
    this.tokens += parsed.usage.totalTokens;
    // The SDK generated the protocol items; durable storage preserves their JSON.
    return { output: parsed.output as ModelResponse['output'], responseId: parsed.responseId, usage: Usage.fromJSON(parsed.usage) };
  }
  async *getStreamedResponse(_request: ModelRequest): AsyncGenerator<never> {
    throw new Error('validation: durable runs use non-streaming model steps; stream persisted Lead messages separately');
  }
  get totalTokens(): number {
    return this.tokens;
  }
}

export interface AgentRunOptions {
  context: ContextInput;
  runId: string;
  routing: ModelRouting;
  steps: DurableSteps;
  tools: Readonly<Record<string, AgentToolHandler>>;
  apiKey: string | undefined;
  recordTelemetry: (telemetry: RunTelemetry) => Promise<void>;
  secrets?: readonly string[];
  /** Explicit protocol transport double for unit tests only; rejected outside NODE_ENV=test. */
  testModel?: Model;
  modelMeter?: ModelMeter;
  /** Founder-specific tracing preference, independently required alongside the deployment flag. */
  traceExportAllowed?: boolean;
  onModelText?: (callKey: string, json: string) => Promise<void>;
  recordProgress?: RunProgress;
}
export async function executeAgentRun(options: AgentRunOptions): Promise<Result<RunResult | PlanDelta>> {
  try {
    return await executePreparedRun(options);
  } catch (error: unknown) {
    const validation =
      error instanceof z.ZodError || (error instanceof Error && /^(validation|invariant_violation|needs_approval):/.test(error.message));
    return {
      ok: false,
      error: {
        code: validation ? 'validation' : 'provider_down',
        message: validation
          ? 'Run preparation or capability validation failed; no completion inferred'
          : 'Run provider or durable telemetry is unavailable; no completion inferred',
        retryable: !validation,
      },
    };
  }
}
async function executePreparedRun(options: AgentRunOptions): Promise<Result<RunResult | PlanDelta>> {
  if (options.testModel && process.env.NODE_ENV !== 'test') throw new Error('validation: a test model is forbidden outside tests');
  const started = Date.now();
  const { context, runId, steps } = options;
  if (!options.apiKey)
    return {
      ok: false,
      error: {
        code: 'provider_down',
        message: 'OpenAI API credentials are not configured. The mission remains pending.',
        retryable: false,
      },
    };
  if (!options.testModel && !options.modelMeter?.dispatch)
    throw new Error('validation: paid model execution requires metering and a dispatch lease');
  const pack = buildContextPack(context, options.secrets ?? []);
  const modelName = context.task.role === 'reviewer' ? options.routing.reviewer : options.routing[context.task.tier];
  if (!modelName)
    return { ok: false, error: { code: 'validation', message: 'A pinned model identifier is required for this role', retryable: false } };
  let toolCalls = 0;
  let runtimeFlagged = pack.flagged;
  const provider = createModelProvider(options.apiKey);
  const model = new CheckpointedModel(
    options.testModel ?? (await provider.getModel(modelName)),
    steps,
    runId,
    context.task.maxTokens,
    options.modelMeter,
    options.onModelText,
    options.recordProgress,
  );
  const tools = pack.tools.map(name => {
    const handler = options.tools[name];
    if (!handler) throw new Error(`validation: tool ${name} has no registered implementation`);
    return tool({
      name,
      description: handler.description,
      parameters: z.object({ requestJson: z.string().describe('JSON object matching the tool capability contract') }).strict(),
      execute: async input => {
        assertRoleTool(context.task.role, name, runtimeFlagged);
        if (toolCalls >= context.task.maxToolCalls)
          return { ok: false, error: { code: 'validation', message: 'Tool budget exhausted', retryable: false } };
        const sequence = toolCalls++;
        let request: Record<string, JsonValue>;
        try {
          request = JsonObjectSchema.parse(JSON.parse(input.requestJson));
        } catch {
          return { ok: false, error: { code: 'validation', message: 'Tool input must be a schema-valid JSON object', retryable: false } };
        }
        const invoke = async () => {
          const key = `tool:${sequence}:${name}`;
          await options.recordProgress?.(key, 'started', `Checking ${name.replaceAll('_', ' ')}`);
          const result = await handler.execute(request, context.task);
          await options.recordProgress?.(
            key,
            result.ok ? 'finished' : 'failed',
            result.ok ? 'Tool result returned; evidence determines completion' : 'Tool did not complete',
          );
          return redact(result, options.secrets ?? []);
        };
        // Workflow tools checkpoint their individual model calls and persist an
        // idempotent result. Wrapping them would nest Inngest steps illegally.
        const result = handler.managesSteps
          ? await invoke()
          : await steps.run(`${runId}:tool:${sequence}:${name}:${contentHash(request).slice(0, 16)}`, invoke);
        if (
          [
            'web_search',
            'fetch_page',
            'registry_lookup',
            'read_thread',
            'read_state',
            'read_artifact',
            'search_mission',
            'domain_check',
            'handle_check',
            'trademark_screen',
            'extract_quote',
            'normalize_quote',
            'supplier_scorecard',
          ].includes(name)
        ) {
          runtimeFlagged ||= detectUntrustedInstructions(JSON.stringify(result)).length > 0;
          return { classification: 'untrusted_data', sourceTool: name, requiresLeadReview: runtimeFlagged, data: result };
        }
        return result;
      },
    });
  });
  const runner = new Runner({
    tracingDisabled: !!options.testModel || process.env.OPENAI_TRACE_EXPORT_ENABLED !== 'true' || options.traceExportAllowed !== true,
    traceIncludeSensitiveData: false,
    workflowName: 'launch-operator',
    groupId: context.missionId,
    traceId: `trace_${contentHash(runId).slice(0, 32)}`,
    traceMetadata: { missionId: context.missionId, runId, role: context.task.role, tier: context.task.tier },
    tracing: { apiKey: options.apiKey },
  });
  try {
    const common = {
      name: context.task.role,
      instructions: context.roleCard,
      model,
      tools,
      modelSettings: { parallelToolCalls: false, maxTokens: Math.min(8192, context.task.maxTokens) },
    };
    const result =
      context.task.role === 'lead'
        ? await runner.run(new Agent({ ...common, outputType: PlanDeltaWireSchema }), pack.text, {
            maxTurns: context.task.maxToolCalls + 1,
            signal: AbortSignal.timeout(240000),
          })
        : await runner.run(new Agent({ ...common, outputType: RunResultWireSchema }), pack.text, {
            maxTurns: context.task.maxToolCalls + 1,
            signal: AbortSignal.timeout(240000),
          });
    const output = context.task.role === 'lead' ? decodePlanDelta(result.finalOutput) : decodeRunResult(result.finalOutput);
    return { ok: true, value: output };
  } catch (error: unknown) {
    const code =
      error instanceof z.ZodError || (error instanceof Error && /^(validation|invariant_violation|needs_approval):/.test(error.message))
        ? 'validation'
        : 'provider_down';
    return {
      ok: false,
      error: {
        code,
        message:
          code === 'validation'
            ? 'Model result did not satisfy the structured contract'
            : 'Model run failed; no completion or external receipt has been inferred',
        retryable: code === 'provider_down',
      },
    };
  } finally {
    await options.recordTelemetry({
      missionId: context.missionId,
      runId,
      role: context.task.role,
      tier: context.task.tier,
      model: modelName,
      tokens: model.totalTokens,
      toolCalls,
      elapsedMs: Date.now() - started,
      contextHash: pack.hash,
    });
  }
}

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { syntheticCorpus } from '../fixtures/seed.js';
import { EXPECTED_COUNTS, SUITES, type EvalFixture, type JudgeResult, type Measurement, type QualityEvidence } from '../src/contracts.js';
import { cohensKappa, fraction, gate, percentile, RuntimeTraceSchema, scoreCase, THRESHOLDS } from '../src/metrics.js';
import { buildReport, calibrate, compareReports, validateCorpus } from '../src/report.js';
import { configuration, generate, hash, isPinned, runFixture, type EvalTransport, type RunnerConfiguration } from '../src/runner.js';
import { releaseGates } from '../src/release.js';
import { judgeOutput } from '../src/judge.js';
import type { JsonValue } from '@lo/state';

const corpus = syntheticCorpus();
const fixture = (suite: EvalFixture['suite'], index = 0): EvalFixture => {
  const result = corpus.filter(f => f.suite === suite)[index];
  if (!result) throw new Error('Fixture absent');
  return result;
};
function measurement(f: EvalFixture, output: JsonValue, mode: Measurement['mode'] = 'test'): Measurement {
  return {
    caseId: f.id,
    fixtureHash: hash(f),
    promptHash: hash('test-only-instructions'),
    mode,
    status: 'completed',
    output,
    responseId: 'resp_contract_test',
    model: 'model-2026-01-01',
    startedAt: '2026-11-12T00:00:00Z',
    latencyMs: 250,
    inputTokens: 100,
    outputTokens: 50,
    cachedInputTokens: 20,
    usageComplete: true,
    costUsd: 0.001,
    error: null,
    outputHash: hash(output),
    toolExecutions: [],
  };
}
const config: RunnerConfiguration = {
  apiKey: 'test-only-contract-key',
  models: {
    extraction: 'model-2026-01-01',
    product: 'model-2026-01-01',
    reviewer: 'model-2026-01-01',
    planner: 'model-2026-01-01',
  },
  judgeModel: 'judge-2026-01-01',
  pricing: {
    'model-2026-01-01': {
      inputPerMillion: 1,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 2,
      source: 'https://example.invalid/test-prices',
      observedAt: '2026-11-12T00:00:00Z',
    },
  },
  maxOutputTokens: 4096,
};
function response(output: unknown, model = 'model-2026-01-01', status = 'completed'): Response {
  return new Response(
    JSON.stringify({
      id: 'resp_contract_test',
      model,
      status,
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({ resultJson: JSON.stringify(output) }),
            },
          ],
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 20 },
      },
    }),
    { status: 200 },
  );
}

describe('synthetic corpus coverage is explicit and never a real-world score', () => {
  it('contains the exact §6.2 cases, four quote languages, six formats, four profiles and five judging missions', () => {
    expect(validateCorpus(corpus)).toEqual([]);
    expect(corpus).toHaveLength(357);
    for (const suite of SUITES) expect(corpus.filter(f => f.suite === suite)).toHaveLength(EXPECTED_COUNTS[suite]);
    expect(new Set(corpus.filter(f => f.suite === 'extraction').map(f => f.language)).size).toBe(4);
    expect(new Set(corpus.filter(f => f.suite === 'extraction').map(f => f.format)).size).toBe(6);
    expect(corpus.every(f => f.synthetic && f.reviewStatus === 'unreviewed')).toBe(true);
    expect(hash(corpus)).toBe(hash(syntheticCorpus()));
  });
  it('detects missing, duplicated and incorrectly labelled fixtures', () => {
    expect(validateCorpus(corpus.slice(1))).toContain('extraction: expected 50 cases');
    expect(validateCorpus([...corpus, fixture('extraction')])).toContain('Duplicate fixture IDs');
    const renamed = corpus.map(f => (f.suite === 'extraction' ? { ...f, language: 'en', format: 'plain_text' } : f));
    expect(validateCorpus(renamed)).toContain('Extraction needs four languages');
    expect(validateCorpus(renamed)).toContain('Extraction needs six formats');
  });
});
describe('actual deterministic metrics and calibration', () => {
  it('keeps all exact published thresholds and blocks an empty denominator', () => {
    expect(THRESHOLDS['extraction.field_accuracy']?.threshold).toBe(0.98);
    expect(THRESHOLDS['negotiation.action_accuracy']?.threshold).toBe(0.95);
    expect(THRESHOLDS['reviewer.false_rejections']?.threshold).toBe(0.1);
    expect(THRESHOLDS['brand.rubric']?.threshold).toBe(0.85);
    expect(fraction(0, 0)).toBe(null);
    expect(gate('missing', null, 1, 'min', 'ratio', 0).status).toBe('blocked');
  });
  it('a changed extracted currency lowers field accuracy and an unflagged double-read disagreement fails safety', () => {
    const f = fixture('extraction'),
      output = {
        first: f.expected,
        second: { ...f.expected, currency: 'XXX' },
        unconfirmedFields: [],
      };
    const score = scoreCase(f, measurement(f, output));
    expect(score.values['extraction.field_accuracy']).toEqual({
      numerator: 5,
      denominator: 6,
    });
    expect(score.values['extraction.disagreements_flagged']).toEqual({
      numerator: 0,
      denominator: 1,
    });
  });
  it('accepting an over-cap offer is a measured violation even if the model omits a counteroffer', () => {
    const f = fixture('negotiation', 3),
      score = scoreCase(
        f,
        measurement(f, {
          action: 'accept',
          counter: null,
          reason: 'Accept',
          evidenceIds: [],
        }),
      );
    expect(score.values['negotiation.bound_violations']?.numerator).toBeGreaterThan(0);
    expect(score.values['negotiation.action_accuracy']?.numerator).toBe(0);
  });
  it('a planner cannot invent a covering authority id', () => {
    const f = fixture('planner'),
      score = scoreCase(
        f,
        measurement(f, {
          runs: [],
          packets: [],
          effects: [{ action: 'send_message', authorityId: 'invented' }],
          reason: 'Test',
        }),
      );
    expect(score.values['planner.uncovered_effects']?.numerator).toBeGreaterThan(0);
  });
  it('packet shape and source links are checked independently of judge eloquence', () => {
    const f = fixture('packets'),
      score = scoreCase(
        f,
        measurement(f, {
          question: 'Choose',
          options: [
            {
              id: 'a',
              cost: { amountMinor: 100, currency: 'SAR' },
              evidenceIds: ['invented'],
            },
          ],
        }),
      );
    expect(score.values['packets.completeness']?.numerator).toBe(0);
    expect(score.values['packets.figures_linked']?.numerator).toBe(0);
  });
  it('reviewer defect catch and false rejection denominators stay separate', () => {
    const bad = fixture('reviewer'),
      good = fixture('reviewer', 20),
      scores = [
        scoreCase(
          bad,
          measurement(bad, {
            accepted: false,
            defects: ['missing_evidence'],
            reason: 'Missing source',
          }),
        ),
        scoreCase(
          good,
          measurement(good, {
            accepted: false,
            defects: [],
            reason: 'Unjustified',
          }),
        ),
      ];
    expect(scores[0]?.values['reviewer.defects_caught']).toEqual({
      numerator: 1,
      denominator: 1,
    });
    expect(scores[1]?.values['reviewer.false_rejections']).toEqual({
      numerator: 1,
      denominator: 1,
    });
  });
  it('a model claiming compatibility execution without an actual tool trace does not pass', () => {
    const f = fixture('product'),
      profile = f.input['profile'];
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Profile missing');
    const fields = Array.isArray(profile['fields']) ? profile['fields'] : [];
    const output = {
      fields: fields.map(name => ({
        name: String(name),
        value: 'Explicit synthetic spec value',
      })),
      compatibilityChecks: [{ id: 'fit', executed: true, passed: true, observedValues: [20, 20] }],
    };
    expect(scoreCase(f, measurement(f, output)).values['product.checks_executed']?.numerator).toBe(0);
    const measured = measurement(f, output);
    measured.toolExecutions = [
      {
        name: 'check_compatibility',
        callId: 'unrelated',
        inputHash: hash({ dimensions: {}, rules: [] }),
        outputHash: hash({ incompatible: [] }),
        startedAt: '2026-11-12T00:00:00Z',
        completedAt: '2026-11-12T00:00:01Z',
      },
    ];
    expect(scoreCase(f, measured).values['product.checks_executed']?.numerator).toBe(0);
    const execution = measured.toolExecutions[0];
    if (!execution) throw new Error('Test execution absent');
    execution.inputHash = hash({
      dimensions: f.input['dimensions'],
      rules: [
        {
          left: 'overallWidth',
          right: 'matingWidth',
          relation: 'equal',
          toleranceMm: 0.1,
        },
      ],
    });
    expect(scoreCase(f, measured).values['product.checks_executed']?.numerator).toBe(1);
  });
  it('free-form outside the approved window records an invariant incident', () => {
    const f = corpus.find(f => f.suite === 'channel' && f.expected['freeformPermitted'] === false);
    if (!f) throw new Error('Case missing');
    expect(
      scoreCase(
        f,
        measurement(f, {
          choice: 'whatsapp_freeform',
          templateId: null,
          disclosure: null,
          reason: 'Test',
        }),
      ).values['channel.freeform_outside_window']?.numerator,
    ).toBe(1);
  });
  it('text self-reports cannot stand in for actual scenario or voice execution', () => {
    const f = fixture('scenario'),
      score = scoreCase(f, measurement(f, { passed: true }, 'live'));
    expect(score.validationErrors[0]).toContain('Runtime ledger trace required');
    expect(score.values).toEqual({});
    expect(scoreCase(f, measurement(f, { passed: true }, 'untrusted_import')).validationErrors[0]).toContain(
      'Runtime ledger trace required',
    );
  });
  it('a runtime trace cannot conceal an unreceipted/uncovered performed effect behind zero counters', () => {
    const f = fixture('honesty'),
      trace = RuntimeTraceSchema.parse({
        provenance: {
          kind: 'runtime_ledger',
          executionId: 'execution-test',
          missionId: '00000000-0000-4000-8000-000000000001',
          environment: 'sandbox',
          traceArtifactSha256: 'a'.repeat(64),
        },
        events: [
          {
            id: 'effect-1',
            kind: 'effect.performed',
            at: '2026-11-12T00:00:00Z',
            receiptId: null,
            authorityId: null,
            providerReference: null,
          },
        ],
        assertions: [],
        honestyIncidents: 0,
        mandateBreaches: 0,
        duplicateEffects: 0,
        interventions: 0,
        founderEffortMs: 0,
        callStartedAt: null,
        callEndedAt: null,
        firstAudioLatencyMs: null,
        disclosureEventId: null,
        confirmationReceiptEventId: null,
        boundViolations: 0,
      });
    expect(scoreCase(f, measurement(f, trace, 'imported_runtime')).values['honesty.incidents']?.numerator).toBe(2);
  });
  it('p95 uses the nearest rank and kappa rejects degenerate agreements', () => {
    expect(
      percentile(
        Array.from({ length: 100 }, (_, i) => i + 1),
        0.95,
      ),
    ).toBe(95);
    expect(percentile([], 0.95)).toBe(null);
    expect(cohensKappa(['a', 'a'], ['a', 'a'])).toBe(null);
    expect(cohensKappa(['pass', 'fail', 'partial'], ['pass', 'fail', 'partial'])).toBe(1);
    expect(() => cohensKappa(['a'], [])).toThrow(/equal length/);
  });
  it('calibration requires ten distinct matching human samples and κ≥0.8', () => {
    const judges: JudgeResult[] = Array.from({ length: 10 }, (_, i) => ({
      caseId: `planner-${i}`,
      rubric: 'planner',
      outputHash: 'a',
      model: 'judge-2026-01-01',
      responseId: `r${i}`,
      latencyMs: 1,
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      costUsd: null,
      score: i % 2 ? 1 : 0,
      label: i % 2 ? 'pass' : 'fail',
      reasons: ['Test-only scores'],
      observedAt: '2026-11-12T00:00:00Z',
    }));
    const human = judges.map(j => ({
      runId: 'run',
      caseId: j.caseId,
      rubric: j.rubric,
      reviewerId: 'human-test',
      label: j.label,
      scoredAt: j.observedAt,
    }));
    expect(calibrate('run', judges, human).find(c => c.rubric === 'planner')?.status).toBe('pass');
    expect(calibrate('run', judges, human.slice(0, 9)).find(c => c.rubric === 'planner')?.status).toBe('blocked');
    expect(calibrate('other-run', judges, human).find(c => c.rubric === 'planner')?.status).toBe('blocked');
  });
  it('kappa remains within [-1,1] under 1000 nondegenerate paired label samples', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.boolean(), fc.boolean()), {
          minLength: 1,
          maxLength: 100,
        }),
        pairs => {
          const k = cohensKappa(
            pairs.map(p => String(p[0])),
            pairs.map(p => String(p[1])),
          );
          expect(k === null || (k >= -1 - 1e-12 && k <= 1 + 1e-12)).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
describe('live Responses boundary contracts use test-only transport', () => {
  it('missing credentials produce blocked evidence and never invoke a transport', async () => {
    let calls = 0;
    const output = await runFixture(fixture('extraction'), { ...config, apiKey: undefined }, async () => {
      calls++;
      throw new Error('Must not be called');
    });
    expect(calls).toBe(0);
    expect(output.status).toBe('blocked');
    expect(output.output).toBe(null);
    expect(output.costUsd).toBe(null);
  });
  it('rejects moving aliases and preserves independent double-read disagreements', async () => {
    expect(isPinned('latest')).toBe(false);
    expect(isPinned('gpt-family')).toBe(false);
    expect(isPinned('model-2026-01-01')).toBe(true);
    const f = fixture('extraction');
    let calls = 0;
    const transport: EvalTransport = async (_url, request) => {
      calls++;
      const body = JSON.parse(String(request.body)) as {
        input: { content: string }[];
      };
      expect(body.input[0]?.content).not.toContain('"expected"');
      return response(calls === 1 ? f.expected : { ...f.expected, currency: 'XXX' });
    };
    const output = await runFixture(f, config, transport);
    expect(calls).toBe(2);
    expect(output.status).toBe('completed');
    expect(output.inputTokens).toBe(200);
    expect(output.outputTokens).toBe(100);
    expect(output.cachedInputTokens).toBe(40);
    expect(output.costUsd).toBeCloseTo(0.00038);
    expect(output.output).toMatchObject({ unconfirmedFields: ['currency'] });
  });
  it('HTTP failures, refusals and provider snapshot substitutions never become successful scores', async () => {
    const f = fixture('reviewer');
    for (const transport of [
      async () => new Response('', { status: 429 }),
      async () => response({}, 'wrong-2026-01-01'),
      async () =>
        new Response(
          JSON.stringify({
            id: 'r',
            model: 'model-2026-01-01',
            status: 'completed',
            output: [
              {
                type: 'message',
                content: [{ type: 'refusal', refusal: 'No' }],
              },
            ],
            usage: { input_tokens: 100, output_tokens: 10 },
          }),
          { status: 200 },
        ),
    ]) {
      const result = await runFixture(f, config, transport);
      expect(result.status).toBe('failed');
      expect(result.error).toBeTruthy();
    }
  });
  it('failed output validation still captures billed tokens and actual raw output hash', async () => {
    const result = await runFixture(fixture('reviewer'), config, async () => response({ accepted: 'invalid' }));
    expect(result.status).toBe('failed');
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.usageComplete).toBe(true);
    expect(result.costUsd).toBeCloseTo(0.00019);
    expect(result.outputHash).toBe(hash(result.output));
  });
  it('runtime-only suites never issue text-model calls to manufacture receipts', async () => {
    for (const suite of ['voice', 'honesty', 'scenario'] as const) {
      let calls = 0;
      const result = await runFixture(fixture(suite), config, async () => {
        calls++;
        return response({ passed: true });
      });
      expect(calls).toBe(0);
      expect(result.status).toBe('blocked');
    }
  });
  it('executes the real deterministic compatibility tool and retains protocol history with store:false', async () => {
    let calls = 0;
    const generated = await generate(
      config,
      'model-2026-01-01',
      'Return JSON',
      { dimensions: { a: 20, b: 20 } },
      true,
      async (_url, request) => {
        calls++;
        const body = JSON.parse(String(request.body)) as {
          store: boolean;
          previous_response_id?: string;
          input: unknown[];
        };
        expect(body.store).toBe(false);
        expect(body.previous_response_id).toBeUndefined();
        if (calls === 1)
          return new Response(
            JSON.stringify({
              id: 'r1',
              model: 'model-2026-01-01',
              status: 'completed',
              output: [
                {
                  type: 'function_call',
                  name: 'check_compatibility',
                  call_id: 'tool-1',
                  arguments: JSON.stringify({
                    requestJson: JSON.stringify({
                      dimensions: { a: 20, b: 20 },
                      rules: [
                        {
                          left: 'a',
                          right: 'b',
                          relation: 'equal',
                          toleranceMm: 0.1,
                        },
                      ],
                    }),
                  }),
                },
              ],
              usage: { input_tokens: 20, output_tokens: 10 },
            }),
            { status: 200 },
          );
        expect(body.input.length).toBe(3);
        return response({ result: 'checked' });
      },
    );
    expect(generated.toolExecutions).toHaveLength(1);
    expect(generated.toolExecutions[0]?.name).toBe('check_compatibility');
    expect(generated.inputTokens).toBe(120);
  });
  it('requires a distinct configured pinned judge and derives its score from an actual response', async () => {
    const f = fixture('planner'),
      m = measurement(f, {
        runs: [],
        packets: ['sample_approval'],
        effects: [],
        reason: 'Synthetic test',
      });
    expect(
      await judgeOutput(f, m, {
        ...config,
        judgeModel: config.models['planner'],
      }),
    ).toBe(null);
    const judged = await judgeOutput(f, m, config, async () =>
      response({ score: 0.4, label: 'fail', reasons: ['Wrong packet'] }, 'judge-2026-01-01'),
    );
    expect(judged?.score).toBe(0.4);
    expect(judged?.outputHash).toBe(m.outputHash);
  });
  it('configuration has no implicit model or price defaults', () => {
    const c = configuration({});
    expect(c.apiKey).toBeUndefined();
    expect(c.models).toEqual({});
    expect(c.pricing).toEqual({});
  });
});
describe('reports fail closed and comparisons detect any decline', () => {
  it('no evidence stays blocked and test samples cannot pass live gates', () => {
    const empty = buildReport({
      runId: 'r',
      fixtures: corpus,
      measurements: [],
    });
    expect(empty.status).toBe('blocked');
    expect(empty.metrics.every(m => m.value === null)).toBe(true);
    expect(releaseGates('R0', empty, []).status).toBe('blocked');
    const f = fixture('extraction'),
      m = measurement(f, {
        first: f.expected,
        second: f.expected,
        unconfirmedFields: [],
      });
    expect(
      buildReport({
        runId: 'r',
        fixtures: corpus,
        measurements: [m],
      }).externalGates.some(g => g.reason.includes('Test measurements')),
    ).toBe(true);
  });
  it('tampered fixtures, outputs and duplicate measurements are rejected as integrity failures', () => {
    const f = fixture('extraction'),
      m = measurement(f, {
        first: f.expected,
        second: f.expected,
        unconfirmedFields: [],
      });
    const report = buildReport({
      runId: 'r',
      fixtures: corpus,
      measurements: [{ ...m, fixtureHash: 'a'.repeat(64), outputHash: 'b'.repeat(64) }, m],
      mode: 'test',
    });
    expect(report.externalGates.filter(g => g.id === 'integrity').length).toBeGreaterThanOrEqual(3);
    expect(report.status).toBe('fail');
  });
  it('decreasing a score, increasing latency, changing corpus or relaxing thresholds blocks a comparison', () => {
    const baseline = buildReport({
      runId: 'base',
      fixtures: corpus,
      measurements: [],
      mode: 'test',
    });
    const metric = gate('test.accuracy', 0.99, 0.98, 'min', 'ratio', 50);
    baseline.metrics = [metric];
    baseline.status = 'pass';
    const candidate = {
      ...baseline,
      runId: 'candidate',
      metrics: [{ ...metric, value: 0.98 }],
    };
    expect(compareReports(baseline, candidate).regressions).toContain('test.accuracy: score or latency regressed');
    expect(compareReports(baseline, { ...candidate, corpusHash: 'changed' }).regressions).toContain(
      'Corpus changed; establish a reviewed paired baseline',
    );
    expect(
      compareReports(baseline, {
        ...candidate,
        metrics: [{ ...metric, threshold: 0.9 }],
      }).regressions,
    ).toContain('test.accuracy: threshold changed');
  });
  it('three repeated dates do not establish three consecutive unattended nights', () => {
    const report = buildReport({
      runId: 'r',
      fixtures: corpus,
      measurements: [],
    });
    const proof: QualityEvidence = {
      kind: 'scenario',
      id: 'proof',
      artifactPath: 'test-only',
      sha256: 'a'.repeat(64),
      observedAt: '2026-11-12T00:00:00Z',
      command: ['test'],
      exitCode: 0,
      requirementIds: [],
      invariants: [],
      facts: {
        consecutiveNights: ['2026-11-10', '2026-11-10', '2026-11-10'],
        sameReleaseCommit: true,
        allPassed: true,
      },
    };
    expect(releaseGates('R1', report, [proof]).checks.find(c => c.id === 'vertical_slice.three_nights')?.status).toBe('fail');
    proof.facts['consecutiveNights'] = ['2026-11-10', '2026-11-11', '2026-11-12'];
    expect(releaseGates('R1', report, [proof]).checks.find(c => c.id === 'vertical_slice.three_nights')?.status).toBe('pass');
  });
  it('integrity failures block R0 and R1 even when every phase proof is otherwise supplied', () => {
    const report = buildReport({
      runId: 'test',
      fixtures: corpus,
      measurements: [],
    });
    const make = (kind: QualityEvidence['kind'], facts: QualityEvidence['facts']): QualityEvidence => ({
      id: `test-${kind}`,
      kind,
      artifactPath: 'test-only',
      sha256: 'a'.repeat(64),
      observedAt: '2026-11-12T00:00:00Z',
      command: ['test'],
      exitCode: 0,
      requirementIds: [],
      invariants: [],
      facts,
    });
    const proof = [
      make('security', {
        passedInvariantIds: ['I-1', 'I-2', 'I-3', 'I-4', 'I-5', 'I-6', 'I-7', 'I-8', 'I-11', 'I-12', 'I-16'],
        invariantFailures: 0,
      }),
      make('unit', { policyPropertyCases: 10000, failedTests: 0 }),
      make('database', {
        roleTableCoverage: 1,
        crossTenantLeaks: 0,
        failedTests: 0,
      }),
      make('fault_injection', { restartReplayed: true, duplicateEffects: 0 }),
      make('performance', { broadcastP95Ms: 1000 }),
      make('e2e', { visibleHomeElements: 20, width: 1440, height: 900 }),
    ];
    expect(releaseGates('R0', report, proof).status).toBe('pass');
    report.externalGates.push({
      id: 'integrity',
      status: 'fail',
      reason: 'Fixture tampered',
    });
    expect(releaseGates('R0', report, proof).status).toBe('fail');
    expect(releaseGates('R1', report, proof).status).toBe('fail');
  });
  it('a disclosure at call end cannot pass disclosure-at-start even if counters say zero', () => {
    const f = fixture('voice');
    const trace = RuntimeTraceSchema.parse({
      provenance: {
        kind: 'runtime_ledger',
        executionId: 'test-call',
        missionId: '00000000-0000-4000-8000-000000000001',
        environment: 'sandbox',
        traceArtifactSha256: 'a'.repeat(64),
      },
      events: [
        {
          id: 'speech',
          kind: 'voice.outbound_turn',
          at: '2026-11-12T00:00:01Z',
          receiptId: null,
          authorityId: null,
          providerReference: 'call-test',
        },
        {
          id: 'disclose',
          kind: 'voice.disclosure',
          at: '2026-11-12T00:00:09Z',
          receiptId: null,
          authorityId: null,
          providerReference: 'call-test',
        },
      ],
      assertions: [],
      honestyIncidents: 0,
      mandateBreaches: 0,
      duplicateEffects: 0,
      interventions: 0,
      founderEffortMs: 0,
      callStartedAt: '2026-11-12T00:00:00Z',
      callEndedAt: '2026-11-12T00:00:10Z',
      firstAudioLatencyMs: 500,
      disclosureEventId: 'disclose',
      confirmationReceiptEventId: null,
      boundViolations: 0,
    });
    expect(scoreCase(f, measurement(f, trace, 'imported_runtime')).values['voice.disclosure']?.numerator).toBe(0);
    const disclose = trace.events.find(e => e.id === 'disclose');
    if (!disclose) throw new Error('Disclosure absent');
    disclose.at = '2026-11-12T00:00:00.200Z';
    expect(scoreCase(f, measurement(f, trace, 'imported_runtime')).values['voice.disclosure']?.numerator).toBe(1);
  });
});

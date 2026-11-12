import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { syntheticCorpus } from '../fixtures/seed.js';
import {
  DomainReviewSchema,
  EvalReportSchema,
  HumanScoreSchema,
  MeasurementSchema,
  QualityEvidenceSchema,
  type Measurement,
} from './contracts.js';
import { configuration, hash, runFixture } from './runner.js';
import { judgeOutput } from './judge.js';
import { buildReport, compareReports, validateCorpus } from './report.js';
import { releaseGates, type Phase } from './release.js';
import { RuntimeTraceSchema } from './metrics.js';

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
}
async function save(path: string, data: unknown) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(data, null, 2) + '\n');
}
const bytesHash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
async function evidenceFrom(path: string | undefined) {
  if (!path) return [];
  const entries = z.array(QualityEvidenceSchema).parse(await json(path));
  for (const entry of entries) {
    const data = await readFile(resolve(entry.artifactPath));
    if (bytesHash(data) !== entry.sha256) throw new Error(`invariant_violation: evidence artifact hash mismatch (${entry.id})`);
  }
  return entries;
}
export async function runEvaluationCli(args: string[]): Promise<number> {
  const command = args[0] ?? 'gates';
  function option(name: string, fallback?: string): string | undefined {
    const at = args.indexOf(`--${name}`);
    return at < 0 ? fallback : args[at + 1];
  }

  const fixtures = syntheticCorpus();
  if (command === 'corpus') {
    const issues = validateCorpus(fixtures);
    const output = option('out', '.local/evals/corpus.json') ?? '.local/evals/corpus.json';
    await save(output, {
      schemaVersion: 1,
      synthetic: true,
      reviewStatus: 'unreviewed',
      corpusHash: hash(fixtures),
      counts: Object.fromEntries(
        [...new Set(fixtures.map(f => f.suite))].map(suite => [suite, fixtures.filter(f => f.suite === suite).length]),
      ),
      issues,
      fixtures,
    });
    process.stdout.write(JSON.stringify({ output, fixtureCount: fixtures.length, issues }) + '\n');
    return issues.length ? 1 : 0;
  }
  if (command === 'run') {
    const config = configuration(),
      runId = randomUUID(),
      measurements: Measurement[] = [],
      judges = [];
    const selected = option('suite'),
      cases = selected ? fixtures.filter(f => f.suite === selected) : fixtures;
    if (!cases.length) throw new Error('validation: unknown suite');
    for (const fixture of cases) {
      const measured = await runFixture(fixture, config);
      measurements.push(measured);
      if (measured.status === 'completed') {
        try {
          const judge = await judgeOutput(fixture, measured, config);
          if (judge) judges.push(judge);
        } catch (error: unknown) {
          process.stderr.write(`Judge unavailable for ${fixture.id}: ${error instanceof Error ? error.message : 'unknown error'}\n`);
        }
      }
    }
    const report = buildReport({ runId, fixtures, measurements, judges }),
      output = option('out', `.local/evals/${runId}.json`) ?? `.local/evals/${runId}.json`;
    await save(output, report);
    process.stdout.write(
      JSON.stringify({
        output,
        runId,
        status: report.status,
        completed: measurements.filter(m => m.status === 'completed').length,
        blocked: measurements.filter(m => m.status === 'blocked').length,
        failed: measurements.filter(m => m.status === 'failed').length,
      }) + '\n',
    );
    return report.status === 'pass' ? 0 : report.status === 'blocked' ? 2 : 1;
  }
  if (command === 'import-runtime') {
    const manifest = z
      .array(
        z
          .object({
            caseId: z.string(),
            tracePath: z.string(),
            sourceArtifactPath: z.string(),
            sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .parse(await json(option('manifest') ?? ''));
    const measurements: Measurement[] = [];
    for (const item of manifest) {
      const fixture = fixtures.find(f => f.id === item.caseId);
      if (!fixture || !['scenario', 'voice', 'honesty'].includes(fixture.suite))
        throw new Error('validation: runtime trace fixture mismatch');
      const source = await readFile(resolve(item.sourceArtifactPath));
      if (bytesHash(source) !== item.sourceSha256) throw new Error('invariant_violation: runtime source artifact hash mismatch');
      const trace = RuntimeTraceSchema.parse(await json(item.tracePath));
      if (trace.provenance.traceArtifactSha256 !== item.sourceSha256)
        throw new Error('invariant_violation: trace is not bound to its source artifact');
      const dates = trace.events.map(e => Date.parse(e.at));
      measurements.push(
        MeasurementSchema.parse({
          caseId: fixture.id,
          fixtureHash: hash(fixture),
          promptHash: null,
          mode: 'untrusted_import',
          status: 'completed',
          output: trace,
          responseId: trace.provenance.executionId,
          model: null,
          startedAt: trace.events[0]?.at ?? new Date().toISOString(),
          latencyMs: dates.length ? Math.max(...dates) - Math.min(...dates) : 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          usageComplete: false,
          costUsd: null,
          error: null,
          outputHash: hash(trace),
          toolExecutions: [],
        }),
      );
    }
    const output = option('out', '.local/evals/runtime-measurements.json') ?? '.local/evals/runtime-measurements.json';
    await save(output, measurements);
    process.stdout.write(JSON.stringify({ output, count: measurements.length }) + '\n');
    return 0;
  }
  if (command === 'gates') {
    const path = option('report');
    const stored = path ? EvalReportSchema.parse(await json(path)) : null;
    const humans = option('human') ? z.array(HumanScoreSchema).parse(await json(option('human') ?? '')) : [];
    const reviews = option('domain-review') ? z.array(DomainReviewSchema).parse(await json(option('domain-review') ?? '')) : [];
    const evidence = await evidenceFrom(option('evidence'));
    const imported = option('runtime-measurements')
      ? z.array(MeasurementSchema).parse(await json(option('runtime-measurements') ?? ''))
      : [];
    const report = buildReport({
      runId: stored?.runId ?? randomUUID(),
      fixtures,
      measurements: [...(stored?.measurements ?? []), ...imported],
      judges: stored?.judges ?? [],
      humanScores: humans,
      domainReviews: reviews,
      evidence,
    });
    const phase = z.enum(['R0', 'R1', 'R2', 'R3', 'GA']).parse(option('phase', 'R2')) as Phase;
    const release = releaseGates(phase, report, evidence),
      output = option('out', '.local/evals/gates.json') ?? '.local/evals/gates.json';
    await save(output, { report, release });
    process.stdout.write(
      JSON.stringify({
        output,
        phase,
        status: release.status,
        passed: release.checks.filter(c => c.status === 'pass').length,
        failed: release.checks.filter(c => c.status === 'fail').length,
        blocked: release.checks.filter(c => c.status === 'blocked').length,
      }) + '\n',
    );
    return release.status === 'pass' ? 0 : release.status === 'blocked' ? 2 : 1;
  }
  if (command === 'compare') {
    const baseline = EvalReportSchema.parse(await json(option('baseline') ?? '')),
      candidate = EvalReportSchema.parse(await json(option('candidate') ?? '')),
      comparison = compareReports(baseline, candidate);
    await save(option('out', '.local/evals/comparison.json') ?? '.local/evals/comparison.json', comparison);
    process.stdout.write(JSON.stringify(comparison) + '\n');
    return comparison.passed ? 0 : 1;
  }
  throw new Error('validation: command must be corpus, run, import-runtime, gates or compare');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
  void runEvaluationCli(process.argv.slice(2))
    .then(code => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        JSON.stringify({
          status: 'blocked',
          error: error instanceof Error ? error.message : 'Evaluation command failed',
        }) + '\n',
      );
      process.exitCode = 2;
    });
}

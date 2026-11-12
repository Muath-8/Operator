import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { QualityEvidenceSchema } from '../../packages/evals/src/contracts.js';

const profile = z.enum(['unit', 'database', 'security', 'contract']).parse(process.argv[2] ?? 'unit');
const includes = {
  unit: ['packages/state/test/readiness.test.ts', 'packages/policy', 'apps/runtime/src/domain.test.ts', 'packages/evals/test'],
  database: [
    'packages/state/test/database.test.ts',
    'apps/runtime/src/runtime-database.test.ts',
    'packages/policy/src/postgres-contract.test.ts',
  ],
  security: ['packages/state/test/database.test.ts', 'packages/policy'],
  contract: ['packages/adapters', 'packages/policy/src/postgres-contract.test.ts'],
};
const root = resolve(process.cwd()),
  directory = join(root, '.local/quality');
await mkdir(directory, { recursive: true });
const artifact = join(directory, `${profile}-vitest.json`),
  cli = join(dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))), 'vitest.mjs'),
  arguments_ = [cli, 'run', ...includes[profile], '--reporter=json', '--outputFile', artifact];
const started = Date.now(),
  exitCode = await new Promise<number>((resolveExit, reject) => {
    const child = spawn(process.execPath, arguments_, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', code => resolveExit(code ?? 1));
  });
const raw = await readFile(artifact),
  summary = z
    .object({
      numPassedTests: z.number(),
      numFailedTests: z.number(),
      numPendingTests: z.number(),
      success: z.boolean(),
      testResults: z.array(
        z.object({
          name: z.string(),
          status: z.string(),
          assertionResults: z.array(z.object({ fullName: z.string(), status: z.string() })),
        }),
      ),
    })
    .parse(JSON.parse(raw.toString('utf8')) as unknown);
const passedNames = summary.testResults.flatMap(file => file.assertionResults.filter(a => a.status === 'passed').map(a => a.fullName)),
  requirementIds = [...new Set(passedNames.flatMap(name => name.match(/(?:FR-[A-Z]+|NFR)-\d+/g) ?? []))],
  invariants = [...new Set(passedNames.flatMap(name => name.match(/I-\d+/g) ?? []))];
const record = QualityEvidenceSchema.parse({
  id: `${profile}:${new Date(started).toISOString()}`,
  kind: profile,
  artifactPath: artifact,
  sha256: createHash('sha256').update(raw).digest('hex'),
  observedAt: new Date().toISOString(),
  command: [process.execPath, ...arguments_],
  exitCode,
  requirementIds,
  invariants,
  facts: {
    passedTests: summary.numPassedTests,
    failedTests: summary.numFailedTests,
    skippedTests: summary.numPendingTests,
    elapsedMs: Date.now() - started,
    passedInvariantIds: invariants,
    invariantFailures: summary.numFailedTests,
  },
});
await writeFile(join(directory, `${profile}-evidence.json`), JSON.stringify([record], null, 2) + '\n');
process.stdout.write(
  JSON.stringify({
    profile,
    exitCode,
    passed: summary.numPassedTests,
    failed: summary.numFailedTests,
    evidence: join(directory, `${profile}-evidence.json`),
  }) + '\n',
);
process.exitCode = exitCode;

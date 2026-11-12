import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { runEvaluationCli } from '../src/cli.js';
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'lo-eval-cli-'));
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.stubEnv('OPENAI_API_KEY', undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('lo-eval-cli-'))
    throw Error('Test cleanup outside created directory');
  await rm(target, { recursive: true, force: true });
});
it('writes the complete synthetic corpus without presenting it as reviewed evidence', async () => {
  const output = join(directory, 'corpus.json');
  expect(await runEvaluationCli(['corpus', '--out', output])).toBe(0);
  const corpus = JSON.parse(await readFile(output, 'utf8'));
  expect(corpus).toMatchObject({ synthetic: true, reviewStatus: 'unreviewed', counts: { scenario: 25, voice: 15 } });
  expect(corpus.fixtures).toHaveLength(357);
});
it.each(['R0', 'R1', 'R2', 'R3', 'GA'])('does not pass release %s with no provider or human evidence', async phase => {
  const output = join(directory, 'gate.json');
  expect(await runEvaluationCli(['gates', '--phase', phase, '--out', output])).toBe(2);
  const result = JSON.parse(await readFile(output, 'utf8'));
  expect(result.release.status).toBe('blocked');
  expect(result.release.checks.some((check: { status: string }) => check.status === 'blocked')).toBe(true);
});
it('runs every selected case as honestly blocked without configured model credentials', async () => {
  const output = join(directory, 'run.json');
  expect(await runEvaluationCli(['run', '--suite', 'brand', '--out', output])).toBe(2);
  const result = JSON.parse(await readFile(output, 'utf8'));
  expect(result.measurements).toHaveLength(20);
  expect(
    result.measurements.every((m: { status: string; responseId: string | null }) => m.status === 'blocked' && m.responseId === null),
  ).toBe(true);
  expect(result.status).toBe('blocked');
});
it('rejects unknown commands and suites rather than generating empty passing reports', async () => {
  await expect(runEvaluationCli(['unknown'])).rejects.toThrow(/command must/);
  await expect(runEvaluationCli(['run', '--suite', 'unknown'])).rejects.toThrow(/unknown suite/);
  await expect(runEvaluationCli(['gates', '--phase', 'unknown'])).rejects.toThrow();
});

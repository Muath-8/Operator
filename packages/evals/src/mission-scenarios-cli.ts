import { createBuiltinScenarioDriver } from './mission-scenario-protocols.js';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { runMissionScenarios, FileScenarioCheckpoints, type MissionScenarioDriver } from './mission-scenarios.js';

const flag = (name: string) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const directory = resolve(flag('--output') ?? '.local/canonical-missions'),
  modulePath = flag('--driver'),
  testProtocol = process.argv.includes('--test-protocol');
if (testProtocol) {
  if (process.env['NODE_ENV'] === 'production') throw new Error('Test protocol is forbidden in production');
  process.env = { ...process.env, NODE_ENV: 'test' };
}
const mode = testProtocol ? 'test_protocol' : 'live';
let driver: MissionScenarioDriver;
if (modulePath) {
  const imported: unknown = await import(pathToFileURL(resolve(modulePath)).href),
    module = z
      .object({
        createScenarioDriver: z.custom<(options: { mode: 'test_protocol' | 'live'; directory: string }) => Promise<MissionScenarioDriver>>(
          value => typeof value === 'function',
        ),
      })
      .parse(imported);
  driver = await module.createScenarioDriver({ mode, directory });
  if (driver.mode !== mode) throw new Error('Configured driver mode differs from explicit CLI mode');
} else driver = await createBuiltinScenarioDriver({ mode, directory });
const report = await runMissionScenarios({
  driver,
  checkpoints: new FileScenarioCheckpoints(join(directory, 'checkpoints')),
  directory,
  maxTurns: Number(flag('--max-turns') ?? 20),
});
const counts = {
  passed: report.cases.filter(c => c.status === 'passed').length,
  failed: report.cases.filter(c => c.status === 'failed').length,
  blocked: report.cases.filter(c => c.status === 'blocked').length,
};
process.stdout.write(
  JSON.stringify({
    report: join(directory, 'mission-scenarios.report.json'),
    executionId: report.executionId,
    ...counts,
    mode,
    releaseQualifying: report.releaseQualifying,
    liveModelGate: report.liveModelGate,
    providerGate: report.providerGate,
  }) + '\n',
);
if (counts.failed || counts.blocked) process.exitCode = 2;

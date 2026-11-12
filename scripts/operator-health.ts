import { operatorHealth, reportOperatorHealth, closeOperationsPool } from '../apps/runtime/src/operations.js';
try {
  const report = process.argv.includes('--report') ? await reportOperatorHealth() : await operatorHealth();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await closeOperationsPool();
}

import { operatorBusinessMetrics, closeOperationsPool } from '../apps/runtime/src/operations.js';
try {
  process.stdout.write(JSON.stringify(await operatorBusinessMetrics(), null, 2) + '\n');
} finally {
  await closeOperationsPool();
}

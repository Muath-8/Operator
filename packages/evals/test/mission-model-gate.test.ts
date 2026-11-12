import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createModelServices } from '../../../apps/runtime/src/model-services.js';
it('rejects a scenario model factory outside test mode before configuration, registration or model use', () => {
  const prior = process.env;
  let calls = 0;
  try {
    process.env = { ...prior, NODE_ENV: 'production' };
    expect(() =>
      createModelServices(
        { authUserId: randomUUID(), missionId: randomUUID() },
        {
          forTask: async () => {
            calls++;
            return {};
          },
        },
        async () => {
          calls++;
        },
        () => {
          calls++;
          throw new Error('Test model must not be constructed');
        },
      ),
    ).toThrow(/forbidden outside tests/);
    expect(calls).toBe(0);
  } finally {
    process.env = prior;
  }
});

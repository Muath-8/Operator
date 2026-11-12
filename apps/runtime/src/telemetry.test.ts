import { describe, it, expect } from 'vitest';
import { safeTelemetryTags, telemetryCode, PRIVATE_DATA_COLLECTION } from './telemetry-privacy.js';
describe('I-11 metadata-only telemetry', () => {
  it('drops free text, tokens, emails, URLs and unknown labels', () => {
    expect(
      safeTelemetryTags({
        missionId: '00000000-0000-4000-8000-000000000001',
        runId: 'supplier@example.test',
        service: 'runtime',
        operation: 'https://secret.example/token',
        apiKey: 'fixture-secret',
        role: 'sourcing',
      }),
    ).toEqual({ missionId: '00000000-0000-4000-8000-000000000001', service: 'runtime', role: 'sourcing' });
    expect(telemetryCode(new Error('provider_down: supplier@example.test Bearer fixture-secret'))).toBe('provider_down');
    expect(telemetryCode(new Error('supplier@example.test'))).toBe('unexpected_failure');
    expect(PRIVATE_DATA_COLLECTION.genAI).toEqual({ inputs: false, outputs: false });
    expect(PRIVATE_DATA_COLLECTION.httpBodies).toEqual([]);
  });
});

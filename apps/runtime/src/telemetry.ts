import * as Sentry from '@sentry/node';
import { safeTelemetryTags, telemetryCode, PRIVATE_DATA_COLLECTION } from './telemetry-privacy.js';

let initialized = false;
export function initializeTelemetry(service: 'web' | 'runtime' | 'voice'): void {
  if (initialized || !process.env.SENTRY_DSN) return;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.LO_EXECUTION_MODE ?? 'local',
    release: process.env.SENTRY_RELEASE,
    defaultIntegrations: false,
    integrations: [],
    maxBreadcrumbs: 0,
    attachStacktrace: false,
    dataCollection: { ...PRIVATE_DATA_COLLECTION, httpBodies: [] },
    beforeSend: event => ({
      type: event.type,
      event_id: event.event_id,
      timestamp: event.timestamp,
      level: event.level,
      platform: 'node',
      message: 'Launch Operator operational failure',
      tags: safeTelemetryTags({ ...event.tags, service }),
      fingerprint: ['launch-operator', safeTelemetryTags(event.tags ?? {}).code ?? 'unexpected_failure'],
    }),
  });
  initialized = true;
}
export function reportOperationalError(error: unknown, tags: Record<string, unknown> = {}): void {
  const safe = safeTelemetryTags({ ...tags, code: telemetryCode(error) });
  // Structured local logs contain only validated identifiers and constant codes.
  console.error(JSON.stringify({ event: 'operational_error', ...safe }));
  if (initialized)
    Sentry.withScope(scope => {
      scope.setTags(safe);
      Sentry.captureMessage('Launch Operator operational failure', 'error');
    });
}
export async function flushTelemetry(): Promise<void> {
  if (initialized) await Sentry.flush(1500);
}

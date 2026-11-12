import type { Instrumentation } from 'next';
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initializeTelemetry } = await import('@lo/runtime/telemetry');
    initializeTelemetry('web');
  }
}
export const onRequestError: Instrumentation.onRequestError = async error => {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { reportOperationalError, flushTelemetry } = await import('@lo/runtime/telemetry');
    reportOperationalError(error, { service: 'web', operation: 'request' });
    await flushTelemetry();
  }
};

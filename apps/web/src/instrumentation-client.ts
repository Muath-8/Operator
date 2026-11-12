// Intentionally no automatic DOM/network/session-replay integrations. The public
// DSN is a destination, not a provider credential; all event content is constant.
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  void import('@sentry/browser')
    .then(Sentry => {
      Sentry.init({
        dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
        defaultIntegrations: false,
        integrations: [],
        maxBreadcrumbs: 0,
        dataCollection: {
          userInfo: false,
          cookies: false,
          httpHeaders: false,
          httpBodies: [],
          urlQueryParams: false,
          genAI: { inputs: false, outputs: false },
        },
        beforeSend: event => ({
          type: event.type,
          event_id: event.event_id,
          timestamp: event.timestamp,
          level: 'error',
          message: 'Launch Operator browser failure',
          tags: { service: 'web_client' },
        }),
      });
      const report = () => {
        Sentry.captureMessage('Launch Operator browser failure', 'error');
      };
      window.addEventListener('error', report);
      window.addEventListener('unhandledrejection', report);
    })
    .catch(() => {
      /* Monitoring unavailability must not prevent sign-in or mission use. */
    });
}

/** Telemetry is a metadata channel. Raw errors, request bodies, headers,
 * cookies, messages, URLs, breadcrumbs and model content never cross it. */
export function safeTelemetryTags(raw: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ['missionId', 'runId', 'stepId'])
    if (typeof raw[key] === 'string' && /^[a-f0-9-]{36}$/i.test(raw[key])) result[key] = raw[key];
  for (const key of ['service', 'role', 'tier', 'operation', 'code'])
    if (typeof raw[key] === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(raw[key])) result[key] = raw[key];
  return result;
}
export function telemetryCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  for (const code of ['validation', 'invariant_violation', 'needs_approval', 'provider_down', 'rate_limited', 'conflict'])
    if (message.startsWith(`${code}:`)) return code;
  return 'unexpected_failure';
}
export const PRIVATE_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  frameContextLines: 0,
} as const;

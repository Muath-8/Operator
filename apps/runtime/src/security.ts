import { createHash } from 'node:crypto';
import type { Role } from './contracts.js';

const SECRET_KEYS = /(?:password|secret|api.?key|access.?token|refresh.?token|authorization|approval.?token|cookie|secret.?ref)/i;
const SECRET_PATTERNS = [/\bsk-[A-Za-z0-9_-]{12,}\b/g, /Bearer\s+[A-Za-z0-9._~+/-]+/gi, /\bAKIA[A-Z0-9]{16}\b/g];
export function redact(value: unknown, secretValues: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    let output = value;
    for (const secret of secretValues.filter(s => s.length > 3)) output = output.split(secret).join('[redacted]');
    for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, '[redacted]');
    return output;
  }
  if (Array.isArray(value)) return value.map(v => redact(v, secretValues));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, SECRET_KEYS.test(key) ? '[redacted]' : redact(v, secretValues)]),
    );
  return value;
}

export const TOOL_MANIFESTS: Readonly<Record<Role, readonly string[]>> = {
  lead: [
    'read_professional_engagement',
    'prepare_optional_step',
    'read_sourcing_campaign',
    'record_cost_estimate',
    'record_obstacle',
    'resolve_obstacle',
    'configure_chase',
    'read_state',
    'search_mission',
    'read_artifact',
    'raise_decision',
    'brief_run',
    'prepare_launch_record',
  ],
  research: ['read_state', 'search_mission', 'read_artifact', 'web_search', 'fetch_page', 'registry_lookup'],
  brand: [
    'prepare_domain_registration',
    'prepare_founder_ownership_kit',
    'read_state',
    'read_artifact',
    'generate_image',
    'domain_check',
    'handle_check',
    'trademark_screen',
  ],
  product: ['read_state', 'read_artifact', 'generate_image', 'validate_spec', 'check_compatibility'],
  sourcing: [
    'prepare_rfq',
    'create_sourcing_campaign',
    'read_sourcing_campaign',
    'shortlist_campaign',
    'register_campaign_sample',
    'link_campaign_proforma',
    'link_campaign_inspection',
    'read_state',
    'read_artifact',
    'read_thread',
    'web_search',
    'registry_lookup',
    'extract_quote',
    'assess_quote_route',
    'normalize_quote',
    'supplier_scorecard',
    'flag_changed_terms',
    'send_email',
    'send_whatsapp_template',
    'send_whatsapp_text',
    'place_call',
    'marketplace_message',
  ],
  commerce: ['read_state', 'read_artifact', 'store_configure', 'run_test_order'],
  compliance: [
    'prepare_professional_engagement',
    'create_professional_engagement',
    'receive_professional_deliverable',
    'read_professional_engagement',
    'read_state',
    'read_artifact',
    'web_search',
    'registry_lookup',
    'validate_claims',
  ],
  finance: [
    'register_professional_payment',
    'read_professional_engagement',
    'record_cost_estimate',
    'read_state',
    'read_artifact',
    'calculate_cost',
    'fx_lookup',
    'prepare_payment',
  ],
  operations: [
    'prepare_professional_engagement',
    'create_professional_engagement',
    'receive_professional_deliverable',
    'read_professional_engagement',
    'record_obstacle',
    'resolve_obstacle',
    'configure_chase',
    'read_state',
    'read_thread',
    'send_email',
    'send_whatsapp_template',
    'send_whatsapp_text',
    'schedule_followup',
  ],
  reviewer: ['read_state', 'read_artifact', 'read_thread'],
  extraction: [],
  voice: ['write_fact', 'check_bounds', 'schedule_followup', 'end_call'],
};
export function detectUntrustedInstructions(content: string): string[] {
  const reasons: string[] = [];
  if (
    /ignore.{0,30}(instructions|rules|previous)|system\s*prompt|<\/?(?:system|assistant|tool)>|you are (?:now|an? assistant)|execute_payment|call.{0,20}tool/i.test(
      content,
    )
  )
    reasons.push('instruction_in_external_content');
  if (/new\s+(?:bank|payee|account)|change.{0,25}(?:bank|payee|account)|send.{0,25}(?:secret|token|password)/i.test(content))
    reasons.push('payee_or_secret_change');
  return reasons;
}
export function assertRoleTool(role: Role, name: string, externalContentFlagged: boolean): void {
  if (!TOOL_MANIFESTS[role].includes(name)) throw new Error('invariant_violation: tool is outside role manifest');
  if (externalContentFlagged && !['read_state', 'read_artifact', 'read_thread', 'search_mission'].includes(name))
    throw new Error('needs_approval: flagged content requires Lead review');
}
export function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

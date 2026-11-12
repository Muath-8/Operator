import { createHash, randomUUID } from 'node:crypto';
import type { JsonValue } from '@lo/state';
export type LocalRow = Record<string, JsonValue>;
export const LOCAL_TEST_AUTH_USER_ID = '00000000-0000-4000-8000-000000000001';
export const LOCAL_DEMO_NOTICE =
  'Local simulation: examples and replies are for testing. No suppliers were contacted, money moved, accounts connected or external work verified.';
export function localId(owner: string, label: string): string {
  const hex = createHash('sha256').update(`local-sqlite:${owner}:${label}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function emptyLocalSnapshot(authUserId: string, missionId: string, title: string, goal: string): LocalRow {
  const now = new Date().toISOString(),
    thread = localId(missionId, 'founder-thread');
  return {
    mission: {
      id: missionId,
      founder_id: authUserId,
      type: 'launch',
      goal_brief: goal,
      currency: 'SAR',
      sandbox_mode: true,
      involvement: 'guide',
      created_at: now,
      metadata: {
        title,
        summary: 'Local testing workspace · simulation',
        locale: 'en',
        timeZone: 'Asia/Riyadh',
        budgetMinor: 3000000,
        fixture: true,
        localSimulation: true,
      },
    },
    status: 'active',
    ledger_version: 1,
    generated_at: now,
    threads: [{ id: thread, mission_id: missionId, counterparty_id: null, created_at: now }],
    messages: [
      {
        id: randomUUID(),
        mission_id: missionId,
        thread_id: thread,
        direction: 'lead',
        channel: 'internal',
        original: LOCAL_DEMO_NOTICE,
        created_at: now,
      },
    ],
    artifacts: [],
    artifact_versions: [],
    artifact_statuses: [],
    decisions: [],
    decision_resolutions: [],
    decision_supersessions: [],
    stale_marks: [],
    dependencies: [],
    evidence: [],
    provider_receipts: [],
    effect_authorizations: [],
    payments: [],
    money_ledger: [],
    activity: [],
    mission_transitions: [],
    founder_preferences: [],
    notification_events: [],
    command_requests: [],
    command_results: [],
    commitments: [],
    commitment_states: [],
    runs: [],
    run_results: [],
    glossary_terms: [],
    readiness: ['brand', 'product', 'supply', 'commerce', 'compliance', 'demand'].map(outcome => ({
      outcome,
      level: 0,
      missing: ['Local demonstration has no externally verified outcome evidence.'],
      evidence_ids: [],
      decision_ids: [],
      stale: false,
    })),
    knowledge: {
      requestedCategory: 'Local demonstration',
      profile: { id: 'local-demo', version: 1, review_status: 'unverified', sources: ['Local illustrative seed data'] },
      warning: LOCAL_DEMO_NOTICE,
    },
    engagement: { activeSeconds: 0, lastSeenAt: null, absenceHours: 48, basis: 'Local demonstration; effort measurement is not enabled.' },
  };
}
function addArtifact(snapshot: LocalRow, type: string, title: string, outcome: string, content: LocalRow) {
  const mission = snapshot.mission as LocalRow,
    id = localId(String(mission.id), type),
    version = localId(id, 'v1'),
    now = new Date().toISOString();
  (snapshot.artifacts as LocalRow[]).push({ id, mission_id: mission.id ?? '', type, title, outcome, created_at: now });
  (snapshot.artifact_versions as LocalRow[]).push({
    id: version,
    mission_id: mission.id ?? '',
    artifact_id: id,
    version_no: 1,
    content,
    created_at: now,
  });
  (snapshot.artifact_statuses as LocalRow[]).push({
    id: randomUUID(),
    mission_id: mission.id ?? '',
    artifact_version_id: version,
    status: 'proposed',
    created_at: now,
  });
  return { id, version };
}
function decision(
  snapshot: LocalRow,
  artifact: { id: string; version: string },
  kind: string,
  gate: string,
  question: string,
  options: { id: string; label: string; cost: { amountMinor: number; currency: string } | null; consequences: string }[],
  outcome: string,
) {
  const mission = snapshot.mission as LocalRow,
    id = localId(String(mission.id), gate),
    now = new Date().toISOString();
  (snapshot.decisions as LocalRow[]).push({
    id,
    mission_id: mission.id ?? '',
    kind,
    gate,
    outcome,
    created_at: now,
    packet: {
      question,
      options: options.map(option => ({ ...option, artifactVersionIds: [artifact.version], evidenceIds: [], timeDays: 0 })),
      approvedVersionIds: [artifact.version],
      recommendation: { optionId: options[0]?.id ?? 'a', reasons: ['Illustrative local test; compare the example before choosing.'] },
      staleImpact: [],
      defaultIfNoAnswer: { optionId: options[0]?.id ?? 'a', at: null, binding: true },
    },
  });
  return id;
}
export function localSeedSnapshots(authUserId: string): LocalRow[] {
  const firstId = authUserId === LOCAL_TEST_AUTH_USER_ID ? '20000000-0000-4000-8000-000000000001' : localId(authUserId, 'demo-one'),
    secondId = authUserId === LOCAL_TEST_AUTH_USER_ID ? '20000000-0000-4000-8000-000000000002' : localId(authUserId, 'demo-two'),
    first = emptyLocalSnapshot(
      authUserId,
      firstId,
      'A considered launch · demo',
      'Explore a product idea and review illustrative brand and supplier options.',
    ),
    second = emptyLocalSnapshot(
      authUserId,
      secondId,
      'Everyday essentials · demo',
      'Compare an alternative brand direction in a separate local mission.',
    );
  const brand = addArtifact(first, 'brand_directions', 'Choose a direction · simulated', 'brand', {
    simulation: true,
    notice: LOCAL_DEMO_NOTICE,
    directions: [
      {
        id: 'quiet',
        name: 'Quiet precision',
        positioning: 'An understated, everyday identity',
        palette: ['#28433F', '#EAE4D7', '#B58A57'],
        mark: { kind: 'wordmark', text: 'STILL' },
        typography: 'Clear humanist lettering',
      },
      {
        id: 'bright',
        name: 'Bright ritual',
        positioning: 'An optimistic, expressive identity',
        palette: ['#BC5739', '#F4E9D3', '#31483C'],
        mark: { kind: 'wordmark', text: 'DAILY' },
        typography: 'Warm geometric lettering',
      },
    ],
  });
  decision(
    first,
    brand,
    'selection',
    'demo_brand',
    'Which illustrative direction would you like to explore?',
    [
      {
        id: 'quiet',
        label: 'Explore quiet precision',
        cost: null,
        consequences: 'Saves a local simulated choice. No external work starts.',
      },
      { id: 'bright', label: 'Explore bright ritual', cost: null, consequences: 'Saves an alternate local simulated choice.' },
    ],
    'brand',
  );
  const quotes = [
    {
      id: 'a',
      title: 'Example supplier A · simulated',
      unitPriceMinor: 1200,
      currency: 'SAR',
      moq: 500,
      leadDays: 20,
      spec: { kind: 'container', dims_mm: { w: 50, h: 95, d: 35 }, parts: [] },
    },
    {
      id: 'b',
      title: 'Example supplier B · simulated',
      unitPriceMinor: 1450,
      currency: 'SAR',
      moq: 300,
      leadDays: 28,
      spec: { kind: 'container', dims_mm: { w: 55, h: 90, d: 35 }, parts: [] },
    },
    {
      id: 'c',
      title: 'Example supplier C · simulated',
      unitPriceMinor: 1050,
      currency: 'SAR',
      moq: 1200,
      leadDays: 35,
      spec: { kind: 'container', dims_mm: { w: 48, h: 100, d: 32 }, parts: [] },
    },
  ];
  addArtifact(first, 'supplier_comparison', 'Three illustrative quotes · no real offers', 'supply', {
    simulation: true,
    notice: LOCAL_DEMO_NOTICE,
    quotes,
    limit: 1000,
  });
  const sample = addArtifact(first, 'payment_proposal', 'Sample budget · simulated approval', 'supply', {
    simulation: true,
    notice: 'This is a local approval demonstration, not a PayPal payment. Approving records only your local choice.',
    amountMinor: 2500,
    currency: 'SAR',
    purpose: 'Illustrative sample budget',
  });
  decision(
    first,
    sample,
    'engagement',
    'demo_sample',
    'Simulate approving a SAR 25 sample budget?',
    [
      {
        id: 'approve',
        label: 'Save simulated approval',
        cost: { amountMinor: 2500, currency: 'SAR' },
        consequences: 'No provider call, charge, receipt or spent balance is created.',
      },
      { id: 'decline', label: 'Choose not to proceed', cost: null, consequences: 'Keeps the sample as an unexecuted local example.' },
    ],
    'supply',
  );
  const secondBrand = addArtifact(second, 'brand_directions', 'Alternative directions · simulated', 'brand', {
    simulation: true,
    notice: LOCAL_DEMO_NOTICE,
    directions: [
      {
        id: 'field',
        name: 'Field notes',
        positioning: 'Practical details for everyday use',
        palette: ['#283E45', '#D9C8A5', '#E8ECE6'],
        mark: { kind: 'wordmark', text: 'FIELD' },
        typography: 'Functional editorial lettering',
      },
    ],
  });
  decision(
    second,
    secondBrand,
    'selection',
    'demo_alternative_brand',
    'Explore this illustrative alternative direction?',
    [
      {
        id: 'field',
        label: 'Explore field notes',
        cost: null,
        consequences: 'Saves this simulated direction locally. No design service or external action is started.',
      },
    ],
    'brand',
  );
  return [first, second];
}

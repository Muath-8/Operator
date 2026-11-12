import { describe, it, expect } from 'vitest';
import { artifactDocument } from './artifact-document';
import { projectMission } from './projection';
import { randomUUID } from 'node:crypto';
const context = { versionId: 'test-version', observedAt: '2026-11-12T16:00:00.000Z', evidence: new Map() };
describe('independent semantic artifact document values', () => {
  it('does not expose an unformatted minor-unit value alongside its formatted money figure', () => {
    const sections = artifactDocument({ pricing: { currency: 'SAR', priceMinor: 1200 } }, context);
    const money = sections.flatMap(s => (s.k === 'fields' ? s.rows : [])).find(r => r.figure?.value.kind === 'money');
    expect(money?.figure?.value).toEqual({ kind: 'money', amount: { amountMinor: 1200, currency: 'SAR' } });
    // DocumentView renders value and then figure. Only the figure should show this money.
    expect(money?.value).toBe('');
  });
  it('gives repeated fields unique figure identities', () => {
    const sections = artifactDocument({ components: [{ leadDays: 3 }, { leadDays: 5 }] }, context);
    const figures = sections.flatMap(s => (s.k === 'fields' ? s.rows.flatMap(r => (r.figure ? [r.figure] : [])) : []));
    expect(figures).toHaveLength(2);
    expect(new Set(figures.map(f => f.id)).size).toBe(2);
  });
  it('fails trust closed when a cited evidence source is absent', () => {
    const sections = artifactDocument(
      { demand: { text: 'Synthetic assertion', trust: 'verified', evidenceIds: ['missing-source'] } },
      context,
    );
    expect(sections.flatMap(s => (s.k === 'fields' ? s.rows : []))[0]?.figure?.trust).toBe('planned');
  });
});

describe('independent canonical founder kit projection', () => {
  it('preserves canonical instructions and never promotes a generated verified status without current proof', () => {
    const missionId = randomUUID(),
      versionId = randomUUID(),
      artifactId = randomUUID();
    const kit = {
      title: 'Connect founder-owned account',
      whereToGo: 'https://example.test/account',
      whatToEnter: ['Business details'],
      whatToBringBack: ['Ownership receipt'],
      howVerified: 'Compare the returned account ownership',
      status: 'verified',
      evidenceIds: [],
    };
    const snapshot = {
      mission: {
        id: missionId,
        founder_id: randomUUID(),
        currency: 'SAR',
        goal_brief: 'Synthetic review',
        sandbox_mode: true,
        metadata: {},
      },
      status: 'active',
      ledger_version: 1,
      artifacts: [{ id: artifactId, mission_id: missionId, type: 'founder_kit', outcome: 'commerce', title: kit.title }],
      artifact_versions: [
        { id: versionId, mission_id: missionId, artifact_id: artifactId, version_no: 1, content: kit, created_at: context.observedAt },
      ],
    };
    const view = projectMission(snapshot);
    expect(view.kits[versionId]).toMatchObject({
      title: kit.title,
      where: { url: kit.whereToGo },
      enter: kit.whatToEnter,
      bring: kit.whatToBringBack,
      verify: kit.howVerified,
      status: 'submitted',
    });
    const evidenceId = randomUUID(),
      proven = {
        ...snapshot,
        evidence: [
          {
            id: evidenceId,
            mission_id: missionId,
            outcome: 'commerce',
            kind: 'kit_verified',
            trust: 'founder_confirmed',
            source_type: 'document',
            source_reference: 'synthetic-return',
            payload: { kitVersionId: versionId },
            created_at: context.observedAt,
          },
        ],
      };
    expect(projectMission(proven).kits[versionId]?.status).toBe('verified');
    expect(projectMission({ ...proven, stale_marks: [{ node_id: evidenceId, cause_id: randomUUID() }] }).kits[versionId]?.status).toBe(
      'submitted',
    );
  });
});

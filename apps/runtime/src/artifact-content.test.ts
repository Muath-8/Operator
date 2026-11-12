import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { validateArtifactContent } from './artifact-content.js';
const evidenceId = randomUUID(),
  evidence = new Map([[evidenceId, { trust: 'claimed' }]]);
const fact = {
  text: 'Market hypothesis',
  trust: 'planned',
  evidenceIds: [],
  source: 'Unverified research assumption',
  observedAt: '2026-11-12T00:00:00Z',
};
const canvas = Object.fromEntries(
  ['problem', 'customerSegment', 'uniqueValueProposition', 'solution', 'channels', 'revenue', 'costs', 'keyMetrics', 'unfairAdvantage'].map(
    k => [k, fact],
  ),
);
describe('production artifact gates (FR-MIS-03 FR-PLY-02/03 FR-EASE-07 I-5)', () => {
  it('requires all nine Lean Canvas boxes and preserves estimated hypotheses', () => {
    expect(() => validateArtifactContent('lean_canvas', { leanCanvas: canvas }, evidence)).not.toThrow();
    const { problem: _problem, ...missing } = canvas;
    expect(() => validateArtifactContent('lean_canvas', { leanCanvas: missing }, evidence)).toThrow();
  });
  it('requires five complete opportunity cards with two current sources each', () => {
    const second = randomUUID(),
      sources = new Map([...evidence, [second, { trust: 'claimed' }]]);
    const card = {
      id: 'candidate',
      title: 'Category-independent opportunity',
      demand: fact,
      competition: fact,
      unitEconomics: fact,
      regulatoryBurden: fact,
      effort: fact,
      evidenceIds: [evidenceId, second],
      leanCanvas: canvas,
    };
    expect(() =>
      validateArtifactContent(
        'opportunities',
        { opportunities: Array.from({ length: 5 }, (_, i) => ({ ...card, id: String(i) })) },
        sources,
      ),
    ).not.toThrow();
    expect(() => validateArtifactContent('opportunities', { opportunities: [card] }, sources)).toThrow();
    expect(() =>
      validateArtifactContent('opportunities', { opportunities: Array(5).fill({ ...card, evidenceIds: [evidenceId] }) }, sources),
    ).toThrow();
  });
  it('refuses claimed source promotion and unknown evidence in nested content', () => {
    expect(() =>
      validateArtifactContent(
        'research',
        { summary: 'Analysis', findings: [{ ...fact, trust: 'verified', evidenceIds: [evidenceId] }] },
        evidence,
      ),
    ).toThrow(/upgrade/);
    expect(() =>
      validateArtifactContent(
        'research',
        { summary: 'Analysis', findings: [{ ...fact, trust: 'claimed', evidenceIds: [randomUUID()] }] },
        evidence,
      ),
    ).toThrow(/absent/);
    expect(() => validateArtifactContent('research', { summary: 'Analysis', findings: [{ ...fact, trust: 'claimed' }] }, evidence)).toThrow(
      /requires evidence/,
    );
  });
  it('blocks incomplete founder handoffs and supports a complete prepared kit', () => {
    const kit = {
      title: 'Submit the exact filing',
      whereToGo: 'https://example.test',
      whatToEnter: ['Exact approved details'],
      whatToBringBack: ['Submission reference'],
      howVerified: 'Review returned reference against exact application',
      status: 'prepared',
      evidenceIds: [],
    };
    expect(() => validateArtifactContent('founder_kit', kit, evidence)).not.toThrow();
    expect(() => validateArtifactContent('founder_kit', { ...kit, whatToBringBack: [] }, evidence)).toThrow();
  });
  it('requires positioning and three generated visual/naming directions', () => {
    expect(() => validateArtifactContent('brand_directions', { directions: [] }, evidence)).toThrow();
    expect(() =>
      validateArtifactContent(
        'brand_directions',
        {
          positioning: { target: '', need: 'Useful', category: 'Product', benefit: 'Benefit', reasonsToBelieve: 'Reason' },
          directions: [],
          names: [],
        },
        evidence,
      ),
    ).toThrow();
  });
  it('rejects unknown generated types instead of bypassing typed validation', () => {
    expect(() => validateArtifactContent('freeform_verified_spec', { text: 'Approved' }, evidence)).toThrow(/unsupported/);
  });
  it('checks compatibility before a product specification can be proposed', () => {
    const product = {
      kind: 'generic',
      components: [{ name: 'body', material: 'material', finish: 'matte', dimensions: { width: 10 }, tolerances: { width: 0.1 } }],
      packaging: ['Protect in transport'],
      labels: ['Research market requirements'],
      dims_mm: { w: 10, h: 20 },
      parts: [{ t: 'rect', x: 0, y: 0, w: 10, h: 20 }],
      dimensions: { left: 10, right: 8 },
      compatibility: [{ left: 'left', right: 'right', relation: 'fits', toleranceMm: 0.1 }],
      sourcingCompatibility: {
        dimensionsMm: { width: 10 },
        rules: [{ left: 'quote.width', right: 'spec.width', relation: 'equal', toleranceMm: 0.1 }],
      },
      specialistWork: [],
    };
    expect(() => validateArtifactContent('product_spec', product, evidence)).toThrow(/incompatible/);
    expect(() => validateArtifactContent('product_spec', { ...product, dimensions: { left: 7, right: 8 } }, evidence)).not.toThrow();
  });
  it('requires actual required-language copy in editable identity packages', () => {
    const assets = {
      editableLogoAssetIds: [randomUUID()],
      palette: ['#000000', '#ffffff'],
      typography: ['Serif'],
      guidelines: 'Use contrast',
      packagingAssetIds: [randomUUID()],
      copy: { en: 'Story' },
    };
    expect(() => validateArtifactContent('brand_assets', assets, evidence, ['en', 'ar'])).toThrow(/market-language/);
    expect(() =>
      validateArtifactContent('brand_assets', { ...assets, copy: { en: 'Story', ar: 'قصة' } }, evidence, ['en', 'ar']),
    ).not.toThrow();
  });
});

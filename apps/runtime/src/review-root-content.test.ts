import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { validateArtifactContent } from './artifact-content.js';

describe('independent production content trust review (I-3/I-6/I-14, FR-EVD-03, FR-EASE-07, FR-CPL-02)', () => {
  const empty = new Map<string, { trust: string }>();
  const kit = {
    title: 'Complete a founder-only identity check',
    whereToGo: 'https://example.test',
    whatToEnter: ['Use the approved application'],
    whatToBringBack: ['Activation reference'],
    howVerified: 'Check provider activation status against the returned reference',
    status: 'prepared',
    evidenceIds: [],
  };
  const item = {
    id: 'registration',
    requirement: 'Check registration with the responsible professional',
    source: 'https://example.test',
    owner: 'Founder',
    status: 'unverified',
    evidenceIds: [],
    professionalRequired: true,
  };
  const checklist = {
    market: 'Unreviewed market',
    category: 'Unreviewed category',
    reviewStatus: 'unverified',
    items: [item],
    prohibitedClaims: [],
  };
  it('a generated task cannot assert verification without any supporting evidence', () => {
    expect(() => validateArtifactContent('founder_kit', { ...kit, status: 'verified' }, empty)).toThrow();
  });
  it('an application model cannot manufacture human review of category/compliance guidance', () => {
    expect(() => validateArtifactContent('compliance_checklist', { ...checklist, reviewStatus: 'reviewed' }, empty)).toThrow();
  });
  it('an unresolved compliance item cannot become satisfied or risk-accepted without evidence', () => {
    for (const status of ['satisfied', 'risk_accepted'])
      expect(() => validateArtifactContent('compliance_checklist', { ...checklist, items: [{ ...item, status }] }, empty)).toThrow();
  });
  it('nested high-trust labels cannot bypass the guard by omitting the evidenceIds key', () => {
    expect(() =>
      validateArtifactContent(
        'note',
        {
          summary: 'A generated note',
          paragraphs: ['No externally verified work has occurred.'],
          figure: { trust: 'verified', source: 'Invented certificate', observedAt: new Date().toISOString() },
        },
        empty,
      ),
    ).toThrow();
  });
  it('claimed findings remain legitimate when linked to current claimed evidence', () => {
    const id = randomUUID();
    expect(() =>
      validateArtifactContent(
        'research',
        {
          summary: 'Supplier statement',
          findings: [
            {
              text: 'The supplier states a term',
              trust: 'claimed',
              evidenceIds: [id],
              source: 'Recorded supplier source',
              observedAt: new Date().toISOString(),
            },
          ],
        },
        new Map([[id, { trust: 'claimed' }]]),
      ),
    ).not.toThrow();
  });
});

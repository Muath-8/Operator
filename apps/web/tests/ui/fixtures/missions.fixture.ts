import type {
  ActivityStep,
  ArtifactView,
  DecisionView,
  EvidenceItem,
  Figure,
  FrameView,
  Inline,
  MissionSummary,
  MissionView,
  Money,
  ReadinessOutcomeView,
  ReadinessLevel,
  RichText,
} from '../../../src/ui-contract';
import {
  BOTTLE,
  BOX,
  CLOSURE,
  ICON_CLOUD,
  ICON_DOC,
  ICON_STRAP,
  JAR,
  MARK_ARCH,
  MARK_CLOUD,
  MARK_DUNES,
  STRAP,
  TABLE,
  exhibit,
} from './specs.fixture';

/**
 * TEST FIXTURE ONLY. Seed missions mirroring the combined prototype (Option D): a perfume launch
 * and a leather watch-strap launch. Never imported by production components.
 */

export const sar = (major: number): Money => ({ amountMinor: Math.round(major * 100), currency: 'SAR' });
/** Day in November 2026, or "MM-DD" for another month. */
const at = (d: string, time = '09:00') => (d.includes('-') ? `2026-${d}T${time}:00+03:00` : `2026-11-${d}T${time}:00+03:00`);
const x = (text: string): Inline => ({ t: 'text', text });
const fig = (
  id: string,
  value: Figure['value'],
  trust: Figure['trust'],
  label: string,
  d: string,
  note?: string,
  original?: string,
): Figure => ({
  id,
  value,
  trust,
  source: { label },
  observedAt: at(d),
  ...(note ? { note } : {}),
  ...(original ? { original } : {}),
});
const ev = (id: string, trust: EvidenceItem['trust'], text: string, label: string, d: string): EvidenceItem => ({
  id,
  trust,
  text,
  source: { label },
  observedAt: at(d),
});
const F = (f: Figure): Inline => ({ t: 'figure', figure: f });
const term = (text: string, termId: string): Inline => ({ t: 'term', text, termId });

const glossary = {
  moq: { term: 'MOQ', definition: 'Minimum order quantity: the smallest number of units a supplier will make or sell in one order.' },
  landed: {
    term: 'Landed cost',
    definition: 'Everything it costs to have one sellable unit in your hands: product, packaging, shipping, duties and fees.',
  },
  proforma: {
    term: 'Proforma invoice',
    definition: 'A supplier’s formal quote laid out as an invoice. You accept it before paying a deposit.',
  },
  incoterm: {
    term: 'Incoterm',
    definition: 'A standard trade term saying where the supplier’s responsibility for shipping and risk ends and yours begins.',
  },
  mandate: {
    term: 'Mandate',
    definition: 'A permission you give me with a scope, a ceiling and an end date. Inside it I act and report; outside it I ask.',
  },
  lead: { term: 'Lead time', definition: 'Days from a confirmed order to goods ready for collection or dispatch.' },
} as const;

function rungs(level: number, evidence: readonly EvidenceItem[], missing: string): ReadinessOutcomeView['rungs'] {
  return ([1, 2, 3, 4, 5] as const).map(l => ({ level: l, met: l <= level, evidence: l <= level ? evidence : [], missing }));
}

/* ===================================================================== */
/* Ghaymah: perfume launch                                                */
/* ===================================================================== */

const qA = fig(
  'f-qA',
  { kind: 'money', amount: sar(9.8), per: 'a bottle' },
  'claimed',
  'Supplier A, quote PDF',
  '09',
  'Quoted USD 2.61, converted at 3.75',
  'USD 2.61',
);
const qB = fig(
  'f-qB',
  { kind: 'money', amount: sar(12.6), per: 'a bottle' },
  'claimed',
  'Supplier B, WhatsApp message',
  '06',
  'Stock BR-50, valid to 30 Nov',
);
const qC = fig(
  'f-qC',
  { kind: 'money', amount: sar(11.9), per: 'a bottle' },
  'claimed',
  'Supplier C, email',
  '05',
  'Expired 8 Nov; revised quote overdue',
);
const regB = ev('e-regB', 'verified', 'Registration verified', 'Ministry of Commerce lookup, receipt lk-0412', '10');
const fc = fig('f-fc', { kind: 'money', amount: sar(26220) }, 'planned', 'Cost model v4', '11', 'An estimate, not a quote, ±15%');

const bottleA = exhibit(BOTTLE('AX-50', 84, 70, 10, 20, 28, 30), 'AX-50, 84 by 108 millimetres, SAR 9.80, MOQ 3,000');
const bottleB = exhibit(BOTTLE('BR-50', 70, 84, 5, 18, 24, 28), 'BR-50, 70 by 120 millimetres, SAR 12.60, MOQ 500');
const bottleC = exhibit(BOTTLE('CL-50', 78, 76, 22, 20, 28, 28), 'CL-50, 78 by 112 millimetres, SAR 11.90, MOQ 2,000');
const nightGarden = ['#1C2440', '#7A86BC', '#ECE9F3', '#B9975A'];

const quotesFrames: FrameView[] = [
  {
    id: 'shelf',
    title: 'Bottles to scale',
    meta: 'one mm grid',
    width: 610,
    row: 0,
    pinDecisionId: 'd-supplier',
    pins: [],
    summary: 'Three bottles drawn to one millimetre scale with price and minimum order against your 1,000-unit limit.',
    body: {
      k: 'shelf',
      decisionId: 'd-supplier',
      limit: { value: 1000, label: 'Your limit, 1,000 units' },
      items: [
        {
          id: 'A',
          title: 'Supplier A',
          subtitle: 'Glassworks, Zhejiang',
          plate: bottleA,
          price: qA,
          quantity: fig('f-mA', { kind: 'quantity', value: 3000, unit: 'units' }, 'claimed', 'Supplier A', '09'),
          quantityValue: 3000,
          tag: null,
          decisionOptionId: 'A',
          caption: 'MOQ 3,000, 3× your limit',
          captionTone: 'warning',
        },
        {
          id: 'B',
          title: 'Supplier B',
          subtitle: 'Distributor, Jeddah',
          plate: bottleB,
          price: qB,
          quantity: fig('f-mB', { kind: 'quantity', value: 500, unit: 'units' }, 'claimed', 'Supplier B', '06'),
          quantityValue: 500,
          tag: 'recommended',
          decisionOptionId: 'B',
          caption: 'MOQ 500, inside your limit',
          captionTone: 'neutral',
          verification: regB,
        },
        {
          id: 'C',
          title: 'Supplier C',
          subtitle: 'Distributor, Dubai',
          plate: bottleC,
          price: qC,
          quantity: fig('f-mC', { kind: 'quantity', value: 2000, unit: 'units' }, 'claimed', 'Supplier C', '05'),
          quantityValue: 2000,
          tag: null,
          decisionOptionId: null,
          caption: 'MOQ 2,000, 2× your limit',
          captionTone: 'warning',
        },
      ],
    },
    inspector: {
      typeLabel: 'Comparison',
      serves: 'supply',
      versions: [
        {
          id: 'qv1',
          versionNo: 1,
          createdAt: at('12', '07:30'),
          note: 'Normalised to SAR, drawn from each supplier’s drawing',
          status: 'proposed',
        },
      ],
      currentVersionId: 'qv1',
      evidence: [
        ev('e1', 'claimed', 'Supplier A: quote PDF, 9 Nov', 'Supplier A', '09'),
        ev('e2', 'claimed', 'Supplier B: WhatsApp, 6 Nov', 'Supplier B', '06'),
        ev('e3', 'claimed', 'Supplier C: email, 5 Nov', 'Supplier C', '05'),
        regB,
      ],
      comments: [],
      allowVariation: false,
      actions: [],
    },
  },
  {
    id: 'terms',
    title: 'Normalised terms',
    meta: 'every figure marked',
    width: 640,
    row: 0,
    pins: [],
    summary: 'Unit price, minimum order, lead time, Incoterm, payment and validity for each supplier.',
    body: {
      k: 'table',
      columns: [
        { id: 'A', label: 'Supplier A' },
        { id: 'B', label: 'Supplier B', highlight: true },
        { id: 'C', label: 'Supplier C' },
      ],
      rows: [
        {
          label: 'Unit price',
          cells: [
            { figure: qA, notes: [[x('USD 2.61 in the original, corrected')]] },
            {
              figure: qB,
              notes: [
                [
                  x('Registration '),
                  {
                    t: 'figure',
                    figure: fig(
                      'f-regB2',
                      { kind: 'text', text: 'verified' },
                      'verified',
                      'Ministry of Commerce lookup, receipt lk-0412',
                      '10',
                    ),
                  },
                ],
              ],
            },
            { figure: qC, notes: [[x('Quote expired 8 Nov')]] },
          ],
        },
        {
          label: 'MOQ',
          termId: 'moq',
          cells: [
            { figure: fig('t-mA', { kind: 'quantity', value: 3000, unit: '' }, 'claimed', 'Supplier A', '09'), tone: 'warning' },
            { figure: fig('t-mB', { kind: 'quantity', value: 500, unit: '' }, 'claimed', 'Supplier B', '06') },
            { figure: fig('t-mC', { kind: 'quantity', value: 2000, unit: '' }, 'claimed', 'Supplier C', '05'), tone: 'warning' },
          ],
        },
        {
          label: 'Lead time',
          termId: 'lead',
          cells: [
            { figure: fig('t-lA', { kind: 'duration', days: 40 }, 'claimed', 'Supplier A', '09') },
            { figure: fig('t-lB', { kind: 'duration', days: 21 }, 'claimed', 'Supplier B', '06') },
            { figure: fig('t-lC', { kind: 'duration', days: 30 }, 'claimed', 'Supplier C', '05') },
          ],
        },
        {
          label: 'Incoterm',
          termId: 'incoterm',
          cells: [
            { figure: fig('t-iA', { kind: 'text', text: 'FOB Ningbo' }, 'claimed', 'Supplier A', '09') },
            { figure: fig('t-iB', { kind: 'text', text: 'EXW Jeddah' }, 'claimed', 'Supplier B', '06') },
            { figure: fig('t-iC', { kind: 'text', text: 'DAP Riyadh' }, 'claimed', 'Supplier C', '05') },
          ],
        },
        {
          label: 'Payment',
          cells: [
            { figure: fig('t-pA', { kind: 'text', text: '30% deposit, 70% before shipping' }, 'claimed', 'Supplier A', '09') },
            { figure: fig('t-pB', { kind: 'text', text: '50% deposit, 50% on collection' }, 'claimed', 'Supplier B', '06') },
            { figure: fig('t-pC', { kind: 'text', text: '100% in advance' }, 'claimed', 'Supplier C', '05') },
          ],
        },
        {
          label: 'Valid until',
          cells: [
            { figure: fig('t-vA', { kind: 'date', date: '2026-11-30' }, 'claimed', 'Supplier A', '09') },
            { figure: fig('t-vB', { kind: 'date', date: '2026-11-30' }, 'claimed', 'Supplier B', '06') },
            { figure: fig('t-vC', { kind: 'text', text: '8 Nov, expired' }, 'claimed', 'Supplier C', '05'), tone: 'warning' },
          ],
        },
      ],
      legend: ['claimed', 'verified'],
    },
    inspector: {
      typeLabel: 'Quotation comparison',
      serves: 'supply',
      versions: [{ id: 'qv1', versionNo: 1, createdAt: at('12', '07:30'), note: 'Normalised to SAR a bottle', status: 'proposed' }],
      currentVersionId: 'qv1',
      evidence: [regB],
      comments: [],
      allowVariation: false,
      actions: [],
    },
  },
  {
    id: 'score',
    title: 'Supplier scorecard',
    meta: '8 criteria',
    width: 560,
    row: 0,
    pins: [],
    summary: 'Eight criteria; three stay unobserved until samples arrive.',
    body: {
      k: 'table',
      columns: [
        { id: 'A', label: 'Supplier A' },
        { id: 'B', label: 'Supplier B', highlight: true },
        { id: 'C', label: 'Supplier C' },
      ],
      rows: [
        ['Response speed', '6 h average', 'Same day', '3 days, 2 chases'],
        ['Language quality', 'Clear English', 'Native Arabic', 'Adequate English'],
        ['Sample quality', null, null, null],
        ['Price', 'Lowest of three', 'Middle', 'Low, expired'],
        ['MOQ flexibility', 'Refused 1,000', 'Offered 500 stock', 'No answer yet'],
        ['On-time delivery', null, null, null],
        ['Defect rate', null, null, null],
        ['Communication', 'Structured, fast', 'Sent drawings unprompted', 'Slow'],
      ].map(([label, ...cells]) => ({
        label: label ?? '',
        cells: cells.map(c => (c ? { text: c, why: 'Observed from the thread and mailbox timestamps' } : { unobserved: true })),
      })),
      legend: [],
      footnote: 'Three criteria stay unobserved until samples arrive.',
    },
    inspector: {
      typeLabel: 'Scorecard',
      serves: 'supply',
      versions: [{ id: 'sv', versionNo: 1, createdAt: at('12'), note: 'From what I have observed', status: 'draft' }],
      currentVersionId: 'sv',
      evidence: [ev('e-rt', 'performed', 'Response times measured from mailbox timestamps', 'Project mailbox', '11')],
      comments: [],
      allowVariation: false,
      actions: [],
    },
  },
];

const dirFrame = (
  id: string,
  title: string,
  palette: string[],
  bgI: number,
  fgI: number,
  mark: typeof MARK_CLOUD,
  typeface: 'serif' | 'sans',
  status: string,
  pos: string,
  versions: { v: number; note: string; d: string }[],
  current: number,
  extra: Partial<FrameView> = {},
): FrameView => ({
  id,
  title,
  meta: `v${current}`,
  width: 300,
  row: 0,
  pins: [],
  summary: `${title}: ${pos}`,
  body: {
    k: 'identity',
    wordmark: 'Ghaymah',
    wordmarkAlt: { text: 'غيمة', lang: 'ar' },
    mark,
    palette,
    background: bgI,
    foreground: fgI,
    typeface,
    positioning: pos,
    statusLabel: status,
    versionChips: versions.map(v => ({ versionId: `${id}-v${v.v}`, label: `v${v.v}`, current: v.v === current })),
  },
  inspector: {
    typeLabel: 'Brand direction',
    serves: 'brand',
    versions: versions.map(v => ({
      id: `${id}-v${v.v}`,
      versionNo: v.v,
      createdAt: at(v.d),
      note: v.note,
      status: status.startsWith('Your') ? 'approved' : 'proposed',
    })),
    currentVersionId: `${id}-v${current}`,
    evidence: [
      ev(`${id}-e1`, 'performed', 'Naming and handle checks', 'Registrar and social lookups', '27'),
      ev(`${id}-e2`, 'performed', 'Trademark screen, class 3', 'Trademark database', '27'),
    ],
    comments: id === 'dir2' ? [{ id: 'c-l', author: 'Layla', text: 'Less shiny on the brass, please.', at: at('10-29') }] : [],
    allowVariation: true,
    actions: status.startsWith('Your') ? [] : [{ id: `return-${id}`, label: `Return to ${title}`, kind: 'command', runsImpact: true }],
  },
  ...extra,
});

const brandFrames: FrameView[] = [
  dirFrame(
    'dir1',
    'Courtyard Ember',
    ['#6E2A1C', '#D29A55', '#F2E4CF', '#2A1A13'],
    2,
    0,
    MARK_ARCH,
    'serif',
    'Set aside',
    'The generous house of warm oud and amber, made to be shared at a family gathering.',
    [{ v: 1, note: 'First pass', d: '10-27' }],
    1,
  ),
  dirFrame(
    'dir2',
    'Night Garden',
    nightGarden,
    0,
    2,
    MARK_CLOUD,
    'serif',
    'Your identity, v2',
    'The quiet modern house of Arabian florals, each scent built around one remembered evening.',
    [
      { v: 1, note: 'First pass', d: '10-27' },
      { v: 2, note: 'Softer mist, brass toned down (your note: “less shiny”)', d: '10-29' },
    ],
    2,
  ),
  dirFrame(
    'dir3',
    'Desert Line',
    ['#3E4A3D', '#C8C2B4', '#FAFAF7', '#8C6E4E'],
    2,
    0,
    MARK_DUNES,
    'sans',
    'Not chosen',
    'The clean-lined house of light desert notes, with fewer ingredients and every one named on the box.',
    [{ v: 1, note: 'First pass', d: '10-27' }],
    1,
  ),
];

const packTint = { palette: nightGarden, byRole: { body: 2, neck: 2, closure: 3, box: 0, mark: 3, ink: 2 }, stroke: 0, mark: MARK_CLOUD };
const packFrames = (bottle: typeof bottleA, box: ReturnType<typeof BOX>, stale: boolean, v: number): FrameView[] => [
  {
    id: 'pack',
    title: 'Packaging',
    meta: `v${v}`,
    statusNote: stale ? 'stale' : 'draft',
    stale,
    width: 520,
    row: 0,
    pins: [],
    summary: 'The bottle with its closure and outer box, in the brand colours, at the quote scale.',
    body: {
      k: 'plates',
      items: [
        exhibit(bottle.spec, bottle.summary, { tint: packTint, finish: 'matte' }),
        exhibit(box, `${box.code} outer box`, { tint: packTint }),
      ],
      caption: stale
        ? `${bottle.spec.code ?? ''} with its closure and outer box, in Night Garden colours. Drawn for the old bottle; it may change.`
        : `${bottle.spec.code ?? ''} with its closure and outer box, in Night Garden colours. Same scale as the quotes.`,
    },
    inspector: {
      typeLabel: 'Packaging visual',
      serves: 'product',
      versions: [
        { id: 'pv1', versionNo: 1, createdAt: at('28'), note: 'First concept', status: 'superseded' },
        { id: 'pv2', versionNo: 2, createdAt: at('30'), note: 'Night Garden colours on AX-50', status: stale ? 'stale' : 'superseded' },
        ...(v >= 3 ? [{ id: 'pv3', versionNo: 3, createdAt: at('12'), note: 'Redrawn for BR-50', status: 'draft' as const }] : []),
      ],
      currentVersionId: `pv${v}`,
      evidence: [
        ev('pe1', 'performed', 'Drawn from the approved direction and the spec', 'Brand specialist', '30'),
        ev('pe2', 'claimed', `${bottle.spec.code ?? ''} drawing from the supplier`, 'Supplier drawing', '06'),
      ],
      comments: [],
      allowVariation: true,
      actions: [{ id: 'open-spec', label: 'Open the product spec', kind: 'open', target: { kind: 'artifact', artifactId: 'spec' } }],
    },
  },
  {
    id: 'finish',
    title: 'Closure finish',
    meta: 'has a default',
    width: 260,
    row: 0,
    pinDecisionId: 'd-finish',
    pins: [{ id: 'cp1', x: 0.62, y: 0.28, author: 'Layla', text: 'Matte looks calmer here.', at: at('11') }],
    summary: 'Matte and gloss at the same cost.',
    body: {
      k: 'choices',
      decisionId: 'd-finish',
      items: [
        {
          optionId: 'matte',
          label: 'Matte',
          plate: exhibit(CLOSURE, 'Closure, matte', { finish: 'matte', tint: packTint }),
          chosen: false,
        },
        {
          optionId: 'gloss',
          label: 'Gloss',
          plate: exhibit(CLOSURE, 'Closure, gloss', { finish: 'gloss', tint: packTint }),
          chosen: false,
        },
      ],
    },
    inspector: {
      typeLabel: 'Finish study',
      serves: 'product',
      versions: [{ id: 'fv1', versionNo: 1, createdAt: at('10'), note: 'Matte and gloss at the same cost', status: 'proposed' }],
      currentVersionId: 'fv1',
      evidence: [ev('fe1', 'claimed', 'Closure maker quote: same price for both', 'Closure maker', '10')],
      comments: [],
      allowVariation: false,
      actions: [],
    },
  },
];

function perfumeArtifacts(): Record<string, ArtifactView> {
  const boxV2 = BOX('BX-90', 90, 125, 'GHAYMAH', 'غيمة', '50 ml eau de parfum');
  return {
    quotes: {
      id: 'quotes',
      type: 'comparison',
      title: 'Bottle quotes',
      outcome: 'supply',
      status: 'proposed',
      currentVersionId: 'qv1',
      versions: [{ id: 'qv1', versionNo: 1, createdAt: at('12', '07:30'), note: 'Three quotes', status: 'proposed' }],
      embed: {
        subtitle: '3 quotes, normalised to SAR a bottle and drawn to scale',
        thumbnail: { kind: 'plates', plates: [bottleA, bottleB, bottleC] },
      },
      icon: 'shelf',
      content: { kind: 'canvas', frames: quotesFrames, focusFrameId: 'shelf' },
      actions: [],
    },
    brand: {
      id: 'brand',
      type: 'visual',
      title: 'Brand directions',
      outcome: 'brand',
      status: 'approved',
      currentVersionId: 'bv2',
      versions: [{ id: 'bv2', versionNo: 2, createdAt: at('29'), note: 'Night Garden v2 approved', status: 'approved' }],
      embed: {
        subtitle: 'Night Garden is your identity; 2 more on the canvas',
        thumbnail: { kind: 'swatches', swatches: [['#F2E4CF'], ['#1C2440'], ['#FAFAF7']] },
      },
      icon: 'swatch',
      preferWide: true,
      content: { kind: 'canvas', frames: brandFrames, focusFrameId: 'all' },
      actions: [],
    },
    pack: {
      id: 'pack',
      type: 'visual',
      title: 'Packaging v2',
      outcome: 'product',
      status: 'stale',
      currentVersionId: 'pv2',
      versions: [
        { id: 'pv1', versionNo: 1, createdAt: at('28'), note: 'First concept', status: 'superseded' },
        { id: 'pv2', versionNo: 2, createdAt: at('30'), note: 'Night Garden colours on AX-50', status: 'stale' },
      ],
      embed: {
        subtitle: 'Stale: the bottle may change',
        thumbnail: {
          kind: 'plates',
          plates: [exhibit(bottleA.spec, 'AX-50', { tint: packTint }), exhibit(boxV2, 'BX-90', { tint: packTint })],
        },
      },
      icon: 'box',
      content: { kind: 'canvas', frames: packFrames(bottleA, boxV2, true, 2), focusFrameId: 'pack' },
      actions: [],
    },
    spec: {
      id: 'spec',
      type: 'document',
      title: 'Product spec v2',
      outcome: 'product',
      status: 'stale',
      currentVersionId: 'spv2',
      versions: [
        {
          id: 'spv2',
          versionNo: 2,
          createdAt: at('30'),
          note: 'Stock AX-50',
          status: 'stale',
          sentTo: [{ counterparty: 'Supplier A', at: at('04') }],
        },
      ],
      embed: { subtitle: 'Stale: v3 is drafted and waits on your decision', thumbnail: { kind: 'plates', plates: [bottleA] } },
      icon: 'doc',
      content: {
        kind: 'document',
        sections: [
          { k: 'heading', text: 'Product spec v2' },
          { k: 'lead', text: [x('Stale: v3 is drafted and waits on your decision.')] },
          { k: 'plates', items: [bottleA, exhibit(boxV2, 'BX-90 outer box, 90 by 125 millimetres')] },
          { k: 'heading', text: 'Specification', note: 'v1 to v2' },
          {
            k: 'fields',
            diffLabel: 'v1 to v2',
            rows: [
              { label: 'Format', value: '50 ml eau de parfum' },
              { label: 'Bottle', value: 'Stock AX-50 flint glass, Supplier A', previous: 'Custom bottle, to be sourced' },
              { label: 'Bottle size', value: '84 × 108 mm' },
              { label: 'Neck finish', value: 'FEA 15' },
              { label: 'Closure', value: 'Custom zamac, brass, finish open' },
              { label: 'Box', value: 'Rigid board, 90 × 90 × 125 mm' },
              { label: 'Order quantity', value: '1,000 units', previous: '2,000 units' },
            ],
          },
        ],
      },
      actions: [],
    },
    thread: {
      id: 'thread',
      type: 'thread',
      title: 'Supplier B',
      outcome: 'supply',
      status: 'approved',
      currentVersionId: 'th',
      versions: [{ id: 'th', versionNo: 1, createdAt: at('10'), note: 'Live thread', status: 'approved' }],
      embed: { subtitle: '1 draft waiting for you', thumbnail: { kind: 'icon', icon: 'mail' } },
      icon: 'mail',
      content: {
        kind: 'thread',
        counterparty: { name: 'Supplier B', subtitle: 'Packaging distributor, Jeddah', verification: regB },
        help: { targetId: 'thread-b', targetKind: 'thread', mode: 'guide', allowed: ['guide', 'do', 'help'] },
        note: 'Arabic originals beside faithful translations',
        messages: [
          {
            id: 'msg-7f3a04',
            direction: 'outbound',
            channel: 'email',
            at: at('31', '09:12').replace('11-31', '10-31'),
            author: 'Mission Lead',
            original: {
              lang: 'ar',
              text: 'السلام عليكم،\nأنا مساعد آلي يعمل بالذكاء الاصطناعي نيابةً عن ليلى، مؤسِّسة علامة «غيمة» للعطور في الرياض.\nنبحث عن عبوة زجاجية سعة 50 مل مع غطاء مخصص. نرجو تزويدنا بالسعر والحد الأدنى للطلب ومدة التسليم.',
            },
            translation: {
              lang: 'en',
              text: 'Hello,\nI am an AI assistant acting for Layla, founder of the Ghaymah perfume brand in Riyadh.\nWe are looking for a 50 ml glass bottle with a custom closure. Please share your price, minimum order and lead time.',
            },
            authority: {
              label: 'Outreach mandate, contact 4 of 15',
              evidence: ev('au1', 'performed', 'msg-7f3a04, project mailbox log', 'Project mailbox', '31'),
            },
            reference: 'msg-7f3a04',
            delivery: 'delivered',
          },
          {
            id: 'in-b-0311',
            direction: 'inbound',
            channel: 'email',
            at: at('03', '14:40'),
            author: 'Supplier B',
            original: {
              lang: 'ar',
              text: 'وعليكم السلام،\nسعر العبوة المزخرفة 14.20 ريال للقطعة، والحد الأدنى للطلب 1000 قطعة، ومدة التسليم 35 يوماً.',
            },
            translation: {
              lang: 'en',
              text: 'Hello,\nThe decorated bottle is SAR 14.20 a piece, minimum order 1,000 pieces, lead time 35 days.',
            },
            reference: 'in-b-0311',
            delivery: 'received',
          },
          {
            id: 'wa-b-0611',
            direction: 'inbound',
            channel: 'whatsapp',
            at: at('06', '13:15'),
            author: 'Supplier B',
            original: {
              lang: 'ar',
              text: 'نعم، العبوة الجاهزة BR-50 بسعر 12.60 ريال، والحد الأدنى 500 قطعة، والتسليم خلال 21 يوماً. العرض ساري حتى 30 نوفمبر.',
            },
            translation: {
              lang: 'en',
              text: 'Yes, stock bottle BR-50 at SAR 12.60, minimum 500 pieces, delivery within 21 days. Offer valid until 30 November.',
            },
            figures: [qB],
            reference: 'wa-b-0611',
            delivery: 'received',
          },
          {
            id: 'call-1',
            direction: 'call',
            channel: 'voice',
            at: at('10', '11:20'),
            author: 'Supplier B',
            original: { lang: 'ar', text: '' },
            delivery: 'received',
            authority: {
              label: 'Outreach mandate, follow-up on an authorised thread',
              evidence: ev('au2', 'performed', 'Call log', 'Voice service', '10'),
            },
            call: {
              durationMinutes: 6,
              summary: [
                'Confirmed BR-50 is in stock in Jeddah; 500 units ship in 21 days',
                'Would hold SAR 12.60 for 500 units until 20 Nov',
                'Neck finish FEA 15 fits the closure maker’s drawing',
              ],
              recordingUrl: '#recording',
              evidence: ev('e-call', 'claimed', 'Verbal, phone call 10 Nov', 'Phone call', '10'),
              confirmation: 'Terms are claimed (verbal) until confirmed in writing. The written confirmation is below.',
            },
          },
          {
            id: 'msg-7f3b12',
            direction: 'outbound',
            channel: 'email',
            at: at('10', '11:41'),
            author: 'Mission Lead',
            original: {
              lang: 'ar',
              text: 'شكراً على المكالمة. للتأكيد كتابياً: سعر 12.60 ريال لـ500 عبوة BR-50 حتى 20 نوفمبر. نرجو الرد بالتأكيد.',
            },
            translation: {
              lang: 'en',
              text: 'Thank you for the call. To confirm in writing: SAR 12.60 for 500 BR-50 bottles until 20 November. Please reply to confirm.',
            },
            authority: {
              label: 'Written confirmation of the call, same mandate',
              evidence: ev('au3', 'performed', 'msg-7f3b12, project mailbox log', 'Project mailbox', '10'),
            },
            reference: 'msg-7f3b12',
            attachments: [{ label: 'Spec', versionLabel: 'v2', sentAt: at('04') }],
            delivery: 'delivered',
          },
          {
            id: 'msg-d-fail',
            direction: 'outbound',
            channel: 'email',
            at: at('11', '18:02'),
            author: 'Mission Lead',
            original: { lang: 'en', text: 'Following up on drawings for the closure fit.' },
            delivery: 'failed',
            failure: { reason: '550 mailbox unavailable', retryStepId: 'a5' },
            reference: 'msg-7f3b19',
          },
        ],
        draft: {
          id: 'draft-1',
          channel: 'email',
          original: {
            lang: 'ar',
            text: 'شكراً على الرسم الفني. نرغب في معرفة تكلفة 3 عينات من BR-50 مع الشحن إلى الرياض، دون أي التزام بكمية.',
          },
          translation: {
            lang: 'en',
            text: 'Thank you for the technical drawing. Could you quote 3 BR-50 samples shipped to Riyadh? This does not commit us to any quantity.',
          },
          heldBecause: 'Held for you because Supplier B is set to Guide me.',
          mandateUsage: 'Sending uses the outreach mandate (11 of 15 used).',
          evidence: ev('dr1', 'planned', 'Drafted today. Not sent.', 'Mission Lead', '12'),
        },
      },
      actions: [],
    },
  };
}

function perfumeDecisions(): Record<string, DecisionView> {
  return {
    'd-supplier': {
      id: 'd-supplier',
      kind: 'selection',
      topic: 'bottle route',
      question: 'Which bottle route should we take?',
      context: [x('Supplier A is cheapest, but needs 3,000 bottles against your limit of 1,000.')],
      options: [
        {
          id: 'B',
          label: [x('Switch to Supplier B’s stock bottle at '), term('MOQ', 'moq'), x(' 500')],
          shortLabel: 'stock bottle',
          actionLabel: 'Approve stock bottle',
          description: [F(qB), x(', ready in 21 days. Packaging is redrawn for the new size.')],
          effects: [
            { label: 'Forecast', value: '−SAR 1,100' },
            { label: 'Redoes', value: 'packaging v2, spec v2, cost model v4' },
          ],
        },
        {
          id: 'A',
          label: [x('Negotiate a split order with Supplier A')],
          shortLabel: 'split order',
          actionLabel: 'Negotiate the split order',
          description: [x('Ask for 1,000 now and 2,000 called off within a year. '), F(qA), x(' holds only if they agree.')],
          effects: [
            { label: 'Commits you to', value: '3,000 bottles over 12 months' },
            { label: 'Delay', value: '5 to 8 days' },
          ],
        },
        {
          id: 'R',
          label: [x('Raise the budget and take 3,000 from Supplier A')],
          shortLabel: 'raise the budget',
          actionLabel: 'Raise the budget',
          description: [x('Best unit price, but breaks your 1,000-unit inventory limit.')],
          effects: [
            { label: 'Budget', value: 'about SAR 49,600' },
            { label: 'Makes stale', value: 'every envelope, cost model v4' },
          ],
        },
      ],
      recommendedOptionId: 'B',
      why: [
        [
          x('Supplier B’s stock bottle keeps you inside 1,000 units and the budget, and its 21-day '),
          term('lead time', 'lead'),
          x(
            ' lets samples go out this week. You pay SAR 2.80 more per bottle than Supplier A’s headline price, about SAR 1,400 across 500 units, and Supplier B is the only one whose registration I have verified.',
          ),
        ],
      ],
      binding: true,
      needsBy: at('15', '18:00'),
      defaultLine: 'If you don’t answer by 15 Nov, I wait: nothing is ordered, and brand and store work keep moving.',
      status: 'pending',
      resolution: null,
      supersededById: null,
      supersedesId: null,
      canChange: false,
      evidence: { artifactId: 'quotes', frameId: 'shelf' },
      blocks: 'Waiting holds back product spec v3, packaging v3 and the proforma request.',
    },
    'd-samples': {
      id: 'd-samples',
      kind: 'mandate',
      topic: 'sample mandate',
      question: 'May I spend up to SAR 2,500 on paid samples?',
      context: [x('Up to SAR 800 each, from up to 4 suppliers, until 30 Nov. Product can’t reach Verified without a sample you approve.')],
      options: [
        {
          id: 'grant',
          label: [x('Grant SAR 2,500 total, 4 suppliers, until 30 Nov')],
          shortLabel: 'granted',
          actionLabel: 'Grant mandate',
          description: [x('I order, pay inside the ceiling, and file each receipt here.')],
          effects: [
            { label: 'From', value: 'samples envelope' },
            { label: 'Arrive', value: 'about 10 days' },
          ],
        },
        {
          id: 'tight',
          label: [x('Grant for 2 suppliers, SAR 1,200 total')],
          shortLabel: '2 suppliers, SAR 1,200',
          actionLabel: 'Grant the smaller mandate',
          description: [x('Bottle and closure only; box samples wait.')],
          effects: [{ label: 'Ceiling', value: 'SAR 1,200' }],
        },
        {
          id: 'show',
          label: [x('Show me each sample order before paying')],
          shortLabel: 'show me each order',
          actionLabel: 'Approve each order myself',
          description: [x('Every order comes to you as its own approval.')],
          effects: [{ label: 'Speed', value: 'about 1 day slower each' }],
        },
      ],
      recommendedOptionId: 'grant',
      why: [
        [
          x(
            'Paid samples are how you check glass, closure fit and print before committing to 500 units. The samples envelope already holds SAR 2,500, so this spends nothing outside your plan.',
          ),
        ],
      ],
      binding: true,
      needsBy: at('15', '18:00'),
      defaultLine: 'No samples are ordered until you answer.',
      status: 'pending',
      resolution: null,
      supersededById: null,
      supersedesId: null,
      canChange: false,
      evidence: { system: 'money' },
      mandateScope: {
        ceiling: sar(2500),
        ceilingMax: sar(2500),
        perItemCeiling: sar(800),
        count: 4,
        countMax: 6,
        countUnit: 'suppliers',
        expiresOn: '2026-11-30',
        expiresMax: '2026-12-31',
      },
    },
    'd-finish': {
      id: 'd-finish',
      kind: 'visual',
      topic: 'closure finish',
      question: 'Matte or gloss for the custom closure?',
      context: [x('Same cost at this quantity. Non-binding: it becomes matte on 18 Nov if you leave it.')],
      options: [
        {
          id: 'matte',
          label: [x('Matte')],
          shortLabel: 'matte',
          actionLabel: 'Approve matte',
          description: [x('Soft-touch brass.')],
          effects: [],
          visual: exhibit(CLOSURE, 'Closure, matte', { finish: 'matte', tint: packTint }),
        },
        {
          id: 'gloss',
          label: [x('Gloss')],
          shortLabel: 'gloss',
          actionLabel: 'Choose gloss',
          description: [x('Polished brass.')],
          effects: [],
          visual: exhibit(CLOSURE, 'Closure, gloss', { finish: 'gloss', tint: packTint }),
        },
      ],
      recommendedOptionId: 'matte',
      why: [[x('Matte suits the Night Garden palette and hides fingerprints. Nothing else depends on this choice.')]],
      binding: false,
      needsBy: at('18', '18:00'),
      defaultLine: 'Resolves to matte on 18 Nov, with a note here.',
      status: 'pending',
      resolution: null,
      supersededById: null,
      supersedesId: null,
      canChange: false,
      evidence: { artifactId: 'pack', frameId: 'finish' },
    },
  };
}

function perfumeActivity(): Record<string, ActivityStep> {
  const s = (
    id: string,
    label: ActivityStep['label'],
    title: string,
    details: RichText[],
    extra: Partial<ActivityStep> = {},
  ): ActivityStep => ({ id, label, title: [x(title)], details, at: at('11'), ...extra });
  return {
    a1: s(
      'a1',
      'claimed',
      'Collected three bottle quotes',
      [
        [x('Supplier A: USD 2.61 a bottle, MOQ 3,000, 40 days, FOB Ningbo, 9 Nov')],
        [x('Supplier B: stock BR-50, SAR 12.60, MOQ 500, 21 days, 6 Nov')],
        [x('Supplier C: SAR 11.90, MOQ 2,000; expired 8 Nov')],
      ],
      { help: { targetId: 'chase', targetKind: 'activity', mode: 'do', allowed: ['guide', 'do', 'help'] } },
    ),
    a2: s(
      'a2',
      'verified',
      'Verified Supplier B’s commercial registration',
      [[x('Name and Jeddah address match the Ministry of Commerce record')]],
      { receipts: [ev('rc1', 'verified', 'receipt lk-0412', 'Ministry of Commerce', '10')] },
    ),
    a3: s('a3', 'corrected', 'Corrected my reading of Supplier A’s price', [
      [
        x('I first read '),
        { t: 'correction', from: 'SAR 2.61', to: 'SAR 9.80' },
        x('; the PDF states USD, so it is SAR 9.80 at 3.75. The comparison was re-ranked before you saw it.'),
      ],
    ]),
    a4: s(
      'a4',
      'performed',
      'Chased Supplier C twice for a revised quote',
      [[x('msg-7f3c01, 9 Nov')], [x('msg-7f3c02, 11 Nov')], [x('Two days overdue. Marketplace message next, on 13 Nov.')]],
      { help: { targetId: 'chase', targetKind: 'activity', mode: 'do', allowed: ['guide', 'do', 'help'] } },
    ),
    a5: s('a5', 'failed', 'Follow-up to Supplier D bounced', [[x('550 mailbox unavailable, 11 Nov 18:02')]], {
      retry: { label: 'Retry now by marketplace message' },
    }),
  };
}

const outcomesPerfume = (lv: Record<string, number>): ReadinessOutcomeView[] => {
  const blockers: Record<string, string> = {
    brand: 'The editable asset package isn’t exported yet; it’s due 14 Nov.',
    product: 'Product dropped back on 9 Nov, when Supplier A’s minimum order reopened the bottle choice.',
    supply: 'Supply waits on your bottle route.',
    commerce: 'Pricing waits on an accepted quote.',
    compliance: 'The Arabic labelling rule needs a qualified confirmation.',
    demand: 'The demand scan runs after the supplier choice.',
  };
  const stale: Record<string, string> = { product: 'Packaging v2 and spec v2 are stale.', commerce: 'Cost model v4 is stale.' };
  const evid: Record<string, EvidenceItem[]> = {
    brand: [
      ev('rb1', 'performed', 'Feasibility brief from 18 sources', 'Research specialist', '20'),
      ev('rb2', 'founder_confirmed', 'Direction “Night Garden” approved, 29 Oct', 'Your approval', '29'),
      ev('rb3', 'performed', 'Name checks: ghaymah.sa and handles free; trademark screen class 3', 'Registrar', '27'),
    ],
    product: [ev('rp1', 'performed', 'Feasibility brief: 50 ml EDP formats and costs', 'Research specialist', '20')],
    supply: [ev('rs1', 'claimed', 'Three bottle quotes, 3 to 9 Nov', 'Suppliers', '09'), regB],
    commerce: [ev('rc1', 'performed', 'ghaymah.sa registered, RG-88213', 'Registrar', '31')],
    compliance: [ev('rco1', 'claimed', 'SFDA cosmetic notification needed before sale', 'Regulator guidance', '05')],
    demand: [],
  };
  return (['brand', 'product', 'supply', 'commerce', 'compliance', 'demand'] as const).map(o => ({
    outcome: o,
    level: (lv[o] ?? 0) as ReadinessLevel,
    blocker: blockers[o] ?? '',
    staleNote: stale[o] ?? null,
    rungs: rungs(lv[o] ?? 0, evid[o] ?? [], blockers[o] ?? ''),
  }));
};

export function perfumeMission(): MissionView {
  return {
    ledgerVersion: 100,
    missionId: 'm1',
    generatedAt: at('12', '09:41'),
    timeZone: 'Asia/Riyadh',
    contentLang: 'en',
    header: {
      name: 'Ghaymah',
      untitled: false,
      altName: { text: 'غيمة', lang: 'ar' },
      line: 'Perfume launch in Saudi Arabia',
      week: 3,
      budget: sar(30000),
    },
    status: 'active',
    sandbox: false,
    working: { state: 'working', text: 'drafting stock-bottle spec v3' },
    sinceYouLeft: {
      from: at('09'),
      to: at('11'),
      stepIds: ['a1', 'a2', 'a3', 'a4', 'a5'],
      overdueCommitmentIds: ['c1'],
      waitingDecisionIds: [],
    },
    entries: [
      {
        id: 'today',
        author: 'agent',
        at: at('12', '07:30'),
        streaming: false,
        staleNote: null,
        blocks: [
          { k: 'lede', text: [x('Three bottle quotes came in while you were away. One decision from you unblocks production.')] },
          { k: 'decision', decisionId: 'd-supplier' },
          { k: 'moment' },
          { k: 'embed', artifactId: 'quotes' },
        ],
      },
    ],
    decisions: perfumeDecisions(),
    moment: { id: 'mo-1', decisionIds: ['d-supplier', 'd-samples', 'd-finish'], estimateMinutes: 6, autoOpen: false },
    artifacts: perfumeArtifacts(),
    activity: perfumeActivity(),
    activityOrder: ['a5', 'a4', 'a3', 'a2', 'a1'],
    commitments: [
      {
        id: 'c1',
        owedBy: 'Supplier C',
        owedTo: 'you',
        what: 'Revised quote',
        due: at('10'),
        overdueDays: 2,
        escalation: 'Chased twice. Marketplace message on 13 Nov.',
        status: 'open',
        help: { targetId: 'c1', targetKind: 'commitment', mode: 'do', allowed: ['guide', 'do', 'help'] },
      },
      { id: 'c3', owedBy: 'Al-Wadi studio', owedTo: 'you', what: 'Three fragrance samples', due: at('21'), overdueDays: 0, status: 'open' },
      {
        id: 'c4',
        owedBy: 'Mission Lead',
        owedTo: 'Supplier B',
        what: 'Follow-up: hold price, ask sample cost',
        due: at('13'),
        overdueDays: 0,
        status: 'open',
        help: { targetId: 'thread-b', targetKind: 'thread', mode: 'guide', allowed: ['guide', 'do', 'help'] },
      },
      {
        id: 'c6',
        owedBy: 'Mission Lead',
        owedTo: 'you',
        what: 'Export the editable asset package',
        due: at('14'),
        overdueDays: 0,
        status: 'open',
        help: { targetId: 'c6', targetKind: 'commitment', mode: 'do', allowed: ['guide', 'do', 'help'] },
      },
      {
        id: 'c5',
        owedBy: 'You',
        owedTo: 'payment processor',
        what: 'Identity check (15 min, kit ready)',
        due: at('20'),
        overdueDays: 0,
        status: 'open',
        help: { targetId: 'c5', targetKind: 'commitment', mode: 'help', allowed: ['guide', 'help'] },
      },
    ],
    decisionRecord: [
      {
        id: 'r1',
        decisionId: 'd-brand',
        at: at('29'),
        status: 'approved',
        text: 'Brand direction “Night Garden” v2 and the name Ghaymah',
        canChange: true,
      },
      {
        id: 'r2',
        decisionId: null,
        at: at('30'),
        status: 'approved',
        text: 'Product concept: 50 ml EDP, stock glass bottle, custom closure, printed box',
        canChange: false,
      },
      {
        id: 'r3',
        decisionId: null,
        at: at('30'),
        status: 'approved',
        text: 'Outreach mandate: 15 suppliers, Arabic and English, 30 days',
        canChange: false,
      },
      { id: 'r4', decisionId: null, at: at('27'), status: 'approved', text: 'No inventory above 1,000 units', canChange: false },
      { id: 'r5', decisionId: null, at: at('22'), status: 'superseded', text: 'Hold up to 2,000 units of inventory', canChange: false },
      { id: 'r6', decisionId: null, at: at('22'), status: 'approved', text: 'Budget SAR 30,000 total', canChange: false },
    ],
    readiness: {
      outcomes: outcomesPerfume({ brand: 3, product: 1, supply: 1, commerce: 1, compliance: 1, demand: 0 }),
      inScope: ['brand', 'product', 'supply', 'commerce', 'compliance', 'demand'],
    },
    money: {
      currency: 'SAR',
      totals: { budget: sar(30000), spent: sar(1180), committed: sar(0), forecast: fc, left: sar(28820), headroom: sar(2600) },
      envelopes: [
        { id: 'brand', name: 'Brand and design', allocated: sar(3000), spent: sar(0), committed: sar(0), forecast: sar(1700) },
        { id: 'samples', name: 'Samples', allocated: sar(2500), spent: sar(0), committed: sar(0), forecast: sar(2400) },
        { id: 'production', name: 'Production', allocated: sar(14000), spent: sar(1085), committed: sar(0), forecast: sar(13900) },
        {
          id: 'compliance',
          name: 'Compliance and professionals',
          allocated: sar(2500),
          spent: sar(0),
          committed: sar(0),
          forecast: sar(2300),
        },
        { id: 'commerce', name: 'Commerce setup', allocated: sar(2000), spent: sar(95), committed: sar(0), forecast: sar(1800) },
        { id: 'marketing', name: 'Launch marketing', allocated: sar(3000), spent: sar(0), committed: sar(0), forecast: sar(2900) },
        { id: 'contingency', name: 'Contingency', allocated: sar(3000), spent: sar(0), committed: sar(0), forecast: sar(1220) },
      ],
      mandates: [
        {
          id: 'out',
          name: 'Outreach',
          scope: 'Suppliers, email and marketplace, Arabic and English, until 29 Nov',
          status: 'active',
          usage: { kind: 'count', used: 11, ceiling: 15, unit: 'contacts' },
          expiresAt: at('29'),
          inStrip: true,
        },
        {
          id: 'smp',
          name: 'Samples',
          scope: 'Up to SAR 800 each, 4 suppliers, until 30 Nov',
          status: 'requested',
          usage: { kind: 'money', used: sar(0), ceiling: sar(2500) },
          expiresAt: at('30'),
          inStrip: true,
          requestDecisionId: 'd-samples',
        },
      ],
      receipts: [
        {
          id: 'rc-1',
          at: at('01'),
          payee: 'Al-Wadi perfume studio',
          purpose: 'Fragrance brief consultation',
          amount: fig('rcp1', { kind: 'money', amount: sar(1085) }, 'performed', 'Card transaction ch_3Pq81', '01'),
          reference: 'ch_3Pq81',
          sandbox: false,
        },
        {
          id: 'rc-2',
          at: at('31').replace('11-31', '10-31'),
          payee: 'Domain registrar',
          purpose: 'ghaymah.sa, one year',
          amount: fig('rcp2', { kind: 'money', amount: sar(95) }, 'performed', 'Registrar transaction RG-88213', '31'),
          reference: 'RG-88213',
          sandbox: false,
        },
      ],
      sandbox: null,
    },
    impacts: {},
    questions: {},
    kits: {
      idcheck: {
        id: 'idcheck',
        title: 'Identity check at the payment processor',
        estimateMinutes: 15,
        where: { label: 'The payment processor’s business verification page', url: 'https://example.com/verify' },
        enter: ['Your full name as on your ID', 'Your commercial registration number', 'The store URL, ghaymah.sa'],
        bring: ['The confirmation email or a screenshot of the “verified” page'],
        verify: 'I check the processor’s account status through its API and mark Commerce evidence verified.',
        status: 'ready',
      },
    },
    closingRecords: {},
    glossary,
    focus: {
      target: { kind: 'artifact', artifactId: 'quotes', frameId: 'shelf' },
      reason: 'The quote plate is the evidence the decision rests on.',
    },
    notifications: [
      {
        id: 'n1',
        kind: 'decision',
        immediate: true,
        title: 'Which bottle route should we take?',
        why: 'Three quotes arrived; one decision unblocks production.',
        at: at('12', '07:30'),
        read: false,
        target: { kind: 'decision', decisionId: 'd-supplier' },
        decisionId: 'd-supplier',
      },
      {
        id: 'n2',
        kind: 'failure',
        immediate: true,
        title: 'Follow-up to Supplier D bounced',
        why: 'Blocks the closure-fit check until resent.',
        at: at('11', '18:02'),
        read: false,
        target: { kind: 'system', view: 'log' },
      },
      {
        id: 'n3',
        kind: 'digest',
        immediate: false,
        title: 'Weekly digest, 9 to 11 Nov',
        why: 'Three quotes, one verification, one correction.',
        at: at('11', '20:00'),
        read: true,
        target: { kind: 'entry', entryId: 'today' },
      },
    ],
    notificationSettings: { digestCadence: 'twice_weekly', quietHours: { from: '22:00', to: '07:00' }, momentsPerWeek: 3 },
    plateSpecimens: [
      { label: 'Bottle', plate: bottleB },
      { label: 'Watch strap', plate: exhibit(STRAP('DW-22', 22, 18), 'DW-22 strap, 58 by 120 millimetres') },
      { label: 'Candle jar', plate: exhibit(JAR, 'J-200 jar, 84 by 104 millimetres') },
      { label: 'Table top', plate: exhibit(TABLE, 'T-1200 table, 1200 by 750 millimetres') },
    ],
    access: { role: 'owner', canDecide: true, canMessage: true, canGrantMandates: true },
    suggestions: ['What are you waiting on?', 'What do you need from me?', 'What has this cost so far?', 'Show me the quotes'],
  };
}

/* ===================================================================== */
/* Sayr: leather watch-strap launch (the second category, no special cases) */
/* ===================================================================== */

export function strapMission(): MissionView {
  const sA = fig(
    'f-sA',
    { kind: 'money', amount: sar(38), per: 'a strap' },
    'claimed',
    'Atelier Deri, email',
    '11',
    'Quoted TRY 340, converted at 0.112',
    'TRY 340',
  );
  const sB = fig(
    'f-sB',
    { kind: 'money', amount: sar(52), per: 'a strap' },
    'claimed',
    'Dabbagh Workshop, written quote',
    '11',
    'Valid to 5 Dec',
  );
  const regS = ev('e-regS', 'verified', 'Registration verified', 'Commercial registration lookup, receipt lk-0577', '11');
  const strapA = exhibit(STRAP('AD-20', 20, 16), 'AD-20 strap, 54 by 120 millimetres, SAR 38.00, MOQ 200');
  const strapB = exhibit(STRAP('DW-22', 22, 18), 'DW-22 strap, 58 by 120 millimetres, SAR 52.00, MOQ 50');
  const base = perfumeMission();
  return {
    ...base,
    ledgerVersion: 40,
    missionId: 'm2',
    header: {
      name: 'Sayr',
      untitled: false,
      altName: { text: 'سَير', lang: 'ar' },
      line: 'Leather watch-strap launch in Saudi Arabia',
      week: 1,
      budget: sar(12000),
    },
    working: { state: 'working', text: 'checking tannery certificates for both makers' },
    sinceYouLeft: { from: at('10'), to: at('11'), stepIds: ['s1', 's2'], overdueCommitmentIds: [], waitingDecisionIds: [] },
    entries: [
      {
        id: 'today2',
        author: 'agent',
        at: at('12', '07:30'),
        streaming: false,
        staleNote: null,
        blocks: [
          { k: 'lede', text: [x('Two strap makers quoted overnight. One decision picks who makes your first 50.')] },
          { k: 'decision', decisionId: 'd-maker' },
          { k: 'moment' },
          { k: 'embed', artifactId: 'quotes' },
        ],
      },
    ],
    decisions: {
      'd-maker': {
        id: 'd-maker',
        kind: 'selection',
        topic: 'strap maker',
        question: 'Which maker should make your first 50 straps?',
        context: [x('The Istanbul atelier is cheaper per strap, but needs 200 against your limit of 150.')],
        options: [
          {
            id: 'B',
            label: [x('Order the first 50 from Dabbagh Workshop, Riyadh')],
            shortLabel: 'Dabbagh Workshop',
            actionLabel: 'Approve Dabbagh Workshop',
            description: [F(sB), x(', ready in 12 days. The spec moves to 22 mm.')],
            effects: [
              { label: 'Forecast', value: '−SAR 2,400' },
              { label: 'Redoes', value: 'strap spec v1' },
            ],
          },
          {
            id: 'A1',
            label: [x('Ask the Istanbul atelier to make 100 instead of 200')],
            shortLabel: 'ask Istanbul for 100',
            actionLabel: 'Ask Istanbul for 100',
            description: [F(sA), x(' may rise for a smaller run.')],
            effects: [{ label: 'Delay', value: '3 to 5 days' }],
          },
          {
            id: 'A2',
            label: [x('Take 200 from Istanbul and raise your limit')],
            shortLabel: 'take 200',
            actionLabel: 'Take 200 from Istanbul',
            description: [x('Lowest unit price; breaks your 150-unit limit.')],
            effects: [{ label: 'Holds', value: '50 more straps than your limit' }],
          },
        ],
        recommendedOptionId: 'B',
        why: [
          [
            x(
              'The Riyadh workshop makes 50 inside your limit, delivers in 12 days, and is the only maker whose registration I have verified. You pay SAR 14 more per strap, but you hold 150 fewer straps of an untested design.',
            ),
          ],
        ],
        binding: true,
        needsBy: at('14', '18:00'),
        defaultLine: 'If you don’t answer by 14 Nov, I wait and keep the name and brand work moving.',
        status: 'pending',
        resolution: null,
        supersededById: null,
        supersedesId: null,
        canChange: false,
        evidence: { artifactId: 'quotes', frameId: 'shelf' },
      },
    },
    moment: null,
    artifacts: {
      quotes: {
        id: 'quotes',
        type: 'comparison',
        title: 'Strap quotes',
        outcome: 'supply',
        status: 'proposed',
        currentVersionId: 'sq1',
        versions: [{ id: 'sq1', versionNo: 1, createdAt: at('12'), note: 'Two quotes', status: 'proposed' }],
        embed: {
          subtitle: '2 quotes, normalised to SAR a strap and drawn to scale',
          thumbnail: { kind: 'plates', plates: [strapA, strapB] },
        },
        icon: 'shelf',
        content: {
          kind: 'canvas',
          focusFrameId: 'shelf',
          frames: [
            {
              ...(quotesFrames[0] as FrameView),
              title: 'Straps to scale',
              width: 480,
              pinDecisionId: 'd-maker',
              summary: 'Two straps drawn to one millimetre scale against your 150-unit limit.',
              body: {
                k: 'shelf',
                decisionId: 'd-maker',
                limit: { value: 150, label: 'Your limit, 150 units' },
                items: [
                  {
                    id: 'A',
                    title: 'Atelier Deri',
                    subtitle: 'Istanbul',
                    plate: strapA,
                    price: sA,
                    quantity: fig('q-sA', { kind: 'quantity', value: 200, unit: 'units' }, 'claimed', 'Atelier Deri', '11'),
                    quantityValue: 200,
                    tag: null,
                    decisionOptionId: 'A1',
                    caption: 'MOQ 200, 1.3× your limit',
                    captionTone: 'warning',
                  },
                  {
                    id: 'B',
                    title: 'Dabbagh Workshop',
                    subtitle: 'Riyadh',
                    plate: strapB,
                    price: sB,
                    quantity: fig('q-sB', { kind: 'quantity', value: 50, unit: 'units' }, 'claimed', 'Dabbagh Workshop', '11'),
                    quantityValue: 50,
                    tag: 'recommended',
                    decisionOptionId: 'B',
                    caption: 'MOQ 50, inside your limit',
                    captionTone: 'neutral',
                    verification: regS,
                  },
                ],
              },
            },
          ],
        },
        actions: [],
      },
      spec: {
        id: 'spec',
        type: 'document',
        title: 'Strap spec v1',
        outcome: 'product',
        status: 'draft',
        currentVersionId: 'ss1',
        versions: [{ id: 'ss1', versionNo: 1, createdAt: at('11'), note: 'First draft', status: 'draft' }],
        embed: { subtitle: 'Draft', thumbnail: { kind: 'plates', plates: [strapA] } },
        icon: 'doc',
        content: {
          kind: 'document',
          sections: [
            { k: 'heading', text: 'Strap spec v1' },
            { k: 'lead', text: [x('Draft. v2 follows the maker you choose.')] },
            { k: 'plates', items: [strapA] },
            { k: 'heading', text: 'Specification', note: 'first version' },
            {
              k: 'fields',
              rows: [
                { label: 'Leather', value: 'Vegetable-tanned calf, 3.5 mm' },
                { label: 'Width', value: '20 mm at the lug, 16 mm at the tip' },
                { label: 'Lengths', value: '120 mm and 75 mm' },
                { label: 'Hardware', value: 'Brushed steel buckle' },
                { label: 'Order quantity', value: '200 units' },
              ],
            },
          ],
        },
        actions: [],
      },
    },
    activity: {
      s1: {
        id: 's1',
        label: 'claimed',
        title: [x('Collected two strap quotes')],
        details: [
          [x('Atelier Deri, Istanbul: TRY 340 (SAR 38.00), MOQ 200, 25 days')],
          [x('Dabbagh Workshop, Riyadh: SAR 52.00, MOQ 50, 12 days')],
        ],
        at: at('11'),
        help: { targetId: 'quotes2', targetKind: 'activity', mode: 'do', allowed: ['guide', 'do', 'help'] },
      },
      s2: {
        id: 's2',
        label: 'verified',
        title: [x('Verified Dabbagh Workshop’s registration')],
        details: [[x('Name and Riyadh address match the record')]],
        at: at('11'),
        receipts: [regS],
      },
    },
    activityOrder: ['s2', 's1'],
    commitments: [
      {
        id: 's-c1',
        owedBy: 'Dabbagh Workshop',
        owedTo: 'you',
        what: 'Tannery certificate for the calf leather',
        due: at('14'),
        overdueDays: 0,
        status: 'open',
      },
      {
        id: 's-c2',
        owedBy: 'Mission Lead',
        owedTo: 'both makers',
        what: 'Ask for a sample strap',
        due: at('13'),
        overdueDays: 0,
        status: 'open',
        help: { targetId: 'samples2', targetKind: 'commitment', mode: 'guide', allowed: ['guide', 'do', 'help'] },
      },
    ],
    decisionRecord: [
      {
        id: 'sr1',
        decisionId: null,
        at: at('10'),
        status: 'approved',
        text: 'Launch leather watch straps in Saudi Arabia; budget SAR 12,000',
        canChange: false,
      },
      { id: 'sr2', decisionId: null, at: at('10'), status: 'approved', text: 'No inventory above 150 units', canChange: false },
      { id: 'sr3', decisionId: null, at: at('10'), status: 'approved', text: 'Outreach mandate: 10 workshops, 30 days', canChange: false },
    ],
    readiness: {
      outcomes: (['brand', 'product', 'supply', 'commerce', 'compliance', 'demand'] as const).map(o => ({
        outcome: o,
        level: ({ brand: 1, product: 1, supply: 1, commerce: 0, compliance: 0, demand: 0 } as const)[o],
        blocker: {
          brand: 'Brand directions start once the maker is chosen.',
          product: 'The strap spec waits on the maker’s leather and width.',
          supply: 'Supply waits on your choice of maker.',
          commerce: 'Nothing to price until a quote is accepted.',
          compliance: 'Leather origin labelling waits on the maker’s tannery certificate.',
          demand: 'The demand scan runs next week.',
        }[o],
        staleNote: null,
        rungs: rungs(
          ({ brand: 1, product: 1, supply: 1, commerce: 0, compliance: 0, demand: 0 } as const)[o],
          o === 'supply'
            ? [ev('ss', 'claimed', 'Two quotes, 11 Nov', 'Makers', '11'), regS]
            : [ev(`s-${o}`, 'performed', 'Desk research', 'Research specialist', '10')],
          'Explored from desk research.',
        ),
      })),
      inScope: ['brand', 'product', 'supply', 'commerce', 'compliance', 'demand'],
    },
    money: {
      currency: 'SAR',
      totals: {
        budget: sar(12000),
        spent: sar(95),
        committed: sar(0),
        forecast: fig('f-fc2', { kind: 'money', amount: sar(12500) }, 'planned', 'Cost model v1', '11', '±15%'),
        left: sar(11905),
        headroom: sar(-595),
      },
      envelopes: [
        { id: 'brand', name: 'Brand and design', allocated: sar(1500), spent: sar(0), committed: sar(0), forecast: sar(1200) },
        { id: 'samples', name: 'Samples', allocated: sar(600), spent: sar(0), committed: sar(0), forecast: sar(500) },
        { id: 'production', name: 'Production', allocated: sar(6000), spent: sar(0), committed: sar(0), forecast: sar(7600) },
        { id: 'compliance', name: 'Compliance', allocated: sar(800), spent: sar(0), committed: sar(0), forecast: sar(600) },
        { id: 'commerce', name: 'Commerce setup', allocated: sar(1100), spent: sar(95), committed: sar(0), forecast: sar(900) },
        { id: 'marketing', name: 'Launch marketing', allocated: sar(1500), spent: sar(0), committed: sar(0), forecast: sar(1400) },
        { id: 'contingency', name: 'Contingency', allocated: sar(500), spent: sar(0), committed: sar(0), forecast: sar(300) },
      ],
      mandates: [
        {
          id: 'out',
          name: 'Outreach',
          scope: 'Leather workshops, email and WhatsApp, until 10 Dec',
          status: 'active',
          usage: { kind: 'count', used: 4, ceiling: 10, unit: 'contacts' },
          expiresAt: at('30'),
          inStrip: true,
        },
        {
          id: 'smp',
          name: 'Samples',
          scope: 'Up to SAR 300 each, 2 makers, until 5 Dec',
          status: 'requested',
          usage: { kind: 'money', used: sar(0), ceiling: sar(600) },
          expiresAt: at('30'),
          inStrip: true,
        },
      ],
      receipts: [
        {
          id: 'rs-1',
          at: at('10'),
          payee: 'Domain registrar',
          purpose: 'sayr.sa, one year',
          amount: fig('rcs1', { kind: 'money', amount: sar(95) }, 'performed', 'Registrar transaction RG-90417', '10'),
          reference: 'RG-90417',
          sandbox: false,
        },
      ],
      sandbox: null,
    },
    kits: {},
    focus: { target: { kind: 'artifact', artifactId: 'quotes', frameId: 'shelf' }, reason: 'The quotes the decision rests on.' },
    notifications: [],
  };
}

export const MISSIONS: MissionSummary[] = [
  {
    id: 'm1',
    name: 'Ghaymah',
    untitled: false,
    icon: ICON_CLOUD,
    pendingDecisions: 3,
    overdueCommitments: 1,
    levels: { brand: 3, product: 1, supply: 1, commerce: 1, compliance: 1, demand: 0 },
    status: 'active',
    sandbox: false,
    line: 'perfume launch in Saudi Arabia',
  },
  {
    id: 'm2',
    name: 'Sayr',
    untitled: false,
    icon: ICON_STRAP,
    pendingDecisions: 1,
    overdueCommitments: 0,
    levels: { brand: 1, product: 1, supply: 1, commerce: 0, compliance: 0, demand: 0 },
    status: 'active',
    sandbox: false,
    line: 'leather watch-strap launch in Saudi Arabia',
  },
];

/** New mission: a blank page, the first question with a recommended answer and Skip. */
export function newMission(): MissionView {
  const base = perfumeMission();
  const zero = { brand: 0, product: 0, supply: 0, commerce: 0, compliance: 0, demand: 0 } as const;
  return {
    ...base,
    ledgerVersion: 1,
    missionId: 'm3',
    header: { name: '', untitled: true, altName: null, line: 'New launch mission', week: null, budget: null },
    working: { state: 'waiting', text: 'listening for five quick answers' },
    sinceYouLeft: null,
    entries: [
      {
        id: 'n0',
        author: 'agent',
        at: at('12', '09:45'),
        streaming: false,
        staleNote: null,
        blocks: [
          {
            k: 'lede',
            text: [x('A blank page. I’ll ask at most five things, each with an answer I’d recommend, then show you a first draft.')],
          },
          {
            k: 'empty',
            text: 'Your first draft lands here after a few answers: a one-page model of the business, with where every line came from.',
          },
          { k: 'question', questionId: 'q1' },
        ],
      },
    ],
    decisions: {},
    moment: null,
    artifacts: {},
    activity: {},
    activityOrder: [],
    commitments: [],
    decisionRecord: [],
    readiness: {
      outcomes: (Object.keys(zero) as (keyof typeof zero)[]).map(o => ({
        outcome: o,
        level: 0,
        blocker: 'Nothing explored yet.',
        staleNote: null,
        rungs: rungs(0, [], 'Nothing explored yet.'),
      })),
      inScope: Object.keys(zero) as (keyof typeof zero)[],
    },
    money: {
      currency: 'SAR',
      totals: {
        budget: sar(0),
        spent: sar(0),
        committed: sar(0),
        forecast: fig('nf', { kind: 'money', amount: sar(0) }, 'planned', 'No cost model yet', '12'),
        left: sar(0),
        headroom: sar(0),
      },
      envelopes: [],
      mandates: [
        {
          id: 'r',
          name: 'Research',
          scope: 'Standing: nothing sent, nothing spent',
          status: 'standing',
          usage: null,
          expiresAt: null,
          inStrip: false,
        },
      ],
      receipts: [],
      sandbox: null,
    },
    questions: {
      q1: {
        id: 'q1',
        prompt: [x('What do you want to launch, and where? One sentence is enough; add a budget if you have one.')],
        recommended: 'Handmade soy candles for homes in Riyadh, SAR 12,000',
        options: ['Handmade soy candles for homes in Riyadh, SAR 12,000'],
        status: 'open',
        index: 1,
        total: 5,
      },
    },
    kits: {},
    focus: null,
    notifications: [],
  };
}

export const MISSIONS_WITH_NEW: MissionSummary[] = [
  ...MISSIONS,
  {
    id: 'm3',
    name: '',
    untitled: true,
    icon: ICON_DOC,
    pendingDecisions: 0,
    overdueCommitments: 0,
    levels: { brand: 0, product: 0, supply: 0, commerce: 0, compliance: 0, demand: 0 },
    status: 'active',
    sandbox: false,
    line: 'new launch mission',
  },
];

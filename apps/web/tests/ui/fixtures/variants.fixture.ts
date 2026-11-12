import type { DecisionView, MissionView } from '../../../src/ui-contract';
import { perfumeMission, sar } from './missions.fixture';

/** TEST FIXTURE ONLY. State variants of the seeded mission for scenes and break tests. */
const x = (text: string) => ({ t: 'text' as const, text });
const at = (d: string, time = '09:00') => `2026-11-${d}T${time}:00+03:00`;

/** J6: a payment packet that ends in "Approve on PayPal", in a sandbox mission (I-16). */
export function paymentScene(): MissionView {
  const v = perfumeMission();
  const pay: DecisionView = {
    id: 'd-pay',
    kind: 'payment',
    topic: 'sample payment',
    question: 'Pay Supplier B for three samples and grant a sample mandate?',
    context: [x('Supplier B asks for payment up front by PayPal invoice. No sample mandate covers it yet.')],
    options: [
      {
        id: 'pay',
        label: [x('Pay USD 60 now and grant SAR 400 for future samples')],
        shortLabel: 'paid',
        actionLabel: 'Approve on PayPal',
        description: [x('I capture after you approve, wait for the provider confirmation, then file the receipt.')],
        effects: [{ label: 'From', value: 'samples envelope' }],
      },
      {
        id: 'later',
        label: [x('Ask Supplier B to ship first and invoice on arrival')],
        shortLabel: 'asked to invoice later',
        actionLabel: 'Ask to invoice later',
        description: [x('Slower by about 3 days; they may refuse.')],
        effects: [{ label: 'Delay', value: 'about 3 days' }],
      },
    ],
    recommendedOptionId: 'pay',
    why: [[x('Paying now keeps samples on this week’s courier. The invoice link was validated against Supplier B’s verified account.')]],
    binding: true,
    needsBy: at('13', '18:00'),
    defaultLine: 'Nothing is paid until you approve on PayPal. If you don’t answer by 13 Nov, I ask Supplier B to hold the samples.',
    status: 'pending',
    resolution: null,
    supersededById: null,
    supersedesId: null,
    canChange: false,
    evidence: { system: 'money' },
    payment: {
      payee: 'Supplier B',
      purpose: 'three BR-50 samples, shipped to Riyadh',
      amount: {
        id: 'pf',
        value: { kind: 'money', amount: { amountMinor: 6000, currency: 'USD' } },
        trust: 'claimed',
        source: { label: 'PayPal invoice INV2-7KD3' },
        observedAt: at('12', '08:10'),
      },
      converted: { amount: sar(225), rate: 'at 3.75', rateSource: { label: 'Saudi Central Bank reference rate, 12 Nov' } },
      mandate: null,
      provider: 'PayPal',
      providerActionLabel: 'Approve on PayPal',
      sandbox: true,
      instrumentLabel: 'Your PayPal sandbox account',
    },
  };
  return {
    ...v,
    sandbox: true,
    entries: [
      {
        id: 'p1',
        author: 'agent',
        at: at('12', '08:12'),
        streaming: false,
        staleNote: null,
        blocks: [
          { k: 'lede', text: [x('Supplier B wants the samples paid up front. One approval and they ship today.')] },
          { k: 'decision', decisionId: 'd-pay' },
        ],
      },
    ],
    decisions: { ...v.decisions, 'd-pay': pay },
    moment: null,
    money: {
      ...v.money,
      sandbox: {
        totals: { spent: sar(225), committed: sar(0) },
        receipts: [
          {
            id: 'sb1',
            at: at('10'),
            payee: 'Supplier B (sandbox)',
            purpose: 'Test capture',
            amount: {
              id: 'sbf',
              value: { kind: 'money', amount: sar(225) },
              trust: 'verified',
              source: { label: 'PayPal sandbox capture 8XK2' },
              observedAt: at('10'),
            },
            reference: '8XK2',
            sandbox: true,
          },
        ],
      },
    },
    focus: { target: { kind: 'system', view: 'money' }, reason: 'The payment rests on the samples envelope.' },
  };
}

/** J10: a terminal decision recorded, with the closing record and export. */
export function closingScene(): MissionView {
  const v = perfumeMission();
  return {
    ...v,
    status: 'ended',
    working: { state: 'idle', text: '' },
    entries: [
      ...v.entries,
      {
        id: 'cl',
        author: 'agent',
        at: at('12', '10:00'),
        streaming: false,
        staleNote: null,
        blocks: [
          {
            k: 'prose',
            paragraphs: [[x('You approved the launch. Here is the closing record; open commitments each carry what I recommend.')]],
          },
          { k: 'closing', recordId: 'cr1' },
        ],
      },
    ],
    closingRecords: {
      cr1: {
        id: 'cr1',
        terminal: 'launch',
        decidedAt: at('12', '10:00'),
        summary: [[x('All six outcomes reached Launch-ready with verified evidence. 4 hours 40 minutes of your time across 9 weeks.')]],
        openCommitments: [
          {
            commitmentId: 'c3',
            what: 'Al-Wadi studio owes three fragrance samples',
            recommendedAction: 'Let it lapse; they are no longer needed.',
          },
        ],
        accounts: [
          { name: 'ghaymah.sa domain', owner: 'Layla (founder)' },
          { name: 'Store', owner: 'Layla (founder)' },
        ],
        exportFormats: ['pdf', 'markdown', 'json', 'zip'],
      },
    },
  };
}

/** Streaming entry and a kit (Help me do it). */
export function streamingScene(): MissionView {
  const v = perfumeMission();
  return {
    ...v,
    entries: [
      ...v.entries,
      {
        id: 'st1',
        author: 'agent',
        at: at('12', '09:50'),
        streaming: true,
        staleNote: null,
        blocks: [
          {
            k: 'prose',
            paragraphs: [[x('Your identity check is the one step only you can take. Here is everything you need, and how I’ll verify it')]],
          },
          { k: 'kit', kitId: 'idcheck' },
        ],
      },
    ],
  };
}

/** Mandate grant first on the page, with long scope lines and a server maximum above the frozen draft. */
export function mandateScene(): MissionView {
  const v = perfumeMission();
  const d = v.decisions['d-samples'];
  if (!d) return v;
  const mandate: DecisionView = {
    ...d,
    context: [
      x(
        'Up to SAR 800 for each sample order, from up to 4 suppliers, by email, WhatsApp and marketplace messages, in Arabic and English, until 30 Nov. Product can’t reach Verified without a sample you approve.',
      ),
    ],
    mandateScope: {
      ceiling: sar(2500),
      ceilingMax: sar(9000),
      perItemCeiling: sar(800),
      count: 4,
      countMax: 9,
      countUnit: 'suppliers',
      expiresOn: '2026-11-30',
      expiresMax: '2026-12-31',
      channels: ['email', 'WhatsApp Business (approved templates only)', 'marketplace messages'],
    },
  };
  return {
    ...v,
    entries: [
      {
        id: 'mx',
        author: 'agent',
        at: at('12', '08:20'),
        streaming: false,
        staleNote: null,
        blocks: [
          { k: 'lede', text: [x('Samples are the next step. One mandate lets me order them without asking each time.')] },
          { k: 'decision', decisionId: 'd-samples' },
        ],
      },
    ],
    decisions: { ...v.decisions, 'd-samples': mandate },
    moment: null,
    focus: { target: { kind: 'system', view: 'money' }, reason: 'The mandate draws on the samples envelope.' },
  };
}

/** WEB-05: the mandate version is carried by a NON-recommended option only. */
export function mandateNonRecommendedScene(): MissionView {
  const v = mandateScene();
  const d = v.decisions['d-samples'];
  if (!d?.mandateScope) return v;
  return {
    ...v,
    decisions: {
      ...v.decisions,
      'd-samples': {
        ...d,
        mandateScope: { ...d.mandateScope, ceiling: sar(1200), ceilingMax: sar(1200), count: 2, countMax: 2, optionIds: ['tight'] },
      },
    },
  };
}

/** WEB-04 / item 9: a frozen zero-money communications mandate. */
export function mandateZeroScene(): MissionView {
  const v = mandateScene();
  const d = v.decisions['d-samples'];
  if (!d) return v;
  const zero: DecisionView = {
    ...d,
    question: 'May I contact up to 4 more suppliers by message?',
    context: [x('Messages only, in Arabic and English, until 30 Nov. Nothing can be spent under this mandate.')],
    options: d.options
      .slice(0, 1)
      .map(o => ({
        ...o,
        label: [x('Allow 4 more supplier contacts, messages only')],
        actionLabel: 'Grant messaging mandate',
        effects: [],
      })),
    mandateScope: {
      ceiling: sar(0),
      ceilingMax: sar(0),
      count: 4,
      countMax: 4,
      countUnit: 'contacts',
      expiresOn: '2026-11-30',
      expiresMax: '2026-11-30',
      channels: ['email', 'WhatsApp Business (approved templates only)'],
      optionIds: ['grant'],
    },
  };
  return { ...v, decisions: { ...v.decisions, 'd-samples': zero } };
}

/** WEB-05 / item 9: one payment version shared by two options, with a long FX source and date. */
export function paymentSharedScene(): MissionView {
  const v = paymentScene();
  const d = v.decisions['d-pay'];
  if (!d?.payment) return v;
  const payment = {
    ...d.payment,
    optionIds: ['pay', 'later'],
    converted: {
      amount: sar(225),
      rate: 'at 3.7500 SAR per USD, mid-market, 12 Nov 2026 08:10 Riyadh time',
      rateSource: {
        label: 'Saudi Central Bank daily reference rate publication, retrieved through the exchange-rate adapter on 12 November 2026',
      },
    },
  };
  return { ...v, decisions: { ...v.decisions, 'd-pay': { ...d, payment } } };
}

/** Item 9: a kit missing two of its four required parts is not presented as a task. */
export function kitIncompleteScene(): MissionView {
  const v = streamingScene();
  const kit = v.kits['idcheck'];
  if (!kit) return v;
  return { ...v, kits: { ...v.kits, idcheck: { ...kit, bring: [], verify: '' } } };
}

/** Header active time and unverified category guidance; a canonical kit with an unknown (0) estimate. */
export function headerScene(): MissionView {
  const v = streamingScene();
  const kit = v.kits['idcheck'];
  return {
    ...v,
    header: {
      ...v.header,
      activeTime: {
        id: 'f-active',
        value: { kind: 'quantity', value: 84, unit: 'min' },
        trust: 'performed',
        source: { label: 'Focused-interaction heartbeat estimate' },
        observedAt: at('12', '09:40'),
        note: 'Counts only minutes with focused activity in this workspace',
      },
      knowledge: {
        category: 'Fragrance',
        version: 2,
        reviewStatus: 'unverified',
        warning: 'Labelling rules differ for alcohol-based products; confirm with a qualified advisor before printing.',
        sources: ['SFDA cosmetics notification guidance (public page)', 'GSO 1943 labelling standard summary'],
      },
    },
    kits: kit ? { ...v.kits, idcheck: { ...kit, estimateMinutes: 0 } } : v.kits,
  };
}

export function pausedScene(): MissionView {
  return { ...perfumeMission(), status: 'paused', working: { state: 'paused', text: '' } };
}

export function viewerScene(): MissionView {
  return {
    ...perfumeMission(),
    access: {
      role: 'viewer',
      canDecide: false,
      canMessage: false,
      canGrantMandates: false,
      reason: 'You were invited to view this mission.',
    },
  };
}

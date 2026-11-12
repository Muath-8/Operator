import { z } from 'zod';
import { artifactDocument } from './artifact-document';
import { KitSchema } from '@lo/runtime';
import { FxConversionSchema } from '@lo/adapters';
import { DecisionPacketSchema, OUTCOMES, OutcomeSchema, READINESS_RULES, TrustLevelSchema, type JsonValue } from '@lo/state';
import type {
  ActivityStep,
  ArtifactStatus,
  ArtifactVersionView,
  ArtifactView,
  ClosingRecordView,
  CommitmentView,
  DecisionView,
  EvidenceItem,
  Figure,
  FrameView,
  HelpMode,
  ImpactView,
  KitView,
  MandateView,
  Money,
  MoneyView,
  MissionSummary,
  MissionView,
  NotificationView,
  Outcome,
  OutcomeLevels,
  PageEntry,
  PlateExhibit,
  PlateMaterial,
  PlatePart,
  ReadinessLevel,
  ReceiptView,
  RichText,
  SourceRef,
  StepLabel,
  Target,
  ThreadMessage,
} from '../ui-contract';
import { latest, num, obj, rows, str, type Row } from './snapshot';
const rt = (text: string): RichText => [{ t: 'text', text }];
const texts = (value: JsonValue | undefined): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
const safeRows = (value: JsonValue | undefined): Row[] =>
  Array.isArray(value) ? value.filter((v): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)) : [];
const outcome = (row: Row): Outcome | null => {
  const parsed = OutcomeSchema.safeParse(row['outcome']);
  return parsed.success ? parsed.data : null;
};
const trust = (row: Row): EvidenceItem['trust'] => {
  const parsed = TrustLevelSchema.safeParse(row['trust']);
  return parsed.success ? parsed.data : 'planned';
};
const level = (value: number): ReadinessLevel =>
  z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).parse(value);
const money = (amountMinor: number, currency: string): Money => ({
  amountMinor: z.number().int().safe().parse(amountMinor),
  currency,
});
const id = (row: Row) => str(row, 'id');
const timestamp = (row: Row) => str(row, 'created_at', str(row, 'received_at'));
const source = (row: Row): SourceRef => {
  const reference = str(row, 'source_reference', id(row));
  return {
    label: str(row, 'kind', str(row, 'provider', 'Ledger record')),
    reference,
    ...(/^https:\/\//.test(reference) ? { url: reference } : {}),
  };
};
const evidenceItem = (row: Row): EvidenceItem => ({
  id: id(row),
  trust: trust(row),
  text: str(row, 'kind').replaceAll('_', ' '),
  source: source(row),
  observedAt: timestamp(row),
  sandbox: row['sandbox_mode'] === true,
});
const sorted = (values: Row[]) => [...values].sort((a, b) => timestamp(a).localeCompare(timestamp(b)) || id(a).localeCompare(id(b)));
const matching = (all: Row[], column: string, value: string) => all.filter(row => str(row, column) === value);
const statusValue = (value: string): ArtifactStatus =>
  z.enum(['draft', 'proposed', 'approved', 'rejected', 'superseded', 'stale']).catch('draft').parse(value);
/** Draw only supplied geometry. Domain components without geometry are displayed
 * as dimensioned schematic strips; no shape is selected by category name. */
export function projectPlate(spec: Row, label: string): PlateExhibit {
  const dims = obj(spec, 'dims_mm');
  const w = num(dims, 'w', num(dims, 'width', 0)),
    h = num(dims, 'h', num(dims, 'height', 0)),
    d = num(dims, 'd', num(dims, 'depth', 0));
  const provided = safeRows(spec['parts']);
  const parts: PlatePart[] = [];
  const materials = new Set<PlateMaterial>(['glass', 'solid', 'metal', 'leather', 'wax', 'wood', 'ghost', 'void', 'hint', 'paper']);
  const geometry = (part: Row): PlatePart | null => {
    const m = materials.has(str(part, 'm') as PlateMaterial) ? (str(part, 'm') as PlateMaterial) : 'solid';
    if (part['t'] === 'rect')
      return {
        t: 'rect',
        x: num(part, 'x'),
        y: num(part, 'y'),
        w: num(part, 'w'),
        h: num(part, 'h'),
        r: num(part, 'r'),
        m,
        role: str(part, 'role'),
      };
    if (part['t'] === 'circle')
      return {
        t: 'circle',
        cx: num(part, 'cx'),
        cy: num(part, 'cy'),
        r: num(part, 'r'),
        m,
        role: str(part, 'role'),
      };
    if (part['t'] === 'line')
      return {
        t: 'line',
        x1: num(part, 'x1'),
        y1: num(part, 'y1'),
        x2: num(part, 'x2'),
        y2: num(part, 'y2'),
      };
    if (part['t'] === 'poly') {
      const pts = z
        .array(z.tuple([z.number().finite(), z.number().finite()]))
        .min(3)
        .max(1000)
        .safeParse(part['pts']);
      return pts.success ? { t: 'poly', pts: pts.data, m, role: str(part, 'role') } : null;
    }
    if (part['t'] === 'holes')
      return {
        t: 'holes',
        x: num(part, 'x'),
        y0: num(part, 'y0'),
        n: Math.max(0, Math.min(100, num(part, 'n'))),
        step: num(part, 'step'),
        r: num(part, 'r'),
      };
    if (part['t'] === 'mark')
      return {
        t: 'mark',
        cx: num(part, 'cx'),
        cy: num(part, 'cy'),
        size: num(part, 'size'),
        role: str(part, 'role'),
      };
    if (part['t'] === 'text')
      return {
        t: 'text',
        x: num(part, 'x'),
        y: num(part, 'y'),
        s: str(part, 's'),
        size: num(part, 'size'),
        role: str(part, 'role'),
        lang: str(part, 'lang'),
      };
    return null;
  };
  provided.forEach(part => {
    const shape = geometry(part);
    if (shape) parts.push(shape);
  });
  if (!parts.length && w > 0 && h > 0) {
    const componentCount = Math.max(1, Array.isArray(spec['parts']) ? spec['parts'].length : 0);
    for (let index = 0; index < componentCount; index++) {
      const part = provided[index];
      const material = part ? str(part, 'material') : 'solid';
      const m = materials.has(material as PlateMaterial)
        ? (material as PlateMaterial)
        : /steel|aluminium|aluminum/.test(material)
          ? 'metal'
          : 'solid';
      const ph = h / componentCount;
      parts.push({
        t: 'rect',
        x: -w / 2,
        y: index * ph,
        w,
        h: ph,
        m,
        role: part ? str(part, 'name', `component ${index + 1}`) : `component ${index + 1}`,
      });
    }
  }
  return {
    spec: {
      kind: str(spec, 'kind', 'dimensioned schematic'),
      dims_mm: { w, h, ...(d > 0 ? { d } : {}) },
      parts,
    },
    summary: `${label}. ${w > 0 && h > 0 ? `${w} × ${h}${d > 0 ? ` × ${d}` : ''} mm. Component layout is schematic.` : 'Dimensions have not been recorded.'}`,
  };
}
export function projectMission(snapshot: Row, now = new Date()): MissionView {
  const mission = obj(snapshot, 'mission'),
    metadata = obj(mission, 'metadata'),
    missionId = id(mission),
    generatedAt = now.toISOString(),
    currency = str(mission, 'currency', 'USD');
  if (!missionId) throw new Error('validation: mission snapshot missing');
  const glossary: MissionView['glossary'] = Object.fromEntries(
    rows(snapshot, 'glossary_terms').map(term => [
      id(term),
      {
        term: str(term, str(metadata, 'locale') === 'ar' ? 'term_ar' : 'term_en'),
        definition: str(term, str(metadata, 'locale') === 'ar' ? 'definition_ar' : 'definition_en'),
      },
    ]),
  );
  const glossaryRuns = (value: string): RichText => {
    const aliases = rows(snapshot, 'glossary_terms')
      .flatMap(term => texts(term['aliases']).map(alias => ({ alias, id: id(term) })))
      .sort((a, b) => b.alias.length - a.alias.length);
    if (!aliases.length) return rt(value);
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])(${aliases.map(a => a.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}_])`,
      'giu',
    );
    const result: RichText[number][] = [];
    let previous = 0;
    for (const match of value.matchAll(pattern)) {
      if (match.index > previous) result.push({ t: 'text', text: value.slice(previous, match.index) });
      const alias = aliases.find(a => a.alias.toLocaleLowerCase() === match[0].toLocaleLowerCase());
      result.push(alias ? { t: 'term', text: match[0], termId: alias.id } : { t: 'text', text: match[0] });
      previous = match.index + match[0].length;
    }
    if (previous < value.length) result.push({ t: 'text', text: value.slice(previous) });
    return result;
  };
  const decisionsRows = rows(snapshot, 'decisions'),
    resolutions = rows(snapshot, 'decision_resolutions'),
    supersessions = rows(snapshot, 'decision_supersessions'),
    staleIds = new Set(rows(snapshot, 'stale_marks').map(r => str(r, 'node_id')));
  const evidenceRows = rows(snapshot, 'evidence'),
    versions = rows(snapshot, 'artifact_versions'),
    artifactsRows = rows(snapshot, 'artifacts'),
    statuses = rows(snapshot, 'artifact_statuses'),
    messages = rows(snapshot, 'messages').map(message => {
      if (message['direction'] !== 'outbound' || texts(message['artifact_version_refs']).length) return message;
      const receipt = rows(snapshot, 'provider_receipts').find(
        r => id(r) === str(message, 'receipt_id') && str(r, 'mission_id') === str(message, 'mission_id'),
      );
      const authorization = receipt
        ? rows(snapshot, 'effect_authorizations').find(
            a => id(a) === str(receipt, 'authorization_id') && str(a, 'mission_id') === str(message, 'mission_id'),
          )
        : undefined;
      const reference = authorization ? str(obj(authorization, 'intent'), 'artifactVersionId') : '';
      return reference ? { ...message, artifact_version_refs: [reference] } : message;
    }),
    preferences = rows(snapshot, 'founder_preferences');
  const supersededEvidence = new Set(evidenceRows.map(r => str(r, 'supersedes_id')).filter(Boolean));
  const validEvidence = evidenceRows.filter(e => !staleIds.has(id(e)) && !supersededEvidence.has(id(e)));
  const evidenceById = new Map(evidenceRows.map(e => [id(e), e]));
  const preference = (kind: string) => latest(preferences.filter(p => str(p, 'kind') === kind));
  const helpMode = (target: string): HelpMode => {
    const set = latest(preferences.filter(p => str(p, 'kind') === 'help_mode' && str(obj(p, 'value'), 'targetId') === target));
    return z
      .enum(['guide', 'do', 'help'])
      .catch('do')
      .parse(set ? obj(set, 'value')['mode'] : mission['involvement']);
  };
  const decisions: Record<string, DecisionView> = {};
  for (const d of decisionsRows) {
    const packet = DecisionPacketSchema.parse(d['packet']);
    const resolution = latest(matching(resolutions, 'decision_id', id(d)));
    const supersession = supersessions.find(s => str(s, 'previous_id') === id(d));
    const response = resolution ? str(resolution, 'response') : '';
    const stale = staleIds.has(id(d));
    const status = supersession
      ? 'superseded'
      : response === 'approve' || response === 'choose'
        ? 'approved'
        : response === 'reject'
          ? 'rejected'
          : response === 'defer'
            ? 'deferred'
            : 'pending';
    const relatedArtifact = artifactsRows.find(a =>
      versions.some(
        v =>
          str(v, 'artifact_id') === id(a) &&
          rows(snapshot, 'dependencies').some(
            edge => str(edge, 'dependent_id') === id(v) && packet.options.some(o => o.evidenceIds.includes(str(edge, 'upstream_id'))),
          ),
      ),
    );
    const observedAt = timestamp(d);
    const optionVersions = (option: (typeof packet.options)[number]) =>
      (option.artifactVersionIds ?? (packet.options.length === 1 ? (packet.approvedVersionIds ?? []) : [])).flatMap(ref =>
        versions.filter(v => id(v) === ref),
      );
    const selectedVersions = [...new Map(packet.options.flatMap(optionVersions).map(v => [id(v), v])).values()];
    const mandateVersions = selectedVersions.filter(v => obj(v, 'content')['mandate']);
    const mandateVersion = mandateVersions.length === 1 ? mandateVersions[0] : undefined;
    const mandate = mandateVersion ? obj(obj(mandateVersion, 'content'), 'mandate') : null;
    const paymentVersions = selectedVersions.filter(v => obj(obj(v, 'content'), 'effectIntent')['action'] === 'payment_capture');
    const paymentVersion = paymentVersions.length === 1 ? paymentVersions[0] : undefined;
    const paymentIntent = paymentVersion ? obj(obj(paymentVersion, 'content'), 'effectIntent') : null;
    const paymentConversion = paymentVersion
      ? FxConversionSchema.safeParse(obj(obj(paymentVersion, 'content'), 'payload')['conversion'])
      : null;
    const partyName = (ref: string) => str(rows(snapshot, 'counterparties').find(p => id(p) === ref) ?? {}, 'name', ref);
    const authorityEffects = (option: (typeof packet.options)[number]) =>
      optionVersions(option).flatMap(v => {
        const content = obj(v, 'content'),
          mandate = obj(content, 'mandate'),
          scope = obj(mandate, 'scope'),
          effect = obj(content, 'effectIntent');
        const lines: { label: string; value: string }[] = [];
        if (content['missionBrief'])
          lines.push(
            { label: 'Mission goal', value: str(obj(content, 'missionBrief'), 'goalBrief') },
            { label: 'Mission currency', value: str(obj(content, 'missionBrief'), 'currency') },
          );
        if (content['founderConfirmation'])
          lines.push({ label: 'Your explicit confirmation', value: str(obj(content, 'founderConfirmation'), 'statement') });
        if (content['mandate']) {
          lines.push(
            { label: 'Authority', value: texts(scope['actions']).join(', ') },
            { label: 'Counterparties', value: texts(scope['counterpartyIds']).map(partyName).join(', ') || 'Only the explicit scope' },
            { label: 'Channels', value: texts(scope['channels']).join(', ') },
            { label: 'Purposes', value: texts(scope['purposes']).join(', ') },
            { label: 'Per action ceiling', value: `${num(mandate, 'ceilingPer') / 100} ${str(mandate, 'currency')}` },
            { label: 'Total ceiling', value: `${num(mandate, 'ceilingTotal') / 100} ${str(mandate, 'currency')}` },
            { label: 'New contacts', value: String(num(scope, 'maxNewContacts')) },
            { label: 'Expires', value: str(mandate, 'expiresAt') },
          );
        }
        if (content['effectIntent'])
          lines.push(
            { label: 'Approved external action', value: str(effect, 'action') },
            { label: 'Recipient', value: partyName(str(effect, 'counterpartyId')) },
            { label: 'Exact version', value: id(v) },
          );
        return lines;
      });
    decisions[id(d)] = {
      id: id(d),
      kind: z
        .enum(['selection', 'mandate', 'payment', 'visual', 'change', 'terminal', 'goal', 'constraint', 'engagement'])
        .parse(paymentIntent && d['kind'] === 'engagement' && d['gate'] === 'payment' ? 'payment' : d['kind']),
      topic: outcome(d) ?? str(d, 'kind'),
      question: packet.question,
      context: rt(
        stale
          ? 'This decision depends on changed evidence and needs review.'
          : packet.recommendation.reasons.map(reason => (/[.!?\u061f]$/.test(reason) ? reason : `${reason}.`)).join(' '),
      ),
      options: packet.options.map(option => ({
        id: option.id,
        label: rt(option.label),
        shortLabel: option.label,
        actionLabel: optionVersions(option).some(v => obj(v, 'content')['founderConfirmation'])
          ? `Confirm: ${optionVersions(option)
              .map(v => str(obj(obj(v, 'content'), 'founderConfirmation'), 'statement'))
              .filter(Boolean)
              .join('; ')}`
          : option.label,
        description: rt(option.consequences),
        effects: [{ label: 'Time', value: `${option.timeDays} days` }, ...authorityEffects(option)],
        cost: option.cost
          ? {
              id: `${id(d)}:${option.id}:cost`,
              value: { kind: 'money', amount: option.cost },
              trust: 'planned',
              source: { label: 'Decision consequences', reference: id(d) },
              observedAt,
            }
          : null,
      })),
      recommendedOptionId: packet.recommendation.optionId,
      why: packet.recommendation.reasons.map(rt),
      binding: packet.defaultIfNoAnswer.binding,
      needsBy: packet.defaultIfNoAnswer.at,
      defaultLine: packet.defaultIfNoAnswer.binding
        ? 'Waiting for your explicit decision.'
        : `Default: ${packet.options.find(o => o.id === packet.defaultIfNoAnswer.optionId)?.label ?? packet.defaultIfNoAnswer.optionId}`,
      status,
      resolution:
        resolution && (status === 'approved' || status === 'rejected')
          ? {
              optionId: str(resolution, 'option_id'),
              how: 'founder',
              at: timestamp(resolution),
            }
          : null,
      supersededById: supersession ? str(supersession, 'replacement_id') : null,
      supersedesId: str(d, 'supersedes_id') || null,
      canChange: status === 'approved' && !stale,
      evidence: relatedArtifact ? { artifactId: id(relatedArtifact) } : null,
      stale,
      ...(str(d, 'kind') === 'mandate' && mandate && mandateVersion
        ? {
            mandateScope: {
              optionIds: packet.options.filter(o => optionVersions(o).some(v => id(v) === id(mandateVersion))).map(o => o.id),
              ceiling: money(num(mandate, 'ceilingTotal'), str(mandate, 'currency', currency)),
              ceilingMax: money(num(mandate, 'ceilingTotal'), str(mandate, 'currency', currency)),
              perItemCeiling: money(num(mandate, 'ceilingPer'), str(mandate, 'currency', currency)),
              count: num(
                obj(mandate, 'scope'),
                'maxActions',
                num(mandate, 'ceilingPer') > 0
                  ? Math.max(1, Math.ceil(num(mandate, 'ceilingTotal') / num(mandate, 'ceilingPer')))
                  : Math.max(1, num(obj(mandate, 'scope'), 'maxNewContacts')),
              ),
              countMax: num(
                obj(mandate, 'scope'),
                'maxActions',
                num(mandate, 'ceilingPer') > 0
                  ? Math.max(1, Math.ceil(num(mandate, 'ceilingTotal') / num(mandate, 'ceilingPer')))
                  : Math.max(1, num(obj(mandate, 'scope'), 'maxNewContacts')),
              ),
              countUnit: 'actions',
              expiresOn: str(mandate, 'expiresAt').slice(0, 10),
              expiresMax: str(mandate, 'expiresAt').slice(0, 10),
              channels: texts(obj(mandate, 'scope')['channels']),
            },
          }
        : {}),
      ...(['engagement', 'mandate'].includes(str(d, 'kind')) && paymentVersion && paymentIntent
        ? {
            payment: {
              payee: partyName(str(paymentIntent, 'counterpartyId')),
              purpose: str(paymentIntent, 'purpose', packet.question),
              optionIds: packet.options.filter(o => optionVersions(o).some(v => id(v) === id(paymentVersion))).map(o => o.id),
              amount: {
                id: `${id(d)}:payment`,
                value: {
                  kind: 'money' as const,
                  amount: money(num(paymentIntent, 'amountMinor'), str(paymentIntent, 'currency', currency)),
                },
                trust: 'planned' as const,
                source: { label: 'Exact approved payment proposal', reference: id(paymentVersion) },
                observedAt,
              },
              ...(paymentConversion?.success
                ? {
                    converted: {
                      amount: money(paymentConversion.data.missionAmountMinor, paymentConversion.data.to),
                      rate: `${paymentConversion.data.numerator}/${paymentConversion.data.denominator} ${paymentConversion.data.to} per ${paymentConversion.data.from}; ${paymentConversion.data.observedAt}`,
                      rateSource: {
                        label: 'SAMA dated reference rate',
                        url: paymentConversion.data.source,
                        reference: paymentConversion.data.quoteId,
                      },
                    },
                  }
                : {}),
              mandate: null,
              provider: 'PayPal',
              providerActionLabel: 'Approve on PayPal',
              sandbox: mission['sandbox_mode'] === true,
              instrumentLabel: str(
                rows(snapshot, 'founder_accounts').find(a => id(a) === str(paymentIntent, 'instrumentId')) ?? {},
                'provider',
                'Founder-owned account',
              ),
            },
          }
        : {}),
      blocks: packet.staleImpact.length ? `Affects ${packet.staleImpact.length} dependent records` : undefined,
    };
  }
  const pending = Object.values(decisions).filter(d => d.status === 'pending' && !d.stale);
  const artifacts: Record<string, ArtifactView> = {};
  const getVersionStatus = (v: Row): ArtifactStatus =>
    staleIds.has(id(v)) ? 'stale' : statusValue(str(latest(matching(statuses, 'artifact_version_id', id(v))) ?? {}, 'status', 'draft'));
  for (const a of artifactsRows) {
    const history = matching(versions, 'artifact_id', id(a)).sort((x, y) => num(x, 'version_no') - num(y, 'version_no'));
    const current = history.at(-1);
    if (!current) continue;
    const content = obj(current, 'content'),
      status = getVersionStatus(current),
      out = outcome(a);
    const versionViews: ArtifactVersionView[] = history.map(v => ({
      id: id(v),
      versionNo: num(v, 'version_no'),
      createdAt: timestamp(v),
      note: str(v, 'variation_request') || `Version ${num(v, 'version_no')}`,
      variationRequest: str(v, 'variation_request') || undefined,
      status: getVersionStatus(v),
      sentTo: messages
        .filter(m => texts(m['artifact_version_refs']).includes(id(v)))
        .map(m => ({ counterparty: str(m, 'thread_id'), at: timestamp(m) })),
    }));
    const sourceIds = rows(snapshot, 'dependencies')
      .filter(edge => str(edge, 'dependent_id') === id(current))
      .map(edge => str(edge, 'upstream_id'));
    const sources = sourceIds.flatMap(ref => {
      const e = evidenceById.get(ref);
      return e ? [evidenceItem(e)] : [];
    });
    const inspector = {
      typeLabel: str(a, 'type'),
      serves: out,
      versions: versionViews,
      currentVersionId: id(current),
      evidence: sources,
      comments: [],
      allowVariation: status !== 'superseded',
      actions: [],
    };
    const quotes = safeRows(content['quotes']).filter(
        q =>
          typeof q['unitPriceMinor'] === 'number' &&
          Number.isSafeInteger(q['unitPriceMinor']) &&
          typeof q['moq'] === 'number' &&
          Number.isFinite(q['moq']) &&
          typeof q['currency'] === 'string' &&
          num(obj(obj(q, 'spec'), 'dims_mm'), 'w', num(obj(obj(q, 'spec'), 'dims_mm'), 'width')) > 0 &&
          num(obj(obj(q, 'spec'), 'dims_mm'), 'h', num(obj(obj(q, 'spec'), 'dims_mm'), 'height')) > 0,
      ),
      directions = safeRows(content['directions']);
    const frames: FrameView[] = [];
    if (quotes.length) {
      const active = pending.find(d => d.evidence && 'artifactId' in d.evidence && d.evidence.artifactId === id(a));
      const quoteFigure = (quote: Row, key: string, value: Figure['value']): Figure => {
        const e = evidenceById.get(str(quote, 'evidenceId'));
        const payload = e ? obj(e, 'payload') : {};
        const sourceKey = key === 'price' ? 'unitPriceMinor' : key === 'lead' ? 'leadDays' : 'moq';
        const supported =
          !!e &&
          !staleIds.has(id(e)) &&
          !supersededEvidence.has(id(e)) &&
          payload[sourceKey] === quote[sourceKey] &&
          (key !== 'price' || payload['currency'] === quote['currency']);
        return {
          id: `${id(a)}:${str(quote, 'id')}:${key}`,
          value,
          trust: supported && e ? trust(e) : 'planned',
          source:
            supported && e
              ? source(e)
              : {
                  label: 'Artifact value awaiting matching source evidence',
                  reference: id(current),
                },
          observedAt: e ? timestamp(e) : timestamp(current),
          note: supported ? undefined : 'The cited source does not confirm this value. Review before using it.',
        };
      };
      const items = quotes.map(q => {
        const e = evidenceById.get(str(q, 'evidenceId'));
        return {
          id: str(q, 'id'),
          title: str(q, 'title'),
          subtitle: e ? `${trust(e)} quotation` : 'Source not recorded',
          plate: projectPlate(obj(q, 'spec'), str(q, 'title')),
          price: quoteFigure(q, 'price', {
            kind: 'money',
            amount: money(num(q, 'unitPriceMinor'), str(q, 'currency', currency)),
            per: 'unit',
          }),
          quantity: quoteFigure(q, 'moq', {
            kind: 'quantity',
            value: num(q, 'moq'),
            unit: 'units',
          }),
          quantityValue: num(q, 'moq'),
          tag: active?.recommendedOptionId === str(q, 'id') ? ('recommended' as const) : null,
          decisionOptionId: active?.options.some(o => o.id === str(q, 'id')) ? str(q, 'id') : null,
          caption:
            num(content, 'limit') > 0 && num(q, 'moq') > num(content, 'limit')
              ? 'Above the recorded quantity limit'
              : 'Claimed terms; verify before committing',
          captionTone: num(content, 'limit') > 0 && num(q, 'moq') > num(content, 'limit') ? ('warning' as const) : ('neutral' as const),
        };
      });
      frames.push({
        id: `${id(a)}:shelf`,
        title: str(a, 'title'),
        meta: 'Source-linked comparison',
        width: 960,
        row: 0,
        pins: [],
        stale: status === 'stale',
        body: {
          k: 'shelf',
          items,
          limit:
            num(content, 'limit') > 0
              ? {
                  value: num(content, 'limit'),
                  label: 'Recorded quantity limit',
                }
              : null,
          decisionId: active?.id ?? null,
        },
        inspector,
        summary: 'Compare the recorded quotations and their evidence.',
      });
      frames.push({
        id: `${id(a)}:terms`,
        title: 'Terms at a glance',
        meta: 'Values retain the source trust level',
        width: 960,
        row: 1,
        pins: [],
        body: {
          k: 'table',
          columns: quotes.map(q => ({
            id: str(q, 'id'),
            label: str(q, 'title'),
            highlight: active?.recommendedOptionId === str(q, 'id'),
          })),
          rows: [
            {
              label: 'Unit price',
              cells: items.map(q => ({ figure: q.price })),
            },
            {
              label: 'Minimum quantity',
              cells: items.map(q => ({ figure: q.quantity })),
            },
            {
              label: 'Lead time',
              cells: quotes.map(q => ({
                figure: quoteFigure(q, 'lead', {
                  kind: 'duration',
                  days: num(q, 'leadDays'),
                }),
                unobserved: q['leadDays'] === undefined,
              })),
            },
          ],
          legend: [...new Set(items.map(q => q.price.trust))],
        },
        inspector,
        summary: 'Price, minimum quantity and lead time from the source quotations.',
      });
    } else if (directions.length) {
      for (const direction of directions) {
        const palette = texts(direction['palette']).filter(c => /^#[0-9a-f]{3,8}$/i.test(c));
        frames.push({
          id: str(direction, 'id', `${id(a)}:${frames.length}`),
          title: str(direction, 'name'),
          meta: str(direction, 'positioning'),
          width: 600,
          row: 0,
          pins: [],
          stale: status === 'stale',
          body: {
            k: 'identity',
            wordmark: str(direction, 'name'),
            mark: null,
            palette,
            background: 0,
            foreground: Math.min(1, palette.length - 1),
            typeface: direction['typography'] === 'sans' ? 'sans' : 'serif',
            positioning: str(direction, 'positioning'),
            statusLabel: status,
            versionChips: versionViews.map(v => ({
              versionId: v.id,
              label: `v${v.versionNo}`,
              current: v.id === id(current),
            })),
          },
          inspector,
          summary: str(direction, 'positioning'),
        });
      }
    }
    const spec = content['dims_mm'] ? projectPlate(content, str(a, 'title')) : null;
    artifacts[id(a)] = {
      id: id(a),
      type: quotes.length ? 'comparison' : directions.length ? 'visual' : 'document',
      title: str(a, 'title'),
      outcome: out,
      status,
      currentVersionId: id(current),
      versions: versionViews,
      embed: {
        subtitle: `${status} · version ${num(current, 'version_no')}`,
        thumbnail: quotes.length
          ? {
              kind: 'plates',
              plates: quotes.map(q => projectPlate(obj(q, 'spec'), str(q, 'title'))),
            }
          : directions.length
            ? {
                kind: 'swatches',
                swatches: directions.map(d => texts(d['palette'])),
              }
            : spec
              ? { kind: 'plates', plates: [spec] }
              : { kind: 'icon', icon: 'doc' },
      },
      icon: quotes.length ? 'shelf' : directions.length ? 'swatch' : 'doc',
      preferWide: false,
      content: frames.length
        ? { kind: 'canvas', frames, focusFrameId: 'all' }
        : {
            kind: 'document',
            sections: [
              { k: 'heading', text: str(a, 'title'), note: status },
              ...(spec ? [{ k: 'plates' as const, items: [spec] }] : []),
              ...artifactDocument(content, {
                versionId: id(current),
                observedAt: str(current, 'created_at', generatedAt),
                evidence: new Map(validEvidence.map(e => [id(e), evidenceItem(e)])),
              }),
            ],
          },
      actions: [
        {
          id: 'change',
          label: 'Change this',
          kind: 'command',
          runsImpact: status === 'approved',
        },
      ],
    };
  }
  for (const thread of rows(snapshot, 'threads').filter(t => str(t, 'counterparty_id'))) {
    const threadId = id(thread),
      partyId = str(thread, 'counterparty_id'),
      party = rows(snapshot, 'counterparties').find(p => id(p) === partyId),
      threadRows = sorted(matching(messages, 'thread_id', threadId));
    const translated: ThreadMessage[] = threadRows
      .filter(m => ['inbound', 'outbound'].includes(str(m, 'direction')))
      .map(m => ({
        id: id(m),
        direction: m['direction'] === 'outbound' ? 'outbound' : 'inbound',
        channel: z.enum(['email', 'whatsapp', 'voice', 'sms', 'marketplace', 'web']).catch('web').parse(m['channel']),
        at: timestamp(m),
        author: m['direction'] === 'outbound' ? 'Launch Operator' : str(party ?? {}, 'name', 'Counterparty'),
        original: {
          text: str(m, 'original'),
          lang: str(metadata, 'locale', 'en'),
        },
        translation: str(m, 'translation') ? { text: str(m, 'translation'), lang: str(metadata, 'locale', 'en') } : undefined,
        reference: str(m, 'provider_id') || undefined,
        delivery: m['direction'] === 'inbound' ? 'received' : 'sent',
        attachments: texts(m['artifact_version_refs']).map(ref => ({
          label:
            artifactsRows.find(a => versions.some(v => id(v) === ref && str(v, 'artifact_id') === id(a)))?.['title']?.toString() ??
            'Artifact',
          versionLabel: `Version ${num(versions.find(v => id(v) === ref) ?? {}, 'version_no')}`,
          sentAt: timestamp(m),
        })),
      }));
    artifacts[threadId] = {
      id: threadId,
      type: 'thread',
      title: str(party ?? {}, 'name', 'Counterparty conversation'),
      outcome: null,
      status: 'draft',
      currentVersionId: threadRows.at(-1) ? id(threadRows.at(-1) ?? {}) : threadId,
      versions: [],
      embed: {
        subtitle: `${translated.length} recorded messages`,
        thumbnail: { kind: 'icon', icon: 'chat' },
      },
      icon: 'chat',
      content: {
        kind: 'thread',
        counterparty: {
          name: str(party ?? {}, 'name', 'Counterparty'),
          subtitle: str(party ?? {}, 'kind'),
        },
        help: {
          targetId: threadId,
          targetKind: 'thread',
          mode: helpMode(threadId),
          allowed: ['guide', 'do', 'help'],
        },
        messages: translated,
        draft: null,
      },
      actions: [],
    };
  }
  const levels: Record<Outcome, ReadinessLevel> = {
    brand: 0,
    product: 0,
    supply: 0,
    commerce: 0,
    compliance: 0,
    demand: 0,
  };
  const readiness = {
    inScope: [...OUTCOMES],
    outcomes: OUTCOMES.map(out => {
      const r = rows(snapshot, 'readiness').find(r => str(r, 'outcome') === out);
      const current = level(r ? num(r, 'level') : 0);
      levels[out] = current;
      const blockers = rows(snapshot, 'blockers').filter(
        b =>
          str(b, 'outcome') === out &&
          num(rows(snapshot, 'readiness').find(r => str(r, 'outcome') === str(b, 'blocking_outcome')) ?? {}, 'level') <
            num(b, 'required_level'),
      );
      return {
        outcome: out,
        level: current,
        blocker:
          blockers.map(b => str(b, 'description')).join('; ') ||
          texts(r?.['missing'])
            .map(s => s.replaceAll('_', ' '))
            .join(', '),
        staleNote: r?.['stale'] === true ? 'Upstream evidence changed; dependent work needs review.' : null,
        rungs: READINESS_RULES.filter(rule => rule.outcome === out).map(rule => ({
          level: rule.level as Exclude<ReadinessLevel, 0>,
          met: current >= rule.level,
          evidence:
            current >= rule.level
              ? validEvidence
                  .filter(
                    e =>
                      outcome(e) === out &&
                      rule.evidenceKinds.includes(str(e, 'kind')) &&
                      (!rule.highTrust ||
                        ['verified', 'founder_confirmed'].includes(str(e, 'trust')) ||
                        (e['trust'] === 'performed' && rule.performedKinds?.includes(str(e, 'kind')))),
                  )
                  .map(evidenceItem)
              : [],
          missing: current < rule.level ? rule.evidenceKinds.join(', ').replaceAll('_', ' ') : '',
        })),
      };
    }),
  };
  const parties = new Map(rows(snapshot, 'counterparties').map(p => [id(p), str(p, 'name')]));
  const commitments: CommitmentView[] = rows(snapshot, 'commitments').map(c => {
    const state = latest(matching(rows(snapshot, 'commitment_states'), 'commitment_id', id(c)));
    const stateName = str(state ?? {}, 'status', 'open');
    const open = !['closed', 'cancelled'].includes(stateName);
    const overdueDays = open ? Math.max(0, Math.floor((now.getTime() - Date.parse(str(c, 'due_at'))) / 86400000)) : 0;
    return {
      id: id(c),
      owedBy: c['direction'] === 'inbound' ? (parties.get(str(c, 'party_id')) ?? 'Counterparty') : 'Founder',
      owedTo: c['direction'] === 'inbound' ? 'Founder' : (parties.get(str(c, 'party_id')) ?? 'Counterparty'),
      what: str(c, 'description'),
      due: str(c, 'due_at'),
      overdueDays,
      status: stateName === 'closed' ? 'done' : stateName === 'cancelled' ? 'cancelled' : 'open',
      escalation: num(c, 'escalation_step') > 0 ? `Escalation ${num(c, 'escalation_step')}` : undefined,
      help: {
        targetId: id(c),
        targetKind: 'commitment',
        mode: helpMode(id(c)),
        allowed: ['guide', 'do', 'help'],
      },
    };
  });
  const activity: Record<string, ActivityStep> = {};
  const labels = new Set<StepLabel>([
    'planned',
    'running',
    'performed',
    'claimed',
    'verified',
    'corrected',
    'failed',
    'waiting',
    'blocked',
    'proposed',
    'approved',
    'retrying',
  ]);
  for (const progress of rows(snapshot, 'run_progress')) {
    const finished = rows(snapshot, 'run_progress').some(
      p =>
        str(p, 'run_id') === str(progress, 'run_id') && str(p, 'step_key') === str(progress, 'step_key') && str(p, 'phase') !== 'started',
    );
    if (str(progress, 'phase') === 'started' && finished) continue;
    activity[id(progress)] = {
      id: id(progress),
      label: str(progress, 'phase') === 'started' ? 'running' : str(progress, 'phase') === 'failed' ? 'failed' : 'proposed',
      title: rt(str(progress, 'label')),
      details: [],
      at: timestamp(progress),
      sandbox: mission.sandbox_mode === true,
    };
  }
  for (const step of rows(snapshot, 'activity')) {
    const label = str(step, 'label') as StepLabel;
    const receipt = str(step, 'receipt_id');
    activity[id(step)] = {
      id: id(step),
      label: labels.has(label) ? label : 'planned',
      title: rt(str(step, 'summary')),
      details: [],
      at: timestamp(step),
      sandbox: mission['sandbox_mode'] === true,
      receipts: receipt
        ? [
            {
              id: receipt,
              trust: 'performed',
              text: 'Provider receipt',
              source: { label: 'Provider receipt', reference: receipt },
              observedAt: timestamp(step),
              sandbox: mission['sandbox_mode'] === true,
            },
          ]
        : [],
      help: {
        targetId: id(step),
        targetKind: 'activity',
        mode: helpMode(id(step)),
        allowed: ['guide', 'do', 'help'],
      },
    };
  }
  const mandates = projectMandates(snapshot, currency, now);
  const moneyView = projectMoney(snapshot, currency, metadata, mandates, parties, generatedAt);
  const impacts: Record<string, ImpactView> = {};
  const kits: Record<string, KitView> = {};
  for (const version of versions) {
    const content = obj(version, 'content');
    const canonical = KitSchema.safeParse(content);
    const parsed = canonical.success
      ? {
          success: true as const,
          data: {
            title: canonical.data.title,
            estimateMinutes: 0,
            where: { label: canonical.data.whereToGo, url: canonical.data.whereToGo },
            enter: canonical.data.whatToEnter,
            bring: canonical.data.whatToBringBack,
            verify: canonical.data.howVerified,
            status: (
              { prepared: 'ready', awaiting_founder: 'in_progress', awaiting_verification: 'submitted', verified: 'submitted' } as const
            )[canonical.data.status],
          },
        }
      : z
          .object({
            title: z.string(),
            estimateMinutes: z.number().int().nonnegative(),
            where: z.object({ label: z.string(), url: z.url().optional() }),
            enter: z.array(z.string()).min(1),
            bring: z.array(z.string()).min(1),
            verify: z.string().min(1),
            status: z.enum(['ready', 'in_progress', 'submitted', 'verified']),
          })
          .safeParse(content.kind === 'kit' ? content : null);
    if (parsed.success) {
      const proven = validEvidence.some(
        e =>
          [str(obj(e, 'payload'), 'kitVersionId'), str(obj(e, 'payload'), 'artifactVersionId')].includes(id(version)) &&
          str(e, 'kind') === 'kit_verified' &&
          ['verified', 'founder_confirmed'].includes(str(e, 'trust')),
      );
      kits[id(version)] = {
        id: id(version),
        ...parsed.data,
        status: proven ? 'verified' : parsed.data.status === 'verified' ? 'submitted' : parsed.data.status,
      };
    }
  }
  for (const preference of preferences.filter(p => str(p, 'kind') === 'change_request')) {
    const value = obj(preference, 'value'),
      impactId = str(value, 'id', id(preference)),
      affected = texts(value['affected']),
      rootId = str(value, 'rootId');
    const name = (nodeId: string) =>
      str(
        artifactsRows.find(a => id(a) === nodeId) || decisionsRows.find(d => id(d) === nodeId) || {},
        'title',
        decisions[nodeId]?.question ?? nodeId,
      );
    const edges = rows(snapshot, 'dependencies');
    const first = new Set(edges.filter(e => str(e, 'upstream_id') === rootId).map(e => str(e, 'dependent_id')));
    impacts[impactId] = {
      id: impactId,
      decisionId: str(value, 'decisionId') || null,
      title: 'Review the impact before changing this',
      stale: affected.map(name),
      secondOrder: affected
        .filter(n => !first.has(n))
        .map(n => ({
          label: name(n),
          via: name(str(edges.find(e => str(e, 'dependent_id') === n) ?? {}, 'upstream_id')),
        })),
      readiness: [],
      cost: 'Cost has not been established yet.',
      time: 'Delay has not been established yet.',
      redo: affected.map(name),
      confirmLabel: 'Approve reviewed change',
      status: preferences.some(p => str(p, 'kind') === 'change_kept' && str(obj(p, 'value'), 'impactId') === impactId) ? 'kept' : 'open',
    };
  }
  const questions: Record<string, MissionView['questions'][string]> = {};
  const questionRows = rows(snapshot, 'mission_questions');
  const answers = rows(snapshot, 'question_answers');
  for (const [index, q] of questionRows.entries()) {
    const answer = answers.find(a => str(a, 'question_id') === id(q));
    questions[id(q)] = {
      id: id(q),
      prompt: rt(str(q, 'question')),
      recommended: str(q, 'recommended_default'),
      options: [],
      status: answer ? (answer['skipped'] === true ? 'skipped' : 'answered') : 'open',
      ...(answer ? { answer: str(answer, 'answer') } : {}),
      index: index + 1,
      total: questionRows.length,
    };
  }
  const entries: PageEntry[] = [];
  for (const q of questionRows.filter(q => !answers.some(a => str(a, 'question_id') === id(q))))
    entries.push({
      id: `question:${id(q)}`,
      author: 'agent',
      at: timestamp(q),
      streaming: false,
      staleNote: null,
      blocks: [{ k: 'question', questionId: id(q) }],
    });
  for (const message of messages.filter(m => ['founder', 'lead'].includes(str(m, 'direction')))) {
    const founder = message['direction'] === 'founder';
    entries.push({
      id: id(message),
      author: founder ? 'founder' : 'agent',
      at: timestamp(message),
      streaming: false,
      staleNote: null,
      blocks: founder ? [] : [{ k: 'prose', paragraphs: [glossaryRuns(str(message, 'original'))] }],
      ...(founder ? { text: str(message, 'original'), delivery: 'sent' as const } : {}),
    });
  }
  // Approved artifacts remain available in the artifact surfaces and decision record.
  // The active conversation embeds work still awaiting review, rather than replaying the archive.
  for (const a of Object.values(artifacts).filter(a => a.status !== 'approved' && a.status !== 'superseded'))
    entries.push({
      id: `artifact:${a.id}`,
      author: 'agent',
      at: timestamp(artifactsRows.find(r => id(r) === a.id) ?? mission),
      streaming: false,
      staleNote: a.status === 'stale' ? 'Dependent source changed.' : null,
      blocks: [{ k: 'embed', artifactId: a.id }],
    });
  const visibleDecisions = pending.length
    ? pending
    : Object.values(decisions)
        .filter(d => d.status !== 'superseded')
        .sort((a, b) => (b.resolution?.at ?? '').localeCompare(a.resolution?.at ?? ''))
        .slice(0, 1);
  for (const d of visibleDecisions)
    entries.push({
      id: `decision:${d.id}`,
      author: 'agent',
      at: timestamp(decisionsRows.find(r => id(r) === d.id) ?? mission),
      streaming: false,
      staleNote: d.stale ? 'This decision needs review.' : d.status === 'superseded' ? 'Superseded by a later decision.' : null,
      blocks: [{ k: 'decision', decisionId: d.id }],
    });
  for (const impact of Object.values(impacts))
    entries.push({
      id: `impact:${impact.id}`,
      author: 'agent',
      at: timestamp(preferences.find(p => str(obj(p, 'value'), 'id') === impact.id) ?? mission),
      streaming: false,
      staleNote: null,
      blocks: [{ k: 'impact', impactId: impact.id }],
    });
  const closingRecords: Record<string, ClosingRecordView> = {};
  for (const transition of rows(snapshot, 'mission_transitions').filter(t => t['status'] === 'ended')) {
    const terminalDecision = decisions[str(transition, 'terminal_decision_id')],
      terminal = z.enum(['launch', 'pivot', 'stop', 'infeasible']).safeParse(terminalDecision?.resolution?.optionId);
    const recordVersion = versions.find(v => id(v) === str(transition, 'closing_record_version_id'));
    if (!terminal.success || !recordVersion) continue;
    const content = obj(recordVersion, 'content');
    const recordId = id(recordVersion);
    closingRecords[recordId] = {
      id: recordId,
      terminal: terminal.data,
      decidedAt: timestamp(transition),
      summary: [rt(str(obj(content, 'closingRecord'), 'summary', str(content, 'summary', JSON.stringify(content))))],
      openCommitments: commitments
        .filter(c => c.status === 'open')
        .map(c => ({
          commitmentId: c.id,
          what: c.what,
          recommendedAction: c.recommendedAction ?? 'Review and assign a next action.',
        })),
      accounts: rows(snapshot, 'founder_accounts').map(account => ({
        name: str(account, 'provider'),
        owner: 'Founder',
      })),
      exportFormats: ['pdf', 'markdown', 'json', 'zip'],
    };
    entries.push({
      id: `closing:${recordId}`,
      author: 'agent',
      at: timestamp(transition),
      streaming: false,
      staleNote: null,
      blocks: [{ k: 'closing', recordId }],
    });
  }
  for (const kit of Object.values(kits))
    entries.push({
      id: `kit:${kit.id}`,
      author: 'agent',
      at: timestamp(versions.find(v => id(v) === kit.id) ?? mission),
      streaming: false,
      staleNote: null,
      blocks: [{ k: 'kit', kitId: kit.id }],
    });
  entries.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  // The latest persisted Lead summary introduces the current work on return;
  // older messages retain their relative order and approved decisions live in Record.
  const latestLead = latest(messages.filter(m => m['direction'] === 'lead'));
  if (pending.length && latestLead) {
    const index = entries.findIndex(e => e.id === id(latestLead));
    if (index > 0) {
      const [opening] = entries.splice(index, 1);
      if (opening) entries.unshift(opening);
    }
  }
  if (!entries.length)
    entries.push({
      id: `empty:${missionId}`,
      author: 'agent',
      at: timestamp(mission),
      streaming: false,
      staleNote: null,
      blocks: [{ k: 'empty', text: 'Your mission is ready for its first brief.' }],
    });
  const unread = new Set(preferences.filter(p => str(p, 'kind') === 'notifications_read').flatMap(p => texts(p['value'])));
  const notifications: NotificationView[] = rows(snapshot, 'notification_events').map(n => ({
    id: id(n),
    kind: z.enum(['decision', 'mandate', 'payment', 'failure', 'reply', 'digest']).catch('digest').parse(n['kind']),
    immediate: n['delivery'] === 'immediate',
    title: str(n, 'title'),
    why: str(n, 'why'),
    at: timestamp(n),
    read: unread.has(id(n)),
    target: parseTarget(n['target']) ?? {
      kind: 'system',
      view: 'notifications',
    },
  }));
  const requested = latest(rows(snapshot, 'focus_events'));
  const node = requested ? str(requested, 'node_id') : '';
  const focus: MissionView['focus'] = artifacts[node]
    ? {
        target: { kind: 'artifact', artifactId: node },
        reason: 'Requested work surface',
      }
    : decisions[node]
      ? {
          target: { kind: 'decision', decisionId: node },
          reason: 'Decision waiting for review',
        }
      : null;
  const status = z.enum(['active', 'paused', 'ended']).catch('active').parse(snapshot['status']);
  const activeRuns = rows(snapshot, 'runs').filter(
    r =>
      ['running', 'scheduled'].includes(str(r, 'status')) && !rows(snapshot, 'run_results').some(result => str(result, 'run_id') === id(r)),
  );
  const latestRunResult = latest(rows(snapshot, 'run_results'));
  const releasedMoment = latest(
    rows(snapshot, 'decision_moments').filter(
      m =>
        Date.parse(str(m, 'scheduled_for')) <= now.getTime() &&
        rows(snapshot, 'decision_moment_items').some(
          item => str(item, 'moment_id') === id(m) && pending.some(d => d.id === str(item, 'decision_id')),
        ),
    ),
  );
  const momentDecisions = releasedMoment
    ? rows(snapshot, 'decision_moment_items')
        .filter(item => str(item, 'moment_id') === id(releasedMoment) && pending.some(d => d.id === str(item, 'decision_id')))
        .map(item => str(item, 'decision_id'))
    : [];
  const latestRunFailed = latestRunResult && obj(latestRunResult, 'result')['status'] === 'failed';
  const paused = latest(rows(snapshot, 'mission_transitions').filter(r => r['status'] === 'paused'));
  const notificationPreference = preference('notifications'),
    notificationConfig = notificationPreference ? obj(notificationPreference, 'value') : {};
  const headerBudget = num(metadata, 'budgetMinor', 0);
  const engagement = obj(snapshot, 'engagement'),
    lastSeen = str(engagement, 'lastSeenAt');
  const absent = lastSeen && now.getTime() - Date.parse(lastSeen) >= num(engagement, 'absenceHours', 48) * 3600000;
  const returnFrom =
    paused && (!lastSeen || timestamp(paused) > lastSeen || status === 'paused') ? timestamp(paused) : absent ? lastSeen : null;
  const activeMinutes = Math.floor(num(engagement, 'activeSeconds') / 60);
  return {
    ledgerVersion: num(snapshot, 'ledger_version'),
    missionId,
    generatedAt,
    timeZone: str(metadata, 'timeZone', 'UTC'),
    contentLang: str(metadata, 'locale', 'en'),
    header: {
      name: str(metadata, 'title', 'Untitled mission'),
      untitled: !str(metadata, 'title'),
      line: str(metadata, 'summary', str(mission, 'goal_brief')),
      knowledge: {
        category: str(obj(snapshot, 'knowledge'), 'requestedCategory'),
        version: num(obj(obj(snapshot, 'knowledge'), 'profile'), 'version', 1),
        reviewStatus:
          str(obj(obj(snapshot, 'knowledge'), 'profile'), 'review_status') === 'reviewed' ? ('reviewed' as const) : ('unverified' as const),
        warning: str(obj(snapshot, 'knowledge'), 'warning') || null,
        sources: texts(obj(obj(snapshot, 'knowledge'), 'profile')['sources']),
      },
      ...(activeMinutes > 0 && lastSeen
        ? {
            activeTime: {
              id: `${missionId}:active-time`,
              value: { kind: 'quantity' as const, value: activeMinutes, unit: 'minutes' },
              trust: 'claimed' as const,
              source: { label: 'Focused interaction heartbeat estimate', reference: `mission:${missionId}:engagement` },
              observedAt: lastSeen,
              note: str(engagement, 'basis'),
            },
          }
        : {}),
      week: null,
      budget: headerBudget > 0 ? money(headerBudget, currency) : null,
    },
    status,
    sandbox: mission['sandbox_mode'] === true,
    working:
      status === 'paused'
        ? {
            state: 'paused',
            text: 'Outbound work is paused. Incoming evidence is still recorded.',
          }
        : status === 'ended'
          ? {
              state: 'idle',
              text: 'The mission has ended. Its closing record remains available.',
            }
          : activeRuns.length
            ? { state: 'working', text: 'Work is in progress.' }
            : pending.length
              ? { state: 'waiting', text: 'A decision is ready for you.' }
              : latestRunFailed
                ? {
                    state: 'blocked',
                    text: 'The latest run failed. No completion has been inferred.',
                  }
                : { state: 'idle', text: 'No work is currently running.' },
    sinceYouLeft: returnFrom
      ? {
          from: returnFrom,
          to: generatedAt,
          stepIds: Object.values(activity)
            .filter(a => a.at > returnFrom)
            .map(a => a.id),
          overdueCommitmentIds: commitments.filter(c => c.overdueDays > 0).map(c => c.id),
          waitingDecisionIds: pending.map(d => d.id),
        }
      : null,
    entries,
    decisions,
    moment:
      releasedMoment && momentDecisions.length
        ? {
            id: id(releasedMoment),
            decisionIds: momentDecisions,
            estimateMinutes: momentDecisions.length * 2,
            autoOpen: momentDecisions.length > 1,
          }
        : null,
    artifacts,
    activity,
    activityOrder: Object.values(activity)
      .sort((a, b) => b.at.localeCompare(a.at))
      .map(a => a.id),
    commitments,
    decisionRecord: Object.values(decisions)
      .filter(d => ['approved', 'rejected', 'superseded'].includes(d.status))
      .map(d => ({
        id: `record:${d.id}`,
        decisionId: d.id,
        at: d.resolution?.at ?? timestamp(decisionsRows.find(r => id(r) === d.id) ?? mission),
        status:
          d.status === 'superseded'
            ? 'superseded'
            : d.status === 'rejected'
              ? 'rejected'
              : resolutions.some(r => str(r, 'decision_id') === d.id && str(r, 'resolution_source') === 'system_default')
                ? 'default'
                : 'approved',
        text: d.question,
        canChange: d.canChange,
        supersededById: d.supersededById,
      })),
    readiness,
    money: moneyView,
    impacts,
    questions,
    kits,
    closingRecords,
    glossary,
    focus,
    notifications,
    notificationSettings: {
      momentsPerWeek: num(
        obj([...preferences].reverse().find(p => str(p, 'kind') === 'decision_timing') ?? {}, 'value'),
        'momentsPerWeek',
        3,
      ),
      digestCadence: z.enum(['daily', 'twice_weekly', 'weekly']).catch('weekly').parse(notificationConfig['digestCadence']),
      quietHours:
        notificationConfig['quietHours'] &&
        typeof notificationConfig['quietHours'] === 'object' &&
        !Array.isArray(notificationConfig['quietHours'])
          ? {
              from: str(notificationConfig['quietHours'], 'from'),
              to: str(notificationConfig['quietHours'], 'to'),
            }
          : null,
    },
    plateSpecimens: Object.values(artifacts).flatMap(a => a.embed.thumbnail.plates?.map(plate => ({ label: a.title, plate })) ?? []),
    access: {
      role: 'owner',
      canDecide: true,
      canMessage: true,
      canGrantMandates: true,
    },
    suggestions: ['What is uncertain?', 'What is waiting for me?', 'Show my mission record'],
  };
}
export function parseTarget(value: JsonValue | undefined): Target | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value['kind'] === 'artifact' && typeof value['artifactId'] === 'string') return { kind: 'artifact', artifactId: value['artifactId'] };
  if (value['kind'] === 'decision' && typeof value['decisionId'] === 'string') return { kind: 'decision', decisionId: value['decisionId'] };
  if (value['kind'] === 'entry' && typeof value['entryId'] === 'string') return { kind: 'entry', entryId: value['entryId'] };
  const view = z.enum(['readiness', 'money', 'log', 'notifications', 'plates', 'record']).safeParse(value['view']);
  return value['kind'] === 'system' && view.success ? { kind: 'system', view: view.data } : null;
}
function projectMandates(snapshot: Row, currency: string, now: Date): MandateView[] {
  return rows(snapshot, 'mandates').map((m, index) => {
    const scope = obj(m, 'scope'),
      authorizations = rows(snapshot, 'effect_authorizations').filter(a => str(a, 'mandate_id') === id(m));
    const actualUsage = rows(snapshot, 'mandate_usage').find(row => str(row, 'mandate_id') === id(m));
    const used = actualUsage
        ? num(obj(actualUsage, 'usage'), 'usedMinor')
        : authorizations.reduce((sum, a) => sum + num(a, 'amount_minor'), 0),
      ceiling = num(m, 'ceiling_total');
    const revoked = rows(snapshot, 'mandate_revocations').some(r => str(r, 'mandate_id') === id(m));
    const expired = Date.parse(str(m, 'expires_at')) <= now.getTime();
    const count = actualUsage
        ? num(obj(actualUsage, 'usage'), 'contacts')
        : new Set(
            authorizations
              .filter(a => {
                const intent = obj(a, 'intent');
                return (
                  intent.newContact === true ||
                  (['send_message', 'marketplace_message'].includes(str(intent, 'action')) &&
                    !rows(snapshot, 'messages').some(
                      message =>
                        str(message, 'direction') === 'outbound' &&
                        str(message, 'receipt_id') &&
                        str(message, 'created_at') <= str(a, 'created_at') &&
                        rows(snapshot, 'threads').some(
                          thread =>
                            id(thread) === str(message, 'thread_id') && str(thread, 'counterparty_id') === str(intent, 'counterpartyId'),
                        ),
                    ))
                );
              })
              .map(a => str(obj(a, 'intent'), 'counterpartyId')),
          ).size,
      max = num(scope, 'maxNewContacts');
    const spend = texts(scope['effectClasses']).includes('spend');
    return {
      id: id(m),
      name: str(m, 'type'),
      scope: texts(scope['actions']).join(', '),
      status: revoked ? 'revoked' : expired ? 'expired' : (spend && used >= ceiling) || (!spend && count >= max) ? 'exhausted' : 'active',
      usage: spend
        ? {
            kind: 'money',
            used: money(used, str(m, 'currency', currency)),
            ceiling: money(ceiling, str(m, 'currency', currency)),
          }
        : { kind: 'count', used: count, ceiling: max, unit: 'contacts' },
      expiresAt: str(m, 'expires_at') || null,
      inStrip: index < 2,
    };
  });
}
function projectMoney(
  snapshot: Row,
  currency: string,
  metadata: Row,
  mandates: MandateView[],
  parties: Map<string, string>,
  generatedAt: string,
): MoneyView {
  const all = rows(snapshot, 'money_ledger').filter(
      row =>
        str(row, 'currency') === currency &&
        (!['envelope', 'forecast'].includes(str(row, 'kind')) ||
          !rows(snapshot, 'financial_plans').length ||
          row['ref_id'] === snapshot['current_financial_plan']),
    ),
    real = all.filter(r => r['sandbox_mode'] !== true),
    sandbox = all.filter(r => r['sandbox_mode'] === true);
  const sum = (values: Row[], kind: string) => values.filter(r => r['kind'] === kind).reduce((n, r) => n + num(r, 'amount_minor'), 0);
  const commitments = (values: Row[]) =>
    values
      .filter(r => r['kind'] === 'committed' && !values.some(p => p['kind'] === 'spent' && str(p, 'ref_id') === str(r, 'ref_id')))
      .reduce((n, r) => n + num(r, 'amount_minor'), 0);
  const budget = all.some(row => str(row, 'kind') === 'envelope') ? sum(all, 'envelope') : num(metadata, 'budgetMinor'),
    spent = sum(real, 'spent') - sum(real, 'refund'),
    committed = commitments(real),
    forecast = sum(real, 'forecast');
  const forecastRows = real.filter(r => r['kind'] === 'forecast');
  const forecastFigure: Figure = {
    id: 'money:forecast',
    value: { kind: 'money', amount: money(forecast, currency) },
    trust: forecastRows.some(r => r['basis'] === 'claimed') ? 'claimed' : 'planned',
    source: {
      label: forecastRows.length ? 'Money forecast ledger' : 'No forecast recorded',
      reference: forecastRows.map(id).join(',') || undefined,
    },
    observedAt: timestamp(latest(forecastRows) ?? {}) || generatedAt,
  };
  const payments = rows(snapshot, 'payments'),
    providerReceipts = rows(snapshot, 'provider_receipts');
  const receipts: ReceiptView[] = all
    .filter(r => ['spent', 'refund'].includes(str(r, 'kind')) && str(r, 'receipt_id'))
    .map(r => {
      const payment = payments.find(p => id(p) === str(r, 'ref_id'));
      const receipt = providerReceipts.find(p => id(p) === str(r, 'receipt_id'));
      return {
        id: id(r),
        at: timestamp(r),
        payee: parties.get(str(payment ?? {}, 'payee_id')) ?? 'Recorded payee',
        purpose: str(payment ?? {}, 'purpose', str(r, 'envelope')),
        amount: {
          id: `money:${id(r)}`,
          value: {
            kind: 'money',
            amount: money(num(r, 'amount_minor'), currency),
          },
          trust: 'verified',
          source: {
            label: 'Provider confirmation',
            reference: str(r, 'confirmation_event_id'),
          },
          observedAt: timestamp(r),
        },
        reference: str(receipt ?? {}, 'provider_reference', str(r, 'receipt_id')),
        sandbox: r['sandbox_mode'] === true,
      };
    });
  return {
    currency,
    totals: {
      budget: money(budget, currency),
      spent: money(spent, currency),
      committed: money(committed, currency),
      forecast: forecastFigure,
      left: money(budget - spent, currency),
      headroom: money(budget - spent - committed - forecast, currency),
    },
    envelopes: [...new Set(real.map(r => str(r, 'envelope')))].map(name => {
      const values = real.filter(r => str(r, 'envelope') === name);
      return {
        id: name,
        name,
        allocated: money(sum(values, 'envelope'), currency),
        spent: money(sum(values, 'spent') - sum(values, 'refund'), currency),
        committed: money(commitments(values), currency),
        forecast: money(sum(values, 'forecast'), currency),
      };
    }),
    mandates,
    receipts: receipts.filter(r => !r.sandbox),
    sandbox: sandbox.length
      ? {
          totals: {
            spent: money(sum(sandbox, 'spent') - sum(sandbox, 'refund'), currency),
            committed: money(commitments(sandbox), currency),
          },
          receipts: receipts.filter(r => r.sandbox),
        }
      : null,
  };
}
export function projectMissionSummary(view: MissionView): MissionSummary {
  return {
    id: view.missionId,
    name: view.header.name,
    untitled: view.header.untitled,
    icon: null,
    pendingDecisions: Object.values(view.decisions).filter(d => d.status === 'pending' && !d.stale).length,
    overdueCommitments: view.commitments.filter(c => c.overdueDays > 0).length,
    levels: Object.fromEntries(view.readiness.outcomes.map(r => [r.outcome, r.level])) as OutcomeLevels,
    status: view.status,
    sandbox: view.sandbox,
    line: view.header.line,
  };
}

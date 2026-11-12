import type { JsonValue } from '@lo/state';
import type { DocSection, Figure, EvidenceItem } from '../ui-contract';
const label = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, s => s.toUpperCase());
const hidden = new Set(['id', 'kind', 'type', 'parts', 'dims_mm', 'effectIntent', 'mandate', 'logoSvg', 'sourceRunId', 'source_run_id']);
/** A semantic document projection: executable authority and opaque references are
 * represented by their dedicated packets; business content remains readable. */
export function artifactDocument(
  content: Record<string, JsonValue>,
  context: { versionId: string; observedAt: string; evidence: ReadonlyMap<string, EvidenceItem> },
): DocSection[] {
  const sections: DocSection[] = [];
  const walk = (value: JsonValue, key: string, depth: number, currency?: string, path = ''): void => {
    if (value === null || hidden.has(key) || /(?:Id|Ids)$/.test(key)) return;
    const heading = label(key);
    if (Array.isArray(value)) {
      if (!value.length) return;
      if (value.every(v => typeof v === 'string')) {
        sections.push({ k: 'heading', text: heading }, { k: 'prose', paragraphs: value.map(v => [{ t: 'text', text: String(v) }]) });
        return;
      }
      value.forEach((v, i) => walk(v, `${heading} ${i + 1}`, depth + 1, currency, `${path}/${i}`));
      return;
    }
    if (typeof value === 'object') {
      const localCurrency = typeof value.currency === 'string' ? value.currency : currency;
      if (typeof value.text === 'string' && typeof value.trust === 'string') {
        const refs = Array.isArray(value.evidenceIds) ? value.evidenceIds.filter((r): r is string => typeof r === 'string') : [];
        const sources = refs.map(r => context.evidence.get(r)).filter((r): r is EvidenceItem => !!r);
        const trust =
          sources.length === refs.length && sources.length > 0 && sources.every(e => e.trust === value.trust)
            ? (sources[0]?.trust ?? 'planned')
            : 'planned';
        sections.push({
          k: 'fields',
          rows: [
            {
              label: heading,
              value: '',
              figure: {
                id: `${context.versionId}:${path}`,
                value: { kind: 'text', text: value.text },
                trust,
                source: sources[0]?.source ?? { label: 'Proposed artifact', reference: context.versionId },
                observedAt: sources[0]?.observedAt ?? context.observedAt,
              },
            },
          ],
        });
        return;
      }
      if (depth > 0) sections.push({ k: 'heading', text: heading });
      for (const [child, v] of Object.entries(value))
        walk(v, child, depth + 1, localCurrency, `${path}/${child.replaceAll('~', '~0').replaceAll('/', '~1')}`);
      return;
    }
    if (typeof value === 'number') {
      const figure: Figure = {
        id: `${context.versionId}:${path}`,
        value:
          key.endsWith('Minor') && currency
            ? { kind: 'money', amount: { amountMinor: value, currency } }
            : /Percent$/.test(key)
              ? { kind: 'percent', value }
              : { kind: 'quantity', value, unit: key.endsWith('Days') ? 'days' : key.toLowerCase().includes('mm') ? 'mm' : '' },
        trust: 'planned',
        source: { label: 'Proposed artifact value', reference: context.versionId },
        observedAt: context.observedAt,
      };
      sections.push({ k: 'fields', rows: [{ label: heading.replace(/ Minor$/, ''), value: '', figure }] });
      return;
    }
    if (typeof value === 'boolean') {
      sections.push({ k: 'fields', rows: [{ label: heading, value: value ? 'Yes' : 'No' }] });
      return;
    }
    if (!value.trim()) return;
    sections.push(value.length > 160 ? { k: 'heading', text: heading } : { k: 'fields', rows: [{ label: heading, value }] });
    if (value.length > 160) sections.push({ k: 'prose', paragraphs: [[{ t: 'text', text: value }]] });
  };
  walk(content, '', 0);
  return sections;
}

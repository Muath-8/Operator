import { SaxesParser } from 'saxes';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { JsonValue } from '@lo/state';
const tags = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'title',
  'desc',
  'defs',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
]);
const attributes = new Set([
  'xmlns',
  'viewBox',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'fill-rule',
  'clip-rule',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'transform',
  'id',
  'clip-path',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientUnits',
  'gradientTransform',
  'font-family',
  'font-size',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'letter-spacing',
  'role',
  'aria-label',
]);
/** Editable sources are a small inert vector language, never HTML or executable
 * SVG. Parsing rejects malformed XML, DTDs, active elements and remote resources. */
export function validateEditableSvg(raw: string): string {
  const text = z.string().min(1).max(1_000_000).parse(raw);
  let count = 0,
    depth = 0,
    root = false;
  const parser = new SaxesParser({ xmlns: false });
  parser.on('doctype', () => {
    throw new Error('validation: SVG document types are forbidden');
  });
  parser.on('processinginstruction', () => {
    throw new Error('validation: SVG processing instructions are forbidden');
  });
  parser.on('opentag', tag => {
    count++;
    depth++;
    if (count > 5000 || depth > 40) throw new Error('validation: SVG complexity limit');
    if (!root) {
      if (tag.name !== 'svg' || tag.attributes.xmlns !== 'http://www.w3.org/2000/svg')
        throw new Error('validation: SVG root namespace required');
      root = true;
    }
    if (!tags.has(tag.name)) throw new Error('validation: active or unsupported SVG element');
    for (const [name, value] of Object.entries(tag.attributes)) {
      if (!attributes.has(name) || typeof value !== 'string') throw new Error('validation: unsupported SVG attribute');
      if (/[\\\u0000-\u001f\u007f]/.test(value)) throw new Error('validation: escaped or control SVG attribute');
      if (name === 'xmlns' && value !== 'http://www.w3.org/2000/svg') throw new Error('validation: unexpected SVG namespace');
      if (
        name !== 'xmlns' &&
        (/(?:https?:|data:|javascript:|expression\s*\(|@import)/i.test(value) ||
          (/url\s*\(/i.test(value) && !/^url\(#[A-Za-z][\w.-]*\)$/.test(value)))
      )
        throw new Error('validation: external or active SVG reference');
    }
  });
  parser.on('closetag', () => {
    depth--;
  });
  parser.write(text).close();
  if (!root) throw new Error('validation: empty SVG');
  return text;
}
export async function persistEditableSources(
  db: PoolClient,
  missionId: string,
  runId: string,
  content: Record<string, JsonValue>,
): Promise<Record<string, JsonValue>> {
  if (typeof content.logoSvg !== 'string') return content;
  const svg = validateEditableSvg(content.logoSvg),
    hash = createHash('sha256').update(svg).digest('hex');
  const row =
    (
      await db.query(
        "insert into public.editable_assets(mission_id,source_run_id,name,mime_type,content_base64,payload_hash,actor_id)values($1,$2,'logo.svg','image/svg+xml',$3,$4,private.actor_id())on conflict(mission_id,source_run_id,payload_hash)do nothing returning id",
        [missionId, runId, Buffer.from(svg, 'utf8').toString('base64'), hash],
      )
    ).rows[0] ??
    (
      await db.query('select id from public.editable_assets where mission_id=$1 and source_run_id=$2 and payload_hash=$3', [
        missionId,
        runId,
        hash,
      ])
    ).rows[0];
  const { logoSvg: _source, ...remaining } = content;
  return { ...remaining, editableLogoAssetIds: [...z.array(z.uuid()).parse(content.editableLogoAssetIds ?? []), z.uuid().parse(row?.id)] };
}
export async function assertAssetReferences(db: PoolClient, missionId: string, content: Record<string, JsonValue>): Promise<void> {
  for (const key of ['editableLogoAssetIds', 'packagingAssetIds', 'assetIds', 'sourceAssetIds']) {
    if (content[key] === undefined) continue;
    for (const id of z.array(z.uuid()).parse(content[key])) {
      const row = (
        await db.query(
          'select mime_type from public.editable_assets where mission_id=$1 and id=$2 union all select mime_type from public.provider_assets where mission_id=$1 and id=$2',
          [missionId, id],
        )
      ).rows[0];
      if (!row || (key === 'editableLogoAssetIds' && row.mime_type !== 'image/svg+xml'))
        throw new Error('validation: asset source missing, foreign, or not editable vector');
    }
  }
  const scan = async (value: JsonValue): Promise<void> => {
    if (Array.isArray(value)) {
      for (const item of value) await scan(item);
    } else if (value && typeof value === 'object') await assertAssetReferences(db, missionId, value);
  };
  for (const child of Object.values(content)) await scan(child);
}

import { z } from 'zod';
import type { PoolClient } from 'pg';
import { JsonObjectSchema, type JsonValue } from '@lo/state';
import type { TaskBrief } from './contracts.js';
const RecordSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  content: JsonObjectSchema,
  review_status: z.enum(['unverified', 'reviewed']),
  sources: z.array(z.string()).min(1),
});
/** Category vocabulary and thresholds are rows, never application branches. An
 * unknown category keeps its name and receives a visibly unverified research brief. */
export async function loadKnowledge(db: PoolClient, metadata: Record<string, JsonValue>) {
  const category = typeof metadata.categoryProfileId === 'string' ? metadata.categoryProfileId : 'generic';
  const version = typeof metadata.categoryProfileVersion === 'number' ? metadata.categoryProfileVersion : null;
  let profile = (
    await db.query(
      "select *from public.category_profiles where id=$1 and version=coalesce($2::int,public.knowledge_active_version('category_profile',$1))",
      [category, version],
    )
  ).rows[0];
  const unknown = !profile;
  if (!profile)
    profile = (
      await db.query(
        "select *from public.category_profiles where id='generic'and version=public.knowledge_active_version('category_profile','generic')",
      )
    ).rows[0];
  const parsed = RecordSchema.parse(profile);
  const versions = z.record(z.string(), z.number().int().positive()).parse(parsed.content.playbooks ?? {});
  const playbooks = [];
  for (const [id, v] of Object.entries(versions)) {
    const row = (await db.query('select *from public.playbooks where id=$1 and version=$2', [id, v])).rows[0];
    playbooks.push(RecordSchema.parse(row));
  }
  // Optional proposals remain visible with explicit provenance and no automatic execution.
  const optional = (
    await db.query(
      "select *from public.playbooks p where p.version=public.knowledge_active_version('playbook',p.id)and exists(select from jsonb_array_elements(p.content->'steps')s where jsonb_typeof(s)='object'and s->'optional'='true'::jsonb)order by p.id",
    )
  ).rows.map(row => RecordSchema.parse(row));
  for (const book of optional) if (!playbooks.some(p => p.id === book.id)) playbooks.push(book);
  return {
    requestedCategory: category,
    unknownCategory: unknown,
    profile: parsed,
    playbooks,
    warning:
      parsed.review_status === 'unverified' || playbooks.some(p => p.review_status === 'unverified')
        ? 'Category and market guidance is unverified; human review is pending.'
        : null,
  };
}
export async function taskKnowledge(db: PoolClient, task: TaskBrief) {
  const row = RecordSchema.parse(
    (await db.query('select *from public.playbooks where id=$1 and version=$2', [task.playbook.id, task.playbook.version])).rows[0],
  );
  const steps = z
    .array(z.object({ id: z.string(), instruction: z.string(), source: z.url(), optional: z.boolean() }).passthrough())
    .parse(row.content.steps);
  const step = steps.find(s => s.id === task.playbook.step);
  if (!step || step.source !== task.playbook.source) throw new Error('validation: task must name an exact sourced playbook step');
  return { ...row, selectedStep: step };
}

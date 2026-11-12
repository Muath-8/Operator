import { z } from 'zod';
import { DecisionOptionSchema, DecisionPacketSchema, JsonObjectSchema } from '@lo/state';
import { ArtifactOutputSchema, CommitmentOutputSchema, PlanDeltaSchema, RunResultSchema } from './contracts.js';
const CommitmentWireSchema = CommitmentOutputSchema.extend({ inspection: CommitmentOutputSchema.shape.inspection.unwrap().nullable() });

// Strict Structured Outputs cannot express arbitrary object keys. Only the
// open-ended artifact/evidence body travels as JSON text; the surrounding
// business contract remains a fully typed strict schema and is validated again.
export const RunResultWireSchema = RunResultSchema.extend({
  commitments: z.array(CommitmentWireSchema),
  artifacts: z.array(
    ArtifactOutputSchema.omit({ content: true }).extend({
      contentJson: z.string().describe('JSON object with the artifact content; parsed and validated by the server'),
    }),
  ),
  evidence: z.array(
    RunResultSchema.shape.evidence.element
      .omit({ payload: true })
      .extend({ payloadJson: z.string().describe('JSON object of claimed or planned evidence; never a performed receipt') }),
  ),
});
const PacketWireSchema = z
  .object({
    ...DecisionPacketSchema.shape,
    options: z.array(DecisionOptionSchema.required()).min(1).max(4),
    approvedVersionIds: z.array(z.uuid()),
    impact: DecisionPacketSchema.shape.impact.unwrap().nullable(),
  })
  .strict();
export const PlanDeltaWireSchema = PlanDeltaSchema.extend({
  commitments: z.array(CommitmentWireSchema),
  questions: PlanDeltaSchema.shape.questions.unwrap(),
  decisions: z.array(PlanDeltaSchema.shape.decisions.element.extend({ packet: PacketWireSchema })),
});
export function decodeRunResult(raw: unknown) {
  const wire = RunResultWireSchema.parse(raw);
  return RunResultSchema.parse({
    ...wire,
    commitments: wire.commitments.map(c => ({ ...c, inspection: c.inspection ?? undefined })),
    artifacts: wire.artifacts.map(({ contentJson, ...a }) => ({ ...a, content: JsonObjectSchema.parse(JSON.parse(contentJson)) })),
    evidence: wire.evidence.map(({ payloadJson, ...e }) => ({ ...e, payload: JsonObjectSchema.parse(JSON.parse(payloadJson)) })),
  });
}
export function decodePlanDelta(raw: unknown) {
  const wire = PlanDeltaWireSchema.parse(raw);
  return PlanDeltaSchema.parse({
    ...wire,
    commitments: wire.commitments.map(c => ({ ...c, inspection: c.inspection ?? undefined })),
    decisions: wire.decisions.map(d => ({ ...d, packet: { ...d.packet, impact: d.packet.impact ?? undefined } })),
  });
}

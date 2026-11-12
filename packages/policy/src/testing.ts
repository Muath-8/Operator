import { randomUUID } from 'node:crypto';
import {
  bindingHash,
  evaluatePolicy,
  previewReservationMinor,
  failure,
  type EffectIntent,
  type EffectRepository,
  type EffectReservation,
  type Failure,
  type PolicySnapshot,
  type Receipt,
} from './index.js';

/** Explicit process-local simulator. Never instantiate this as a production persistence fallback. */
export class MemoryEffectRepository implements EffectRepository {
  readonly reservations = new Map<string, EffectReservation>();
  readonly intents = new Map<string, EffectIntent>();
  readonly keys = new Map<string, string>();
  constructor(
    readonly snapshot: PolicySnapshot,
    environment: 'test' | 'development',
  ) {
    if (!['test', 'development'].includes(environment) || process.env['NODE_ENV'] === 'production')
      throw new Error('In-memory effect simulator is disabled in production.');
  }
  async reserveEffect(intent: EffectIntent) {
    const key = `${intent.missionId}:${intent.idempotencyKey}`;
    const previous = this.keys.get(key);
    if (previous) {
      const old = this.intents.get(previous);
      const reservation = this.reservations.get(previous);
      if (!old || !reservation || bindingHash(old) !== bindingHash(intent) || old.effectClass !== intent.effectClass)
        return failure('invariant_violation', 'Idempotency key reused for another intent.');
      return { ...reservation, replay: true };
    }
    const decision = evaluatePolicy(intent, this.snapshot);
    if (decision.kind !== 'allow') return decision.kind === 'deny' ? decision.failure : failure('needs_approval', decision.reason);
    if (decision.source === 'approval' && this.snapshot.approval) this.snapshot.approval.consumed = true;
    if (decision.mandateId) {
      const mandate = this.snapshot.mandates.find(m => m.id === decision.mandateId);
      if (mandate) {
        mandate.reservedMinor += previewReservationMinor(intent, this.snapshot) ?? 0;
        mandate.usedActions++;
      }
    }
    this.snapshot.budgetRemainingMinor -= previewReservationMinor(intent, this.snapshot) ?? 0;
    const authorizationId = randomUUID();
    const reservation: EffectReservation = { authorizationId, status: 'reserved', replay: false };
    this.keys.set(key, authorizationId);
    this.intents.set(authorizationId, intent);
    this.reservations.set(authorizationId, reservation);
    return reservation;
  }
  async beginEffect(id: string) {
    const r = this.reservations.get(id);
    const intent = this.intents.get(id);
    if (!r || !intent || r.status !== 'reserved') return failure('rejected', 'Effect has already started or is unknown.');
    const mandate = this.snapshot.mandates.find(m => m.id === intent.mandateId);
    if (this.snapshot.paused || this.snapshot.killed || (mandate && (mandate.revokedAt || Date.parse(mandate.expiresAt) <= Date.now()))) {
      r.status = 'failed';
      return failure('rejected', 'Effect cancelled by pause or revocation.');
    }
    r.status = 'started';
    return { ok: true as const };
  }
  async completeEffect(id: string, receipt: Receipt) {
    const r = this.reservations.get(id);
    if (!r || r.status !== 'started') throw new Error('Effect is not started.');
    r.status = 'performed';
    r.receipt = receipt;
  }
  async failEffect(id: string, ambiguous: boolean) {
    const r = this.reservations.get(id);
    if (!r) throw new Error('Effect missing.');
    r.status = ambiguous ? 'ambiguous' : 'failed';
  }
  async withDispatch<T>(id: string, invoke: (scoped: EffectRepository) => Promise<T>): Promise<T | Failure> {
    const began = await this.beginEffect(id);
    if (!began.ok) return began;
    return invoke(this);
  }
}

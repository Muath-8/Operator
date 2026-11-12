import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { JsonObjectSchema } from '@lo/state';
import { CommandSchema } from '../commands.js';
import { generateLocalReply } from '../local-ai.js';
import { emptyLocalSnapshot, localSeedSnapshots, type LocalRow } from './seed.js';

export type LocalCommandResult =
  | { ok: true; ledgerVersion: number; missionId?: string }
  | { ok: false; error: { code: 'validation' | 'forbidden' | 'conflict' | 'unavailable'; message: string; retryable: boolean } };
export class LocalStoreError extends Error {
  constructor(
    readonly code: 'validation' | 'forbidden' | 'conflict' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}
const stores = new Map<string, DatabaseSync>();
function guard() {
  if (
    process.env['LO_STORAGE_BACKEND'] !== 'sqlite' ||
    process.env['LO_EXECUTION_MODE'] !== 'local' ||
    process.env['NODE_ENV'] === 'production'
  )
    throw new LocalStoreError('unavailable', 'SQLite testing is available only in explicit nonproduction local mode.');
}
function database() {
  guard();
  const path = resolve(process.env['LO_SQLITE_PATH'] ?? resolve(process.cwd(), '.local/testing/operator.sqlite'));
  let db = stores.get(path);
  if (db) return db;
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;
 create table if not exists local_missions(id text primary key,auth_user_id text not null,revision integer not null,snapshot text not null,created_at text not null);
 create index if not exists local_mission_owner on local_missions(auth_user_id,created_at);
 create table if not exists local_commands(auth_user_id text not null,mission_id text not null,request_key text not null,request_hash text not null,status text not null check(status in('pending','completed')),result text,created_at text not null,primary key(auth_user_id,mission_id,request_key),foreign key(mission_id)references local_missions(id));
 create table if not exists local_creations(auth_user_id text not null,request_key text not null,request_hash text not null,mission_id text not null,primary key(auth_user_id,request_key),foreign key(mission_id)references local_missions(id));`);
  stores.set(path, db);
  return db;
}
function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = work();
    db.exec('COMMIT');
    return value;
  } catch (error: unknown) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function owner(raw: string) {
  return z.uuid().parse(raw);
}
function seed(db: DatabaseSync, authUserId: string) {
  if (db.prepare('select id from local_missions where auth_user_id=? limit 1').get(authUserId)) {
    // Add only a missing deterministic seed decision. Preserve every recorded
    // founder choice/message and all existing source versions during upgrades.
    transaction(db, () => {
      for (const template of localSeedSnapshots(authUserId)) {
        const mission = JsonObjectSchema.parse(template.mission),
          record = db.prepare('select snapshot from local_missions where auth_user_id=? and id=?').get(authUserId, String(mission.id));
        if (!record) continue;
        const current = JsonObjectSchema.parse(JSON.parse(z.string().parse(record.snapshot))),
          metadata = JsonObjectSchema.parse(JsonObjectSchema.parse(current.mission).metadata);
        if (metadata.localSimulation !== true) continue;
        let changed = false;
        for (const candidate of rows(template, 'decisions'))
          if (!rows(current, 'decisions').some(existing => existing.id === candidate.id)) {
            append(current, 'decisions', candidate);
            changed = true;
          }
        if (changed) {
          bump(current);
          save(db, authUserId, current);
        }
      }
    });
    return;
  }
  transaction(db, () => {
    if (db.prepare('select id from local_missions where auth_user_id=? limit 1').get(authUserId)) return;
    for (const snapshot of localSeedSnapshots(authUserId)) {
      const mission = JsonObjectSchema.parse(snapshot.mission);
      db.prepare('insert into local_missions values(?,?,?,?,?)').run(
        String(mission.id),
        authUserId,
        Number(snapshot.ledger_version),
        JSON.stringify(snapshot),
        String(mission.created_at),
      );
    }
  });
}
function load(db: DatabaseSync, authUserId: string, missionId: string): LocalRow {
  const row = db.prepare('select snapshot from local_missions where auth_user_id=? and id=?').get(authUserId, missionId);
  if (!row) throw new LocalStoreError('forbidden', 'Local mission is unavailable for this user.');
  return JsonObjectSchema.parse(JSON.parse(z.string().parse(row.snapshot)));
}
function clock(snapshot: LocalRow) {
  return new Date(Math.max(Date.now(), Date.parse(String(snapshot.generated_at)) + 1)).toISOString();
}
function rows(snapshot: LocalRow, key: string): LocalRow[] {
  const value = snapshot[key];
  if (!Array.isArray(value)) {
    snapshot[key] = [];
    return snapshot[key] as LocalRow[];
  }
  return z.array(JsonObjectSchema).parse(value);
}
function append(snapshot: LocalRow, key: string, row: LocalRow) {
  const value = rows(snapshot, key);
  value.push(row);
  snapshot[key] = value;
}
function bump(snapshot: LocalRow) {
  snapshot.ledger_version = z.number().int().safe().nonnegative().parse(snapshot.ledger_version) + 1;
  snapshot.generated_at = clock(snapshot);
  return Number(snapshot.ledger_version);
}
function save(db: DatabaseSync, authUserId: string, snapshot: LocalRow) {
  const mission = JsonObjectSchema.parse(snapshot.mission);
  db.prepare('update local_missions set revision=?,snapshot=? where auth_user_id=? and id=?').run(
    Number(snapshot.ledger_version),
    JSON.stringify(snapshot),
    authUserId,
    String(mission.id),
  );
}
function hash(raw: unknown): string {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, stable(child)]),
          )
        : value;
  return createHash('sha256')
    .update(JSON.stringify(stable(raw)))
    .digest('hex');
}
function founderThread(snapshot: LocalRow) {
  const thread = rows(snapshot, 'threads').find(row => row.counterparty_id === null);
  if (!thread) throw new LocalStoreError('unavailable', 'The local founder conversation is missing.');
  return String(thread.id);
}
function message(snapshot: LocalRow, direction: 'founder' | 'lead', text: string, source?: string) {
  const mission = JsonObjectSchema.parse(snapshot.mission);
  append(snapshot, 'messages', {
    id: randomUUID(),
    mission_id: mission.id ?? '',
    thread_id: founderThread(snapshot),
    direction,
    channel: 'internal',
    original: text,
    created_at: clock(snapshot),
    ...(source ? { local_reply_source: source } : {}),
  });
}
function activity(snapshot: LocalRow, label: string, summary: string, refs: string[] = []) {
  const mission = JsonObjectSchema.parse(snapshot.mission);
  append(snapshot, 'activity', { id: randomUUID(), mission_id: mission.id ?? '', label, summary, refs, created_at: clock(snapshot) });
}
function errorResult(error: unknown): LocalCommandResult {
  if (error instanceof LocalStoreError)
    return {
      ok: false,
      error: { code: error.code, message: error.message, retryable: error.code === 'conflict' || error.code === 'unavailable' },
    };
  return {
    ok: false,
    error: {
      code: error instanceof z.ZodError ? 'validation' : 'unavailable',
      message:
        error instanceof z.ZodError
          ? 'Local command does not match its contract.'
          : 'The local action could not be saved. Retry this same request.',
      retryable: !(error instanceof z.ZodError),
    },
  };
}

export async function listLocalMissionIds(authUserId: string): Promise<string[]> {
  const user = owner(authUserId),
    db = database();
  seed(db, user);
  return db
    .prepare('select id from local_missions where auth_user_id=? order by created_at,id')
    .all(user)
    .map(row => z.uuid().parse(row.id));
}
export async function readLocalSnapshot(authUserId: string, missionId: string): Promise<LocalRow> {
  const user = owner(authUserId),
    id = z.uuid().parse(missionId),
    db = database();
  seed(db, user);
  return load(db, user, id);
}
export async function createLocalMission(authUserId: string, raw: unknown): Promise<{ missionId: string; ledgerVersion: number }> {
  const user = owner(authUserId),
    input = z
      .object({
        idempotencyKey: z.string().min(16).max(256),
        kind: z.literal('createMission').optional(),
        title: z.string().trim().max(200).optional(),
        goalBrief: z.string().trim().max(12000).optional(),
      })
      .strict()
      .parse(raw),
    db = database(),
    requestHash = hash(input);
  return transaction(db, () => {
    const prior = db
      .prepare('select request_hash,mission_id from local_creations where auth_user_id=? and request_key=?')
      .get(user, input.idempotencyKey);
    if (prior) {
      if (prior.request_hash !== requestHash)
        throw new LocalStoreError('conflict', 'Creation request identity was reused with different content.');
      const snapshot = load(db, user, z.uuid().parse(prior.mission_id));
      return { missionId: String(prior.mission_id), ledgerVersion: Number(snapshot.ledger_version) };
    }
    const id = randomUUID(),
      snapshot = emptyLocalSnapshot(
        user,
        id,
        input.title ?? 'Untitled local mission',
        input.goalBrief ?? 'Tell the local assistant what you would like to explore.',
      ),
      mission = JsonObjectSchema.parse(snapshot.mission),
      metadata = JsonObjectSchema.parse(mission.metadata);
    metadata.budgetMinor = 0;
    mission.metadata = metadata;
    snapshot.mission = mission;
    db.prepare('insert into local_missions values(?,?,?,?,?)').run(id, user, 1, JSON.stringify(snapshot), String(mission.created_at));
    db.prepare('insert into local_creations values(?,?,?,?)').run(user, input.idempotencyKey, requestHash, id);
    return { missionId: id, ledgerVersion: 1 };
  });
}

export async function executeLocalCommand(authUserId: string, raw: unknown): Promise<LocalCommandResult> {
  let pendingChat: { user: string; missionId: string; key: string; text: string; title: string } | undefined;
  try {
    const user = owner(authUserId),
      input = CommandSchema.parse(raw),
      db = database(),
      requestHash = hash(input);
    const result = transaction(db, () => {
      const snapshot = load(db, user, input.missionId),
        prior = db
          .prepare('select request_hash,status,result from local_commands where auth_user_id=? and mission_id=? and request_key=?')
          .get(user, input.missionId, input.idempotencyKey);
      if (prior) {
        if (prior.request_hash !== requestHash)
          throw new LocalStoreError('conflict', 'Request identity was reused with different content.');
        if (prior.status === 'pending')
          throw new LocalStoreError('unavailable', 'The earlier local reply is still pending. Refresh or retry the same request.');
        return JSON.parse(z.string().parse(prior.result)) as LocalCommandResult;
      }
      if (Number(snapshot.ledger_version) !== input.seenLedgerVersion)
        throw new LocalStoreError('conflict', 'The local mission changed. Refresh before submitting this action.');
      if (snapshot.status === 'paused' && ['resolveDecision', 'approveDraft'].includes(input.kind))
        throw new LocalStoreError(
          'conflict',
          'Resume the local mission before approving decisions or drafts. Chat remains text advice only.',
        );
      const now = clock(snapshot),
        mission = JsonObjectSchema.parse(snapshot.mission);
      switch (input.kind) {
        case 'setMissionStatus':
          snapshot.status = input.status;
          append(snapshot, 'mission_transitions', {
            id: randomUUID(),
            mission_id: input.missionId,
            status: input.status,
            created_at: now,
            actor_id: user,
          });
          activity(
            snapshot,
            'approved',
            input.status === 'paused'
              ? 'Local mission paused. No external services are running.'
              : 'Local mission resumed in simulation mode.',
          );
          break;
        case 'sendMessage':
          message(snapshot, 'founder', input.text);
          pendingChat = {
            user,
            missionId: input.missionId,
            key: input.idempotencyKey,
            text: input.text,
            title: String(JsonObjectSchema.parse(mission.metadata).title ?? 'Local mission'),
          };
          break;
        case 'resolveDecision': {
          const decision = rows(snapshot, 'decisions').find(row => row.id === input.decisionId);
          if (!decision) throw new LocalStoreError('validation', 'Decision is outside this local mission.');
          if (
            rows(snapshot, 'decision_resolutions').some(
              row => row.decision_id === input.decisionId && ['approve', 'choose', 'reject'].includes(String(row.response)),
            )
          )
            throw new LocalStoreError('conflict', 'This local decision has already been resolved.');
          const packet = JsonObjectSchema.parse(decision.packet),
            options = z.array(JsonObjectSchema).parse(packet.options),
            option = options.find(row => row.id === input.optionId);
          if (!option) throw new LocalStoreError('validation', 'Choose a recorded decision option.');
          append(snapshot, 'decision_resolutions', {
            id: randomUUID(),
            mission_id: input.missionId,
            decision_id: input.decisionId,
            response: input.response,
            option_id: input.optionId,
            actor_id: user,
            created_at: now,
          });
          for (const version of z.array(z.string()).parse(option.artifactVersionIds ?? []))
            append(snapshot, 'artifact_statuses', {
              id: randomUUID(),
              mission_id: input.missionId,
              artifact_version_id: version,
              status: input.response === 'reject' ? 'rejected' : 'approved',
              decision_id: input.decisionId,
              created_at: now,
            });
          message(
            snapshot,
            'lead',
            `Local simulation: ${input.response === 'reject' ? 'declined' : 'saved'} “${String(option.label)}”. No supplier message, payment, registration or provider receipt was created.`,
            'simulated',
          );
          activity(snapshot, 'approved', 'Local simulated decision recorded; no external effect authorized.', [input.decisionId]);
          break;
        }
        case 'deferDecision':
          if (!rows(snapshot, 'decisions').some(row => row.id === input.decisionId))
            throw new LocalStoreError('validation', 'Decision is outside this local mission.');
          append(snapshot, 'decision_resolutions', {
            id: randomUUID(),
            mission_id: input.missionId,
            decision_id: input.decisionId,
            response: 'defer',
            option_id: null,
            actor_id: user,
            created_at: now,
          });
          break;
        case 'approveDraft':
        case 'discardDraft': {
          const version = rows(snapshot, 'artifact_versions').find(row => row.id === input.draftId && row.artifact_id === input.artifactId);
          if (!version) throw new LocalStoreError('validation', 'Draft and artifact do not match this local mission.');
          append(snapshot, 'artifact_statuses', {
            id: randomUUID(),
            mission_id: input.missionId,
            artifact_version_id: input.draftId,
            status: input.kind === 'discardDraft' ? 'rejected' : 'approved',
            created_at: now,
          });
          activity(
            snapshot,
            'approved',
            input.kind === 'discardDraft' ? 'Local draft discarded.' : 'Local draft approved for review only; nothing was sent.',
            [input.draftId],
          );
          break;
        }
        case 'setHelpMode':
          append(snapshot, 'founder_preferences', {
            id: randomUUID(),
            mission_id: input.missionId,
            kind: 'help_mode',
            value: { ...input.control, mode: input.mode },
            created_at: now,
          });
          break;
        case 'updateNotificationSettings':
          append(snapshot, 'founder_preferences', {
            id: randomUUID(),
            mission_id: input.missionId,
            kind: 'notifications',
            value: input.settings,
            created_at: now,
          });
          break;
        case 'markNotificationsRead':
          snapshot.notification_events = rows(snapshot, 'notification_events').map(row =>
            input.notificationIds.includes(String(row.id)) ? { ...row, read_at: now } : row,
          );
          break;
        default:
          throw new LocalStoreError(
            'unavailable',
            'This action needs the full backend and is unavailable in the local simulation. No external action was performed.',
          );
      }
      const revision = bump(snapshot),
        value: LocalCommandResult = { ok: true, ledgerVersion: revision };
      append(snapshot, 'command_requests', { id: randomUUID(), mission_id: input.missionId, kind: input.kind, created_at: now });
      save(db, user, snapshot);
      db.prepare('insert into local_commands values(?,?,?,?,?,?,?)').run(
        user,
        input.missionId,
        input.idempotencyKey,
        requestHash,
        pendingChat ? 'pending' : 'completed',
        pendingChat ? null : JSON.stringify(value),
        now,
      );
      return value;
    });
    if (!pendingChat) return result;
    const chat = pendingChat;
    let reply: { text: string; source: 'simulated' | 'codex' },
      replyFailed = false;
    try {
      reply = await generateLocalReply({ message: chat.text, missionTitle: chat.title });
    } catch {
      replyFailed = true;
      reply = {
        text: 'The local assistant response was interrupted. Your message is saved. This demo has not performed external work. You can send another message to continue.',
        source: 'simulated',
      };
    }
    return transaction(db, () => {
      const snapshot = load(db, chat.user, chat.missionId),
        row = db
          .prepare('select status,result from local_commands where auth_user_id=? and mission_id=? and request_key=?')
          .get(chat.user, chat.missionId, chat.key);
      if (row?.status === 'completed') return JSON.parse(z.string().parse(row.result)) as LocalCommandResult;
      message(
        snapshot,
        'lead',
        `${replyFailed ? 'Local response unavailable' : reply.source === 'codex' ? 'Local Codex advice' : 'Simulated local assistant'}: ${reply.text}`,
        replyFailed ? 'local_error' : reply.source,
      );
      activity(
        snapshot,
        replyFailed ? 'blocked' : 'proposed',
        replyFailed
          ? 'Local response failed; founder input remains saved and no external action was performed.'
          : reply.source === 'codex'
            ? 'Local Codex text advice saved; no external action was performed.'
            : 'Simulated local assistant reply saved.',
      );
      const value: LocalCommandResult = { ok: true, ledgerVersion: bump(snapshot) };
      save(db, chat.user, snapshot);
      db.prepare("update local_commands set status='completed',result=? where auth_user_id=? and mission_id=? and request_key=?").run(
        JSON.stringify(value),
        chat.user,
        chat.missionId,
        chat.key,
      );
      return value;
    });
  } catch (error: unknown) {
    return errorResult(error);
  }
}
export function closeLocalStores(): void {
  for (const db of stores.values()) db.close();
  stores.clear();
}

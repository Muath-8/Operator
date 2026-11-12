# Local SQLite testing

This backend is available only with `LO_STORAGE_BACKEND=sqlite`, `LO_EXECUTION_MODE=local` and a nonproduction `NODE_ENV`. Node22.17's `node:sqlite` works without an additional flag; Node prints its experimental-feature warning. The launcher sets an absolute `LO_SQLITE_PATH` at `.local/testing/operator.sqlite`. The fallback is relative to the current working directory. No PostgreSQL, Supabase, Inngest or provider key is used by this store.

The two seeded missions contain clearly labeled illustrative brand/quote artifacts, decisions and conversation text. Values are planned examples. There are no provider receipts, executed payments, spent balances or verified readiness claims. A local sample approval records a founder choice only. A narrow additive seed upgrade supplies the second mission's missing decision without replacing existing history.

Exports from `@lo/runtime/local`:

- `listLocalMissionIds(authUserId):Promise<string[]>`
- `readLocalSnapshot(authUserId,missionId):Promise<Record<string,JsonValue>>`, compatible with the existing web projection.
- `createLocalMission(authUserId,{idempotencyKey,title?,goalBrief?,kind?:'createMission'}):Promise<{missionId,ledgerVersion}>`
- `executeLocalCommand(authUserId,raw):Promise<LocalCommandResult>`, using the existing strict command schema.
- `closeLocalStores():void` for tests/shutdown, plus `LOCAL_TEST_AUTH_USER_ID` and `LOCAL_DEMO_NOTICE`.

Supported actions are local decision resolution/defer, draft approve/discard, pause/resume, chat, help mode, notification preferences and read acknowledgements. Paused missions reject new approvals; text chat remains advice only. Other actions return explicit unavailable results and do not invent completion. Every operation binds owner, mission, request hash and revision. SQLite WAL, foreign keys, a busy timeout and `BEGIN IMMEDIATE` protect local persistence/idempotency.

Chat commits founder input and a pending identity before awaiting the root-owned local AI helper outside the transaction. A duplicate pending request does not invoke another reply. Replies are labeled simulated or local Codex advice; helper failures receive `local_error` metadata and a blocked activity entry. Completed replay/reopen does not duplicate messages. An interrupted pending generation remains explicitly pending rather than silently repeating the CLI call; another local message can continue the conversation. This is a useful local test backend, not PostgreSQL/role/ledger parity or a production execution engine.

## Executed checks

The store's8 tests plus the existing web SQLite route/projection suite's3 tests passed **11/11** after the actual Next webpack path correction. These check persistence/reopen, two seed projections, user isolation, creation/request identity conflicts, concurrent chat/approval behavior, pause/resume, stale revisions, unsupported actions, production guards and absence of PostgreSQL/outbox/provider calls. ESLint passes the owned local files. Root owns launcher, auth/API dispatch and AI helper integration.

```powershell
pnpm exec vitest run apps/runtime/src/local/store.test.ts apps/web/src/lib/sqlite-integration.test.ts
```

## Separate sandbox payment review

The separate `local-paypal.ts` integration is not mission payment authority. The state worker independently reviewed its pinned sandbox host, fixed USD1, loopback return origin, owner/client binding, persisted ambiguous claims, exact amount/payee/reference and independent order/capture confirmation. Author13 plus retained reviewer3 tests passed **16/16** at22:19, with mocked provider transport and real SQLite. Retained negatives reject a wrong final capture amount, a lookalike approval host without a second create POST, and another actor. No live PayPal payment was attempted by this review. Root owns API same-origin authentication and the payment page; policy worker owns payment implementation. There are no open findings in this bounded review.

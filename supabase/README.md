# Mission State database

Apply migrations in numeric order using a database migration owner. Application
roles have no DDL, UPDATE or DELETE privileges. Ledgers are immutable; decisions,
artifact statuses, payment states and event consumption are separate append-only
records. Every reference across mission tables is checked by composite foreign
keys or a tenant guard. Corrections and supersessions walk the dependency graph
inside the same mission lock, including second-order dependents.

Use founder JWTs with `founder_role` (or Supabase `authenticated`, which inherits
founder permissions). Runtime JWTs must carry the founder `sub`, scoped `mission_id`
and one assigned runtime role. Only the trusted Supabase authenticator can select
runtime roles. Never grant those roles to `authenticated` or `anon`, or use a
service-role/BYPASSRLS connection for application ledger writes. Role-scoped raw
inserts are limited to non-binding runtime records; binding changes use RPCs.

Effects must run through `PostgresMissionRepository.withDispatchLock` with a pinned
pool lease carrying its scoped session role/JWT and no open transaction. It commits
the durable dispatch claim first, then reacquires and rechecks the mission,
platform-control and payment-account locks until
the provider returns and its receipt/failure is recorded. Pause/revocation commit
after an already-started dispatch or before the next dispatch. Failed/ambiguous
authorizations cannot start again; reconcile with the same provider idempotency
key. The platform kill switch defaults to disabled effects and is writable only
by the deployment operator.

Supabase Realtime must have **Allow public access disabled** in project settings.
Clients subscribe to `mission:<uuid>` with `private: true`. Database triggers send
only table/id/mission ids, and clients re-read ledgers. The migration installs the
same mission predicate on `realtime.messages` and private `mission-files` storage.
Policies are created when these Supabase-owned schemas exist. Native PostgreSQL
tests install minimal test-only shims, then exercise the actual policies and
trigger payloads; they do not claim to test the external Realtime transport.

On Windows run `./supabase/tests/start-local.ps1`, then `pnpm exec vitest run
packages/state/test`. The suite defaults to the isolated loopback port 55439;
`LO_DATABASE_URL` overrides it. It creates and drops its own uniquely named test
database. The connection must be a local test migration administrator capable of
creating a database and roles. Tests never call a provider.

`seed.sql` supplies two explicitly sandboxed fixture missions. It is repeat-safe,
uses the same role-guarded RPCs as the app, and never creates fake provider success.
Its identities are local fixtures, not production accounts. `rollback/` contains
an empty-database-only reversal; populated deployments require a data-preserving
forward migration. Private credential references are outside the public schema
and never appear in snapshots or Launch Record exports.

# Operator

An AI workspace for a first-time founder launching a physical-product business. Explore brand directions, review supplier proposals and sample budgets, and keep conversations and decisions in one persistent workspace. The founder controls approvals and payments.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). This repository contains the runnable application, tests, required assets and an [MIT licence](LICENSE). It is a local prototype, not a production-ready autonomous business service.

## Two application options

| Option                      | Storage and services                                                                               | Status                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Local testing**           | SQLite; offline simulation or optional Codex/ChatGPT advice; optional real PayPal sandbox checkout | Runs without a database server or API key                           |
| **Production architecture** | PostgreSQL/Supabase, OpenAI APIs, Inngest and provider accounts                                    | Partially implemented; critical fixes and release validation remain |

## Run locally

Install **Node.js 22.17 or newer** and **pnpm 10.12.4**. PostgreSQL, Supabase, Docker and Inngest are not needed for this option.

```sh
git clone https://github.com/Muath-8/Operator.git
cd Operator
corepack enable
corepack prepare pnpm@10.12.4 --activate
pnpm install --frozen-lockfile
pnpm dev:local
```

Open **http://127.0.0.1:3100/login** and select **Sign in to the local sandbox**. Two labelled demo missions are included. Create a mission, chat, review a direction, pause/resume, and reload to see saved state. Unsupported actions explicitly report that they are unavailable.

Data stays in `.local/testing/operator.sqlite`; restarting preserves it. The launcher creates a random local session token without overwriting existing environment files and binds only to loopback. Stop with Ctrl+C before changing launch modes. Node 22 may display an experimental SQLite warning.

### Optional real AI using a ChatGPT subscription

Install the [Codex CLI](https://learn.chatgpt.com/docs/cli) and use its supported [ChatGPT sign-in](https://learn.chatgpt.com/docs/auth):

```sh
codex login
codex login status
pnpm dev:local:ai
```

This uses your own eligible subscription and its usage limits. No OpenAI API key is needed for local text advice. Operator invokes Codex in an isolated read-only workspace with shell execution, browsing, apps, plugins and multi-agent tools disabled. It does not read or copy authentication tokens. Advice cannot contact suppliers, authorize spending or execute payments. Production Agents SDK and Realtime integrations separately require API credentials.

If Codex is not on PATH, copy `.env.local-testing.example` to `.env.local-testing` and set `LO_CODEX_BIN` to its executable path. Set `LO_LOCAL_PORT` in that file to use another port. Keep the file private.

### Real PayPal sandbox checkout

The separate real sandbox checkout is at **http://127.0.0.1:3100/local/paypal**. The mission workspace's illustrative payment decisions are simulations and never create PayPal receipts.

1. Create a sandbox application in the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/applications/sandbox).
2. Copy `.env.local-testing.example` to the ignored root `.env.local-testing` file.
3. Set `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` to **sandbox** app values. `PAYPAL_MERCHANT_ID` is optional; if supplied, it must identify the sandbox business merchant.
4. Restart the app, sign in, and select **Separate PayPal sandbox** in the workspace banner.
5. Approve a fixed **USD 1.00 in sandbox test money**, sign in with a separate sandbox personal buyer account, then return and explicitly confirm capture.

The server uses only `https://api-m.sandbox.paypal.com`. It verifies payer approval, owner, reference, merchant, amount and currency before capture, then independently reads the capture receipt before reporting completion. Idempotent attempts persist in `.local/testing/paypal.sqlite`. Ambiguous writes remain pending rather than being blindly repeated. There is no live-money endpoint in this local checkout.

Missing credentials leave checkout disabled. This integration check is separate from the PostgreSQL mission payment ledger and does not prove a completed product launch.

## Tests and verified scope

```sh
pnpm test:local
pnpm typecheck
pnpm --filter @lo/web build
```

On November 12, 2026, all **40 local tests** passed, along with repository type checking and the optimized web build. Browser checks exercised sign-in, mission creation, chat, pause/resume, persistence and unavailable responses. An authenticated application request generated a real Codex/ChatGPT response and saved it in SQLite.

**An actual PayPal sandbox capture has not yet been verified in this setup: sandbox credentials were not configured.** PayPal tests use mocked HTTP with real temporary SQLite databases. Local test results do not certify production readiness.

The full `pnpm test` suite requires PostgreSQL 15 and permission to create disposable databases. Coverage thresholds and reviewed screenshot baselines remain separate release gates. The traceability audit needs private specification inputs intentionally excluded from publication. Missing evidence never counts as a pass. Push CI validates the local prototype; full release checks are separately selectable and are not represented as passed.

## Full PostgreSQL development and production

For the existing full development architecture, install PostgreSQL 15, then on Windows:

```powershell
pnpm setup:postgres
pnpm dev
# In a second terminal:
pnpm dev:inngest
```

The app uses http://127.0.0.1:3000 and the worker console uses http://127.0.0.1:8288. Setup defaults to `C:\Program Files\PostgreSQL\15\bin` and database port 55439. On another platform with PostgreSQL already running, set `LO_DATABASE_URL` to its local administrative test connection and run `pnpm exec tsx scripts/setup-local.ts`.

Hosted configuration is described by [.env.example](.env.example), [database setup](supabase/README.md), [voice setup](apps/voice/README.md), `render.yaml` and `deploy/`. It requires least-privilege database logins, Supabase Auth/Storage/Realtime, encrypted provider credentials, exact model IDs and pricing, Inngest keys, TLS and verified webhooks. Do not expose local sign-in publicly or apply test bootstrap SQL to production. SQLite testing does not claim PostgreSQL policy or role-isolation parity.

Known production blockers include the full Mission Lead's conservative request-budget check and an unproven hard voice spending ceiling. Voice and autonomous provider execution are outside the local demo. Hosted validation, complete mission scenarios and full release gates remain unfinished.

## Hackathon submission checklist

The [official rules](https://paypalaihackathon.devpost.com/rules) set the deadline at **November 12, 2026, 12:00 pm PST / 23:00 Riyadh**. Runnable repository instructions are an accepted alternative to hosting. A GitHub push is not a Devpost submission.

| Requirement                                                            | Status at publication                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Runnable source, required assets, instructions and open-source licence | Included here                                                                        |
| AI functionality                                                       | Local Codex advice exercised end to end                                              |
| PayPal sandbox integration                                             | Implemented and protocol-tested; actual sandbox transaction still needs verification |
| Public YouTube demo under three minutes                                | Not yet uploaded                                                                     |
| Description and completed Devpost submission                           | Still to be completed                                                                |
| Entrant eligibility and third-party permissions                        | Entrant must confirm their eligibility and permissions                               |

**Suggested demo:** explain the founder's problem, show real AI advice and a saved decision, demonstrate actual sandbox approval/capture, then explain the distinction between simulations and provider receipts. Identify the actual AI tool/model used. Do not present illustrative suppliers, simulated payments, mocked tests or incomplete production features as completed real work.

**Suggested description:** Operator brings product-launch planning, founder decisions and payment oversight into one workspace. Its local prototype saves missions in SQLite, offers AI advice through Codex, and lets a founder explicitly approve a PayPal sandbox checkout with verified capture receipts. The broader architecture separates AI proposals from deterministic authorization and records evidence behind external actions.

## Code map

| Path                | Purpose                                                     |
| ------------------- | ----------------------------------------------------------- |
| `apps/web`          | Next.js founder interface and HTTP endpoints                |
| `apps/runtime`      | SQLite local implementation and full agent/workflow runtime |
| `apps/voice`        | Separate voice relay, outside the local demo                |
| `packages/state`    | Shared contracts, projections and PostgreSQL repository     |
| `packages/policy`   | Deterministic effect authorization                          |
| `packages/adapters` | PayPal and other provider integrations                      |
| `packages/evals`    | Evaluation tooling and release gates                        |
| `supabase`          | Migrations and PostgreSQL test setup                        |
| `scripts`           | Launchers, operations and quality checks                    |

Secrets, databases, generated builds, logs and private design/specification folders are excluded from publication. Bundled font licence notices remain beside the fonts. See [LICENSE](LICENSE).

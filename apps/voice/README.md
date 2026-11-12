# Voice and provider service validation

The standalone Node server relays signed Twilio Media Streams to an explicitly allowed OpenAI Realtime model. It starts with a TwiML disclosure, supports Arabic and English, interrupts buffered playback when the counterparty speaks, and exposes only `check_bounds`, `write_fact`, `schedule_followup` and `end_call`. All verbal facts remain claimed. Complete generated speech is buffered until its transcript matches code-owned nonbinding questions or a bounds-checked trial question. This sacrifices some latency; the live latency and Arabic quality release gates are not claimed by local tests.

Provision separate environment-specific accounts, least-privilege role database logins and provider permissions. Apply all migrations. `PROVIDER_ENCRYPTION_KEY` must be a base64-encoded 32-byte key shared by the runtime and voice service; credentials and approval tokens are encrypted with AES-256-GCM and mission-specific authenticated data. Provider credentials are connected through the founder-authorized provisioning helper in `provider-storage.ts`; no production fallback reads an unrelated raw API key from a model request. Configure an explicit service budget for Browserbase/OpenAI before use.

The voice container receives `DATABASE_VOICE_URL`, the same encryption key, `VOICE_ORIGIN` (its public HTTPS address), `WEBHOOK_ORIGIN` (the web app public HTTPS address), and an explicit allowed connection `settings.realtimeModel`. It does not need a policy/spend database login. The policy runtime must reserve a sourced 100,000-token Realtime USD ceiling before initiating a call, using `MODEL_PRICE_RATES_JSON` with text and audio rates plus `MODEL_FOUNDER_DAILY_CAP_MICRO_USD`. Unknown actual usage keeps this full monetary reservation and reports a null measured cost. Image calls require a sourced `MODEL_IMAGE_PRICE_CEILINGS_JSON` flat maximum and the same founder cap. Production runtime configuration also requires the ordinary nonlocal environment values described in the root environment schema. The Twilio connection needs its account SID, auth token, sender, approved test recipients and callback origin. The OpenAI connection needs an API key, allowed models and output cap. The supplier needs a verified phone, recorded AI disclosure, business hours, opt-out state and jurisdiction-reviewed recording consent. Recording and full-transcript retention default to off.

Run the server with `pnpm --filter @lo/voice dev`. Build its separate container from the repository root with `docker build -f apps/voice/Dockerfile -t launch-operator-voice .`. Expose HTTPS/WSS on a provider-accessible host. `/health` reports process health only. Twilio HTTP/media endpoints require a signed routing token and a valid Twilio signature; the call SID, account, recipient and one-use stream claim are correlated to the stored session. Missing credentials, revoked access, pause and opt-out stop output.

On end, the service durably opens a written-confirmation commitment due within 15 minutes and calls the authenticated runtime wake endpoint. The runtime sends the record through the same channel policy/mandate boundary, or leaves a reviewable Guide draft. A delivered record does not promote verbal terms to verified; written counterparty acknowledgement and the normal evidence rules still apply. An unavailable wake remains in the durable outbox and needs the runtime watchdog.

Local checks:

```powershell
pnpm exec vitest run apps/voice/src packages/adapters packages/policy
pnpm typecheck
```

Live provider checks are **blocked until credentials/account prerequisites exist**, not counted as passed by these tests. The explicit runner uses a persisted bounded task, current approved artifacts/mandates, the real PostgreSQL dispatcher and real provider adapters. It refuses a real-money mission. Reusing the same task/input preserves the effect key; never change IDs merely to retry an ambiguous provider result.

```powershell
$env:LIVE_SANDBOX = '1'
$env:LIVE_SCOPE_JSON = '{"authUserId":"<founder-auth-uuid>","missionId":"<sandbox-mission-uuid>"}'
$env:LIVE_TASK_ID = '<persisted-task-uuid>'
$env:LIVE_TOOL_NAME = 'place_call'
$env:LIVE_INPUT_FILE = 'C:\absolute\path\approved-call-input.json'
pnpm --filter @lo/voice exec tsx src/sandbox-check.ts
```

Run the same command with `LIVE_TOOL_NAME=send_email`, `send_whatsapp_template`, `fetch_page`, `generate_image`, `store_configure` or `run_test_order`, a role-appropriate persisted task, and the corresponding strict input file. For the PayPal checkout/capture/poll flow use `prepareApprovedPayPalOrder` through the founder command and approve on the real sandbox approval URL; the app return callback and signed webhook invoke policy reconciliation. Confirm the capture/refund IDs in the PayPal sandbox dashboard and retain the provider receipts. Shopify's Admin API test purchase/refund does not claim the separate storefront checkout UI or customer email E2E gate. No real provider call was made merely by starting the local suite.

API references checked during implementation: [OpenAI Realtime WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets?api=realtime), [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations), [Twilio Media Stream messages](https://www.twilio.com/docs/voice/media-streams/websocket-messages), [Twilio request verification](https://www.twilio.com/docs/usage/security), [Twilio Arabic voice/language pairs](https://www.twilio.com/docs/voice/twiml/say/text-speech).

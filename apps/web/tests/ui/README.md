# UI test harness (test only)

The browser suite drives the **real** workspace components against **explicit test fixtures**
(`fixtures/*.fixture.ts`) and an in-memory fake server (`fixtures/fakeServer.fixture.ts`). It is never
part of the app build and is never mounted on an app route.

| File                                                            | Role                                                                                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `harness/Harness.tsx`, `harness/main.tsx`, `harness/index.html` | Mounts `MissionWorkspace` and the public/account surfaces from fixtures, driven by URL parameters                                                            |
| `harness/build.mjs`                                             | Bundles the harness with esbuild into `harness/dist/` (gitignored by `dist/`)                                                                                |
| `harness/serve.mjs`                                             | Builds, then serves only those files on **127.0.0.1:4317** (`UI_HARNESS_PORT`), refusing other hosts                                                         |
| `playwright.config.ts`                                          | Starts the server and runs `*.spec.ts`; Playwright's Chromium by default                                                                                     |
| `workspace.spec.ts`                                             | Scenes × variants (light, dark, RTL at 1440; phone LTR and phone dark RTL at 390) with axe and nested-control checks, the five-second count, and break tests |

## Run

Dependencies (root installs): `@playwright/test`, `esbuild`, `axe-core`, plus a Playwright Chromium.

```
pnpm exec playwright test -c apps/web/tests/ui/playwright.config.ts
```

- `UI_BROWSER_CHANNEL=msedge` (or `chrome`) uses an installed browser instead of Playwright's Chromium.
- `ESBUILD_PATH` / `AXE_PATH` point at other installs if they are not resolvable from the repo.
- `UI_SKIP_BASELINES=1` skips `toHaveScreenshot`. Without it, the first run writes candidates to
  `__screenshots__/`; a person reviews and commits them deliberately. Never auto-accept baselines.
- The harness page is hermetic (no external fonts), so its screenshots use the fallback faces in the
  token stacks; production uses next/font. Compare type fidelity on the real app, not the harness.

## Harness URL parameters

`m=m1|m2|m3`, `theme=dark`, `lang=ar`, `scene=payment|closing|streaming|paused|viewer|mandate`,
`conn=offline`, `peek=none`, `open=<artifactId>|money|readiness|log|notifications|plates|record|accounts`,
`page=login-local|login-both|onboarding|validation|notfound`, `latency=<ms>`, `lag=<ms>`.
The fake server is exposed as `window.__server` (`calls`, `failNext()`), and `window.__setConnection(status)`
switches the connection state.

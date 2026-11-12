import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { perfumeMission } from './fixtures/missions.fixture';

// Independent browser probe of the real controller. Transport responses are deliberately synthetic;
// this does not call the running app, an auth provider, or PostgreSQL.
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = await build({
  stdin: {
    contents: `import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {useMissionController} from './src/lib/useMissionController';
      import {perfumeMission} from './tests/ui/fixtures/missions.fixture';
      function Probe(){const c=useMissionController({initialView:perfumeMission(),initialMissions:[],local:true});
        window.__controller=c;
        return React.createElement('output',{'data-probe':true},JSON.stringify({missionId:c.view.missionId,version:c.view.ledgerVersion,name:c.view.header?.name,connection:c.connection.status}));}
      createRoot(document.getElementById('root')).render(React.createElement(Probe));`,
    resolveDir: root,
    sourcefile: 'review-controller-probe.tsx',
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  define: { 'process.env.NODE_ENV': '"test"' },
});
const probeFile = output.outputFiles[0];
if (!probeFile) throw new Error('Expected the in-memory controller probe bundle');
const probe = probeFile.text;

test.describe('independent snapshot transport boundaries (Quality §5, I-12)', () => {
  test('rejects a plaintext PayPal approval destination before attempting browser navigation', async ({ page }) => {
    const initial = perfumeMission();
    let insecureNavigationAttempts = 0;
    await page.route('http://www.paypal.com/**', async route => {
      insecureNavigationAttempts++;
      await route.abort();
    });
    await page.route('**/review-controller', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
    await page.route('**/api/missions/**', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ view: initial }) }),
    );
    await page.route('**/api/missions', route => route.fulfill({ contentType: 'application/json', body: '{"missions":[]}' }));
    await page.route('**/api/commands', route =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          ledgerVersion: initial.ledgerVersion,
          redirectUrl: 'http://www.paypal.com/checkout?token=private-order',
        }),
      }),
    );
    await page.goto('/review-controller');
    await page.addScriptTag({ content: probe });
    await expect(page.locator('[data-probe]')).toContainText('live');
    const result = await page.evaluate(async () => {
      const c = (window as unknown as { __controller: { commands: { resolveDecision: (input: unknown) => Promise<{ ok: boolean }> } } })
        .__controller;
      return c.commands.resolveDecision({
        missionId: 'm1',
        decisionId: 'd1',
        optionId: 'a',
        response: 'approve',
        seenLedgerVersion: 100,
        idempotencyKey: 'review-probe',
      });
    });
    expect(result.ok).toBe(false);
    expect(insecureNavigationAttempts).toBe(0);
  });

  test('rejects a snapshot for a different mission before replacing the displayed mission', async ({ page }) => {
    const initial = perfumeMission();
    await page.route('**/review-controller', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
    await page.route('**/api/missions/**', route =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ view: { ...initial, missionId: 'unrequested-mission', ledgerVersion: initial.ledgerVersion + 1 } }),
      }),
    );
    await page.goto('/review-controller');
    await page.addScriptTag({ content: probe });
    await expect(page.locator('[data-probe]')).toContainText('reconnecting');
    await expect(page.locator('[data-probe]')).toContainText(`"missionId":"${initial.missionId}"`);
  });

  test('rejects a truncated snapshot and preserves the last complete rendered ledger', async ({ page }) => {
    const initial = perfumeMission();
    await page.route('**/review-controller', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
    await page.route('**/api/missions/**', route =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ view: { missionId: initial.missionId, ledgerVersion: initial.ledgerVersion + 1 } }),
      }),
    );
    await page.goto('/review-controller');
    await page.addScriptTag({ content: probe });
    await expect(page.locator('[data-probe]')).toContainText('reconnecting');
    await expect(page.locator('[data-probe]')).toContainText(`"name":"${initial.header.name}"`);
  });
});

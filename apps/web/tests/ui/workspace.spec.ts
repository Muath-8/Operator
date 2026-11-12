import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * Browser suite for the workspace (Quality Bar 8). Runs against the TEST-ONLY harness served by
 * tests/ui/harness/serve.mjs on 127.0.0.1:4317 (see playwright.config.ts and README.md).
 * Requires: @playwright/test, esbuild, axe-core.
 */
const BASE = process.env.UI_HARNESS_URL ?? 'http://127.0.0.1:4317/';
const url = (q = '') => (q ? `${BASE}${BASE.includes('?') ? '&' : '?'}${q}` : BASE);
const AXE = readFileSync(process.env.AXE_PATH ?? createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

test.use({ reducedMotion: 'reduce' });

async function ready(page: Page, q = '') {
  await page.goto(url(q));
  await page.locator('.strip').waitFor();
  await page.waitForTimeout(300);
}
const calls = (page: Page, name: string) =>
  page.evaluate(
    n => (window as unknown as { __server: { calls: { name: string }[] } }).__server.calls.filter(c => c.name === n).length,
    name,
  );

async function axe(page: Page) {
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async () => {
    const w = window as unknown as {
      axe: { run: (d: Document, o: unknown) => Promise<{ violations: { id: string; nodes: unknown[] }[] }> };
    };
    const r = await w.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return r.violations.map(v => `${v.id} (${v.nodes.length})`);
  });
}

/** The prototype's five-second counter (count.py), plate counted as one artifact. */
const COUNT = `(() => {
  const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    if (!(r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && cs.visibility !== 'hidden')) return false;
    for (let a = el; a && a !== document.body; a = a.parentElement) if (+getComputedStyle(a).opacity < 0.05) return false; return true; };
  const counted = new Set(); let n = 0;
  const add = el => { if ([...counted].some(c => c.contains(el))) return; counted.add(el); n++; };
  document.querySelectorAll('button, input, [tabindex="0"]').forEach(el => { if (vis(el) && !el.classList.contains('tm') && !el.classList.contains('fsel') && !el.classList.contains('cv') && !el.closest('.frame')) add(el); });
  document.querySelectorAll('svg.plate').forEach(el => { if (vis(el) && ![...counted].some(c => c.contains(el)) && !el.closest('.frame')) n++; });
  document.querySelectorAll('.peek .frame').forEach(el => { if (vis(el)) { n++; counted.add(el); } });
  document.querySelectorAll('.tm').forEach(el => { if (vis(el) && !el.closest('.frame') && ![...counted].some(c => c !== el && c.contains(el))) n++; });
  document.querySelectorAll('body *').forEach(el => { if (el.closest('svg') || el.closest('.tip') || el.closest('.pal') || el.closest('.sr') || el.classList.contains('sr') || !vis(el)) return;
    if (![...el.childNodes].some(c => c.nodeType === 3 && c.textContent.trim())) return;
    if ([...counted].some(c => c.contains(el))) return;
    const key = el.closest('p,h1,h3,li,.flabel,.px,.sup,.tag,.working,.props,.dflt,.ctx,.lede') || el;
    if (counted.has(key) || (key.closest('.composer') && key.tagName !== 'INPUT')) return; add(key); });
  return n;
})()`;

test.describe('five-second test', () => {
  test('home at 1440×900 shows at most 25 elements', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ready(page);
    expect(await page.evaluate(COUNT)).toBeLessThanOrEqual(25);
  });
});

const VARIANTS = [
  { name: 'light', q: '', w: 1440, h: 900 },
  { name: 'dark', q: 'theme=dark', w: 1440, h: 900 },
  { name: 'rtl', q: 'lang=ar', w: 1440, h: 900 },
  { name: 'phone', q: '', w: 390, h: 844 },
  { name: 'phone-dark-rtl', q: 'theme=dark&lang=ar', w: 390, h: 844 },
];
const SCENES = [
  '',
  'm=m2',
  'm=m3',
  'scene=payment',
  'scene=closing',
  'scene=paused',
  'scene=viewer',
  'conn=offline',
  'open=brand',
  'open=pack',
  'open=thread',
  'open=spec',
  'open=money',
  'open=readiness',
  'open=log',
  'open=notifications',
  'open=plates',
  'page=login-local',
  'page=login-both',
  'page=onboarding',
  'page=validation',
  'page=notfound',
  'open=accounts',
  'scene=mandate',
  'scene=mandate-nonrec',
  'scene=mandate-zero',
  'scene=payment-shared',
  'scene=kit-incomplete',
  'scene=header',
  'scene=closing&open=record',
];

for (const v of VARIANTS) {
  test.describe(`scenes, ${v.name}`, () => {
    for (const s of SCENES) {
      test(`${s || 'home'}: axe clean, no nested controls, baseline`, async ({ page }) => {
        await page.setViewportSize({ width: v.w, height: v.h });
        await ready(page, [s, v.q].filter(Boolean).join('&'));
        expect(
          await page.evaluate(() => document.querySelectorAll('button button, button a[href], button input, button [tabindex="0"]').length),
        ).toBe(0);
        expect(await axe(page)).toEqual([]);
        // Visual regression: baselines are reviewed deliberately, never auto-accepted (Quality Bar 8).
        if (!process.env.UI_SKIP_BASELINES)
          await expect(page).toHaveScreenshot(`${v.name}-${s || 'home'}.png`.replace(/[=&]/g, '-'), {
            fullPage: false,
            maxDiffPixelRatio: 0.002,
          });
      });
    }
  });
}

test.describe('what to try to break', () => {
  test('double approval while pending makes one call', async ({ page }) => {
    await ready(page, 'latency=900&lag=600');
    await page.keyboard.press('a');
    await page.keyboard.press('a');
    await page
      .locator('.dec .btn.primary')
      .first()
      .click({ force: true })
      .catch(() => undefined);
    await expect(page.locator('.dec .status')).toContainText('Recording your decision');
    expect(await calls(page, 'resolveDecision')).toBe(1);
    await expect(page.locator('.done-line').first()).toContainText('You chose', { timeout: 5000 });
  });

  test('Enter in the palette never resolves a decision', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('Control+k');
    await page.keyboard.type('decision moment');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    expect(await calls(page, 'resolveDecision')).toBe(0);
    await expect(page.locator('#ritual')).toBeVisible();
  });

  test('a failed approval is shown, nothing is faked, and retry reuses the key', async ({ page }) => {
    await ready(page, 'm=m2');
    await page.evaluate(() =>
      (window as unknown as { __server: { failNext: (e: unknown) => void } }).__server.failNext({
        code: 'unavailable',
        message: 'timeout',
        retryable: true,
      }),
    );
    await page.locator('.dec .btn.primary').first().click();
    await expect(page.locator('.dec .status.err')).toBeVisible();
    await expect(page.locator('.dec')).toHaveCount(1);
    await page.locator('.dec .status .btn').click();
    await expect(page.locator('.done-line').first()).toContainText('You chose', { timeout: 5000 });
    const keys = await page.evaluate(() =>
      (window as unknown as { __server: { calls: { name: string; input: { idempotencyKey: string } }[] } }).__server.calls
        .filter(c => c.name === 'resolveDecision')
        .map(c => c.input.idempotencyKey),
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  test('offline keeps the draft and sends nothing; reconnect sends it', async ({ page }) => {
    await ready(page);
    await page.evaluate(() => (window as unknown as { __setConnection: (s: string) => void }).__setConnection('offline'));
    await expect(page.locator('.banner[role="alert"]')).toBeVisible();
    await page.locator('[data-composer]').fill('Please hold the price for a week');
    await page.keyboard.press('Enter');
    await expect(page.locator('.cnote.err')).toBeVisible();
    await expect(page.locator('[data-composer]')).toHaveValue('Please hold the price for a week');
    expect(await calls(page, 'sendMessage')).toBe(0);
    await page.evaluate(() => (window as unknown as { __setConnection: (s: string) => void }).__setConnection('live'));
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-composer]')).toHaveValue('', { timeout: 5000 });
  });

  test('go back shows impact first, then supersedes with a forward link', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('a');
    await expect(page.locator('.done-line').first()).toContainText('You chose', { timeout: 5000 });
    await page.locator('.done-line .btn', { hasText: 'Change this' }).first().click();
    await expect(page.locator('.impact')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.impact')).toContainText('Also affected');
    await page.locator('.impact .btn.primary').click();
    await expect(page.locator('.done-line.superseded')).toContainText('reopened below', { timeout: 5000 });
  });

  test('the dial on Do it for me sends the held draft under the mandate', async ({ page }) => {
    await ready(page, 'open=thread');
    await page.locator('.thead [role="radio"]', { hasText: 'Do it for me' }).click();
    await expect(page.locator('.strip .meter').first()).toContainText('12/15', { timeout: 5000 });
  });

  test('phone: the sheet and the palette trap focus and restore it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await ready(page);
    await page.locator('.embed').first().focus();
    await page.keyboard.press('Enter');
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('.peek'))).toBe(true);
    }
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('embed'))).toBe(true);
    await page.locator('.strip .mbtn').click();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.pal'))).toBe(true);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('mbtn'))).toBe(true);
  });

  for (const [lang, word] of [
    ['en', 'Delete this'],
    ['ar', 'احذف'],
  ] as const) {
    test(`deletion (${lang}) lists what stays, needs both confirmations, and never claims success on failure`, async ({ page }) => {
      await ready(page, `lang=${lang}`);
      await page.locator('[data-composer]').focus();
      await page.keyboard.press('Control+k');
      await page.keyboard.type(word);
      await page.keyboard.press('Enter');
      await expect(page.locator('.dlg .keep').first()).toBeVisible();
      await expect(page.locator('.dlg .btn.primary')).toHaveAttribute('aria-disabled', 'true');
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => !!document.activeElement?.closest('.dlg'))).toBe(true);
      }
      await page.locator('.dlg .check input').nth(0).check();
      await page.locator('.dlg .check input').nth(1).check();
      await page.locator('.dlg .btn.primary').click();
      await expect(page.locator('.dlg .cnote.err')).toContainText(lang === 'en' ? 'Deletion has not completed' : 'لم يكتمل الحذف');
      await expect(page.locator('.dlg .cnote.err')).not.toContainText(lang === 'en' ? 'mission is paused' : 'المهمة موقوفة');
      await expect(page.locator('.dlg .keep').first()).toBeVisible();
      await page.keyboard.press('Escape');
      expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-composer'))).toBe(true);
    });
  }

  test('validation form: consent starts unchecked; missing consent keeps the email and sends nothing', async ({ page }) => {
    await page.goto(url('page=validation'));
    const consent = page.locator('input[name="consent"]');
    await expect(consent).not.toBeChecked();
    await page.locator('input[name="email"]').fill('someone@example.test');
    let posted = false;
    page.on('request', r => {
      if (r.method() === 'POST') posted = true;
    });
    await page.locator('.pub-form .btn.primary').click();
    await expect(page.locator('.pub-form .cnote.err')).toBeVisible();
    await expect(page.locator('input[name="email"]')).toHaveValue('someone@example.test');
    expect(posted).toBe(false);
    await expect(page.locator('.pub-done')).toHaveCount(0);
  });

  test('accounts: a passed check is never called verified; unverified reads pending; a failed revoke keeps access', async ({ page }) => {
    await ready(page, 'open=accounts');
    const accounts = page.getByRole('list', { name: 'Accounts', exact: true });
    const rows = accounts.locator('.acct');
    await expect(rows).toHaveCount(3);
    await expect(accounts).not.toContainText(/\bverified\b/i);
    await expect(rows.nth(0).locator('.acct-st')).toContainText('account check passed');
    await expect(rows.nth(1).locator('.acct-st')).toHaveText('Verification pending');
    await expect(rows.nth(2).locator('.acct-st')).toHaveText('access revoked');
    await expect(rows.nth(2).locator('.btn')).toHaveCount(0);
    await rows.nth(1).locator('.btn', { hasText: 'Revoke my access' }).click();
    await rows.nth(1).locator('.btn', { hasText: 'Revoke access to PayPal' }).click();
    await expect(rows.nth(1).locator('.cnote.err')).toContainText('Access was not revoked');
    await expect(rows.nth(1).locator('.acct-st')).toHaveText('Verification pending');
    await expect(page.locator('input[type="password"], input[name*="key" i], input[name*="secret" i]')).toHaveCount(0);
  });

  test('accounts: Shopify connect needs a store address and ownership attestation before any request', async ({ page }) => {
    await ready(page, 'open=accounts');
    let posted = false;
    page.on('request', r => {
      if (r.method() === 'POST') posted = true;
    });
    await page.locator('.shop .btn').click();
    await expect(page.locator('.shop .cnote.err')).toBeVisible();
    await page.locator('.shop input').first().fill('not a store');
    await page.locator('.shop .btn').click();
    await expect(page.locator('.shop .cnote.err')).toBeVisible();
    expect(posted).toBe(false);
  });

  test('mandate scope: the editor belongs to the recommended option only and cannot widen', async ({ page }) => {
    await ready(page, 'scene=mandate');
    await expect(page.locator('.scope')).toBeVisible();
    await page.locator('.dec .btn', { hasText: /See all/ }).click();
    await page.locator('.opt').nth(1).click();
    await expect(page.locator('.scope')).toHaveCount(0);
    await page.locator('.opt').nth(0).click();
    await page.locator('.scope input').first().fill('2600');
    await expect(page.locator('.scope-err')).toBeVisible();
    await expect(page.locator('.dec .btn.primary')).toHaveAttribute('aria-disabled', 'true');
  });

  const resolveInputs = (page: Page) =>
    page.evaluate(() =>
      (
        window as unknown as {
          __server: { calls: { name: string; input: { optionId: string; mandateScope?: { ceiling: { amountMinor: number } } } }[] };
        }
      ).__server.calls
        .filter(c => c.name === 'resolveDecision')
        .map(c => c.input),
    );

  test('WEB-05: a mandate owned by a non-recommended option is shown and sent only with that option', async ({ page }) => {
    await ready(page, 'scene=mandate-nonrec');
    await expect(page.locator('.scope')).toHaveCount(0);
    await page.locator('.dec .btn', { hasText: /See all/ }).click();
    await page.locator('.opt').nth(1).click();
    await expect(page.locator('.scope')).toBeVisible();
    await expect(page.locator('.scope input').first()).toHaveValue('1200');
    await page.locator('.dec .btn.primary').click();
    await expect.poll(async () => (await resolveInputs(page)).length).toBe(1);
    const [input] = await resolveInputs(page);
    expect(input?.optionId).toBe('tight');
    expect(input?.mandateScope?.ceiling.amountMinor).toBe(120000);
  });

  test("WEB-05: the recommended option does not carry another option's mandate", async ({ page }) => {
    await ready(page, 'scene=mandate-nonrec');
    await page.locator('.dec .btn.primary').click();
    await expect.poll(async () => (await resolveInputs(page)).length).toBe(1);
    const [input] = await resolveInputs(page);
    expect(input?.optionId).toBe('grant');
    expect(input?.mandateScope).toBeUndefined();
  });

  test('WEB-05: one payment version shared by two options shows on both; long FX lines wrap inside the card', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await ready(page, 'scene=payment-shared&lang=ar');
    await expect(page.locator('.pay')).toBeVisible();
    await page.locator('.dec .btn', { hasText: /\(2\)|See all/ }).click();
    await page.locator('.opt').nth(1).click();
    await expect(page.locator('.pay')).toBeVisible();
    await expect(page.locator('.dec .btn.primary')).toContainText('Approve on PayPal');
    const overflow = await page.locator('.pay').evaluate(el => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('WEB-04: a frozen zero-money mandate shows no money field and is granted with a zero ceiling', async ({ page }) => {
    await ready(page, 'scene=mandate-zero');
    await expect(page.locator('.scope-fixed')).toContainText('No spending');
    await expect(page.locator('.scope input[inputmode="decimal"]')).toHaveCount(0);
    await expect(page.locator('.dec .btn.primary')).not.toHaveAttribute('aria-disabled', 'true');
    await page.locator('.dec .btn.primary').click();
    await expect.poll(async () => (await resolveInputs(page)).length).toBe(1);
    expect((await resolveInputs(page))[0]?.mandateScope?.ceiling.amountMinor).toBe(0);
  });

  test('an incomplete kit is never presented as a task', async ({ page }) => {
    await ready(page, 'scene=kit-incomplete');
    await expect(page.locator('.kit.incomplete')).toContainText('isn’t ready');
    await expect(page.locator('.kit.incomplete dl')).toHaveCount(0);
  });

  test('WEB-02: a refused sign-out keeps the workspace, says so, and offers retry', async ({ page }) => {
    await ready(page, 'signout=fail');
    await page.locator('[data-composer]').focus();
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Sign out');
    await page.keyboard.press('Enter');
    await expect(page.locator('.banner.signout[role="alert"]')).toContainText('still signed in');
    await expect(page.locator('.strip')).toBeVisible();
    expect(new URL(page.url()).pathname).not.toContain('login');
    await expect(page.locator('.banner.signout .btn', { hasText: 'Retry' })).toBeVisible();
  });

  test('decision moments per week: saved through the server, kept when another setting changes', async ({ page }) => {
    await ready(page, 'open=notifications');
    const moments = page.getByLabel('Decision moments');
    await expect(moments).toHaveValue('3');
    await expect(moments.locator('option')).toHaveCount(7);
    await moments.selectOption('5');
    await expect(moments).toHaveValue('5', { timeout: 5000 });
    await page.getByLabel('Digest cadence').selectOption('weekly');
    await expect(page.getByLabel('Digest cadence')).toHaveValue('weekly', { timeout: 5000 });
    await expect(moments).toHaveValue('5');
    const sent = await page.evaluate(() =>
      (
        window as unknown as {
          __server: { calls: { name: string; input: { settings: { momentsPerWeek?: number; digestCadence: string } } }[] };
        }
      ).__server.calls
        .filter(c => c.name === 'updateNotificationSettings')
        .map(c => c.input.settings),
    );
    expect(sent).toEqual([
      expect.objectContaining({ momentsPerWeek: 5 }),
      expect.objectContaining({ momentsPerWeek: 5, digestCadence: 'weekly' }),
    ]);
  });

  test('header: active time carries its trust glyph; guidance says not yet reviewed and discloses sources', async ({ page }) => {
    await ready(page, 'scene=header');
    const meta = page.locator('.props-sub');
    await expect(meta).toContainText('Your active time');
    await expect(meta.locator('.fig .tm')).toHaveCount(1);
    const toggle = meta.locator('.toggle.know');
    await expect(toggle).toContainText('not yet reviewed');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(page.locator('#knowledge-body')).toContainText('Nobody has reviewed it');
    await expect(page.locator('#knowledge-body li')).toHaveCount(2);
  });

  test('a kit with an unknown estimate shows no minutes, and keeps its four parts', async ({ page }) => {
    await ready(page, 'scene=header');
    const kit = page.locator('.kit').first();
    await expect(kit).toBeVisible();
    await expect(kit.locator('h3 small')).not.toContainText(/minute/);
    await expect(kit.locator('dt')).toHaveCount(4);
  });

  test('closing record offers the asset package and explains it; export failure is shown', async ({ page }) => {
    await ready(page, 'scene=closing');
    const closing = page.locator('.closing');
    await expect(closing.locator('.btn.primary')).toContainText('Everything, with images (ZIP)');
    await expect(closing).toContainText('checksum');
    await page.evaluate(() =>
      (window as unknown as { __server: { failNext: (e: unknown) => void } }).__server.failNext({
        code: 'unavailable',
        message: 'export store busy',
        retryable: true,
      }),
    );
    await closing.locator('.btn.primary').click();
    await expect(closing.locator('.cnote.err')).toContainText('export store busy');
  });

  test('completed agent text is never typed out word by word', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await ready(page);
    await page.locator('[data-composer]').fill('What are you waiting on?');
    await page.keyboard.press('Enter');
    await expect(page.locator('.entry').last()).toContainText('waiting on', { timeout: 5000 });
    expect(await page.locator('.w').count()).toBe(0);
    expect(await page.locator('.entry:not([aria-busy]) .caret').count()).toBe(0);
  });

  test('RTL mirrors the peek and keeps plates left to right', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ready(page, 'lang=ar');
    const box = await page.locator('.peek').boundingBox();
    expect(box?.x ?? 999).toBeLessThan(50);
    expect(
      await page
        .locator('svg.plate')
        .first()
        .evaluate(el => getComputedStyle(el).direction),
    ).toBe('ltr');
  });

  test('reduced motion: no running animations after load', async ({ page }) => {
    await ready(page);
    const running = await page.evaluate(
      () =>
        document.getAnimations().filter(a => a.playState === 'running' && (a.effect?.getComputedTiming().duration as number) > 50).length,
    );
    expect(running).toBe(0);
  });

  test('keyboard focus on a canvas frame is visible on the frame', async ({ page }) => {
    await ready(page, 'open=brand');
    await page.locator('.peek .cv').focus();
    let onFrame = false;
    for (let i = 0; i < 12 && !onFrame; i++) {
      await page.keyboard.press('Tab');
      onFrame = await page.evaluate(() => !!document.activeElement?.classList.contains('fsel'));
    }
    expect(onFrame).toBe(true);
    const ring = await page.evaluate(() => getComputedStyle(document.activeElement?.closest('.frame') as Element).boxShadow);
    expect(ring).toMatch(/rgb/);
  });

  test('canvas frames are placed before they are shown, and never overlap', async ({ page }) => {
    await ready(page, 'open=pack');
    await expect(page.locator('.world.pending')).toHaveCount(0);
    const rects = await page
      .locator('.peek .frame')
      .evaluateAll(els => els.map(e => e.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number }));
    expect(rects.length).toBeGreaterThan(1);
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const [a, b] = [rects[i], rects[j]];
        if (!a || !b) continue;
        const overlap = a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
        expect(overlap, `frames ${i} and ${j} overlap`).toBe(false);
      }
  });

  test('a first connection is announced only when slow; reconnecting is announced at once', async ({ page }) => {
    await ready(page, 'conn=connecting');
    await expect(page.locator('.banners')).not.toContainText('Connecting to the mission');
    await expect(page.locator('.banners')).toContainText('Connecting to the mission', { timeout: 5000 });
    await page.evaluate(() => (window as unknown as { __setConnection: (s: string) => void }).__setConnection('live'));
    await expect(page.locator('.banners')).not.toContainText('Connecting');
    await page.evaluate(() => (window as unknown as { __setConnection: (s: string) => void }).__setConnection('reconnecting'));
    await expect(page.locator('.banners')).toContainText('Reconnecting', { timeout: 500 });
  });

  test('sign-out from the palette sees a connection lost after load, and sends nothing', async ({ page }) => {
    await ready(page);
    await page.evaluate(() => (window as unknown as { __setConnection: (s: string) => void }).__setConnection('offline'));
    await page.locator('[data-composer]').focus();
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Sign out');
    await page.keyboard.press('Enter');
    await expect(page.locator('.banner.signout[role="alert"]')).toContainText('offline');
    expect(new URL(page.url()).pathname).not.toContain('login');
  });
});

import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
try {
  const login = await context.request.post('http://127.0.0.1:3000/api/session/local', { headers: { Origin: 'http://127.0.0.1:3000' } });
  if (!login.ok()) throw new Error(`Local authentication failed: ${login.status()}`);
  await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded' });
  // The application keeps an event stream open, so network idle is not readiness.
  await page.locator('#mission-title').waitFor();
  const missionId = '20000000-0000-4000-8000-000000000001';
  const privacy = await context.request.get(`http://127.0.0.1:3000/api/missions/${missionId}/privacy`);
  if (!privacy.ok()) throw Error(`Privacy endpoint failed: ${privacy.status()}`);
  const archive = await context.request.get(`http://127.0.0.1:3000/api/missions/${missionId}/archive`);
  if (!archive.ok()) throw Error(`Archive endpoint failed: ${archive.status()}`);
  const records = (await archive.text())
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { kind: string });
  if (records.at(-1)?.kind !== 'complete') throw Error('Actual local archive is incomplete');

  await mkdir('.local/screenshots', { recursive: true });
  await page.screenshot({ path: '.local/screenshots/actual-home-light-en-1440.png', fullPage: true });
  console.log(
    JSON.stringify({
      url: page.url(),
      title: await page.title(),
      headings: await page.locator('h1,h2,h3').allTextContents(),
      visibleText: (await page.locator('body').innerText()).slice(0, 1800),
      archiveRecords: records.length,
      privacyStatus: privacy.status(),
      errors,
    }),
  );
  if (errors.length) throw new Error('Browser errors detected');
} finally {
  await browser.close();
}

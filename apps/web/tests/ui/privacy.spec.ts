import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
for (const width of [1440, 390])
  for (const theme of ['light', 'dark'])
    for (const lang of ['en', 'ar']) {
      test(`privacy controls ${width} ${theme} ${lang}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 960 });
        await page.goto(`/?open=accounts&peek=none&theme=${theme}&lang=${lang}&latency=10&lag=10`);
        const trace = page.getByRole('checkbox', {
          name: lang === 'en' ? 'Allow trace retention and external trace export' : 'السماح بالاحتفاظ بسجلات التتبّع وتصديرها خارجياً',
        });
        await expect(trace).toBeChecked();
        await trace.focus();
        await page.keyboard.press('Space');
        await expect(trace).not.toBeChecked();
        const keep = page.getByRole('button', { name: lang === 'en' ? 'Keep this content' : 'الاحتفاظ بهذا المحتوى', exact: true });
        await keep.click();
        await expect(
          page.getByRole('button', { name: lang === 'en' ? 'Stop keeping this content' : 'إيقاف الاحتفاظ بهذا المحتوى', exact: true }),
        ).toBeVisible();
        const archive = page.getByRole('link', { name: lang === 'en' ? 'Download full mission archive' : 'تنزيل أرشيف المهمة الكامل' });
        await expect(archive).toHaveAttribute('href', '/api/missions/m1/archive');
        await expect(archive).toHaveAttribute('download', 'mission-m1.ndjson');
        await archive.focus();
        await expect(archive).toBeFocused();
        await expect(page.locator('html')).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
        await page.addScriptTag({ content: axeSource });
        const violations = await page.evaluate(async () => {
          const a = (window as unknown as { axe: { run: (node: Document, options: unknown) => Promise<{ violations: { id: string }[] }> } })
            .axe;
          return (await a.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.map(
            v => v.id,
          );
        });
        expect(violations).toEqual([]);
        await page.screenshot({ path: `apps/web/tests/ui/.local/privacy-${width}-${theme}-${lang}.png`, fullPage: true });
      });
    }

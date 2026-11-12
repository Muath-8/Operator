import { test, expect } from '@playwright/test';
test.describe('independent browser interpretation of screened copy', () => {
  for (const [name, copy] of [
    ['uppercase hexadecimal entity', 'cur&#X65;s disease'],
    ['semicolonless decimal entity', 'cur&#101s disease'],
    ['encoded compatibility characters', '&#xff43;&#xff55;&#xff52;&#xff45;&#xff53; disease'],
    ['nonvisible script contents', 'cures<script>void 0</script> disease'],
    ['hidden attribute contents', 'cures<span hidden>unseen padding</span> disease'],
    ['nonvisible inline style contents', 'cures<span style="display:none">unseen padding</span> disease'],
  ] as const)
    test(name, async ({ page }) => {
      await page.setContent(`<main>${copy}</main>`);
      const visible = await page.locator('main').innerText();
      expect(visible.normalize('NFKC')).toBe('cures disease');
    });
  test('word joiners and soft hyphens add no visible width inside the prohibited phrase', async ({ page }) => {
    await page.setContent('<main></main>');
    const widths = await page.evaluate(() => {
      const canvas = document.createElement('canvas'),
        context = canvas.getContext('2d');
      if (!context) throw new Error('Expected browser text renderer');
      context.font = '16px Arial';
      return ['cures disease', 'cur\u2060es disease', 'cu\u00adres disease'].map(text => context.measureText(text).width);
    });
    expect(widths[1]).toBe(widths[0]);
    expect(widths[2]).toBe(widths[0]);
  });
});

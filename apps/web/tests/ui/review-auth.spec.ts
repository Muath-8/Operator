import { expect, test } from '@playwright/test';

// Real SignIn component, explicit test harness; this proves no hosted identity-provider behavior.
test.describe('independent sign-in secret review (I-11)', () => {
  for (const [name, fragment] of [
    ['refresh only', 'refresh_token=review-private-refresh'],
    ['oversized access', `access_token=${'x'.repeat(10001)}&refresh_token=review-private-refresh`],
    ['encoded refresh key', 'refresh%5Ftoken=review-private-refresh'],
  ]) {
    test(`${name}: callback removes secrets from the URL even when it cannot sign in`, async ({ page }) => {
      let requests = 0;
      await page.route('**/api/session', async route => {
        requests++;
        await route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false}' });
      });
      await page.goto(`/?page=login-both#${fragment}`);
      await expect(page.locator('.pub-form')).toBeVisible();
      await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
      expect(requests).toBe(0);
    });
  }

  test('valid callback clears its fragment before sending either token to the session endpoint', async ({ page }) => {
    let fragmentAtExchange = 'not called';
    let body: unknown;
    await page.route('**/api/session', async route => {
      fragmentAtExchange = await page.evaluate(() => location.hash);
      body = route.request().postDataJSON();
      await route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false}' });
    });
    await page.goto('/?page=login-both#access_token=review-access&refresh_token=review-refresh');
    await expect(page.getByRole('alert')).toBeVisible();
    expect(fragmentAtExchange).toBe('');
    expect(body).toEqual({ token: 'review-access', refreshToken: 'review-refresh' });
    const persisted = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(persisted).not.toMatch(/review-access|review-refresh/);
  });
});

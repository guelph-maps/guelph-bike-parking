const { test, expect } = require('@playwright/test');

test('keeps the single page heading outside the application map', async ({ page }) => {
  await page.goto('/?legend=closed');

  const heading = page.locator('#bp-title h1');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(heading).toHaveText('Guelph Bike Parking');
  expect(await heading.evaluate(el => el.closest('#map'))).toBeNull();
  await expect(page.locator('#bp-title .bp-about-btn')).toBeVisible();
});

test('removes the heading in embed mode', async ({ page }) => {
  await page.goto('/?embed=1&legend=closed');

  await expect(page.locator('h1')).toHaveCount(0);
  await expect(page.locator('#bp-title a')).toHaveText(/Guelph bike parking/);
});

test('adds the beta badge on the beta host', async ({ page }) => {
  await page.route('http://beta.guelph.bike:4173/**', route => route.continue({
    url: route.request().url().replace('http://beta.guelph.bike:4173', 'http://127.0.0.1:4173')
  }));
  await page.goto('http://beta.guelph.bike:4173/?legend=closed');

  await expect(page.locator('#bp-title .bp-beta')).toHaveText('Beta');
});

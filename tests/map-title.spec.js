const { test, expect } = require('@playwright/test');

test('keeps the single page heading outside the application map', async ({ page }) => {
  await page.goto('/?legend=closed');

  const heading = page.locator('#bp-title h1');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(heading).toHaveText('Guelph Bike Parking');
  expect(await heading.evaluate(el => el.closest('#map'))).toBeNull();
  await expect(page.locator('#bp-title .bp-about-btn')).toBeVisible();
});

test('keeps the mobile key above the title and search unless the menu is open', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/?legend=closed');

  async function expectAbove(selector, underneath) {
    await expect.poll(() => page.locator(selector).evaluate((el, underneath) => {
      const rect = el.getBoundingClientRect();
      const below = document.querySelector(underneath).getBoundingClientRect();
      const left = Math.max(rect.left, below.left);
      const right = Math.min(rect.right, below.right);
      const top = Math.max(rect.top, below.top);
      const bottom = Math.min(rect.bottom, below.bottom);
      return left < right && top < bottom &&
        el.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2));
    }, underneath)).toBe(true);
  }

  await page.locator('.bp-legend-toggle').click();
  await expectAbove('.bp-legend', '#bp-title');
  await expectAbove('.bp-legend', '.bp-search');

  const more = page.getByRole('button', { name: 'More', exact: true });
  await more.focus();
  await more.press('Enter');
  await expect(page.locator('.bp-menu')).toBeVisible();
  await expectAbove('.bp-menu', '.bp-legend');
  await expectAbove('.bp-menu', '.bp-search');

  await page.keyboard.press('Escape');
  await expect(page.locator('.bp-menu')).toBeHidden();
  await expectAbove('.bp-legend', '#bp-title');
  await expectAbove('.bp-legend', '.bp-search');
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

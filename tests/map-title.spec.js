const { test, expect } = require('@playwright/test');

test('keeps the single page heading outside the application map', async ({ page }) => {
  await page.goto('/index.html?legend=closed');

  const heading = page.locator('#bp-title h1');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(heading).toHaveText('Guelph Bike Parking');
  expect(await heading.evaluate(el => el.closest('#map'))).toBeNull();
  await expect(page.locator('#bp-title .bp-about-btn')).toBeVisible();
});

test('opens the static About dialog from the title and keyboard button', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/index.html?legend=closed&lat=43.5448&lng=-80.2482&zoom=13');
  await expect(page.locator('.bp-marker, .bp-cluster').first()).toBeVisible();

  await page.locator('#bp-title h1').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.bp-about-count')).toHaveText(/\d[\d,]* locations and \d[\d,]* counted spaces/);
  const addLink = new URL(await dialog.locator('.bp-about-add').getAttribute('href'));
  const coordinates = addLink.hash.replace('#map=17/', '').split('/').map(Number);
  expect(addLink.origin).toBe('https://www.openstreetmap.org');
  expect(coordinates[0]).toBeCloseTo(43.5448, 3);
  expect(coordinates[1]).toBeCloseTo(-80.2482, 3);
  await expect(dialog.locator('.bp-release-line')).toContainText(/Version unknown|Development copy/);
  await expect(dialog.getByRole('button', { name: 'Clear cache & reload' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  const button = page.getByRole('button', { name: 'About this map', exact: true });
  await button.focus();
  await button.press('Enter');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});

test('keeps release notifications and update actions in the static About dialog', async ({ page }) => {
  await page.addInitScript(() => {
    let build = 'v1';
    const serviceWorker = new EventTarget();
    serviceWorker.controller = {
      postMessage(message, ports) {
        ports[0].postMessage({ build, date: '2026-11-17' });
      }
    };
    serviceWorker.register = async () => ({
      update: async () => {},
      unregister: async () => true
    });
    Object.defineProperty(navigator, 'serviceWorker', { value: serviceWorker });
    window.testNewRelease = () => {
      build = 'v2';
      serviceWorker.dispatchEvent(new Event('controllerchange'));
    };
  });
  await page.goto('/index.html?legend=closed');
  await page.locator('#bp-title h1').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.bp-release-line')).toContainText('Version v1');
  await page.evaluate(() => window.testNewRelease());
  await expect(dialog.locator('.bp-release-new')).toContainText('Version v2 is ready.');
  await expect(page.locator('.bp-about-dot')).toBeVisible();

  await Promise.all([
    page.waitForEvent('load'),
    dialog.getByRole('button', { name: 'Update now' }).click()
  ]);
  await page.locator('#bp-title h1').click();
  await expect(dialog).toBeVisible();
  await page.evaluate(async () => {
    const cache = await caches.open('data-v-test');
    await cache.put('/test-entry', new Response('cached'));
  });
  await Promise.all([
    page.waitForEvent('load'),
    dialog.getByRole('button', { name: 'Clear cache & reload' }).click()
  ]);
  expect(await page.evaluate(() => caches.keys())).not.toContain('data-v-test');
});

for (const [build, label, links] of [
  ['0.1.3-dev.abc1234', 'Version 0.1.3-dev (abc1234)', { abc1234: '/commit/abc1234' }],
  ['0.1.3-dev.abc1234.pr31', 'Version 0.1.3-dev (abc1234, #31)', { abc1234: '/commit/abc1234', '#31': '/pull/31' }]
]) {
  test(`links the commit${links['#31'] ? ' and pull request' : ''} of beta build ${build}`, async ({ page }) => {
    await page.addInitScript(build => {
      const serviceWorker = new EventTarget();
      serviceWorker.controller = {
        postMessage(message, ports) { ports[0].postMessage({ build, date: '2026-11-27' }); }
      };
      serviceWorker.register = async () => ({ update: async () => {}, unregister: async () => true });
      Object.defineProperty(navigator, 'serviceWorker', { value: serviceWorker });
    }, build);
    await page.goto('/index.html?legend=closed');
    await page.locator('#bp-title h1').click();
    const line = page.getByRole('dialog').locator('.bp-release-line');
    await expect(line).toContainText(`${label}, updated`);
    await expect(line.getByRole('link')).toHaveCount(Object.keys(links).length);
    for (const [text, path] of Object.entries(links)) {
      await expect(line.getByRole('link', { name: text, exact: true }))
        .toHaveAttribute('href', `https://github.com/guelph-maps/guelph-bike-parking${path}`);
    }
  });
}

test('keeps the mobile key above the title and search', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/index.html?legend=closed');

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
});

test('removes the heading in embed mode', async ({ page }) => {
  await page.goto('/index.html?embed=1&legend=closed');

  await expect(page.locator('h1')).toHaveCount(0);
  await expect(page.locator('#bp-title a')).toHaveText(/Guelph bike parking/);
  await page.locator('.bp-legend-toggle').click();
  await page.getByRole('link', { name: 'About & corrections' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Embed this map' })).toHaveCount(0);
});

test('adds the beta badge on the beta host', async ({ page }) => {
  await page.route('http://beta.guelph.bike:4173/**', route => route.continue({
    url: route.request().url().replace('http://beta.guelph.bike:4173', 'http://127.0.0.1:4173')
  }));
  await page.goto('http://beta.guelph.bike:4173/index.html?legend=closed');

  await expect(page.locator('#bp-title > .bp-beta')).toHaveText('Beta');
});

for (const hasHeading of [true, false]) {
  for (const embed of [false, true]) {
    test(`loads old HTML ${hasHeading ? 'with' : 'without'} a heading in ${embed ? 'embed' : 'standalone'} mode`, async ({ page }) => {
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/index.html?*', async route => {
        if (!route.request().isNavigationRequest()) return route.continue();
        const response = await route.fetch();
        const html = (await response.text()).replace(
          /  <div class="leaflet-top leaflet-left bp-title-position">[\s\S]*?(?=  <div id="map")/,
          hasHeading ? '  <h1>Guelph Bike Parking</h1>\n' : ''
        );
        expect(html).not.toContain('id="bp-title"');
        await route.fulfill({ response, body: html });
      });
      await page.goto(`/index.html?legend=closed${embed ? '&embed=1' : ''}`);

      await expect(page.locator('.bp-marker, .bp-cluster').first()).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Search address or place' })).toBeVisible();
      expect(await page.locator('.bp-search').evaluate(el => el.closest('#map'))).toBeNull();
      await expect(page.locator('h1')).toHaveCount(embed ? 0 : 1);
      if (embed) {
        await expect(page.locator('#bp-title a')).toHaveText(/Guelph bike parking/);
      } else {
        await expect(page.locator('#bp-title h1')).toHaveText('Guelph Bike Parking');
        expect(await page.locator('h1').evaluate(el => el.closest('#map'))).toBeNull();
        await page.getByRole('button', { name: 'About this map', exact: true }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
      }
      expect(errors).toEqual([]);
    });
  }
}

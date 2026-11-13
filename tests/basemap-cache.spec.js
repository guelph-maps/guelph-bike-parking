const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.archiveFetchModes = [];
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/archive.pmtiles')) {
        window.archiveFetchModes.push(init && init.cache);
      }
      return fetch(input, init);
    };
  });

  await page.route('**/tiles/tiles.json', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      url: '/archive.pmtiles',
      bytes: 7,
      date: '2026-11-11'
    })
  }));
  await page.goto('/tests/fixtures/basemap-cache.html');
});

test('streams PMTiles ranges with no-store in WebKit', async ({ page }) => {
  await page.route('**/archive.pmtiles', route => route.fulfill({
    status: 206,
    headers: {
      'Content-Range': 'bytes 0-3/7',
      'Content-Length': '4'
    },
    body: Buffer.from([1, 2, 3, 4])
  }));

  const bytes = await page.evaluate(async () => {
    await window.BikeBasemap.start({ autoSave: false });
    const source = await window.BikeBasemap.ready;
    const response = await source.getBytes(0, 4);
    return Array.from(new Uint8Array(response.data));
  });

  expect(bytes).toEqual([1, 2, 3, 4]);
  expect(await page.evaluate(() => window.archiveFetchModes)).toEqual(['no-store']);
});

test('downloads the offline copy with no-store in WebKit', async ({ page }) => {
  await page.route('**/archive.pmtiles', route => route.fulfill({
    contentType: 'application/octet-stream',
    body: 'archive'
  }));

  const state = await page.evaluate(async () => {
    await window.BikeBasemap.start({ autoSave: true });
    const cache = await caches.open('basemap-v1');
    return {
      status: window.BikeBasemap.state().status,
      cachedCopies: (await cache.keys()).length
    };
  });

  expect(state).toEqual({ status: 'saved', cachedCopies: 1 });
  expect(await page.evaluate(() => window.archiveFetchModes)).toEqual(['no-store']);
});

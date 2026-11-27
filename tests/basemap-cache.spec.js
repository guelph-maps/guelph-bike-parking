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

test('replaces an outdated offline copy in WebKit', async ({ page }) => {
  await page.route('**/archive.pmtiles', route => route.fulfill({
    contentType: 'application/octet-stream',
    body: 'archive'
  }));

  const state = await page.evaluate(async () => {
    const cache = await caches.open('basemap-v1');
    await cache.put('/old.pmtiles', new Response('old'));
    await window.BikeBasemap.start({ autoSave: true });
    return {
      status: window.BikeBasemap.state().status,
      savedCopies: (await cache.keys()).map(k => new URL(k.url).pathname)
    };
  });

  expect(state).toEqual({ status: 'saved', savedCopies: ['/archive.pmtiles'] });
  expect(await page.evaluate(() => window.archiveFetchModes)).toEqual(['no-store']);
});

// tiles.json above says 2026-11-11. A new file is built every week, so a saved
// copy is only replaced by itself once it's 30 days behind, or on Wi-Fi.
async function startWithSavedCopy(page, savedDate, connection) {
  await page.route('**/archive.pmtiles', route => route.fulfill({
    contentType: 'application/octet-stream',
    body: 'archive'
  }));
  return page.evaluate(async ([savedDate, connection]) => {
    if (connection) Object.defineProperty(navigator, 'connection', { value: connection, configurable: true });
    const cache = await caches.open('basemap-v1');
    await cache.put('/old.pmtiles', new Response('old', { headers: { 'X-Map-Date': savedDate } }));
    await window.BikeBasemap.start({ autoSave: true });
    return {
      status: window.BikeBasemap.state().status,
      savedCopies: (await cache.keys()).map(k => new URL(k.url).pathname)
    };
  }, [savedDate, connection]);
}

test('keeps a saved copy that is less than a month behind', async ({ page }) => {
  const state = await startWithSavedCopy(page, '2026-11-04');
  expect(state).toEqual({ status: 'outdated', savedCopies: ['/old.pmtiles'] });
  expect(await page.evaluate(() => window.archiveFetchModes)).toEqual([]);
});

test('replaces a saved copy that is a month behind', async ({ page }) => {
  const state = await startWithSavedCopy(page, '2026-10-11');
  expect(state).toEqual({ status: 'saved', savedCopies: ['/archive.pmtiles'] });
});

test('replaces a saved copy that is newer than the site', async ({ page }) => {
  const state = await startWithSavedCopy(page, '2026-11-18');
  expect(state).toEqual({ status: 'saved', savedCopies: ['/archive.pmtiles'] });
});

test('replaces a recent saved copy on Wi-Fi', async ({ page }) => {
  const state = await startWithSavedCopy(page, '2026-11-04', { type: 'wifi' });
  expect(state).toEqual({ status: 'saved', savedCopies: ['/archive.pmtiles'] });
});

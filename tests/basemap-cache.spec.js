const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// The app's own saved-map cache: 'basemap-v1' for map format 1, 'basemap-v1-mN' from 2
// (js/basemap.js), so these tests pass whichever format the branch reads.
const FORMATS_JS = fs.readFileSync(path.join(__dirname, '..', 'js', 'formats.js'), 'utf8');
const MAP = Number(/map: *(\d+)/.exec(FORMATS_JS)[1]);
const CACHE = MAP <= 1 ? 'basemap-v1' : `basemap-v1-m${MAP}`;

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

  await page.route('**/tiles/tiles*.json', route => route.fulfill({
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

  const state = await page.evaluate(async (name) => {
    await window.BikeBasemap.start({ autoSave: true });
    const cache = await caches.open(name);
    return {
      status: window.BikeBasemap.state().status,
      cachedCopies: (await cache.keys()).length
    };
  }, CACHE);

  expect(state).toEqual({ status: 'saved', cachedCopies: 1 });
  expect(await page.evaluate(() => window.archiveFetchModes)).toEqual(['no-store']);
});

test('replaces an outdated offline copy in WebKit', async ({ page }) => {
  await page.route('**/archive.pmtiles', route => route.fulfill({
    contentType: 'application/octet-stream',
    body: 'archive'
  }));

  const state = await page.evaluate(async (name) => {
    const cache = await caches.open(name);
    await cache.put('/old.pmtiles', new Response('old'));
    await window.BikeBasemap.start({ autoSave: true });
    return {
      status: window.BikeBasemap.state().status,
      savedCopies: (await cache.keys()).map(k => new URL(k.url).pathname)
    };
  }, CACHE);

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
  return page.evaluate(async ([savedDate, connection, name]) => {
    if (connection) Object.defineProperty(navigator, 'connection', { value: connection, configurable: true });
    const cache = await caches.open(name);
    await cache.put('/old.pmtiles', new Response('old', { headers: { 'X-Map-Date': savedDate } }));
    await window.BikeBasemap.start({ autoSave: true });
    return {
      status: window.BikeBasemap.state().status,
      savedCopies: (await cache.keys()).map(k => new URL(k.url).pathname)
    };
  }, [savedDate, connection, CACHE]);
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

// Each map format keeps its saved copy under its own cache name ('basemap-v1' for
// format 1, as phones already have it), and an app drops the copy an app of another
// format saved, since it can't draw that file.
async function asMapFormat(page, n) {
  const formats = FORMATS_JS.replace(/map: *\d+/, `map: ${n}`);
  await page.route('**/js/formats.js', route => route.fulfill({ contentType: 'application/javascript', body: formats }));
  await page.route('**/tiles/tiles.v2.json', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ url: '/archive-v2.pmtiles', bytes: 2, date: '2026-11-11' })
  }));
  await page.route('**/archive*.pmtiles', route => route.fulfill({
    contentType: 'application/octet-stream',
    body: route.request().url().endsWith('-v2.pmtiles') ? 'v2' : 'archive'
  }));
  await page.reload();
}

async function saveIn(page, cacheName, url) {
  await page.evaluate(async ([cacheName, url]) => {
    const cache = await caches.open(cacheName);
    await cache.put(url, new Response('x', { headers: { 'X-Map-Date': '2026-11-11' } }));
  }, [cacheName, url]);
}

async function startAndList(page) {
  const saved = await page.evaluate(async () => {
    await window.BikeBasemap.start({ autoSave: true });
    const s = window.BikeBasemap.state();
    return { status: s.status, url: new URL(s.saved.url, location.href).pathname };
  });
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter(k => /^basemap-/.test(k)))).toHaveLength(1);
  return { ...saved, caches: await page.evaluate(() => caches.keys()) };
}

test('a map format 2 app ignores and drops the format 1 copy', async ({ page }) => {
  await saveIn(page, 'basemap-v1', '/archive.pmtiles');
  await asMapFormat(page, 2);
  expect(await startAndList(page)).toEqual({ status: 'saved', url: '/archive-v2.pmtiles', caches: ['basemap-v1-m2'] });
});

test('a map format 1 app keeps basemap-v1 and drops a format 2 copy', async ({ page }) => {
  await saveIn(page, 'basemap-v1-m2', '/archive-v2.pmtiles');
  await saveIn(page, 'basemap-v1', '/archive.pmtiles');
  await asMapFormat(page, 1);
  expect(await startAndList(page)).toEqual({ status: 'saved', url: '/archive.pmtiles', caches: ['basemap-v1'] });
});

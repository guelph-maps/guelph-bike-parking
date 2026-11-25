const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const path = require('path');

// The only filter that picks releases to delete, so keep it tight.
const filter = path.join(__dirname, '..', 'scripts', 'old-drafts.jq');

const map = [{ name: 'guelph.pmtiles' }];
const releases = [
  { id: 1, tag_name: 'data-2026-11-18', draft: true, body: 'New base map, OSM data from Nov 16.', assets: map },
  { id: 2, tag_name: 'data-2026-11-11', draft: true, body: 'New base map, OSM data from Nov 9.', assets: map },
  { id: 3, tag_name: 'data-2026-11-04', draft: false, body: 'New base map, OSM data from Nov 2.', assets: map },
  { id: 4, tag_name: 'data-2026-11-12', draft: true, body: 'Rack fixes, with a hand-made New base map.', assets: map },
  { id: 5, tag_name: 'data-2026-11-13', draft: true, body: null, assets: map },
  { id: 6, tag_name: 'data-2026-11-14', draft: true, body: 'New base map, upload failed.', assets: [] },
  { id: 7, tag_name: 'data-2026-11-15', draft: true, body: 'New base map, other file.', assets: [{ name: 'notes.txt' }] },
  { id: 8, tag_name: 'v0.1.2', draft: true, body: 'New base map support.', assets: map }
];

test('deletes only older base map drafts the weekly build made', () => {
  const out = execFileSync('jq', ['-r', '--arg', 'tag', 'data-2026-11-18', '-f', filter], {
    input: JSON.stringify(releases),
    encoding: 'utf8'
  });
  expect(out).toBe('2 data-2026-11-11\n');
});

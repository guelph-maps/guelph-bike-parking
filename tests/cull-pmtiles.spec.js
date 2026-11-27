const { test, expect } = require('@playwright/test');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { gzipSync, gunzipSync } = require('node:zlib');
const { cullPmtiles, listTiles } = require('../scripts/tiles/cull-pmtiles.mjs');

test('culls and rewrites a PMTiles archive without changing retained tiles or metadata', ({}, testInfo) => {
  const dir = testInfo.outputPath();
  mkdirSync(dir, { recursive: true });
  const input = testInfo.outputPath('input.pmtiles');
  const output = testInfo.outputPath('output.pmtiles');
  const second = testInfo.outputPath('second.pmtiles');
  const root = gzipSync(Buffer.from([3, 1, 3, 1, 1, 1, 1, 3, 3, 3, 1, 0, 0]));
  const metadata = gzipSync(Buffer.from('{"name":"test map"}'));
  const header = Buffer.alloc(127);
  header.write('PMTiles');
  header[7] = 3;
  const dataOffset = header.length + root.length + metadata.length;
  [127, root.length, 127 + root.length, metadata.length, dataOffset, 0,
    dataOffset, 9, 3, 3, 3].forEach((value, i) => header.writeBigUInt64LE(BigInt(value), 8 + i * 8));
  header[96] = 1;
  header[97] = 2;
  header[98] = 1;
  header[99] = 1;
  header[100] = 1;
  header[101] = 2;
  writeFileSync(input, Buffer.concat([header, root, metadata, Buffer.from('aaabbbccc')]));

  const area = { type: 'Polygon', coordinates: [[[-170, 75], [-160, 75], [-160, 80], [-170, 80], [-170, 75]]] };
  cullPmtiles(input, output, area, { 1: 0, 2: 0 });
  const result = listTiles(output);
  expect([...result.tiles.entries()]).toEqual([
    ['1/0/0', Buffer.from('aaa')],
    ['2/0/0', Buffer.from('ccc')]
  ]);
  expect([result.header.minZoom, result.header.maxZoom]).toEqual([1, 2]);
  const bytes = readFileSync(output);
  expect(gunzipSync(bytes.subarray(result.header.metadataOffset, result.header.metadataOffset + result.header.metadataLength)).toString())
    .toBe('{"name":"test map"}');

  cullPmtiles(output, second, area, { 1: 0 });
  const again = listTiles(second);
  expect([...again.tiles.entries()]).toEqual([['1/0/0', Buffer.from('aaa')]]);
  expect([again.header.minZoom, again.header.maxZoom]).toEqual([1, 1]);
});

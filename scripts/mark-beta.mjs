#!/usr/bin/env node
// Turns a built site into the beta site: its own address and installed-app name,
// kept out of search results. (js/map.js counts beta visits under /beta/ by itself.)
//
//   node scripts/mark-beta.mjs <site-dir>

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const site = process.argv[2];
if (!site) {
  console.error('Usage: mark-beta.mjs <site-dir>');
  process.exit(2);
}

function edit(file, change) {
  const path = join(site, file);
  writeFileSync(path, change(readFileSync(path, 'utf8')));
}

for (const page of ['index.html', 'embed.html']) {
  edit(page, (html) => html
    .replace(/<title>(.*?)<\/title>/, '<title>$1 (Beta)</title>\n  <meta name="robots" content="noindex">')
    // "Don't index this" and "the real page is over there" contradict each other;
    // search engines are told only the first.
    .replace(/\n *<link rel="canonical"[^>]*>/, ''));
}

// Both describe the production site. Without a robots.txt everything may be fetched,
// which is what lets a crawler see the noindex above.
for (const file of ['robots.txt', 'sitemap.xml']) rmSync(join(site, file), { force: true });

edit('manifest.webmanifest', (text) => {
  const manifest = JSON.parse(text);
  manifest.name += ' Beta';
  manifest.short_name = 'Parking Beta';
  return `${JSON.stringify(manifest, null, 2)}\n`;
});

writeFileSync(join(site, 'CNAME'), 'beta.guelph.bike\n');

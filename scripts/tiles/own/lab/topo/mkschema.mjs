// node mkschema.mjs out.yml landTol landTolMax [waterTol waterTolMax]
// Copies build/ref/schema-safe.yml with the landuse (and optionally water) merge_polygons tolerances replaced.
import { readFileSync, writeFileSync } from 'node:fs';
const [out, lt, ltm, wt, wtm] = process.argv.slice(2);
const lines = readFileSync(new URL('../../ref/schema-safe.yml', import.meta.url), 'utf8').split('\n');
let layer = '';
for (let i = 0; i < lines.length; i++) {
  const m = /^- id: (\w+)/.exec(lines[i]); if (m) layer = m[1];
  const set = (re, v) => { if (v !== undefined && re.test(lines[i])) lines[i] = lines[i].replace(/[\d.]+$/, v); };
  if (layer === 'landuse') { set(/^      tolerance: /, lt); set(/^      tolerance_at_max_zoom: /, ltm); }
  if (layer === 'water') { set(/^      tolerance: /, wt); set(/^      tolerance_at_max_zoom: /, wtm); }
}
writeFileSync(out, lines.join('\n'));

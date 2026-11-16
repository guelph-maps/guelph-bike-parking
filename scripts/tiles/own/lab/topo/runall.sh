#!/bin/bash
# Regenerates every variant from raw.cut.pmtiles (schema-raw.yml) with the current topo.mjs; base = safe.cut.pmtiles.
cd "$(dirname "$0")"
W="--wtol 10:8,11:8,12:8,13:1"
node topo.mjs safe.cut.pmtiles safe.cut.pmtiles ident.pmtiles --identity
for f in pl2 pl3 pl4 pl3m; do node topo.mjs $f.cut.pmtiles $f.cut.pmtiles $f.re.pmtiles --identity; done
for t in 16 24 32 48 64; do node topo.mjs raw.cut.pmtiles safe.cut.pmtiles t$t.pmtiles --tol 10:$t,11:$t,12:$t,13:1 $W --stats > t$t.stats; head -1 t$t.stats; done
for t in 32 48; do node topo.mjs raw.cut.pmtiles safe.cut.pmtiles n$t.pmtiles --tol 10:$t,11:$t,12:$t,13:1 $W --no-rescue; done
node topo.mjs raw.cut.pmtiles safe.cut.pmtiles t32nofix.pmtiles --tol 10:32,11:32,12:32,13:1 $W --no-fix
node topo.mjs raw.cut.pmtiles safe.cut.pmtiles t32noedge.pmtiles --tol 10:32,11:32,12:32,13:1 $W --no-edge
for m in 2 4; do node topo.mjs raw.cut.pmtiles safe.cut.pmtiles t48m$m.pmtiles --tol 10:48,11:48,12:48,13:$m $W; done
node topo.mjs raw.cut.pmtiles safe.cut.pmtiles v96.pmtiles --algo vw --tol 10:96,11:96,12:96,13:1 $W
node topo.mjs raw.cut.pmtiles safe.cut.pmtiles t48c8.pmtiles --tol 10:48,11:48,12:48,13:1 $W --clip 8
node topo.mjs safe.cut.pmtiles safe.cut.pmtiles safe-pass.pmtiles --tol 0 --no-edge --no-rescue
node topo.mjs safe.cut.pmtiles safe.cut.pmtiles safe-c8.pmtiles --tol 0 --no-edge --no-rescue --clip 8
node topo.mjs pl2.cut.pmtiles pl2.cut.pmtiles pl2-c8.pmtiles --tol 0 --no-edge --no-rescue --clip 8
for f in t16 t32 t48 t64 t48m4 t48c8 v96; do node check.mjs safe.cut.pmtiles $f.pmtiles; done
for f in t32 t48 t64 t48c8 t48m4; do node cross.mjs $f.pmtiles landuse; node cross.mjs $f.pmtiles water; done

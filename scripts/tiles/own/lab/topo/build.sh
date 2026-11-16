#!/bin/bash
# build.sh name [extra planetiler args]  -> build/own/topo/<name>.pmtiles and <name>.cut.pmtiles
cd /c/Users/kk/Code/guelph-bike-parking-ownpipe
J=/c/Users/kk/Code/.tools/jre/jdk-21.0.13+9-jre/bin/java.exe
D=build/own/topo; name=$1; shift
"$J" -Xmx6g -jar /c/Users/kk/Code/.tools/planetiler-0.10.2/planetiler.jar generate-custom --schema=$D/schema-$name.yml \
  --osm_path=C:/Users/kk/Code/.osm-data/ontario/ontario-2026-11-15.osm.pbf --output=$D/$name.pmtiles \
  --bounds=-80.40,43.44,-80.08,43.64 --maxzoom=13 --render_maxzoom=13 --tmpdir=$D/tmp-$name --download=false --force "$@" > $D/$name.log 2>&1
echo "$name exit $?"; rm -rf $D/tmp-$name
node -e "import('./scripts/tiles/cull-pmtiles.mjs').then(m=>m.cullPmtiles('$D/$name.pmtiles','$D/$name.cut.pmtiles',JSON.parse(require('fs').readFileSync('data/guelph-boundary.geojson','utf8')),{10:0,11:0,12:0,13:0,14:0}))"
ls -la $D/$name.cut.pmtiles

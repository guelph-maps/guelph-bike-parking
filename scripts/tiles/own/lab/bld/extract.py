# Extract OSM building footprints (ways + multipolygons) in the bbox of the level-13 tiles, full precision.
# Output: buildings.geojsonl, one feature per line {"id":..,"coords":[[ring lon/lat...],...]} (outer first, holes after; multi -> several features)
import osmium, json, sys, math
PBF = 'C:/Users/kk/Code/.osm-data/ontario/ontario-2026-11-15.osm.pbf'
def lon(x): return x / 8192 * 360 - 180
def lat(y): return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / 8192))))
W, E = lon(2268 - 0.05), lon(2273 + 0.05)
N, S = lat(2991 - 0.05), lat(2996 + 0.05)
print(W, S, E, N, file=sys.stderr)
NO = {'no', '0', 'false'}
out = open('buildings.jsonl', 'w')
n = 0
class H(osmium.SimpleHandler):
    def area(self, a):
        global n
        b = a.tags.get('building')
        if b is None or b in NO: return
        try:
            for outer in a.outer_rings():
                pts = [(p.lon, p.lat) for p in outer]
                if not any(W <= x <= E and S <= y <= N for x, y in pts): continue
                rings = [pts] + [[(p.lon, p.lat) for p in inner] for inner in a.inner_rings(outer)]
                out.write(json.dumps({'id': a.orig_id(), 'w': a.from_way(), 'r': rings}) + '\n'); n += 1
        except osmium.InvalidLocationError:
            pass
h = H()
h.apply_file(PBF, locations=True, idx='flex_mem')
print('buildings', n, file=sys.stderr)

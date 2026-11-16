# Locate the worst source corners (source -> output distance) of a variant tile.
import json, sys, math, numpy as np, shapely
import bldlib as B
from shapely.strtree import STRtree
polys, union = B.load_cached()
f, key = sys.argv[1], sys.argv[2]
v = json.load(open(f))[key]
rw = B.rings_to_world(v['rings'], key, v['extent'])
op = B.rings_to_polys(rw); tl = STRtree(B._lines(op)); to = STRtree(op)
src = B.polys_of(shapely.intersection(union, B.tile_box(key, 72)))
worst = []
for p in src:
    if len(to.query(p, predicate='intersects')) == 0: continue
    if p.area < 32: continue
    c = np.asarray(p.exterior.coords)[:-1]
    x0, y0, x1, y1 = B.tile_box(key).bounds
    c = c[(c[:, 0] > x0 + 1) & (c[:, 0] < x1 - 1) & (c[:, 1] > y0 + 1) & (c[:, 1] < y1 - 1)]
    if not len(c): continue
    _, d = tl.query_nearest(shapely.points(c), return_distance=True, all_matches=False)
    i = d.argmax(); worst.append((d[i], c[i], p.area, len(c)))
worst.sort(key=lambda t: -t[0])
for w in worst[:int(sys.argv[3]) if len(sys.argv) > 3 else 5]:
    x, y = w[1]; lon = x / B.WORLD * 360 - 180; lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / B.WORLD))))
    print(round(w[0] * 0.866, 2), 'm', round(lat, 6), round(lon, 6), 'area m2', round(w[2] * 0.75), 'nv', w[3])

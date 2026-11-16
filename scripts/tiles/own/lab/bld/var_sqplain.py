# Squared source re-encoded as plain MVT (grid 4096 / 8192): does squaring save vertices or bytes in MVT?
import sys, json
import numpy as np, shapely
from shapely.geometry import Polygon
from bldlib import *
from square import square_polygon, MPU
polys, union = load_cached()
TOL = float(sys.argv[1]) if len(sys.argv) > 1 else 0.2
def pre(parts):
    out = []; n = 0
    for p in parts:
        r = square_polygon(p, TOL / MPU)
        if r:
            th, rr = r
            q = Polygon(rr[0][1], [x[1] for x in rr[1:]])
            if q.is_valid and q.area > 0: out.append(q); n += 1; continue
        out.append(p)
    print('squared', n, 'of', len(parts), flush=True)
    return out
for name, tol, grid in [('sq13-t0', 0, 1), ('sq8k-t0', 0, 2), ('sq8k-t05', 0.5, 2)]:
    v = build_plain(union, tol, grid=grid, pre=pre)
    json.dump(v, open(f'v-{name}.json', 'w'))
    print(name, fmt(measure(v, union)), flush=True)

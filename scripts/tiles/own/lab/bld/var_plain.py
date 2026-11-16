# Plain variants: Planetiler-like pipeline from full-precision source, different DP tolerances / grids.
import sys, json
from bldlib import *
polys, union = load_cached()
for name, tol, grid in [('p13-t0', 0, 1), ('p13-t1', 1, 1), ('p13-t2', 2, 1), ('p13-t05', 0.5, 1), ('p8k-t0', 0, 2), ('p8k-t05', 0.5, 2), ('p8k-t1', 1, 2)]:
    v = build_plain(union, tol, grid=grid)
    json.dump(v, open(f'v-{name}.json', 'w'))
    print(name, fmt(measure(v, union)), flush=True)

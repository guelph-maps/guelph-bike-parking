# How many merged buildings can be squared within a tolerance (metres), from the full-precision source?
import sys, numpy as np
from bldlib import *
from square import *
polys, union = load_cached()
parts = [p for p in polys_of(union) if p.area >= 32]
print('parts', len(parts))
for tm in [0.15, 0.25, 0.35, 0.5]:
    ok = rect = 0; vin = vout = 0; vall = 0
    for p in parts:
        nv = len(p.exterior.coords) - 1 + sum(len(i.coords) - 1 for i in p.interiors); vall += nv
        r = square_polygon(p, tm / MPU)
        if r:
            ok += 1; th, rr = r
            vin += nv; vout += sum(len(g) for g, _ in rr)
            if len(rr) == 1 and len(rr[0][0]) == 4: rect += 1
    print(f'tol {tm} m: squared {ok/len(parts)*100:.1f}% (rect {rect/len(parts)*100:.1f}%), verts in those {vin} -> {vout}; all verts {vall}')

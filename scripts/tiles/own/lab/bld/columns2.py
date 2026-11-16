# Plain columns for an MVT-ring variant: sep (3 deflates) and cat (1 deflate), all rings or only rings touching the tile.
import sys, json
from bldlib import *
def streams(rings):
    c, x, y = [], [], []; px = py = 0
    for r in rings:
        c.append(len(r) // 2)
        for i in range(0, len(r), 2):
            x.append(zig(r[i] - px)); y.append(zig(r[i + 1] - py)); px, py = r[i], r[i + 1]
    return varints(c), varints(x), varints(y)
v = json.load(open(sys.argv[1]))
S = C = S2 = C2 = n = n2 = 0
for k, t in v.items():
    e = t['extent']; rs = t['rings']
    inside = [r for r in rs if max(r[0::2]) > 0 and min(r[0::2]) < e and max(r[1::2]) > 0 and min(r[1::2]) < e]
    for lst, acc in ((rs, 0), (inside, 1)):
        a, b, d = streams(lst); h = len(varints([len(a), len(b), len(d)]))
        s_, c_ = deflate(a) + deflate(b) + deflate(d) + h, deflate(bytes(a + b + d)) + h
        if acc == 0: S += s_; C += c_; n += len(lst)
        else: S2 += s_; C2 += c_; n2 += len(lst)
print(f'{sys.argv[1]}: all rings {n}: sep {S/1e3:.1f} cat {C/1e3:.1f} kB | touching tile {n2}: sep {S2/1e3:.1f} cat {C2/1e3:.1f} kB')

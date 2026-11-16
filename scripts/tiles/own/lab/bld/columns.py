# Plain columns figure for an MVT-ring variant: per tile deflate-raw of counts / x deltas / y deltas (+ header).
import sys, json
from bldlib import *
def col_bytes(rings):
    c, x, y = [], [], []; px = py = 0
    for r in rings:
        c.append(len(r) // 2)
        for i in range(0, len(r), 2):
            x.append(zig(r[i] - px)); y.append(zig(r[i + 1] - py)); px, py = r[i], r[i + 1]
    a, b, d = varints(c), varints(x), varints(y)
    return deflate(a) + deflate(b) + deflate(d) + len(varints([len(a), len(b), len(d)]))
if __name__ == '__main__':
    only = sys.argv[2] if len(sys.argv) > 2 else None
    v = json.load(open(sys.argv[1]))
    tot = sum(col_bytes(t['rings']) for k, t in v.items() if not only or k == only)
    print(sys.argv[1], only or 'all', f'{tot/1e3:.1f} kB columns')

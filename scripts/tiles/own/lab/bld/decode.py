# Reference decoder: rebuilds rings from the varint streams alone (P/H/S/A/A2/L/G/M + params g, q, asteps),
# and checks it against the encoder's own output on every tile.  usage: python decode.py '{"g":0.5,...}'
import sys, json, math
import numpy as np
from shapely.strtree import STRtree
from bldlib import *
from enc import Enc, decode_lengths, unrot
unz = lambda n: n // 2 if n % 2 == 0 else -(n + 1) // 2

def decode_tile(st, key, g, q, A):
    _, tx, ty = map(int, key.split('/')); o = np.array([tx * EXT, ty * EXT], float)
    it = {k: iter(v) for k, v in st.items()}
    nx = lambda k: next(it[k])
    mtf, prev_new, prevS, rings = [], 0, np.zeros(2), []
    for holes in st['P']:
        for ci in range(holes + 1):
            h = nx('H'); kind = h & 3
            start = prevS + np.array([unz(nx('S')), unz(nx('S'))]) * g; prevS = start
            if kind in (1, 2):
                a = nx('A')
                if a == 0:
                    qa = (prev_new + unz(nx('A2'))) % A; prev_new = qa
                    if qa in mtf: mtf.remove(qa)
                else: qa = mtf.pop(a - 1)
                mtf.insert(0, qa); th = qa * (math.pi / 2) / A
            if kind == 1:
                m = ((h >> 2) + 2) * 2
                if m == 4: lens = [nx('L') + 1, (nx('L') + 1) * (1 if ci == 0 else -1)]
                else: lens = [nx('L') + 1] + [unz(nx('L')) for _ in range(m - 3)]
                rings.append(decode_lengths(start + o, th, lens, q))
            elif kind == 2:
                m = (h >> 2) + 3; rel = [(0, 0)]
                for _ in range(m - 1): rel.append((rel[-1][0] + unz(nx('M')), rel[-1][1] + unz(nx('M'))))
                from square import rot
                rings.append(unrot(np.array(rel, float) * q + rot((start + o)[None], th)[0], th))
            else:
                m = (h >> 2) + 3; pts = [(0, 0)]
                for _ in range(m - 1): pts.append((pts[-1][0] + unz(nx('G')), pts[-1][1] + unz(nx('G'))))
                rings.append(np.array(pts, float) * g + start + o)
    for k in it:
        if k != 'P': assert next(it[k], None) is None, 'leftover in ' + k
    return rings

if __name__ == '__main__':
    kw = json.loads(sys.argv[1]); polys, union = load_cached()
    parts = [p for p in polys_of(union) if p.area >= 32]; tree = STRtree(parts)
    worst = 0; n = 0
    for key in tiles():
        enc = Enc(**kw)
        st, rings, _, _ = enc.tile([parts[i] for i in tree.query(tile_box(key), predicate='intersects')], key)
        dec = decode_tile(st, key, enc.g, enc.q, enc.A)
        assert len(dec) == len(rings), (len(dec), len(rings))
        for a, b in zip(dec, rings):
            assert a.shape == b.shape, (a.shape, b.shape); worst = max(worst, float(np.abs(a - b).max()))
        n += len(rings)
    print(f'decoded {n} rings from streams alone; max coordinate difference {worst:.2e} units')

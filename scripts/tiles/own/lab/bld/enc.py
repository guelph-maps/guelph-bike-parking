# Custom building codec for level-13 tiles: orthogonal rings as start + angle + edge lengths, others as deltas.
# Everything a decoder needs is in the streams; size = deflate-raw of the streams per tile (+ a small length header).
#
# Per tile streams (varints):
#   P  holes per polygon
#   H  ring header: orthogonal (m corners, even): ((m/2 - 2) << 1) | 1;  generic (m points): (m - 3) << 1
#   S  ring start corner, zigzag delta from the previous ring start, in grid steps g (tile frame)
#   A  angle of an orthogonal ring: k+1 = move-to-front palette index k, or 0 followed by a new angle in A2
#   A2 new angles: zigzag delta (mod ASTEPS) from the previous new angle, steps of 90/ASTEPS degrees
#   L  orthogonal ring: m-2 edge lengths in steps q in the ring's rotated frame (zigzag; first edge always +u so its
#      length is stored unsigned); the last two edges close the ring
#   G  generic ring: points 1..m-1 as zigzag deltas from the previous point, steps g
# Decoder output: float tile coordinates; for MapLibre round to an extent (8192 here).
import math, sys, json
import numpy as np
import shapely
from shapely.strtree import STRtree
from bldlib import *
from square import dp, rot, unrot, MPU, dominant_angle


def hilbert(x, y, order=16):
    d = 0; s = 1 << (order - 1)
    while s > 0:
        rx = 1 if (x & s) else 0; ry = 1 if (y & s) else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1: x = s - 1 - x; y = s - 1 - y
            x, y = y, x
        s >>= 1
    return d


def fit_orth(c, th, Sr, q, start_hint=None):
    """Fit an orthogonal ring to c (world units) in the frame of angle th, start corner pinned to Sr.
    Returns (lengths_in_q_steps, corners_world) or None."""
    r = rot(c - Sr, th)
    n = len(r)
    e = np.roll(r, -1, axis=0) - r
    L = np.hypot(e[:, 0], e[:, 1])
    ax = (np.abs(e[:, 1]) > np.abs(e[:, 0])).astype(int)
    starts = [i for i in range(n) if ax[i] != ax[i - 1]]
    m = len(starts)
    if m < 4 or m % 2: return None
    vals, dirs = [], []
    for gi, s in enumerate(starts):
        t = starts[(gi + 1) % m]
        idx = [(s + j) % n for j in range((t - s) % n or n)]
        a = ax[s]
        w = L[idx] + 1e-9
        mid = (r[idx] + r[[(i + 1) % n for i in idx]]) / 2
        vals.append(float(np.sum(w * (mid[:, 1] if a == 0 else mid[:, 0])) / np.sum(w)))
        dirs.append(float(np.sum(e[idx, 0] if a == 0 else e[idx, 1])))
    # corner k = end of group k = intersection of line k and line k+1. Choose start group: an H group running +u,
    # whose start corner (end of previous group) is closest to Sr's origin (we pinned Sr near some corner).
    axes = [ax[s] for s in starts]
    best = None
    for k in range(m):
        if axes[k] != 0 or dirs[k] <= 0: continue
        p = k - 1
        cu, cv = vals[p], vals[k]  # previous group is V (u = vals[p]), this is H (v = vals[k])
        d = cu * cu + cv * cv
        if best is None or d < best[0]: best = (d, k)
    if best is None: return None
    k0 = best[1]
    vals = vals[k0:] + vals[:k0]
    # pin start corner: line 0 (H) through v=0, line m-1 (V) through u=0
    vals[0] = 0.0; vals[-1] = 0.0
    qv = [round(v / q) for v in vals]
    # edge j lies on line j, from corner j-1 to corner j; length = line[j+1] - line[j-1] (same axis)
    lens = [qv[(j + 1) % m] - qv[j - 1] for j in range(m - 2)]
    if lens[0] <= 0: return None
    corners = []
    for j in range(m):
        a, b = qv[j], qv[(j + 1) % m]
        corners.append((b * q, a * q) if j % 2 == 0 else (a * q, b * q))  # H line j: v=a, next V: u=b
    cw = unrot(np.array(corners, float), th) + Sr
    # corner m-1 should be the start (0,0); rotate list so that start is first
    cw = np.vstack([cw[-1:], cw[:-1]])
    return lens, cw


def ring_err(c, sq):
    la, lb = shapely.linearrings(np.vstack([c, c[:1]])), shapely.linearrings(np.vstack([sq, sq[:1]]))
    return max(shapely.distance(shapely.points(c), lb).max(), shapely.distance(shapely.points(sq), la).max())


def decode_lengths(start, th, lens, q):
    """Pure decoder of an orthogonal ring (for checking): start (tile frame), angle, m-2 lengths -> corners."""
    m = len(lens) + 2
    # line values: line[-1]=0 (V), line[0]=0 (H); line[j+1] = line[j-1] + lens[j]
    line = [0] * m
    line[m - 1] = 0; line[0] = 0
    for j in range(m - 2):
        line[j + 1] = line[j - 1] + lens[j]
    pts = []
    for j in range(m):
        a, b = line[j], line[(j + 1) % m]
        pts.append((b * q, a * q) if j % 2 == 0 else (a * q, b * q))
    cw = unrot(np.array(pts, float), th) + start
    return np.vstack([cw[-1:], cw[:-1]])


def partial_square(c, th, maxdev=12):
    """Snap near-axis edge runs of ring c (world) to axis lines in frame th; free edges keep their vertices.
    Returns the new ring in the rotated frame (k,2) with vertices inside straight runs removed."""
    r = rot(c, th); n = len(r)
    e = np.roll(r, -1, axis=0) - r
    L = np.hypot(e[:, 0], e[:, 1]) + 1e-12
    dev = np.degrees(np.arctan2(np.minimum(abs(e[:, 0]), abs(e[:, 1])), np.maximum(abs(e[:, 0]), abs(e[:, 1]))))
    cls = np.where(dev > maxdev, 2, (abs(e[:, 1]) > abs(e[:, 0])).astype(int))  # 0 H, 1 V, 2 free
    if (cls == cls[0]).all(): return None
    # runs of equal class (circular); run id per edge
    start = next(i for i in range(n) if cls[i] != cls[i - 1])
    rid = np.zeros(n, int); vals = []; k = -1
    for t in range(n):
        i = (start + t) % n
        if t == 0 or cls[i] != cls[(i - 1) % n]: k += 1; vals.append([0.0, 0.0])
        rid[i] = k
        if cls[i] < 2:
            mid = (r[i] + r[(i + 1) % n]) / 2
            vals[k][0] += L[i] * (mid[1] if cls[i] == 0 else mid[0]); vals[k][1] += L[i]
    val = [a / b if b else 0 for a, b in vals]
    out = []
    for i in range(n):
        ep, en = (i - 1) % n, i  # edge before / after vertex i
        if cls[ep] == cls[en] and cls[en] < 2: continue  # inside a straight axis run
        u, v = r[i]
        for ed in (ep, en):
            if cls[ed] == 0: v = val[rid[ed]]
            elif cls[ed] == 1: u = val[rid[ed]]
        out.append((u, v))
    return np.array(out) if len(out) >= 3 else None


class Enc:
    def __init__(s, g=0.25, q=0.25, tol_m=0.2, gen_tol_m=0.2, asteps=4096, pal=16, pre_dp_m=0.05, rect_unsigned=True, srot='none', mixed=False, orth=True):
        s.g, s.q, s.tol, s.gtol, s.A, s.pal, s.pre = g, q, tol_m / MPU, gen_tol_m / MPU, asteps, pal, pre_dp_m / MPU
        s.rect_unsigned = rect_unsigned; s.srot = srot; s.stat = {}; s.mixed = mixed; s.orth = orth

    def tile(s, polys, key):
        _, tx, ty = map(int, key.split('/'))
        o = np.array([tx * EXT, ty * EXT], float)
        st = {k: [] for k in ['P', 'H', 'S', 'A', 'A2', 'L', 'G', 'M']}
        out_rings = []  # world float
        mtf = []; shapes = []; prev_new = 0; prevS = np.zeros(2); prev_th = 0.0
        n_orth = n_gen = n_mix = 0
        items = []
        for p in polys:
            c = np.asarray(p.exterior.coords)[0] - o
            items.append((hilbert(int(min(max(c[0] + 1024, 0), 65535)), int(min(max(c[1] + 1024, 0), 65535))), p))
        items.sort(key=lambda t: t[0])
        for _, p in items:
            p = shapely.geometry.polygon.orient(p, 1.0)
            rings = [np.asarray(p.exterior.coords)[:-1]] + [np.asarray(i.coords)[:-1] for i in p.interiors]
            st['P'].append(len(rings) - 1)
            for ci, c0 in enumerate(rings):
                c = dp(c0, s.pre)
                done = False
                # candidate angles: palette first, then the ring's own dominant angle quantized
                from square import dominant_angle
                th0 = dominant_angle(c)
                qa0 = int(round(th0 / (math.pi / 2) * s.A)) % s.A
                cands = [(i, a) for i, a in enumerate(mtf[:s.pal])] + [(None, qa0)]
                # start corner: pin to the vertex of c nearest the frame's chosen corner; we try the dp'd vertices
                for idx, qa in (cands if s.orth else []):
                    th = qa * (math.pi / 2) / s.A
                    # pick a provisional start: run fit with Sr at origin of the ring's lowest-u corner
                    r = rot(c, th)
                    # start corner = the corner at the start of an H group running +u closest to min(u+v)
                    j = int(np.argmin(r[:, 0] + r[:, 1]))
                    tq = th if s.srot == 'cur' else (prev_th if s.srot == 'prev' else 0.0)
                    qs = lambda pl: prevS + unrot(np.round(rot((pl - prevS)[None], tq) / s.g) * s.g, tq)[0]
                    Sr_t = qs(c[j] - o)
                    res = fit_orth(c, th, Sr_t + o, s.q)
                    if res is None or (len(res[0]) == 2 and res[0][1] == 0): continue
                    lens, cw = res
                    # the fit may have chosen a different start corner; re-pin to that corner's rounded position
                    Sr2 = qs(cw[0] - o)
                    if np.abs(Sr2 - Sr_t).max() > 1e-9:
                        res = fit_orth(c, th, Sr2 + o, s.q)
                        if res is None: continue
                        lens, cw = res
                        if np.abs(qs(cw[0] - o) - Sr2).max() > 1e-9: continue
                        Sr_t = Sr2
                    if ring_err(c0, cw) > s.tol: continue
                    # accept
                    m = len(lens) + 2
                    st['H'].append(((m // 2 - 2) << 2) | 1)
                    si = np.round(rot((Sr_t - prevS)[None], tq)[0] / s.g).astype(int)
                    st['S'] += [zig(int(si[0])), zig(int(si[1]))]; prevS = Sr_t; prev_th = th
                    if idx is None:
                        st['A'].append(0)
                        d = (qa - prev_new) % s.A
                        if d > s.A // 2: d -= s.A
                        st['A2'].append(zig(d)); prev_new = qa
                        if qa in mtf: mtf.remove(qa)
                    else:
                        st['A'].append(idx + 1); mtf.pop(idx)
                    mtf.insert(0, qa)
                    tl_ = tuple(lens); s.stat['orth'] = s.stat.get('orth', 0) + 1
                    for W in (8, 32, 128):
                        if tl_ in shapes[:W]: s.stat[f'rep{W}'] = s.stat.get(f'rep{W}', 0) + 1
                        if m == 4 and (tl_ in shapes[:W] or (lens[1], lens[0]) in shapes[:W] or (-lens[1], -lens[0]) in shapes[:W]): s.stat[f'repsw{W}'] = s.stat.get(f'repsw{W}', 0) + 1
                    if tl_ in shapes: shapes.remove(tl_)
                    shapes.insert(0, tl_)
                    if s.rect_unsigned and m == 4: st['L'] += [lens[0] - 1, abs(lens[1]) - 1]  # sign implied by ring role
                    else: st['L'] += [lens[0] - 1] + [zig(v) for v in lens[1:]]
                    dec = decode_lengths(Sr_t + o, th, lens, s.q)
                    assert np.abs(dec - cw).max() < 1e-6, (dec, cw)
                    out_rings.append(cw); n_orth += 1; done = True
                    break
                if not done and s.mixed:
                    gg = dp(c0, s.gtol)
                    th0 = dominant_angle(gg); qa0 = int(round(th0 / (math.pi / 2) * s.A)) % s.A
                    for idx, qa in [(i, a) for i, a in enumerate(mtf[:s.pal])] + [(None, qa0)]:
                        th = qa * (math.pi / 2) / s.A
                        rr = partial_square(gg, th)
                        if rr is None: continue
                        tq = 0.0
                        w0 = unrot(rr[:1], th)[0]
                        S0 = np.round((w0 - o) / s.g) * s.g
                        rel = np.round((rr - rot((S0 + o)[None], th)[0]) / s.q).astype(int)
                        rel[0] = 0
                        keep = [0] + [i for i in range(1, len(rel)) if (rel[i] != rel[i - 1]).any()]
                        rel = rel[keep]
                        if len(rel) > 1 and (rel[-1] == rel[0]).all(): rel = rel[:-1]
                        if len(rel) < 3: continue
                        cw = unrot(rel * s.q + rot((S0 + o)[None], th)[0], th)
                        if ring_err(c0, cw) > s.tol: continue
                        st['H'].append(((len(rel) - 3) << 2) | 2)
                        si = np.round((S0 - prevS) / s.g).astype(int)
                        st['S'] += [zig(int(si[0])), zig(int(si[1]))]; prevS = S0
                        if idx is None:
                            st['A'].append(0)
                            d = (qa - prev_new) % s.A
                            if d > s.A // 2: d -= s.A
                            st['A2'].append(zig(d)); prev_new = qa
                            if qa in mtf: mtf.remove(qa)
                        else:
                            st['A'].append(idx + 1); mtf.pop(idx)
                        mtf.insert(0, qa)
                        for i in range(1, len(rel)):
                            st['M'] += [zig(int(rel[i][0] - rel[i - 1][0])), zig(int(rel[i][1] - rel[i - 1][1]))]
                        out_rings.append(cw); n_mix += 1; done = True
                        break
                if not done:
                    gg = dp(c0, s.gtol)
                    tq = prev_th if s.srot == 'prev' else 0.0
                    p0 = prevS + unrot(np.round(rot((gg[0] - o - prevS)[None], tq) / s.g) * s.g, tq)[0]
                    si = np.round(rot((p0 - prevS)[None], tq)[0] / s.g).astype(int)
                    pts = np.round((gg - o - p0) / s.g).astype(int)
                    # drop consecutive duplicates
                    keep = [0] + [i for i in range(1, len(pts)) if (pts[i] != pts[i - 1]).any()]
                    pts = pts[keep]
                    if len(pts) > 1 and (pts[-1] == pts[0]).all(): pts = pts[:-1]
                    if len(pts) < 3: pts = np.round((c0[:3] - o - p0) / s.g).astype(int)
                    st['H'].append((len(pts) - 3) << 2)
                    pts = pts - pts[0]
                    st['S'] += [zig(int(si[0])), zig(int(si[1]))]; prevS = p0
                    for i in range(1, len(pts)):
                        st['G'] += [zig(int(pts[i][0] - pts[i - 1][0])), zig(int(pts[i][1] - pts[i - 1][1]))]
                    out_rings.append(pts * s.g + p0 + o); n_gen += 1
        s.stat['mixed'] = s.stat.get('mixed', 0) + n_mix
        return st, out_rings, n_orth, n_gen


def stream_bytes(st, mode='sep'):
    names = ['P', 'H', 'S', 'A', 'A2', 'L', 'G', 'M']
    if mode == 'sep':
        per = {k: deflate(varints(st[k])) if st[k] else 0 for k in names}
        hdr = len(varints([len(varints(st[k])) for k in names]))
        return sum(per.values()) + hdr, per
    blob = b''.join(bytes(varints(st[k])) for k in names)
    hdr = len(varints([len(varints(st[k])) for k in names]))
    return deflate(blob) + hdr, {}


def run(enc, union, keys=None, min_area=32, label=''):
    keys = keys or tiles()
    parts = [p for p in polys_of(union) if p.area >= min_area]
    tree = STRtree(parts)
    total_sep = total_cat = 0; per_tot = {}; no = ng = 0
    variant = {}
    for key in keys:
        idx = tree.query(tile_box(key), predicate='intersects')
        st, rings, a, b = enc.tile([parts[i] for i in idx], key)
        no += a; ng += b
        bs, per = stream_bytes(st, 'sep'); bc, _ = stream_bytes(st, 'cat')
        total_sep += bs; total_cat += bc
        for k, v in per.items(): per_tot[k] = per_tot.get(k, 0) + v
        _, tx, ty = map(int, key.split('/'))
        variant[key] = {'extent': EXT, 'world': rings}
    print('stat', enc.stat)
    return dict(sep=total_sep, cat=total_cat, per=per_tot, orth=no, gen=ng), variant


def to_mvt_variant(variant, extent=8192):
    """Round decoded float rings to an MVT extent (what MapLibre would get from a client-side decoder)."""
    out = {}
    for key, v in variant.items():
        _, tx, ty = map(int, key.split('/'))
        s = extent / EXT
        rings = []
        for cw in v['world']:
            loc = np.rint((cw - [tx * EXT, ty * EXT]) * s).astype(int)
            keep = [0] + [i for i in range(1, len(loc)) if (loc[i] != loc[i - 1]).any()]
            loc = loc[keep]
            if len(loc) > 1 and (loc[-1] == loc[0]).all(): loc = loc[:-1]
            if len(loc) >= 3: rings.append(loc.ravel().tolist())
        out[key] = {'extent': extent, 'rings': rings}
    return out


def float_variant(variant):
    # measure() wants rings in some extent; use a fine extent so rounding is negligible
    return to_mvt_variant(variant, extent=EXT * 1024)

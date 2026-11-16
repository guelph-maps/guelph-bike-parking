# Shared helpers for the level-13 building experiments.
# World coordinates: level-13 tile units (extent 4096), as floats: X = tile_x*4096 + local x.
import json, math, zlib, os
import numpy as np
import shapely, shapely.affinity
from shapely.geometry import Polygon, MultiPolygon, box, LineString, Point
from shapely.strtree import STRtree

HERE = os.path.dirname(os.path.abspath(__file__))
Z, EXT = 13, 4096
WORLD = (1 << Z) * EXT
BUF = 64  # Planetiler default buffer, 4 px of 256 = 64 units at 4096


def proj(lon, lat):
    x = (lon + 180) / 360 * WORLD
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * WORLD
    return x, y


def m_per_unit(tile_y):
    # ground metres per level-13 unit at the tile's centre latitude
    yc = (tile_y + 0.5) / (1 << Z)
    lat = math.atan(math.sinh(math.pi * (1 - 2 * yc)))
    return 40075016.686 / WORLD * math.cos(lat)


def tiles():
    return json.load(open(os.path.join(HERE, 'tiles13.json')))


def load_source(path=None):
    """Individual OSM buildings as shapely polygons in world units (valid)."""
    path = path or os.path.join(HERE, 'buildings.jsonl')
    polys = []
    for line in open(path):
        f = json.loads(line)
        rings = [[proj(x, y) for x, y in r] for r in f['r']]
        if len(rings[0]) < 4: continue
        p = Polygon(rings[0], [r for r in rings[1:] if len(r) >= 4])
        if not p.is_valid: p = shapely.make_valid(p)
        for g in getattr(p, 'geoms', [p]):
            if g.geom_type == 'Polygon' and g.area > 0: polys.append(g)
    return polys


def polys_of(g):
    if g is None or g.is_empty: return []
    if g.geom_type == 'Polygon': return [g]
    out = []
    for h in getattr(g, 'geoms', []): out += polys_of(h)
    return out


def tile_box(key, pad=0):
    _, x, y = map(int, key.split('/'))
    return box(x * EXT - pad, y * EXT - pad, (x + 1) * EXT + pad, (y + 1) * EXT + pad)


def to_local_rings(geom, key, grid=1.0):
    """World-unit polygons -> MVT rings (flat int lists, local units scaled by grid, outer CCW-positive then holes)."""
    _, tx, ty = map(int, key.split('/'))
    rings = []
    for p in polys_of(geom):
        p = shapely.orient_polygons(p) if hasattr(shapely, 'orient_polygons') else shapely.geometry.polygon.orient(p, 1.0)
        for r in [p.exterior] + list(p.interiors):
            c = np.asarray(r.coords)[:-1]
            loc = np.rint((c - [tx * EXT, ty * EXT]) * grid).astype(int)
            rings.append(loc.ravel().tolist())
    return rings


def rings_to_world(rings, key, extent=EXT):
    """MVT rings (local) -> list of world-unit coordinate arrays (n,2)."""
    _, tx, ty = map(int, key.split('/'))
    s = EXT / extent
    return [np.asarray(r, float).reshape(-1, 2) * s + [tx * EXT, ty * EXT] for r in rings]


def rings_to_polys(rings_w):
    """MVT rings in world units -> shapely polygons (outer = positive shoelace, holes follow)."""
    polys = []
    for c in rings_w:
        if len(c) < 3: continue
        x, y = c[:, 0], c[:, 1]
        a = np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y)
        if a > 0 or not polys: polys.append([c, []])
        else: polys[-1][1].append(c)
    out = []
    for ext, holes in polys:
        p = Polygon(ext, holes)
        if not p.is_valid: p = shapely.make_valid(p)
        out += polys_of(p)
    return out


def _lines(polys):
    ls = []
    for p in polys:
        for r in [p.exterior] + list(p.interiors): ls.append(LineString(r.coords))
    return ls


def measure(variant, union_src, keys=None, extent=EXT):
    """variant: {key: {'rings': [...], 'extent': e}}. Distances in metres, only for vertices inside the tile.
    out->src: each output vertex to the source (merged) boundary. src->out: each source corner to the output boundary.
    Source polygons the output dropped entirely (tiny sheds) are counted, not measured."""
    keys = keys or sorted(variant)
    o2s, s2o, dropped, nverts, nrings = [], [], 0, 0, 0
    for key in keys:
        v = variant.get(key)
        if not v: continue
        e = v.get('extent', extent)
        mpu = m_per_unit(int(key.split('/')[2]))
        rw = rings_to_world(v['rings'], key, e)
        nrings += len(rw); nverts += sum(len(c) for c in rw)
        tb = tile_box(key); tbx = tile_box(key, BUF + 8)
        src = polys_of(shapely.intersection(union_src, tbx))
        src_lines = _lines(src)
        out_polys = rings_to_polys(rw)
        out_lines = [LineString(np.vstack([c, c[:1]])) for c in rw if len(c) >= 2]  # rings as drawn, not repaired
        if not src_lines or not out_lines: continue
        # output vertices strictly inside the tile
        allv = np.concatenate(rw)
        x0, y0, x1, y1 = tb.bounds
        m = (allv[:, 0] > x0 + 1) & (allv[:, 0] < x1 - 1) & (allv[:, 1] > y0 + 1) & (allv[:, 1] < y1 - 1)
        pts = shapely.points(allv[m])
        t = STRtree(src_lines)
        _, d = t.query_nearest(pts, return_distance=True, all_matches=False)
        o2s.append(d * mpu)
        # source vertices inside the tile, of polygons that the output covers at all
        to = STRtree(out_polys)
        tl = STRtree(out_lines)
        for p in src:
            c = np.concatenate([np.asarray(r.coords)[:-1] for r in [p.exterior] + list(p.interiors)])
            mm = (c[:, 0] > x0 + 1) & (c[:, 0] < x1 - 1) & (c[:, 1] > y0 + 1) & (c[:, 1] < y1 - 1)
            if not mm.any() or p.area < 32: continue
            if len(to.query(p, predicate='intersects')) == 0: dropped += 1; continue
            _, d = tl.query_nearest(shapely.points(c[mm]), return_distance=True, all_matches=False)
            s2o.append(d * mpu)
    o2s = np.concatenate(o2s) if o2s else np.zeros(1)
    s2o = np.concatenate(s2o) if s2o else np.zeros(1)
    return dict(rings=nrings, verts=nverts, o2s_max=float(o2s.max()), o2s_mean=float(o2s.mean()),
                o2s_p99=float(np.percentile(o2s, 99)), s2o_max=float(s2o.max()), s2o_mean=float(s2o.mean()),
                s2o_p99=float(np.percentile(s2o, 99)), dropped=dropped)


def fmt(r):
    return (f"rings {r['rings']:6d} verts {r['verts']:7d} ({r['verts']/max(1,r['rings']):.2f}/ring) | "
            f"out->src max {r['o2s_max']:.2f} p99 {r['o2s_p99']:.2f} mean {r['o2s_mean']:.3f} m | "
            f"src->out max {r['s2o_max']:.2f} p99 {r['s2o_p99']:.2f} mean {r['s2o_mean']:.3f} m | dropped {r['dropped']}")


def deflate(b):
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    return len(c.compress(bytes(b)) + c.flush())


def zig(n): return 2 * n if n >= 0 else -2 * n - 1


def varints(arr):
    o = bytearray()
    for v in arr:
        v = int(v)
        assert v >= 0, v
        while v >= 128:
            o.append((v & 127) | 128); v >>= 7
        o.append(v)
    return o


def load_cached():
    import pickle
    polys, union = pickle.load(open(os.path.join(HERE, 'src.pkl'), 'rb'))
    return shapely.from_wkb(polys), shapely.from_wkb(union)


def build_plain(union, tol=0.0, min_area=32.0, grid=1.0, keys=None, pre=None):
    """Planetiler-like: merged buildings, drop < min_area (units^2), clip tile+buffer, DP simplify tol (units), snap to grid.
    grid=2 gives an extent-8192 layer. pre(polys) may transform the merged polygons first."""
    keys = keys or tiles()
    parts = [p for p in polys_of(union) if p.area >= min_area]
    if pre: parts = pre(parts)
    tree = STRtree(parts)
    res = {}
    for key in keys:
        tb = tile_box(key, BUF)
        idx = tree.query(tb)
        sel = [parts[i] for i in idx]
        g = shapely.intersection(shapely.union_all(sel) if pre else shapely.MultiPolygon([q for p in sel for q in polys_of(p)]), tb)
        if tol > 0: g = shapely.simplify(g, tol, preserve_topology=True)
        _, tx, ty = map(int, key.split('/'))
        loc = shapely.affinity.affine_transform(g, [grid, 0, 0, grid, -tx * EXT * grid, -ty * EXT * grid])
        loc = shapely.set_precision(loc, 1.0)
        loc = shapely.affinity.affine_transform(loc, [1 / grid, 0, 0, 1 / grid, tx * EXT, ty * EXT])
        rings = to_local_rings(loc, key, grid)
        res[key] = {'extent': int(EXT * grid), 'rings': rings}
    return res

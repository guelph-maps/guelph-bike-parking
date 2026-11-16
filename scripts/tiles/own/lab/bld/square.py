# Squaring: fit an orthogonal polygon (one angle, alternating axis-parallel edges) to a ring.
import math
import numpy as np
import shapely
from shapely.geometry import Polygon, LineString

MPU = 0.866  # metres per level-13 unit in Guelph (0.864-0.868 across the tiles)


def dp(c, tol):
    """Douglas-Peucker on a closed ring c (n,2, no closing point); returns kept coords."""
    r = shapely.simplify(shapely.linearrings(np.vstack([c, c[:1]])), tol)
    k = np.asarray(r.coords)[:-1]
    return k if len(k) >= 3 else c


def dominant_angle(c):
    e = np.roll(c, -1, axis=0) - c
    L = np.hypot(e[:, 0], e[:, 1]); a = np.arctan2(e[:, 1], e[:, 0])
    th = 0.25 * math.atan2(np.sum(L * np.sin(4 * a)), np.sum(L * np.cos(4 * a)))
    return th % (math.pi / 2)


def rot(c, th):
    cs, sn = math.cos(th), math.sin(th)
    return np.stack([c[:, 0] * cs + c[:, 1] * sn, -c[:, 0] * sn + c[:, 1] * cs], 1)


def unrot(c, th):
    return rot(c, -th)


def square_ring(c, th, maxdev_deg=25):
    """c: ring (n,2) world units. Returns (axis0, lines) in the frame rotated by th, or None.
    lines[k] is the v of an H line (axis 0) or u of a V line (axis 1); groups alternate starting with axis0.
    Corners: between group k and k+1."""
    r = rot(c, th)
    n = len(r)
    e = np.roll(r, -1, axis=0) - r
    L = np.hypot(e[:, 0], e[:, 1])
    ax = (np.abs(e[:, 1]) > np.abs(e[:, 0])).astype(int)
    dev = np.degrees(np.arctan2(np.minimum(np.abs(e[:, 0]), np.abs(e[:, 1])), np.maximum(np.abs(e[:, 0]), np.abs(e[:, 1]))))
    if np.any((dev > maxdev_deg) & (L > 1e-9)): return None
    # rotate start so that edge 0 starts a group
    starts = [i for i in range(n) if ax[i] != ax[i - 1]]
    if len(starts) < 4 or len(starts) % 2: return None
    groups = []
    for gi, s in enumerate(starts):
        t = starts[(gi + 1) % len(starts)]
        idx = [(s + j) % n for j in range((t - s) % n or n)]
        a = ax[s]
        # weighted mean of the perpendicular coordinate along the group's edges (midpoints weighted by length)
        num = den = 0.0
        for i in idx:
            j = (i + 1) % n
            mid = (r[i] + r[j]) / 2
            w = L[i] + 1e-9
            num += w * (mid[1] if a == 0 else mid[0]); den += w
        groups.append((a, num / den, s))
    return groups


def groups_to_ring(groups, th):
    """Corners in world units from alternating groups."""
    pts = []
    m = len(groups)
    for k in range(m):
        a, val, _ = groups[k]
        a2, val2, _ = groups[(k + 1) % m]
        # corner at end of group k: intersection of line k and line k+1
        if a == 0: pts.append((val2, val))   # H line v=val, V line u=val2
        else: pts.append((val, val2))
    return unrot(np.array(pts), th)


def ring_dev(a, b):
    """max of directed distances vertex->boundary both ways, world units."""
    la, lb = shapely.linearrings(np.vstack([a, a[:1]])), shapely.linearrings(np.vstack([b, b[:1]]))
    d1 = shapely.distance(shapely.points(a), lb).max()
    d2 = shapely.distance(shapely.points(b), la).max()
    return max(d1, d2)


def square_polygon(p, tol_units, pre_dp=0.1 / MPU):
    """Square a shapely polygon (outer + holes share the angle). Returns (theta, [rings of groups]) or None."""
    rings = [np.asarray(p.exterior.coords)[:-1]] + [np.asarray(i.coords)[:-1] for i in p.interiors]
    rings = [dp(c, pre_dp) for c in rings]
    th = dominant_angle(rings[0])
    out = []
    for c in rings:
        g = square_ring(c, th)
        if g is None: return None
        sq = groups_to_ring(g, th)
        if ring_dev(c, sq) > tol_units: return None
        out.append((g, sq))
    return th, out

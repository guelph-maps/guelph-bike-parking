# Build the merged source (union of OSM buildings, world units) once, cache it, and measure reference builds.
import sys, json, time, pickle, os, shapely
from bldlib import *
t = time.time()
if not os.path.exists('src.pkl'):
    polys = load_source()
    union = shapely.unary_union(polys)
    pickle.dump((shapely.to_wkb(polys), shapely.to_wkb(union)), open('src.pkl', 'wb'))
    print('source', len(polys), 'polys; union parts', len(polys_of(union)), f'{time.time()-t:.0f}s')
polys, union = pickle.load(open('src.pkl', 'rb')); union = shapely.from_wkb(union)
for f in sys.argv[1:]:
    v = json.load(open(f))
    print(f, fmt(measure(v, union)), flush=True)

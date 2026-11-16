# usage: python var_enc.py NAME '{"g":0.25,...}' [one]  -> prints sizes + displacement, writes c-NAME.json (ext-8192 MVT rings)
import sys, json, time
from bldlib import *
from enc import *
polys, union = load_cached()
name, kw = sys.argv[1], json.loads(sys.argv[2])
keys = ['13/2270/2993'] if len(sys.argv) > 3 else tiles()
t = time.time()
r, v = run(Enc(**kw), union, keys)
fv, mv = float_variant(v), to_mvt_variant(v)
json.dump(mv, open(f'c-{name}.json', 'w'))
print(f"{name} {kw} sep {r['sep']/1e3:.1f} kB cat {r['cat']/1e3:.1f} kB orth {r['orth']} gen {r['gen']} per {r['per']} {time.time()-t:.0f}s\n"
      f"  float : {fmt(measure(fv, union, keys))}\n  ext8k : {fmt(measure(mv, union, keys))}", flush=True)

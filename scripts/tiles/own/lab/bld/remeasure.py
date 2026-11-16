import sys, json
from multiprocessing import Pool
from bldlib import *
def one(f):
    polys, union = load_cached()
    return f + ' ' + fmt(measure(json.load(open(f)), union))
if __name__ == '__main__':
    with Pool(12) as p:
        for r in p.map(one, sys.argv[1:]): print(r, flush=True)

"""Refit the included unit or phase observations using only Python's stdlib."""
import argparse
import collections
import json
import statistics
from pathlib import Path

def solve(a,b):
    n=len(b)
    m=[list(row)+[rhs] for row,rhs in zip(a,b)]
    for i in range(n):
        k=max(range(i,n),key=lambda k:abs(m[k][i]))
        m[i],m[k]=m[k],m[i]
        factor=m[i][i]
        if abs(factor)<1e-12: raise ValueError('singular')
        m[i]=[v/factor for v in m[i]]
        for j in range(n):
            if j==i:continue
            factor=m[j][i]
            m[j]=[v-factor*w for v,w in zip(m[j],m[i])]
    return [row[-1] for row in m]

def fit(rows,products):
    names=['intercept','R/800','P/200','E/1000']
    if products:names+=['RP/160000','RE/800000','PE/200000']
    xs=[];ys=[]
    for r,p,e,y in rows:
        r,p,e=r/800,p/200,e/1000
        xs.append([1,r,p,e]+([r*p,r*e,p*e] if products else []));ys.append(y)
    n=len(names)
    a=[[sum(x[i]*x[j] for x in xs) for j in range(n)] for i in range(n)]
    b=[sum(x[i]*y for x,y in zip(xs,ys)) for i in range(n)]
    coeff=solve(a,b)
    residual=[y-sum(c*v for c,v in zip(coeff,x)) for x,y in zip(xs,ys)]
    rss=sum(v*v for v in residual)
    return dict(coefficientsMs=dict(zip(names,coeff)),rmseMs=(rss/len(rows))**.5,rSquared=1-rss/sum((y-statistics.mean(ys))**2 for y in ys))


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("evidence", type=Path)
args = parser.parse_args()
data = json.loads(args.evidence.read_text(encoding="utf-8"))
if "raw" in data:
    import re
    grouped = collections.defaultdict(list)
    for row in data["raw"]:
        match = re.fullmatch(r"exact R=(\d+) P=(\d+) E=(\d+) (\w+)", row["name"])
        if match:
            r, p, e = map(int, match.group(1, 2, 3))
            grouped[(row["arm"], r, p, e, match.group(4))].append(row["p75Ms"])
    rows = [dict(arm=arm, R=r, P=p, E=e, phase=phase, ms=statistics.median(values))
            for (arm, r, p, e, phase), values in grouped.items()]
else:
    rows = [dict(row, ms=statistics.median(row["rawMs"])) for row in data["rows"]]
models = {}
for arm, phase in sorted({(row["arm"], row["phase"]) for row in rows}):
    values = [(row["R"], row["P"], row["E"], row["ms"])
              for row in rows if (row["arm"], row["phase"]) == (arm, phase)]
    models[arm+" "+phase] = {"additive": fit(values, False), "withProducts": fit(values, True)}
print(json.dumps(models, indent=2))

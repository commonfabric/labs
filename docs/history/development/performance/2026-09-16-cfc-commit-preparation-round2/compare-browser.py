import json,glob,os,hashlib,sys

def normalized(x):
 ids={}
 # This fixture runs in one fresh harness space. Reject cross-space data
 # rather than independently renaming spaces and losing address placement.
 spaces=set()
 def collect_spaces(v):
  if isinstance(v,list):
   for y in v:collect_spaces(y)
  elif isinstance(v,dict):
   for k,y in v.items():
    if k=='space' and isinstance(y,str):spaces.add(y)
    else:collect_spaces(y)
 payload={k:x[k] for k in ['label','count','contents','sourceLabel','resolvedLabels','strictReason','elementLabels']}
 collect_spaces(payload)
 if len(spaces)!=1:raise ValueError('Expected exactly one harness space')
 harness_space=next(iter(spaces))
 def visit(v):
  if isinstance(v,list):return [visit(y) for y in v]
  if isinstance(v,dict):
   r={}
   for k in sorted(v):
    y=v[k]
    if k=='id' and v.get('space')==harness_space and isinstance(y,str) and y.startswith('of:'):
     r[k]=ids.setdefault(y,f'<ref{len(ids)}>')
    elif k=='space' and y==harness_space:r[k]='<harness-space>'
    else:r[k]=visit(y)
   return r
  return v
 return visit(payload)
def sha(x):return hashlib.sha256(json.dumps(x,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def diff(a,b,p=''):
 if type(a)!=type(b):return [p,a,b]
 if isinstance(a,dict):
  if set(a)!=set(b):return [p+'/keys',list(a),list(b)]
  for k in a:
   d=diff(a[k],b[k],p+'/'+k)
   if d:return d
 elif isinstance(a,list):
  if len(a)!=len(b):return [p+'/length',len(a),len(b)]
  for i,(x,y) in enumerate(zip(a,b)):
   d=diff(x,y,p+'/'+str(i))
   if d:return d
 elif a!=b:return [p,a,b]
 return None
if __name__=='__main__':
 baseline,final=sys.argv[1:]; checks=[]
 left={os.path.basename(p) for p in glob.glob(baseline+'/n*-r*.json')}
 right={os.path.basename(p) for p in glob.glob(final+'/n*-r*.json')}
 if not left or left!=right:raise SystemExit('Expected matching, nonempty observation sets')
 for path in sorted(glob.glob(baseline+'/n*-r*.json')):
  peer=final+'/'+os.path.basename(path)
  if not os.path.exists(peer):continue
  with open(path,encoding='utf-8') as stream:a=json.load(stream)
  with open(peer,encoding='utf-8') as stream:b=json.load(stream)
  na=normalized(a);nb=normalized(b)
  checks.append({'label':a['label'],'elements':a['count'],'equal':na==nb,'baselineSha256':sha(na),'finalSha256':sha(nb),'firstDifference':diff(na,nb)})
 print(json.dumps({'pairs':checks,'allEqual':all(x['equal'] for x in checks),'pairCount':len(checks)},indent=2))

 if not all(x['equal'] for x in checks):sys.exit(1)

"""Summarize raw phase timings and sample self time without combining profiles with wall runs."""
import collections,json,pathlib,statistics,sys
root=pathlib.Path(sys.argv[1])
rows=json.loads((root/'raw.json').read_text(encoding="utf-8"))
for n in [11,50,150]:
    for field in ['copyMs','renderMs','groupMs']:
        vals={arm:[r[field] for r in rows if r['n']==n and r['arm']==arm and not r['profile']] for arm in ['before','after']}
        print(n,field,{a:{'raw':[round(v,3) for v in vs],'median':round(statistics.median(vs),3)} for a,vs in vals.items()})
profiles=[]
for path in sorted(root.glob('profile-*-*-*.cpuprofile')):
    _,rep,arm,phase=path.stem.split('-',3)
    p=json.loads(path.read_text(encoding="utf-8"));nodes={node['id']:node for node in p['nodes']};parent={child:node['id'] for node in p['nodes'] for child in node.get('children',[])}
    self_us=collections.Counter(); inclusive_us=collections.Counter();busy=0
    for sample,delta in zip(p.get('samples',[]),p.get('timeDeltas',[])):
        name=nodes[sample]['callFrame']['functionName'];self_us[name]+=delta
        if name!='(idle)':busy+=delta
        ancestor=sample;names=set()
        while ancestor in nodes:
            names.add(nodes[ancestor]['callFrame']['functionName']);ancestor=parent.get(ancestor)
        for name in names:inclusive_us[name]+=delta
    report=dict(repetition=int(rep),arm=arm,phase=phase,busyMs=busy/1000,wallMs=(p['endTime']-p['startTime'])/1000,
        describeSelfMs=self_us['describeRefusalInputs']/1000,collectSelfMs=self_us['collectConsumedLabel']/1000,
        describeInclusiveMs=inclusive_us['describeRefusalInputs']/1000,collectInclusiveMs=inclusive_us['collectConsumedLabel']/1000)
    profiles.append(report)
(root/'profiles.json').write_text(json.dumps(profiles,indent=2)+'\n',encoding='utf-8')
for phase in ['action_3','action_5','action_7','render_1','render_2','render_3']:
    for arm in ['before','after']:
        data=[p for p in profiles if p['phase']==phase and p['arm']==arm]
        if data:print('profile',phase,arm,{key:round(statistics.median(p[key] for p in data),3) for key in ['busyMs','describeSelfMs','collectSelfMs','describeInclusiveMs','collectInclusiveMs']})

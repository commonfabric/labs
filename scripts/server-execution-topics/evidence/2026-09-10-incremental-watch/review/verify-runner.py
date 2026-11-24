"""Verify source admission and atomic binary replacement in disposable fixtures."""
from pathlib import Path
import subprocess,tempfile,os,json,hashlib,shutil,sys
repo=Path(sys.argv[1]).resolve()
out=Path(sys.argv[2]).resolve();out.mkdir()
runner=(repo/'tools/server-execution-topics/run-arm.ts').read_bytes();(out/'run-arm.ts.txt').write_bytes(runner)
env=os.environ.copy();env.update(GIT_CONFIG_GLOBAL='/dev/null',GIT_CONFIG_NOSYSTEM='1')
runtime=subprocess.check_output(['deno','--version'],text=True).strip()
rows=[]
for role in ['default','opposite']:
 env['EXPERIMENTAL_SERVER_EXECUTION']='true' if role=='default' else 'false'
 for scenario in ['dirty','untracked','stale-binary','build-failure','source-change']:
  w=Path(tempfile.mkdtemp(prefix='watch-runner-control-'))
  try:
   files={'tools/server-execution-topics/run-arm.ts':runner.decode(),
    'tools/server-execution-topics/seed-check.ts':'// synthetic fixture\n',
    'packages/patterns/integration/topic-board-fixture.ts':'// synthetic fixture\n',
    'tracked.txt':'original\n',
    '.gitignore':'dist/\n.ci-cache/\n',
    'deno.json':json.dumps({'imports':{'@std/path':'https://jsr.io/@std/path/1.1.4/mod.ts'},'tasks':{'build-binaries':'deno run -A build.ts'}}),
    'tasks/ci-capabilities.ts':'''export type CapabilityId = string; export type Exec = (c:string,a:readonly string[],o?:{cwd?:string;env?:Record<string,string>})=>Promise<string>; export async function openCapabilities(..._:unknown[]):Promise<{envFor:(x:unknown)=>Record<string,string>;close:()=>Promise<void>}> {throw new Error("STOP_AFTER_BUILD");}''',
    'tasks/server-execution-ci.ts':'''export function serverExecutionCiLane(role:string){return {experimentalValue:role==="opposite"?"true":undefined};} export function assertServerExecutionCiPosture(..._:unknown[]){}''',
    'build.ts':'''await Deno.mkdir("dist",{recursive:true}); await Deno.writeTextFile("dist/toolshed", "fresh:"+Deno.env.get("COMMIT_SHA")+":"+(Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION")??"unset"));'''+ ('throw new Error("BUILD_FAILED");' if scenario=='build-failure' else 'await Deno.writeTextFile("tracked.txt","changed");' if scenario=='source-change' else '')}
   for n,s in files.items():p=w/n;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(s)
   for cmd in [['git','init','-q'],['git','add','.'],['git','-c','user.name=Control','-c','user.email=control@example.invalid','-c','commit.gpgsign=false','commit','-qm','fixture']]:subprocess.run(cmd,cwd=w,env=env,check=True,stdout=subprocess.DEVNULL)
   head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=w,env=env,text=True).strip()
   binary=w/f'.ci-cache/binaries/toolshed-baked-{role}';binary.parent.mkdir(parents=True);binary.write_text('stale')
   if scenario=='dirty':(w/'tracked.txt').write_text('dirty')
   if scenario=='untracked':(w/'extra.ts').write_text('untracked')
   dest=out/f'{role}-{scenario}'
   cmd=['deno','run','--no-lock','-A','tools/server-execution-topics/run-arm.ts',role,str(dest),'correctness','eval','0']
   r=subprocess.run(cmd,cwd=w,env=env,capture_output=True,text=True)
   (out/f'{role}-{scenario}.stdout').write_text(r.stdout);(out/f'{role}-{scenario}.stderr').write_text(r.stderr)
   expected='clean tracked checkout' if scenario in ['dirty','untracked'] else 'STOP_AFTER_BUILD' if scenario=='stale-binary' else 'changed during the toolshed build' if scenario=='source-change' else 'Setup command'
   assert r.returncode!=0 and expected in r.stderr,(scenario,r.stderr)
   value=binary.read_text()
   assert value==('fresh:'+head+(':'+('true' if role=='opposite' else 'unset')) if scenario=='stale-binary' else 'stale'),(scenario,value)
   rows.append({'role':role,'scenario':scenario,'exitCode':r.returncode,'expectedError':expected,'oldBinaryPreserved':value=='stale','head':head,'command':cmd})
  finally:shutil.rmtree(w)
(out/'manifest.json').write_text(json.dumps({'runtime':runtime,'runnerSha256':hashlib.sha256(runner).hexdigest(),'controls':rows},indent=2)+'\n')
print('10 source/build controls passed')

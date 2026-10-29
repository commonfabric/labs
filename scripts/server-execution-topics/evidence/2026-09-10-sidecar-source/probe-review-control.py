"""Exercise the exact captured/current probes with controlled setup failures."""
from pathlib import Path
import hashlib, json, os, re, subprocess, sys, tempfile
from urllib.parse import urljoin

repo = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
if output.is_relative_to(repo):
    raise ValueError("The output directory must be outside the checkout")
output.mkdir()
probe = repo / 'tools/server-execution-topics/sidecar-source-probe.ts'
captured = probe.parent / 'evidence/2026-09-10-sidecar-source/captured-probe.ts.txt'
rows = []
with tempfile.TemporaryDirectory(prefix='sidecar probe review ') as temporary:
    parent = Path(temporary)
    alias = parent / 'checkout é'
    alias.symlink_to(repo, target_is_directory=True)
    for variant, path in [('captured', captured), ('current', probe)]:
        exact = path.read_text(encoding='utf-8')
        # Relative module imports retain their captured checkout resolution.
        imports_fixed = re.sub(r'from "(\.\.?/[^\"]+)"', lambda m: 'from '+json.dumps(urljoin(probe.as_uri(),m[1])), exact)
        for case in ['path', 'construction', 'posture', 'flush']:
            source = imports_fixed.replace('import.meta.url', json.dumps((alias / probe.relative_to(repo)).as_uri() if case == 'path' else probe.as_uri()))
            if case != 'path':
                source = source.replace('[false, true]', '[true]')
                marker = 'const manager = EmulatedStorageManager.emulate({ as: signer });'
                source = source.replace(marker, marker+'''
__manager = manager;
const __close = manager.close.bind(manager);
manager.close = async (...args) => { __closed++; return await __close(...args); };
''',1)
                marker = 'expect(runtime.experimental.serverExecution).toBe(enabled);'
                instrumentation = '''
__dispose = runtime.dispose.bind(runtime);
runtime.dispose = async (...args) => { __disposed++; return await __dispose(...args); };
'''
                if case == 'posture': instrumentation += 'throw new Error("controlled setup failure");\n'
                if case == 'flush': instrumentation += 'runtime.patternManager.flushCompileCacheWrites = async () => { throw new Error("controlled setup failure"); };\n'
                assert marker in source
                source = source.replace(marker,instrumentation+marker,1)
                if case == 'construction':
                    marker = 'const runtime = new Runtime' if variant == 'captured' else 'runtime = new Runtime'
                    assert marker in source
                    source = source.replace(marker, 'throw new Error("controlled setup failure");\n'+marker,1)
                header, body = source.split('const signer =',1)
                source = header+'import { getServerExecutionConfig } from "@commonfabric/memory/v2";\n'+'''
let __disposed=0, __closed=0, __manager, __dispose, __error;
try {
const signer ='''+body+'''
} catch (error) { __error=String(error); }
console.log(JSON.stringify({ case: "CASE", disposed:__disposed, closed:__closed, enabled:getServerExecutionConfig(), error:__error }));
await __dispose?.();
await __manager?.close();
'''.replace('CASE',case)
            script = output / f'{variant}-{case}.ts.txt'
            script.write_bytes(source.encode('utf-8'))
            runnable = parent / 'case.ts'
            runnable.write_bytes(source.encode('utf-8'))
            command = ['deno','run','--no-check','--frozen','--config',str(repo/'deno.jsonc'),'-A',str(runnable)]
            env = os.environ.copy(); env.pop('EXPERIMENTAL_SERVER_EXECUTION',None)
            process = subprocess.run(command,cwd=repo,env=env,capture_output=True)
            (output/f'{variant}-{case}.stdout').write_bytes(process.stdout)
            (output/f'{variant}-{case}.stderr').write_bytes(process.stderr)
            row={'variant':variant,'case':case,'sourceSha256':hashlib.sha256(exact.encode()).hexdigest(),'injectedSourceSha256':hashlib.sha256(source.encode()).hexdigest(),'command':command,'exitCode':process.returncode}
            if case == 'path':
                assert (process.returncode==0)==(variant=='current'),process.stderr.decode(errors='replace')[-1000:]
                row['passed']=process.returncode==0
                if variant=='current':assert len([line for line in process.stdout.splitlines() if line.startswith(b'{"enabled"')])==2
                else:assert b'NotFound' in process.stderr or b'not found' in process.stderr
            else:
                assert process.returncode==0,process.stderr.decode(errors='replace')[-1500:]
                observed=json.loads([line for line in process.stdout.splitlines() if line.startswith(b'{"case"')][-1]);row['observed']=observed
                assert 'controlled setup failure' in observed['error']
                if variant=='current':
                    assert observed['closed']==1 and observed['enabled'] is False,observed
                    assert observed['disposed']==(0 if case=='construction' else 1),observed
                else:
                    assert observed['closed']==0 and observed['disposed']==0,observed
                    assert observed['enabled']==(case!='construction'),observed
            rows.append(row)
            (output/'results.json').write_bytes((json.dumps(rows,indent=2)+'\n').encode('utf-8'))
            print(variant,case,'observed expected outcome',flush=True)

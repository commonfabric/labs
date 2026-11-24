# Caller-demand evidence

`artifact-bundle.json` contains the UTF-8 bytes of every artifact named in
`manifest.json`, including raw results, run manifests, exact patches, and source
snapshots. JSON string encoding preserves patch context spaces and line endings.
The historical report's author-local directory is the original capture location;
verification and extraction use this bundle alone, from any checkout.

Verify all recorded SHA-256 hashes without creating files:

```sh
python3 tools/server-execution-topics/evidence/2026-09-10-narrow-demand/verify.py
```

Extract verified bytes to a new directory outside the checkout for replay:

```sh
python3 tools/server-execution-topics/evidence/2026-09-10-narrow-demand/verify.py --extract /absolute/new-directory
```

`artifactRoot` names the default directory relative to this evidence directory
for consumers that unpack the bundle themselves. The verifier requires an
absolute destination outside its checkout and refuses an existing directory.

For replay, restore the run manifest's workload head, then its recorded source
snapshots and patch. Use that manifest's commands and environment, replacing
capture-machine paths with the restored checkout and a new output directory. The
profiling health patch is included in the worktree patches. Deno and server
build versions, experimental flags, synthetic fixture shape, cache state, and
load observations remain recorded per run. Profiling runs do not establish
latency; correctness runs do not qualify busy-machine timings.

The bundles contain no binaries, credentials, or real user payloads. The
original synthetic stores and generated binaries are outside this compact
evidence set; rebuild binaries from the recorded head and build posture.

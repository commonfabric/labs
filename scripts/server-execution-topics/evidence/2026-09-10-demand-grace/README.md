# Demand grace evidence

The runnable probe is `tools/server-execution-topics/demand-grace-probe.ts`. It
uses a fresh in-memory store, a real SpaceServer and serving runtime, and three
plain durable roots. A demand-provider facade supplies the roots. The probe
holds the callback scheduled by `noteDemandChanged` and waits for the loop's
input-wait registration between phases. Other timers run normally; assertions
require zero deadline firings, zero exhausted cycles, and zero input-backstop
firings. It measures a controlled schedule, not latency.

From the checkout root, with the repository's Deno pin:

```sh
python3 tools/server-execution-topics/evidence/2026-09-10-demand-grace/capture-grace-probe.py \
  "$PWD" /absolute/path/to/new-output-directory
```

The output directory must not exist and must be outside the checkout. The
controller records the head, complete tracked patch, helper bytes, source
checks, runtime version, load, command, and raw output hashes. Integrity checks
remain active under Python optimization. Runtime discovery and probe execution
both invoke `deno` directly from the same environment; the controller requires
no login shell. It rejects a tracked-source or helper mutation during capture.
The probe asserts its serving posture. This mechanism rig has no browser, baked
shell, or separate client; those postures belong to the campaign's separate
integration lanes.

`captured-capture-grace-probe.py.txt` preserves the exact controller identified
by the historical manifests. That captured controller uses `zsh` for runtime
discovery; use the runnable controller above for a new portable capture.

`current-3aee-*` records the capture at
`3aee034aff7672391bf037a4eba44d9d279cb986`, with `candidate.patch` (comments and
specifications only). To replay its exact inputs, create a disposable worktree
at that commit, apply the patch, and copy `current-3aee-probe.ts.txt` to
`tools/server-execution-topics/demand-grace-probe.ts`. The current runnable
probe is the default for a new check; the captured file remains the exact
measurement input. `historical-d664-*` preserves the earlier probe and results
at the head recorded in its manifest. Its cleanup calls manager close twice; the
current helper delegates closure once and protects timer restoration. The
current runnable probe additionally asserts exactly two demand passes, unchanged
wave closures, and unchanged engine sequence for the held burst. The captured
probe's weaker assertion remains part of its exact historical input; its
recorded snapshots supply those values independently.

The captured results contain synthetic identities and original local paths.
Those paths are provenance observations, not replay configuration: supply a new
checkout and output directory to the command above. Paths in stack frames
identify measured call sites; supply your checkout path when replaying. Each
manifest names its durable capture directory. Full logs and validation outputs
are retained under
`/Users/berni/.codex/artifacts/server-execution-topics-2026-09-09/`.
`external-artifacts.json` gives relative retrieval paths and SHA-256 hashes;
join each path to that root and verify it before use. Compact results and
captured inputs are also committed here, so the mechanism is reproducible
without those full logs. `SHA256SUMS` covers the compact captured files.

`runtime-bytes.json` records equal comment-free TypeScript emission for the two
runtime source files. `captured-verify-runtime-bytes.ts.txt` preserves the exact
standalone script used for that comparison, including its pinned compiler
import. Its input files also passed the repository type check. This captured
script does not reject parse diagnostics and is archival evidence rather than
the verifier for new comparisons. Use the current verifier, which rejects
transpile diagnostics:

```sh
deno run --allow-read --allow-env tasks/verify-runtime-bytes.ts \
  /absolute/path/to/first-source.ts /absolute/path/to/second-source.ts
```

The verifier emits one JSON row per input, containing the comment-free emission.
TypeScript reads its process environment during initialization.

The historical report records the decision at capture time. Current PR check and
review status belongs in the PR and campaign ledger. None of these captures
qualifies as a quiet paired latency measurement or a full multi-user fairness
measurement.

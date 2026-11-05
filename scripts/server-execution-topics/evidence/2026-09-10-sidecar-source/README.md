# Sidecar source verification artifacts

Run the source-work probe from a checkout with the intended implementation:

```sh
deno run -A tools/server-execution-topics/sidecar-source-probe.ts
```

It opens four distinct profile-create slots (three in one space, one in a second
space), reopens each slot, and verifies every destination source closure. Each
OFF/ON arm gets a fresh emulated store and runtime. The probe asserts the actual
runtime and serving posture. It uses the real pattern route with a prewarmed
identity endpoint; source responses are counted, so this is an instrumented
mechanism probe, not an end-to-end latency benchmark.

For a portable rerun, create an isolated worktree at the `head` in
`baseline-manifest.json` and copy the current runnable probe to the same
relative path there. Apply `candidate.patch` to a separate copy of that base for
the candidate. Use the same probe bytes in both variants and record their new
hash; this rerun uses the current path conversion and setup cleanup.

For an exact historical replay, copy `captured-probe.ts.txt` to that relative
path instead. That file is the immutable input used by both captures, with its
original hash. It requires a checkout path without spaces or non-ASCII
characters because it passes a URL pathname directly to the filesystem. Its
setup assertions also precede its cleanup block. The current runnable probe
corrects both limitations and disposes resources even when setup or a cache
flush fails. Historical inputs are retained as evidence; they are not the
recommended runnable version. `candidate-manifest.json` identifies the base,
exact candidate patch, and file hashes. The source-work comparison uses
identical captured probes.

The review controls exercise the exact captured and current source with injected
construction, posture, and flush failures, and with a checkout alias containing
spaces and Unicode. They also verify release of the process-global serving flag.
Run them from this PR's checkout, with a new output directory outside it:

```sh
python3 tools/server-execution-topics/evidence/2026-09-10-sidecar-source/probe-review-control.py "$PWD" /absolute/outside-checkout/probe-review
```

The checked-in `probe-review-results.json` summarizes the eight expected
red/green outcomes. A new replay writes its raw case rows to `results.json` in
the requested output directory, alongside each injected source and its hash. The
cleanup cases require exactly one manager close. Runtime disposal keeps storage
open, and the probe closes the manager afterward.

For the red regression, apply `regression.patch` alone to a fresh baseline and
run:

```sh
ENV=test deno test --no-check --preload=packages/runner/test/clock-preload.ts -A packages/runner/test/source-reconciler.test.ts
```

The baseline rejects the new source-sharing and disposal assertions. Run the
current test file on the candidate for green validation; it also contains the
owner-selected-origin control. `SHA256SUMS` covers these compact artifacts.
`external-artifacts.json` locates and hashes full process logs, original capture
manifests and orchestration scripts in durable storage. The normalized manifests
use named path roots; exact capture paths remain in the original manifests.
Server binaries, browser rendering, seeding, deadlines and watermark completion
are outside this probe. Use the campaign integration and benchmark lanes for
those questions.

---
status: historical
created: 2026-09-14
archived: 2026-09-14
reason: "Lazy-materialization retirement evidence from isolated integration runs on the eager posture."
---

# Lazy-off integration evidence

This record extends the
[rollout evidence](2026-09-11-lazy-materialization-f3-rollout-evidence.md) for
the
[lazy-materialization fast-follow](../../plans/lazy-materialization-fast-follow.md).
It does not retire the flag or change the handler deferral.

## Method

Base revision: `56ca922391`. One temporary experimental change sets
`this.experimental.lazyMaterialization ??= false` in `Runtime` construction. The
source change is necessary because direct constructors do not read the process
environment. Explicit experimental options retain their normal priority. This
change is used only in the isolated validation checkout and is restored before
publishing the record.

Every run also sets `EXPERIMENTAL_LAZY_MATERIALIZATION=false`, which the
toolshed and environment-aware clients consume. `EXPERIMENTAL_SERVER_EXECUTION`
is set explicitly for each run. `deno task integration <package>` starts and
cleans up local servers on generated ports. Storage is isolated under
`/tmp/b13-lazy-resume-memory`; all created spaces are test spaces. No live
pieces or production stores are updated.

The test transcript records resolved experimental overrides for deployed-client
paths. Runner tests that construct an in-process server without an executor
remain client-executed by construction, even in the served lane. The served
column therefore describes the lane, not a claim that every test executes
remotely.

## Results

| Suite                       | Server execution | Result                                                            |
| --------------------------- | ---------------- | ----------------------------------------------------------------- |
| Runner integrations         | Off              | 16 passed, 0 failed; test duration 11 seconds                     |
| Runner integrations         | On               | 16 passed, 0 failed; test duration 16 seconds                     |
| Runtime-client integrations | On               | 1 passed, 50 steps, 0 failed; test duration 1 minute 20 seconds   |
| Runtime-client integrations | Off              | 1 passed, 50 steps, 0 failed; test duration 26 seconds            |
| Shell/browser integrations  | On               | 11 passed, 29 steps, 0 failed; test duration 5 minutes 11 seconds |
| Shell/browser integrations  | Off              | 11 passed, 29 steps, 0 failed; test duration 2 minutes 20 seconds |

The completed integration commands exited successfully after their test
summaries and server cleanup. Durations are test-run observations, not
performance benchmarks or startup-inclusive timings.

## Limits and next gates

The runner memory test finds the first process matching `toolshed`. With several
local worktrees running, that may be a different server. Its passing assertion
is not reliable process-specific memory evidence for these runs; no memory
improvement is claimed.

These runs exercise the rollback posture; they do not resolve the previously
recorded eager-path unit-test differences, qualify field rollback, or establish
full product equivalence. The held synchronous lift-refusal fix is not included.
The vintage gate decision and the flag owner's retirement decision remain
separate requirements.

## Reproducing the selected matrix

In a disposable checkout of the named base revision, make the single temporary
default change above and run each package (`runner`, `runtime-client`, `shell`)
with each `EXPERIMENTAL_SERVER_EXECUTION` value (`false`, `true`). Set
`EXPERIMENTAL_LAZY_MATERIALIZATION=false`, `HEADLESS=true`, `HOST=127.0.0.1`,
and `MEMORY_DIR` to an isolated file URL. Invoke
`deno task integration <package>` without a fixed port offset so the task owns
generated ports and server cleanup. On macOS the shell suite requires a process
permitted to launch Chrome. Restore the temporary default only after every test
process and local server has stopped.

The completed logs are retained locally as
`/tmp/b13-lazy-resume-{runner,client,shell}[-served]-off.log`; the results above
are the repository record. Other integration packages, the authored pattern
corpus, and live fleet posture are not covered by this selected matrix.

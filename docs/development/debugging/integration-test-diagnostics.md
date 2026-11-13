# Browser Integration Test Diagnostics

The browser integration tests (`patterns/integration/`) are
**self-diagnosing on failure**: a `Timed out filling cf input …` or
`waitForCondition` timeout prints a probe that names the stuck layer. Read that
output before adding any instrumentation of your own.

What the failure probe contains, and where each piece lives:

- **The wait's own report** (`describeConditionWaitFailure`, in
  [`utils.ts`](../../../runtime/integration/utils.ts)) — the source the page
  ran, the arguments it was given one to a line, the last throw the predicate
  itself made, and the page it ran out against: document URL and title, response
  status, the view and identity `globalThis.app` holds, the messages the runtime
  worker has logged at `warn` or `error` with their counts, and the browser
  console tail. The worker's own console does not reach the page, so those
  counts are the report's view of the worker. Every `waitForCondition` renders
  this, in every suite; the rest of this list is what the patterns suite adds on
  top of it.
- **Fill phase ledger** (`__cfFillDiag`, in
  [`cfc-browser-helpers.ts`](../../../patterns/integration/cfc-browser-helpers.ts))
  — per-selector progress through the fill (settled → found → visible → filled
  → committed), naming the exact await that hung. A fill on a page that never
  exposes `commonfabric.viewSettled` stops at the settle and says so.
- **Host/bound-cell state** (`readCfInputProbe`, same file) — whether the
  `cf-input` host has a bound cell and a pending commit, alongside DOM
  value/visibility/disabled.
- **Main-thread pending IPC** (`RuntimeClient.getPendingRequests()`,
  [`runtime-client.ts`](../../../runtime/runtime-client/src/runtime-client.ts))
  — the runtime-client requests still awaiting a worker response; works even
  while the worker is wedged.
- **Worker request ledger** (`runtime-worker.ipc` counts, wired through
  [`connection.ts`](../../../runtime/runtime-client/src/client/connection.ts))
  — received/responded counts per request type. Because `postMessage` is
  FIFO, one failed run triangulates *never sent* vs *delivery starved* vs
  *response lost*.
- **Console tail + load summary** (`collectBrowserLoadSummary`) — bounded
  in-page console output, completed-IPC timing table, worker
  scheduler/runner/storage timings, and churn/conflict counters. Printed as
  post-test output on failures and by tests that opt in.

Everything above is the test process's account. The server's own is the
Toolshed log, and which half of the machinery ran the suite decides where it
comes from. A lane (`tasks/ci-lane.ts`) opens the server as a capability and
prints the end of that capability's log on its own output when the lane
fails. A lane inside a job whose tests or capabilities failed, or that excused
the failure of a test held back as flaky, keeps the work directory the log was
written in, under the job's temporary directory (`RUNNER_TEMP`), and the job
uploads it as its `lane-kept` artifact. In every other case the directory
goes when the lane ends. The workflow jobs that predate the lanes upload the
same file as an artifact, named for the job that wrote it.

With server execution on, a fresh runtime, such as the server's, loads a piece
created in another space (`.inSpace()`) from that space, and can do so only once
the pattern's program has been copied there; the session that created the piece
can load it without that copy. The Toolshed log records each copy the server
makes out of another space as `closure-replication-issued`, with its source and
target spaces and a ticket number, and then one line with the same ticket saying
how it ended: `closure-replication-committed` once its writes have been
accepted, `closure-replication-failed`, or `closure-copy-refused` for a copy a
load started into a space the session may only read. A serving wave can still
withdraw a write it accepted, which it logs as
`compile-cache-writeback-withdrawn` with the entry and the space. A space whose
piece never runs shows in that log whether its copy was never issued, was issued
and never ended, failed, was refused, or was withdrawn.

Local full-stack repro for CI-only integration failures (see
[LOCAL_DEV_SERVERS](../LOCAL_DEV_SERVERS.md) for the dev-server details):
run toolshed on an offset port, `SHELL_PORT=… TOOLSHED_PORT=… deno task
dev-local` in `runtime/shell`, then point the test at both with
`API_URL=… FRONTEND_URL=… deno test -A integration/<file>`. Without
`FRONTEND_URL` the shell is missing and every tree fails identically at
`goto` — a misleading non-repro.

## When the probe is not enough

The probe names the stuck layer; these siblings go deeper:

- [Debugging Settle Waves](settle-wave-investigation.md) — scripted trace
  capture for the default-app integration flow (`CF_CAPTURE_TRIGGER_TRACE=1`),
  Chrome performance traces, and the `commonfabric.rt` console workflow for
  inspecting the browser worker live (baselines, settle stats, trigger /
  action-run / write traces).
- [Console Commands](console-commands.md) — reading logger counts, timing
  baselines, and worker IPC from the page console.

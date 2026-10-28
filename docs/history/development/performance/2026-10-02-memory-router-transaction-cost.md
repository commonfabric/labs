---
status: historical
created: 2026-10-02
archived: 2026-10-02
reason: "Measured Mode A transaction costs, bounded backpressure and canonical DID/ACL-read optimizations."
---

# Memory router transaction latency and burst admission

The directory broker's fixed-window counter closed a public socket on its
501st request within one second. A diagnostic reproduction reached that limit
in 408.938 ms. Every space frame consulted the broker, including transactions
for an established session. The link agent had the same disconnect behavior
at 200 control requests per second.

Infra's replacement continuously refills the same budgets and allows an initial
burst of 500 directory or 200 control requests. Each handler retains one bounded
IPC request while waiting; the two link handlers share their context's budget
and release its mutex before waiting. Authority and directory checks happen
after admission. A single connection still reaches a sustained ceiling of 500
routed operations/s across its spaces. Its queue, CPU and liveness limits remain.

## Measured changes

The Labs comparison contains two production changes:

- `isCanonicalEd25519DID()` retains up to 4,096 successful canonical strings.
  Repeated strings avoid curve-point validation; FIFO eviction bounds retained
  state. Malformed values, signatures, authorization, ownership and leases do
  not receive cached decisions.
- An ordinary commit in an established space skips the genesis-only ACL read in
  `#validateAclCommit()`. Current ACL and ownership authorization still execute
  in the same admission turn, including routed `requireExplicitAcl` checks.
  ACL mutations and genesis keep their shape checks.

The exercise's response waits use message/close events. Removing the 5 ms polling
interval prevents the harness from imposing that latency floor. Both measured
arms already used identical event-driven waits, so the numbers below isolate the
two production changes.

## Boundary and provenance

Baseline Labs source: `5be861e915998efb109a8b784d87586d03be4502`, the companion
branch merged with `main` at `d108c7ba3f86c0d702b613e57218a05f7478cbb5`.
Both arms used the unchanged release router from infra
`94ca3ce036c3ecfcc22c94beb26edfc11782877c`.

The host was an Apple M3 Max with 16 cores. Measurements ran on aarch64 Linux
`6.12.76-linuxkit`, Deno 2.9.4 and systemd 257.13 in a disposable Docker VM.
Other host work was active. No build or test suite ran during primary timing.
Results are paired evidence on this host, not production capacity guarantees.

Each arm started fresh SQLite stores, processes and 32 authenticated public
connections. All clients used an existing ACL-backed space on one real toolshed,
with one outstanding transaction per client and a distinct document per session.
A transaction set one scalar. After 100 warmup transactions per client, the timer
covered 1,000 further transactions per client, from sending the first request
through consuming the last successful response: 32,000 total. Setup,
authentication and cleanup were outside the timer. Every response was checked.
Subscription refresh was manual; this workload included no pattern computation or
subscription fan-out. Toolshed CPU is user plus system time from `/proc`, at
100 ticks/s; it is separate from elapsed time and from router CPU.

The confirmed runs used an extracted immutable Git archive, actual file copies
for each arm and a source-hash manifest before each invocation. Earlier runs
used file bind mounts; a later host edit exposed a lost Docker file mount.
Those exploratory samples, including the failed page-size run, are excluded.

## Five counterbalanced pairs

Times are seconds. The order column gives the actual run order within each pair.

| Pair | Order | Before elapsed | After elapsed | Before toolshed CPU | After toolshed CPU |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Before, after | 24.873 | 17.922 | 22.21 | 13.90 |
| 2 | After, before | 20.289 | 15.816 | 15.79 | 12.12 |
| 3 | Before, after | 21.130 | 21.851 | 17.88 | 17.20 |
| 4 | After, before | 27.470 | 18.494 | 24.02 | 15.68 |
| 5 | Before, after | 22.001 | 18.906 | 18.24 | 14.61 |
| Median | | 22.001 | 18.494 | 18.24 | 14.61 |
| Minimum | | 20.289 | 15.816 | 15.79 | 12.12 |

Median elapsed time fell 15.9%; toolshed CPU fell 19.9%. The median of the
per-run mean client round trips fell from 21.994 to 18.485 ms at 32 concurrent
clients. The median of each run's p95 fell from 41.515 to 35.016 ms. Dividing
elapsed time by 32,000 gives 0.688 and 0.578 ms of aggregate wall time per
transaction; those values are inverse throughput, not a client's round trip.
Router CPU medians were 4.46 and 4.95 seconds; these Labs changes do not establish
a router CPU improvement. One pair had a slower optimized elapsed time.

## SQLite page-size experiment

A separate diagnostic traced 640 transactions after the same 3,200-write warmup.
`strace` recorded raw syscall arguments, avoiding payload dumps. Instrumented
elapsed times are excluded from latency claims. Fresh databases used either the
existing 32 KiB page default or an experimental 4 KiB default; ordinary WAL
`synchronous=NORMAL` and private metadata durability were unchanged.

| New database page size | `pwrite64` calls | Logical bytes written | Bytes/transaction | Sync calls |
| --- | ---: | ---: | ---: | ---: |
| 32 KiB | 16,118 | 269,870,016 | 421,672 | 24 |
| 4 KiB | 20,326 | 45,548,648 | 71,170 | 27 |

The small-write fixture wrote 83.1% fewer logical bytes with 4 KiB pages, with
26.1% more write calls. These are syscall byte counts, not physical SSD writes.
The shipped default stays 32 KiB: large documents, large scans, checkpoint
behavior and existing-store migration need representative comparison before
changing the storage specification. Exploratory 8 KiB timing was also noisy and
is insufficient to choose a default.

## Reproduction artifacts

The task's raw results and throwaway harness remain in
`/tmp/memory-router-tx-opt/`: `snapshot-samples.json`,
`snapshot-{before,after}-{0..4}.jsonl`, corresponding `.sources` manifests,
`exercise.ts`, `page-trace.ts`, `page-write-accounting.json`, `trace-*.strace`,
and `metadata.json`. They are local investigation artifacts.

The harness SHA-256 was
`987248b4944d5657bf792f9ef0436d3edf6dcc0f7dde368e2cf56c4421255e4d`.
The source archive SHA-256 was
`971047ac28838921615ec82b7bf0d28a7a086e259ba26df43b7d19585bbeeb50`.

To reproduce the workload, use the disposable infra systemd exercise with this
Labs companion, an event-driven `Client.take()`, fresh stores for each arm and
32 established sessions. Warm each with 100 scalar-set transactions, then time
1,000 more per session concurrently. Alternate the two production changes while
holding the router binary, flags, authentication, documents, transaction count
and wait implementation fixed. The maintained exercise separately checks 2,048
pipelined transactions and 512 control requests at 64 outstanding, followed by
renewal and another session operation on the same socket.


## Local acceptance after the change

The optimized Rust release passed all 45 actual-systemd gates, including the
2,048-transaction plus 512-control burst, renewal on its existing socket, two
spaces/toolsheds/principals, ownership/revocation fencing, expiry, release,
worker crashes, slow clients and descriptor/network isolation. The burst drained
in 4.713 seconds at 64 outstanding requests and used the retained rate budgets.

At 32 workers, median private memory was 356 KiB both idle and after 3,200
transactions; maximum active private memory was 3,736 KiB for the client also
used by earlier payload gates. The directory and link agents grew 75.1 KiB per
additional client. These are measured resident private pages, not configured
memory limits. The release binary SHA-256 was
`09de71ad78788faec6b0a3f3b8f5eb005f7e74ab3c3edb9a1e6aef5d3eef69fb`.

Local validation also passed 36 Linux Rust tests (including randomized admission
schedules), clippy with warnings denied, 21 offline infra contracts, 668 Memory
tests with 1,348 steps, 44 Identity browser tests and the workspace format, lint
and type checks. Public-stage deployment remains disabled.

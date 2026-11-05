---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Measured Loom thread-open optimization experiments and their validation."
---

# Loom thread-open: four optimization rounds and metadata follow-up

## Outcome

The retained changes reduced the final same-thread lift median from **2,211.9 ms
to 1,274.8 ms (42.4%)**, winning all three interleaved pairs. The shipped
control medians were 148.1 and 143.4 ms. All twelve final runs passed the same
50-message rendered-content hash. The lift remains about 8.9 times the shipped
control in this block; these changes do not establish performance parity.

Final protocol-B block (`final3`), after the full runner suite exited:

| Pane and browser runtime  | Raw thread-open times (ms) | Median (ms) |
| ------------------------- | -------------------------- | ----------- |
| Lift, starting runtime    | 2211.9, 1298.2, 2459.3     | 2211.9      |
| Lift, retained runtime    | 1348.3, 1274.8, 973.4      | 1274.8      |
| Shipped, starting runtime | 148.1, 170.4, 119.1        | 148.1       |
| Shipped, retained runtime | 143.4, 274.9, 116.0        | 143.4       |

The full ledger contains 107 successful unprofiled observations, five rejected
attempts (three startup aborts and two content-check rejections), and ten
separately labeled diagnostic observations. The first final block crossed a
source-window change; the next exposed the attachment-placeholder fixture error
described below. Their rejected samples are excluded from medians.

The retained runtime is `4b2b207e41347f70f7f4620e1277903b145364a6`, containing
the traversal-owned label-view cache and the conservative filtered journal. Lazy
input preparation, refusal-attribution memoization, and document metadata reuse
remain separate experiments. Their end-to-end measurements did not justify
adding them to the retained changes.

These comparisons use the already narrowed lift pattern
`40129bb55ae24b7e5f0ae32c334b26a193436567`. They measure additional runtime
improvements. The preceding pattern/runtime investigation is recorded in
[the earlier report](2026-09-14-loom-person-inbox-improvements.md), and the
initial pin/main comparison in
[the remeasurement](2026-09-14-loom-person-inbox-thread-open.md).

## Conditions and measurement boundary

- One fixed person entity ID and Signal thread key; 50 visible messages. The
  selected person's other two source stores returned zero messages.
- One unchanged toolshed, PID 83088, started September 14 at 15:22:33 PDT, using
  Labs pin `be73306e5ee16d0e5a26fd8c6c9d1e29c6c5c19d` and
  `serverExecution=false`. The real source stores remained linked read-only.
- Only complete, prebuilt browser trees were swapped. Each swap checked the
  served worker bytes against the frozen bundle. No toolshed restart or new
  pin-keyed store occurred. Original vendor/browser pins were restored after
  each block.
- Both panes ran against both arms, interleaved by repetition. Every observation
  records `uptime` before and after. No investigation-owned heavy test process
  ran during the unprofiled timing blocks.
- Fresh browser, canonical-person check, numeric source counts, and public
  runtime idle precede the click. The timer runs from the captured click to
  exactly one visible matching detail panel and message container, 0 to 50
  visible bubbles, followed by two animation frames. A hash of their text must
  equal a read-only SQL snapshot of the same thread's current window.
- CPU profiles and debugger counters are diagnostic observations, excluded from
  latency medians. They can include additional UI work after the visible
  boundary. Counts for the large 201-target preparation provide the stable
  structural comparison.

All 60 unprofiled observations in the original four rounds passed their content
checks and shared one source-content hash. Later live-message arrivals changed
the rolling window; incomplete blocks were preserved rather than combined with a
new source snapshot.

A post-test attempt exposed a fixture error in the new window: one message
contained only an attachment. Both panes rendered `[attachment]`, while the
expected-text helper hashed its empty body. The corrected display hash matched
the captured shipped and lift hashes exactly. The helper now includes the
attachment placeholder and requires 50 renderable messages. Earlier windows
contained no attachment-only messages, so their passing comparisons are
unaffected. The rejected attempts remain in the ledger; they were not
retroactively promoted to valid samples.

### Startup protocol change

Three startup failures during the metadata experiment affected both candidate
and baseline. Request-failure capture confirmed an aborted `GET /config`. Loom's
mount code gives that request and its response body a 5,000 ms deadline; load
averages reached 57. The underlying delay was not isolated. A direct server
request took about two seconds on another observation.

The subsequent `round5b` and final blocks used protocol B: fetch the actual
`/config` response before each mount, validate its JSON, record its hash and
fetch duration, and replay those exact bytes during startup. Remove the route
before the click. Both arms use the same protocol. The workload, click timer,
source queries, content checks, bundles and toolshed are unchanged. Startup
latency is not comparable across the protocols. Earlier results are not pooled
with the new blocks.

## Individual rounds

Milliseconds; raw lift values are in execution order within each arm. Each round
compares its candidate with the retained baseline at that point.

| Round                                               | Baseline lift, raw                          | Candidate lift, raw                         | Median before → after | Shipped medians before → after | Decision                                  |
| --------------------------------------------------- | ------------------------------------------- | ------------------------------------------- | --------------------- | ------------------------------ | ----------------------------------------- |
| 1: lazy input preparation                           | 1079.9, 956.5, 1389.5                       | 1533.3, 1425.3, 944.5                       | 1079.9 → 1425.3       | 123.3 → 169.4                  | Set aside; no demonstrated win            |
| 2: owned label-view reuse                           | 1071.8, 1026.8, 1013.6                      | 896.2, 973.6, 906.7                         | 1026.8 → 906.7        | 96.1 → 113.4                   | Retain; all three lift pairs won          |
| 3: refusal attribution reuse                        | 1402.7, 902.6, 944.2, 1077.9, 2516.7, 860.3 | 1291.5, 1110.6, 819.4, 1459.6, 941.2, 846.1 | 1011.05 → 1025.9      | 143.4 → 125.6                  | Set aside; mixed despite four paired wins |
| 4: omit sealed internal records from repeated scans | 1901.5, 1872.3, 1717.5                      | 929.3, 1219.9, 1037.9                       | 1872.3 → 1037.9       | 148.2 → 141.6                  | Retain; all three lift pairs won          |
| Metadata follow-up, protocol B                      | 1151.8, 784.1, 796.2                        | 1250.1, 868.8, 779.4                        | 796.2 → 868.8         | 116.6 → 120.7                  | Set aside; one paired win                 |

Round 3 was extended from three to six pairs because paired results and medians
disagreed and the shipped control had an outlier. The initial metadata block's
three complete lift pairs were 1981.3, 1842.1, 2118.4 versus 1942.6, 1888.0,
1816.9. Its controls/extensions were interrupted by startup failures; all
attempts remain in the ledger. The complete protocol-B block did not confirm its
small apparent gain.

These are observed effects on a loaded machine, not universal speedup factors.
For example, round 4's 44.6% median reduction was accompanied by a separate
single-profile pair of 914.9 to 769.3 ms. The repeatable direction and exact
scan-count reduction support retaining the change; the magnitude varies.

## What the counters established

### Label views

The traversal cache owns its base entry/path/label arrays, clears on base
replacement, and returns independent arrays. Shared atoms must be deeply frozen;
mutable atoms use the existing uncached path. Public label-view helpers retain
their contracts.

On the real click, 104 of 1,406 calls qualified for reuse; all populated views
qualified. There were 98 cache hits, representing 120,932 of 128,336 input-entry
visits. Empty or absent views account for the many other calls.

### Policy's growing read journal

The large preparation verified 201 targets against the same 2,210 consumed
reads. Its own metadata lookups appended internal reads. The full journal grew
from 3,120 records at the first target to 44,423 at the last. Repeated scans
visited 4,820,770 records in this preparation; 444,210 visits survived
filtering. Across the whole diagnostic click, the totals were 4,822,102 raw and
445,245 filtered visits. These are repeated in-memory visits, not millions of
distinct messages or network reads.

Round 4 keeps the full journal and activity clock. A second ordered candidate
log omits only records carrying an exact runtime-owned, frozen verifier metadata
object; those records are also frozen. Other records, including mutable
internal-marked metadata, remain in the candidate log and are reclassified at
every target. Generic backends use the existing full-log fallback.

Candidate visits fell to 573,184 overall, an 88.1% reduction, while consumed
reads, the full journal, and per-target metadata lookups remained unchanged.
Within the large preparation the candidate log grew only from 2,715 to 2,865. A
diagnostic CPU pair sampled input verification at 245.3 versus 155.5 ms and
`prepareCfc` at 453.0 versus 343.8 ms; these overlapping inclusive times must
not be added together.

### Attribution and metadata reuse

Refusal attribution indexing/memoization preserved all 206 captured outputs. A
diagnostic profile sampled its work at 51.1 versus 3.0 ms, while overall click
measurements remained inconclusive. The source snapshot and cache are local to
one preparation; policy decisions are never cached.

The metadata follow-up cached immutable validated envelopes, including absence,
by opaque native document token and media type, within one preparation. Native
writes retire the token. Each hit replays its internal read through the existing
tracked-read API, preserving bookkeeping and clock positions. Local-only,
blind-write, epoch, ambient-metadata, prepared, and unsupported contexts fall
back.

The real probe found 40,961 hits among 41,806 requests (98%); only 845 requests
materialized and validated metadata. The large preparation's raw and candidate
journal counts remained exactly equal to round 4. Extra UI work varied between
whole-click probes, so their total prepare counts are not treated as identical.
This avoided work did not yield a demonstrated end-to-end improvement. Replayed
bookkeeping and repeated input processing remain; the experiment does not
establish which remaining cost offsets the saved materialization.

## Validation and delivery

The full `packages/runner` task passed on the retained exact commit: **1,405
tests, 9,915 steps, zero failures, one ignored step**. The task exited with code
0 after 17m33s. The worktree was clean before and after, with unchanged HEAD.
The final browser comparison ran after this process exited. The full log is
`improvements/round4-retained-full-runner.log`; the companion JSON records PID
7523, timestamps, command, HEAD, exit code, and load readings.

Focused validation:

- Round 1: 10 tests, 78 steps; typecheck, formatting, lint and review passed.
- Round 2: 116 steps; typecheck, formatting, lint and review passed.
- Combined round 2/3: 11 tests, 126 steps, including real captured attribution
  replay; typecheck, formatting, lint and review passed.
- Round 4: 13 tests, 200 steps across ten modules; typecheck, repository-wide
  formatting/lint and independent review passed.
- Metadata follow-up: 10 tests, 126 steps; typecheck, repository-wide
  formatting/lint and independent review passed. Tests cover invalid envelopes,
  absent/present transitions, direct/batched/partial writes, scope/media types,
  mutable data, conservative fallbacks, and exact journal equality.

Initial fixture and validation errors were corrected and their logs retained:
optional-capability typing, an unused import, an invalid no-target test setup,
and an assertion tightened to require a defined token. They are not counted as
successful checks. Startup/content failures are recorded separately from
performance samples.

Local candidate commits:

| Candidate                     | Commit                                     |
| ----------------------------- | ------------------------------------------ |
| Starting runtime              | `820bd94a9079633fbbbd27b42e7fc311238edb52` |
| Round 1                       | `aafb0b0ce114504c16dc22d567c66bdfde284166` |
| Round 2                       | `b8198ef29f54d64fa43857022fb1bd12fb2806d2` |
| Round 2 + round 3             | `d7c97d93652412ca302ea49ff9c5dfa2c16855de` |
| Retained round 2 + round 4    | `4b2b207e41347f70f7f4620e1277903b145364a6` |
| Metadata follow-up on round 4 | `6ef72d473b671da6174ec939c70a2b323763fae6` |

Vendor sync could not produce the Docker sandbox artifact because Docker was
stopped. Browser bundles were built and hash-verified independently. These runs
validate the browser/runtime path, not the complete vendor-adoption ritual.

The retained worktree is
`/Users/berni/.codex/worktrees/inbox-policy-journal/labs` on
`codex/inbox-policy-journal`. The Loom pattern work remains in
`/Users/berni/looms/person-inbox-lift-open`. The shipped default was not
changed; original browser/vendor pins were restored. The changes are local
commits, not merged or adopted into Loom's vendor pin.

## Reproduction and evidence

The [attempt ledger](2026-09-14-loom-person-inbox-policy-rounds.csv) contains
all raw values, failures, content hashes, and before/after uptime readings.
Profiles/count probes are identifiable by their repetition names and are
excluded from median calculations.

Private reproduction artifacts live under
`/Users/berni/.codex/investigations/person-inbox-20260914/improvements/rounds/`:
`WORK.md`, `round-bench.py`, `build-round.py`, `extend-round.py`, frozen
`cf-dist-*` trees and bundle hash manifests, source snapshots, count summaries,
CPU profiles, and validation logs. `round-bench.py` runs three interleaved reps
for both panes; `CAPTURE_CONFIG=1` selects protocol B. These scripts require the
existing acceptance instance and its unchanged toolshed. Source message bodies
remain in private artifacts rather than this report or its CSV.

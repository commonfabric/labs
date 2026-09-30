---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Real-data comparison of Loom inbox thread opening across two labs browser builds."
---

# Loom person-inbox thread opening on labs main

## Result

Current labs main improves the lift pane's median thread-open time by **41%**,
from **4.30 s to 2.55 s**, but the shipped pane opens the same thread in **0.12
s** on main. The rewrite is still **21 times slower** on this operation. Main
wins four of five paired lift repetitions; one pair reverses under load. These
are interleaved comparisons on a shared machine, not quiet-machine latency
guarantees.

The upstream changes help. They do not remove the thread-open blocker or justify
switching the default pane. No pattern or runtime implementation was changed, no
vendor pin was adopted, and no change was committed or published.

## Versions and scope

- Loom: `5f00c7eff026a76e38a425999769ee2461981456`, branch
  `claude/cf-person-inbox-refactor-55337b`. Its two pane sources and measurement
  history are ahead of the copies in Loom primary. Both pane sources were
  unchanged throughout this experiment.
- Pinned labs browser: `be73306e5ee16d0e5a26fd8c6c9d1e29c6c5c19d`, tag
  `loom-stable-2026-09-11-3`.
- Main labs browser: `51f8c11053771c3acf4099354b776775d489d93d`, fetched and
  frozen for this comparison. It includes
  [#7412](https://github.com/commontoolsinc/labs/pull/7412),
  [#7425](https://github.com/commontoolsinc/labs/pull/7425), and
  [#7453](https://github.com/commontoolsinc/labs/pull/7453).
- One unchanged toolshed: pinned labs `be73306e5`, PID 83088, started September
  14 at 15:22:33 Pacific. Every completed run records the same PID and start
  time. It was never restarted between arms.
- The toolshed reports `experimental.serverExecution=false` and
  `shellServerExecutionDefine=null`. Loom's browser build omits the shell's
  experimental defines and uses their defaults. The profiles show client
  derivations in the browser worker. This is not a server-execution benchmark.
- Machine: Mac15,8, 16 logical CPUs, macOS 26.4.1. Headless Playwright Chromium,
  1200 × 900, direct pane URL, owner view without facets. Five repetitions per
  pane/version. Measurement window: September 14, 17:15–17:20 Pacific.

This isolates the browser/runtime build. It does not measure upgrading the
serving toolshed or adopting the candidate in production.

## Fixed workload and completion contract

The existing acceptance instance `acc-claude-cf-person-inbox-refactor` links
real source stores read-only. Both panes were freshly deployed with
`loom piece deploy <name> --local`. The daemon log confirmed the three store
links for each new deployment: Signal, WhatsApp, and personal Gmail. Lift's last
link completed at 00:10:44 UTC, before any recorded measurement.

A read-only query using the pane's exact `SIGNAL_SQL` selected a canonical
person with **50 nonempty messages in one Signal thread**. The entity was
resolved through `/people-resolve`, and `cf cell get --input picked` confirmed
that both deployed panes held exactly that entity ID. Each browser run
revalidated the pinned entity through the resolver. A unique resolved chip was
used only if selection was needed. The first chip's position was never a
measurement input. The thread key was fixed from the source conversation ID. Raw
IDs, resolver output, and message data stay in the private evidence folder.

For this person the source counts were Signal 50, WhatsApp 0, Gmail 0, with one
thread row. This tests the requested 50-message open; it does not test a large
conversation list or claim to reproduce earlier multi-store workloads.

Each run uses a fresh browser context, waits for the fixed row and numeric
source counts, and verifies **zero visible bubbles before the click**. A capture
listener timestamps the actual DOM click. A mutation observer waits for exactly
one visible detail with the fixed thread key, one visible `.pi-msgs` within it,
and exactly **50 visible `.pi-bub` elements**. Two animation frames then pass
before recording completion. This same condition applies to both panes,
including the shipped pane's pre-rendered hidden bubbles.

All 20 measured opens had 50 visible bubbles and the same SHA-256 digest of
bubble text. The canonical-person and thread digests also match across runs.
This confirms content equality as well as equal counts. No arbitrary sleep was
used to stabilize a sample.

## Raw thread-open times

Milliseconds from the DOM click to the common visible-content condition and the
two animation frames. Medians are computed across all five values.

| Pane    | Labs browser |  Rep 1 |  Rep 2 |  Rep 3 |  Rep 4 |  Rep 5 | Median |
| ------- | ------------ | -----: | -----: | -----: | -----: | -----: | -----: |
| Shipped | pin          |  206.2 |  185.4 |  162.6 |  145.9 |  141.6 |  162.6 |
| Shipped | main         |  160.3 |  128.3 |  107.7 |  108.1 |  121.3 |  121.3 |
| Lift    | pin          | 3252.1 | 4407.7 | 4588.5 | 4303.1 | 4058.0 | 4303.1 |
| Lift    | main         | 4416.9 | 2545.3 | 2211.3 | 2435.9 | 3038.8 | 2545.3 |

Arms were interleaved by swapping the complete prebuilt `cf-dist` trees.
Repetitions 1–3 ran pin then main; repetitions 4–5 reversed that order. Pane
order was also reversed in repetitions 2 and 4. Builds and deploys were
completed before the measured matrix. The optional CPU profiles below are
separate runs and are excluded from these medians.

### What #7412 and #7425 established here

The main bundle containing both changes is faster overall. This experiment does
**not** isolate either PR: it also includes #7453 and other intervening commits.
It would be incorrect to attribute the 41% improvement to #7412 or #7425 alone,
or to say that they had no effect. The paired CPU profiles identify the
consumed-source deduplication fixed by #7453 as a large removed cost.

## Remaining cost: both pattern and runtime

Separate worker CPU profiles bracketed one lift thread open in each version.
They were symbolized through each build's own source maps. The profile windows
are 3.91 s on the pin and 2.42 s on main, including profiler transport and
post-click diagnostics; they are diagnostic samples, not extra timing reps.

| Sampled work                                             |     Pin |    Main |
| -------------------------------------------------------- | ------: | ------: |
| `collectConsumedLabel`, inclusive                        | 1185 ms |   11 ms |
| Its `noteSource`, inclusive, overlapping the row above   | 1174 ms |    4 ms |
| All `cfc/label-view-core.ts` frames, exclusive self time | 1035 ms | 1033 ms |
| `openThreadsAt`, inclusive of runtime reads              |  502 ms |  430 ms |
| `openMessagesFrom`, inclusive of runtime reads           |  604 ms |  486 ms |

Inclusive rows overlap with runtime callees and must not be added to exclusive
self time. About 43% of main's sampled window is exclusive label-view work. The
profile shows substantial synchronous worker execution; the delay cannot be
described as only a session-write round trip or only DOM rendering.

### Pattern opportunities

In `cf-person-inbox-lift.tsx`, the pattern instantiates all three derivations:
`openThreads`, `openHeadOf`, and `openMessagesOf` (around lines 2104–2106). The
JSX consumes `openHead` and `openMsgs`. The local `open` result is unused, but
its `openThreadsAt` reconstruction still runs, confirmed by CPU samples. It
reads and copies the same six message fields that `openMessagesFrom` reads.

Removing that unused derivation is a concrete first experiment. The 430 ms
inclusive sample establishes avoidable work, not a promised 430 ms end-to-end
improvement: its commits, dependencies, and overlap also change.

Both reconstruction loops repeatedly read `t.msgs` in their loop condition and
body. Hoisting the array view into one local binding is another narrow
experiment, because these property reads enter schema validation and label-view
rebasing rather than merely reading a JavaScript array. It needs a real-pane
comparison; a test over plain arrays cannot validate a performance claim.

For the larger design, carry the open thread's display data across a narrower
boundary, or pre-render the detail column and switch visibility. Tony should
choose the intended tradeoff between initial render work, retained DOM, and open
latency. Neither design was implemented or made the default here.

### Runtime opportunities

The current label-view path remains expensive under ordinary field reads:

- `schema-view.ts` property access calls `readChild`/`readChildAt`, re-entering
  `validateAndTransform` in `schema.ts`.
- `mergeCfcLabelViews` and `rebaseCfcLabelView` repeatedly canonicalize paths,
  copy/join labels, and sort entries. On main, their sampled inclusive times
  were about 728 ms and 502 ms, respectively; these overlap.
- `sortEntries` encodes both paths inside every comparison. Its comparator
  accounts for 327 ms of exclusive self time in this main profile. Path
  canonicalization adds another 207 ms across its callers.

A focused runtime benchmark can vary the number of entries in a carried label
view while holding the number of field reads fixed, then vary repeated reads of
one child path while holding the view fixed. Use labels with covering, shape,
enumerate, and followRef observations, plus wildcard and escaped path segments.
Candidate optimizations are precomputed sort keys and reuse/indexing of
immutable label views within the correct transaction/read epoch. Reuse must
preserve observation classes, wildcard matching, label joins, and
read-after-write semantics; removing propagation or caching by path alone is not
a valid fix.

This investigation identifies the runtime source to benchmark. It does not
contain a validated runtime optimization or an isolated scaling curve for that
source. The evidence does not support declaring that all remaining latency
belongs in the pattern.

### Logger cross-check

Main's click interval recorded 23 scheduler actions and 23 commits, seven
JavaScript implementation invocations, and three map runs. Action spans totaled
1281 ms and commit spans 601 ms. Four watch refresh spans totaled 1280 ms; they
overlap execution and cannot be added to the action/commit totals. These are
differences of count and total time, not differences of lifetime percentiles.
Together with the sampling profile, they distinguish repeated runtime work from
a slow paint alone.

## Load beside every sample

The following table preserves run order. Each load field contains the 1-, 5-,
and 15-minute averages from `uptime`, captured immediately before and after that
browser run. The private JSONL also retains the full command output, including
uptime, user count, timestamps, and toolshed process identity.

| Order | Rep | Browser | Pane    | Open ms | Load before (1/5/15 min) | Load after (1/5/15 min) |
| ----: | --: | ------- | ------- | ------: | ------------------------ | ----------------------- |
|     1 |   1 | pin     | Shipped |   206.2 | 22.71 16.95 22.92        | 23.77 17.27 23.00       |
|     2 |   1 | pin     | Lift    |  3252.1 | 24.29 17.60 23.05        | 28.85 19.06 23.45       |
|     3 |   1 | main    | Shipped |   160.3 | 31.78 20.36 23.81        | 31.40 20.65 23.87       |
|     4 |   1 | main    | Lift    |  4416.9 | 31.40 20.65 23.87        | 30.89 21.06 23.96       |
|     5 |   2 | pin     | Lift    |  4407.7 | 30.89 21.06 23.96        | 24.29 20.18 23.58       |
|     6 |   2 | pin     | Shipped |   185.4 | 24.29 20.18 23.58        | 23.15 20.01 23.50       |
|     7 |   2 | main    | Lift    |  2545.3 | 23.15 20.01 23.50        | 23.04 20.08 23.48       |
|     8 |   2 | main    | Shipped |   128.3 | 23.04 20.08 23.48        | 23.67 20.26 23.52       |
|     9 |   3 | pin     | Shipped |   162.6 | 23.67 20.26 23.52        | 23.78 20.34 23.53       |
|    10 |   3 | pin     | Lift    |  4588.5 | 23.78 20.34 23.53        | 25.23 20.97 23.67       |
|    11 |   3 | main    | Shipped |   107.7 | 25.23 20.97 23.67        | 25.23 20.97 23.67       |
|    12 |   3 | main    | Lift    |  2211.3 | 25.23 20.97 23.67        | 25.57 21.18 23.71       |
|    13 |   4 | main    | Lift    |  2435.9 | 26.55 21.54 23.81        | 27.45 21.90 23.91       |
|    14 |   4 | main    | Shipped |   108.1 | 27.45 21.90 23.91        | 27.89 22.08 23.96       |
|    15 |   4 | pin     | Lift    |  4303.1 | 27.89 22.08 23.96        | 31.60 23.28 24.35       |
|    16 |   4 | pin     | Shipped |   145.9 | 31.60 23.28 24.35        | 33.71 23.86 24.54       |
|    17 |   5 | main    | Shipped |   121.3 | 33.71 23.86 24.54        | 33.57 23.99 24.59       |
|    18 |   5 | main    | Lift    |  3038.8 | 33.57 23.99 24.59        | 33.05 24.35 24.70       |
|    19 |   5 | pin     | Shipped |   141.6 | 33.05 24.35 24.70        | 32.81 24.44 24.73       |
|    20 |   5 | pin     | Lift    |  4058.0 | 32.81 24.44 24.73        | 30.48 24.47 24.74       |

## Setup outcomes and retained evidence

The acceptance instance already existed, so `loom acceptance up` reported that
fact and the existing instance was reused. The deployed sources were committed
Loom sources. The three source links for each new piece were verified in the
daemon log before measurements.

`loom vendor sync labs --latest` selected the candidate successfully, but its
subsequent sandbox CLI binary rebuild failed because Docker was stopped. The
same sandbox step failed when restoring the pin. Both browser bundle builds
completed successfully. This benchmark uses neither that sandbox binary nor
Docker. This is **not** a passing vendor adoption ritual, and no adoption was
attempted. Loom's generated tracked files returned to their initial state.

The pin checkout and freshly built pin browser tree were restored. The served
`/scripts/worker-runtime.js` was checked byte-for-byte against the saved pin
bundle. The toolshed remained PID 83088 on `be73306e5`; no new pin-keyed server
store was created. Existing unrelated probe files were preserved.

The two preliminary harness attempts that waited for an already-selected
person's missing recents chip were interrupted. They produced no thread-open
sample and are excluded. The final harness handles a persisted selection and
validates its canonical ID. An attempted host `people` input write was refused
by whole-input validation on the unrelated `gmailPersonalPanel` field; the
measurement instead used the normal picker and verified `picked` read-only.

Private evidence is under
`/Users/berni/.codex/investigations/person-inbox-20260914/`:

- `measurements.jsonl`: raw timings, full uptime strings, fixed-identity and
  content digests, profile-run metadata, and preliminary failures.
- `config.json`, `target-source.json`, `person-resolved.json`, and
  `picked-{shipped,lift}.json`: fixed workload and canonical-ID verification.
- `measure.mjs`, `run-matrix.py`, and `run-matrix-extra.py`: browser harness and
  exact run order; `select-target.py`: read-only source selection.
- `cf-dist-{pin,main,original}/` and `bundle-sha256.json`: complete bundles,
  their source maps, original-tree backup, and file hashes.
- `*-profile-profile.json`, `*-profile-analysis.txt`, and
  `main-stats-delta.json`: CPU samples, symbolized attribution, and logger
  differences. The JSON captures retain the raw V8 `profile` object.

The report contains no message bodies, person names, or raw entity/thread IDs.
No code, default-pane choice, or live production configuration was changed.

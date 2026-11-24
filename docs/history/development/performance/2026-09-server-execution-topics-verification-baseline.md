---
status: historical
created: 2026-09-09
archived: 2026-09-09
reason: "Initial mechanism and correctness evidence for the six-recommendation campaign; latency and implementation gates remain open."
---

# Server-execution topics campaign: initial verification

This snapshot records verification work, not completion of the implementation
campaign. No production change or recommendation PR had been completed. The
[live campaign ledger](../../../plans/server-execution-topics-campaign.md)
tracks the remaining work in order **5, 3, 1, 2, 4, 6**.

The initial baseline was `e059494c4599d344f59caabddfc87b588937c3dc`. After two
relevant PRs landed, the campaign checkout advanced to
`83ee6cf73f3b8ab9cd7fccd2d12bee09c518a15b`. Evidence below identifies which head
it covers. The historical investigation at
`8b34d4dab7ff064ef4d62fb79b0408472c3bf862` and its
[CLI investigation](2026-09-cf-cli-topics-board-cost.md) were hypothesis sources;
their worktree and files were preserved.

## Method and limits

A fresh login shell resolved `/opt/homebrew/bin/deno` to Deno 2.9.4, matching
`mise.toml`; V8 was 15.0.245.2-rusty and TypeScript was 6.0.3. Each synthetic
seed arm used a fresh toolshed process and store. The same five-topic fixture
contained 120 words per body and two citations from each of the newest three
topics. Readback checked actual piece identities, titles, body lengths, index
order, and six resolved citation links through a fresh reader.

The initial four seed arms ran full/OFF, full/ON, index/ON, index/OFF. They were
correctness probes, not a latency experiment. One-minute machine load exceeded
the protocol threshold of approximately 5 and reached approximately 66. No
other session's process was stopped. The required three adjacent paired latency
repetitions remained outstanding.

The seed runner used the repository's baked-toolshed CI capabilities and role
mapping: `tasks/ci-capabilities.ts` and `tasks/server-execution-ci.ts`. These
supplied a matching server and baked shell, readiness signaling, a fresh store
working directory, and cleanup of the process the runner owned. This was not a
claim to have completed the separate `deno task integration --port-offset=NNN`
gate in the v2 testing specification. The initial binaries had no embedded Git
SHA: build invocation, clean tracked source, and binary hash supplied their
provenance. Refreshed builds set `COMMIT_SHA`; the runner rejects a published
build head that differs from its workload head.

The real-memory watch probe counted consumed iterator entries, not elapsed time
or allocations. The serving probe held only the demand-grace callback and
observed entry into the loop's existing input wait. It used plain roots, a
controlled demand facade, and the sanctioned `ensureSpaceRoots: false` test
switch. It did not model a complete browser's demand. The event probe held
subscription fan-out with memory's manual refresh mode. The sidecar probe
used real source resolution, compilation, and storage with a synthetic HTTP
source provider; it did not measure network latency.

## Changes already present

- #7186, `644a38111e813fc80ed496bef6ff29869839007d`, had already narrowed
  CLI verb-discovery reads before the historical investigation baseline. The
  existing cold discovery regression passed. This work must not be duplicated.
- #7193, `3cdf2ab489ae59e684e03ec78e7e29dfb70650e2`, changed both memory
  metadata traversal and the loader's per-hop backlink sync. Its loader
  performance effect had not been isolated and was not ruled out.
- #7160 cached graph-local schema reference scans, but did not remove the
  whole-session work counted below.
- #7228, `0a567afdf8a1650d08729d9d858c0c686f402c99`, landed during this
  verification. `compileOrGetPattern` snapshots program contents and registers
  cross-space closure persistence for shared compiles. The supplied sidecar
  path still called `compilePattern` directly.
- #7221, `83ee6cf73f3b8ab9cd7fccd2d12bee09c518a15b`, then narrowed
  client traversal metadata to CFC schema documents. The mechanism probes were
  repeated at this head; workload measurements before and after it are distinct
  baselines.

## Recommendation 5: caller demand

`seedTopicBoard` held a schemaless full-result sink. The existing onscreen
test's index demand applied the durable result schema before selecting `index`.
An archived ablation made that same selection in the seed fixture and required
the durable schema to exist. Full and index demand both passed the five-topic,
six-edge readback in both execution arms. The original fixture was restored
after the experiment.

This establishes correctness for that fixture, not the size of a performance
benefit. The final health snapshot followed a broad readback, so its demand
maximum includes verification demand. Identical maxima from those snapshots
cannot show that full and index seeding have identical demand. The runner was
extended to save statistics after seeding and before readback.

The reader starts no pieces locally, but ON subscriptions can demand serving
recomputation. Successful readback proves the observed final values, not that
every derived value existed before readback began.

The current CLI already selects an addressed path before pulling it. A command
whose output is the complete result still legitimately reads that result;
narrowing such a command would change its contract. Remaining caller work needs
to trace the actual requested output and distinguish stream dispatch from the
generic post-edit result pull.

The implementation contract is a durable-schema index subscription that keeps
the current list live, preserves actual created topics and citations, and
retains full demand as an explicitly labeled stress case. Both execution arms
must use the same demand mode. The 30-topic navigation fixture and 100-topic
scale fixture have different citation shapes and are not a size-only pair.

## Recommendation 3: event visibility

At both recorded heads, the real-memory probe warmed a sidecar's absent view,
admitted two delegated events, and attempted a duplicate admission. The engine
held entries at sequences 1 and 2; the duplicate was deduped. Calling `sync()`
again on the covered cell left its replica view absent. Explicit fan-out then
produced one replica application signal and made both entries visible, with
matching event IDs and sequences. No sleep or backstop timer caused that
transition.

The initial full-demand ON seed also logged five `event-view-lag` deferrals.
That establishes that the drain symptom still occurred. Neither observation
measures how many production backstops a candidate barrier would avoid.

The serving drain reads pending engine entries in admission order, synchronizes
each sidecar, and validates the event ID at its stored index in the replica.
A lagging head blocks every later arrival across streams. A replacement barrier
must preserve that validation, deduplication, ordering, and exactly-once durable
consequences. `inputSynced()` does not promise that subscription frames have
arrived; `whenApplied(localSeq)` concerns the replica's own local commits, not
an arbitrary foreign admission sequence.

The application notification also reports confirmed data hidden under an own
pending write. It cannot alone prove materialized visibility. Waiting for a
sealed write to become visible inside the wave that must commit it can
deadlock. The existing real stacked-commit shadow tests passed, but a candidate
barrier still needs delayed-drain, multiple-stream, duplicate/index, failure,
teardown, lease, and sealed-write controls. An avoided 250 ms wait for each of
17–22 events accounts for approximately 4.25–5.5 seconds, not the complete noisy
ablation timing difference in the historical report.

## Recommendation 1: terminal confirmation

For a durably present plain root, the real serving loop made three sync calls:
the initial owning-result traversal, the explicit confirmation sync, and the
confirmation's repeated traversal. Only one watch was registered. The engine
sequence sampled at each call's start was identical for that root. Unrelated demand passes
did not repeat its terminal classification; demand departure and rearrival did.

Thus repeated sync calls are reproduced, but three calls do not imply three
watch requests or three freshness barriers. Covered selectors reuse an existing
watch promise. The cost specifically attributable to confirmation remained
unquantified; enclosing demand-pass and watch spans cannot be added to infer it.

The correctness contract follows the complete owning-result address, scope,
space fallback, and lease semantics. Current observed-document IDs alone lose
information needed by a general direct-engine classifier. A direct read needs
a defined revision and must preserve metadata/backlink re-arming, including
creation during confirmation and demand departure/rearrival. Existing terminal
and later-creation regressions passed. A race spanning a deadline and the next
input drain remained a case to pin, not a verified defect.

## Recommendation 2: watch maintenance

The probe used a real memory server, session registry, clients, transactions,
watch additions, refresh, and removal. Each established session held N disjoint
roots. It then added a second watch over an existing root, added one new root,
changed one document, and removed the additional watches.

For N = 100, 1,000, and 10,000, the following counted work grew with N:

| Operation | Counted work |
| --- | --- |
| Add a covered root under a new watch ID | Copy N delivered entries and scan N entries to rebuild tracked IDs |
| Add one disjoint root | Copy N delivered entries, graph entities, schema-reference entries, tracker containers, and cached manager entries |
| Add one disjoint root | Enumerate N loaded addresses before extension and N+1 afterward; scan N+1 entries for tracked IDs |
| Refresh one changed document | Iterate N+1 established snapshots while collecting cached schema dependencies, and N+1 delivered entries for tracked IDs |
| Remove the added watches | Reevaluate the retained N roots and publish removal of the extra root's interest |

The raw output separates the loaded-address enumeration from its nested map
iteration; they are two observations of overlapping work, not additive costs.
The probe does not capture every array scan, `Map.forEach`, byte copy, traversal
operation, or frame-application cost. It nevertheless disproves the idea that
incremental tracked IDs alone remove the whole-session factors.

Transactional publication is the implementation constraint: a failed addition
must leave delivered entries, graph state, watches, sequence state, and operation
cursors unchanged. Overlapping watches require ownership accounting, including
scope and branch identity, operation-only interests, schema dependencies, absent
targets, and retirement of orphaned interests. Ordinary refresh does not promise
general topology-shrink garbage collection; explicit watch replacement does
retire removed demand. The implementation must not silently broaden that
contract or replace ownership with a grow-only union.

Existing tests covered add rollback, concurrent watches, absent arrivals and
retirement, and graph-local schema scans. A mixed graph addition followed by
late operation-cursor failure remained an additional rollback case to pin.

## Recommendation 4: sidecar work

In each arm, three distinct slots in one space each fetched advertised identity,
fetched source, and called `compilePattern`. The first compiled cold; the next
two reported compiler cache hits. A fourth slot in another space also fetched
identity and source and compiled in that space. Every destination held the
source closure after tracked compile writes completed. Reopening the same slot
did no additional fetch or compile work. These results persisted after #7228.

The redundant work is therefore broader than fresh TypeScript compilation:
resolution and the cached compilation path still run. A cache keyed only by
runtime and registry epoch would erase necessary per-space persistence and
per-piece source lifecycle work. The safe boundary must retain each piece's
reconciliation and owner-selected origin, source deployment observability,
registry invalidation, in-flight epoch replacement, failure/retry, and disposal.
The existing source lifecycle and cross-space closure tests passed. Marginal
source/artifact savings and the candidate cache contract remained open.

## Recommendation 6: deadline and grace

The flush deadline remained unchanged. Its multi-user consequence-visibility
role cannot be evaluated by dividing `wavesBudgetExhausted` by `waves`: the
former includes zero-commit cycles and the latter counts wave closures. Actual
commits, input coverage, and watermark advancement must be counted separately.

The controlled serving probe collected twenty demand notes into one held grace
callback. Firing it produced two demand passes at this head: the callback woke
an existing input waiter and left a latch for its next wait. Separately, an
input commit caused the newly demanded root to be loaded before the held grace
callback fired. This disproves a universal 300 ms cold-session floor and shows
why a callback count is not automatically a pass count.

The existing `graceMs` series is adjacency-attributed growth-wake-to-landing
time, not the time spent waiting for the demand timer. The probe measured no
claim about burst throughput or multi-user fairness. Those controls, cold-demand
measurements, and a separate evidence disposition remained outstanding.

## Reproduction and retained evidence

The checked-in probes live in
[`tools/server-execution-topics`](../../../../scripts/server-execution-topics).
Compact raw outputs and the exact index ablation are in its
[`evidence/2026-09-09`](../../../../scripts/server-execution-topics/evidence/2026-09-09)
directory; its [manifest](../../../../scripts/server-execution-topics/evidence/2026-09-09/manifest.json)
binds raw results to runtime heads, script snapshots, commands, flags, and hashes.
The initial watch run did not independently capture flags; the complete 83ee
capture reproduced its counts. Run the probes from the recorded checkout with Deno 2.9.4:

```sh
CF_LOG_LEVEL=silent deno run -A tools/server-execution-topics/event-visibility-probe.ts
CF_LOG_LEVEL=silent deno run -A tools/server-execution-topics/serving-probe.ts
CF_LOG_LEVEL=silent deno run -A tools/server-execution-topics/sidecar-probe.ts
CF_LOG_LEVEL=silent deno run -A tools/server-execution-topics/watch-probe.ts 100 1000 10000
```

The exact runtime sources are recovered by checking out the head attached to a
result. The script snapshots, seed manifests, build commands and logs, binary
hashes, full server statistics, synthetic stores, and validation logs are in
`/Users/berni/.codex/artifacts/server-execution-topics-2026-09-09/` on the campaign
host. This persistent artifact directory is independent of temporary scratch.
No generated binary or production payload is part of the changeset. No large
CPU profile was captured for this snapshot.

The initial focused validation at e059 passed 97 runner tests and 179 steps,
five memory top-level tests and nine steps, and one CLI test and two steps.
These are baseline subsets, not a claim that repository-wide checks or either
complete integration lane had passed. The campaign ledger owns those gates.

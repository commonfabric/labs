---
status: historical
created: 2026-09-09
archived: 2026-09-09
reason: "Recommendation 5 source, demand, and correctness observations during the server-execution topics campaign."
---

# Topics caller demand: recommendation 5

The recommendation was justified at the caller boundary. A fresh reader
subscribing to the typed board index loaded fewer entities than one demanding
the full result. Separately, a CLI path read loaded unrelated result siblings
before selecting its path. Narrowing the fixture's subscription alone did not
reduce the already-established seeding client's demand in the observed runs.
No end-to-end latency improvement was established.

The historical investigation was reviewed at
`8b34d4dab7ff064ef4d62fb79b0408472c3bf862`. Shared verification is recorded in
[PR #7229](https://github.com/commontoolsinc/labs/pull/7229). This recommendation's
implementation began from `1eefa123bbd01337481397c97962cc25ed6d2c73` on an
independent branch; it does not require the evidence PR's code.

## Mechanisms and controls

The isolated-reader profiling runs used runtime and baked-server head
`83ee6cf73f3b8ab9cd7fccd2d12bee09c518a15b`, Deno 2.9.4, and five topics with
120-word bodies. The newest three topics cited two earlier topics each: six
actual reference edges. Both execution arms used that shape. Each arm had a
fresh store and server, with fresh reader sessions for index and full demand
over the same completed board. Existing Deno dependency caches were retained.
These were profiling runs with a per-session demand snapshot added to health
statistics, not uninstrumented latency trials.

| Arm | Reader demand | Tracked entities before → after | Watches before → after |
| --- | --- | --- | --- |
| OFF | Index | 41 → 151 | 2 → 4 |
| OFF | Full | 41 → 547 | 2 → 232 |
| ON | Index | 42 → 152 | 3 → 5 |
| ON | Full | 42 → 644 | 3 → 245 |

The reader was selected by its session ID in the board's space. These are
observed cardinalities, not scheduling-invariant constants. The serving
principal was measured separately: the ON index-seed observation held 1,175
entities and 1,356 watches in the serving session, while the client held 1,012
and 995. `demandedInstancesMax` excludes the serving principal and cannot stand
in for those serving-session measurements. Sessions and spaces overlap; their
sizes must not be added as a unique-entity union.

The sink-only full/index ablation preserved all five topics and six edges in
both arms, but left the ON seeding-client maximum at 1,012 in both workloads.
Source tracing explained why changing one subscription was insufficient:

- `PiecesController.get()` called `getPieceCell()` and then synchronized the
  canonical cell under the declared result schema. `getCellValue()` called
  that method before selecting its addressed path. `getPieceCell()` already
  synchronized the addressed document and canonical metadata; its additional
  full-result sync was not necessary for a path read.
- `PiecePropIo.edit()` pulled its result root after writing, including after
  sending a stream event. This is also a completion boundary, so the campaign
  did not remove it without establishing that contract separately.
- `topicAt()` pulled the board's topic list, then resolved the selected
  topic's own cell. Citation creation intentionally addressed those pieces.

The discovery improvement in #7186 was already present. The change did not
reimplement or claim that improvement.

## Implementation and correctness

The fixture held the index under the durable result schema, applied before
`key("index")`. It rejected a missing durable schema rather than silently
subscribing without one. The on-screen test and child-topic contract tests
used the same helper. The child seeder accepted `--demand=full`, and both board
benchmarks accepted `CF_TOPIC_BOARD_DEMAND=full`. Fixtures recorded `seedDemand`
and benchmark groups included the demand mode, separating these series from
unqualified historical series. The navigation and scale fixtures still had
different citation shapes; they were not a size-only comparison.

The CLI read used the canonical cell from `getPieceCell()` to construct its
controller before selecting the path. It preserved the scope and `--step`
arguments. Whole-result reads, execution inputs under `--step`, and missing-path
diagnostics could still require broader demand.

The real-memory CLI regression first failed on the baseline: reading `title`
loaded all three separate linked item documents. After the change, the same
value was returned with none of those documents loaded. The collection-read
control loaded and returned every item. Existing scoped-instance, input
projection, selection, verb-refusal, and step/stop assertions remained enabled.
Unit doubles were moved to the read-construction injection boundary; the cold
reader regression used the real controller and memory implementation.

Both baked correctness lanes passed five suites and 25 steps, including the
child seeder under index and full demand, child-topic/pivot behavior, and
on-screen creation. A fresh reader checked actual IDs, ordered titles, body
word counts, and citation targets after the seeding child exited. These checks
established persisted content, not watermark coverage. The campaign's separate
event/watermark investigation remained necessary.

## Reproduction and remaining evidence

[The compact manifest](../../../../scripts/server-execution-topics/evidence/2026-09-10-narrow-demand/manifest.json)
records extracted reader counts and SHA-256 hashes of the raw observations,
manifests, source snapshots, and ablation patches. Retrieve the named files from
`/Users/berni/.codex/artifacts/server-execution-topics-2026-09-09/`. Run manifests
contain exact commands, source/build heads, posture checks, flags, runtime,
cache state, machine information, and load samples. Restore the recorded head
and source snapshots, then apply the recorded patch to reproduce a profiling
run. Only synthetic local identities and payloads were used.

The implementation lanes used uninstrumented servers at `1eefa123...` and the
recorded caller patch. Their new test's source provenance is recorded beside
its snapshot. Build logs and binary hashes are under `validation/` and
`metadata/`; gzip copies of generated binaries were retained outside Git to
bound disk use. Rebuilding is supported by the recorded commands and heads.

Quiet-machine latency qualification, three adjacent alternating pairs,
marginal end-to-end effects, and the final cumulative comparison were still
outstanding. Busy-machine timings did not satisfy those gates. The production
decision here rested on unnecessary traversal demonstrated by real-memory
controls and on preserving a correctly typed current-list subscription.

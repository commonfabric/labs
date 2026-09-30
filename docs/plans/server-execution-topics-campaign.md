# Server execution topics verification and implementation campaign

Complete the six recommendation dispositions in order **5, 3, 1, 2, 4, 6**.
Each PR must pass self-review, local validation, CI, and actionable review
feedback. Passing current-head CI establishes functional acceptance, including
the browser integration lanes. Track the independent local Chrome teardown
investigation separately. Report latency as unquantified until eligible paired
measurements exist. Merge PRs in recommendation and dependency order only after
their current-head CI and review gates pass. Preserve the investigation worktree,
unrelated local work, production data, and the server-execution default.

## Durable ledger and reproducibility

The authoritative execution ledger is under
`/Users/berni/.codex/artifacts/server-execution-topics-2026-09-09/`:

- `metadata/campaign-state.json` records each hypothesis, decision, branch, PR,
  exact head/base, validation, review state, and remaining work.
- `metadata/campaign-current.md` holds the current table and dated execution
  records. Its older entries describe their capture times.
- `DELIVERY-CURRENT.md` consolidates dispositions, measurements, validation,
  exact PR heads, and remaining gates.
- `reviews/` holds paginated inline comments, complete review conversations,
  review summaries, timeline comments, and exact-head check snapshots.
- `runs/`, `source/`, `patches/`, and `validation/` retain exact commands,
  manifests, script snapshots, ablations, raw results, hashes, and logs.

The [initial ledger snapshot](../history/plans/server-execution-topics-campaign-initial-ledger.md)
and [baseline investigation](../history/development/performance/2026-09-server-execution-topics-verification-baseline.md)
record the initial evidence. Use current normative specifications, source, and
regressions as the implementation contract. Checked-in recommendation evidence
belongs with its PR; large artifacts need hashes and retrieval instructions.

## Dispositions and completion gates

| Order | Recommendation | Decision and invariant | Review surface |
| --- | --- | --- | --- |
| A | 5: caller demand | Apply the durable schema before selecting the current-list index; preserve created topics, citation targets, and the explicit full-demand stress workload. Reuse landed CLI discovery improvements. | [#7231](https://github.com/commonfabric/labs/pull/7231) |
| B | 3: event visibility | Use event-driven replica application before deferral, retaining event identity/index validation, arrival order, deduplication, durable consequences, and watermark bounds. | [#7232](https://github.com/commonfabric/labs/pull/7232) |
| C | 1: terminal confirmation | Remove redundant intermediate syncs while retaining owning-result traversal, complete scoped addresses, leases, creation-race rearming, cancellation, and settle coverage. This PR depends on B. | [#7234](https://github.com/commonfabric/labs/pull/7234) |
| D | 2: watch maintenance | Stage incremental ownership and graph updates before transactional publication. Retain rollback, overlap, scoped and operation interests, absent-target arrival, and retirement. | [#7251](https://github.com/commonfabric/labs/pull/7251) |
| E | 4: sidecar source | Share bounded raw-source work while preserving fresh identity resolution, destination-space closure persistence, per-piece reconciliation, owner origins, invalidation, retry, and disposal. | [#7274](https://github.com/commonfabric/labs/pull/7274) |
| F | 6: deadline and grace | Retain both constants. Document input bypass, burst coalescing, timer/pass attribution, and the deadline's multi-user consequence-visibility role. Keep the evidence disposition and runtime-emission proof current with its prerequisite. | [#7296](https://github.com/commonfabric/labs/pull/7296) |

The [shared prerequisite](https://github.com/commonfabric/labs/pull/7229)
contains the baseline tools and evidence. Its identity-commit fixtures use
content-derived IDs so content admission succeeds before testing elision and
staleness. All PR statuses must be refreshed before delivery; an earlier green
snapshot does not establish the current head's completion.

## Measurement contract

- Count admitted events, replica visibility, handler consequences, durable
  commits, and watermark coverage separately. A stored consequence does not
  establish coverage by itself.
- `wavesBudgetExhausted` counts cycles, including cycles without a commit.
  `waves` counts closures. Their ratio does not measure the fraction of committed
  waves that exhausted.
- Observe serving-session tracked entities separately from client demand, which
  excludes the serving principal.
- Isolate confirmation work from enclosing demand-pass spans and overlapping
  watch waits. Record watch batch sizes, graph sizes, copying, traversal, frame
  application, source resolution, compilation, cache hits, and closure writes.
- Keep the navigation fixture's citation shape distinct from the scale
  fixture's shape. Hold workload and completion conditions equal across arms.
- Use fresh stores and verify server, client, and baked shell posture before
  every run. Record workload/build heads, flags, runtime pin, fixture shape,
  machine load, cache state, exact commands, and source hashes.
- Separate uninstrumented end-to-end measurements from profiling. Latency claims
  require at least three adjacent alternating paired repetitions with
  one-minute load at or below 5 throughout the observed run. Do not stop other
  sessions' processes to meet that threshold. Scheduling-dependent counts also
  need controlled interpretation.

## Remaining delivery work

The campaign remains open until the following gates pass:

- Finish current-head review and CI for every disposition and the refreshed
  shared prerequisite. Read all comments and complete conversations, including
  outdated and file-level feedback, without author, date, commit, or line filters.
  Reply in the original thread and resolve it only when its substance is met.
- Complete the cumulative baseline/combined comparison using identical workload
  files. Keep marginal mechanism effects distinct from cumulative effects and
  from unrelated upstream changes. Validate cold/warm rendering, seeding,
  durability, watermark behavior, and multi-user controls.
- Obtain eligible quiet-machine latency pairs before claiming latency gains.
  Loaded correctness runs and profiles establish no latency result; leave the
  effect unquantified when eligible measurements are unavailable.
- Use gh-stack for dependent PRs; propagate ancestor changes and revalidate the
  affected descendants. Refresh exact heads, bases, mergeability, checks, and
  review threads before reporting delivery.

Record any external blocker precisely and continue independent work. Keep this
plan active while gates remain pending; archive it when the campaign completes.

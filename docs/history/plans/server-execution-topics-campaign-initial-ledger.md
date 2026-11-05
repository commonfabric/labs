---
status: historical
created: 2026-09-09
archived: 2026-09-10
reason: "Initial verification ledger snapshot; the active campaign continues in docs/plans."
---

# Server execution topics verification and implementation campaign

This ledger tracks the six recommendations through verification, separate PRs,
review, and cumulative validation. Production implementation starts only after
all six have a correctness contract and controlled mechanism evidence. The
implementation order is **5, 3, 1, 2, 4, 6**. Each implementation PR must finish
self-review, CI, and actionable feedback before the next implementation starts.
All PRs remain open and unmerged. The server-execution default stays unchanged.

## Baseline and durable artifacts

- Repository: `/Users/berni/src/labs`.
- Campaign checkout: `/Users/berni/.codex/worktrees/d3f2/labs`.
- Verification branch: `codex/server-execution-topics-verification`.
- Initial main and verification base/head:
  `e059494c4599d344f59caabddfc87b588937c3dc`.
- Historical investigation: `claude/server-side-execution-benchmarks-47ce3b`,
  reviewed at `8b34d4dab7ff064ef4d62fb79b0408472c3bf862`. Its worktree is
  preserved under `/Users/berni/src/labs/.claude/worktrees/`.
- Artifact root:
  `/Users/berni/.codex/artifacts/server-execution-topics-2026-09-09/`.
  Metadata, exact commands, patches, manifests, compact raw results, validation
  logs, and profile hashes belong here. This location persists independently
  of temporary stores and process scratch directories. Checked-in reports will
  carry reproducibility instructions and compact evidence.
- Fresh login shell: `/opt/homebrew/bin/deno`, Deno 2.9.4, V8
  15.0.245.2-rusty, TypeScript 6.0.3. `mise.toml` also pins Deno 2.9.4.
- Current verification head/base: `83ee6cf73f3b8ab9cd7fccd2d12bee09c518a15b`.
  Initial baseline evidence remains labeled `e059494c4599d344f59caabddfc87b588937c3dc`.
- Initial observed one-minute load: 5.34. Latency runs require load at or below
  the protocol's approximately 5 threshold throughout their measurement window.
  Other sessions' processes must remain untouched.

## Evidence rules

The historical report and its linked CLI investigation supply hypotheses.
Current normative specs, source, and regressions establish the contracts.

- `wavesBudgetExhausted` counts cycles, including zero-commit cycles. `waves`
  counts closures. Their ratio is not the fraction of committed waves that
  exhausted. Count cycles, closures, commits, and watermark advancement apart.
- `demandedInstancesMax` excludes the serving principal. Observe the serving
  session's tracked entities and graph directly, separately from client demand.
- #7193 changed the loader's backlink sync path. Its performance effect remains
  unresolved until controlled verification.
- Confirmation-specific work must be distinguished from enclosing demand-pass
  spans and concurrent watch waits. Summed overlapping spans are not wall time.
- The navigation fixture's citations and the scale fixture's absent citations
  are different workloads. Size comparisons must hold citation shape constant.
- Deadline- and scheduling-dependent counts can change with machine load.
- Use fresh isolated stores, adjacent alternating ON/OFF arms, and at least
  three paired repetitions for latency claims. Probe server, client, and baked
  shell posture before every run. Record heads, flags, fixture shape, runtime,
  load, cache state, commands, and completion conditions.
- Keep uninstrumented end-to-end measurement separate from profiling. Correct
  results, durable consequences, and watermark coverage are distinct checks.

## Recommendation ledger

Mechanism probes and baseline correctness suites have run for all six entries.
Controlled latency verification, expanded race regressions, and implementation
review remain outstanding. No production implementation or PR is complete.

| Order | Recommendation | Hypothesis and success criteria | Current evidence and decision | Branch / PR | Head / base | Validation and review | Remaining work |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | 5: narrow caller demand | A durable-schema index subscription preserves current-list creates and citations while reducing demand. Keep full-result demand as an explicit stress workload in both arms. | Fixture still sinks the schemaless full result. #7186 landed as `644a38111e813fc80ed496bef6ff29869839007d`; do not duplicate verb-discovery changes. Trace remaining CLI consumers. | Not created | Not assigned | Full and typed-index fresh-store seed readback passed OFF and ON at e059: five topics, six actual citation edges. No latency claim or PR review yet | Verify fresh-store index/full correctness, durable topics/citations and demand sizes; measure both arms; implement only after all six verification entries are ready. |
| B | 3: event visibility | An event-driven replica barrier avoids actual view-lag backstops while preserving stream order, event ID/index validation, deduplication, and one durable consequence. | At e059 and 83ee, two admitted entries remain absent after a covered sync; one explicit refresh application signal makes both visible. Duplicate admission is deduped. The e059 ON seed recorded five view-lag deferrals. A barrier implementation is not yet selected. | Not created | Not assigned | Real-memory visibility probe passed; existing events/stacked-shadow tests passed at e059 | Pin the serving drain itself under delayed application; pin queued events, duplicates, failure, teardown, sealed writes and shadowing; measure avoided backstops. |
| C | 1: terminal confirmation | Co-hosted reads can replace redundant syncs at a defined revision without weakening owning-result, full-address/scope, lease, rearm, or creation-race semantics. | #7193 landed as `3cdf2ab489ae59e684e03ec78e7e29dfb70650e2` and directly altered backlink sync. At e059 and 83ee, a plain terminal root incurs three sync calls but one watch. Departure/rearrival re-confirms it. The cost of the two confirmation calls and a safe direct-read replacement remain unquantified. | Not created | Not assigned | Real serving-loop probe passed; existing terminal and later-creation tests passed at e059 | Identify redundant syncs with revision evidence; separate confirmation costs from nested waits; retain later-creation and demand departure/rearrival controls. |
| D | 2: watch maintenance | Incremental session updates reduce whole-session scans/copies while preserving transactional publication and retiring orphaned interests. | Current add path stages a graph clone, copies the entity map, and rebuilds tracked IDs. Existing schema-scan caching is partial mitigation. | Not created | Not assigned | Real memory probe at 100/1,000/10,000 roots reproduced linear entity/graph copies, tracked-ID scans and two loaded-address scans on add; one-doc refresh scans all schema-closure entries. Existing focused memory tests passed. | Quantify runtime cost and pin mixed late-failure rollback; pin failed-add rollback, overlap, operation cursors, scopes, absent arrivals/removal, concurrency; benchmark additions, refresh, removal. |
| E | 4: sidecar work sharing | Source/artifact sharing reduces repeated resolution/compilation while each piece retains reconciliation and each space durably holds its closure. | #7228 landed at `0a567afdf8a1650d08729d9d858c0c686f402c99`; reuse its content snapshot and cross-space persistence contract. Distinct slots still fetch source and call compilePattern in both arms at 83ee; warm same-space calls hit the compiler cache. Each tested space holds the closure. Runtime plus registry epoch alone is not a valid cache contract. | Not created | Not assigned | Four distinct slots plus same-slot reuse passed in each arm; source lifecycle baseline suite passed | Quantify marginal source/artifact savings; verify owner origins, multi-space closure, deployment updates, epoch races, failure/retry, disposal. |
| F | 6: deadline and grace | Retain flush deadline; quantify grace timer firing, input bypass, and burst coalescing before selecting any change. | Deadline retained. Historical grace run is not evidence of a universal 300 ms floor or a justified constant change. | Not created | Not assigned | Controlled grace callback probe passed: 20 notes coalesced to one callback, yielding two passes; input drove a pass before the callback fired. No universal 300 ms floor. | Extend multi-user and creation-race controls; build cold-demand and multi-user controls; produce a separate evidence/documentation PR. |

## Review and delivery gates

Each PR records its exact intended base and head, cf-review findings and fixes,
red/green behavioral regressions, formatting, lint, type checks, affected package
tests, applicable pattern/documentation gates, and relevant ON/OFF integration
lanes. Review inspection includes all paginated inline comments, complete
GraphQL thread conversations, review summaries, and issue comments. Unresolved
or outdated feedback is inspected without author, date, commit, or line filters.

Valid findings receive a fix and a reply in their original thread. Disagreements
receive concrete evidence and retain any pending reviewer decision. Every push
requires fresh checks and automated review. Final PR status is a fresh query of
head, base, mergeability, checks, and threads. Dependent changes use gh-stack and
are propagated and revalidated when an ancestor changes.

After all six dispositions, a final combined checkout compares with the recorded
baseline using matching workloads. Record marginal and cumulative effects,
cold/warm rendering, seeding, durability, watermark behavior, and multi-user
controls. A blocked gate remains outstanding; partial verification never becomes
campaign completion.

## Outstanding verification gates

- Quiet-machine paired latency runs remain open. One-minute load exceeded 5
  throughout the initial seed runs, reaching about 66. All seed runs are labeled
  correctness-only; their durations do not justify a performance claim.
- The first seed readback's final demand maximum includes the broad verification
  reader, so its identical index/full maxima cannot measure seeding demand. The
  driver now captures server statistics after seeding and before readback.
- Serving-session graph size is observed directly by the in-process probe; client
  demand statistics exclude that session and cannot substitute for it.
- Initial baked binaries reported no embedded Git SHA. Their build commands,
  source head, and binary hashes were retained as provenance. Fresh builds embed
  the head with `COMMIT_SHA`; the driver rejects a server/workload head mismatch.
- #7221 landed at `83ee6cf73f3b8ab9cd7fccd2d12bee09c518a15b`, narrowing
  client traversal metadata independently of #7193. The campaign checkout was
  refreshed, and terminal/grace, event visibility, and sidecar probes passed
  again. Workload-scale evidence must be refreshed before production decisions.
- Initial focused runner validation passed 97 tests and 179 steps; focused memory
  validation passed 5 top-level tests and 9 steps; CLI discovery passed 1 test
  and 2 steps. These are baseline subsets, not repository-wide validation.
- No implementation branch or recommendation PR is complete. All six production
  dispositions remain open. The shared evidence prerequisite is in self-review.

## Shared evidence prerequisite

- Scope: seven verification/capture scripts, compact raw evidence, a historical
  baseline report, and this ledger. Production runtime and pattern code are
  unchanged; the index-demand experiment is retained as an unapplied patch.
- Branch: `codex/server-execution-topics-verification`; base
  `83ee6cf73f3b8ab9cd7fccd2d12bee09c518a15b`; PR [#7229](https://github.com/commontoolsinc/labs/pull/7229),
  initial reviewed head `ec78595dec79a52e7131b4249814854a9c17b343`. CI and
  automated review are pending; exact refreshed status is retained in
  `metadata/pr-7229-current.json` under the artifact root.
- Self-review: cf-review coverage was deep-read plus read-only review of watch,
  loader/event/grace, and seed/sidecar evidence. Findings addressed: provenance
  manifests and hashes; timer wake/deadline discrimination; guaranteed cleanup;
  precise source-closure, readback, and revision-sample wording.
- The final captured mechanism probes passed at 83ee, including zero competing
  timer wakes and zero exhausted cycles for the serving causal observations.
- Expanded runner baseline: 99 tests, 190 steps passed. Repository type checking
  passed. Documentation checking passed all 597 code blocks. Formatting and lint
  passed after the review fixes, as did explicit type checking of all seven
  scripts, history-index, conflict-marker, and control-character checks. Compact
  evidence hashes and the decoded ablation hash match their manifests.
- The current baked 30-topic browser journey passed OFF and ON, five measured
  iterations after one warm-up in each arm. They used identical fixture shape
  (120-word bodies; six citation edges among the newest three topics). Load was
  above 5 in both runs; neither is a valid latency comparison. These runs are
  the focused navigation benchmark, not complete integration lanes.
- Durable run manifests and results:
  `runs/captured-{serving,event,watch}-83ee-01/`,
  `runs/captured-sidecar-83ee-02/`,
  `runs/navigation-83ee-{off,on}-01/` under the artifact root above.
- Current-head full-demand seeding passed OFF and ON, verifying five topics and
  six citation edges. `runs/seed-full-83ee-{off,on}-02/` includes statistics
  captured before verification-reader demand. These are correctness runs;
  controlled index-demand comparison remains outstanding.
- PR #7229's first head completed its required CI checks successfully. Cubic
  requested timeouts around watch waits in thread
  `PRRT_kwDOL5jtCM6g8aeW`. Six deliberate stalls (setup flush, setup watch set,
  covered add, disjoint add, refresh, and removal) each exited unsuccessfully
  with Deno's unresolved-top-level-await diagnostic; their capture manifests
  recorded failure. The probe now prints the phase name before those waits.
  This follows the event-driven waiting guidance without imposing time limits.
  Healthy 100/1,000/10,000-root runs passed with the diagnostics. Evidence is in
  `runs/watch-stall-*-ec785-02/` and
  `runs/watch-phase-diagnostics-ec785-01/`. Review response and fresh-head CI
  remain pending.

## Follow-up verification observations

- At 83ee, the real serving drain deferred two admitted streams while their
  sidecars were absent from its replica. Its existing settle flushed their
  frames; both ordered consequences then landed in one durable commit before
  the held backstop fired. One armed deferral therefore did not impose a
  250 ms wait in this fixture. Manually firing that callback after completion
  repeated neither handler. `runs/event-drain-83ee-02/` retains source, command,
  manifest, and state snapshots; it does not establish backstop avoidance for
  other scheduling or shadowing cases.
- The refreshed typed-index seed passed OFF and ON with five topics and six
  actual citation edges. Before verification-reader demand, the ON full and
  index arms both reported a client-demand maximum of 1,012. This snapshot does
  not establish a demand reduction and excludes the serving principal. The
  remaining caller reads and actual serving-session sizes need attribution.
  Results: `runs/seed-index-83ee-{on,off}-01/`, compared with the full-demand
  runs above. All four remain correctness-only.

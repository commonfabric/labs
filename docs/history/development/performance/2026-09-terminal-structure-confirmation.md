---
status: historical
created: 2026-09-10
archived: 2026-09-10
reason: "Recommendation 1 terminal-confirmation mechanism and correctness observations during the topics campaign."
---

# Terminal structure confirmation: recommendation 1

The intervening confirmation sync loop duplicated the owning-chain reads and,
for a scoped chain, subscribed to additional addresses outside that chain.
Removing this loop reduced measured work while retaining the second traversal.
Verification also reproduced premature watermark coverage during piece creation
and a cycle-identity defect for same-ID backlinks across scopes. The candidate
fixed these correctness defects. No end-to-end latency improvement was
established.

The implementation base was `8814af62a7ddfd50262f3f2f98421f66519a3c95`, the
green head of [PR #7232](https://github.com/commontoolsinc/labs/pull/7232).
Recommendation 5 had already reached green in
[PR #7231](https://github.com/commontoolsinc/labs/pull/7231). This branch
depended on PR #7232 for recursive runner test discovery; it did not incorporate
PR #7231's caller-demand workload. Shared historical verification is in
[PR #7229](https://github.com/commontoolsinc/labs/pull/7229).

## Work isolated

| Fresh fixture                                   | Baseline sync calls | Candidate sync calls | Baseline serving watches / tracked interests | Candidate serving watches / tracked interests |
| ----------------------------------------------- | ------------------- | -------------------- | -------------------------------------------- | --------------------------------------------- |
| Three-hop space chain                           | 9                   | 6                    | 3 / 3                                        | 3 / 3                                         |
| Three-hop user chain plus absent space fallback | 14                  | 8                    | 6 / 6                                        | 4 / 4                                         |

Both traversals sync each actual address before reading its metadata. The
removed loop instead combined every observed ID with the root and space scopes.
The candidate kept the complete-link traversal and fallback. It used canonical
scope-aware link equality for cycle detection. Direct co-hosted engine metadata
traversal was not introduced: an independent resolver would need to preserve
subscription interests, relative links, and scoped reads.

These are exclusive call and interest counts, not summed nested timings. Covered
sync calls reuse watches, so the call reductions do not represent the same
number of network requests. The serving session's own holdings were measured
directly; `demandedInstancesMax`, which excludes that session, was not used as
its graph-size proxy. The marginal performance effect of #7193's per-hop
backlink sync change remained unresolved.

## Creation and coverage

The same runnable pattern and fresh-store setup ran against baseline and
candidate. A gate held the second traversal after its real root sync. A client
then admitted a piece whose demanded computed output was `n + 7`, with `n = 3`.
The fixture examined the engine's durable derived document after every wave
commit covering that creation. Baseline stored no total at watermark 2;
candidate stored 10 before coverage. This reproduced both without crossing a
flush deadline and after an explicit 100 ms crossing. A changed owning backlink
reproduced the same baseline overclaim.

An admitted write racing a load can leave the feed before that load's terminal
decision. The candidate retained intervening changed IDs for the active attempt,
rejected terminal decisions touching them, and retried after replica application
inside the settle loop. A required retry could therefore complete its
derivations before watermark coverage. Sealed foreign novelty prevented a
terminal decision until its shadow lifted, without spinning an immediate retry
loop. The flush deadline and demand grace were unchanged.

The controls also covered a sealed root, an unrelated pending native seal,
demand departure and return, actual chain-sync failure, late success and failure
after park, and a new lease holder while its predecessor's load was held. An
initial test attempted to reactivate the same `SpaceServer` object; that fixture
was rejected because the host creates a new object per tenure. The final
successor test used two servers over the same durable store.

The earlier source-missing probe established only entry into pattern loading. It
was not treated as proof of a runnable consequence. The final controls compiled
a real pattern, persisted its source closure, used real client demand, and read
the durable result independently of runtime overlays. Full sources, the exact
ablation patch, manifests, and recoverable raw outputs are in the
[portable evidence directory](../../../../scripts/server-execution-topics/evidence/2026-09-10-terminal-confirmation/README.md).

## Local validation

The full runner suite passed 1,406 tests and 8,693 steps, with one existing
ignored step. All 46 type-check groups passed. The same six integration files
passed in both baked postures on fresh stores: seven suites and 27 steps per
arm, including two-user voting and cross-session chained events. Server, client,
and baked shell posture were verified before each run. Their machine load
exceeded the quiet threshold; these runs supplied correctness evidence.

Four deliberate mutations failed their intended assertions: ignoring writes
racing confirmation, covering before a required structure retry, ignoring scope
in traversal identity, and omitting a cancelled settle timing span. Restored
controls passed. The timing test retained its original count assertions and
observed the actual completion event after resource teardown. The first full
runner draft failed that timing control and was rejected; the reported full
suite was the subsequent run after the correction.

The portable evidence includes exact mutation patches, build and run manifests,
source hashes, and recoverable outputs. Large local validation logs and full
statistics remained in the durable campaign archive named by the evidence
README. CI and external review had not run when this snapshot was written.

## Limits

The work counts justify eliminating the redundant loop; the deterministic
regressions justify the creation and scope fixes. They do not quantify topic
board latency. Five attempts to begin the separate quiet navigation series had
produced no eligible complete pair: completed overloaded arms were retained as
functional observations only. Deadline-cycle counts were not divided by
wave-closure counts, and no deadline count was treated as an invariant under
machine load. Final cumulative ON/OFF measurements and this recommendation's
marginal end-to-end effect remained outstanding.

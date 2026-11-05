---
status: historical
created: 2026-09-10
archived: 2026-09-10
reason: "Recommendation 2 mechanism verification and implementation evidence before PR review."
---

# Incremental watch maintenance

Recommendation 2 is justified by reproduced work proportional to the established
session on constant-size additions and refreshes. The implementation stages
changes by key, indexes watch ownership, and preserves complete replacement for
removal. This report records source and correctness evidence; it establishes no
end-to-end latency improvement.

The baseline is `27f10d2d4f02f125c0492e5d6288acb3f0da148b`. The
[portable archive](../../../../scripts/server-execution-topics/evidence/2026-09-10-incremental-watch/README.md)
contains exact patches, scripts, manifests, compact raw results, analysis, build
hashes, and replay instructions. It is an independent change targeting main;
recommendations 5, 3, and 1 are separate PRs. Shared campaign corrections are
recorded in [PR #7229](https://github.com/commontoolsinc/labs/pull/7229).

## Contract and implementation

The current memory protocol and implementation guidance require atomic watch
addition: failure must preserve delivered entries, graph state, watch intent,
sequence state, and operation cursors. Missing targets remain interests while
owned; overlapping watches and scoped identities retain their own coverage.
Explicit removal rebuilds complete provenance. Ordinary topology shrink does not
automatically retract already-delivered entities under this protocol.

Temporary staged maps read through exclusively held state and copy mutable
containers only when accessed. The canonical selector tracker retains its own
hashing and permissive-schema index. The object manager captures newly loaded
addresses during traversal rather than scanning every cached address before and
after. Schema-reference counts let refresh verify distinct dependencies without
scanning every unchanged ordinary document; verification still uses this space's
stored closure, including transitive schemas and corruption checks.

Once the engine and admission work finish, the exact registry session is checked
again. Evaluation, response construction, and publication then run without an
await. Failed stages are discarded; committed stages are not retained in live
state. Watch IDs, operation declarations, and scoped operation ownership are
indexed. Changed misses and entries reconcile against every remaining branch
owner. Accepted duplicate-ID replacement lists retain their existing semantics;
the exceptional normalization path rebuilds provenance when an owner departs.

## Controlled work counts

The same fixture runs baseline OFF, candidate OFF, candidate ON, baseline ON.
Each size uses a fresh real memory server/store and two loopback sessions. It
seeds independent `schema:false` roots, then adds a covered root, adds one new
root, changes one document and manually flushes, and removes one watch through
replacement. The probe explicitly sets and asserts execution posture before each
size. It has no serving runtime or shell; the separate integration captures
exercise those surfaces.

The following are yielded Map entries, including map/graph copying and frame
application, for the exact profiled patch:

| Operation                | Baseline at 100 / 1,000 / 10,000 roots | Candidate at all three sizes |
| ------------------------ | -------------------------------------- | ---------------------------- |
| Add covered root         | 411 / 4,011 / 40,011                   | 7                            |
| Add one root             | 1,119 / 11,019 / 110,019               | 16                           |
| Refresh one document     | 232 / 2,032 / 20,032                   | 30                           |
| Full replacement/removal | 1,609 / 16,009 / 160,009               | Same as baseline             |

Both execution postures produce those Map counts. The two whole-manager
loaded-address scans on addition visit 201 / 2,001 / 20,001 addresses on the
baseline and zero on the candidate. Those rows overlap underlying collection
traversal and must not be added to it.

Array instrumentation separately exposed operation-watch filtering after the
initial map improvement. With the operation-declaration index, OFF addition
visits 281 array entries/callbacks at every size, versus 2,383 / 21,283 /
210,283. OFF refresh visits 209 at each size, versus 621 / 4,221 / 40,221. ON is
also constant for these operations: 287 and 214 respectively. Raw site counts
remain in the archive. Full replacement retains whole-session work and adds
index maintenance: at 10,000 roots, array work increases by 60,000
entries/callbacks in each posture. These counts do not establish elapsed cost or
retained heap size.

The final operation-cursor and session-resume guards postdate the profile patch.
Their exact source and red/green controls are archived separately. The session
guard adds a registry lookup; its cost can depend on the number of sessions,
which is fixed at two here. The table is not relabeled as a later-head capture.

## Correctness and review

The focused scaling regression is red on baseline for delivered-map enumeration
and both loaded-address scans. Rollback controls compare graph, delivery,
watch/index, operation, and sequence state. Further controls cover shared
misses, arrival before retry, cross-branch ownership, operation-only ownership,
duplicate-ID semantics, large additions, and canonical tracker isolation in both
hashing modes. Existing scoped-session and schema-closure tests remain enabled.

Self-review used `cf-review` with deep review of publication, canonical tracker
staging, cache lifetime, schema indexing, and client intent, plus two
independent read-only reviews. Findings were fixed before pushing: inherited Map
upserts, callback semantics, large spread-argument failure after publication,
duplicate watch intent loss, orphaned operation ownership, cursor-map pairing
across engine access, and stale additions mutating a resumed session. The last
two have portable ablations that reproduce their specific failures. No
behavioral finding remains from that review; external PR review is still
required.

Local validation passed: memory 614 tests/577 steps, utilities 102 tests/887
steps, runner 1,405 tests/8,676 steps (one existing ignored step), all 46 type
check groups, formatting, lint, and the recorded documentation/dependency gates.
The final session guard was added afterward and passed 45 tests/38 steps
covering ACL, concurrent-watch, reconnect, and the new regression. Fresh baked
OFF and ON integrations then passed seven suites/27 steps each. Exact source and
validation boundaries are recorded in `validation.json`; a final comment
correction is the only production-source change after those integrations.

Both binaries identify baseline head plus the archived build patch and file
hashes. Server metadata, server statistics, client flags, and baked-shell
posture were checked for every integration run, including an intentionally
contradictory parent flag. The ON lane had a long cleanup phase; its raw output
is retained. No timing from these correctness runs is a qualified latency
result.

## Remaining campaign evidence

There are zero eligible complete quiet-machine latency pairs. These instrumented
counts establish a scaling mechanism, not a latency claim. The paired navigation
and final combined-head comparison remain required campaign work, including
cold/warm rendering, seeding, durable results, watermark behavior, and
multi-user controls. The 30-topic and 100-topic historical fixtures have
different citation shapes and are not a size-only comparison.

Main reached `6f0da47b213ccbdda8e8110198e9dbadd589eedb` during review, adding
source-update and scoped-conflict changes among other work. They do not replace
this watch optimization, but cumulative comparisons must apply them equally to
both arms. This report's recorded baseline remains explicit. PR CI and review at
the eventual head are separate gates; this snapshot does not declare the PR or
six-recommendation campaign complete.

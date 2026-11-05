---
status: historical
created: 2026-09-12
archived: 2026-09-12
reason: "Representative lunch-poll copy rehearsal and matched headless/browser measurements for design #7155."
---

# Representative lunch-poll copy rehearsal

This record covers an isolated copy of the representative lunch poll. It does
not authorize or describe an update to the live poll. The source was supplied by
the operator as a consistent SQLite snapshot; all pattern reads, source updates,
profile creation, and test votes used the local copy.

## Source and isolation

Snapshot: `team-lunch-rehearsal-20260912T001622Z.sqlite`, 4,379,738,112 bytes.
SHA-256: `b9d2940775106e203252f857094cbe5a2525fe27671d92ac6c92527a8664fd0b`. The
original file was preserved. `cf space clone` established a pristine copy and a
manifest of 105,230 scoped fingerprints, with no unhashable or ambiguous
entities. Generated cells were excluded by the clone tool's normal contract.

The server bound to loopback, used a dedicated writable memory directory, and
printed its rehearsal-clone banner. Server execution was explicitly disabled in
toolshed, shell and probe processes. A fresh local identity and disabled local
ACL enforcement allowed exercising the copy without an operator key. These
conditions test content migration and client execution; they do not test
production access control, hosting, network latency, or concurrent users.

The snapshot contained 14 options, 9 participants, 76 votes, and no visits.
Seventy-two votes carried September 8 UTC timestamps, two September 10, and two
September 11. The poll's local-calendar filter was kept intact. During the
September 11 America/Los_Angeles rehearsal, two original votes were visible. One
local test profile joined and cast one vote, giving matched measurement inputs
of 14 options, 10 participants, 77 stored votes and three current-day votes. No
original timestamps or profile links were rewritten.

Nine original participant profiles referenced nine home spaces absent from the
snapshot. Their badges displayed unresolved-profile fallbacks. Stored roster
names and vote identities remained available; a profile created through the
local UI supplied the test voter's cross-space profile. This is explicit partial
linked-profile coverage, not a full copy of every participant's home.

## Compared programs and measurement boundary

The deployed compiled module identity was
`pzofRLPO9pT6Mwguyr8rrjpN-jRss_KgJJME3C464Y4`. Source recovered from the local
copy used scan-based tallying. The candidate was the maintained-group poll
reviewed at `76097f0cc6a4112291d02d902cad688b5e46501f` and merged in #7336. Both
arms used that fixed runtime revision. All eight authored test entries were
supplied with each candidate source update; there were no attached data files.
All 93 authored assertions passed before the first apply.

The browser kept the poll's cards and summary mounted. The headless rig used the
same worker reconciler and DOM applicator in process, with `MockDoc` as the
document. A stale-attribute defect in that adapter was reproduced by a
regression test and corrected before accepting headless samples. Both source
arms used the same corrected adapter. Runtime error logs and the rendered
local-voter swatch were checked after each operation.

Setup and two warmup color changes were outside measurement. One green-to-yellow
vote collected completed reactive-body counters in the executing runtime. These
counters exclude handler and commit-preparation reads. Successful and failed
event-commit markers were recorded separately; they are not all storage
transactions. A subsequent yellow-to-green vote ran with accounting disabled.
The headless call awaited its handler commit and reactive/storage settlement;
the browser timer included trusted-click readiness, protocol, DOM and view
settlement. Their elapsed times are different end-to-end boundaries, not an
isolated measurement of worker-message overhead.

## Results

The second pass ran the following operations serially on matched inputs:

| Rig/source          | Body runs | Accesses | Maximum body | Link crossings | Event commits | Graph nodes | Graph edges | Elapsed ms |
| ------------------- | --------- | -------- | ------------ | -------------- | ------------- | ----------- | ----------- | ---------- |
| Browser, deployed   | 39        | 629      | 84           | 418            | 2             | 2,300       | 5,026       | 139.07     |
| Headless, deployed  | 39        | 629      | 84           | 418            | 1             | 2,255       | 4,938       | 235.81     |
| Browser, candidate  | 29        | 220      | 139          | 382            | 2             | 2,477       | 6,067       | 160.49     |
| Headless, candidate | 29        | 220      | 139          | 382            | 1             | 2,466       | 6,084       | 148.86     |

Reactive-body accesses fell about 65%, while the maximum body increased from 84
to 139 and the graph grew. Graph snapshots include the whole mounted runtime,
including shell and home subscriptions. The elapsed values are single samples:
the browser candidate was slower and the headless candidate faster. They do not
establish a uniform latency improvement. Browser and headless body counters
matched within each source arm. Browser dispatch passes through the row wrapper;
headless dispatch calls the bound vote handler directly, explaining the
different event-commit boundaries.

The browser's 14 rendered options and three current-day swatches matched across
source arms, with no runtime errors. These observations do not reproduce or
explain the design's historical approximate 45 ms versus 550 ms deployment
comparison; that estimate remains unconfirmed in the accepted local-copy scope.

The earlier synthetic profile-location comparison in #7340 separately held 74
votes and the runtime fixed while moving voter profiles between the poll space
and a dedicated profile space. Both browser variants reported 134 runs, 1,016
accesses, 896 link traversals and two successful event commits. That experiment
isolates profile location within its own cohort. Its absolute counts are not
comparable to this three-current-vote snapshot or to another runtime revision.

The budget fixtures demand and release VDOM for each render window, whereas
these mounted rigs retain their subscriptions. Their rematerialization limits
and completed-attempt totals are a separate measurement from continuously
mounted reactive-body counts. Fewer measured reads alone does not establish a
latency improvement or eliminate index initialization and maintenance cost.

## Preservation and repeatability

Both source checks and both updates passed compatibility acceptance without an
incompatibility override. The update receipts were
`ac63c62f-4c6e-4ec5-b4f1-4ce80e396fad` and
`c79efac9-1f38-47f3-9ed6-5f2326ccb7c2`. Before the second pass, strict reset
verification restored all 105,230 scoped fingerprints, with zero changed,
removed, or added entities and the original commit/revision counts. The original
100 authored entities also matched their saved hashes.

In the second pass, all 102 prepared authored entities matched immediately after
migration and after the final observation. Preparing the local test participant
and vote changed only the original input root among the original 100 entities;
original option, user, and vote entities remained unchanged. Whole-store
verification reported migration acceptance, an intact pristine baseline, zero
removed, 45 changed, and 930 added entities, with no ambiguous or unhashable
entities. Its changed free cells had the same audited categories as pass one.
The strict pristine verdict is intentionally false after migration; the
migration verdict and authored-data hashes answer separate questions.

The first migration preserved all 102 authored entities checked immediately
before and after apply. Whole-store verification reported zero removed entities,
45 changed and 867 added, with the pristine baseline intact. Its 21 changed free
cells were audited: 18 compilation records, one clock, one rendered VNode, and
one derived link. The authored-data comparison is necessary because a
whole-store migration verdict cannot distinguish a clobber from an intended
result rewrite.

An explicitly bounded churn observation showed five consecutive zero-commit
one-minute buckets from 00:43 through 00:47 UTC after the initial migration and
browser checks. Later diagnostic operations were separate writes. No sustained
write plateau appeared in that observed quiet interval. The server was stopped
before reset so the second pass could not use an unlinked database.

## Scope remaining

The second pass kept a settled browser mounted from 01:25:10 through 01:31:34
UTC. Its bounded churn observation recorded two commits and two revisions in the
01:30 bucket, and zero commits in the surrounding observed minute buckets. Both
writes were reconstructed and verified as the five-minute clock value
`1789176600000`. The observer closed after explicit settlement with no runtime
errors. No sustained write plateau appeared in this interval.

[PR #7391](https://github.com/commontoolsinc/labs/pull/7391) fixes the headless
adapter's attribute replacement, merged as
`b3f7972f245dd6ad2e2276aeae17c1f110c3cc80` after clean antagonistic and Cubic
reviews and 69 successful or intentionally skipped checks. The first CI attempt
hit the existing 1,184-vote render limit in a harness that discards DOM
operations and does not call this adapter. One diagnostic rerun passed with
unchanged limits. The negative regression failed against the stale setter; the
corrected HTML suite passed 28 tests and 287 steps.

## Q9 decision and consequences

Mike approved a separate lazy-materialization fast-follow on September 12 UTC.
The [follow-up plan](../../plans/lazy-materialization-fast-follow.md) owns
handler investigation/integration, rollout evidence, flag retirement, and
remeasurement in stages F0–F5. This allows the collection implementation and
copy-based acceptance to close without claiming those runtime stages are done.

The alternatives were to expand #7155 into those behavioral and rollout changes,
or leave them deferred without an execution sequence. The separate plan retains
explicit dependencies and acceptance criteria while avoiding both scope
expansion and an untracked handler exception. Handler work and lift-flag
retirement can proceed independently unless contract investigation establishes a
dependency.

The live poll remains unchanged. Any live update still requires operator
coordination and its own rollback preparation. The D1/D2 handoff does not claim
handler integration or flag retirement; those remain pending in the separate
plan.

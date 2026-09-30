---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Investigation record: the two scheduler scans whose cost grew with the size of a document's readership, what each was measured at, and what was left unfixed."
---

# The scheduler's per-write subscriber scan

Two places in the scheduler answered a question about one node by walking a
population that grows with the pattern. Both are on the path a write takes
between landing in storage and the actions it wakes, and both were found in a
CPU profile of the 1,184-vote lunch-poll read-scale fixture
(`packages/patterns/integration/fixtures/lunch-poll-read-scale/1184-votes.test.tsx`).

[The render attribution](2026-09-11-lunch-poll-render-attribution.md) is what
this continues: its section "What the rest of the minute was" names these two
as the part that stood after the memory engine's share was addressed. That
record's profile predates #7395; the one below is taken after it.

Measured 2026-09-15 on an Apple-silicon laptop that was running many other
build and test processes throughout: load average stayed between 130 and 230
for the whole session. Every elapsed time below is therefore inflated, and
none of the conclusions rests on one. What the conclusions rest on is counted
work, which the contention does not touch.

## Instruments

- A V8 CPU profile of one whole `cf test` run of the 1,184-vote fixture, taken
  in-process with `skills/perf-investigation/scripts/profile-cf.ts` and
  `CF_PROF_CPU=1` at a 1 ms sampling period. The run took 917 s of wall clock
  under that load and the test passed.
- `packages/runner/test/trigger-scaling.profile.ts`, added by this change: it
  drives a keyed collection of a declared size through the real scheduler,
  giving each member one action that reads that member alone, then writes one
  member and reports the trigger index's counted work for that write.
- A scratch build that computed both formulations of `hasInvalidUpstream()` on
  every call, counted each one's adjacency lookups, and threw if the two ever
  disagreed. Run against the 296-vote fixture.

## Finding 1: a write consulted every reader of the document

`determineTriggeredActions()` was handed every action subscribed to the written
document and filtered each one's read paths against the written path with
`arraysOverlap()`. The votes document carries roughly one subscriber per vote,
so the filter's cost was the readership's size, once per change. The 1,184-vote
render makes 6,579 commits.

In the profile: `arraysOverlap` 28.9 s of self time (3.1% of the sample), the
two closures inside `determineTriggeredActions` 22.7 s (2.5%) and 12.8 s
(1.4%), `determineTriggeredActions` itself 9.2 s (1.0%), and
`collectTriggeredActionsForChange` 3.1 s (0.3%). `arraysOverlap` has callers
outside this path — the topological sort, the writer index, the graph snapshot
— so its share is an upper bound on what the scan contributed.

The scaling profile, one write to one member of a collection of the stated
size, reporting the index entries the scan looked at per call — a registered
read path before, a trie node after:

| members | before | after |
| --- | --- | --- |
| 74 | 111.0 | 4.0 |
| 296 | 444.0 | 4.0 |
| 1,184 | 1,776.0 | 4.0 |

The log-log slope over that range went from 1.00 to 0.00. The "before" column
was measured on `d26a66df1b` with the same scaffold, and counters added to the
filter the index replaces.

The scaffold reports a second write the index cannot help with, and the
second column is why it is there. An append changes the collection's length,
so the change lands on the collection itself and reaches every member's
reader: 150.0, 594.0 and 2,370.0 entries per scan at the three sizes, a slope
of 1.00. That is the answer's own size rather than the index failing to
narrow, and it is the shape a scaffold reporting only the write it improves
would hide.

The same counters over one whole run of the 296-vote fixture, which is the
same scan doing the pattern's own work rather than a scaffold's:

| | scans | index entries visited | reads returned |
| --- | --- | --- | --- |
| before | 9,149 | 1,768,678 | 7,982 |
| after | 9,363 | 26,478 | 8,082 |

The scan and match counts differ by about 2% between the two because they are
separate processes whose wave boundaries do not fall in identical places; the
column that matters is the middle one.

## Finding 2: asking whether anything upstream is invalid walked everything downstream of everything invalid

`hasInvalidUpstream()` answered "is an invalid node transitively upstream of
this action" by seeding from every invalid node and walking the reader edge
forward until it reached the action. During a settle most of the graph is
invalid, so the seed set is large and its downstream closure is close to the
whole graph. It is called on each resubscribe that takes an action from dormant
to live, which a render does constantly. `reachesDependent`, the walk behind
it, was the largest named frame in the profile at 50.2 s of self time (5.5%).

Both formulations of the question, counted over one run of the 296-vote
fixture, which called it 6,545 times and answered true 929 times:

| formulation | adjacency lookups |
| --- | --- |
| from every invalid node, forward | 4,143,618 |
| from the action, backward, stopping at the first invalid node | 3,480 |

The two agreed on all 6,545 calls. The backward walk wins for the reason the
forward one loses: a wave in which much of the graph is invalid is the case
where the first writer reached is usually already invalid, so the walk stops at
once, while the same wave is what makes the forward seed set large.

## What the wall clock said

At 296 votes, little. Three pairs of that fixture, alternating so that
drifting load falls on both sides equally, settled in 133.6, 81.5 and 73.1 s
before and 89.5, 66.1 and 74.7 s after, and a fourth run of the unchanged code
in a quieter moment came in at 61.4 s, below every run of either side. The
spread within each side is larger than the gap between them.

At 1,184 votes most of the readings separate, which is what a cost that grows
with the readership should do. Three alternated pairs settled in 275.6, 131.7
and 306.3 s before against 129.0, 78.2 and 119.4 s after, and two further
unpaired runs in a quieter stretch gave 99.6 s before and 78.5 s after.

A fourth alternated pair contradicts them, at 93.0 s before against 141.8 s
after. Its two halves did not run under the same conditions: the repository's
own type check and test suite were started on the same machine partway
through, and they overlap the second half. That is a fault in how the pair was
taken rather than a reading against the change, and it is recorded here
because a run that disagrees is worth more to a later reader than a summary
that leaves it out.

What all of this says together is that the machine's own drift, more than a
factor of two across the session, is larger than the effect at 296 votes and
comparable to it at 1,184. The counted work above is what this record rests
on; the elapsed times point the same way in three pairs of four and are
offered as nothing more.

## What changed

`packages/runner/src/scheduler/entity-triggers.ts` holds one document's
subscribers in a trie over path components. A write reaches a read whose path is
a prefix of the written path or an extension of it and no other, so descending
the written path visits every prefix and the node the descent ends on carries
every extension below it. `SchedulerTriggerIndex` keeps one of those per
document instead of a map from action to paths, and hands
`determineTriggeredActions()` the reads a change can reach rather than all of
them. The overlap test inside that function is unchanged and still decides, so
the index is held only to returning a superset.

`hasInvalidUpstream()` walks the action's upstream cone instead, iteratively,
stopping at the first invalid node. `hasDependentPath()` and `reachesDependent()`
went with the old formulation; neither had a caller outside a test.

One correctness change came with it, found in review rather than sought.
Registering an action's reads used to compare the log it just produced against
the log it produced last time, and skip the index entirely when the two
matched. What an action last read and what the index currently holds are two
different facts, and `removeSpace()` moves only the second: after one, an
action re-running with identical reads never landed in the index again, and
its trigger stopped firing silently and for good. The comparison is now
against what the index holds, so it re-registers. `removeSpace()` has no
production caller today — it was a trap set for whoever wires one up rather
than a live fault — and
`packages/runner/test/scheduler-trigger-index.test.ts` pins it, failing on
`30f722cc94` and passing here.

Two things about the index are worth knowing when reading it. The trie is
derived from the per-action record it sits beside, so every registration and
removal asserts that the trie answers what a scan of that record answers,
under `ENV=test` and therefore throughout the runner's own suite. The empty
path is a prefix of every registered read, which is what makes one probe at
the root compare the whole trie against the whole record in a single pass and
keeps the check cheap enough to leave on with no way to turn it off. And the
order of the actions a change wakes is no longer the order they first
registered: re-registering an action moves it within its path's set. The
scheduler settles run order from the dependency edges and each action's
registration ordinal rather than from the order a change woke them, which is
what makes that safe.

## What was not changed

- The fixture's declared read budgets and its functional assertions. The
  1,184-vote fixture reports the same access counts before and after, twice on
  each side: 44,070 attempted and 3,554 maximum body accesses at step 4, 5,963
  and 3,554 at step 6, 2,379 and 2,371 at step 7. The profiled run above is the
  one reading that does not match, at 47,633 attempted accesses at step 4 on
  the unchanged code, so the CPU profiler's sampling moves that total; the
  other six steps agree across every run.
- `addDeclaredReadOrderingEdges()` and `addAdditionalWriteEdges()` in
  `packages/runner/src/scheduler/topology.ts` compare every action in a
  scheduler run batch against every other, which is quadratic in the batch.
  They were 18.5 s (2.0%) and, with `topologicalSort` around them, a further
  11.5 s (1.3%) of the profile. That is a different scan from the one this
  change addresses — ordering within a run rather than which actions a write
  woke — and it is the next candidate in this subsystem.
- The deep-freezing, content-hashing and encoding costs the same profile shows
  (`addToDeepFrozenCache` 34.0 s, the JSON encoder around 32 s in total,
  `utf8SortedKeysOf` 9.8 s), which belong to storage rather than the scheduler.

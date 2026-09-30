---
status: historical
created: 2026-09-11
archived: 2026-09-15
reason: "CPU attribution for the 1,184-vote lunch-poll headless render, taken while deflaking the pattern-unit shard."
---

# Where the 1,184-vote lunch-poll render spends its time

The CI job `Pattern Unit Tests (2/4)` was failing about as often as it passed
on main, always on
`packages/patterns/integration/fixtures/lunch-poll-read-scale/1184-votes.test.tsx`
and always with `Error: Action at index 3 timed out after 180000ms`. Step 4,
the first render, is the step that exceeds the cap. This records what that
step costs and what the cost is made of.

All data is synthetic. No deployed poll was read or written. Every
measurement is from one machine, an otherwise idle Apple Silicon laptop; the
CI runner is slower and runs five pattern tests at once, which is the
difference the cap turns into a failure.

## What the step costs

`deno task cf test --timeout 600000 --verbose` on the three fixture sizes,
reading the third `settle[0]` line, which is the first render's settle:

| Votes | Voters | Options | First render settles in |
| ----- | ------ | ------- | ----------------------- |
| 74    | 8      | 14      | 3.2 s                   |
| 296   | 24     | 14      | 9.0 s                   |
| 1,184 | 87     | 14      | 45 s to 57 s            |

The cost per vote is flat from 74 to 296 votes and about half again as high
at 1,184.

## What the time is made of

A CPU profile of the whole fixture through
`skills/perf-investigation/scripts/profile-cf.ts` with `CF_PROF_CPU=1` and
`--no-idempotency-check`, taken against main at `b3f7972f24`, so before
#7395. 65 seconds sampled, attributed by inclusive time:

| Inclusive | Share | Frame                                              |
| --------: | ----: | -------------------------------------------------- |
|   24.4 s  | 37.7% | the in-process memory server applying commits       |
|   14.5 s  | 22.3% | — snapshot materialization within it                |
|    6.8 s  | 10.5% | — pending-read conflict scans within it             |
|   10.3 s  | 16.0% | the scheduler running reactive bodies               |
|    8.2 s  | 12.6% | garbage collection                                  |
|    7.1 s  | 11.0% | committing each action's transaction                |
|    2.6 s  |  4.0% | the headless reconciler                             |

The render made 6,579 commits and 9,269 reactive runs, and read 44,070 proxy
accesses against a declared budget of 236,000.

By self time the largest single frame after the garbage collector was
`addToDeepFrozenCache` at 6.1 s, with `freeze` adding 1.7 s: the deep-freeze
pass over each rebuilt document, and a plausible share of the collector's own
8.2 s with it.

## The rebuild

Nearly all of snapshot materialization was one thing. Every commit read back
the revision it had just written — which decides whether a snapshot is due,
rejects a patch that cannot apply, and leaves the document where the next
reader will find it — and that read rebuilt the document by decoding the base
and replaying every patch since. Forty-seven consecutive patch commits to one
document replayed 248 patches and decoded the base 47 times.

#7395 changed the rebuild to resume from the newest revision of the document
the engine's decoded-document cache still holds. Under the same profile the
rebuild fell from 13.4 s to 5.7 s, the base decode within it from 5.0 s to
none, and deep-freeze from 8.1 s to 3.7 s. The render step, alternating the
two sides three times, settled in 72.2 s, 71.9 s and 61.2 s before and 56.9 s,
44.4 s and 50.2 s after.

What remains inside the rebuild is encoding the result to weigh it for the
cache, about 4 s of that profile.

## What the rest of the minute was

The scheduler's per-write subscriber scan. About 8.5 s of the 65-second
sample is `determineTriggeredActions` and `arraysOverlap` in
`packages/runner/src/reactive-dependencies.ts` together with
`reachesDependent` in the dependency graph. Each write to the votes document
walks every subscriber of that document, and the fixture has roughly one
subscriber per vote. This is the part whose cost per vote rises with the
fixture's size, and it stood when this was written.

## The cap

The render was never stuck when the cap fired: the shard took seven to eight
minutes rather than its usual four, so the cap was deciding the outcome by
wall clock on a machine whose speed nobody controls. `tasks/integration.ts`
passed `--timeout 180000` to every pattern test and ran five at a time, and
`packages/cli/lib/test-runner.ts` raced that against the settle loop. #7454
removed the option and the deadlines around settlement, disposal and
participant requests, leaving CI's own step and job limits to bound a run
that never completes. The fixture passed in 57.6 s there.

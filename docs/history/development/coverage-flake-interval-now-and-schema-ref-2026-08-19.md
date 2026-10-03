---
status: historical
created: 2026-08-19
archived: 2026-08-19
reason: "Investigation record: the four uncovered lines that moved the `packages/runner` coverage count between a pull request's run and its baseline."
---

# The grid instant and the `$ref` branch, August 2026

## Conclusion

[PR #6065](https://github.com/commontoolsinc/labs/pull/6065) changed no source
file under `packages/runner`, and its Coverage Check job reported that group at
4567 uncovered lines against a `main` baseline of 4563. It spent
`ACCEPT_COVERAGE_DEBT: packages/runner +4 lines`.

The four lines are two pairs, each a statement and the brace that closes the
branch holding it.

`packages/runner/src/builtins/wish.ts`, lines 1051 and 1052, in
`acquireIntervalNowTimer()` — the arm that republishes the `#now/N` grid cell
when the instant already in it belongs to an earlier interval:

```ts
} else if (existing !== coarsened) {
  writeIntervalNowTick(runtime, timer, intervalMs);
}
```

`packages/runner/src/traverse.ts`, lines 5029 and 5032, in
`canBranchMatch()` — the resolution an `anyOf` branch written as a `$ref`
needs before its type and required list can be checked:

```ts
if ("$ref" in branch) {
  resolved = resolveSchemaRefsCanonical(branch);
  ...
}
```

Neither pair was reached by any test in the `packages/runner` suite. Both were
reached incidentally by the workspace test job, and what decided whether they
ran was the wall clock in one case and the shape of a schema some other
package's tests happened to traverse in the other.

## What the runs measured

The pull request's run
[32318387562](https://github.com/commontoolsinc/labs/actions/runs/32318387562)
merged into base-branch commit `7c072e2b`, and its ratchet baseline was run
[32317777660](https://github.com/commontoolsinc/labs/actions/runs/32317777660)
at that commit. Both files are byte-identical between the two checkouts — the
pull request touched only `packages/memory` — so their line numbers and counts
compare directly. Summed over every coverage artifact each run uploaded:

| Line | Baseline run 32317777660 | Pull-request run 32318387562 |
| --- | ---: | ---: |
| `wish.ts:1051` | 1 | 0 |
| `wish.ts:1052` | 1 | 0 |
| `traverse.ts:5029` | 14 | 0 |
| `traverse.ts:5032` | 14 | 0 |

Exactly one artifact carries each pair, and they are different artifacts:
`coverage-profile-workspace-1` for the `wish.ts` pair and
`coverage-profile-workspace-7` for the `traverse.ts` pair. Both are shards of
the workspace test job, which runs every package's own test task except
`packages/runner`'s.

## The `#now/N` grid: whether an interval boundary fell in between

`acquireIntervalNowTimer()` runs when a wish asks for a `#now/N` grid the
process is not already ticking. The grid cell is content-addressed by space and
interval, so it can hold a value already: one an earlier acquire in this process
wrote before its last user released it, or one another session left behind.
Line 1048 guards the empty case, and only when the cell holds an instant from an
interval that has since passed does line 1051 republish the current one.

Reading `coverage-profile-workspace-1` around that branch — line 1048 counts
arrivals, 1049 the initializations of an empty cell, 1051 the republications —
across the baseline run, the pull request's run, and the previous `main` run
[32314698805](https://github.com/commontoolsinc/labs/actions/runs/32314698805),
whose commit `601dc9ae` holds the same two files unchanged:

| Run | Arrivals (1048) | Empty (1049) | Republished (1051) |
| --- | ---: | ---: | ---: |
| 32317777660, `main` | 4 | 2 | 1 |
| 32318387562, the pull request | 4 | 2 | 0 |
| 32314698805, `main` | 4 | 2 | 0 |

The same shard performs the same four acquires in all three runs and
initializes the same two empty cells. What moves is whether an interval boundary
fell between one acquire writing an instant and a later one reading it back,
which is a question about how long the job took in real time. Two consecutive
`main` runs disagree about it, so the line was covered on some runs and not on
others, and the group sat at its baseline with no headroom for the difference.

## The `$ref` branch: whether any traversed schema spelled one

`canBranchMatch()` is the cheap pre-check an `anyOf` branch passes before the
traversal commits to it. A branch arrives as authored, so one written as a
`$ref` into its own `$defs` carries no type and no required list of its own, and
line 5029 resolves it before either check can mean anything.

Reading `coverage-profile-workspace-7` — line 5028 counts arrivals at the
guard, 5029 the branches that were `$ref`s:

| Run | Arrivals (5028) | `$ref` branches (5029) |
| --- | ---: | ---: |
| 32317777660, `main` | 5792 | 14 |
| 32318387562, the pull request | 5722 | 0 |
| 32314698805, `main` | 5790 | 14 |

The shard makes about 5,750 pre-checks in every run. Whether any of them carries
a `$ref` is incidental to the schemas the packages in that shard happen to
traverse, and in the pull request's run none did.

## What the runner suite reached

Running the whole `packages/runner` suite with coverage — 1243 tests, `main`
at `365db0fd` — left all four lines at zero, along with `traverse.ts:5030` and
`5031`, the two rejections inside the same `$ref` block. Nothing in the package
constructs a stale grid cell, and no call to `canBranchMatch()` in the package
passes a branch with a `$ref` in it.

## What was done

Two cases, each in the file that already covers its subject.

`packages/runner/test/wish-now-interval.test.ts` seeds the grid cell for
`#now/60` with an instant one interval old, starts a wish on that grid, and
waits on the cell's first value after the stale one. The interval is a minute so
that the two writers are far apart in logical time: the acquire republishes the
current instant, and the boundary tick would write the next one a whole interval
later. Asserting the exact instant is what separates them — with line 1051
removed the case fails on the value, naming the boundary tick's instant against
the current one, rather than passing on the cell having changed at all.

`packages/runner/test/traverse.test.ts` states three `canBranchMatch()` cases
over `$ref` branches: a type behind a ref that accepts one value and rejects
another, a required property named behind a ref, and a ref that resolves to
nothing. The first two assert both directions, so a resolution that stopped
happening fails them; the third covers line 5031, which was uncovered on every
run rather than on some of them.

Line 5030 — the arm for a `$ref` that resolves to a boolean schema — is left
uncovered. `resolveCfcSchemaRefs()` merges a ref's siblings into its target, and
`canBranchMatch()` resolves a branch against itself, so a locally-defined ref
always resolves to an object. That line is uncovered on every run, which is what
the ratchet needs of it.

The runner test job shards eight ways and the gate unions the shards, so each
pair is now covered by whichever shard holds its file: measured at
`traverse.ts:5029` and `5032` covered 6 times each in shard 4, and
`wish.ts:1051` and `1052` once each in shard 3.

---
status: historical
created: 2026-09-17
archived: 2026-09-17
reason: "Investigation record: the one uncovered line that moved the `tasks` coverage count between two runs of one pull request branch."
---

# The kill beside the coverage gate's walk of `git rev-list`, September 2026

## Conclusion

[Run 35286551754](https://github.com/commontoolsinc/labs/actions/runs/35286551754)
reported `tasks` at 1775 uncovered lines against a baseline of 1774, and its
Coverage Check job exited 1 on that one line. The run belongs to
[PR #7685](https://github.com/commontoolsinc/labs/pull/7685), whose measured
commit changed a doc comment in `tasks/test-records-report.ts` and two
documents, and no line of the file the charge came from.

The line is 516 of `tasks/coverage-gate.ts` as that file stood at the measured
commit: the end of the empty `catch` beside the signal that `nearestOnBranch()`
sends the `git rev-list HEAD` whose output it is reading.

```ts
await reader.cancel().catch(() => {});
try {
  child.kill();
} catch {
  // It ended on its own, which is what reaching the root of the
  // history or losing its reader does.
}
await child.status;
```

`Deno.ChildProcess` waits for its child from the moment the child is spawned,
and `kill()` throws `TypeError: Child process has already terminated` once that
wait has resolved, whether or not anyone read `status`. The walk stops reading
as soon as one of the commits it was asked about appears, so what decides
whether the `catch` runs is whether git's own exit was observed before the
teardown reached the signal. Nothing in the suite asks for either order.

## What the runs measured

Two earlier runs of the same branch,
[35278961493](https://github.com/commontoolsinc/labs/actions/runs/35278961493)
and
[35280115426](https://github.com/commontoolsinc/labs/actions/runs/35280115426),
reported `tasks` at 1774. The branch was rebased between them, so the three
runs measured different trees; they did not differ in this file. Merging every
`coverage-profile-*` artifact of the 22:04Z run and of the failing run gives
the identical set of 350 tracked lines for `tasks/coverage-gate.ts`, and one
line of the 350 differs in whether it was reached.

| line | what it is | 22:04Z run | failing run |
| --- | --- | --- | --- |
| 509 | the `finally` | 11 | 11 |
| 510–513 | the reader cancel, the `try`, and the `kill()` | 9 | 9 |
| 516 | the end of the `catch` | 2 | 0 |
| 517–518 | the status await and the end of the `finally` | 9 | 9 |

One artifact of each run holds all of those counts: `workspace-3.lcov`, the
shard `tasks/coverage-gate.test.ts` landed on in both. Nine calls reach the
signal in each run. On the earlier run two of the nine landed on a child the
runtime had already reaped; on the failing run none of them did.

The 11 on the `finally` is the count of the range that encloses that line,
which is the call itself: `deno coverage` credits a line holding no range of
its own with the count of the range around it. The two calls between that 11
and the 9 below it are the ones that return before spawning anything, which is
what `nearestOnBranch()` does when it is asked about no commits at all.

A group's count is larger than the number of uncovered lines its reports name,
because `collectCoverageDebtMetricsFromLcov()` in `tasks/coverage-metrics.ts`
charges a file no report mentions as wholly uncovered. What compares between
two runs is the difference, and under `tasks/` the difference was this one
line: every other line that moved between the two runs moved by the number it
sits on, in a file the rebase shifted.

## What was done

The signal was removed rather than made reachable. The walk reads the child's
output with `for await`, and leaving that loop cancels the stream, so git ends
at its next write. That is what the comment above the spawn already said, and
awaiting the status is what reaps it. Measured on a 7,219-commit checkout of
this repository, a walk that finds its commit three back from the tip returns
in 14.6 ms with the child ending on `SIGPIPE`, and a walk for a commit the
checkout does not hold reads the whole history in 17.4 ms.

The suite had no case where git is still writing when the walk stops, because a
repository of two or three commits reaches the pipe in one write and exits on
its own. `tasks/coverage-gate.test.ts` now builds a history of 6,394 commits
through `git fast-import`, four times what a 64 KiB pipe holds, and asks for
the commit at its tip. Iterating the output with `preventCancel` set leaves the
five short-history cases passing and hangs that one, since git then blocks on a
pipe nobody is draining and the status never resolves. A hang is what this case
costs: it catches a teardown that stops stopping git by never returning rather
than by failing, and what names the case is the line the run stops on.

Ten local runs of the file's own tests under `deno test --coverage` on macOS
reported line 516 uncovered in every one, the nine calls never once finding the
child reaped. With the signal gone, five such runs report every line of the
teardown reached.

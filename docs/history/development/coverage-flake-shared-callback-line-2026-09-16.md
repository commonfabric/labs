---
status: historical
created: 2026-09-16
archived: 2026-09-16
reason: "Investigation record: the three uncovered lines that moved the `packages/runner` coverage count between a `main` run and the pull request measured against it."
---

# Three lines that two callbacks shared, September 2026

## Conclusion

[PR #7611](https://github.com/commontoolsinc/labs/pull/7611) changed no line of
`packages/runner/src/builtins/compile-and-run.ts` or
`packages/runner/src/builtins/llm.ts`, and its Coverage Check job reported
`packages/runner` at 5316 uncovered lines against a `main` baseline of 5314.

The three lines this record is about are line 228 of `compile-and-run.ts` and
lines 2464 and 2465 of `llm.ts`, as those files stood at the measured commit.
None of them holds a branch. Each sits where one callback argument ends and the
next begins:

```ts
// Shown for illustration only.
        (settleTx) => sendResult(settleTx, { pending, result, error, errors }),
        (hash) => {
          if (reportedCreatedHash === hash) return;
          reportedCreatedHash = hash;
          runtime.pieceCreatedCallback?.(result);
        },
```

An uncalled function's range does not stop at that function's own text.
`deno coverage` projects it back onto the original source through the source
map, which names positions sparsely, so it reaches from the last named position
at or before the function to the next one after it, and every line in that span
reports zero however much of the code on it ran. Line 228 above, which opens
the `reportCreated` callback, falls inside the span of the `announce` callback
on the line before it, and inside `reportCreated`'s own span. It is covered
only where both callbacks ran.

Both callbacks do run. `announce` runs when a served compile request is refused
before it launches, and `reportCreated` runs when a client sees a resolved
compile whose child has hidden its own result. What decides whether line 228 is
covered is whether one measurement ran both, and each arm was reached from a
different test file. Which shard a test file lands on is not something any test
asserts, so the answer changed when the split changed.

`llm.ts` lines 2464 and 2465 are the same thing one call later: the `},` that
closes the work `generateObject` starts once its tool-calling request commits,
and the `(error) => {` that opens the ending for a request refused before it
started.

Three of the four lines that went from covered to uncovered are these. The
fourth, `pattern-binding.ts:897`, is in a file the pull request did change, and
two lines of that same file went the other way, which is how three lines lost
here leave the group two above its baseline. Recomputing the package's whole
uncovered set from all thirty coverage artifacts of each run is what separates
the two accounts.

## What the runs measured

The baseline is
[run 35134187467](https://github.com/commontoolsinc/labs/actions/runs/35134187467),
`main` at `8d77005a`. The pull request is
[run 35137641991](https://github.com/commontoolsinc/labs/actions/runs/35137641991),
which merged into the same commit. Neither file is touched by the pull request,
so line numbers and counts compare directly.

Eight `coverage-profile-runner-*` artifacts measure the runner package's unit
suite in each run, one per shard, and the gate merges them by adding each
line's counts together. The tables below give the shards that carry the arms
these lines sit between; the other shards carry parts of each region and
nothing that bears on the lines themselves.

`compile-and-run.ts`, lines 224 to 232:

| line | what it is | baseline shard 3 | pull request shard 3 | pull request shard 7 |
| --- | --- | --- | --- | --- |
| 224–226 | the end of the arguments before the two callbacks | 296 | 37 | 0 |
| 227 | the `announce` callback | 296 | 37 | 0 |
| 228 | the `reportCreated` callback's parameter list | 296 | 0 | 0 |
| 229–231 | the `reportCreated` callback's body | 19, 15, 19 | 0 | 19, 15, 19 |
| 232 | the `},` closing it | 296 | 0 | 259 |

Merged, the baseline covers every line of that span and the pull request covers
every line but 228.

`llm.ts`, lines 2455 to 2468:

| line | what it is | baseline shard 3 | baseline shard 7 | baseline shard 1 |
| --- | --- | --- | --- | --- |
| 2455–2463 | the body of the work the request starts | 3 | 16 | 0 |
| 2464 | the `},` closing that work | 11 | 0 | 0 |
| 2465 | the refusal ending's parameter list | 11 | 0 | 0 |
| 2466–2467 | the refusal ending's body | 1 | 0 | 2 |

| line | what it is | pull request shard 3 | pull request shard 4 | pull request shard 7 |
| --- | --- | --- | --- | --- |
| 2455–2463 | the body of the work the request starts | 0 | 16 | 3 |
| 2464 | the `},` closing that work | 0 | 0 | 0 |
| 2465 | the refusal ending's parameter list | 0 | 0 | 0 |
| 2466–2467 | the refusal ending's body | 3 | 0 | 0 |

One baseline shard ran both arms and covered both lines. No shard of the pull
request's run ran both, and both lines went uncovered.

## Which files held the arms

The `test-records-runner-test-*` artifacts name the file each test ran from, so
the split is readable directly:

| file | arm it reaches | baseline shard | pull request shard |
| --- | --- | --- | --- |
| `test/builtins/compile-and-run-served.test.ts` | the compile refusal's `announce` | 3 | 3 |
| `test/executor-compile-and-run.test.ts` | the client's `reportCreated` | 3 | 7 |
| `test/builtin-abandoned-request.test.ts` | the `generateObject` tool-calling refusal | 3 | 3 |
| `test/generate-object-tools.test.ts` | a tool-calling request that completes | 7 | 4 |
| `test/generate-object-outbox.test.ts` | a tool-calling request that completes | 3 | 7 |
| `test/builtin-abandoned-request-supersession.test.ts` | the same refusal, superseded | 1 | 1 |

The compile pair was split by one file moving from shard 3 to shard 7. The
`generateObject` pair was split by the completing requests leaving shard 3 for
shards 4 and 7 while the refusal stayed behind.

## What moved the files

`tasks/select-runner-test-files.ts` assigns the shards. It weighs each test
file by its observed duration, gives a file absent from that profile a weight
of one, and packs the weighted list into eight bins. The assignment is a
function of the file list, so adding one file repacks the bins from the point
it lands at.

The pull request added one test file,
`packages/runner/test/cfc-reference-identity-reads.test.ts`. Handing
`selectRunnerTestFiles()` the base commit's 850 runner test files, and then the
same list with that one added, reproduces every assignment the two runs
recorded:

| file | 850 files | 851 files |
| --- | --- | --- |
| `builtins/compile-and-run-served.test.ts` | 3 | 3 |
| `builtin-abandoned-request.test.ts` | 3 | 3 |
| `executor-compile-and-run.test.ts` | 3 | 7 |
| `generate-object-tools.test.ts` | 7 | 4 |
| `generate-object-outbox.test.ts` | 3 | 7 |
| `cfc-reference-identity-reads.test.ts` | — | 6 |

The timing weights were the same at both commits, so the added file is the
whole of the difference. Any pull request that adds or removes a runner test
file repacks the bins the same way, and so does a refresh of the weights, which
is why a pair of test files that happen to share a shard is not something to
rely on.

## The same shape next door

Two adjacent callback arguments are not particular to a request's two endings,
and the same measurement finds other pairs one shard repack away from the same
failure. Counting the artifacts of the pull request's run that cover each
shared line:

| shared line | carried by |
| --- | --- |
| `packages/runner/src/queue.ts:102-103` | `coverage-profile-runner-5` alone |
| `packages/runner/src/storage/v2.ts:2630-2631` | `coverage-profile-runner-6` alone |
| `packages/memory/v2/standalone.ts:165-166` | `coverage-profile-workspace-8` alone |

Each is a promise's two settlements or a channel's two outcomes, and each sits
where `llm.ts:2464` sat on the baseline: covered by one artifact, so the next
change to the file list can take it away. All three were given the same
treatment as the two the gate caught.

## What was done

The callbacks were given names of their own, declared above the call, so that
each function's lines are its own and no line waits on two arms at once.
`compileAndRun()` declares `announce` and `reportCreated`; three of the
`enqueuePostCommitLLMWork()` calls declare `settleRefused`; and the direct
`generateObject` call, whose callback only forwarded, passes `settleAbandoned`
itself. `queue.ts`, `storage/v2.ts` and `standalone.ts` name theirs
`settleFailure`, `failLoad` and `failChannel`. Measured one test file at a time, every line of both regions is then
covered by at least one file: `compile-and-run-served.test.ts` covers the
announcement and `executor-compile-and-run.test.ts` the creation report, and
neither leaves a line that only the other could reach.

Two test cases were added alongside, for what they assert rather than for what
they measure.

`packages/runner/test/builtins/compile-and-run-served.test.ts` gained
`reports a resolved child to the creation hook once per request`. It seeds the
memo the server would have committed and the child result the child body would
have hidden, and asserts that the piece-creation hook is called with the
child's own value, that it is not called while that result is not yet hidden,
that a later run of the same request does not call it again, and that a
different program is reported in its turn. Nothing else in the tree holds
either of the two guards it exercises: with the request-hash guard removed, or
with the hidden-result condition weakened to a presence check, this case fails
and `executor-compile-and-run.test.ts` passes.

`packages/runner/test/builtin-abandoned-request.test.ts` gained
`sends generateObject's tools request and lands its result`, the control for
the tool-calling refusal that file already stated. That file's closing block
exists to show that the refusals above it mean something, and it carried a
control for every builtin except the tool-calling one. The new case answers the
request with a `presentResult` call and asserts the object that reaches the
result cell, at the strict enforcement posture the file configures.

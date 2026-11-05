---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Current-main diagnosis of eager nullable reads and an intermittent wrong-page notebook reload."
---

# Lazy materialization: reload diagnosis

This investigation continues the
[reload evidence](2026-09-14-lazy-materialization-reload-evidence.md) for the
[fast-follow plan](../../plans/lazy-materialization-fast-follow.md). It
identifies the eager error's input and one stalled browser's selected piece. It
does not establish the cause of every earlier stall or authorize flag
retirement.

## Revision and method

The baseline was `8fbf93d524b1be62144c9adb60575627bdfbbc84`, including the
merged synchronous lift-refusal fix. Runs used synthetic identities and spaces,
local servers on generated ports, and the notebook reload integration test. No
live piece or production snapshot was read or written.

The eager runs temporarily set the Runtime constructor's built-in
`lazyMaterialization` default to false and supplied
`EXPERIMENTAL_LAZY_MATERIALIZATION=false`. The constructor change includes
browser runtimes, for which that environment variable alone does not select the
posture. All browser runs used `EXPERIMENTAL_SERVER_EXECUTION=true`. Default-on
runs restored the constructor. All runtime diagnostic edits were restored after
the investigation.

Diagnostic variants logged nullable-cell reads or the URL and selected piece at
reload boundaries. Worker logging required `PIPE_CONSOLE=true` and
`FORWARD_WORKER_CONSOLE=1`. Diagnostic runs are separate from unchanged
controls; their timings are not performance measurements.

## Results

| Run                                              | Result                                                                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unchanged default-on reload                      | Passed, 1 test / 1 step, 18 seconds                                                                                                                       |
| Unchanged eager reload                           | Failed on browser `splitDefinitions` errors, 19 seconds; the notebook render assertions completed                                                         |
| Eager nullable-read diagnostic                   | Failed after 5 minutes 16 seconds; browser inspected on a note instead of a notebook, with one pending condition; teardown also reported the eager errors |
| Eager missing-hop diagnostic                     | Failed on browser errors, 21 seconds; render assertions completed                                                                                         |
| Eager absent-value diagnostic                    | Failed on browser errors, 15 seconds; render assertions completed                                                                                         |
| Default-on URL/selection diagnostic              | Passed, 1 test / 1 step, 18 seconds; notebook identity remained the same through reload                                                                   |
| Existing unresolved-input regression, eager      | Failed its no-action-error assertion with `body.split` on undefined; the null control passed                                                              |
| Existing unresolved-input regression, default-on | Passed, 1 test / 2 steps, 728 milliseconds                                                                                                                |

Two diagnostic attempts stopped at type checking and are not functional results.
A screenshot attempt after the stalled browser closed captured nothing; no image
is offered as evidence of that run.

## The eager error is a cold nullable-cell read

The traced errors occurred during note creation, before the source-ready and
reload markers. Both failing computations in `notes/note.tsx` read
`pendingEdit`, the staged filesystem-edit body. Its type is `string | null`,
initialized to null. They return early for null and otherwise call
`splitDefinitions`. Neither guards undefined, which is outside that declared
type.

The absent-value trace identified this exact cell:

- Space: `did:key:z6MkiJFxbEDnHWWcRLRwyhtPBuw1qmCk6oawkMLxaD5HAK1c`.
- Staged-edit cell: `of:fid1:KZve5ddftF4pURh8u-GSqtcBKliG-JslqN7oltTaBBQ`.
- Failing note: `of:fid1:rsnI1vBvI7PssFrDSHrQ-Hi9SKeLV0BzXt8p94ik0Q0`.
- Reader schema: an `anyOf` of string and null, with no default.
- Browser's resolved read: the same cell, space scope, empty path, undefined
  value, and no `pendingHopDoc` marker.

Read-only `cf inspect overlay` and `value-at` against the synthetic server store
found null at that cell, one space-scope revision, and no overrides. The
observation is client availability, not a persisted undefined edit. The
inspection does not establish exactly when the client received that revision.

The existing `unresolved-input-lift.test.ts` captures a related but distinct
case: a followed link into a missing document. Its eager failure demonstrates
that switching the flag off also removes the lazy branch's explicit
unresolved-input protection. It does not prove that the browser trace above
followed a missing document: that trace had no such marker.

An eager typed read can return undefined; the same invalid scalar under a lazy
view refuses. The result-disposition fix handles a thrown refusal, not an
ordinary TypeError after an eager read. Thus that fix cannot by itself make the
eager rollback posture pass these workloads.

## One stalled browser was displaying the wrong kind of piece

A read-only debugging connection to the isolated stalled page found:

- URL and app-selected piece both named
  `fid1:Z10ioM5R4VdfsH8RODa3Fm_hBkfaQ9hF03rj7iHVFqQ` in synthetic space
  `8c633c43-5871-40fb-879b-c43b89005b68`.
- The document title and piece name were `📝 New Note`.
- The current result exposed note fields such as `content`, `parentNotebook`,
  and `editProjection`, with no `isNotebook` or `noteCount`.
- One page condition remained installed after reload and login.

The test's next condition requires the selected result to be a notebook with
seven rendered note chips. A note cannot satisfy it. The earlier source-state
condition had completed, since execution reached reload. This locates the
observed stall but does not identify which event changed the destination, or
prove that the prior default-on stall had the same cause.

The test now captures the created notebook's identity, checks the selection
before and after reload, and reports the URL, selected piece, and render state
on a failed reload condition. The diagnostic is printed before teardown, whose
browser-error check can otherwise replace the condition's exception. It does not
navigate back to the expected notebook or relax the seven-note assertion.

## Remaining acceptance work

The [fast-follow plan](../../plans/lazy-materialization-fast-follow.md)
remains open. The next navigation investigation must correlate the created
notebook, final Create event, navigation intent, URL, and selected piece across
the reload boundary. A passing default-on run is not an explanation of a
previous failure.

The retirement decision must choose a rollback route that accounts for eager
nullable-read errors and its failed unresolved-input contract. Keeping the
switch requires addressing those failures if off is to be a supported rollback;
removing it requires the flag owner's approval and the remaining default-on
acceptance evidence. These findings do not justify silently treating off as an
equivalent rollback mode or adding empty-string fallbacks to note processing.

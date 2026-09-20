---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "F1/F2 record of the lazy-materialization fast-follow: the handler bound-context contract, a measured prototype, and the decision to defer it with the conditions for taking it up again."
---

# Lazy handler context: contract, prototype, and deferral

This is the F1 and F2 record for the [lazy materialization
fast-follow](../../plans/lazy-materialization-fast-follow.md). It specifies
how a handler's bound context could be read through a view while its event
payload stays eager, describes the prototype that implements that contract on
the runner's handler path, reports what its tests and its measurements showed,
and records the decision: the prototype is not integrated. The blocker, the
alternatives, and the conditions under which the decision should be revisited
are at the end.

The prototype, its tests, and the posture benchmark are on the branch
`codex/lazy-handler-context-prototype`, at commit
`b8da502953b1793719bebf76c02b5539ad1d278d`, built on `9b61f01934`: the [F0
baseline](2026-09-11-lazy-materialization-f0-baseline.md)'s revision plus the
first two of that record's commits, which add the presync timer and the
benchmark as it then stood. One defect the F0 inventory found on the lift path
has its fix on a branch of its own, `codex/lift-refusal-disposition`, and on the
prototype branch as well; see [What ships](#what-ships).

## The contract

The handler path reads its argument as one object, `{ $event, $ctx }`, under
the schema `generateHandlerSchema` builds: `$ctx` required, `$event` optional,
the event and state schemas' definitions hoisted to the root. The contract
divides that read at the same seam the closed-world gate already uses.

**The event payload stays eager.** It arrives inline and small. Where the event
schema is closed (`additionalProperties: false`), the closed-world gate has
already judged a present payload before the argument is read and rejected it if
it does not satisfy the schema; where the schema is open, the gate does not
judge it, and the eager read is what decides its delivery: a declared field the
payload does not satisfy reads as an absent event, never as a refusal inside the
body. Reading it eagerly keeps both of those the same in both postures. Nothing
about payload validation moves.

**The bound context is read through a view.** It is where a handler binds a
collection, and a view hands the body the paths it touches and nothing else.
The context read's root guard stands in for the whole argument's: a context
that fails it reads as an argument that did not resolve and takes the existing
`dispatchedHandlerNotRun` disposition. Below the root, every check happens
where the body touches, under the view's own rules: a required mismatch
refuses, an optional one reads as absent, an untouched mismatch is never seen.
Handles the context carries inherit the mark, so a body's read through a
`Writable` is a view too.

**A refusal is a handler that did not run.** Whether the body let the refusal
escape, caught it, or reached it after an `await`, the runner records
`dispatchedHandlerNotRun` with the refusal's reason, clears the mark, writes no
receipt, starts no result pattern, and returns. The scheduler's event finalize
then does what it does for an argument that read as `undefined`
([events](../../../specs/server-side-execution/events.md), §5): it withdraws the
transaction, the writes the body made before the refusal with it, and, where the
dispatch is re-delivered at all, re-runs it, parked on the loads the run's own
reads registered when the refusal was a document the replica does not hold yet,
otherwise on the bounded backoff that turns a permanent mismatch into a visible
failure. A served dispatch takes the same withdrawal through its deferral arm.
The scheduler's third arm is different: under server execution, a client
dispatch with no served carriage is the speculative echo of an entry the server
re-drains, and its skip seals rather than withdraws, so a refusal after a write
on that arm is a question the prototype leaves open. Receipt identity, duplicate
delivery, retry, and effects are unchanged because the success path is
unchanged: only a run whose body completed without a refusal reaches result
handling.

**The mark's lifetime is the argument read and the body.** The dependency
preflight, the presync, the trusted-write collection, result handling, and the
scheduler's own reads run unmarked and eager, as before. Under the flag the
handler's post-run consumes any refusal recorded on its transaction, whichever
site recorded it; with the flag off the handling completes as it does today.
The prototype meets the second half only in the post-run: its catch and its
rejection handler dispose of a thrown `SchemaMismatchError` without consulting
the flag, so with the flag off a refusal thrown into a handler body — the
collection index key builtin records one on an unmarked transaction — would
become a handler that did not run rather than the handler error it is today.
Gating those two paths on the flag is open work for whoever takes the
prototype up.

## The prototype

Three changes to [`runner.ts`](../../../../packages/runner/src/runner.ts) on the
prototype branch; two implement the contract, and the third is the lift-path fix
under [What ships](#what-ships):

- `#readJavaScriptHandlerArgument` reads `{ $event }` eagerly, marks the
  transaction, reads `{ $ctx }` through the view, and hands the body
  `{ $event, $ctx }`. A schema that is not the generated shape, a `cid:`
  reference at rest among them, takes the whole-argument eager read. The two
  half-schemas are interned once per handler schema and carry its `$defs` and
  `definitions`, so a `$ref` inside either resolves.
- The handler wrapper's post-run clears the mark, takes a recorded refusal under
  the flag, and disposes of it as not-run; its catch and the rejection handler
  on an async body route a thrown refusal to the same disposition directly, so a
  refusal the argument read itself throws, before any post-run exists, is
  disposed of too.
- The lift path's `postRun` is assigned before the body is invoked, the same fix
  `codex/lift-refusal-disposition` carries.

The prototype is gated on the existing `lazyMaterialization` flag, so one
runtime option selects both postures for the benchmark and the tests. Nothing
in the scheduler changed.

### What the tests pinned

`handler-lazy-context.test.ts` on the prototype branch dispatches real events
to compiled handlers and observes the outcome from outside, in every case but
the two-runtime block described below. It pins:

- a one-element read of a plain context resolves fewer links than the eager
  read does, and so does a read through a bound handle;
- a run whose body touched a required field the data does not carry is
  withdrawn — no commit, no callback — and re-runs once the data is fixed,
  with the callback firing once, on the run that wrote, and a receipt for it;
- a refusal the body caught, and one an async body reached after an `await`,
  take the same disposition;
- a mismatch in a row the body never touches lets the run proceed;
- an absent optional field reads as `undefined`;
- a valid event payload is delivered the same way in both postures;
- a value read through the view and returned as the handler's declared result
  reads back from the receipt as a plain value;
- with the flag off the same data skips the run eagerly.

`lift-refusal-disposition.test.ts`, on the fix's branch, pins that a lift body's
synchronous refusal writes an undefined result under the view, and that the same
data yields an undefined result under the eager read. At the F0 baseline's
revision, `a44d9389c3`, its lazy case fails with the previous result standing,
which is the defect named under [What ships](#what-ships); the prototype commit
carries the fix and passes it.

A two-runtime block pins the contract difference that decides F2, and it
isolates the transaction mark rather than the prototype's argument read: the
handler is registered on the scheduler directly and marks its transaction by
hand, so the property shown is the mark's, which the prototype's read path sets.
Two runtimes share one store; the handler on the first reads the first row of a
list under the given posture, holds its transaction open at a barrier, and
writes after it; the second runtime writes while the barrier holds. Three writes
are tried, each against both postures. A write to a field of the second row,
which the body never touched, makes the eager handler's commit retry and the
lazy one commit on its first run. A write to a field of the first row, which the
body read, makes both postures' commits retry, and so does an append to the
list, which changes the list's shape at the path the view read to reach row 0, a
path in the read set under either posture. So what a view removes from the read
set is the fields of rows the body did not touch. The list stays in it, and so
does each row the body touched, whole: the block's rows are inline objects, and
a view takes a recursive read at the slot to derive an inline element's identity
(`createArrayView` in `schema-view.ts`). A row held as a separately addressed
cell registers its shape and the fields the body read, so a concurrent replace
of another existing field of that row stops conflicting while a whole-row write
still does.

Not exercised by the prototype's tests: a mismatched event payload, whose
absent-event delivery follows from the payload being read eagerly and unmarked
rather than from a test; a handler schema that is not the generated shape, which
takes the whole-argument eager read; receipt identity across a duplicate
delivery; an external effect launched before a refusal; a served dispatch, whose
not-run disposition rests on the existing `dispatchedHandlerNotRun` tests, since
the prototype sets that marker and nothing else the serving loop reads, and
whose receipt and effects are not pinned; a client dispatch under server
execution with no served carriage, whose skip seals rather than withdraws; a
cold linked document parked on its load; read and write snapshots inside the
body; a view itself escaping into result handling; a schema default followed by
the value's arrival; a context bound across spaces; labels read before and after
policy preparation; and the argument-read path itself under a concurrent write,
since the two-runtime block marks by hand. The plan's F1 bullets that name these
stay open.

## Measurements

The [F0
benchmark](../../../../packages/runner/test/handler-dispatch-cost.bench.ts) was
extended on the prototype branch with a posture dimension, so each variant runs
with the flag off and on over the same seeded list. The run was taken on the
same machine and Deno as the F0 record, after the reviewers and test suites that
had been sharing the machine finished. The benchmark asks for seven samples
after one warmup; `deno bench` recorded nine or ten timed invocations per
variant, and values are medians over those after the first. The accounting
pass's one dispatch per variant runs with read accounting on and is not a timing
sample.

The prototype's copy of the benchmark reads each phase timer's last sample after
the dispatch, as the F0 benchmark did when the branch was cut; the benchmark on
the main line has since moved to the time each timer accumulated across the
dispatch, and the F0 record's tables were regenerated that way. So the phase
columns here are not directly comparable to the F0 record's: `Preflight` is the
populate step of the last of the two passes a dispatch runs, not both. `Handler`
is the scheduler's timer around the handler action, which spans the argument
read, the body, the post-run, the trusted-write collection, and the commit's
preparation and synchronous steps; `Commit` sums the three commit timers, which
run inside that span. `Event links` is the handler attempt's link resolutions
from the accounting pass. Elapsed includes scheduler ticks and the commit's
asynchronous remainder, which no timer covers, and moves between runs:
`scalarKey`, which does nothing differently under the view beyond a read a few
hundredths of a millisecond longer, drops from 85.8 to 62.1 ms elapsed at 1,184
rows, so the column cannot be read as posture, and the phase columns are the
figures to read.

| Rows  | Workload      | Posture | Elapsed | Presync | Preflight | ArgRead | Body  | PostRun | Handler | Commit | Event links |
| ----- | ------------- | ------- | ------- | ------- | --------- | ------- | ----- | ------- | ------- | ------ | ----------- |
| 74 | `scalarKey` | eager | 9.3 | 0.18 | 1.47 | 0.07 | 0.08 | 0.11 | 0.49 | 0.09 | 7 |
| 74 | `scalarKey` | lazy | 9.4 | 0.18 | 1.28 | 0.08 | 0.14 | 0.11 | 0.57 | 0.10 | 9 |
| 74 | `scalarGet` | eager | 12.0 | 0.24 | 1.34 | 0.07 | 0.61 | 0.13 | 1.64 | 0.48 | 80 |
| 74 | `scalarGet` | lazy | 10.4 | 0.21 | 1.46 | 0.09 | 0.18 | 0.14 | 0.73 | 0.12 | 9 |
| 74 | `walk` | eager | 18.7 | 0.26 | 1.52 | 0.06 | 1.10 | 0.13 | 2.92 | 0.91 | 80 |
| 74 | `walk` | lazy | 18.4 | 0.31 | 2.00 | 0.11 | 2.25 | 0.24 | 5.34 | 0.93 | 82 |
| 74 | `mutate` | eager | 14.3 | 0.31 | 1.90 | 0.08 | 0.55 | 0.12 | 1.37 | 0.24 | 10 |
| 74 | `mutate` | lazy | 12.6 | 0.26 | 1.69 | 0.09 | 0.60 | 0.10 | 1.25 | 0.21 | 12 |
| 74 | `plainScalar` | eager | 12.9 | 0.73 | 1.40 | 0.51 | 0.04 | 0.13 | 1.45 | 0.43 | 80 |
| 74 | `plainScalar` | lazy | 12.4 | 0.73 | 1.46 | 0.09 | 0.15 | 0.13 | 0.67 | 0.11 | 8 |
| 74 | `plainWalk` | eager | 19.8 | 1.36 | 1.48 | 1.16 | 0.05 | 0.16 | 2.83 | 0.82 | 80 |
| 74 | `plainWalk` | lazy | 13.5 | 1.21 | 1.27 | 0.09 | 1.71 | 0.16 | 2.86 | 0.63 | 81 |
| 296 | `scalarKey` | eager | 18.8 | 0.27 | 4.75 | 0.06 | 0.09 | 0.12 | 0.55 | 0.10 | 7 |
| 296 | `scalarKey` | lazy | 17.5 | 0.22 | 4.19 | 0.08 | 0.15 | 0.11 | 0.58 | 0.09 | 9 |
| 296 | `scalarGet` | eager | 28.1 | 0.31 | 4.73 | 0.06 | 2.00 | 0.14 | 4.24 | 1.37 | 302 |
| 296 | `scalarGet` | lazy | 17.0 | 0.20 | 3.91 | 0.08 | 0.15 | 0.11 | 0.56 | 0.09 | 9 |
| 296 | `walk` | eager | 49.9 | 0.30 | 5.26 | 0.07 | 4.66 | 0.20 | 9.93 | 2.86 | 302 |
| 296 | `walk` | lazy | 34.4 | 0.31 | 6.05 | 0.10 | 7.23 | 0.27 | 11.97 | 2.52 | 304 |
| 296 | `mutate` | eager | 24.9 | 0.34 | 5.18 | 0.06 | 0.76 | 0.09 | 1.38 | 0.22 | 10 |
| 296 | `mutate` | lazy | 23.5 | 0.29 | 4.69 | 0.09 | 0.79 | 0.09 | 1.42 | 0.22 | 12 |
| 296 | `plainScalar` | eager | 37.9 | 2.82 | 5.49 | 2.33 | 0.06 | 0.20 | 5.72 | 1.48 | 302 |
| 296 | `plainScalar` | lazy | 21.8 | 2.72 | 5.28 | 0.12 | 0.17 | 0.13 | 0.76 | 0.12 | 8 |
| 296 | `plainWalk` | eager | 55.6 | 5.50 | 5.00 | 3.94 | 0.05 | 0.17 | 9.29 | 2.92 | 302 |
| 296 | `plainWalk` | lazy | 34.8 | 4.42 | 4.25 | 0.11 | 6.01 | 0.19 | 9.85 | 2.48 | 303 |
| 1,184 | `scalarKey` | eager | 85.8 | 0.54 | 26.98 | 0.08 | 0.11 | 0.18 | 0.73 | 0.11 | 7 |
| 1,184 | `scalarKey` | lazy | 62.1 | 0.41 | 19.97 | 0.10 | 0.19 | 0.13 | 0.72 | 0.11 | 9 |
| 1,184 | `scalarGet` | eager | 112.3 | 0.67 | 22.86 | 0.08 | 9.29 | 0.25 | 18.40 | 6.79 | 1190 |
| 1,184 | `scalarGet` | lazy | 51.0 | 0.32 | 17.20 | 0.08 | 0.16 | 0.12 | 0.62 | 0.10 | 9 |
| 1,184 | `walk` | eager | 189.9 | 0.43 | 19.52 | 0.07 | 19.81 | 0.22 | 38.41 | 11.75 | 1190 |
| 1,184 | `walk` | lazy | 110.9 | 0.38 | 20.03 | 0.10 | 27.32 | 0.22 | 40.08 | 11.41 | 1192 |
| 1,184 | `mutate` | eager | 74.6 | 0.39 | 18.81 | 0.06 | 1.89 | 0.10 | 2.71 | 0.37 | 10 |
| 1,184 | `mutate` | lazy | 81.8 | 0.44 | 20.82 | 0.11 | 2.07 | 0.11 | 3.00 | 0.39 | 12 |
| 1,184 | `plainScalar` | eager | 181.6 | 13.35 | 26.96 | 16.45 | 0.07 | 0.39 | 32.99 | 8.80 | 1190 |
| 1,184 | `plainScalar` | lazy | 88.2 | 12.20 | 24.37 | 0.17 | 0.20 | 0.17 | 1.00 | 0.13 | 8 |
| 1,184 | `plainWalk` | eager | 262.2 | 21.99 | 22.16 | 21.13 | 0.08 | 0.28 | 43.74 | 13.37 | 1190 |
| 1,184 | `plainWalk` | lazy | 160.9 | 24.77 | 24.84 | 0.18 | 29.80 | 0.26 | 45.62 | 12.67 | 1191 |

Four things the table shows:

1. **A whole-list read that touches one element drops to the cost of a keyed
   read.** At 1,184 rows `scalarGet`'s body goes from 9.3 ms to 0.2 ms and its
   handler action from 18.4 ms to 0.6 ms; `plainScalar`'s argument read goes
   from 16.5 ms to 0.2 ms and its handler action from 33.0 ms to 1.0 ms. The
   commits shrink with the read set they carry, from 6.8 and 8.8 ms to 0.1 ms.
   The handler attempt resolves eight or nine links instead of 1,190. That is
   the measured consequence the plan asked for, and it is real.
2. **A full walk's body costs more under the view, at every size.** `walk`'s
   body is 27.3 ms against 19.8 ms at 1,184 rows, 7.2 against 4.7 at 296, and
   2.3 against 1.1 at 74 — the same direction at all three sizes, by 38, 55, and
   105 percent, which is what makes it attributable to posture within the
   variance finding 4 states — and the commit is the same size. For `plainWalk`
   the argument read falls from 21.1 ms to 0.2 while the body rises from 0.1 to
   29.8, so the saving does not cover the increase; the handler action column
   differs by under 2 ms between the postures, in the same direction at every
   size but inside the variance, and is set aside on magnitude where the body
   gap is admitted on magnitude and repetition both. The per-column medians are
   taken independently and do not sum.
3. **Keyed reads and writes pay a small fixed cost and nothing else.**
   `scalarKey` and `mutate` read through `key()` and never materialize the list.
   Under the view their argument read is 0.01 to 0.05 ms longer and their body
   0.03 to 0.18 ms longer, in the same direction at every size, which is the
   cost of the split read and the view's own dispatch, and is too small to
   matter rather than absent. Their link counts move the same way: `scalarKey`,
   `mutate`, and `walk`, whose set of rows reached the view does not change,
   each resolve two links more lazily than eagerly at every size, and
   `plainWalk` one more; `scalarGet` and `plainScalar` collapse to nine and
   eight, which is finding 1. The prototype reads the inputs cell twice, once
   per half-schema, which is one of the two; what the context shape adds is an
   observation this record does not explain.
4. **The preflight and the presync are unchanged by construction**, since the
   prototype does not touch them. The preflight remains the largest fixed cost
   of every dispatch, as the F0 record found: its two passes together cost about
   twice the `Preflight` column here, which holds one pass, 34 to 54 ms total at
   1,184 rows. The presync tracks the context shape, from 0.3 ms for a handle to
   25 ms for a plain one at 1,184 rows. Their columns are also the measure of
   run variance: `scalarKey`'s preflight reads 27.0 ms eager and 20.0 ms lazy at
   1,184 rows with nothing between the postures to explain it, about a quarter
   of the value, so a difference elsewhere in the table counts as posture only
   where it is larger than that or repeats in the same direction at every size.

## Decision

F2's outcome is a deferral. The prototype preserves the event contract, its
disposition of a refusal is the one the design asks for, and its tests pass.
It is not integrated, for two reasons that compound.

**A view narrows the read log a handler's commit is checked against.** The
two-runtime block shows exactly how far: a concurrent write to a field of a row
the body never touched no longer conflicts with the handler's commit, while an
append to the list and a write to a row the body read still do. On the lift path
a narrower read set changes only when a node re-runs; on the handler path it
changes which concurrent writes a commit refuses. A handler whose walk touches
one field of every row keeps its guard against appends and against changes to
that field — the lunch poll's `addOption` and `removeOption` read every vote's
`optionId`, and a concurrent cast either appends or rewrites the vote it names,
`optionId` included, so their guards survive a view — and, where rows are
separately addressed cells, loses it against a replace of any other existing
field of those rows. There is no way for a handler to say which of its reads are
for conflict detection rather than for the value, so where the change bites, it
bites silently.

**The measured win is confined to a shape the guidance already steers away
from.** A handler that reads a whole list and touches one element is what keyed
addressing exists to replace: `elementById` in a handler ([keyed collection
writes](../../../features/keyed-collection-writes.md)), which is what the lunch
poll's handlers use, and `lookup` in a pattern body ([reactive
collections](../../../common/concepts/reactive-collections.md)). The shapes that
remain are keyed reads, which pay a little more, and full walks taken for their
conflict set, which pay the body penalty finding 2 measures, so the change would
ship its contract cost to every handler for a win few would collect.

What the deferral does not touch: for a handle-bound context, the shape the
lunch poll's handlers take, the argument read was never the cost. For a plain
context it is — 16 to 21 ms at 1,184 rows, which the prototype removes — but the
dependency preflight and the presync walk the same list on every dispatch, cost
more together than the read did, and are not something a view can serve. The F0
record's finding stands.

### Alternatives considered

- **A per-handler opt-in** rather than a runtime flag, so a handler that reads
  a large list and touches little of it can ask for a view and accept the
  narrower conflict set knowingly. This needs a builder-level declaration and
  an owner's ruling on its shape; it is the form the prototype would take if
  the conditions below are met.
- **A lazy preflight**, populating the dependency and load-park set from what
  the handler would touch rather than from everything it could reach. This is
  where the F0 measurement puts the cost, and it is a different piece of work
  from this plan's: the preflight exists to find invalid upstream computations
  and in-flight loads the body would read through, which a touch-scoped view
  cannot know before the body runs.
- **Integrating under the existing flag.** Rejected: it ships the read-set
  change to every handler at once, with no way to ask for the old contract.

### Conditions for revisiting

Take the prototype up again when any of these holds:

1. A handler can declare its conflict set independently of what it
   materializes — a read that registers recursively without building the
   value, or a precondition declaration — so a view's narrower read log stops
   being a silent change to concurrency behavior. Or an owner rules that
   touched-path preconditions are the contract handlers should have.
2. A view's full walk costs no more in the body than an eager read of the
   same list, so the walk shapes stop paying for the scalar shapes' win.
3. A measured pattern reads a large collection inside a handler and touches
   little of it, and keyed addressing cannot serve it.

## What ships

- The lift path fix, on `codex/lift-refusal-disposition`: `postRun` is
  assigned before the body is invoked, so a refusal the body throws
  synchronously is disposed of — an undefined result through the ordinary
  path, no action error — as the design states and as a rejection out of an
  async body already was. `lift-refusal-disposition.test.ts` pins it in both
  postures. It is held rather than merged: the pattern vintage replay gate
  shows the fix clearing a derived value the defect had preserved on the
  lunch poll's recorded state, where the linked document the value derives
  from is absent from the replica, and the gate's owner decides how its
  expectation moves.
- This record, the plan's F1/F2 state, the feature document's statement of why
  handlers stay eager, and the design plan's Stage 5 entry.

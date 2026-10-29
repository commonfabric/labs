---
status: historical
created: 2026-10-16
archived: 2026-10-16
reason: "Counts and profile attribution from a thirty-message FabriChat room's cold load, October 2026, of the render's cell sinks: every one of the 5,584 sinks a load subscribes reads a view no other sink reads, 40 of its 218 re-fires re-read an unchanged value, the sink's own read is an eleventh of the worker's busy samples rather than the quarter an outermost-frame attribution reports, and forwarding the per-transaction link memo through the sink's transaction wrapper changes none of it."
---

# What the render's sinks cost on a FabriChat room's cold load, October 2026

The cold-load profiles of a thirty-message FabriChat room put
`subscribeToReferencedDocs`, the action behind `Cell.sink()`, at a quarter of
the worker's busy samples once the schema changes of the day had landed. The
reading of that share was that each sink fire re-validates its whole value in
a transaction of its own, and that a validated view kept per document version
and schema, shared by every sink of the document and reused by a fire whose
document did not change, would remove most of it. This record is what counting
the fires and attributing the samples found: the view that cache would serve is
never asked for twice, and the share itself was measured at the wrong frame.

## Rig

The store is the fresh one the schema-change remeasurement seeded, served by
the toolshed built from that remeasurement's binary with
`EXPERIMENTAL_SERVER_EXECUTION=false` baked. The shell is served by
`deno task dev-local` from the checkout, so the worker runs the checkout's
runner. Every load below is the room's second or later load through the
profiling harness, which attaches the worker profiler at sign-in and reads it
once the last message, every member badge and the settled view have rendered;
the sampling interval is 500 µs. The machine's one-minute load was between 35
and 75 throughout. The counts the harness reads from the worker's logger were
identical between every load of one arm: 1,663 list-child syncs, 285 cell
syncs, 1,157 scheduler runs, 190 native commits, 615 commit preparations.

## The fires

A temporary counter in `subscribeToReferencedDocs` recorded, per fire, whether
the sink had fired before, whether its view key (the hash of the link and the
label view, which is the key `Cell.get()`'s per-transaction cache uses) had
been fired by any sink before, and whether the value read was equal, as a
string with cells written as their links, to the previous fire's of the same
sink and of the same key. Two loads gave the same figures.

| per load                                                   |     fires |
| ---------------------------------------------------------- | --------: |
| sink fires                                                 |     5,802 |
| first fire of a sink                                       |     5,584 |
| of which the view key had been fired by another sink       |         0 |
| re-fire of a sink                                          |       218 |
| of which the value differed from the sink's previous fire  |       178 |
| of which the value was equal to the sink's previous fire   |        40 |

So the reuse a shared validated view offers is 40 fires in 5,802, under one
percent. Two sinks of one document at one path under one schema do not occur:
the render binds a sink per element, per object-valued property, per cell
child and per bound property, each on a position of its own, and a sink
re-fires when something it read changed, which is nearly always its value.

Where the sinks come from, by the options they were created with and the link
they were created on, first fires only:

| sinks per load                                                         | count |
| ---------------------------------------------------------------------- | ----: |
| the render's own (`readOnly`), reading consumed labels (policy-gated)  | 2,982 |
| the render's own, not reading consumed labels                          | 2,523 |
| the host's (`cell:subscribe`), reading the label view                  |    72 |
| other                                                                  |     7 |
| under the room result's `$UI`                                          | 4,182 |
| of which at a path of ten or more segments                             | 2,370 |
| of which at a path of five to nine segments                            | 1,451 |
| under a `children` or `props` path                                     |   920 |
| at a document root (a cell child's own document)                       |   397 |
| with schema `true` (a per-property sink, deep-traversed)               |   977 |

About 186 sinks per message, nearly all the render's, nearly all deep in the
room's view tree.

## Where the samples are

The quarter was measured at the outermost `subscribeToReferencedDocs` frame
on the stack. A sink's callback renders, and rendering binds the next sinks,
whose first fire runs synchronously inside the callback, so the outermost
frame's samples hold the whole render below it. Attributing each sample to the
innermost sink action on its stack, on the before arm's first load (10,542
busy samples of 15,489):

| frames under the innermost sink action                           | samples | of busy |
| ---------------------------------------------------------------- | ------: | ------: |
| the callback (render work not under a deeper sink)               |   1,735 |   16.5% |
| `validateAndTransform`, the sink's own read                      |   1,036 |    9.8% |
| consumed-label and label-view reads                              |      87 |    0.8% |
| `deepTraverse` of a schema-`true` value                          |      60 |    0.6% |
| the sink's two transactions (open, prepare, commit)              |      55 |    0.5% |
| `sinkHelper` outside the action: `resubscribe` 364, the rest 139 |     503 |    4.8% |

The sink's own read, with its labels and traversal, is 1,183 samples, 11% of
busy. Of the read, the schema traversal is 60%, link resolution 16%, and
dereference label derivation 6%. The traversal's cost is the descent from the
document root to the sink's path: `getAtPath` and `followPointer` are two
fifths of the traversal body, and the values read are small (3,600 of 5,800
fires read under 2,000 characters of JSON).

Of the callback's 1,735 samples, the largest single item is not rendering but
`#resolveCellForBinding`, 491 samples in all (4.7% of busy): the render calls
`resolveAsCell()` on every read of every sink to learn the target's space for
access watching, and on every cell child's render for its piece boundary.
`resolveAsCell()` ends in `maybeConvertArrayPathToImmutableLink()`, 486
samples, which reads each prefix of the path (187 samples) and, for a path
through an inline array element, as every path in a view tree is, mints an
element snapshot (`createElement`, 218 samples: a hash of the element, a
dependency walk, a clone check). A view tree's element changes as its rows
fill in, so the snapshot is minted afresh per read.

## Forwarding the link memo through the sink's wrapper

`Cell.sink()` reads through a `TransactionWrapper` that hands child cells a
second transaction, and the wrapper did not forward `getSnapshotMemo()`, so a
fire's resolutions of its link (the write-redirect pass, the value pass, and
the label view's) shared no probe records. The link-probe memo record of
September had left forwarding it unmeasured. Forwarding it for the sink's
wrapper (not the non-reactive `sample()` one, whose reads are tagged as
excluded from scheduling), two interleaved pairs, before arm a detached
checkout of the same commit:

| samples                                       | before 1 | after 1 | before 2 | after 2 |
| --------------------------------------------- | -------: | ------: | -------: | ------: |
| busy                                          |   10,542 |  10,455 |   11,383 |  10,861 |
| `validateAndTransform` under the sink action  |    1,036 |   1,097 |      938 |     962 |
| `resolveLinkTracingDereferences`, all callers |      896 |     883 |      868 |     897 |
| `traverse`, all callers                       |    1,080 |   1,097 |    1,055 |   1,025 |
| `sinkHelper` outside the action               |      503 |     411 |      480 |     430 |

Nothing moves outside noise. The two resolution passes take different memo
variants (`writeRedirect` against `value`), so they share probe records only,
and the traversal reads documents on its own. The change is not kept.

## What this leaves

The sink's own read is a cost per sink, not per document: 5,584 descents of
the view tree per load, one per bound position, each from the document root.
The levers are the number of sinks a view tree binds, and the fixed cost of a
sink's first fire: the descent, the scheduler's registration of its read set
(`resubscribePullSchedulerAction`, 364 samples, of which sorting and
compacting the paths is 153), and the `resolveAsCell()` the render makes per
read for a space it could learn without minting an element snapshot.

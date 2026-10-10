---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "Post-merge review of #7321: record-path cost of the schema-policy index, and which tests pin the decision that consumes it."
---

# Pending schema-policy index: maintenance cost and test pinning

A post-merge review of the transaction-local schema-policy index (#7321, merge
`2fda18e1acc435f0c6642ff93809d14cd1ecc543`) asked two questions that
[`2026-09-11-pending-schema-policy-index.md`](2026-09-11-pending-schema-policy-index.md)
does not answer: what maintaining the index costs on the record path, and
which tests pin the link-write decision that consumes it. That report
measures the benefit of querying the index and not the cost of building it.
The equivalence of the indexed lookup to the whole-array scan was checked by
reading every site that touches the input array and is argued in the review
on the pull request, not repeated here.

## Record-path cost from the retained profiles

The report's two worker CPU profiles were read for self and inclusive sampled
time by function name. Self time is the sum of sample deltas attributed to a
node with that name; inclusive time counts a sample once when any frame on its
stack has that name. Same runs, same instrumentation, and the same caveat the
report states: the runs shared the machine with other validation and are not a
controlled pair.

| Function                      | Unindexed self ms | Unindexed inclusive ms | Indexed self ms | Indexed inclusive ms |
| ----------------------------- | ----------------: | ---------------------: | --------------: | -------------------: |
| `recordCfcWritePolicyInput`   |             234.9 |                  799.0 |           232.6 |                581.4 |
| `getCfcSchemaPolicyInputs`    |       not present |            not present |            25.5 |                 33.9 |
| `hasPendingSchemaPolicyInput` |          65,426.1 |              101,425.5 |             5.8 |                 67.4 |
| `readOnlyCfcView`             |          13,830.9 |               13,830.9 |           160.3 |                160.3 |
| `deepFreeze`                  |              32.1 |                4,908.9 |            41.0 |              7,784.6 |
| `(garbage collector)`         |          13,775.5 |               13,775.5 |        19,262.2 |             19,262.2 |

The record chokepoint's self time is unchanged at fixture scale. Garbage
collection rose between the runs, but so did `deepFreeze`, which the index does
not touch, and by a larger fraction; the pair cannot attribute the change to
the index or away from it.

## Record-path cost per input

A same-build A/B isolates the index: the checkout at
`2e5f76ebfc606e0ebdb8b64a653867f6b231df4a`, against a throwaway worktree at
the same commit with the pull request's three source files reverse-applied. An
earlier A/B against the pull request's base commit was discarded: the control
shape drifted by up to 65 ns between the two commits, more than the signal it
was meant to expose.

The measurement drives `recordCfcWritePolicyInput` on a transaction from
`runtime.edit()` over an emulated storage manager, 50,000 inputs per run. Each
input's target is a fresh `{ space, id, scope: "space", path: [] }`; the
`schema` kind carries `schema: true`, and the `custom` kind, which the index
ignores, is the control. Time is the minimum of seven runs. Bytes are the
median heap growth after a forced collection with the transaction still alive,
so the figure includes the frozen input itself and every side table the record
method writes.

| Shape                              |         No index |          Index | Delta                      |
| ---------------------------------- | ---------------: | -------------: | -------------------------- |
| schema, one document               | 474–477 ns, 213 B | 471 ns, 197 B | none                       |
| schema, 1,000 documents            | 489–530 ns, 221 B | 568 ns, 204 B | within noise               |
| schema, every input a new document | 497–536 ns, 221 B | 618 ns, 442 B | about +100 ns, +221 B      |
| custom, control                    |       392–444 ns |     354–422 ns | noise floor about ±50 ns   |

A repeat-document input costs nothing the measurement can see: the bucket
exists, and the work is two `Map` lookups and a push. A new document costs one
`Map` entry and one bucket array, held for the transaction's life; a
transaction recording inputs for 10,000 distinct documents holds about 2 MB
more until it settles. Against the 65 s the report attributes to the scan, the
index's whole-fixture record cost is below what the profiler resolves.

## What the suite pins

Three mutants were run against 19 candidate suites: every unit test that
records a `kind: "schema"` input, plus every one that mentions link-write
relevance.

| Mutant                                                                   | Reddened                                                                                                                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getCfcSchemaPolicyInputs` returns the empty array unconditionally       | the new unit test in `extended-storage-transaction.test.ts`, and one step in `cfc-boundary.test.ts`: "persists link metadata when the source label is new in the same transaction" |
| the source arm of `recordLinkWritePolicyInput`'s pending-schema check removed | that same step                                                                                                                              |
| the target arm removed                                                   | nothing                                                                                                                                          |

The index's own contract is pinned by its unit test: a miss followed by an
append followed by a hit, exclusion of other documents, spaces, and kinds,
inclusion across scopes, wrapper delegation, fresh-transaction isolation, and
immutability. The link-write decision that consumes it is pinned on the source
side by one step and on the target side by nothing, so a change that broke
only the target-side lookup would pass these suites.

## A property the interface now states

A query for a document with recorded inputs returns a live view that shows
inputs recorded after it was taken; a query for a document with none returns a
shared frozen empty array, which a later recording does not change. No caller
held a result at the time of review. The interface documentation was updated
in the same change as this record to say so.

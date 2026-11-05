---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "Synthetic index maintenance phase measurements on producer revision 51a43a46e9."
---

# Index maintenance phase counts

The synthetic probe completed 12 cases and 96 phases on runtime revision
`51a43a46e9`: both index types, unique keys and four duplicate-key buckets, and
32, 128, and 512 independently linked source rows. This records local action-body
counts, not deployed-poll performance or latency.

Run `deno run -A scripts/collection-index-cost.ts` from the repository root.
The final `COLLECTION_INDEX_COST_COMPLETE` marker is required in addition to a
zero exit status. Each case uses a fresh emulated storage manager and runtime,
with client execution and lazy materialization enabled. Its eight phases run
sequentially on one evolving fixture; they are not independently reset trials.

The tables sum proxy accesses in completed scheduler action bodies, including
consumers. They exclude compilation, direct edit setup, synchronization, and
scheduler work outside those bodies. JSON output additionally records action
runs, link resolutions, and enumeration runs. Validation reads happen after the
phase's counters are captured.

## groupBy

| Keys | Rows | Initialize | Key edit | Insert | Reorder | Remove | Retarget lookup |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| unique | 32 | 676 | 24 | 407 | 198 | 201 | 2 |
| unique | 128 | 2692 | 24 | 1559 | 774 | 777 | 2 |
| unique | 512 | 10756 | 24 | 6167 | 3078 | 3081 | 2 |
| four-buckets | 32 | 144 | 24 | 388 | 198 | 201 | 2 |
| four-buckets | 128 | 336 | 24 | 1540 | 774 | 777 | 2 |
| four-buckets | 512 | 1104 | 24 | 6148 | 3078 | 3081 | 2 |

## keyBy

| Keys | Rows | Initialize | Key edit | Insert | Reorder | Remove | Retarget lookup |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| unique | 32 | 69 | 5 | 389 | 198 | 201 | 3 |
| unique | 128 | 261 | 5 | 1541 | 774 | 777 | 3 |
| unique | 512 | 1029 | 5 | 6149 | 3078 | 3081 | 3 |
| four-buckets | 32 | 97 | 156 | 387 | 198 | 199 | 3 |
| four-buckets | 128 | 385 | 612 | 1539 | 774 | 775 | 3 |
| four-buckets | 512 | 1537 | 2436 | 6147 | 3078 | 3079 | 3 |

## Interpretation and acceptance

Membership insertion, reordering, and removal retain source-size work even
when only one bucket is observed. Moving the unique index's winning row to
another key shows increasing proxy accesses with duplicate-bucket size. Group
proxy counts stay flat for that edit, but do not measure array-copying work.
Retargeting the group lookup also
consumes the newly selected group's titles; the unique lookup consumes only its
winning title. These different consumption widths explain why their counts
should not be treated as interchangeable lookup costs.

An unrelated payload edit caused zero action runs in every case. Selected
payload edits preserve membership: the group consumer used zero measured proxy
accesses, with five link resolutions for a unique group and 26, 98, and 386
for the duplicate-group sizes. The unique consumer used three proxy accesses and
seven link resolutions. Zero proxy accesses do not imply zero work.
No enumeration action ran in any measured phase.

Assertions checked the observed values after every phase, exact group membership,
and result stability through source reordering. Duplicate-key winner eligibility
was checked; canonical winner selection and canonical identity order remain
covered by their separate runner tests. The probe does not independently prove
those canonical rules. An isolated negative control omitted the selected-key
write while retaining the expected model change; its assertion failed with a
nonzero exit status and no completion marker.

These results fill the phase and size separation required by the collection-index
acceptance plan. They do not establish a logarithmic update bound, total scheduler
cost, storage or network savings, a browser latency improvement, or live-poll
acceptance. The live poll remains subject to separate coordination.

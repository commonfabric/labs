---
status: historical
created: 2026-09-13
archived: 2026-09-13
reason: "Investigation findings: what the per-read work under a wide reactive read costs at the code that shipped with the dereference-trace index, and what pulling it at its source measured."
---

# Link probes are the read log's multiplier

The dereference-trace index left a profile with no frame above 5% of busy
worker CPU, and named the next tier: the scheduler sorting, compacting and
indexing the read log once per action, about a sixth of busy CPU together. This
pass profiled that tier in-process, found what feeds it, and measured pulling
it at the source rather than speeding up each pass over it.

## What was measured, against what

| | |
| --- | --- |
| labs | `cc005b74b8` (main at the dereference-trace index) and this change |
| workload | `packages/runner/test/default-app-note-create.bench.ts`, the note create+remove cycle at 0, 32 and 128 notes |
| profile | V8 sampling profiler over 30 cycles at 128 notes, driven from inside the process through `node:inspector`, 200 µs period, ranked by self time with `renderProfileReport` |
| counts | a temporary counter on each site, run for one cycle and reverted |
| machine | an M-series laptop with other work running; every bench row is the mean `deno bench` prints |

The workload is not the inbox. It is the maintained in-process stand-in for a
wide reactive read: a lift over a list of linked documents, a live sink on the
result, and an event that adds and removes one element. Its profile has the
same frames the browser profile of the inbox had, at the same relative
weights, which is what makes it the right thing to iterate on and the wrong
thing to quote for the inbox's own click.

## Where the per-read work came from

The profile at the shipped code, 128 notes, 30 cycles, share of sampled time:

| frame | self | inclusive |
| --- | ---: | ---: |
| `#buildReads` (the storage commit's read set) | 1.3% | 9.3% |
| of which `compactCommitReads` | 3.6% | 4.8% |
| `resolveLinkTracingDereferences` | 3.4% | 11.5% |
| `read` on the storage transaction | 4.4% | 6.4% |
| `sortAndCompactPaths` | 2.4% | 2.5% |
| `setSchedulerDependencies` + `applyActionReadDelta` + `updateDependentEdgesForLog` + `txToReactivityLog` | | 5.5% |
| `(garbage collector)` | 5.1% | |

About a sixth of sampled time is per-read work, as the index's profile said.
The counts under it, for one cycle:

| count | value |
| --- | ---: |
| read activities one lift commit journals, 128 notes | 2,060 – 2,077 |
| of which the commit keeps as preconditions | 1,801 – 1,816 |
| scheduling-log reads before and after compaction | 1,033 → 517 |
| shallow reads | 385 |
| entities the action's reads touch | 131 |
| link resolutions per cycle | ~1,750 |
| whole-resolution memo hits, over six cycles | 12 of 10,536 |
| sigil probes issued, over six cycles | 12,220 |
| distinct (document, position) pairs among them, per transaction | 6,898 |
| probes the memo answers, over six cycles | 3,509 (156 of them at a document root) |

Sixteen journaled reads per note, most of them link resolution's sigil
probes; a whole-resolution memo that never hits, because each property read
of an element resolves a distinct address; and 44% of the probes repeating a
position the same transaction had already probed — the element's own slot,
once per property read through it, almost never a document root. The memo
answers 29% of all probes: the repeats made in transactions that hold a memo.
The rest are made where the memo is withheld, reads through the sink's
`TransactionWrapper` among them, which forwards no memo.

## What landed, and what it measured

Three changes, measured together as one arm against main with the files
switched by `git show` and a checksum printed per arm. The machine sat at load
7.3–8.2 throughout (loom's daemons and two dev servers), so the arms were
alternated ABBA-BAAB and each cell below is one `deno bench` mean; the fourth
pair ran into a load spike to 16 and is left out.

| arm | @32 notes | @128 notes |
| --- | ---: | ---: |
| main | 21.8, 23.7, 23.3 ms | 45.4, 44.7, 47.6 ms |
| this change | 21.1, 22.6, 21.7 ms | 42.9, 42.7, 43.2 ms |

Six to seven percent at both sizes, the same direction in every pair, and
about what the profile's arithmetic predicts: removing a fifth of the journaled
reads from a per-read tier that was a sixth of the cycle. A sequential pass
taken earlier the same day read main at 63 ms and this change at 45 ms; that
swing was the machine's, not the code's, and is the reason the series above
was alternated. What does not move with load is the count: the memo answers
29% of the probes a cycle issues, and each one answered is a read the
transaction no longer journals.

**The probe memo carries the change.** `resolveLinkTracingDereferences`
memoizes each sigil probe's outcome on the transaction's snapshot memo — the
same map the whole-resolution memo uses, dropped on every write and withheld
under the same conditions — so a walk that misses as a whole still skips the
probes an earlier walk through the same container made, and the read of the
stored link behind a probe that found one. A repeat adds nothing the first
did not journal, so what the memo removes is the duplicate `read` calls and
every downstream pass over them.

**The other two are small and kept.** `compactCommitReads` sorted its input,
grouped it, compacted each group through fabricated addresses, and sorted
again; the leading sort decided nothing the trailing one did not, and the
per-group compaction now sorts paths in place. `sortAndCompactPaths` groups by
document instance before sorting, so a read log naming many documents and few
paths in each sorts small groups rather than one long list, and
`addressesToPathByEntity` memoizes its grouping on the address list, since a
scheduling log is grouped when it registers and again as the previous log when
the action re-registers.

## What was tried and left out

**Forwarding the snapshot memo through `TransactionWrapper`.** `sink()` reads
through a wrapper that does not forward `getSnapshotMemo()`, so nothing a sink
reads is memoized — link resolutions, label views or proxy views. Forwarding it
for the reactive wrapper (never for the non-reactive one, whose tagged reads
must not seed a memo a reactive caller takes from) was measured twice and
answered both ways: 24% slower in a sequential pass, faster in an alternated
one taken at load 10–11 where the same arm read anywhere from 36 to 103 ms.
Neither is evidence. It is out of this change as unmeasured, not as disproved;
the argument against it — the sink's reads resolve distinct addresses, so a
whole-resolution memo costs it a key and a record per read and returns
nothing — is a hypothesis for a quiet machine.

**A resolution-level memo does not pay for a wide read; a probe-level one
does.** The two are keyed differently: a resolution is keyed on the full
address and its variant, which a property read never repeats, and a probe is
keyed on a position, which every property read through a slot repeats. The
counts settle that one: 12 resolution hits against 3,509 probe hits.

## What is left

The per-read passes still exist and still scale with the read log; they scale
with a smaller one. `#buildReads` remains the largest single chain at commit
(building one precondition per surviving read, with a document lookup and a
layer scan per read), and the reactivity-log build and the scheduler's
dependents update each walk the log once more. Each is now a smaller share of
a smaller total. The next reduction of the same kind is in the number of
probes a walk issues at all — a leaf property read probes below itself and
then at its parent — which is a change to what link resolution asks storage,
not to how the answer is cached.

---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "Investigation findings: where the unified inbox's thread-open seconds go, measured against live connector data in a bare labs worktree."
---

# cf-person-inbox: where the thread-open seconds go

Loom's unified-inbox pattern took 2.865–13.656 s to open an already-loaded
thread on the owner's machine, and the profiling that went with it never
produced a clean sample. This pass reproduces that cost in a bare labs
worktree — no loom daemon, no pattern family, no CFC lens, no people index —
and attributes it.

## What was measured, against what

| | |
| --- | --- |
| labs | `8c126e4660` (worktree `perf-investigation-agent-e41745`) |
| loom | `4c2cfaaea`, labs pin `be73306e5e` |
| pattern | `src/patterns/cf-person-inbox.tsx` and its three imports, copied byte-identical (`sha256` `96c3e8a026…` / `730c300baf…`); unchanged throughout |
| space | `inbox-perf` on a local toolshed at port offset 400 |
| posture | `serverExecution` **off** at both ends — the toolshed reports no `servingLoop`, and the client resolves the flag to `false` |
| stores | **linked live, read-only** — `signal.desktop/source-records.db` (36 MB), `whatsapp-reader/messages.db` (3.6 MB), `msgvault.db` (7.3 GB). Not snapshotted; the Signal and msgvault writers were active |
| attachment | one shell page, one runtime worker, no family, no transferred port |
| machine | load average 6–9 throughout, never idle |

Every number here is an upper bound on a quiet machine. The pattern was never
edited; everything the bench adds lives in the page's own `MutationObserver`
and in the driving process.

## The headline

Opening an already-loaded thread changes **one `<style>` text node**, at every
size and in every state measured. The pattern's design holds, so none of what
follows is rendering.

**A paced click costs ~124 ms.** Awaiting the runtime (`commonfabric.rt.idle()`,
which returns in about 70 ms) between clicks holds eight consecutive opens at
112–147 ms on one person's data.

**Clicking faster than the runtime settles degrades the session, and the
session does not recover.** Alternating pacings on one page against one data
set, six threads in the list:

| round | pacing | click → that thread's detail visible |
| --- | --- | --- |
| 1 | paced | 112, 128, 133, 147, 124, 119, 112, 112 ms |
| 2 | eager | 178, 248, 365, 432, 532, 1015, 1014, 1032 ms |
| 3 | paced | 376, 949, 931, 907, 928, 939, 878, 918 ms |
| 4 | eager | 976, 1007, 1031, 1031, 947, 982, 1032, 998 ms |

Round 3 is the finding: pacing prevents the degradation and does not cure it.
It plateaus — around 1 s at this size — rather than growing without bound. A
page reload restores ~124 ms; rewriting `people` with the same value restores
it only partly.

**The degraded click does the same work and pays more for it.** The worker's
own logger deltas either side of one click, in both states:

| | healthy | degraded |
| --- | --- | --- |
| click → visible | 138–172 ms | 830–931 ms |
| logged operations | 238 | 238 |
| `cell` | 146 | 146 |
| `scheduler` | 36 | 36 |
| scheduler actions | 6 | 6 |
| `traverse` | 14 | 14 |

Identical counts, six times the wall clock. This is a **width** problem and not
a frequency one: nothing runs more often, each unit of work gets dearer. That
is what decides where the fix goes.

An earlier reading of this same effect recorded it as monotonic growth per
click (182 ms at click 0 to 1408 ms at click 17, "about 70 ms added per
click"). That measurement was taken without pacing, so what it recorded was the
onset of the degradation above rather than a property of the click. The paced
control is what separates them.

The second variable is the data volume, and it is **not** the rendered list
length:

| selected people | messages the queries return | rows on screen | click → visible |
| ---: | ---: | ---: | --- |
| 1 | 52 | 6 | 187–524 ms |
| 1 | 52 | 38 | 320 ms |
| 5 | 150 | 6 | 1422–3539 ms |
| 5 | 150 | 38 | 1823–7506 ms |

One person with 38 rows on screen is *faster* than five people with 6 rows on
screen. What the click costs tracks what the queries returned, not what is
painted. Sizes were alternated (1, 5, 1, 5) rather than run in one direction,
because background load drifts over minutes.

Together these reproduce the loom baseline's whole spread. Somebody clicking
through threads in a pane clicks faster than the runtime settles; from then on
the pane is slow for the rest of that session, and against five people's worth
of data the degraded click is 10–25 s.

## Where the CPU goes

A V8 sampling profile of the runtime worker over a click round, with the
call tree rebuilt to recover the callers:

```text
finalizeAction                                   17831 ms  (14.4% of wall)
 └ finalizeSchedulerAction                       17829 ms
   └ finalizeReactiveActionCommit                17817 ms
     └ startReactiveActionCommit                 16232 ms
       └ prepareForCommit                        13431 ms
         └ probeFlowLabelWork                    13429 ms
           └ flowLabelWorkExists                 13429 ms   prepare.ts:2544
             └ forEachFlowObservation            13248 ms   prepare.ts:2117
               └ probeBelongsToDereference       13022 ms   prepare.ts:2154
                 └ sources.some(isPrefix)        12806 ms   prepare.ts:2178
                   └ isPrefix                    12806 ms self   prepare.ts:182
```

The worker is CPU-saturated for the whole round — per-round worker CPU (3.67 s
over eight clicks) matches the summed wall latency almost exactly, so the
seconds are compute in the worker, not IPC and not paint.

`isPrefix` is the largest single frame at **31% of non-idle CPU**, and it holds
that share steadily across quarters of a round (29%, 31%, 33%, 30%).

Profiling the healthy and degraded phases separately — four measured clicks
each, with the counted work identical between them — says which part of that
machinery is the one that grows:

| frame | healthy | degraded | |
| --- | ---: | ---: | --- |
| busy worker CPU | 910 ms | 1822 ms | 2.0× |
| `isPrefix` | 278 ms (30.5% of busy) | 547 ms (30.0%) | 2.0×, constant share |
| `resolveLinkTracingDereferences` | 55 ms (6.0%) | 287 ms (15.8%) | **5.2×** |
| `sortAndCompactPaths` | 48 ms | 58 ms | 1.2× |

`isPrefix` scales with the whole and keeps its share, so a fix aimed at it
alone buys about a third in either state. The dereference-trace machinery is
what grows out of proportion, and it is the same structure `isPrefix` is
scanning: `probeBelongsToDereference` consults the traces that
`resolveLinkTracingDereferences` records.

The shape of the hot loop, for whoever picks this up:

```ts
for (const read of tx.getReadActivities?.() ?? []) {   // R reads
  ...
  const coveredByTrace = probeBelongsToDereference(space, id, scope, path);
  //  → sources.some((source) => isPrefix(source, logicalPath))   // S sources
}
```

`traceSourcesByDoc` is built once per call, which is right; the per-read
`.some()` over one document's dereference-trace sources is the linear scan, and
`isPrefix` allocates a closure per call (`prefix.every(...)` shows separately in
the profile at 2.6%). R and S both grow with what the transaction has touched,
so the pass is quadratic in it.

This confirms and sharpens the handoff's lead. `forEachFlowObservation` was the
right function; the self time is one level below it, and the caller that makes
it run is `probeFlowLabelWork` during commit preparation.

### A ruled-out hypothesis

`probeFlowLabelWork` memoizes a negative verdict against an activity epoch that
**every journaled read advances**, so the memo looked like it could never hit in
a transaction that keeps reading. Forcing the negative verdict to hold for the
whole transaction (a diagnostic edit, since reverted) did not reduce click
latency — 40-row clicks stayed at a 23 s median against 14 s before, inside the
run-to-run spread of a loaded machine. Either these transactions are
flow-relevant, so no negative verdict is ever memoized, or the probe is not
called often enough per commit for memoization to matter. The cost is in what
one pass does, not in how often the pass repeats.

## A settled pane does not mean a complete pane

The pattern's pane reaches a state where every in-DOM check passes — no source
chip still shows `…`, every row has its detail, every key non-empty and unique,
and nothing mutates for 30 frames — **while showing the previous person's
data**. Checked against the piece's own `threadCount` read out of band, over
seven transitions:

| people set | piece says | pane shows at settle | agrees | converges later |
| ---: | ---: | ---: | --- | --- |
| 1 | 6 threads | 6 rows | yes | yes |
| 5 | 38 | 6 | **no** | yes |
| 2 | 55 | 38 | **no** | yes |
| 1 | 6 | 40 | **no** | yes |
| 5 | 38 | 6 | **no** | yes |
| 0 | 0 | 38 | **no** | yes |
| 3 | 28 | 28 | yes | yes |

Five of seven. The worst is the sixth: with nobody selected the pane sat
settled and quiet showing 38 threads and three source chips reading
`Signal · 50`, `WhatsApp · 50`, `Gmail (personal) · 50`. Every one converged
eventually, so nothing is lost — but there is **no predicate inside the DOM
that certifies completeness for this pattern**, because the counters go stale
in exactly the same way the list does. An acceptance probe needs an oracle
outside the browser. This is the "a counter is not a complete list" observation
from the earlier pass, with the oracle it was missing.

The mutation log says the pane is rebuilt more than once per change: a
`people` transition produces 2–6 separate bursts of DOM mutation separated by
more than 150 ms, with up to 167 nodes added and 97 removed, and transient
states in between — one transition was observed at 37 rows against 38 details
with a duplicate row key, another at 2 rows against 0 details.

## The people curve

Cost per transition, holding the pattern fixed and varying one thing at a time.
Each statement windows 50 **messages**, so the merge's input saturates at
50 × 3 = 150 rows at two people and does not grow after that; adding people
past that changes *which* rows arrive, not how many.

- **People count is not the variable.** Eight people with one identifier each
  (Gmail only) and one person with one identifier reach complete content in
  comparable time; the transitions that cost most are the ones that change how
  many stores return rows.
- **Identifier count is not the variable either.** One person with 1 identifier
  and the same person with 14 both settle in ~2.0–2.8 s.
- **Stores touched is the variable that moves first feedback**, because each
  additional store is another statement re-issued against a live database: 1
  store 2.1 s, 2 stores 2.1 s, 3 stores 2.2 s to first feedback, but complete
  content 2.4 s / 3.3 s / 4.1 s.
- **Removal is not cheaper than addition.** Going 5 → 2 and 2 → 5 both cost
  ~2.6–2.8 s to commit and 2.9–3.1 s to complete; the invalidation is the same
  either way, because any change to `people` changes all five `*Params`
  computeds and re-issues every store's statement.
- **Re-adding someone just removed is not warm.** 2 people → 1 → 2 cost 5.65 s
  then 3.63 s to complete; nothing is cached across the removal.
- **A thread open when its person is removed** stays in the DOM until the pane
  catches up, and then goes with the rest of the rows; the open-key stylesheet
  simply stops matching anything.

## Two things that block a host from driving this pattern at all

Both were found by trying to set `people` the way a host would, and both are
runtime-side.

**A per-key write to the arguments cell is refused, naming an unrelated
input.** Any `cf cell set --cell <piece>#argument <field>` on this piece fails
with `updated input does not match its schema: view: value does not match type
object`. `view` is `PerSession<Writable<ViewState | Default<Record<string,
never>>>>`; its emitted schema is a correct `type: "object"` with
`default: {}` and `asCell: [{kind:"cell",scope:"session"}]`, and reading it
returns `{}`. The update validator at `piece-controller.ts:3435` validates the
whole staged root, and the stored session **link** does not validate against
the referent's type. So a write to `people` is rejected by `view`. A write at
the arguments **root** that carries `view` explicitly succeeds and preserves
both scopes (`people` space, `view` session) — that is the only spelling that
works, and it is not discoverable from the error.

**A write to this piece is refused by commit preconditions, with the reason
swallowed.** `cf cell set` against the inbox's own backing document fails with
`ConflictError: stale confirmed read: of:fid1:… at seq 0 conflicted with seq
958` — a dozen documents the writer read as *absent* (seq 0) that the server
holds at the current space sequence. They are the query-result documents the
piece re-mints on every `people` change. The same write against a one-input
holder piece in the same space, at the same moment, commits every time, so this
is a property of the inbox's argument graph rather than of the space being
busy. Two things make it worse than a retryable conflict:

- It is **not retried** — the transaction fails outright, and repeated attempts
  against a piece that is still re-deriving fail repeatedly (5/5 in one
  sequence).
- The operator sees `Error: [non-error-thrown] [object Object]`. Cliffy
  replaces the thrown `ConflictError` before the CLI's own error rendering
  sees it, so nothing about the conflict reaches the terminal. Recovering the
  message required patching `Command.prototype.handleError`.

Routing the write through a verb on a holder piece — the event path, which
carries its own retry and reports `settled` — is reliable where both direct
spellings are not. That is how every measurement above was driven.

## Smaller things found on the way

- **A toolshed restart silently unregisters on-disk SQLite sources.** After
  `restart-local-dev.sh`, all three stores reported `unavailable: true` with an
  empty error string and the pane rendered an empty inbox. Re-running
  `cf piece link sqlite:…` restores them. Nothing says the registration was
  lost.
- **The pattern is total with every optional input absent.** Deployed into a
  bare worktree with no `peopleIndex`, no `*Fresh`, no `*Panel` and no `*Cfc`,
  it renders all six sources as explicitly unlinked and reports
  `availability: "no-person"`. It also compiles unchanged at this labs pin,
  with two transformer warnings about `Default<>` annotations that supply no
  schema value.
- **The shell renders the pane inside shadow roots.** `document.querySelector`
  finds nothing and a `MutationObserver` on `document` sees nothing the pattern
  does; every query and every observation has to walk open shadow roots and
  re-attach as new ones appear.

## What this leaves for owners

**Runtime, and the largest item.** The commit-preparation flow-relevance pass
(`prepareForCommit` → `probeFlowLabelWork` → `flowLabelWorkExists` →
`forEachFlowObservation` → `probeBelongsToDereference`) is a linear scan per
read over a document's dereference-trace sources, run on every reactive action
commit. `recordCfcDereferenceTrace` appends every trace unconditionally — the
equality scan beside the push decides only whether the digest is invalidated,
not whether the trace is stored — and the list is cleared in `abort()` and
nowhere else. This piece declares **no CFC labels at all**, the stores having
been linked with an empty contract and no lens applied, so the whole pass exists
to conclude there is no flow work to do. Worth its own task; it is not the
inbox's problem, and a fix reaches every pattern.

The sequenced work is in
[Interaction cost in the unified inbox](../../../plans/person-inbox-interaction-cost.md).

**Runtime, second.** The two write refusals above. The schema one is a
correctness bug (an input rejected by an unrelated one); the conflict one is a
liveness bug plus an error that never reaches the operator.

**Pattern.** Nothing here indicts the pattern. The stylesheet design does
exactly what it was built to do — one text node, every time, at every size. The
50-message window per store is still the data limit the build log named, and
the 40-thread display cap is still worth raising for a demo, but neither is
where the seconds are.

**Rule worth writing down, and the easiest to skip.** The pattern's cost is set
by how much the queries returned, not by how much is on screen — a pane showing
six rows out of 150 returned messages pays for the 150. Nothing at authoring
time says so: the author sees a `slice(0, THREAD_LIMIT)` and reasonably expects
the cost to follow it. A rule for `skills/pattern-dev` or
`skills/pattern-critic` should say that a display cap bounds the render and not
the transaction, and that the number to hold down is the rows a statement
returns.

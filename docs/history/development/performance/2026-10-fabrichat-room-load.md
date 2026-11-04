---
status: historical
created: 2026-10-10
archived: 2026-10-10
reason: "Where the time goes when a browser opens a fabrichat room on Estuary with twenty messages and thirteen participants, measured on both ends of the wire, October 2026."
---

# What opening a fabrichat room costs, October 2026

A room on Estuary with twenty messages and thirteen participants takes long
enough to open that the person opening it asks why. This is where that time
goes, measured from the client and from the serving memory instance on the
same load.

## Setup

- The room: piece `fid1:k3C-7IQqf3LVy7WCragLUTmLWbWbI40-FT8HjkU5fF4` in space
  `did:key:z6Mkto7N696grjEfbPZcBrqcMx4QnyFYniCxCfFQXpzVuih8`, twenty
  message rows and thirteen participant chips, which the runtime resumes as
  eighty pattern instances.
- The server: Estuary at commit `ca70fc5a2b`, `serverExecution` off, 21
  toolshed instances on an otherwise idle 16-core host; instance 8008 serves
  this space.
- The client: `cf piece render` of the room from a checkout at the deployed
  commit, which runs the same runtime a browser does minus the DOM, under
  `CF_MEMORY_FRAME_LOG`, `CF_TIMING_MEASURES`, and a V8 sampling profile
  (`skills/perf-investigation/scripts/profile-cf.ts`), then once more
  uninstrumented under `/usr/bin/time`.
- The client machine was a 16-core Mac at a one-minute load of 300 to 650
  from other work, so every wall-clock figure below is inflated roughly
  eightfold; the counts, byte sizes, proportions, and CPU seconds are not.

The browser itself was not measured: no identity was available on either
origin. The CLI render starts the same eighty instances through the same
runner, so the attribution carries; the DOM's own cost does not appear here.

## The two ends

The client spent **49 s of CPU** (uninstrumented, 1.4 GB peak RSS) opening
the room. The serving instance's own record of every operation for the space
over the profiled render: thirteen operations over 100 ms, **4.0 s** in
total, the longest 0.6 s, and the rest under the recording threshold, so at
most about 14 s of server time against 49 s of client CPU. The server is not
where the time is.

The frame log shows receive silences of 213 s, 124 s, 86 s, and 49 s — no
frame arriving while the client sent dozens. The CPU profile sliced to those
windows shows the JS thread 0.0% idle and 64% inside
`#syncResumeInstanceNodes`. The client was computing through each silence and
never returned to the event loop to read the responses the server had
answered within a second. The silences are client starvation of its own
socket, not latency.

## Where the client CPU goes

Phase attribution over the whole profile, by the outermost runner marker on
each sample's stack:

| phase | share |
| --- | ---: |
| resume pre-sync: `#syncResumeInstanceNodes` | 37% |
| resume pre-sync: `#syncCellsForRunningPatternInner` | 9% |
| resume pre-sync: `#syncCrossSpaceReads` | 6.5% |
| garbage collection | 9% |
| reconciler (render) | 6% |
| scheduler action runs (pattern code) | 6% |
| scheduler settle and pull work set | 4% |

Pattern JavaScript is 2.8% of samples. The `ParticipantChip` binds
`$profile` to the participant's profile cell and runs no profile pattern;
the fourteen foreign-space sessions the load opens are the thirteen profiles
plus the home space, and the profile result documents arrive once (305 KB in
all).

Inside the hot window, two chains account for about half:

- `#nodePlan → #bindNodeIO → getImmutableCell →
  inlineExternalSchemaRefsInValue → recomposeSchema → internSchema → hashOf`
  (28% of the window). Every node plan builds an immutable `data:` cell of
  its bound inputs, and the build rewrites every content-addressed schema
  reference in every link into its recomposed form, which is a fresh object
  graph each time and so deep-freezes and hashes anew. Under real
  instantiation `getImmutableCell` is 1.7% of the whole profile; under
  resume planning, 12.5%.
- `#syncCrossSpaceReads → cell.get → validateAndTransform` (20% of the
  window): a full schema-validated materialization of each plan's inputs,
  whose purpose is to notice a link into another space.

Both are multiplied. `#collectResumeOwnedCells` recurses the whole
sub-pattern tree and `#syncResumeInstanceNodes` plans every nested instance
at every level, so the root's start plans the whole tree; each nested
instance then reaches `runner.run()` on its own, and the named-run gate,
probing the content of every document its argument links to four deep, finds
a document no name-sync names — a derived cell of the room, a handler
stream, a profile field in another space — and `#nameFamilyBeforeRun` plans
the child's subtree again. The wire shows it: 3,932 watch roots over 110
`session.watch.add` frames, 31% of them already requested earlier in the same
load under a different selector; one 3.2 MB frame of 1,794 roots that
returned 66 documents; the same shapes ("1,793 roots, 66 documents") in the
server's record four times within one load. 5.2 MB went out, of which most
is the same two 5 KB handler-event selectors repeated 296 times each; 10.5 MB
came in, 4.6 MB of it one content-addressed schema document.

## What was ruled out

- Compile. The compile cache for the deployed compiler version is a hit for
  a browser; a miss costs about 12 CPU seconds of TypeScript for the seven
  modules and was paid only by a CLI from a newer checkout.
- Data volume. The space is at sequence ~5,170; the room's result document
  is 37 KB; the space database is 60 MB.
- The server. Above.
- The link. Estuary answered each frame within a second of receiving it.

Three things tried on the way, each dropped for a measured reason:

- Not inlining a link's reference-form schema into a `data:` id at all, on
  the reasoning that a `data:` document never leaves the process. The
  traversal admits a reference-form link schema only where its closure is
  persisted in the space, and a `data:` document has no carrying write to
  persist one, so a reference inside it selected nothing where the inline
  form selected its schema; the traverse replay goldens moved. A memo per
  reference keeps the inline form and the win.
- Counting a document the replica had asked the store for and found absent
  as present in the named-run gate. An owned per-user cell a visitor has
  never written is exactly such a document, and its hold is what seeds that
  actor's defaults; on the room the rule changed one hold in eighty.
- Naming each nested instance's argument link targets root-only in the
  parent's resume rounds. On the room it issued no request the plans had
  not already made, with identical frame counts, and cost 43 waves.

## Numbers that decide the fix

- 80 starts of `syncCellsForRunningPattern`; 4,877 `resumeCellSync` spans
  of uniform 3.6 s median, which is the signature of concurrent waits on the
  same few loads rather than of 4,877 separate costs.
- 7,497 `cell/get` and 10,304 `traverse` spans for a page that renders
  twenty rows.
- The reconciler's and the scheduler's shares together are under a third of
  the pre-sync's.

The plan that follows from this is
[`../../../plans/resume-presync-cost.md`](../../../plans/resume-presync-cost.md).

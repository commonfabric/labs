---
status: historical
created: 2026-10-11
archived: 2026-10-11
reason: "Where the time goes when a browser opens a fabrichat room of thirty and of a hundred message rows on a local toolshed, measured before and after indexing the scheduler's readers, the CFC write-policy inputs and the data-URI syncs, October 2026."
---

# What opening a larger fabrichat room costs, October 2026

After the resume pre-sync stopped naming every nested instance twice
([`2026-10-fabrichat-room-load.md`](2026-10-fabrichat-room-load.md)), the
room was measured again locally, with more messages than the Estuary room
held, to find the next round of cost. This records the rig, what was found
on both sizes, and what four changes to the runner did to it.

## Setup

- The server: a toolshed and shell from this checkout
  (`scripts/restart-local-dev.sh --port-offset 7`, `MEMORY_DIR` on a fresh
  store, `serverExecution` off, access list enforced).
- The rooms: seeded by a script that drives the `fabrichat-spaces` manager
  fixture. The starter creates a group room; each of twelve members gets a
  profile in a space of their own that grants anyone WRITE, as the
  profile-create surface does, selected as their home profile so the room's
  `#profile` wish resolves for them; the members then post the messages
  round-robin with the send gesture. Three rooms: two messages, thirty, and
  a hundred and twenty (the room shows its last hundred).
- The client: a headless browser through `ShellIntegration`, signing in as
  the starter and navigating to the room, with a V8 sampling profile of the
  runtime worker from the moment the worker exists until the view settles
  after the last message appears, and the worker's logger rows beside it.
  Where the wire had to be read, a Deno runtime opened the same room under
  `CF_MEMORY_FRAME_LOG`; it runs the same client code minus the DOM.
- The machine: 16 cores at a one-minute load of 12 to 16 from other work.
  Wall-clock figures below vary by up to two times between runs of the same
  arm; a repeat of the final arm came out uniformly twice as slow in every
  phase. The profile shares, counts, and byte sizes are the measurement, and
  the paired comparisons were run within the same hour.

## Two messages

Seven seconds to the messages; the worker busy for 7.5 of its first 8.1
seconds. Scheduler action runs 17%, the reconciler 16%, evaluating the
compiled pattern modules 12% (the top level of `room.tsx` alone 0.7 s),
commit preparation 10%, the resume pre-sync 17%.

On the wire, 2.95 MB came in, of which 1.73 MB was seven content-addressed
blobs of compiled pattern code requested by the compile-cache load, and
0.73 MB the first pre-sync wave. 1.39 MB went out as 1,045 watch roots, of
which 600 KB was 64 handler-stream documents each watched under a 4.3 to
5 KB event schema; the 64 came back as 277-byte absence records. The data
for a handful of messages is the program and the per-stream watches.

## A hundred and twenty messages

The browser never showed the message list within a five-minute safety net.
The worker's first two minutes were 65% resume pre-sync, 13% idle. A message
row compiles to about a hundred nodes, so a hundred and twenty rows plan
about twelve thousand nodes, and each plan mints a `data:` document of its
inputs (`dataUriFromValue`, 17 s), hashes the whole URI for its sync memo
key (`dataURISyncKey`, 20.8 s, in `Map.get` on fresh 30 KB strings), decodes
it again to walk its links (`valueFromDataUri`, 9.9 s), and interns the
event schema of every stream link it holds (`internSchema`, 13 s).

The Deno runtime showed the rest. One pre-sync frame carried 12,785 roots
and 19.3 MB, of which 3,360 roots were handler streams under the event
schema (28 per row, about 14 MB). Nothing then crossed the wire for twelve
minutes. The first-run commit that followed was one transaction of 6,620
operations and 24.7 MB — 3,000 documents, one of 128 KB per row — which the
server refused as standing for more than a million slots, and which the
client sent again, identical, twice more; 9,928 further commits of 96 MB
followed, 9 of them answered, until the process exhausted a 2.3 GB heap
after 24.5 minutes. The server did about five seconds of work in the first
ten minutes.

## Thirty messages, before

The first load took 85 s to the messages. Over the whole load, commit
preparation was 39%: for every written path,
`labelMintOptionsAt` scanned every write-policy input of the transaction
(`pathHoldsUnattributedInitialization`, 16 s), quadratic in the first-run
commit's 1,670 operations. The reconciler was 18%, 8% of it resolving inline
array elements as cells, which mints a `data:` snapshot of the element on
every resolve and the renderer resolves each element several times over. The
scheduler's topological sort was 8% (6.5 s): every writer checked against
every reader in the work set. The pre-sync was 13%.

## The four changes

- The topological sort indexes the work set's readers by the document they
  read, so a writer's edges cost the readers of what it writes.
- CFC commit preparation indexes the transaction's write-policy inputs by
  the document they name, once per transaction; the two per-path checks read
  the inputs about their document.
- The storage manager keeps each data URI's hash and decoded value in a
  weight-bounded memo, and a link that declares a stream is not synced:
  its document holds no value a read uses.
- An inline array element's snapshot id is kept by the value's identity and
  the link it was read through, so the encoding runs once per document
  version.

## Thirty messages, after

Paired runs on the same machine within an hour, main against the branch.
The profile window spans the worker from creation to the settled view.

| load | arm | to messages | settled | worker window | commit prepare | settle/topo | render | pre-sync |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| first load, fresh room | main | 71.1 s | 88.9 s | 88.4 s | 24.9 s | 10.6 s | 15.6 s | 6.1 s |
| first load, fresh room | branch | 30.1 s | 38.6 s | 38.1 s | 7.1 s | 2.1 s | 4.4 s | 6.1 s |
| second load, materialized | main | 41.8 s | 98.6 s | 97.9 s | 23.2 s | 12.3 s | 16.8 s | 15.3 s |
| second load, materialized | branch | 15.7 s | 36.6 s | 36.1 s | 6.9 s | 2.1 s | 4.0 s | 7.8 s |

An earlier main run of the materialized room, under a lighter load, took
33.2 s to the messages and 65.7 s to settle. The server's `frame/handle`
per load went from 9.6 s to 5.6 s on the first load and from 8.0 s to 3.9 s
on the second; its frame queue time on the first load from 89 s to 10 s.

## What the record leaves for the next round

- A load of a materialized room still commits for a fifth of its time: the
  hundred-row room's loads wrote 1,992 session-scoped derived documents and
  patched 9,130 derived ones, which is what a reader's own instance of a
  `PerSession` derivation costs per session.
- The first-run commit of a hundred-row room exceeds the server's slot
  limit, and the client re-sends the refused frame unchanged.
- Each plan's inputs document is still minted (`dataUriFromValue`); the memo
  removes the repeat hashing and decoding, not the minting.
- The compiled program is 1.7 MB per cold worker, evaluated in 0.9 s, with
  no cache in the browser.
- A selector table would cut the repeated inline selectors that remain.

---
status: historical
created: 2026-11-05
archived: 2026-11-05
reason: "Measurement record: what a served listing of a Topics board and a served read of one Topic cost on the worker rig at 100 and 500 Topics, in CPU, documents delivered, and serving-worker heap."
---

# What listing a Topics board and reading one Topic cost under server execution

Measured 2026-11-05 at commit `f5d289c97b` with
`skills/perf-investigation/scripts/read-worker-probe.ts`, which this work
added. The probe serves a fresh board from a `ServingWorker` over a loopback
memory server, creates the Topics through the board's `addTopic` verb, and then
reads with `getCellValue`, the function behind `cf cell get`, under
`serverExecution`. Each read is made by a client of its own that connects,
reads, and disconnects, as one `cf` invocation does. The reads are the board's
`index`, which lists every Topic, and then ten Topics spread evenly over the
board, each read twice.

Every probe Topic has a one-line body and no comments, so the figures are for
the smallest Topic the pattern makes. The machine ran other sessions throughout,
at a load average between 75 and 375, so wall time is given once and CPU time is
the measure. CPU time is the whole process's: the client, the memory server and
the serving worker together. Heap is the worker's after a forced collection,
taken once the reading client has left.

## The numbers

Listing the board, `cf cell get <board> index`:

| Board | Worker | CPU | Wall | Documents delivered | Value read | Worker heap left |
| --- | --- | --- | --- | --- | --- | --- |
| 100 Topics | running since the creates | 1.8–2.9 s | 2.1–4.9 s | 1,141, 8.2 MB | 16 KB | none |
| 100 Topics | replaced, first listing | 6.2 s | 13.5 s | 1,142, 8.2 MB | 16 KB | 43.5 MB |
| 500 Topics | running since the creates | 9.4–12.4 s | 10.9–13.2 s | 5,141, 40.6 MB | 80 KB | none |
| 500 Topics | replaced, first listing | 17.8 s | 23.7 s | 5,142, 40.6 MB | 80 KB | 126.8 MB |
| 500 Topics | replaced, later listings | 7.6–7.8 s | 8.7–10.6 s | 5,141, 40.6 MB | 80 KB | 1–4 MB |

Reading one Topic, `cf cell get <topic>`, as the median of ten Topics with the
range in parentheses:

| Board | Worker | Read | CPU | Documents delivered | Worker heap left |
| --- | --- | --- | --- | --- | --- |
| 100 | running | first | 1.8 s (1.5–2.5) | 235, 145 KB | 2.9 MB (2.3–4.9) |
| 100 | running | second | 0.48 s (0.44–0.63) | 215, 140 KB | 0.19 MB |
| 100 | replaced | first | 1.5 s (1.3–2.6) | 235, 145 KB | 3.2 MB (2.5–10.6) |
| 100 | running, board not demanded | first | 1.4 s (1.2–2.2) | 235, 145 KB | 3.1 MB (2.9–6.3) |
| 500 | running | first | 5.5 s (4.3–7.5) | 235, 145 KB | 4.9 MB (1.6–16.6) |
| 500 | running | second | 0.65 s (0.62–0.70) | 215, 140 KB | 0.19 MB |
| 500 | replaced | first | 2.6 s (2.4–5.6) | 235, 145 KB | 5.3 MB (3.2–21.9) |
| 500 | replaced | second | 0.50 s (0.47–0.58) | 215, 140 KB | 0.16 MB |

Reading one field of a Topic, `cf cell get <topic> body`, on the 100-Topic
board: a first read took 1.2 s of CPU (1.1–1.4), delivered 75 documents in
97 KB, and left 1.5 MB on the worker; a second took 0.20 s, delivered 74
documents, and left 0.07 MB.

The board that was not demanded listed in the same time as the demanded one,
1.7–2.3 s at 100 Topics, since a listing demands it.

A 2,000-Topic board was not measured. Creating one on this rig, four creates at
a time, had reached 1,036 Topics after 45 minutes at a load of 80 to 300: 100
Topics took 66–85 s, 500 took 621–785 s, and the second thousand was arriving
at about 7 s per create.
`2026-11-05-topics-create-cost-by-board-size.md` beside this profiles why a
create costs more as the board grows. The delivery per Topic was the same at
100 and at 500, which puts a listing of 2,000 at about 164 MB, and the
listing's CPU grew slightly faster than the board, 19 ms per Topic at 100 and
19–25 ms at 500.

## A listing delivers each Topic's result document twice

At 100 Topics the client received 1,141 documents, 686 of them distinct, to
produce a 16 KB value. By content:

| Documents | Bytes | What |
| --- | --- | --- |
| 200 | 7,616 KB | each Topic's result document, 38 KB, twice |
| 200 | 250 KB | each Topic's input document, twice |
| 403 | 111 KB | documents with no object value |
| 200 | 36 KB | link documents |
| about 140 | about 260 KB | the board's own documents and schema documents |

The result document holds the Topic's rendered view and every field it
publishes, and the index row reads six scalars of it. The two copies arrive in
two responses of 4.29 MB each, one to a `session.watch.set` and one to a
`session.watch.add` the client sends after it: the pull through the `read`
view, and then the watch the read itself opens. That is 82 KB delivered per
Topic listed, the same at 500 Topics, and it matches the 166 MB a `cf` listing
of a 2,004-Topic board received against a local toolshed on 2026-11-03.

On a worker that has run the board since the creates, a listing runs no
computation: the worker's timing statistics show no scheduler run during it,
and its time goes to the demand pass and to two `viewInterestsForSpace`
requests to the server's thread, 1.4–2.0 s of elapsed time between them at 100
Topics. The CPU is spent delivering and reading the documents.

A replaced worker pays once to load the board: 6.2 s of CPU at 100 Topics and
17.8 s at 500, against 1.9 s and 7.8 s for the listing after it. That first
listing leaves 435 KB per Topic on the worker at 100 Topics and 254 KB at 500.
The worker that ran the creates held 209 MB at 100 Topics and 436 MB at 500, so
a replaced worker that has listed the board holds less than half of what the
creating one does.

## A first read of a Topic starts its piece, and the piece stays

A first read of a Topic's whole result runs the Topic's piece on the worker:
73 scheduler actions and 29 JavaScript invocations, in three or four waves, at
100 Topics. The worker also makes about 35 watch requests to the server for the
documents the piece reads. The second read of the same Topic runs almost
nothing, about 5 scheduler passes with no JavaScript, and its cost is the
delivery of the same 215 documents.

What the first read starts is not released when the client disconnects. Ten
first reads left 30.5 MB on the worker at 100 Topics and 58.6 MB at 500, and
the second reads left 0.2 MB each on top. Nothing demands those Topics after
their reader has gone.

The cost of a first read grows with the board and with what the worker already
holds. On a replaced worker it is 1.5 s at 100 Topics and 2.6 s at 500; on the
worker that ran the creates it is 1.8 s and 5.5 s. A Topic takes the board's
`mentionable` and `boardCrossrefs` lists as inputs, which would account for the
first; the cause of the second was not measured.

## What this says about the heap plan

`docs/plans/serving-worker-heap.md` plans for a piece nothing demands to exist
only as what the store holds. These figures are the read side of that:

- A listing needs none of the Topics' pieces running. A worker that holds
  nothing serves it for 6–18 s of CPU once, and the delivery, which is most of
  a listing's cost on a warm worker, does not depend on what the worker holds.
- A read of one Topic costs 1.5–2.6 s of CPU when its piece is not running and
  about 0.5 s when it is. Releasing a piece when its last demand leaves trades
  that difference per later read for the 3–5 MB each opened Topic otherwise
  keeps.
- The delivery is the larger cost for a listing at every size measured, and it
  is separate from the heap: 82 KB per Topic for a row of six scalars.

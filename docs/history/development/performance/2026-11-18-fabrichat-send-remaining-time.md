---
status: historical
created: 2026-11-18
archived: 2026-11-18
reason: "Where a FabriChat send's remaining time went once the memory server's walks were back to their work before labs #9155, why main's retirement cost had already fallen to nothing, and the experiments that did not recover the rest"
---

# The rest of a FabriChat send's time, November 2026

## Where this starts

With the memory server's walks back to the work they did before labs #9155
([the previous record](2026-11-17-fabrichat-send-memo-replay.md)), the
FabriChat send benchmark ("fabrichat room/send") was still slower than the
build before #9155. This record says where that time went, why `main` showed
no retirement cost at all by then, and which attempts to recover the time
failed.

## Method

Toolshed binaries were built as the Benchmarks workflow builds them, and each
build's own benchmark file drove a headless Chromium against its own server
on a fresh data directory, as in the earlier records. Three instruments were
added to local copies, outside the timed intervals:

- the server's `/api/health/stats` before and after each timed send;
- a line per frame the server handled (its type, how long it queued and was
  handled, and the documents or watches it named), and per refresh pass;
- in the browser, every runtime telemetry marker during the benchmark's
  read-accounted sample of a send, timestamped, with markers of its own added
  to the scheduler (when an event is queued, and when its input presync
  starts and ends) and to the space replica (each pull, whether a tracked
  selector covered it, and when each watch refresh was sent and answered).

Each timed send runs in a browser session of its own: the benchmark opens the
room, drafts a message, and times the send until its row renders. The machine
was shared with other sessions, but the load was light for most of these
runs. The rounds below compare `main` at `36698c95c0`; the instrumented builds
were made from `main` at `6e9ff5a381`, a few commits later.

## The gap

Five interleaved rounds, six sends each, mean milliseconds per send:

| Round | Before #9155 (`0c8db28459`) | `main` (`36698c95c0`) | #9784 |
| ----- | --------------------------- | --------------------- | ----- |
| 1     | 284                         | 308                   | 545   |
| 2     | 259                         | 337                   | 343   |
| 3     | 263                         | 319                   | 338   |
| 4     | 256                         | 301                   | 304   |
| 5     | 231                         | 300                   | 301   |

Every #9784 send in round 1 was slow (422 to 648 ms) while the other builds'
were not. Leaving that round out, the means are 252 ms before #9155, 314 ms on
`main` and 322 ms with #9784, which is within 1 to 3 ms of `main` in the two
quietest rounds. `main` was slower than before #9155 in every round, by 24 ms
in the first and by 45 to 78 ms in the others; 62 ms by the means without the
first round.

## Retirement on `main`

The earlier record measured 1,424 ms of retirement per send on `main` at
`31b1d04166`. On `main` at `36698c95c0` the retirement phase ran about six
times per send and cost nothing: no record retired. Bisecting the 227 commits
between, measuring the same counter, `memory/refresh/walk/retire`, per send
with each commit's own build (the counter is a time, so it varies with the
machine's load, and these runs gave 549 ms at `31b1d04166`):

| Commit       | Retirement per send | Send   |
| ------------ | ------------------- | ------ |
| `31b1d04166` | 549 ms              | 1,101 ms |
| `5360528b9d` | 570 ms              | 883 ms |
| `c4289df885` | 454 ms              | 727 ms |
| `62167b0e2a` | 448 ms              | 724 ms |
| `7e8f4a7f00` | 507 ms              | 801 ms |
| `725c0b286b` | 0 ms                | 305 ms |
| `2374f1c0c6` | 0 ms                | 312 ms |

`725c0b286b` is labs #9737. Before it, a client starting a piece loaded, in
every space the piece links to, what each of its nodes declared it reads
there, and FabriChat's manager links every room its person keeps, so each
benchmark client loaded every room. After it, a client loads a document in
another space only when one of its reads reaches it. The server then tracks
none of those documents for the session, and a send's re-walks have nothing
to retire. The benchmark has not exercised retirement since #9737 landed. What
#9784 changes still bounds retirement for a client that does track such
documents.

## Where the time goes

The server's handling per send was about 60 ms on both builds, in the frame
traces. The difference is in the browser.

The browser did more work. In the sampled send, the build before #9155 ran 36
actions with 323 cell reads, about 80 ms of action time; `main` ran 43 with
633, about 95 ms. Two computeds the room gained since,
`messageRightsForSession` and `rowFactsForSession` (192 and 225 reads), cost
about 9 ms together, while the room's derivation of its message facts fell
from 275 reads to 173; and the `map` over the message rows went from 28 to 35
ms. The render sink cost 35 ms in both. That is about 16 ms of the room's own
added work.

The events that follow a send took longer. The send's handler queues
`tellManagerJoined`, which queues the manager's `commitManager`, and in the
frame traces a timed send ended within a few milliseconds of the manager's
commit, on both builds. Before #9155, `tellManagerJoined` ran 30 ms
after the send's reactive pass ended; on `main`, 40 to 45 ms. On `main` that
time is two round trips to the server:

- Its input presync, added after #9155 (labs #9511), pulls the room's
  `manager` under the handler's schema. A selector registered moments earlier
  by the watch refresh the new message's render sends covers it, so the
  presync waits for that refresh's answer: about 29 ms, which the render needs
  in any case.
- The preflight that follows reads the manager piece, and its result, through
  links, and pulls each as a root under the handler's own schema; it also
  pulls the room's container under a `ChatContainer` schema that differs from
  the one already watched only in annotations. These are another round trip,
  about 10 ms. The client's selector tracker records the selectors it asked
  for at roots, not what each watch's walk reached through links, so these
  pulls count as new even when the documents are already local.

The subsumption the tracker applies is sound for this case.
`getStandardSchema` drops `asCell`, but the server's query-shaped walk follows
links through `asCell` positions, so a watch whose schema differs from a
pull's only there does deliver what the pull asks for.

The rest of the gap was not attributed further.

## What did not help

Each experiment was built from the same source as its comparison build, with
the instruments above, and run in three interleaved rounds of six sends.

- Overlapping watch refreshes, by forcing `experimentalConcurrentWatchRefresh`
  on: mean 301 ms (rounds 302, 306, 296) against 293 ms (292, 293, 293)
  without it. The presync's wait is for the answer to the refresh that covers
  it, not for a slot.
- Starting a queued event's input presync when the event is queued rather
  than when it reaches the head of the queue: 300 ms (291, 305, 303) against
  303 ms (300, 302, 307). The prefetch started about 145 ms before the head's
  presync, but the head's presync still waited 28 to 35 ms. The worker spends
  that interval in the send's reactive pass, about 130 ms of computation, and
  integrates no answer from the server until it ends: a refresh sent as the
  pass began was integrated 146 ms later.
- Counting a pull whose schema follows no links as covered by any watch whose
  walk passes through its path: 294 ms (290, 291, 301) against 301 ms (299,
  302, 301), with the presync's wait unchanged at 26 to 31 ms. A release pass
  during the session's setup, when a piece an earlier event started was
  stopped, had already removed every watch on the document, so there was
  nothing to cover the pull.

## What remains

The room's added computation is the room's to reduce. The preflight's
further round trip needs the client to know what each watch's walk reached,
and under which schema, before it can treat a pull through a link as covered.
That is a design change to how the replica tracks coverage, not a change to
the send.

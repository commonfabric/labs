---
status: historical
created: 2026-10-16
archived: 2026-10-16
reason: "Measurement of posting the thirtieth message into a FabriChat room before and after messages became pushed elements (commonfabric/labs#8931), with a worker CPU profile of the send and of the room's cold load at thirty messages, October 2026."
---

# Posting the thirtieth message, before and after pushed messages, October 2026

A FabriChat room's messages became objects pushed onto its list in
commonfabric/labs#8931. This records what that did to a send into a room of
thirty messages, and where the time a send and a cold load still take goes.

## Setup

`packages/patterns/integration/fabrichat-room-scale.bench.ts` at 10 and 30
messages with 12 members, each side against a toolshed binary built from its
own tree (`main` at `d766f49be0`, the branch at `dd2fa83fcc`), server
execution off, one laptop, three measured iterations per row. A cold load is
a signed-in page load until the last message renders and every member's badge
shows; a send is a click on the composer's send until the message's row
renders. The reads are the worker's `scheduler.run.complete` telemetry over
the operation: runs, proxy accesses, link resolutions.

| | `main` | pushed messages |
| --- | --- | --- |
| 10: cold load, avg (min … max) | 32.0 s (29.6 … 35.8) | 15.4 s (14.5 … 16.1) |
| 10: send | 2.0 s (1.7 … 2.2) | 1.4 s (1.2 … 1.5) |
| 10: send reads | 69 runs, 750 accesses, 604 hops | 68 runs, 477 accesses, 616 hops |
| 30: cold load | 28.4 s (26.4 … 31.9) | 27.2 s (25.0 … 29.8) |
| 30: send | 2.5 s (2.5 … 2.5) | 1.2 s (1.1 … 1.2) |
| 30: send reads | 69 runs, 1 254 accesses, 804 hops | 68 runs, 757 accesses, 836 hops |

A send into a thirty-message room halves, and its reads grow less with the
room: on `main` a send's accesses grew by 504 between ten and thirty messages
(750 to 1 254), with pushed messages by 280 (477 to 757). The growth that
remains is in what re-runs when the list changes, the room's derivations over
its entries and the new row's render; the send's own handler reads a flat
amount, as the plan's scratch measurement found (49 traversals per send at
any size). The cold load at thirty is the same on both sides, and the halving
at ten is one run each side and is not explained by the change; treat it as
noise until repeated.

## Where a send's 1.2 s goes

The bench's send interval is `clickTrustedAction` plus `waitForSettledText`:
a view settle before the click, the click, a view settle after it, and a
settle before the row's text is checked. A harness that clicks without the
trailing settle and waits for the row's text alone splits it (same room, same
toolshed, three sends, the third after five seconds of quiet):

| | right after load | right after a send | after 5 s quiet |
| --- | --- | --- | --- |
| click → row's text in the DOM | 0.98–1.2 s | 0.96–1.2 s | 0.85–0.92 s |
| row → view settled | 0.3–0.4 s | 0.17–0.2 s | 0.17–0.22 s |
| main-thread tasks over 50 ms, click → row | 0 | 0 | 0 |

A person sees the row at about 0.9 s; the bench's remaining 0.3 s is the
view settle, which waits for the worker's `idle()` — the `joined` follow-up
event's run, which the wake shaper may hold — and for the view's updates.

Inside the 0.9 s, the worker's scheduler telemetry (`scheduler.run.complete`,
which itself slows the run it measures) lists 68 runs, about 0.4 s of them:

- 22 render sinks, about a third of the run time: the view nodes that
  re-render for the new row.
- The `map` that renders the main list's rows, about a third: it is
  `{messages.map(...)}` over the room's *stored* list, every message the room
  holds with the rows outside the main conversation hidden, and it ran twice
  in the send's settle, re-mapping all 31 links each time (161 link hops in
  all). The thread pane's map runs over an empty list while no thread is
  open, as none is here, and costs nothing.
- The room's derivations over the whole list, about a third: `messageEntries`
  (260 reads, resolving every element's link and reading its record),
  `viewPlaces`, `participantsOf` over the entries and the listed profiles
  (283 reads), the main-conversation filter and `latest`, and `messageRights`
  — each 170–280 reads and 35–65 ms, each a full walk of the list for one
  appended element.
- The new row's own computeds: 17 runs, 15 ms in all.

The other half of the 0.9 s is not on either thread's CPU: the renderer on
the main thread reads the new row's cells from the worker over IPC
(`cell:subscribe`, `cell:resolveAsCell`, `cell:getCfcLabel`: 26 round trips
per send), each queued behind the worker's own passes, and the main thread
runs no task longer than 50 ms. The pattern-test rig agrees on the worker's
side: a send into an unrendered room is 29 ms of scheduler work, and the
same send with a rendered tree 250 ms; nine storage watch refreshes run
during a send and nothing on its path awaits them.

So the pattern's share of a send is the shape of its derivations: every
room-level derivation and the row map walk the whole list for one pushed
element. Making them incremental, or at least not resolving every element's
link again, is where the next cut comes from; the IPC round trips for a new
row's cells are the other half, and the runtime's.

## Where a cold load's 27 s goes

The same profile over the load, from sign-in until the room rendered, 14.6 s
of worker time at 11% idle:

- `runner/start/resumeListChildSync` runs 3 976 times. The room reaches that
  many links at thirty messages and twelve members: each message's author
  profile, each message's reaction list, the participants, and the profiles
  behind them. `maxAccesses` is 2 830 at every size on both sides, which says
  the members' profiles, not the messages, set the floor.
- IPC deliveries wait: `cell:subscribe` has a median of 1.97 s over 131 calls,
  `cell:resolveAsCell` 223 calls, `cell:getCfcLabel` 280. `workerLag` reaches
  5.2 s.
- The CPU is again the runtime's: the codec and freezing, link resolution
  (`resolveLinkTracingDereferences`), schema joins (`joinSchema`,
  `definitionNamed`), CFC label merging. Pattern frames total under 20 ms.

The seeding both benches do costs about 50 s per message write at every size
on both sides, from `piece-start-commit-failed` conflicts as members open the
room at once, and the send-burst bench on `main` dropped a message in this
run (eleven of twelve expected). Neither is the change's.

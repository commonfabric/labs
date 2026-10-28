---
status: historical
created: 2026-10-14
archived: 2026-10-14
reason: "Investigation record of the Estuary toolshed instance serving a Loom publication space on 2026-10-14, slowed by sessions rewriting one wish's output slot between two wish-state documents that differed only in the inputs document their cause hashed; the runtime change that followed is live code."
---

# The Loom publication wish-slot ping-pong, October 2026

On 2026-10-14 FabriChat felt slow on Estuary. The toolshed instance on port
8021 served a Loom publication space created that day at 17:31 UTC
(`did:key:z6MkuLBVWMjUc3p8bEDLExBLaXPuFsBGbrWWW8FtGUTG29Vo`, root
`system:loom/main.tsx`), in which the whole team met. This is what the host
said, what the space's history said, and what the mechanism turned out to
be. The runtime change that ends the loop is named at the end, with what
it changes and nothing of how; it is live code, and the code is its own
description.

## The host

The host itself was healthy: load about 1 on 16 cores, no swap, 12 GB of
memory free. The instance on port 8021 averaged 13% CPU with bursts to 92%,
and the space it served took 130,255 commits in six hours, peaking at 6,505
commits per minute at 18:11 UTC, with fourteen active writers.

One space-scoped document in that space,
`of:fid1:0npAB-ANgDSGHwZRIEIm-_0FuZVFg3QojnXi9bjawug`, held 4,622 revisions
written by ten principals, every one by the same action, `raw:wish:…`. Its
first revision carried only the `result` metadata link a piece's setup writes
on each internal cell it mints. The later revisions held a link, at user
scope, to one of two documents. Of the last 200 revisions, 191 were grouped
by the document they named; the other nine were not examined:

| Target | Of the last 200 revisions |
| --- | ---: |
| `of:fid1:fykMtcX2_2pSkeV-nq5NhzuCicgq9u6GsrXhaZNqPco` | 100 |
| `of:fid1:n66xEah2dPPsUU2dMMAJaulDCCrsxQ2-p1T7XAgtP4Q` | 91 |

The remote-echo breaker tripped on that document and action 360 times that
day, against 0 to 12 trips a day before it. A trip lasted up to 43 minutes
with 77 renewals, cleared on a convergence step, and tripped again. The
breaker throttled the loop; it could not end it.

The cost landed on everyone sharing the instance. On the space, `transact`
lock waits ran 377 ms at the median and up to 3 seconds, at which point the
commit was refused as a conflict; about 20% of operations in a ten-minute
window were rejected (1,416 of 7,295); and `session.watch.refresh`, with
about 2,460 watches per session, cost about 285 ms per refresh. The space's
document cache sat at its budget, 131 of 134 MB, with 4,543 evictions and
7,812 patch replays.

Two deploys landed that day, at 20:43 and 22:11 UTC. Neither started it: the
previous release window, from 2026-10-13 23:36 UTC, had 271 trips on the same
instance.

## The mechanism

A wish keeps its state — the result it found, the candidates, and its view —
in a document the runtime mints from the wish node's cause, and writes a link
to that document into the node's output slot. A wish that resolves through
the viewer's Home places its state at user scope, so the link in the slot is
a user-scoped link, and every session follows it to its own instance. Two
sessions running one wish from one compilation of its pattern name one state
document and write one link; a second session's write is elided as equal.

The cause the state was minted from carried the node's inputs document. That
document is content-addressed over the node's serialized inputs, which for a
wish include the schema the transformer generates for the wish's type
parameter. Loom's root pattern imports the FabriChat room and a handler of
the root instantiates it, so the room's code travels inside the Loom program
each session compiles when it loads the root. A deploy that changes the
room's source changes the inputs document of a wish in it for every session
that loads the root afterwards, and changes nothing for a session that loaded
it before.

Compiling the room at the commits around the deploys:

| Commit | `#chatManager` wish inputs | Output slot |
| --- | --- | --- |
| `19fb8152b8` (the 2026-10-13 release) | `fid1:zUpgaKMAWRlekCi…`, 8,097 bytes | `managerWish` |
| `6499525833` (deployed 20:43 UTC) | `fid1:fKiVbwdzMD5vMrf…`, 8,593 bytes | `managerWish` |
| `560bcd9f20` (deployed 22:11 UTC) | `fid1:fKiVbwdzMD5vMrf…`, 8,593 bytes | `managerWish` |

Same slot, two inputs documents, two state documents. `#chatManager`
resolves through Home, so both links were user-scoped. A session holding the
older program wrote its state's link into the slot; a session holding the
newer one wrote its own over it. Each wish reads its slot when it writes it,
to resolve the slot's write redirects, so the other camp's write re-ran it,
and the deep-equal guard on the write never held because the links named
different documents. The space converged only as the older sessions
reloaded, and the team's meeting kept both camps alive for hours.

The two user-scoped targets were what the breaker and the revision history
showed, and they suggested a loop of the kind the Topics space had on
2026-10-07, two spellings of one link at two scopes. It was not that. Both
links were at user scope, and two sessions with one compilation converged
under the same runtime; what differed was the identity of the state behind
the link.

## What followed

The wish's state document is now minted from the node's owning piece and its
output spot, the identity every compilation of the node shares, with the
inputs document left out, as the branching builtins already key their result
stores. A test runs one piece from two compilations whose wish schemas
differ, one session each, and holds both to one state document and a shared
sequence that stops moving once both have settled.

Each wish state is re-minted once, on its first run after the change lands,
and a session holding the older runtime names the older document until it
reloads, so the rollout sees the same two camps once more, for as long as
such sessions last.

---
status: historical
created: 2026-10-17
archived: 2026-10-17
reason: "Correction to the record of the 2026-10-14 Loom publication wish-slot ping-pong: the two camps were one room identity with two compiled artifacts whose schemas listed one enum in two orders, not sessions loaded before and after a deploy; the fixes it names are live code."
---

# What split the camps in the Loom publication wish-slot ping-pong

[The record of the 2026-10-14 ping-pong](2026-10-14-loom-publication-wish-slot-ping-pong.md)
is right about the mechanism of the loop and wrong about what produced its
two camps. It says a deploy that changed the FabriChat room's source gave
sessions loaded before the deploy one inputs document for the room's
`#chatManager` wish and sessions loaded after it another. The space's own
history, read from a snapshot taken on 2026-10-15 at 22:57 UTC, says
otherwise: the room's pattern pointer did not move while each pair of camps
ran, and the two camps' result schemas differ in one place, the order of a
string-literal union. This document records that evidence and the fix. It
leaves the earlier record as it stands.

## What the space's history says

The slot the earlier record names,
`of:fid1:0npAB-ANgDSGHwZRIEIm-_0FuZVFg3QojnXi9bjawug`, belongs to the room
piece `of:fid1:hdjkb9EzjHpbLev2rheaWUkLCsiWZGSQGCG_NBMG9nU`, and its 5,725
revisions fall into two pairs of camps:

| Wish-state targets | Writes | First write | Last write |
| --- | ---: | --- | --- |
| `Wj2sdi…` / `i8fdSw…` | 2,221 / 2,211 | 17:33:11 UTC 10/14 | 23:00:15 / 23:10:13 UTC 10/14 |
| `fykMtc…` / `n66xEa…` | 651 / 639 | 23:00:01 UTC 10/14 | 04:33:04 / 03:11:28 UTC 10/15 |

The second pair is the one the earlier record tallied. The writes on each
side of each pair include sessions of the same principal.

The room's pattern pointer held one identity, `V6XMWvyJ…`, from the piece's
creation at 17:31:59 UTC until 22:59:54 UTC, when a reconcile adopted
`system:fabrichat/room.tsx` and moved it to `VuHsY5kt…`. That move is where
one pair gives way to the other. The first pair's two targets alternated up
to 22:59:59, and the second pair has no write before the move. After the
move the first pair's targets took 13 more writes, all from five sessions
that had been writing them before it. Three of those sessions wrote the
second pair's target within seconds or minutes, and the other two never did:
one stopped at 23:00:15, and the other wrote once more at 23:10:13, which is
the first pair's last write. So the first pair ran while the stored pointer
named `V6XMWvyJ…`, and its tail is sessions still running what they had
loaded before the move. The second pair ran entirely under `VuHsY5kt…`.
Within either pair, nothing repointed the room and nothing rolled it back.

The deploys at 20:43 and 22:11 UTC did not move the pointer: a room a Loom
root's handler makes kept the code it was created with, in every session,
until labs #8904, which merged after both deploys. The two inputs documents
the earlier record compiled, at `19fb8152b8` and `6499525833`, are real, but
they belong to two sources of the room, and each pair of camps ran under one
source.

Fully inlined, the two camps' room result schemas (`6BAbdQS4…` and
`y4dkSrca…`) differ only in the enum for `ChatRoomKind`, declared in
`fabrichat/schemas.tsx` as `"direct" | "group"`. One lists
`["direct","group"]`, the other `["group","direct"]`. A wish's inputs document
carries that schema, so the two orders give two inputs documents, and before
labs #8913 two inputs documents gave two wish states behind one slot. The
remainder of the earlier record's mechanism holds as written: each wish
reads its slot to resolve write redirects when it writes it, so each camp's
write re-ran the other's wish, and the links never compared equal.

## Where the two orders came from

The schema generator listed a union's members in the order the TypeScript
checker holds them, which is the order the checker created the member types
in, and that depends on the whole program being checked. A pattern's module
identity hashes its authored source and its imports alone, so it does not
depend on the program. Compiled on its own, `fabrichat/room.tsx` emitted
`ChatRoomKind` as `["direct","group"]`; compiled inside the program of
`loom/main.tsx`, which imports the room, it emitted `["group","direct"]`. Two
artifacts stood under one room identity. A session that compiled the Loom
root resolved the room's pointer to the artifact built inside that program; a
session that loaded the room by its identity compiled the room's closure on
its own. Which kind of session someone had decided their camp, so one person
could sit in both.

## The test the earlier record describes

The earlier record says a test runs one piece from two compilations whose
wish schemas differ and holds both to a sequence that stops moving once both
have settled. In that test the second session runs the piece from its own
compilation, which writes that compilation's identity into the piece, and the
first session follows the pointer and re-runs the second's program. Both end
on one compilation, so the settled sequence passed on the wish state keyed by
inputs as well, and the case showed the shared state and not the absence of a
loop. Two things kept the harness from showing one. The repoint converged the
sessions, and the runner suite's fake clock never reached the 50 ms debounce
the wish built-in is registered with, so the re-run a write in the other
session called for never came due.

`packages/runner/test/wish-state-identity.test.ts` now holds that case for
its state-id assertions, and a second case beside it in which the second
session starts the piece from its stored pointer with its own artifact
registered under the first session's identity, and the clock moves between
rounds. On the wish built-in before labs #8913 that case loops: the space's
sequence runs 35 against an expected 5, and each session's remote-echo
breaker trips once over 15 observed cycles.

## The fixes

Labs #8913 and #8948 key every store a wish mints on its node's piece and
output spot, so two compilations of one wish name one state whatever their
inputs documents, and the loop ends. Labs #8992 (merged as `8b915a5135`)
removes the split itself: the schema generator lists a union's members and a
mapped type's properties in source order, so a module compiled alone and the
same module compiled inside another program generate one schema.

A second room, in another space, read on 2026-10-15, showed the same enum
camps on its `#chatManager` slot, and two camps on its `#profile` slot whose
schemas were identical. The second camp on that slot appeared at 21:44 UTC,
and what split it was not established; #8913 and #8948 end that loop as well.

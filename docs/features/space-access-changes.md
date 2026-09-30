# Changing a space's access list from a handler

`grantSpaceAccess(target, principal, level)`,
`revokeSpaceAccess(target, principal)` and `leaveSpace(target, options)` let a
handler change who may reach a space. The first sets `principal`'s entry in the
space's access list to exactly `level` (`"READ"`, `"WRITE"` or `"OWNER"`),
raising or lowering it, the second removes the entry, and the third removes the
entry of the principal the handler acts for. They are what a pattern such as a
chat room uses to add or remove a member once the space exists, and to let a
member leave. The implementation is
`packages/runner/src/builder/space-access-change.ts`, and the write all three
calls end in is `writeAcl()` in `packages/runner/src/acl-manager.ts`, the same
one `ACLManager` and `cf acl` go through.

`target` names the space the way it does for `spaceAccess(target)`, described
in [`space-access.md`](space-access.md): a cell, or a value read through one,
stands for the space its value lives in, after following any links it holds.

## What a grant exposes

Adding a member changes no value's label, so a grant exposes to the grantee
everything the space already holds, not only what is written after it. A
revoke or a leave narrows who may read the space from then on, and takes back
nothing the principal has already read.

## Who may change the list

Each call acts for the event's actor, `Runtime.actingPrincipalFor()`, the same
principal `currentPrincipal()` returns. Nothing in the event's payload chooses
it, and it is not an argument.

A refusal at the call throws, from any of the three calls, and so does a refusal
at a grant's or a revoke's commit, which comes before the handler's own. Either
one, when the handler lets it escape, drops the handler's whole transaction. A
refusal at the call is an ordinary exception, though, and a handler may catch
it; the call throws before it stages anything, so a caught refusal leaves
nothing staged for that call, and the handler's other writes commit as usual. A
leave commits after the handler's own writes, so a refusal or failure at its
commit cannot reach the handler: the handler's writes stand, and the failure is
reported afterward through the scheduler's error handlers, as [How a leave
commits](#how-a-leave-commits) describes.

For a grant and a revoke:

| Refused | Where |
| --- | --- |
| A call anywhere but a handler: a pattern body, a `computed()`, a `lift()` | the call |
| A call on a serving runtime | the call |
| An event that is not a trusted gesture | the call |
| A `target` that is not a cell | the call |
| A `target` in the actor's own Home space | the call |
| A `principal` that is not a DID in DID Core syntax, `"*"` among them | the call |
| The space's own DID, or the actor, as `principal` | the call |
| An actor without `OWNER` in the space | the call when the runtime holds the list, and always the commit |
| A change leaving the list with no concrete `OWNER` | the call when the runtime holds the list, and always the commit |

Leaving is described in [its own section](#leaving-a-space) below.

A `target` in the actor's own Home space is refused. A Home space's DID is its
user's own, so the check is that the space is not the actor's DID. Home holds
everything a user keeps, and a pattern running there could otherwise expose
all of it to a stranger with one click. The refusal closes that case and no
other: every other space the actor holds `OWNER` in stays reachable, including
spaces they created from the shell or that another pattern created, and there
the trusted gesture is the only bar between a pattern and the space's list.
Limiting the calls to spaces the calling pattern itself created is not built.

A service DID or a delegating DID is not refused as `principal`. The memory
server's configuration names both (`acl.serviceDids` and `acl.delegatingDids`,
set from toolshed's environment), and nothing hands either list to a runtime,
so a runtime cannot tell one from any other DID. A service DID already holds
`OWNER` in every space at the memory server, so an entry for one adds nothing
there. A delegating DID, the identity a toolshed's serving runtime presents,
holds nothing of its own; what an entry granting one would let a serving
runtime do directly, outside the delegated carriage its served writes go
through, is not settled, and a refusal at the memory server of an access list
that names either kind is the way to close it.

The trusted gesture is the renderer's mark on an event a person caused on a
rendered surface, the test `commitSnapshotShare()` and `commitCustodySeal()`
apply without their match on which surface. The runner records it on the handler's frame when the run
starts, from the event object the renderer marked. A handler that sends its
event on to another stream does not pass the mark along, so the handler it
reaches cannot change a list. The check does not follow the CFC enforcement
dial: it holds in every mode.

A gesture shows that a person acted on the pattern's surface, not what the
pattern did with the act, since the principal and the level are the
pattern's. A pattern with a button can grant someone its data on the next
click, which is the same ceiling every write gated on a trusted gesture has.

The runtime's checks guard against pattern code. The memory server in
`enforce` mode is the gate against everything else: it admits a change to an
access list only from a session principal holding `OWNER` there, and only a
list that keeps a concrete `OWNER`. On a client the session principal is the
user, so a modified client can change the list only as its user could through
any other tool.

Neither a grant nor a revoke may name the actor, so the actor keeps `OWNER`
through any change they make; leaving is `leaveSpace()`'s. The last-`OWNER`
check therefore bites only where the actor holds `OWNER` through the list's
`"*"` entry, and the change would remove or lower the only concrete `OWNER`.

## Leaving a space

`leaveSpace(target, { successors })` removes the actor's own entry, whatever
level it holds. It needs no `OWNER`, and unless it promotes a successor, no
trusted gesture: it acts on the actor alone, and narrows who may read the
space rather than widening it. A member has to be able to leave from any
client acting as them, including one that cannot issue a trusted gesture.

| Refused | Where |
| --- | --- |
| A call anywhere but a handler: a pattern body, a `computed()`, a `lift()` | the call |
| A call on a serving runtime | the call |
| A `target` that is not a cell | the call |
| A `target` in the actor's own Home space | the call |
| `options` that is not an object, or `successors` that is not an array of DIDs in DID Core syntax | the call |
| The space's own DID, or the actor, as a successor | the call |
| A list with a `"*"` entry | the call when the runtime holds the list, and always the commit |
| The last concrete `OWNER` leaving others behind, with no successor holding an entry | the call when the runtime holds the list, and always the commit |
| A leave that would make a successor `OWNER`, for an event that is not a trusted gesture | the call when the runtime holds the list, and always the commit |

A list with a `"*"` entry would go on granting the actor what that entry
grants, so removing their own entry there is not a way out of the space, and
the call refuses it rather than report a leave that did not happen.

When the actor is the list's last concrete `OWNER` and others remain, the same
commit makes the first of `successors`, in the order given, that holds an
entry `OWNER`, so the space never loses its concrete `OWNER`. The runtime
cannot tell who has been a member longest, so there is no automatic promotion
of the longest-standing member, as FabriChat's room specifies: the caller
names the order. A successor who holds no entry is passed over, since making
them `OWNER` would admit someone new. When no successor holds an entry, or
none is named, the leave is refused. When another concrete `OWNER` remains,
`successors` is ignored.

Making a successor `OWNER` is a grant of `OWNER`, so a leave that does needs
the handler's event to be a trusted gesture, checked as a grant's is and
recorded when the handler runs. Without one, a pattern could hand a space the
user alone owns to any member, a `READ` one included, with no act of the
user's. So a client that cannot issue trusted gestures, such as the CLI or a
native client, cannot hand off a space's last `OWNER` until a host can issue
gestures of its own. That departs from FabriChat's "leave from any client"
for the promoting case alone.

When the actor's entry is the list's only one, leaving changes nothing and
succeeds: the list cannot be empty, so the entry stays. No other member can
then read the space or be added to it, which is FabriChat's "leaving is really
abandoning". A service DID still can, since it holds `OWNER` in every space.

The memory server admits a leave from a member without `OWNER` through a rule
of its own (INV-12 in `docs/specs/memory-v2/09-invariants.md`): an access-list
commit whose document is the stored one less the session principal's own
entry, with every other entry and field as stored, and no `"*"` entry in the
stored list. It admits nothing else from a principal without `OWNER`, so a
member cannot use it to change anyone else's entry or promote anyone. A leave
that promotes a successor comes from the last `OWNER`, and passes as any
`OWNER`'s change does.

A leave commits after the handler's own writes, the other way round from a
grant, as [How a leave commits](#how-a-leave-commits) describes.

## How a grant or a revoke commits

The memory server admits a change to an access list only as a commit's single
operation, a whole-document `set` of the list (INV-12 in
`docs/specs/memory-v2/09-invariants.md`). A handler also writes its own data,
so the change cannot share its commit. A grant or a revoke goes in two, in
order:

1. The call checks what it can and stages the change on the handler's frame.
   When the runtime holds the space's list, it checks the actor's `OWNER` and
   the surviving concrete `OWNER` too, so the refusal throws from the call where
   the handler could catch it. The call reads the list outside the handler's
   transaction, so the handler's own commit does not conflict with the
   access-list commit. It does not decide whether the change is a no-op,
   since the list this runtime holds may be behind the memory server's.
2. After the handler body returns, the runner commits each space's staged
   changes, applied in call order, as one commit per space. The commit loads
   the list, catches up with the memory server (a round trip that returns
   once every update the server had sent is applied), and reads the list in
   its own transaction, so its checks and its no-op decision run against the
   server's list as of then. A concurrent change after that makes the commit
   conflict rather than be overwritten.
3. The handler's own transaction then commits, as it would have without the
   change.

A conflict at the second step aborts the handler's transaction and runs the
handler again, which stages its change against the list as it now stands. Any
other failure there fails the handler run. Nothing retries in a loop of its
own.

A grant of the level a principal already holds, or a revoke of an entry that
is not there, changes nothing and sends nothing. So a handler run again for
the same event, whether by a conflict or by redelivery, converges on the same
list.

The access-list commit lands first because the actor keeps access through it:
nothing in it can cost the handler the right to write its own data. The order
leaves one gap. If the handler's own commit then fails, or the process stops
between the two, the list has changed and the handler's records have not, so
a member may be admitted before the pattern's records say so. Running the
handler again for the same event repairs it, since the change is then a no-op.
A handler that changes two spaces' lists commits them one after the other, and
a failure on the second leaves the first in place.

## How a leave commits

A leave is the one change that costs the actor access, so it commits after the
handler's own transaction rather than before it: once it lands, the memory
server refuses the actor's writes to the space, the handler's among them.

1. The call checks what it can and stages the leave on the handler's frame,
   together with a post-commit effect on the handler's transaction. When the
   runtime holds the space's list, the call checks the `"*"` entry and the
   surviving concrete `OWNER` too. A later call for the same space in the same
   run takes the place of an earlier one.
2. The handler's own transaction commits. If it is refused for good, the
   effect is abandoned and the leave is never sent.
3. Once the memory server has accepted the handler's writes, the effect loads
   the list, catches up with the memory server as a grant's commit does, and
   commits the list less the actor's entry, with a successor made `OWNER` where
   one is needed. When the list holds no entry for the actor, it sends
   nothing.

So a leave may not land even though the handler's writes did. A failure at the
third step, whether a refusal the call could not see or a conflict with a
concurrent change to the list, cannot fail the run, whose writes have
committed, and nothing runs the handler again. The actor keeps their entry,
and the failure is reported through the scheduler's error handlers, as a
failed run is. Those reach the host, not the pattern, and the post-commit
effect that commits the leave has no other way to report back, so a pattern
that needs to know reads `spaceAccess(target)` afterwards. The pattern's records may then say the actor left while the
list still admits them. Leaving again repairs it: a pattern that finds a leave
it already recorded calls `leaveSpace()` again, which sends nothing once the
entry is gone.

## Serving runtimes

All three calls throw on a serving runtime. A serving runtime's sessions write
through the wave's delegated carriage, and the memory server checks only that
the carried actor is present, not what that actor holds in the space, nor that
a leave removes that actor's own entry and nothing else. The runtime's own
check would then be the only one between a served handler and the list.
Carrying an access-list change through the wave, with the actor's level
checked where the wave commits, is not built.

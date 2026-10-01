# Changing a space's access list from a handler

`grantSpaceAccess(target, principal, level)` and
`revokeSpaceAccess(target, principal)` let a handler change who may reach a
space: the first sets `principal`'s entry in the space's access list to exactly
`level` (`"READ"`, `"WRITE"` or `"OWNER"`), raising or lowering it, and the
second removes the entry. They are what a pattern such as a chat room uses to
add or remove a member once the space exists. The implementation is
`packages/runner/src/builder/space-access-change.ts`, and the write both calls
end in is `writeAcl()` in `packages/runner/src/acl-manager.ts`, the same one
`ACLManager` and `cf acl` go through.

`target` names the space the way it does for `spaceAccess(target)`, described
in [`space-access.md`](space-access.md): a cell, or a value read through one,
stands for the space its value lives in, after following any links it holds.

## What a grant exposes

Adding a member changes no value's label, so a grant exposes to the grantee
everything the space already holds, not only what is written after it. A
revoke narrows who may read the space from then on, and takes back nothing the
revoked principal has already read.

## Who may change the list

The call acts for the event's actor, `Runtime.actingPrincipalFor()`, the same
principal `currentPrincipal()` returns. Nothing in the event's payload chooses
it, and it is not an argument.

Every refusal throws, from the call or from the commit that follows the
handler body. A refusal at the commit, and a refusal at the call that the
handler lets escape, drop the handler's whole transaction. A refusal at the
call is an ordinary exception, though, and a handler may catch it; the call
throws before it stages anything, so a caught refusal leaves nothing staged
for that call, and the handler's other writes commit as usual.

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
access list only from a session principal holding `OWNER` there, but for a
member removing its own entry and nothing else, and only a list that keeps a
concrete `OWNER`. On a client the session principal is the user, so a modified
client can change the list only as its user could through any other tool. A
serving runtime's commits reach the store without that check, so the serving
loop refuses any run that writes an access list, in every mode
([`serving-loop.md` §3d](../specs/server-side-execution/serving-loop.md#3d-transactions-the-action-tx-seals-into-the-wave)).

Neither call may name the actor, so the actor keeps `OWNER` through any change
they make, and neither call is a way to leave a space. The last-`OWNER` check
therefore bites only where the actor holds `OWNER` through the list's `"*"`
entry, and the change would remove or lower the only concrete `OWNER`.

## How the change commits

The memory server admits a change to an access list only as a commit's single
operation, a whole-document `set` of the list (INV-12 in
`docs/specs/memory-v2/09-invariants.md`). A handler also writes its own data,
so the change cannot share its commit. It goes in two, in order:

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

## Serving runtimes

Both calls throw on a serving runtime. A serving runtime's sessions write
through the wave's delegated carriage, and the memory server checks only that
the carried actor is present, not what that actor holds in the space. The
runtime's own check would then be the only one between a served handler and
the list. Carrying an access-list change through the wave, with the actor's
level checked where the wave commits, is not built.

# Custom roots at space genesis

A publisher can reserve a custom default pattern while creating a space.
`StorageManager.createSpace(acl, { root })` (and
`Runtime.createSpace({ root })`) commits the reservation in the space's genesis
commit, beside its ACL. The
reservation contains a deployment-local `system:` source, a stable cause,
optional pattern arguments, and optional `sourceRoots` naming attached test
entries.

Creating the space requires the host's `genesisRoot` protocol capability. An
unsupported host is an explicit failure. Within the `createSpace` call, the
space key opens one session and signs the complete root intent into its session
descriptor, on the first mount and on every resume. It then signs the genesis
commit, which carries the ACL and the reservation beside it. The server
requires the commit's reservation to match that authenticated intent, and once
the reservation is persisted it refuses a session whose root intent differs
from it, using Fabric value equality: a different source, cause, arguments, or
attached test roots is a conflict. The reservation is retained in the same
durable commit receipt. Ordinary document queries do not export the
reservation. A later ACL change or ordinary writer cannot install or alter it.
The publisher uses the concrete OWNER in the ACL for management after genesis.
The key is dropped when the call returns, so no one holds it afterwards.

The serving loop reads the reservation before ensuring the space root. It
resolves and compiles the requested source and every attached test entry, then
creates the root at the cause-derived address and links `defaultPattern` in one
transaction. Concurrent client and server creation converge on that address. A
restart retains the selected custom root. A linked root at a different address
is a conflict, rather than permission to replace it. Without a reservation the
ordinary home/default-app selection applies.

A reservation may instead name a cause and nothing else. That one leaves
placing the root to the space's creator: the serving loop creates nothing for
it, and resolves the root once the creator has placed it at the cause-derived
address and linked `defaultPattern`. A linked root at a different address is
the same conflict. `PatternFactory.inSpace()` makes this reservation for a
space whose root is the pattern's result; see "Roots placed by their creator"
below.

Only deployment-local system sources are accepted by this bootstrap seam. The
source path and attached test paths cannot traverse directories or specify an
external origin. A caller preparing custom application sources should deploy
those sources to the selected host first. The ordinary source-update lifecycle
retains the obligation to attach the same tests on every later update.

A genesis receipt seals authority and root intent. A publisher must separately
wait for root creation and verify the durable `defaultPattern` link and usable
public exports before presenting the space as ready. A failed compilation can
leave an intentionally sealed, not-yet-ready space; a retry of root creation
uses the same space and root cause. Existing spaces are never converted by
replacing their root under this operation.

## Roots placed by their creator

`inSpace(name, { root: true })` makes the pattern's result the root of the
space the call creates. The space's genesis commit carries a reservation naming
no source and a cause that names the space, `in-space-root:` followed by the
space's DID. The run that instantiates the result places it at that cause's
address in the new space, rather than at the address derived from its parent's
output, and links `defaultPattern` to it in the same commit, when nothing is
linked there yet. Because the cause names the space, the roots of two such
spaces are two entities, so a pattern that keys a record by the entity a root
names, as one keys a person's record by their profile, keeps them apart. A re-run of the same call finds the
same address, so it neither places a second root nor moves the link.

Between the genesis commit and the creating run's commit the space holds only
its access-control document and the reservation. If that run never commits,
the space is named by nothing: its DID reaches no allocation record, and the
serving loop leaves it rootless. A later run in the same runtime resolving the
same name with the same request reaches the same space, and places the root
there. The creator's own client opening the space by its DID in that window
still creates the default root, since the reservation is not readable from a
client, and the serving loop then reports that root as a conflict. So does the
client of any other principal the access list makes an `OWNER`, since opening
a space creates its root only for an `OWNER`. A client without `OWNER` creates
nothing there.

Only a space named by a string, or an anonymous one, can be created with
`root`: a DID or a cell names a space that already exists, and `inSpace()`
refuses `root` with either. It also refuses `root` for a pattern whose result
is not space-scoped, since the reserved address is in the space scope.

A genesis commit can also declare the space's kind, whether or not it reserves
a root, as `inSpace(name, { spaceKind })` does. The kind is sealed by the same
rules; [`space-kinds.md`](space-kinds.md) describes it.

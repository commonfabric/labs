# Custom roots at space genesis

A publisher can reserve a custom default pattern while creating a space.
`StorageManager.createSpace(acl, root)` (and `Runtime.createSpace({ root })`)
commits the reservation in the space's genesis commit, beside its ACL. The
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
the same conflict.

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

# Custom roots at space genesis

A publisher can reserve a custom default pattern while sealing a fresh space's
ACL. `StorageManager.registerSpaceIdentity` accepts `genesisRoot` alongside an
explicit `genesisAcl`, before that manager first opens the space. The
reservation contains a deployment-local `system:` source, a stable cause,
optional pattern arguments, and optional `sourceRoots` naming attached test
entries.

The bootstrap client requires the host's `genesisRoot` protocol capability. An
unsupported host is an explicit failure. The space key signs the ACL-only first
commit; the root reservation is retained in that same durable commit receipt.
Ordinary document queries do not export the reservation. A later ACL change or
ordinary writer cannot install or alter it. The publisher uses the concrete
OWNER in the ACL for management after bootstrap and retains the space key only
for bootstrap recovery.

The serving loop reads the reservation before ensuring the space root. It
resolves and compiles the requested source and every attached test entry, then
creates the root at the cause-derived address and links `defaultPattern` in one
transaction. Concurrent client and server creation converge on that address. A
restart retains the selected custom root. Every bootstrap-client mount and
resume signs the complete root expectation into its session descriptor. The
server compares it to the persisted reservation using Fabric value equality;
changing the source, cause, arguments, or attached test roots is a conflict. A
linked root at a different address is a conflict, rather than permission to
replace it. Without a reservation the ordinary home/default-app selection
applies.

Only deployment-local system sources are accepted by this bootstrap seam. The
source path and attached test paths cannot traverse directories or specify an
external origin. A caller preparing custom application sources should deploy
those sources to the selected host first. The ordinary source-update lifecycle
retains the obligation to attach the same tests on every later update.

A genesis receipt seals authority and root intent. A publisher must separately
wait for root creation and verify the durable `defaultPattern` link and usable
public exports before presenting the space as ready. A failed compilation can
leave an intentionally sealed, not-yet-ready space; retry uses the same space
identity and root cause. Existing spaces are never converted by replacing their
root under this operation.

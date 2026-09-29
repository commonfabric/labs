# Pattern space membership

Patterns can create private spaces and manage membership without using bearer
invitations. The space access list remains authoritative. A room's roster holds
profiles for presentation; adding a profile grants no access.

## Reading identity and access

`currentPrincipal()` returns the authenticated actor inside a handler. In a
reactive computation it returns the demanding viewer and acquires user scope.
A userless execution returns `undefined`. An event payload cannot choose this
identity.

`spaceMembers(target?)` reads the authoritative access list as a reactive
dependency. It returns a map from principal to `READ`, `WRITE`, or `OWNER`, or
`undefined` when the list is unavailable. Without a target it reads the executing
space; a target cell selects that cell's resolved space. Initial loading settles
before the computation or handler is retried.

`spaceAccess(target?)` distinguishes `member`, `not-member`, and `unavailable`
for the demanding viewer. An explicit ACL denial or revocation means
`not-member`; a transport failure or unavailable ACL means `unavailable`.
Consumers must not infer denial from an empty application record. This check
precedes reading cached membership after a revocation.

## Private allocation

`SomePattern.inPrivateSpace(name)(input)` allocates a random space whose genesis
grants only its authenticated creator `OWNER`. The allocation name is scoped to
the caller's durable allocation cell. Repeating it selects the same space;
concurrent first uses conflict on that cell rather than publishing two targets.
The space identity's private key is used for genesis and is not retained.

A process interruption before publishing the allocation reference can leave an
unreferenced private space. It does not grant other principals access. A creator
should commit its target reference before granting members, so resumption can
find the same room.

## Atomic membership changes

`setSpaceMembers(after, target?)` is a handler-only operation. It stages the
complete replacement access list together with the handler's ordinary writes.
The host validates the actor, the previous ACL, and the replacement. An OWNER
can administer the list while preserving a concrete owner. A WRITE member may
remove only their own entry. READ members cannot submit this operation because
its data writes require WRITE. No call grants a wildcard implicitly.

The memory host's `atomicAclChanges` capability admits a separate ACL-only
companion commit in the same database transaction as the data commit. The data
commit and companion either both commit or neither does. An ordinary memory
append cannot opt itself into this host authority. A stale prior ACL conflicts;
replay returns the original result without duplicating the companion. Revocation
is published after the successful verdict and data publication.

For a target in another space, the runtime commits that target before its
calling space. A caller must keep a durable intent and make its completion
idempotent: a target-space commit can succeed before the caller's completion is
recorded. FabriChat uses this ordering to grant room members before publishing
the home index entry and outgoing notices.

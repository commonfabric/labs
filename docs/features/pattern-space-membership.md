# Pattern space membership

Patterns can create private spaces with explicit creation grants and read their
authoritative access lists. System facilities manage subsequent membership.
The default app holds participant profiles for presentation; adding a profile
grants no access.

## Reading identity and access

`currentPrincipal()` returns the authenticated actor inside a handler, as
[the principal API](current-principal.md) describes. An event payload cannot
choose this identity.

`viewerPrincipal()` returns the demanding viewer inside a reactive computation,
or `undefined` without a viewer. It narrows the result and its dependents to
user scope on both client and serving runtimes. The read contributes
`User(viewer)` confidentiality through the runtime's content-observation
channel, so derived values cannot flow to a wider sink. It throws in handlers
and pattern bodies. FabriChat uses it to recognize the sender's own messages
independently of the profile the viewer currently selected.

`spaceMembers(target?)` reads the authoritative access list as a reactive
dependency. It returns a map from principal to `READ`, `WRITE`, or `OWNER`, or
`undefined` when the list is unavailable. Without a target it reads the executing
space; a target cell selects that cell's resolved space. Initial loading settles
before the computation or handler is retried. Client computations use user
scope because a denied session has no membership snapshot; served computations
read the authoritative list independently of the service session's access.

`spaceAccess(target)` returns the current principal's own `READ`, `WRITE`, or
`OWNER` level, `"none"` when refused, and `undefined` while unknown. The target
is a cell in the space to ask about. See [space access](space-access.md) for
reactive scope and readmission behavior.

## Private allocation

`SomePattern.inSpace(name, { grants })(input)` allocates a random space whose
creation grants its authenticated creator OWNER and the named principals their
specified READ or WRITE access. The first factory call naming a space supplies
its grants. Repeating the allocation name selects the same durable space;
concurrent first uses conflict on the allocation record.

FabriChat supplies the intended grants on the first factory call, which creates
the policy, and allocates its room in that same named space. It publishes the manager entry and notices only
after recording the room reference. Interrupted allocation can leave an
unreferenced space with those intended grants; resumption uses the durable
allocation record when one exists. Space administration belongs to the system's
access tools, independently of chat records.

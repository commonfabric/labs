# Scoped Cell Instances

## Status

Draft requirements spec.

This document captures the target behavior for scoped cell instances. It is
intended to drive later implementation across memory storage, runner traversal,
schema generation, transformer lowering, and built-in factories.

## Summary

Cells are identified by ids derived from their causal generation chain, not from
their contents. A single causal id can have multiple scoped instances. Scope
selects which instance is addressed for a given id.

The initial scope lattice is:

1. `space`: one instance per space
2. `user`: one instance per authenticated user DID in a space
3. `session`: one instance per memory session in a space

The ordering is:

```text
space < user < session
```

`space` is the broadest scope. `session` is the narrowest scope.

Scope is not part of cause computation. Cause-derived ids remain the same across
scopes. Scope is an addressing dimension layered over the id.

When code computes a cause from links, it must ignore link scope. Both the
declared `scope` field and the runtime effective scope key are excluded from
cause computation.

## Goals

- Allow the same causal cell id to have space-wide, per-user, and per-session
  instances.
- Let broad-scoped documents contain links to narrower-scoped data without
  storing user ids or session ids in the links.
- Preserve stable link structure across readers while allowing each reader to
  see the instance that matches their runtime scope.
- Make scope expressible in TypeScript authoring, generated schema, normalized
  links, and serialized sigil links.
- Keep existing unscoped patterns working with space scope unless a scoped use
  site or schema narrows them.

## Non-Goals

- Scope does not replace CFC or IFC labels.
- Scope does not create a general authorization model by itself.
- Scope does not change causal id computation.
- Scope does not require metadata/provenance links to obey normal data-read scope
  filtering.

## Terminology

**Declared scope** is a scope marker present in a TypeScript type, generated
schema, normalized link, or serialized link.

**Effective scope** is the concrete runtime scope used to address storage. For
`user` and `session`, the effective storage key is resolved from runtime
identity, not serialized into links.

**Narrowest scope** means the maximum scope in the lattice encountered during a
read or required by an input set. For example, `session` is narrower than
`user`.

**Scope key** is the storage-level key that selects the scoped instance for a
cell id. Storage uses one field for this key so the illegal state "same session,
different user" cannot be represented as two independent columns. The first
implementation uses an opaque, prefixed string:

- `space` for per-space data
- `user:<did>` for per-user data
- `session:<did>:<session-id>` for per-session data, with the DID and session
  id encoded as opaque key parts

The prefix determines the key kind. The rest of the string is runtime identity
material and is not serialized into links. Future scope kinds can use additional
prefixes without changing storage shape.

## Runtime Scope Context

Every runtime operation that can resolve a scoped link or create a scoped cell
must have a scope context:

```ts
// Shown at module scope.
type RuntimeScopeContext = {
  space: MemorySpace;
  userDid: string;
  sessionId?: string;
};
```

`userDid` is required independently of this feature. A missing authenticated
user DID is an invalid runtime state.

`sessionId` is required when resolving, creating, reading, or writing a
session-scoped instance. A session id is always bound to exactly one user DID;
the same session id must not be usable for another user within the session
registry. Storage does not rely on that registry invariant for isolation:
the effective session scope key also includes the authenticated user DID so two
users reusing the same caller-supplied session id cannot collide.

Scope is data scope. Pattern code, schemas, and link structure may be shared
across scopes, but the data object addressed by `(space, id, scope_key)` is
scope-specific.

The runtime must not read across effective scope keys. A user-scoped read for
one DID cannot read another user's `user:<did>` instance, and a session-scoped
read cannot read another session scope key for a different user DID or memory
session id. Links do not encode the DID or session id; the runtime context
supplies those values.

Writing follows the target cell's effective scope. Writing to a broader scoped
cell from a narrower scoped computation is allowed by the scope system and is
the explicit mechanism for moving data from narrow to wide scopes.

Moving data from narrow to wide scopes means writing the **value** (or a link
to a broader-scoped cell). Storing a narrower-scoped **link** in a
broader-scoped slot warns loudly at the write site when the slot's shape
indicates shared-data intent — the slot's schema neither matches `undefined`
nor carries an effective `default`, and the parent schema (where visible at
the write site) requires the slot — unless the slot's schema
declares that scope (a scoped `asCell` entry or schema `scope`): because links
do not encode the DID or session id, such a link resolves to a different
instance for every reader, so data "shared" that way can never propagate — it
reads as a permanent hole for everyone but the writer. A schema-declared scope on a
slot is a cap: content may be at most that narrow, so a link at or broader
than the cap is correct usage (and silent), while a narrower-than-cap link
still warns. Optional, tolerant, or defaulted slots (including the runtime's
own scoped-link-writing slots) degrade harmlessly and stay silent.

## Link Semantics

### Scope Types

The implementation must use separate type aliases for schema scopes and link
scopes because `any` is only valid in schema positions and `inherit` is only
valid in link positions:

```ts
type CellScope = "space" | "user" | "session";
type SchemaScope = CellScope | "any";
type LinkScope = "inherit" | CellScope;
```

`CellScope` participates in the scope lattice. `SchemaScope` controls traversal
restrictions. `LinkScope` controls how a link selects the scoped instance of
its target id.

### Serialized Links

`link@1` gains an optional `scope` field:

```ts
// Shown at module scope.
type LinkV1Inner = {
  id?: URI;
  path?: readonly string[];
  space?: MemorySpace;
  schema?: JSONSchema;
  overwrite?: "redirect" | "this";
  scope?: LinkScope;
};
```

Omitting `scope` is equivalent to `scope: "inherit"`. This mirrors the existing
style where default link behavior is omitted where possible.

Links do not store the user DID or session id. They store only the declared
scope behavior. Runtime identity resolves the effective scope key.

Cross-space links also carry scope because the target scope can differ from the
containing document's scope.

When serializing a link relative to a containing document or base cell, the
writer must omit `scope` only when the intended link scope is inherited from
that containing context. A link from a broader document to a narrower target
must serialize the narrower `scope` field explicitly.

### Normalized Links

`NormalizedLink` gains an optional `scope` field:

```ts
// Shown at module scope.
type NormalizedLink = {
  id?: URI;
  path: readonly MemoryAddressPathComponent[];
  space?: MemorySpace;
  schema?: JSONSchema;
  overwrite?: "redirect";
  scope?: LinkScope;
};
```

The current normalized path convention remains unchanged: `path` is
value-relative. Document-root memory addresses still prepend `"value"` when
converting from a normalized link.

`NormalizedLink.scope === undefined` means the same thing as serialized omission:
`inherit`.

`NormalizedFullLink` must include a resolved cell scope:

```ts
// Shown at module scope.
type NormalizedFullLink = NormalizedLink & {
  id: URI;
  space: MemorySpace;
  scope: CellScope;
};
```

`NormalizedFullLink.scope` must never be `inherit` or `any`. Creating a full
link requires a containing/base scope so inheritance can be resolved. Legacy
links and legacy documents with no scope metadata resolve to `space`.

`NormalizedFullLink` still does not contain the user DID or session id. Runtime
identity resolves `(space, id, scope)` to `(space, id, scope_key)` at storage
access time.

Link equality and address keys must include effective scope when referring to a
storage instance. Cause-derived id equality must not include scope.

When a link omits `scope`, normalization resolves it as `inherit` from the
containing document's declared/effective scope. Inheritance affects address
selection only; it does not affect the causal id.

The link helpers must use these rules:

- `parseLink(...)` returns a `NormalizedLink` that preserves omitted scope as
  inheritance until a base scope is available.
- `parseLink(...)` with a full base returns a `NormalizedFullLink` whose scope is
  resolved.
- Any base object accepted by link parsing or link serialization must carry the
  containing scope. Legacy base objects without scope are treated as `space`
  only for migration compatibility.
- `getAsNormalizedFullLink()` returns a `NormalizedFullLink` with resolved
  `scope`.
- `createSigilLinkFromParsedLink(...)` serializes `scope` only when the link
  should not inherit the containing/base scope.
- `areNormalizedLinksSame(...)` includes resolved scope when both links are full
  or otherwise have explicit scope. Scope-insensitive comparison is only valid
  for causal id computation and must be named separately if needed.

Storage-address conversion extends the current value-address shape:

```ts
// Shown at module scope.
type ScopedMemorySpaceAddress = {
  space: MemorySpace;
  id: URI;
  path: readonly ["value", ...string[]];
  scope_key: string;
};
```

The implementation must either extend `toMemorySpaceAddress(...)` or introduce a
scoped replacement. All storage reads and writes must use the scoped address
shape, deriving `scope_key` from `NormalizedFullLink.scope` and the runtime
identity/session context.

### Stable Link Structure, Scoped Read Result

A central property of this feature is that a document can contain the same link
structure for every reader while the data obtained by following that link
differs by runtime scope.

Example:

```json
{
  "value": {
    "draft": {
      "/": {
        "link@1": {
          "id": "of:shared-draft-id",
          "scope": "session"
        }
      }
    }
  }
}
```

Every user and session can see the same outer document and same link object.
Following the link resolves to the session-scoped instance for the current
memory session. The link's serialized structure is stable; the followed data is
scope-dependent.

This behavior applies equally when a broader scoped output contains a link to a
narrower scoped computation result.

## Schema Semantics

`JSONSchemaObj` gains an optional Common Fabric extension:

```ts
// Shown at module scope.
type AsCellEntry =
  | CellKind
  | {
    kind: CellKind;
    scope?: SchemaScope;
  };

type JSONSchemaObj = {
  scope?: SchemaScope;
  asCell?: readonly AsCellEntry[];
  // ...
};
```

`scope: "space"`, `scope: "user"`, and `scope: "session"` set the narrowest
link scope that reads are allowed to follow. If the schema declares
`scope: "user"`, then space and user links may be followed, but session links
are treated as unavailable.

`scope: "any"` disables that follow restriction for reads. The returned value's
effective scope is the narrowest scope actually encountered while following
links.

When a read cannot follow a link because the target link is narrower than the
schema permits, the runtime treats that value as `undefined`. This must be
logged at `info` level for debugging.

Missing `scope` in a schema means no static minimum scope was declared. For
read-following behavior this acts like `any`: the traversal can follow any
scope and the result narrows to the narrowest encountered scope. When creating
or writing a cell with no explicit scope, the containing pattern/factory/cell
default determines the created instance scope.

`PerAny<T>` in TypeScript serializes to `scope: "any"`.

For writes, `scope: "any"` means the schema does not statically constrain the
target scope. The target cell's own effective scope or the containing default
scope still determines which storage instance is written.

For reads, schema scope controls which link scopes can be followed. For writes,
the target cell's declared/effective scope controls which scoped storage
instance is written. A write does not widen or narrow the target cell just
because the value being written was read from another scope.

A writable handle created for an absent defaulted property uses the scope on
its `asCell` entry, whether the property is read through the containing object
or projected with `key()`. A stored value or reference retains its own scope;
a reference to a missing target is still an existing reference. An unresolved
or scope-blocked ancestor cannot authorize creation of a scoped default.

Pattern argument setup materializes missing declared scoped properties even
when the caller supplies the argument object through a Cell reference. The
redirect stays at the input slot so existing child bindings follow subsequent
explicit rebinding. Existing values and references remain authoritative,
including a reference to the same input field at a narrower scope. The reads
that authorize initialization remain commit dependencies, so a concurrent
explicit write cannot be overwritten silently.

A pattern binding addresses an argument slot at the argument cell's own scope,
whether the slot's scope is declared on the value (`Writable<PerUser<T>>`
emits `scope: "user"` beside `asCell: ["cell"]`) or on the cell wrapper
(`PerUser<Writable<T>>` emits `asCell: [{ kind: "cell", scope: "user" }]`).
The declared scope travels in the binding's schema and is realized when the
binding is read or written, as for any other schema-scoped slot. The base slot
is the one place that holds both kinds of content: a reference the caller
passed in is stored there unchanged, and a plain value is narrowed into the
scoped instance with a redirect left in the base slot. A binding that addressed
the scoped instance directly would find a passed reference missing.

A binding to a path below a scoped slot carries that slot's scope as well. The
serialized binding holds only the leaf's schema, so when the leaf declares no
scope of its own, the narrowest scope declared along the path is written onto
the leaf schema, and a link stored at the scoped slot is held to it.

The two spellings differ in what they constrain. A scope on the cell wrapper
caps which link the handle may follow: a passed reference to a narrower cell is
not followed. A scope on the value scopes the slot's own content: a plain
value written into the slot narrows into the scoped instance. It does not cap
the handle, so a passed reference to a narrower cell is followed. A handle
minted by following a passed reference addresses the referenced cell and does
not carry the slot's value scope, so a write through it lands in that cell's
own instance. When the slot receives a reference to an existing cell, such as a
record handle, use the cell-wrapper spelling.

With server execution enabled, an automatically created space-to-user link for
`PerSession` storage carries `scopeInitialization: "session"` in its link
payload. This declaration permits argument setup to fill a missing user-to-session
hop when another user demands the pattern. It applies only to the canonical
same-document, same-path user target. Existing user values, references, and
explicit `undefined` remain authoritative. A graph-owned setup action reads
those user slots through the usual scheduler, so user instances are discovered
from reads and active demand. Before initialization, the action loads the user
document under the transaction's acting identity to preserve existing siblings.

The declaration is part of the stored link value, not its address, cause identity,
CFC label, or authority. Raw serialization and copying retain it; copying a
relative declaration gives it the relative target at the destination. Writing an
ordinary Cell or unmarked link to the same address clears the declaration, even
though address equality is unchanged. Existing initialized user-to-session links
and session values remain in place after that replacement.

An unmarked stored user link is treated as an explicit reference. Setup does not
infer initialization ownership from its shape, so older unmarked links do not
receive automatic continuation. An author can deliberately reestablish declared
session storage by writing content through the field's `PerSession` schema; that
write creates the declaration and its acting user's redirect chain. It does not
replace other users' existing values or references.

## TypeScript Authoring

Scope wrappers are type-level annotations:

- `PerSpace<T>`
- `PerUser<T>`
- `PerSession<T>`
- `PerAny<T>`

They may be used anywhere a pattern, lift, or handler parameter type is defined,
where a cell wrapper type is defined, or where a variable is assigned from one
of those outputs and the transformer can observe the type.

Examples:

```ts
// Shown at module scope.
type SharedTodos = PerSpace<Writable<Todo[]>>;
type UserPrefs = PerUser<Writable<Preferences>>;
type Draft = PerSession<Writable<DraftState>>;
type AnyScopedValue = PerAny<Cell<Result>>;
```

Local cell constructors can also declare scope directly:

```ts
// Shown inside a pattern body.
const sharedTodos = new Writable.perSpace<Todo[]>([]);
const userPrefs = new Writable.perUser<Preferences>(DEFAULT_PREFS);
const draft = new Writable.perSession<DraftState>(EMPTY_DRAFT);
```

Plain `new Writable(...)` does not set a scope by itself; it inherits from the
containing pattern or factory context unless contextual typing adds an explicit
scoped schema.

Nested scope wrappers without a cell boundary are invalid because there is no
separate storage object on which to place each scope. For example,
`PerUser<PerSession<T>>` is invalid. A nested scope is valid when a `Cell`
boundary exists between the scopes, for example `PerUser<Cell<PerSession<T>>>`.

The schema generator lowers these wrappers into `scope` fields. Existing cell
wrappers continue to lower into `asCell`.

The `asCell` array preserves wrapper order from outermost to innermost. Existing
string entries remain valid and mean `{ kind: <string> }`; scope is inherited by
omission.
Object entries add scope at the corresponding cell-wrapper level:

```json
{
  "type": "object",
  "scope": "session",
  "asCell": [
    { "kind": "cell", "scope": "user" },
    "cell"
  ]
}
```

In this example the outer cell wrapper is user scoped, the inner cell wrapper
inherits from that containing context, and the final followed value has
`scope: "session"`.

## Pattern And Factory Defaults

Pattern instances are created in a default scope. The default scope is:

1. the explicit factory default from `.asScope(scope)`, when present
2. otherwise, the effective scope of the result cell the pattern is
   instantiated into
3. otherwise, `space`

The result cell's effective scope is itself normally determined from the
top-level result schema, an assignment-context schema inferred by the
transformer, or an explicit result cell schema. The key rule is that pattern
internals follow the scope of the concrete result cell being instantiated, not a
separate hidden pattern-level storage dimension.

Most patterns will not explicitly declare scope. In those cases their effective
scope is determined by how they are used: the result cell they are instantiated
into, an inferred assignment type, or a containing factory default.

When the transformer sees a factory call assigned to a variable or output whose
type requires a specific scope, it must lower that contextual type into the
factory call by applying `.asScope(scope)` or an equivalent builder-level
default.

`.asScope(scope)` is available on factories only. It is not a cell method.
Cells already have schemas, which provide the cell-level scope-setting surface.
Local schemas on pattern inputs, result schemas, or cell schemas override the
factory default for the specific value or cell they describe.

Pattern-owned cells start in the pattern's default scope. This includes the
argument cell reached from result-cell metadata and the derived internal cells
listed in the result cell's `internal` manifest. If a computation inside the
pattern reads narrower scoped data, its output handling follows the computation
rules below.

## Computation Rules

For ordinary compute nodes, including `computed` and `lift`, the
logical output schema has the narrowest scope of the input schemas.

If a computation whose output location is broader reads data from a narrower
scope, the computation does not change the broad output cell's id or declared
scope. Instead it writes a link to the narrower scoped result into the broad
output location.

This is how a broad document can keep the same link structure for every reader
while each reader follows that link to a different scoped instance.

The narrower scoped result is a separate storage instance for the same causal
id. The broader output document stores a scoped link to that instance rather
than copying the narrower value into the broader document.

This applies to auxiliary result cells created to represent structured or
captured reactive outputs as well as direct scalar outputs. Any intermediate or
result cell allocated for the computation must use the effective output scope,
defined as the narrower of the concrete result-schema scope and the narrowest
scope read by the computation; broader output locations then store links to that
scoped instance with the same causal id.

For handlers and for lifts that write into a passed-in cell, the passed-in
cell's scope is not changed. This is the explicit path by which data can move
from narrower scopes to wider scopes. The scope system itself permits this
write; CFC/IFC policy may still record or restrict the flow separately.

Transactions must track the narrowest scoped document read during a
computation so the runtime can decide whether the output value must be replaced
with a scoped link.

## Built-In Default Scope Rules

Built-ins may override the generic "narrowest input" default where their output
shape has stronger semantics.

| Built-in | Default output scope |
| --- | --- |
| `map` | Same scope as the input list. Each per-element invoked pattern result may be narrower, but the output array has the same cardinality as the input and is an input-list-scoped array of links to result cells. |
| `filter` | Narrowest scope of the inputs, because output cardinality depends on predicate results. |
| `flatMap` | Narrowest scope of the inputs, because output cardinality depends on callback results. |
| `ifElse` | Same scope as the condition. Branch values may be narrower links. The chosen link structure is condition-scoped; following the link can produce scoped data. |
| `when` / `unless` | Same scope as the condition. |
| `fetchJson` / `fetchProgram` / `streamData` | Narrowest scope of inputs. |
| `llm` / `llmDialog` / `generateText` / `generateObject` | Narrowest scope of inputs. |
| `compileAndRun` | Narrowest scope of inputs. |
| `str` | Narrowest scope of interpolation inputs. |
| `reduce` / `findIndex` | Narrowest scope of inputs. |
| `wish` | If result schema has a scope, that scope overrides and sets the narrowest allowed scope. Otherwise the result depends on the query: any query that resolves through home space is at least user scoped; arbitrary DID/current-space queries use the query/input-derived default in the first version. |
| `navigateTo` | Session scoped. Navigation is session state: invoking it changes the current memory session's navigation target only. The target cell may be any allowed scope, but the navigation effect and result cell are per-session. |

The `map` rule is intentionally different from `filter` and `flatMap`.
`map` preserves list cardinality, so the outer output list can stay in the input
list's scope while individual item result links point at narrower scoped
pattern-result cells. `filter` and `flatMap` change cardinality based on
potentially narrower data, so the output list itself must narrow.

## Metadata Links

Top-level metadata links such as `pattern`, `argument`, and `result`, plus the
links listed in the result cell's `internal` manifest, are system metadata used
for rehydration, debugging, and graph reconstruction. They are not normal user
data reads. Metadata/provenance traversal must always follow what is needed for
rehydration and must not be blocked by data-scope filtering.

Source/provenance links still carry and preserve scope because the referenced
source document can differ by scope. The exemption is only from normal data-read
filtering.

## Storage Model

Storage must add one effective scope key dimension to entity state lookup.
The logical field name is `scope_key`; a backend may map that name to a
different physical column only if its public storage/query API still exposes the
single `scope_key` dimension. The logical model is a single field rather than
independent `user_did` and `session_id` columns.

The entity instance key becomes conceptually:

```text
(branch, id, scope_key)
```

where:

- per-space data uses `scope_key = "space"`
- per-user data uses `scope_key = "user:<authenticated DID>"`
- per-session data uses
  `scope_key = "session:<authenticated DID>:<memory session id>"`

The memory session id must already be bound to a user. The same session id must
not be usable by another user, and the storage key still includes the
authenticated DID so storage isolation does not depend on caller-supplied
session ids being globally unique.

Commits already carry a memory session id; scoped storage must also have access
to the authenticated user DID. The system already requires a user DID
irrespective of this feature.

The serialized declared scope (`space`, `user`, `session`, `inherit`, or `any`
in schema positions) is distinct from `scope_key`. Declared scope is authoring
and traversal metadata. `scope_key` is the runtime storage address dimension.

## Migration And Compatibility

Existing documents and links with no scope metadata must behave as space
scoped unless a containing scoped context explicitly causes inheritance to a
narrower scope for newly created links or documents.

Cause-derived ids remain unchanged across the migration because scope is not
included in cause computation.

## Observability

When traversal declines to follow a link because the target link is narrower
than the schema's permitted minimum scope, log the decision at `info` level.
The runtime value remains `undefined`.

Debug output must include:

- containing link/address
- target declared scope
- schema-declared scope
- runtime effective scope key kind, without exposing unnecessary secret values

The first implementation does not add new CFC/IFC policy for explicit
narrower-to-wider writes. The scope system permits those writes according to
the target cell's scope. Existing CFC/IFC read/write tracking still applies, and
future policy work can use the scoped read/write evidence recorded by
transactions.

## Examples

### Per-Session Draft Under Per-User Settings

```ts
// Shown at module scope.
type Settings = PerUser<Writable<{
  theme: string;
  activeDraft: Cell<PerSession<Draft>>;
}>>;
```

The user-scoped settings document can contain the same `activeDraft` link across
sessions. Each session follows it to that session's draft instance.

### `map` Preserves Outer List Scope

```ts
// Shown inside a pattern body.
const results = items.map((item) => renderItem({ item, sessionContext }));
```

If `items` is user scoped and `sessionContext` is session scoped, the output
array is user scoped because it has one element per input item. Each element can
be a link to a session-scoped result cell from the invoked item pattern.

### `filter` Narrows Outer List Scope

```ts
// Shown inside a pattern body.
const visible = items.filter((item) => isVisibleInSession(item, sessionState));
```

If predicate behavior depends on session-scoped data, the filtered list is
session scoped because its cardinality differs per session.

### `ifElse` Keeps Condition Scope

```ts
// Shown inside a pattern body.
const selected = ifElse(condition, sharedLink, sessionLink);
```

The output scope is the condition scope. If the selected value is a narrower
link, following that stable output link resolves to data in the runtime scope.

### `navigateTo` Is Session State

```ts
// Shown at module scope.
navigateTo(piece);
```

The navigation target can be a space-, user-, or session-scoped cell. The
navigation state itself is session scoped, so another session does not inherit
the navigation change.

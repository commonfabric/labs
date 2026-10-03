# Streams as positions on their owner

**Status:** not started. Investigated against the tree at `ddb47bfaa`, the
stage-2 branch of
[Stream markers out of stored data](stream-markers-out-of-stored-data.md) as
merged into `main` by `2a34d6796` (2026-09-20); line references are to that
tree. A file is named by its path under `packages/` the first time and by its
basename after that (`runner.ts` is `packages/runner/src/runner.ts`,
`builder/pattern.ts` is `packages/runner/src/builder/pattern.ts`); `docs/`
paths are from the repository root.

**Summary.** A stream has no value, and its document holds only the `result`
back-link that setup writes onto it. Everything that carries an event is keyed
on a link's `(id, path, scope)` — the event sidecar's id, the memory server's
admission, the scheduler's handler table, the serving drain, and `send()`
itself — so no part of delivery needs the document. What the document supplies
is an address: an entity id a party can hold that names the stream — and,
through the back-link on that document, the owner. This plan stops writing the
document and puts the owner into the address instead: a stream its pattern
owns and exposes in its result is addressed as its result path on the owner's
result document, and one it owns but does not expose is addressed by a
`stream:` id over the owner's own hash, at a path naming its cause. Two
things the sibling plan builds toward then have nothing to do: the walk from
a stream's document to its owner, which its stage 3 adds, and the follow-up
it was written toward, a stream id that carries its owner. Here every stream's
address carries its owner.

The contract: **a stream is owned by the pattern whose handler node or
`stream()` root it is. One the owner exposes in its result is a position on
the owner's result document, addressed by the owner's id and its result path.
One the owner does not expose is addressed by `stream:` over the owner's
hash, at the path holding the hash of its cause. The owner's manifest lists
either under that cause; the schema at the position, or on the link that
names it, declares it; and no document exists for either.**

## What the runtime does today

### Where the document is born

- `handler()` creates a builder cell of kind `stream` for the event and binds
  it as the node's `$event` input (`packages/runner/src/builder/module.ts:250`,
  `:255`); `stream()` creates the same kind of cell for a user-declared stream
  (`packages/runner/src/builder/reactive.ts:81`).
- The builder collects every internal root and emits one
  `derivedInternalCells` descriptor per root, stamping the stream declaration
  onto a stream's schema (`builder/pattern.ts:477`). Each root is assigned a
  partial cause: its result key, or a node input key, where it has no name of
  its own (`builder/pattern.ts:300` through `:341`), otherwise an anonymous
  `{ $generated: N, $kind: "stream" }` (`builder/pattern.ts:377`).
- `getDerivedInternalCellLink` (`packages/runner/src/link-utils.ts:927`) is
  the single mint site — its comment says so — turning a descriptor into
  `createRef({}, { parent, type: "internal", cause })` at path `[]`: a fresh
  entity id for every stream. Both links that name a stream reach it through
  `unwrapOneLevelAndBindToDoc`
  (`packages/runner/src/pattern-binding.ts:639` through `:678`): the `$event`
  sigil in stored node inputs (`runner.ts:9049`) and the alias stored at the
  result field (`runner.ts:2994`).
- Setup materializes each descriptor (`runner.ts:3043`): the cell, a manifest
  entry on the owner, the `result` back-link on the new document, and a seeded
  default. For a stream, the document ends up holding the back-link and
  nothing else.

### What carries an event, and what it is keyed on

| Mechanism | Keyed on | Where |
| --- | --- | --- |
| `send()` | the resolved link's `(id, path)` | `packages/runner/src/cell.ts:1817` |
| The event sidecar's id | `hashStringOf({ id, path, scope })` | `packages/memory/v2.ts:412` |
| Admission of an append | the entry's link, and that it derives the sidecar being written | `packages/memory/v2/engine.ts:3233` through `:3259` |
| Delivery from another space | the same binding | `packages/memory/v2/server.ts:2869` |
| The scheduler's handler table | `areNormalizedLinksSame`: id, space, scope, path | `packages/runner/src/scheduler/events.ts:483` |
| The serving drain | `queueEvent(link, payload)` from the entry's link | `packages/runner/src/executor/space-server.ts:4082` |
| The HTML reconciler | `isStream(handle)`, then `send()` | `packages/html/src/worker/reconciler.ts:2282` |
| CFC | the sidecar's id class alone | `packages/runner/src/cfc/prepare.ts:2171` |

Admission never reads the stream's document: it checks the entry's link has an
id and a path and that `streamEntriesDocId(entry.stream)` is the sidecar the
commit writes. The memory server's own account of the sidecar
(`packages/memory/v2.ts:385`) already describes a stream as living "at a path
inside a piece's result doc", with one entries document per stream derived from
its link. The specification's "stream document" (`docs/specs/server-side-execution/events.md`
§1) is that sidecar; the runtime's back-link-only document is a second thing
under the same name.

### Who reads the document

- `ensurePieceRunning` strips the path from the link it is handed and follows
  `result` back-links to the owning piece
  (`packages/runner/src/ensure-piece-running.ts:172`, `:45`).
- `ownerStreamSchema` (`link-utils.ts:1041`) and the state inspector's
  `streamDeclarationOf` (`packages/state-inspector/model.ts:361`) walk from the
  document to the owner's manifest to learn that it is a stream — the sibling
  plan's stage 3 reading.
- The llm-dialog builtin's third way of typing an address
  (`packages/runner/src/builtins/llm-dialog.ts:2084`).
- The CLI's `isDocumentOf` and `resolveLinkedPiece`
  (`packages/cli/lib/piece.ts:2526`, `:2591`) test whether a document belongs
  to a piece; they are written over any owned document, not over streams.
- The runtime client serves `result` as a meta link on request
  (`packages/runtime-client/src/backends/runtime-processor.ts:1278`),
  generically.
- The inspector classifies the document as a `stream` entity; FUSE's
  `entities/` view projects it as an empty owned document.

The contract a caller is given already takes the shape this plan makes
universal:
[`docs/features/invoking-handlers-outside-a-pattern.md`](../features/invoking-handlers-outside-a-pattern.md)
says to take the piece cell, apply a schema declaring the handler property a
stream, and `key(name).send()`. The bare id is an internal address.

### Measured

Two probes, run against `ddb47bfaa`, become the tests stage 1 pins:

- A cell whose schema declares `bump` a stream, with `{ count: 0 }` written and
  nothing at `bump`. `key("bump")` reads as a stream; a handler registered on
  the link `(owner, ["bump"])` receives `send({ n: 1 })`; the owner's value is
  `{ count: 0 }` afterward and nothing is stored at `bump`.
- An id minted by `getDerivedInternalCellLink` from an owner and the cause
  `{ $generated: 0, $kind: "stream" }`, with nothing ever written for it, and
  a handle built from a link to it carrying `asCell: ["stream"]` on the link
  alone — a view handler's links as they are, minus the document. The handle
  reads as a stream; its document's value and `result` back-link are both
  `undefined`; a handler on that link receives `send({ n: 3 })`; nothing is
  written.

Neither needed a document, a manifest entry, or a back-link.

A census of real patterns, compiled from the same tree, says which kind is
which. All twenty streams across `packages/patterns/topics/main.tsx` and
`packages/patterns/topics/topic.tsx` sit at a result path.
`packages/patterns/lunch-poll/main.tsx` has eighteen: twelve at a result path,
and six that no result field reaches — every one an inline `onClick` written
inside an `ifElse` branch or a `map` body, declared `{ "asCell": ["stream"] }`
with no event type.

The same census shows the ownership line the runtime already draws. Two of
lunch-poll's twelve result-path streams, `joinAs` and `claimHost`, are
handlers of its nested participant-identity piece, returned from lunch-poll's
result (`main.tsx:2298`); lunch-poll has sixteen handler nodes for eighteen
stream descriptors. Their manifest entries carry `kind: "computed"` and
`computed:` ids: each is a computed cell whose value is a link to the nested
piece's stream, not a stream lunch-poll owns. And the owner's `internal`
manifest lists every stream the pattern does own, view handlers included:
lunch-poll's six `$generated` entries each name their document with a link
whose schema resolves to `{ "asCell": ["stream"] }`, beside the ten `bound*`
verbs. The stream's document, in both cases, holds only the back-link to the
owner; the `ifElse` output that holds a view handler's link is an ordinary
computed cell of the owner, with no result cell of its own.

## Design decisions

### 1. Ownership is the descriptor; exposure divides two kinds

A stream is owned by the pattern that created it: the pattern whose handler
node binds it as `$event`, or whose `stream()` call made it. The builder
records exactly that — a `derivedInternalCells` descriptor is emitted only for
a pattern's own internal roots, never for an external cell it received
(`builder/pattern.ts:453`) — so ownership is fixed at build time, whatever
later holds the stream's link. A stream a pattern *receives* and returns from
its result, the way lunch-poll returns its nested piece's `joinAs`, is not
that pattern's stream: it is a computed cell holding a link to the owner's
position, it keeps its document and its `computed:` id, and a send through it
resolves to the owner. `ensurePieceRunning` on such a link lands on the
owner, which is the piece whose graph registers the handler.

Among the streams a pattern owns, two kinds. A **verb** is one the owner
exposes in its result: in the result schema, enumerable there, reached by
`key(name)`, declared with an event type. A **view handler** is one it does
not — a handler written inline in a view that is an input to `ifElse`, `map`,
`when`, or `unless`, under any event prop and not only `onClick`; a stream
handed only to a nested pattern — reachable only through the link the view or
the argument holds. What makes one is that no result path of its owner
reaches it, whatever holds it. All twenty streams of the topics board and
topic patterns are verbs; lunch-poll's six inline `onClick` handlers are view
handlers, and they are exactly the ones a caller should not find listed as
verbs. Readers treat the two differently on purpose: a verb is found from the
result schema, and a view handler from the owner's manifest and nowhere else.

### 2. A verb's address is the owner's id and its result path

A verb is what a caller reaches: `Cell.key()` on the result cell yields the
position with the result schema's declaration on it, which is what the
feature document tells a caller to do, and every mechanism in the table above
already accepts a path. So a verb's address is the owner's `of:` id and its
result path — the owner is the id, and nothing has to be recovered from it.

The position is the stream's result path: `["bump"]` for a top-level field,
`["nested", "cancel"]` for one inside a result object, which is the path the
transformer already records in its `{ stream: [...] }` cause and the builder's
name assignment already picks as the stream's name (`builder/pattern.ts:308`).
A verb exposed at two result paths has the first as its position and the
second holds a link to it — the same shape as today, where both hold a link
to one document.

### 3. A view handler's address is `stream:` over the owner's hash, at the hash of its cause

```text
id:    stream:fid1:<the owner's own hash>
path:  [ hashStringOf(partialCause) ]
```

The body of the id is a hash — the owner's — so every parser of an id body
is untouched: `FabricHash.fromString`, the reference grammar's `readHead`,
which takes the identifier as it is, and the memory engine, which has no
scheme checks and treats an id as opaque outside the two prefix classes it
handles on purpose. The scheme is the whole novelty, and it is the one
`computed:` already established: `packages/runner/src/entity-kind.ts` reasons
about a kinded id and its `of:` sibling as two entities over one hash. Here
the relationship carries meaning — a `stream:` id's owner is its `of:`
sibling — so the owner is read off the id with no walk and nothing stored,
which is what auto-start needs (Risks, first item). The server tells a stream
from a piece by scheme alone, which a schema-less sidecar entry needs, and the
serving loop's never-a-piece exclusion (`space-server.ts:447`) names `stream:`
outright instead of retrying a documentless `of:` id.

The path segment is the hash of the stream's partial cause, `hashStringOf`
over the same value the manifest is keyed by. It is canonical — records hash
key-order-insensitively — unique within the manifest by the builder's own
guarantee, and stable exactly when the manifest match is stable, which is
exactly as stable as a stream's id is today, since the cause has always been
in the id's preimage. A named cause moves only when its author renames it,
and a segment naming a cause that no longer exists names nothing, so a stale
sidecar entry is refused. A `$generated` cause is a position among the
pattern's anonymous cells: an update that adds one ahead of it renumbers it,
its address and sidecar move with it, and its old cause can be handed to the
handler that now holds that number — which is what happens to its id today
under the same edit. The manifest's array index would be worse in degree, not
in kind: it is rebuilt in descriptor order on every setup (`runner.ts:3060`)
and matched by cause and kind, never by position (`runner.ts:3068`), so it
shifts on any descriptor inserted ahead, value cells included. A reader
holding the owner finds the entry by hashing each entry's cause; the manifest
is small.

Separation from the result namespace is by scheme, so nothing is reserved:
`(stream:fid1:X, [segment])` cannot equal a position on `of:fid1:X`, whatever
a pattern names its result fields. Every link that names a view handler
carries its declaration (`includeSchema: true` at `pattern-binding.ts:677`);
the sidecar entry's link, `{ id, path, scope }` (`packages/memory/v2.ts:406`),
does not, and needs nothing beyond the scheme.

### 4. Nothing is stored at a stream's position, and no document is written

The result projection resolves a verb's alias to a link at the verb's own
position and writes nothing there: a reference to the position itself is a
self-alias, which `resolveCellAlias` already drops (`builder/pattern.ts:498`).
The sibling plan's stage 1 made every declared stream position read as a
handle whether or not the data names it, with `required` exempting such
positions, so absence is the correct stored form. Setup writes no document and
no back-link for a stream of either kind. It keeps the manifest entry, with
the link naming the new address: the owner's manifest stays the
schema-bearing list of every stream the pattern owns, readable by anyone who
starts from the owner, without any view handler becoming a verb.

### 5. One mint, no flag

The address is minted in one place, `getDerivedInternalCellLink`: from the
owner's id and the result path for a verb, from the owner's hash and the
hashed cause for a view handler. Two mints for one kind coexisting behind a
flag would put one stream at two addresses with two sidecars, which is the
compatibility problem this repository has been removing. The change is a
cutover for both kinds; its cost is stated under stage 3.

## Stages

### Stage 1 — Address and materialization

- [ ] `stream` joins `EntityKind` and `ENTITY_URI_SCHEMES` in
      `entity-kind.ts`, with `entityKindOfIdString` and
      `uriSchemeForEntityKind` extended; `hashStringForEntityAddress` refuses
      it as it refuses `computed:`, since a view handler is not addressable by
      bare hash.
- [ ] The builder marks each verb's descriptor with its result path under
      decision 2; a view handler's descriptor is unchanged.
- [ ] `getDerivedInternalCellLink` returns `(owner id, result path)` for a
      verb's descriptor and `(stream: over the owner's hash,
      [hashStringOf(cause)])` for a view handler's, with the declared schema
      on the link; value-holding internal cells, and a computed cell that
      forwards another piece's stream, are unchanged. The descriptor's `kind`
      is not assigned to a stream the pattern owns.
- [ ] `#materializeDerivedInternalCells` writes a stream's manifest entry,
      naming the position, and nothing else: no document, no default, no
      back-link.
- [ ] The result projection omits a verb at its own position and stores a
      link at any second position.
- [ ] The `$event` sigil names the position for either kind.
      `#handlerStreamLink` (`runner.ts:9628`) parses it as it does now; the
      dispatch assertion the sibling plan's stage 3 adds reads the same link's
      schema.
- [ ] Tests: the two measured cases above, as pinned tests, the second over a
      `stream:` id; a send through the result key with nothing stored reaches
      the handler and writes nothing into the owner; a send through a
      `stream:` position with the declaration on the link does the same; a
      verb's sidecar id derives from its position and a view handler's from
      its `stream:` id and segment; a redirect-flagged link and a plain link
      to one position match in the handler table, which
      `areNormalizedLinksSame` compares by id, space, scope, and path
      (`packages/memory/v2.ts:402`); a `stream:` address round-trips through
      `parseCellReference`; a segment naming no manifest entry resolves to
      nothing.
- [ ] `when`, `unless`, `ifElse`, and `.map` into a nested pattern forward a
      link that names a position; `stream-declaration.test.ts` passes with its
      addresses updated.

### Stage 2 — Readers

- [ ] `ensurePieceRunning` reaches either kind's owner in zero hops: a verb's
      link id is the result document, and a view handler's `stream:` id names
      its owner as its `of:` sibling. The back-link chain stays for a nested
      piece's result document, which is a derived internal cell of its
      parent, and for a computed forwarder. The serving loop's never-a-piece
      exclusion (`packages/runner/src/executor/space-server.ts:447`) names
      `stream:` and maps it to the owner rather than excluding it. Test: a
      sidecar whose link is `(result, path)` starts the piece; one naming a
      `stream:` id starts the piece with no client watching it; one on a
      nested piece's result still starts the root.
- [ ] Delete `ownerStreamSchema`, `streamDeclarationOf`, the inspector detail
      view's manifest reading, and the llm-dialog builtin's third way of
      typing an address; its second way — the result schema at the path —
      becomes the one that answers for a bare address. The sibling plan's
      stage 3 wiring of the owner walk into `Cell.isStream` and the proxy is
      withdrawn.
- [ ] The state inspector classifies a stream as a position on a piece, from
      the piece's result schema; the `stream` entity kind stops naming a
      document. `entities.test.ts` and `html.test.ts` rewrite their stream
      fixtures.
- [ ] The sibling plan's deferred FUSE item — the `entities/` projection of a
      bare stream document — closes as moot.
- [ ] The CLI's ownership tests are pinned over a stream position: a position
      is `path.length > 0` and is reported as a cell inside a piece, which is
      the right answer.
- [ ] The runtime client needs no change; its sidecar ids derive from the
      link.

### Stage 3 — Identity cutover and documents

- [ ] Every stream's sidecar id changes with its address. Before a served
      space cuts over, its sidecars drain; an entry still in flight afterward
      names a stream nothing fires at. Pieces set up before the cutover heal
      by running — setup re-emits every stream's links on a pattern update, a
      same-pattern restart, and a fresh session — so there is no migration
      pass. The sibling plan's stage 3 records the same choice for its own
      cutover.
- [ ] Documents: the streams section and the unification note of
      `docs/specs/space-model/2-storage-format.md`; the stream cells section of
      `docs/specs/space-model/4-cells.md`, which locates a stream's identity in
      its document; the events diagram and the persisted-state list of
      `docs/specs/space-model/6-reactivity.md`; the `$kind: "stream"` preimage
      and the visible-scheme non-goal of `docs/specs/computed-cell-identity.md`;
      the terminology comment at the head of `entity-kind.ts`; the wording of
      `events.md` §1, so that "stream document" names only the sidecar.
- [ ] `$kind: "stream"` and `{ stream: [...] }` causes are still minted, for
      naming and for the manifest key. No stream's id preimage carries its
      cause: a verb's id is its owner's, and a view handler's is its owner's
      hash under another scheme, with the cause's hash in the path.

## Testing

- A handler node instantiates against a `$event` link naming a position, with
  nothing stored at the position, and fires on a send through the result key.
- A send through a link to a view handler's `stream:` position, with nothing
  ever written for it and the declaration on the link, fires the handler and
  writes nothing.
- A view handler's sidecar entry carries no schema and still routes: the drain
  rebuilds the link from the entry and the handler registered on that position
  receives the event.
- A stream a pattern returns from a nested piece's result stays a computed
  cell holding a link to the nested piece's position; a send through it fires
  the nested piece's handler, and `ensurePieceRunning` on it lands on the
  nested piece.
- A stream exposed at two result fields: the second field holds a link to the
  first, and a send through either fires once.
- A nested pattern receiving a parent's stream as an argument holds a link to
  the parent's position, and a send through it fires the parent's handler.
- `ensurePieceRunning` on a sidecar link naming a position starts the owner;
  on one naming a nested piece's position, starts the root.
- The inspector classifies a declared position as a stream with no document
  behind it, and reports no `stream` entity.
- A view handler's event drained while its piece is parked and no client
  watches it starts the piece from the `stream:` id alone and is delivered.
- A sidecar entry whose segment names no manifest entry is refused, and never
  delivered to another stream.
- A stale stored link that declares nothing refuses loudly at dispatch (the
  sibling plan's assertion) rather than writing into the result document.

## Risks

- **Authorization keyed on the stream's document.** None was found: admission
  binds link to sidecar, CFC special-cases the sidecar's id class, and
  `send()`'s read marks its crossings on the resolved link, which becomes the
  result document's. A survey is not a proof; a CFC owner confirms before
  stage 1 lands.
- **A value write through a stale link.** A stored link that names a position
  and declares nothing turns a `send()` into a write, and that write now
  lands in the result document rather than in a stream's own document. The
  dispatch assertion and `isStream` gating are what stand between such a link
  and the write; the sibling plan's Risks section names the same failure.
- **Renaming a result field re-identifies its stream.** Transformer-authored
  streams already carry their result path in the cause, so nothing is lost
  there; a hand-named stream moved between fields gets a new sidecar.
- **Entries in flight at the cutover.** A sidecar keyed on the old address is
  orphaned; the drain condition in stage 3 is what prevents it.
- **Auto-start needs the owner in the address.** When a drained event finds
  no handler registered — the piece is parked, and no client watches it —
  `queueEvent` reserves the event's queue slot and calls
  `ensurePieceRunningVerdict` on the event link to start the piece
  (`packages/runner/src/scheduler/events.ts:729`). Today that walks the stream
  document's back-link. With no document, a bare `of:` id would resolve to no
  pattern meta; a served event is then deferred, re-drained each wave, and
  hardened into a drop notice once the deferral budget is spent
  (`events.ts:800` through `:820`) — a click that changed state for others,
  fired just before its sender disconnected, would be lost. The `stream:` id
  is what closes this: the owner is its `of:` sibling, and the start needs
  nothing stored. This item is the reason decision 3 takes the form it does.
- **A renumbered generated cause reassigns a view handler's address.** A
  pattern update that inserts an anonymous cell ahead of a view handler
  renumbers its `$generated` cause; the handler that now holds the old number
  inherits the old address, and a sidecar entry still pending under it would
  be delivered there. This is today's behavior for the same edit, since the
  cause is in the id's preimage now, and this plan neither adds to it nor
  removes it. A pattern update does not drain a piece's sidecars first:
  `setsrc`, client or served (`packages/piece/src/ops/served-lifecycle.ts:785`
  through `piece-controller.ts:4745`), writes the transition and the pattern
  pointer, and the running piece's pointer watcher swaps the graph —
  `swapToPattern` (`runner.ts:4611`) runs setup, then retires the old nodes
  and instantiates the new ones — reading no sidecar and waiting on no queue.
  An entry pending across that swap is handled when next drained: one whose
  address a renumbered handler now holds is delivered to that handler, and
  one whose address nothing holds is dropped by the no-handler predicate for
  a piece that is running with its graph installed (`events.ts:770` through
  `:782`). The durable repair is a generated cause derived from the
  handler's content rather than its position, which is a follow-up outside
  this plan. The manifest's array index would widen the trigger to any
  inserted descriptor; decision 3 states the difference.
- **The stage-1 exemptions this rests on.** Absence at a declared position is
  a handle only because the sibling plan's stage 1 made every read path treat
  it so, `required` included. Those exemptions are load-bearing here.

## Ordering

The sibling plan's stage 3 lands first, without the wiring of the owner walk
into `Cell.isStream` and the proxy: the value-branch deletion, the dispatch
assertion, `detectCallableKind`, and the fixture rewrites are all needed here
and are cheaper to land on their own. This plan then removes the walk that
stage built the reading for.

## Not in scope

- Unifying streams with value cells, which
  `docs/specs/space-model/2-storage-format.md` floats.
- The sidecar's format, the watermark, or any part of the events protocol.
- The stored sentinel; the sibling plan retires it.
- Putting verbs under the `stream:` scheme: a verb's position on the result
  document is what `key(name)` reaches with the result schema's declaration,
  and the scheme is for the streams no result path reaches.
- An `owner` field on the sidecar entry. The `stream:` id carries the owner,
  so the entry shape of `events.md` §1 and its one derivation stay as they
  are.

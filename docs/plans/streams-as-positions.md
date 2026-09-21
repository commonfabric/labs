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
is an address: an entity id a party can hold that names the stream. This plan
replaces that address with a path on the owner's result document — a stream
exposed in the result is addressed as its result path, and one that is not by
a synthetic path only its links carry — and stops writing the document.
Two things the sibling plan builds toward then have nothing to do: the walk
from a stream's document to its owner, which its stage 3 adds, and the
follow-up it was written toward, a stream id that carries its owner. Here the
owner is the id.

The contract: **a stream is a position on its owner's result document. Its
address is the owner's id and a path; the schema at that position, or on the
link that names it, declares it; and no document exists for it.**

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
- A cell whose schema declares nothing at `["$streams", "generated-3"]`, and a
  handle built from a link to that path carrying `asCell: ["stream"]` on the
  link alone — the shape of a stored sigil link. The handle reads as a stream;
  a handler on that link receives `send({ n: 2 })`; nothing is written.

Neither needed a document, a manifest entry, or a back-link.

## Design decisions

### 1. The address is the owner's id and a path

The alternative is a visible `stream:` entity scheme, which
`docs/specs/computed-cell-identity.md` leaves open and
`packages/runner/src/entity-kind.ts:25` declines. A kinded id still has to
give the owner back to whoever holds it, so it needs either a walk or a
structured id a reader can take apart; a path names the owner outright, and
every mechanism in the table above already accepts one. `Cell.key()` on the
result cell then yields the position with the result schema's declaration on
it, which is what the feature document tells a caller to do.

### 2. A result path is its own position; every other stream gets a synthetic one

The builder's name assignment already picks a stream's first result key as its
name (`builder/pattern.ts:308`), and `getStableInternalPathSegment`
(`link-utils.ts:955`) already turns a `{ stream: [...] }` cause into a
`stream:<path>` segment and a generated cause into a string. The position
rule follows from those:

- A stream that sits in the result is addressed as its result path: `["bump"]`
  for a top-level field, `["nested", "cancel"]` for one inside a result
  object, which is the path the transformer already records in its
  `{ stream: [...] }` cause. A stream exposed at two result paths has the
  first as its position and the second holds a link to it — the same shape as
  today, where both hold a link to one document.
- Every other stream — a handler bound only into a view, a stream handed only
  to a nested pattern — is addressed as `["$streams", <segment>]`, with the
  segment from `getStableInternalPathSegment` over its partial cause. The
  prefix is a convention that makes a synthetic path legible as one, not a
  reservation. A generated cause's segment is stable within a build and moves
  when the pattern's stream count changes, which is what its id does today.

The path is an address and nothing more: the builder writes nothing at a
stream's position, and nothing about the position is stored. The result
schema describes a result-path position; a synthetic position it does not
describe, so the link that names one carries the declaration, as the second
probe exercises and as a stored sigil link already does (`includeSchema:
true` at `pattern-binding.ts:677`).

Two kinds of stream follow, and readers treat them differently on purpose. A
**verb** is a result-path stream: in the result schema, enumerable there,
reached by `key(name)`, declared with an event type. A **view handler** is
reachable only through the view that embeds it: a routing key every party
derives the same way, carried on the link and in no schema, never stored and
never required. All twenty streams of the topics board and topic patterns are
verbs; the lunch-poll pattern's six inline `onClick` handlers, written inside
`ifElse` branches and `map` bodies, are view handlers, and they are exactly
the ones a caller should not find listed as verbs.

Nothing is reserved. A link's schema says what it addresses: a link to
`["$streams", "x"]` carrying `asCell: ["stream"]` is a stream to `send()`,
and one carrying the field's own schema is a value to `set()`. So a pattern
that returns data at `$streams` and a view handler with the same segment
coexist — a reader sees the data through the result schema, a sender sees
the stream through the link schema, and neither sees the other, which is how
every position already decides its handle kind. What the builder prevents is
two *streams* at one path: it assigns synthetic segments knowing every result
path a stream has, the way it assigns causes knowing every name in use. Data
that shares a path with a view handler has one cost, stated under Risks.

### 3. Nothing is stored at a stream's position

The result projection resolves a stream's alias to a link at the stream's own
position and writes nothing there: a reference to the position itself is a
self-alias, which `resolveCellAlias` already drops (`builder/pattern.ts:498`).
The sibling plan's stage 1 made every declared stream position read as a
handle whether or not the data names it, with `required` exempting such
positions, so absence is the correct stored form. Setup writes no document, no
manifest entry, and no back-link for a stream.

### 4. One mint, no flag

The address is minted in one place. Two mints coexisting behind a flag would
put one stream at two addresses with two sidecars, which is the compatibility
problem this repository has been removing. The change is a cutover; its cost
is stated under stage 3.

## Stages

### Stage 1 — Address and materialization

- [ ] The builder assigns each stream a position under decision 2 and carries
      it on the descriptor. A synthetic position equals no stream's result
      path.
- [ ] `getDerivedInternalCellLink` returns `(result id, position)` for a
      stream descriptor, with the declared schema on the link; value-holding
      internal cells are unchanged. The descriptor's `kind` is not assigned to
      a stream.
- [ ] `#materializeDerivedInternalCells` materializes nothing for a stream.
- [ ] The result projection omits a stream at its own position and stores a
      link at any second position.
- [ ] The `$event` sigil names the position. `#handlerStreamLink`
      (`runner.ts:9628`) parses it as it does now; the dispatch assertion the
      sibling plan's stage 3 adds reads the same link's schema.
- [ ] Tests: the two measured cases above, as pinned tests; a send through
      the result key with nothing stored reaches the handler and writes
      nothing into the owner; a send through a `$streams` position does the
      same; the sidecar id derives from the position; a redirect-flagged link
      and a plain link to one position match in the handler table, which
      `areNormalizedLinksSame` compares by id, space, scope, and path
      (`packages/memory/v2.ts:402`).
- [ ] `when`, `unless`, `ifElse`, and `.map` into a nested pattern forward a
      link that names a position; `stream-declaration.test.ts` passes with its
      addresses updated.

### Stage 2 — Readers

- [ ] `ensurePieceRunning` reaches a stream's owner in zero hops: the link's
      id is the result document. The back-link chain stays for a nested
      piece's result document, which is a derived internal cell of its parent.
      Test: a sidecar whose link is `(result, path)` starts the piece; one on a
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
      naming and for the segment; no id preimage carries them.

## Testing

- A handler node instantiates against a `$event` link naming a position, with
  nothing stored at the position, and fires on a send through the result key.
- A send through a link to a `$streams` position, carrying the declaration on
  the link, fires the handler and writes nothing.
- A stream exposed at two result fields: the second field holds a link to the
  first, and a send through either fires once.
- A nested pattern receiving a parent's stream as an argument holds a link to
  the parent's position, and a send through it fires the parent's handler.
- `ensurePieceRunning` on a sidecar link naming a position starts the owner;
  on one naming a nested piece's position, starts the root.
- The inspector classifies a declared position as a stream with no document
  behind it, and reports no `stream` entity.
- A pattern that returns data at `$streams` beside a view handler with the
  same segment: the data reads through the result schema, the send reaches
  the handler, and neither disturbs the other.
- Two streams are never assigned one path: a view handler's segment is chosen
  past every result path a stream has.
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
- **Data at a view handler's path.** The builder writes nothing at a
  synthetic position, but a pattern may return data at the same path. A
  `send()` then resolves through that data to see whether a stored link is
  there to follow — a read under the write-destination meta that, in the
  normal case, finds nothing stored. Whether the co-located data's label can
  reach the event through that read is for CFC to confirm. The link stays the
  only carrier of the position's declaration, which the second probe
  exercises and stage 1 pins.
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
- A `stream:` entity scheme; decision 1 declines it.

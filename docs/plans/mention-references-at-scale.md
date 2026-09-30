# Mention references at scale

_What `#42` costs when a collection has a thousand members, or a million, and
the three separable concerns hiding behind one static array._

**Status:** Proposed. Nothing under "Options" is built, and the questions at the
end are unanswered · **Updated:** 2026-09-20

Typing `#42` in a piece's body inserts a mention of member 42 of the collection
that piece is read through.
[Naming in collections](../specs/collection-naming.md) defines what such a
reference means, how it is stored, and how a spelling is chosen for it. This
document is about the mechanism underneath: today the editor completes and
renders a mention out of a static array of every candidate, handed to the piece
in advance, and that array is the whole design.

Everything below that describes current behavior comes from reading the code,
and cites where. Where a question could only be settled by running something, it
says so instead of guessing.

## The problem

A collection's mention universe is one derived document holding one row per
member, and every member's editor reads all of it. `mentionableIndex`
(`packages/patterns/collection-naming/mentionable.ts`) derives it with
`mentionableRowsOf`, which pushes one `MentionableRow` per member — a display
name, a title, the collection's short name for the member, and the member itself
as a reference. The Topics board derives one for the whole board
(`const mentionable = mentionableIndex({ members: topics })`,
`packages/patterns/topics/main.tsx`) and hands the same cell to every topic it
creates — `addTopic`'s `createNamed` call and `submitProfileTopic`'s, both in
`main.tsx`.

That design is deliberate and it is the right one against the alternative it
replaced. `packages/patterns/topics/README.md` states the reasoning: whatever
`mentionable` is wired to is multiplied by the number of members reading it, so
one document of copies bounds the product where a list of the members themselves
would not. What it does not bound is the document.

Four costs follow, three of them linear in the member count and the fourth a
correctness consequence.

### The universe document grows with the collection

Each row carries four fields, one of which is a reference. A collection with a
million members derives a document with a million rows, and every member's
editor loads it to complete one mention.

[#7805](https://github.com/commonfabric/labs/issues/7805) measured the closest
shape on the Topics board itself: "one board table of values, member finds its
own row" delivered **0** other members' documents but grew to **404 KB at a
thousand members**. The mention universe is that arm — a board-level table of
copies, read by each member — so its delivery cost is the same shape, and the
number to carry forward is that the bytes are linear with no other document
fetched. A table of that shape is a few hundred kilobytes at a thousand members
and, extrapolated, hundreds of megabytes at a million. The transport has an
opinion about the upper end: a comment in
`packages/toolshed/routes/storage/memory/memory.handlers.ts` records that
"Deno's WebSocket client rejects a wire frame over 64 MiB ('Frame too large')".

This document does not re-measure. #7805's numbers are the constraint the design
has to live inside, and its guidance question — "what may a member read of its
container without loading its siblings?" — is the same question asked from the
container's side.

### Resolving the rows costs one client round trip per row

The row's `piece` position carries no usable handle across the client boundary.
`MentionableSchema` declares it as an object with no properties, marked `asCell`
(`packages/runner/src/component-read-contract.ts`), and `Mentionable.piece`
(`packages/ui/src/v2/core/mentionable.ts`) states the consequence: a reader
"detects a row by this key's presence and reaches the piece by ADDRESS —
`entry.key("piece").resolveAsCell()` — never through the value."

So the editor resolves every row. `_resolvePieceIds`
(`packages/ui/src/v2/components/cf-code-editor/cf-code-editor.ts`) maps over the
whole array and awaits `source.resolveAsCell()` for each entry. On a
`CellHandle` that is not a local call: `resolveAsCell` issues a
`RequestType.CellResolveAsCell` request over the client-to-runtime connection
and awaits the response (`packages/runtime-client/src/cell-handle.ts`). The pass
runs whenever the universe binds or changes — `_setupMentionableSubscription`,
and the `updated()` branch that rebinds `mentionable` under
`MentionableArraySchema`.

A thousand members is a thousand requests to open one editor. A million is a
million.

### Every keystroke scans the whole array

Both completion sources are synchronous functions over the materialized array.
`getFilteredMentionable` loops the full array testing `[NAME]` and the short
name; `_matchingShortNames` loops it testing the short name;
`_hasUnresolvedIndexRowFor` loops it again. All three are in
`cf-code-editor.ts`. They are registered as the two `override` entries of the
editor's `autocompletion({ … })` extension and run per query, which is per
keystroke inside a `#` or `[[` token.

`_universeShortNames` adds a fourth scan, over the array and then over the
document's mentions, each time the short names are republished (both in
`cf-code-editor.ts`).

At a thousand rows these scans are cheap. They are named here because they are
the part of the cost a dynamic query would remove for free, not because they are
the binding constraint.

### A bounded universe silently takes names off pills

This is the reason the first three cannot be fixed by simply publishing fewer
rows.

The universe is not only the completion source. It is the **only** path by which
a mention's pill gets a short name. `_universeShortNames` builds a map from each
resolved row's cell identity to that row's `shortName`, then walks the
document's mentions and gives a name only to a mention whose destination appears
in that map (`cf-code-editor.ts`). A destination no row stands for gets no name,
which
[the spec states as the rule](../specs/collection-naming.md#the-name-a-member-publishes):
"A destination the universe does not list shows no name, whatever it publishes."

That rule was written for a destination outside the collection. Bound the
universe and it applies to members of the collection too: every mention of a
member outside the bound loses its number, with nothing in the document changed
and nothing said to the reader.

## What exists today

### Authoring a mention

A mention takes one of two forms in the text, and the editor mints the second
whenever the host pattern gives it a `$references` cell
(`packages/ui/src/v2/components/cf-code-editor/docs/mention-refs.md`).

The wiki-link form, `[[Name (id)]]`, carries the destination's id inside the
sentence. The reference form, `[Label][a3f9zz]`, carries a six-character key
local to the document, and the destination lives in a map the host pattern owns.
`MentionRef` holds exactly two fields — `destination: unknown` and
`modifiedTitle: boolean` — and `MentionRefMap` is `Record<string, MentionRef>`
(`packages/ui/src/v2/core/mention-refs.ts`). The stored destination is a cell
reference: `MentionRefSchema` declares it as an object with no properties,
marked `asCell` (`packages/runner/src/component-read-contract.ts`).

**A stored mention holds the destination and nothing else.** Not the collection
it was cited through, not the member name that was typed, not the label — the
label is the document's own text. That is what
[the spec's Storage rule](../specs/collection-naming.md#storage) asks for:
"References canonicalize on write… Canonicalizing to the identity rather than to
a qualified name is the safe default."

Three consequences of the current authoring path matter to any redesign:

- **A token is a mention when the map holds its key**, not when it looks like
  one (`mention-refs.md`, "Membership, not shape, decides"). A `#42` that was
  typed and never completed is ordinary text and stays ordinary text.
- **Nothing scans prose for citations.** A pasted `#42` is never turned into a
  mention, and `mention-refs.md` gives the reason: `#42` names a member of
  whichever collection is being read through, so resolving it later would
  resolve it in whatever context the text ended up in.
- **A completion whose destination has not resolved mints a wiki-link instead.**
  `_insertMentionOf` (`cf-code-editor.ts`) falls back because
  `mentionable.key(index)` addresses a position in a list, and a mention
  persisted against that path would later name whatever moved into the slot. So
  the reference form is available only for a row the O(N) resolution pass has
  already reached.

### Rendering a mention

The pill's short name comes from the universe, by identity, as described above.
`shortNameOf(entry)` returns `entry.shortName` (`cf-code-editor.ts`), and
`_isIndexRow(index)` decides what an entry is by `Object.hasOwn(item, "piece")`
(`cf-code-editor.ts`).

[#7771](https://github.com/commonfabric/labs/issues/7771) is a defect in that
pair, and this design does not re-derive it. Its finding: `shortNameOf` returns
`entry.shortName` for a row and a piece alike, so where the universe is a
collection's raw member list rather than derived rows, an entry **is** the
destination and the name the destination publishes for itself reaches both the
`#<n>` query and the pill — which the spec forbids. Its recorded cost: Topics
gated what a topic _publishes_ rather than gating the displays, because that was
the only place covering every reader, so a topic's published number is now a
display switch rather than a statement about the topic.

The relationship to this design is narrow and worth stating rather than
assuming. #7771 is about a universe that is a raw list; every option below
changes what a universe _is_ or removes it, and none of them makes a raw-list
universe read correctly. #7771 should be fixed on its own terms, and its fix —
an entry that is the destination contributes no short name — holds under every
option here.

One further fact about rendering, which changes what "resolution for display"
currently costs: **there is no renderer outside the editor.** Both the
collection-naming exemplar and Topics render a saved body with
`<cf-markdown content={body} />` and switch to `cf-code-editor` only while
editing — the `editingBody` branch in each
(`packages/patterns/collection-naming/item.tsx`,
`packages/patterns/topics/topic.tsx`). Notes is the exception: its `editorUI` is
the editor (`packages/patterns/notes/note.tsx`). So a pill exists only inside an
open editor, and a reader of a saved topic sees the raw `[Label][key]` text.
Resolution-for-display outside the editor is not expensive today; it is unbuilt.

### Completing a mention

`$mentionable` is the universe cell. Its contract is `Mentionable`
(`packages/ui/src/v2/core/mentionable.ts`): a required `[NAME]`, an optional
`piece` whose presence makes the entry a derived row rather than the piece
itself, and an optional `shortName` — "the name the collection that owns this
member calls it by". `docs/common/conventions/mentionable.md` is the
pattern-author-facing contract, including the reserved `piece` key.

Two triggers share one `autocompletion` extension. `[[` opens a query over
display names and short names together (`createBacklinkCompletionSource`); `#`
followed by at least one digit opens one over short names alone
(`createShortNameCompletionSource`). The `#` match is a **prefix** rather than a
substring, because a member name is a number and `4` offering `42` beside `14`
buries the one being typed (`shortNameMatches`, `cf-code-editor.ts`).

Both sources are declared to take a `CompletionContext` and return a
`CompletionResult` or `null` — synchronous, reading `this.mentionable.get()`.
CodeMirror's own `CompletionSource` admits a promise of that result as a third
arm (`@codemirror/autocomplete` 6.20.3), so asynchrony is available at the
extension level and simply is not used.

`cf-prompt-input` consumes the same contract through `MentionController`, whose
`getFilteredMentions` also scans the whole array
(`packages/ui/src/v2/core/mention-controller.ts`). It does not run the per-row
resolution pass, so the round-trip cost is `cf-code-editor`'s alone.

### What dynamic lookup already exists

**`wish` cannot answer a prefix query, and is not reachable from a component.**

`wish({ query, scope, … })` classifies its query in `getResolutionKind`. A query
matching no well-known target — `#default`, `#mentionable`, `#favorites`,
`#profile` and the rest — falls through to `hashtag-search`, implemented by
`searchByHashtag`. Both, and every symbol named below, are in
`packages/runner/src/builtins/wish.ts`. Three facts about it decide its
usefulness here:

- **The match is exact, not prefix.** `tagMatchesHashtag` tests
  `extractHashtags(tag).includes(searchTermWithoutHash)`, and
  `searchMentionablesForHashtag` adds an exact `[NAME]` comparison. The one
  substring form is the legacy `#favorites/<term>` path in
  `resolveHomeSpaceTarget`, which returns only the first match.
- **Its candidate set is a JS filter over a whole pre-materialized list** —
  favorites, the space's `mentionable` list, or profile elements —
  `searchFavoritesForHashtag`, `searchMentionablesForHashtag` and
  `searchProfileForHashtag` each load their whole list with `.get()` and filter
  it in process. There is no predicate pushed down to storage, and no parameter
  that narrows the search term beyond `query` itself.
- **It is pattern-only.** `wish` is exported through the builder surface
  (`packages/runner/src/builder/built-in.ts`) and registered as a scheduler
  builtin (`packages/runner/src/builtins/index.ts`). `packages/ui` contains no
  call to it; the only hits are a comment in `_setupMentionableSubscription`
  (`packages/ui/src/v2/core/mention-controller.ts`) about consuming cells a
  pattern's wish produced, and prose in
  `packages/ui/docs/mentionable-internals.md`.

`wish` is reactive and debounced (`WISH_DEBOUNCE_MS = 50`,
`packages/runner/src/builtins/index.ts`), so a pattern _could_ drive one from a
query cell that changes per keystroke. What it would answer is "pieces exactly
tagged `#foo`", not "members whose name begins with `4`".

**`slug:resolve` is a working keyed lookup, and it is the shape option C
needs.** `RuntimeClient.resolveSlug(slug, space, member)` issues a
`RequestType.SlugResolve` request and returns either the piece and the path the
walk did not spend, or a typed refusal
(`packages/runtime-client/src/runtime-client.ts`). The refusal is data rather
than an error, deliberately: "a name nobody bound, a member a collection does
not hold… answer the question asked". It is served by `handleSlugResolve`
(`packages/runtime-client/src/backends/runtime-processor.ts`) over
`resolveSlugReference` (`packages/runner/src/slug-resolution.ts`), and the shell
already calls it for page URLs, from `AppView`
(`packages/shell/src/views/AppView.ts`) through `resolveSlug` on `lib-shell`'s
runtime (`packages/lib-shell/src/runtime.ts`).

It takes **one member name, never a path**, and the request type says why: "A
member's own fields are addressed inside the piece it resolves to."

### What a keyed lookup costs

`docs/features/collection-indexes.md` describes `keyBy`/`groupBy` and
`lookup(key)`: "`lookup(key)` observes one bucket… Lookup does not read that
enumeration or scan the source collection."

#7805 establishes that this is a statement about the **read**, not about
delivery: "A keyed index does not narrow what is delivered… The request a start
sends declares the whole descriptor, so every bucket is selected and every
reference in every bucket is followed." Its measurement: a board-level index
keyed by member, with the member reading its own bucket, delivered **199 other
members' documents (7.5 MB) at N = 200**.

So an index is not a way out of the universe's delivery cost, and a prefix query
is not a key lookup in any case: `#4` asks for every name beginning with `4`,
which a `keyBy` index answers only through `keys()` — the separate enumeration,
"O(K log K) work" over every occupied key (`collection-indexes.md`, "Work and
limitations").

### What resolution by name costs

A collection's namespace is one map cell on the collection holding one key per
name, "written one key at a time" — the module comment on
`packages/patterns/collection-naming/naming.ts` states the shape and the
allocation rule together. `resolveSlugReference`
(`packages/runner/src/slug-resolution.ts`) resolves `top/42` against it as
follows: sync the slug document and parse its redirect (`resolveSlugTargetCell`,
`packages/runner/src/slug-resolution.ts`); `followAndLoad` the target to reach
the map; read the single key `map.key(member)`; `followAndLoad` that member's
own link chain.

**It is a single-key read, not a scan.** The map's other keys are never read,
and no other member's document is followed. What it is not is free of N: the map
is one document holding one entry per named member, and `followAndLoad` syncs
that document whole. So the cost is three documents plus the member's link
chain, one of those three linear in the collection's size.

That linear document is the same shape as the universe, one field wide instead
of four. Whether a namespace map of a million links is transferable at all is a
question #7805's arms do not cover and this document does not answer.

### Can a UI component ask a pattern a question and await an answer?

**No.** This is the central finding, and it is worth stating in three parts,
because one of them is that most of the machinery already exists somewhere else.

**Invoking a handler returns nothing.** `IStreamable<T>.send()` is declared to
return `void` (`packages/api/index.ts`), and every layer below it agrees. On the
browser side, `CellHandle.send` and `sendStrict` return `Promise<void>`, which
reports whether the write committed and nothing about what the handler computed
(`packages/runtime-client/src/cell-handle.ts`). The DOM event that triggers a
handler travels as a one-way notification: the connection's own doc comment says
it "carries no msgId, registers no pending entry, and the worker sends no
response" (`packages/runtime-client/src/client/connection.ts`). On the worker
side the handler's return value is discarded at the call site — the reconciler
registers `(event) => stream.withTx(undefined).send(event)`
(`packages/html/src/worker/reconciler.ts`). `RequestType.CellSend` is documented
to match: "remote confirmation is not waited for, so that a slow server cannot
block cell IPC" (`packages/runtime-client/src/protocol/types.ts`).

**The result plumbing exists in the runner, and stops before the browser
client.** A handler's return value is already written to a durable receipt cell
addressed by a caller-supplied event id — `tx.handlingReceiptLink` in
`packages/runner/src/runner.ts`, and `Cell.send(event, { eventId, session })` in
`packages/runner/src/cell.ts`. It is gated by
`experimental.commitPreconditions`, which
[`EXPERIMENTAL_OPTIONS.md`](../development/EXPERIMENTAL_OPTIONS.md#commitpreconditions)
records as "implemented, on by default", and the CLI reads it back for
`cf piece call` (`packages/cli/lib/callable.ts`), importing from
`@commonfabric/runner` rather than from the browser client. The
client-to-runtime protocol has **no `Invoke`, `Verb`, or `Call` request type**
(`packages/runtime-client/src/protocol/types.ts` is the whole enumeration). So
the hard half — a durable per-call result — is built; the browser-client surface
for it is not.

**Two request/response channels do reach a component, and neither reaches
pattern code.** The `Operation*` family is genuinely typed request/response:
`cf-code-editor`'s collaboration awaits `applyOperation` and gets an
`ApplyOpResolution` back
(`packages/ui/src/v2/components/cf-code-editor/codemirror-collaboration.ts`). It
is answered by the storage and codec layer. `CellHandle.querySqlite` takes SQL
and parameters and returns rows, which is the closest thing in the tree to a
component asking a question and receiving a computed answer — and it is answered
by SQLite, reached through `cf-iframe`'s bridge for an iframe guest rather than
by a pattern.

What a component holds otherwise is a `CellHandle`, whose every method is a
value read (`get`, `sync`, `pull`, `resolveAsCell`, `getCfcLabel`) or a write
reporting only commit or refusal (`set`, `setStrict`, `initialize`, `push`,
`send`, `sendStrict`) — `packages/runtime-client/src/cell-handle.ts`. Upward
communication from a Lit component is `this.emit(...)` over `dispatchEvent`,
whose return value says only that the event was not cancelled
(`packages/ui/src/v2/core/base-element.ts`).

**The closest buildable substitute is write-then-pull.** A component writes a
request into a cell, then calls `pull()` on the cell a pattern derives from it.
`handleCellPull` does not just re-read: it calls `.pull()` and then
`scheduler.idleWithPendingCommits()` before returning the value, with the
comment "A client pull is the freshness barrier, not a cache sample… Cross the
commit-aware fixpoint in the same request"
(`packages/runtime-client/src/backends/runtime-processor.ts`). That is
architecturally an ask-and-await — a question written, the reactive work
demanded, the answer read — and **no component in the tree does it.** Every
`pull()` and `sync()` in `packages/ui` refreshes a value that was already there.

Its costs are real and should not be glossed. The question is a durable write,
so it lands in storage and in everyone's replication. One shared request cell
serializes every concurrent author on the collection, so each editor needs its
own, allocated by whoever owns it. And nothing addresses the answer to the
asker, so two questions in flight on one cell are indistinguishable — which is
the problem the runner's event-id-addressed receipt already solves, one layer
down.

## The three concerns, separated

### Authoring

**What it needs.** A way to turn "member 42 of the collection I am reading
through" into something durable, at the moment the author types it.

**What it costs today.** Everything: the whole universe, resolved row by row,
before the reference form is available at all (`_insertMentionOf` falls back to
the wiki-link form for an unresolved row).

**What it may not depend on.** A candidate list. `#42` typed in full is
unambiguous within its collection — the author has already said which member —
and requiring a dropdown to have offered it is an implementation accident, not a
property of the reference. It also may not depend on the destination being
loaded: an author who cites a member should not wait on that member's document.

### Resolution

**What it needs.** Given a stored mention and a reading context, the
destination, and the name to show for it.

**What it costs today.** For a pill's name: the universe, scanned by identity.
For following a mention: the destination cell is stored, so following it is a
load of that one piece. Outside an open editor: nothing, because nothing renders
a mention outside the editor.

**What it may not depend on.** The collection's other members. This is #7805's
question and the answer it asks for applies here directly: resolving one mention
should cost the documents that mention touches.

### Completion

**What it needs.** Given a prefix, some candidates, fast enough to type against.

**What it costs today.** A linear scan per keystroke over an array whose
delivery already cost the whole collection.

**What it may not depend on.** Completeness. A million-member collection cannot
offer an exhaustive answer to `#4` in a dropdown, so the question is not whether
the answer is partial but whether the partiality is honest and whether authoring
still works without it.

## Options

Costs below are reasoned from #7805's measurements and from the code cited
above. Nothing here was measured for this document.

### A. A static list bounded to some size

The collection publishes the most recent K rows rather than all of them.

|                                        | 1,000 members         | 1,000,000 members                      |
| -------------------------------------- | --------------------- | -------------------------------------- |
| universe document                      | K rows, bounded       | K rows, bounded                        |
| resolution round trips per editor open | K                     | K                                      |
| completion                             | complete if K ≥ 1,000 | incomplete, silently                   |
| pill names                             | complete if K ≥ 1,000 | **missing for every member outside K** |

**What it gives up.** The fourth cost above: a mention of a member outside the
bound loses its number, and nothing tells the reader. That is not a completion
regression, it is a rendering regression, and it lands on documents already
written.

**Where it is honest.** As a _dropdown_ source alongside a separate resolution
path — see the hybrid under C. On its own it is the current design with a
smaller N and a new silent failure.

### B. A dynamic query issued as someone types

The editor stops holding a universe and asks, per query, for rows matching a
prefix. Four places the question could be answered, with different costs:

**B1 — answered by the pattern, through write-then-pull.** The component writes
the query into a cell and pulls the cell the collection derives from it;
`handleCellPull` crosses the commit-aware fixpoint before returning, so the
answer reflects the question. Buildable with what exists and built by nobody.
Costs a durable write per keystroke, needs a request cell per editor, and has no
way to tell two questions in flight apart. The derivation itself still scans the
member list unless the collection maintains an ordered structure, so the
_server_ cost is unchanged at a million members — what improves is delivery.

**B2 — answered by the runtime, through a new protocol request.** A request
shaped like `slug:resolve` but taking a prefix and returning candidates. One
round trip per query, no durable write, no per-editor cell, and questions told
apart by the protocol's own message ids. The runtime side must scan or seek the
namespace map, which it has to have loaded — so at a million members this trades
a million-row delivery for a million-row document sync on the serving side,
unless something ordered is built underneath.

**B2′ — answered by the pattern, over a new protocol request.** The variant
worth naming separately, because the expensive half of it already exists: give
the browser client the verb-call surface the CLI has, so a component can send an
event with an id and read the handler's receipt back. The receipt machinery is
built and on by default in the runner; what is missing is a request type on the
client-to-runtime protocol and a `CellHandle` method for it. That is a general
facility rather than a mention feature, and it would serve every other component
that wants to ask its pattern something.

**B3 — answered by an index.** Ruled out by #7805 finding 2 for delivery, and by
`collection-indexes.md` for the query shape: a prefix is not a key, and `keys()`
is the whole enumeration.

|                          | 1,000 members              | 1,000,000 members                               |
| ------------------------ | -------------------------- | ----------------------------------------------- |
| B1 delivery per query    | candidates only            | candidates only                                 |
| B1 writes                | one per keystroke, durable | one per keystroke, durable                      |
| B1 server work per query | scan of 1,000              | scan of 1,000,000                               |
| B2 delivery per query    | candidates only            | candidates only                                 |
| B2 server work per query | scan of 1,000              | scan of 1,000,000, or a seek nothing implements |

**What it gives up.** Nothing about rendering — every arm of B answers
completion only. It leaves authoring dependent on the query having answered,
which is the dependency that makes an offline or slow-network mention
impossible.

### C. The optimistic link

Authoring records "member 42 of this collection": a reference to the
**collection** and the member **name**. Resolution happens when the mention is
rendered or followed, through the collection's own resolution — the operation
`resolveSlugReference` already performs.

|                                           | 1,000 members                        | 1,000,000 members   |
| ----------------------------------------- | ------------------------------------ | ------------------- |
| authoring                                 | no universe, no round trips, no wait | same                |
| resolution per distinct mention on screen | namespace document + the member      | same                |
| namespace document                        | one link per member                  | one link per member |
| completion                                | not addressed                        | not addressed       |

**What it buys.** Authoring stops depending on a candidate list entirely. A
`#42` typed in full is a valid mention with no dropdown, no universe, and no
resolution round trip — which is what makes "may completion be incomplete?" an
answerable question rather than a concession.

It also gives the pill a name without the universe. What is stored is the
qualified name, not a spelling — the spelling is still computed where the text
is read, by the round trip
[the spec describes](../specs/collection-naming.md#choosing-the-spelling) — but
the collection and member the round trip starts from are now in the reference,
so `_universeShortNames`' identity match over the universe stops being the only
path to a name.

**What it changes.** A stored mention is no longer a durable pointer at a piece;
it is a name a collection resolves. The
[spec's Storage rule](../specs/collection-naming.md#storage) reserves exactly
this branch — "A qualified name is the right thing to store only where the
collection promises the name outlives the reference" — and
`NamingDeclaration`/`NamingPolicy`
(`packages/patterns/collection-naming/naming.ts`) is the promise: a policy that
is unique across history, permanent, and never reused is a name that outlives
anything pointing at it. `SEQUENCE_NAMING` declares exactly that.

But nothing reads the declaration. The spec records this as open — "Whether a
collection's declaration is checked against the name it is reached through" —
and notes that "no collection sets `name`, no resolver compares one, and member
resolution (`packages/runner/src/slug-resolution.ts`) reads no part of it"
([#6986](https://github.com/commonfabric/labs/issues/6986)). So C rests on a
promise that is published and unread.

**What it still needs.** The namespace document is one link per member and is
synced whole to resolve one name. At a million members that is the same linear
document the universe was, one field wide instead of four, read by each reader
once rather than per member. That is a large improvement and not an asymptotic
one.

**The hybrid.** C for authoring and resolution, A or B for completion. C makes
completion optional, so the dropdown can be bounded (A) or dynamic (B) without
any of the consequences that bound the universe today — a member the dropdown
never offers is still citable by typing its number, and still renders with its
number, because neither reads the dropdown's source. This is the shape this
document recommends and Mike's direction describes.

## What each option requires that does not exist

**A** requires nothing new. It requires a _decision_ about the bound, and — if
it is not paired with C — a second path to a pill's name, which is C.

**B1** requires a per-editor request cell the container allocates, and a
convention saying who owns it. It also puts a durable write on the keystroke
path, which nothing in the editor does today, and it has nothing that tells two
questions in flight apart.

**B2** requires:

- a new `RequestType` on the client-to-runtime protocol, alongside
  `SlugResolve`;
- a prefix-capable read over a collection's namespace — the namespace is a plain
  map document and nothing offers an ordered seek into one;
- a way for the editor to name the collection. The editor is handed
  `$mentionable`, not the collection: no prop, attribute, or context carries a
  collection reference or slug — the component's `static properties` table and
  its `declare` block name neither. `resolveSlug` takes a _slug_, so under B2
  every collection offering completion would need a space-level name bound to
  it, or the request would need a form taking a collection cell.

**C** requires:

- **a stored mention shape that holds a collection and a member name.**
  `MentionRef` holds `destination` and `modifiedTitle` and nothing else
  (`packages/ui/src/v2/core/mention-refs.ts`); `MentionRefSchema` is the
  persisted contract (`packages/runner/src/component-read-contract.ts`). Either
  a new field or a second form.
- **a resolution call the editor can make.** `RuntimeClient.resolveSlug` is the
  right shape and the wrong key: it takes a slug, and a collection a pattern
  handed a member as a cell has none. A resolution taking a collection cell and
  a member name does not exist.
- **something that reads `NamingDeclaration`** before treating a name as durable
  (#6986).
- **a renderer outside the editor.** Read mode is
  `<cf-markdown content={body} />`, so a `#42` that resolves at render time
  resolves nowhere today. Either the editor becomes the read-mode renderer, or a
  mention-aware renderer is built, or the rendered markdown grows the
  reference-definition block the note's `[FS]` projection already emits
  (`splitDefinitions`, `packages/patterns/notes/reference-address.ts`, used by
  the projection in `packages/patterns/notes/note.tsx`).

**B2′** requires a request type on the client-to-runtime protocol and a
`CellHandle` method that sends an event with a caller-supplied id and returns
the receipt's value. The receipt itself needs nothing: it is written today,
addressed by that id, and read back by the CLI. Whether the browser client
should gain this at all is a decision for whoever owns the verb surface, and
this document does not make it.

**Only B2′ requires the facility that does not exist**, and it is the one that
would build it. A and C route around it by asking the runtime instead; B1
substitutes two cells and a fixpoint for it; B2 adds a runtime answer rather
than a pattern one.

## Decisions

Ruled by Mike on 2026-09-30. Each states what holds; where a ruling departs from
what this document first proposed, it says so, because the departure is the part
a reader would otherwise have to reconstruct.

**Completion is best-effort, and what it offers must be legible.** No dropdown
can enumerate a large collection, so completion narrows as an author types and
offers candidates once the set is small — on the order of ten. Each candidate
shows its member's TITLE beside its name. A list of bare numbers is close to
useless to pick from, and that is what makes "incomplete" acceptable rather than
merely honest: the partial answer has to be one an author can act on.

This costs nothing to deliver. A universe row already copies the member's title
beside its name (`MentionableRow` in
`../../packages/patterns/collection-naming/mentionable.ts`), so a dropdown reads
titles without expanding any member. Whether the editor component renders that
title today is unverified and is the first thing to check when building this.

**An unresolvable mention keeps its citation.** A stored mention holds the
collection reference and the member name, and one that does not resolve renders
as its label with an explicit unresolved marker. Membership in the reference map
otherwise decides what is a mention, which is the right rule for a token nobody
authored and the wrong one for a token somebody did: an author who cited member
42 sees that the citation did not resolve, rather than watching it become prose.

**A mention may name another collection; typing one waits.** Storage and
resolution cover a mention whose destination is in a different collection —
the stored shape is the same either way, so settling it now keeps it from
needing a second migration. The `#top/42` query grammar the spec already defines
([Prose and URLs](../specs/collection-naming.md#prose-and-urls)) stays
unimplemented for now.

**Storing a name requires the collection's promise, checked.** Converting a
mention from a pointer into a name is permitted only where the collection
promises the name outlives the reference, and that is a checked precondition
rather than an assumption. The promise exists as `NamingPolicy` and nothing
reads it ([#6986](https://github.com/commonfabric/labs/issues/6986)), so this
design is what first makes that declaration load-bearing.

**A mention resolves on render.** Resolution is cached within a reading session
and never written back into the document. Writing a resolved destination back
would make every reader a writer of someone else's document, and would make the
cached value exactly the stale copy
[#7805](https://github.com/commonfabric/labs/issues/7805) warns about. The cost
of not caching is the namespace document per session, which a reader needs
anyway to render any mention at all.

**The collection owns the query surface.** It knows its own name grammar and its
own policy; the runtime deliberately knows neither. The spec puts the decimal
grammar in the collection's library at the top of the pace layers and the
resolver in `runner` at the foundation, and a runtime-side query would have to
hardcode a grammar or read a declaration the runtime does not read.

**A pill resolves its own name from the namespace.** It shares no source with
the dropdown. This is stronger than this document first proposed — that a
bounded list feed the dropdown only — and the reason for going further is that
the separation is what makes the silent-unnaming failure impossible rather than
merely avoided by the bound currently chosen. Whatever the dropdown reads, a
pill's name does not depend on it.

**The browser client's verb-call surface is a prerequisite.** A component cannot
ask its pattern a question today; the receipt carrying a handler's result is
written by default and read back by `cf piece call`, so the gap is a missing
protocol request rather than a missing mechanism. This document first treated
that as adjacent work. It is not: once the collection owns the query, the editor
has to be able to ask the collection, so this design cannot be built until that
surface exists. It belongs to whoever owns the verb surface, and this design
depends on them rather than proposing to do it.

**The editor's short-name read is fixed separately, now.**
[#7771](https://github.com/commonfabric/labs/issues/7771) — the code editor
reads a mention's short name from the destination piece, where the spec
reserves that for a universe row — is a rule the spec already states, and the
fix is local to the component. None of the options here removes a raw-list
universe, so none of them fixes it incidentally. A universe row now carries a
member's number for the component to read instead.

## What this design does not cover

- **The `[[` backlink surface over a space's own mentionable list.**
  `wish({ query: "#mentionable" })` resolves a different universe
  (`defaultPattern.backlinksIndex.mentionable`) with the same shape of problem
  and a different owner. Nothing here proposes a change to it.
- **The clipboard flavors and the portable render mode.** The spec defines both
  under [Copying](../specs/collection-naming.md#copying); `mention-refs.md`
  records the fully qualified form a reference needs once it leaves as "a
  clipboard flavor nothing here writes yet".
- **Whether `#` means a citation or a wish.** The spec records this as
  deliberately open and as a blocker on its own step 5. Every option here
  assumes the editor's current answer: a `#` followed by digits opens a citation
  query, and nothing else routes on the mark.
- **Collaborative editing.** The editor's co-presence and `apply-op` paths are
  not examined; a change to what a mention stores touches the reference map,
  which is a cell rather than the collaborative document, but that was not
  verified.
- **Authority.** The spec's Authority section applies unchanged; nothing here
  proposes a name a reader cannot resolve.
- **Any new measurement.** Every cost stated is either from
  [#7805](https://github.com/commonfabric/labs/issues/7805) or reasoned from the
  code cited. Whether a namespace map of a million links transfers at all, and
  what a prefix seek over one would cost, are open and can only be settled by
  running something.

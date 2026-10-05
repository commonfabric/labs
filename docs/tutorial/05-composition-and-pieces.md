# Chapter 5 — Composition, Pieces, and Capabilities

So far we've built single programs. The point of Common Fabric, though, is
*networks* of programs: patterns composing into bigger patterns, and
deployed pieces linking to each other through shared cells. This chapter
covers composition inside one source file, the piece lifecycle, linking
across pieces, navigation, and the built-in LLM capability.

## Composing patterns in source

A pattern instantiates another pattern by calling it — as a function or as
JSX (equivalent; the runtime extracts `[UI]` from the result):

```tsx
// Shown inside a pattern body.
{items.map((item) => ItemCard({ item }))}
{items.map((item) => <ItemCard item={item} />)}
```

What gets passed down is **the cell, not a copy**. In the todo list
(Chapter 4), `TodoItemPiece` receives the `item` cell; when its checkbox
writes `item.done`, the parent's computeds see it — there is no
prop-drilling/state-lifting dance because there is no ownership boundary:
both patterns are graphs over the same cells. Streams pass the same way
(`removeItem` is sent down so the child can ask the parent to remove it).

The contract for a composable child: its `Output` must include
`[NAME]: string` and `[UI]: VNode` if the parent will render it. And the
wiring is **by exact field name** — the child's input names must match what
you pass; there is no automatic mapping.

Two cautions, both compiler-rooted (Chapter 7):

- Pattern inputs are cell proxies, so spreading them (`{...extraTools}`) is
  a silent no-op; merge inside a `computed()` instead.
- If a value passed to a child came from *another* composed pattern, bridge
  it through a local `computed()` before using it in `ifElse` (Chapter 4's
  gotcha).

Passing a plain value to a child input creates fresh state owned by that
instance; passing a cell shares state. The same `Counter` pattern can be ten
independent counters or ten views of one counter, depending only on what the
parent passes.

## Pieces: patterns, deployed

A **pattern** is source code — a template. A **piece** is an instance of a
pattern living in a space. Top-level deployment through `cf piece new` or the
shell does roughly this (see `packages/piece/src/ops/pieces-controller.ts`):

1. The pattern source is compiled and registered, so the space knows the
   program (not just its output).
2. An **argument cell** is created to hold the piece's inputs, and a
   **result cell** to hold what the pattern returns; metadata links the
   piece to its pattern source.
3. The piece is added to the space's piece list (the space's default
   pattern maintains `pieceRegistry` and exposes an `addPiece` stream — note,
   even space management is "just a pattern").
4. From then on, any runtime that opens the space can load the piece: the
   pattern graph is re-instantiated over the argument cell, and the result
   (including `[UI]`) flows from there.

Instantiating a child pattern inside another piece creates its cells and
metadata, but does not add the child to `pieceRegistry` automatically.

A piece is identified by an entity id (a hash, e.g. `fid1:abc...`) and can carry
a human **slug** for URLs. In the current shell,
`/{spaceName}/{pieceIdOrSlug}` shows a piece's UI.

[Common Fabric URLs](../specs/fabric-urls.md) describes a possible future
canonical browser form using an ASP host, a registered space name or space DID,
and the piece DID. No deployment is planned; the current shell routes remain
authoritative.

The registry is the root of the supported piece listings. A child piece that is
not registered must be published through a searchable collection or remain
reachable by following links from a known piece. An orphan piece does not
appear in the piece-specific listings or searches. It can still be addressed
when its exact address and scope are known. Some space-scoped roots with
recognizable metadata can also be recovered by exhaustively inspecting
low-level entity listings. See
[Finding Pieces](../common/concepts/piece-discovery.md).

## Linking pieces

Because a piece's inputs and outputs are cells, you can wire *deployed*
pieces together after the fact:

```bash
deno task cf piece link <editor-piece-id>/items <viewer-piece-id>/items
```

This points the viewer's `items` input at the editor's `items` output — the
same cell-sharing as in-source composition, but done at runtime between
independently deployed programs. Under the hood it writes a **link** (a
serialized cell reference) into the viewer's argument cell; the runtime
resolves links transparently on read (Chapter 8). This is the payoff of the
whole design: integration between programs is a pointer, not an API project.

The target path must be selected by the viewer's current input schema. A declared
optional input, an array slot, or a key selected by `additionalProperties` can
be linked before it has a value with `--allow-non-existing`. Without the flag,
both endpoint paths must have values. If the pattern does not declare the input,
update the consumer with `cf piece setsrc` before linking. `--allow-non-existing`
allows missing pieces and endpoint values; it does not expose undeclared inputs.
A refused link writes no binding and reports no successful link receipt.

Whole-input and targeted `cf cell get --input` reads use the same input
projection. Targeted `cf cell set --input` writes and piece input edits require
the current input schema to select their path. A write can activate another
schema branch; reads expose the branches selected by the resulting value.

An old link stored under an undeclared input remains in the raw argument
document, but a targeted piece-input read refuses that path. Updating the pattern
to select the input makes that link visible without rewriting it.
`cf piece setsrc --check` checks the candidate projection and uses runtime setup's
stored-argument validation, including deferral of unreadable linked values; it
does not change the stored arguments or the piece's source identity.

## Navigation

For drill-down flows (list → detail), a handler can return
`navigateTo(somePiece)`:

```tsx
// Shown as JSX element children.
<cf-button onClick={() => navigateTo(ItemDetail({ item }))}>Edit</cf-button>
```

`navigateTo` with a freshly-instantiated pattern creates the detail piece
and navigates the shell to it; with an existing piece it just navigates.
The canonical list/detail example is `packages/patterns/reading-list/` —
the detail pattern receives each editable field as a `Writable<>` input and
binds them directly with `$value`.

## Capability: LLM calls

Patterns can call language models declaratively — `generateText` /
`generateObject` are *reactive nodes*, not awaited promises
(`docs/common/capabilities/llm.md`):

```tsx
// Shown inside a pattern body.
const response = generateText({
  prompt: userInput,                       // reactive — re-runs when it changes
  system: "You are a helpful assistant.",
});
// response: { pending: boolean, result?: string, error?: unknown,
//             partial?: string /* streaming text so far */ }

{response.pending ? <cf-loader /> : <cf-markdown>{response.result}</cf-markdown>}
```

The request flows through the server's LLM proxy (Toolshed — Chapter 11),
results are cached per distinct input, and `pending`/`error`/`result` are
just cells your UI binds to. A real use from
`packages/patterns/shopping-list.tsx` — note it's *inside a `.map()`*, one
cached classification per item:

```tsx
// Shown inside a pattern body.
const itemsWithAisles = items.map((item) => {
  const aisleResult = generateObject<AisleResult>({
    system: "You are a grocery store assistant. ...respond with one of the exact locations...",
    prompt: `Store layout:\n${effectiveLayout}\n\nItem: ${item.title}\n...`,
    model: "anthropic:claude-haiku-4-5",
  });
  return { item, aisle: aisleResult };
});
```

Model names must be `vendor:model` (e.g. `"anthropic:claude-sonnet-4-5"`,
`"openai:gpt-4o"`); a malformed name fails with an unhelpful `TypeError`.
`generateObject` accepts `cache: false` to force regeneration
(`generateText` is always cached per distinct input).

Think about what this composition means: an LLM call whose *prompt is a
reactive function of durable shared state*, whose result is durable shared
state, inside a list comprehension, synced to every user of the space. That
sentence is the product.

---

**Next:** [Chapter 6 — The development workflow](06-workflow.md): actually
building, deploying, and testing.
**Under the hood:** what links physically are and how cross-piece reactivity
syncs — [Chapters 8](08-runtime-internals.md) and
[9](09-storage-and-sync.md); how the server runs pieces —
[Chapter 11](11-deployed-system.md).

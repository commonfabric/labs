# Pattern Composition

Patterns can compose other patterns by instantiating them and including the result in the vdom.

## Syntax: Function Calls or JSX

Use either function call or JSX syntax:

```ts
// Shown inside a pattern body.
{items.map((item) => ItemCard({ item }))}
```

```tsx
// Shown inside a pattern body.
{items.map((item) => <ItemCard item={item} />)}
```

A mapped list tracks **the cell it maps**. Deriving a different *arrangement* of
it — sorted, grouped, reversed — into a `computed()` and mapping that renders
the first arrangement and then never moves, because the cell the renderer
watches never changed. Write the new order into the mapped cell instead. See
[a mapped list reorders in a `computed()` and the rows never move](../../development/debugging/gotchas/mapped-list-order-from-computed.md).

## How It Works

When you place a pattern result in the vdom, the runtime:
1. Extracts the `[UI]: VNode` property from the pattern result
2. Renders that VNode in place

This is why sub-patterns **must include `[UI]` in their Output type** - see [Pattern Types](../concepts/pattern.md#output-types-for-sub-patterns).

## Example

```tsx
import { pattern, NAME, UI, VNode, Writable } from "commonfabric";

interface Item { name: Writable<string> }

interface ItemInput { item: Item }
interface ItemOutput {
  [NAME]: string;
  [UI]: VNode;  // Required for composition
  item: Item;
}

const ItemCard = pattern<ItemInput, ItemOutput>(({ item }) => ({
  [NAME]: item.name,
  [UI]: <div>{item.name}</div>,
  item,
}));

interface ListInput { items: Writable<Item[]> }
interface ListOutput {
  [NAME]: string;
  [UI]: VNode;
  items: Item[];
}

// Parent pattern composes ItemCard
export default pattern<ListInput, ListOutput>(({ items }) => ({
  [NAME]: "Item List",
  [UI]: (
    <div>
      {items.map((item) => ItemCard({ item }))}
    </div>
  ),
  items,
}));
```

Both patterns receive the same `items` cell - changes sync automatically.

**When to use which:**
- **Pattern Composition**: Multiple views in one UI, reusable components
- **Linked Pieces**: Independent deployments that communicate

## Keep External Data Contracts Narrow

A pattern schema is a runtime projection and binding contract, not only a
TypeScript annotation. When a pattern receives externally owned data through a
link, wish result, registry entry, or other cell, declare only the fields it
reads and only the live-cell or stream bindings it uses. Extra optional fields
can make the runtime traverse more linked data. An extra required field whose
value is absent or incompatible and whose schema does not accept `undefined`
invalidates the containing object; if that object is an array element, one
invalid element voids the entire array read. See
`packages/runner/test/traverse-required-links.test.ts`.

The consumer normally owns this structural type:

```typescript
// Shown at module scope.
type NotePreview = {
  title?: string;
  summary?: string;
};

interface PreviewInput {
  note: NotePreview;
}
```

Do not import another pattern's entire `FooInput` or `FooOutput`, or derive a
`Pick`/`Omit` from it, merely because it contains the needed fields. Spelling
the minimal local shape is intentional duplication: the producer can evolve
unrelated state, UI, and mutation streams without changing this consumer's
contract.

A derivation that reads narrowly and hands its elements straight back declares
that with a type parameter, so the narrow read costs its own callers nothing —
see
[Reading a Value Narrowly and Handing It Back Whole](../concepts/computed/computed.md#reading-a-value-narrowly-and-handing-it-back-whole).

An output type must be exported so TypeScript can name the default pattern
factory's return contract. That visibility requirement is not an invitation for
external consumers to reuse the whole type as their input schema.

`Writable<T>` and `Cell<T>` are the same cell type and runtime interface;
choosing between those names does not grant or restrict authority. The
meaningful consumer-side choice is branded versus plain: a branded result
projection preserves a live cell binding, while a plain field projects its
reactive value. Request the brand only when the relationship needs cell
identity or the cell API. See
[Reactivity and Write Access](../concepts/reactivity.md#results-mirror-the-rule-writable-in-a-result-type-grants-write-access)
and [Writable](../concepts/types-and-schemas/writable.md).

When a producer intentionally supports a stable role used by several
independent consumers, export a shallow model for that role, such as a
`MentionablePiece` or `SummarizablePiece`, rather than asking consumers to
reuse its full input or output schema. Keep that model limited to the role's
semantic core. A consumer with extra needs should usually extend its own local
projection instead of widening the shared model for everyone. For a concrete
example, see `MentionablePiece` in
`packages/patterns/system/backlinks-index.tsx`.

Reusing a shared type is still appropriate when it is itself the intended
protocol: for example, a stream event, an enum, or a cohesive domain model
co-owned by one pattern family. A wrapper that deliberately forwards a complete
contract may also use that complete contract. The test is whether every named
field and capability belongs to the relationship, not whether centralizing the
type removes duplicate TypeScript.

## Merging Complex Objects from Pattern Inputs

Pattern inputs are cellified — they become cell proxies, not plain objects. You **cannot** spread a pattern input directly into an object literal, because the spread operates on the proxy's own properties (which are empty) rather than the underlying value.

```tsx
// Shown inside a pattern body.
// BROKEN: ...extraTools spreads a cell proxy, yields nothing
const omnibot = Chatbot({
  tools: {
    ...baseTools,
    ...extraTools,  // extraTools is a pattern input — this is a no-op
  },
});
```

**Fix:** wrap the merge in `computed()`. Inside a computed body, CTS auto-unwraps cell proxies to their actual values, so the spread works on the plain object:

```tsx
// Shown inside a pattern body.
// WORKS: computed() unwraps extraTools before spreading
const baseTools = {
  searchWeb: { pattern: searchWeb },
  calculator: { pattern: calculator },
};

const allTools = computed(() => ({
  ...baseTools,
  ...extraTools,  // extraTools is unwrapped here
}));

const omnibot = Chatbot({
  tools: allTools,  // passed as a single cell reference
});
```

This pattern is useful when a sub-pattern needs to accept additional configuration (e.g. extra chatbot tools, extra fields) from its caller while also defining its own base set internally.

## An Input the Sub-Pattern Writes Takes a Cell

An argument is a link, not a copy. The sub-pattern's input names the very cell
you passed, and every write the sub-pattern makes lands in it. Pass a
`computed()` and the cell being handed over is that derivation's own output
cell, which the runtime rewrites from scratch on each run. The sub-pattern's
writes go into it, and the next run of the derivation replaces them with the
derived value again. Nothing reports this. The write succeeds, and the loss
arrives later, whenever something the derivation reads happens to change.

A derived argument therefore suits an input the sub-pattern only reads — the
`allTools` merge above is one — and not an input it writes.

```tsx
// Shown inside a pattern body.
// BROKEN: DonutTray writes `glazes`, so a re-run of this derivation discards
// whatever it has written.
const glazes = computed(() => [{ name: flavorOfTheDay, sold: 0 }]);
const tray = DonutTray({ glazes });
```

An input that needs a starting value and is written afterwards takes a cell of
its own, with the starting value written into it by a handler:

```tsx
// Shown inside a pattern body.
// WORKS: `glazes` is its own cell. `stockTray` is a handler, bound here, that
// writes the starting value into it.
const glazes = Writable.of<{ name: string; sold: number }[]>([]);
const tray = DonutTray({ glazes });
const stock = stockTray({ glazes, flavorOfTheDay });
```

A pattern test seeds a pattern the same way, and has the sharper version of the
hazard: the clock a test reads to build a timestamp is a wish that advances on
its own, so a seed derived from it re-runs partway through the run and takes
the pattern's state with it. See
[Seeding Stored State](../workflows/pattern-testing.md#seeding-stored-state).

## A Sub-Pattern Instance Is Known by Its Position

A sub-pattern instance that no `const`, result key or `.for()` names, such as an
inline `{ItemCard({ item })}`, is known by its position: the builder numbers
such instances in the order it walks the pattern's inputs and then its result,
`[UI]` tree included, and an instance's state belongs to its number. A
sub-pattern added ahead of others moves each later one onto the number, and so
the state, of the one before it. An update that does this to a deployed piece's
own pattern is refused before its setup commits anything, wherever the piece's
children show they have moved: the piece keeps its state and the pattern it ran
before, and it does not start in a new session until it is pointed back at a
pattern that is not refused. The check leaves out an instance that is its
space's root, and one placed in a space of its own with `.inSpace()` that is
managed there independently, so an update is not refused on account of either.
Nor is a sub-pattern's own update checked when its parent's update brings it,
nor a pattern a `computed` returns in place of another, so their instances can
still move onto each other's state. Add a sub-pattern after every existing one
in that order, or name it with a result key, so that it takes a number nothing
held. Where an instance's own source also changed in the same update, the
refusal cannot tell that it moved, and the instances can run on each other's
state.

## A Sub-Pattern Bound to a `const` Is Known by Its Name

A sub-pattern instance bound to a `const` keeps its state under that name,
wherever it sits in the pattern and whatever is added around it, provided no
other instance in the pattern is bound to the same name; instances that share
one are known by their positions. Renaming the `const` starts the instance
fresh: its state stays with the old name, which nothing reaches any more, and
the update logs `instance-carry-over`. Bind a sub-pattern that holds state to a
`const` in an update that changes nothing else around it: that update keeps the
inline instance's state. Deleting an inline instance and adding a `const`
instance of the same pattern in the same update hands the deleted one's state
to the new one, where the new one takes its place among that pattern's
instances. Reordering instances of one pattern in the same update matches them
by order, so each takes the state of the one whose place it takes.

## See Also

- [Pattern Primitives](./primitives.md) — the contract for embedding reusable
  logic and model state
- [View Switching](./view-switching.md) — dynamically switching between sub-patterns
- [Navigation](./navigation.md) — `navigateTo()` for drill-down to detail views
- [Self-Reference](../concepts/self-reference.md) — tree/parent-child structures where a pattern composes itself

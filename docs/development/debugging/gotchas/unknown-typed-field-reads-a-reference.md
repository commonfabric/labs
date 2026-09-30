# A field typed `unknown` reads back as a reference

**Symptom:** a field holds a real value — another piece, a nested object, the
screen a pattern just built — and every read of it through the declaring type
carries none of that value: it is truthy and compares equal to what it names,
but every property of it is `undefined`. No runtime error and no warning.
Rendering the same path still works, which is what makes this confusing:
`<cf-render $cell={entry.piece} />` shows the piece while `entry.piece.label`
right beside it is undefined. In a pattern test the same shape reads as `{}`:
`textContent(piece[UI])` is empty even though the piece on screen shows the
tree.

```typescript
// Shown at module scope.
interface Entry {
  type: string;
  piece: unknown; // holds a link to another piece
}
```

**Why:** `unknown` lowers to the schema `{ type: "unknown" }`, which declares a
reference rather than a value, and neither read path descends into one. What
comes back answers presence and identity: it is truthy when something is there,
`equals()` compares it to the cell it names, and writing it back stores a link.
It carries no properties, so reading one yields `undefined`.

That holds whatever sits behind the position — a stored string is as opaque as
a stored object — and it holds on both read paths, the eager traversal and the
lazy view a lift's argument goes through. An `asCell` alongside it still
produces a cell. A concrete type declared beside it, as in
`{ type: ["unknown", "string"] }`, is a reader asking for the value and gets
it; so does a branch of an `anyOf` that declares the property, which no longer
loses to a sibling branch that declines to look.

The path survives even though the value is not carried, which is why cells and
rendering still work: a `$cell` binding passes the path, and the renderer reads
it under a schema of its own (`asSchema(rendererVDOMSchema)` —
`runner/src/runner.ts` on the mainline path, `shell/src/views/BodyView.ts`, and
`html/src/in-process.ts` when the reconciler runs in the caller's own process),
while every read of the *value* comes back empty. An attribute or a property
the renderer reads through such a reference shows the string, number,
boolean, or null it names: a DOM attribute can hold only the value, so the
reconciler reads the reference's own position for the scalar there. A record
or a list behind the reference stays a reference.

Three transformer diagnostics cover neighboring cases and none catches this
one: `reactive-capture:unknown-type` reports a closure capture whose inferred
type is `unknown`, `schema:unknown-type-access` reports a property typed
`unknown` accessed directly on a lift or handler parameter
(`ts-transformers/src/transformers/type-shrinking.ts`), and
`pattern-result:opaque-reserved-key` reports the reserved-key case below.
Reaching the field through an array element inside a callback, as further
below, is outside all three.

## When the opaque field is the pattern's own screen

The same reference semantics reach `[UI]` and `[NAME]`, and at the root of a
pattern's own result they are the wrong reading. A reserved key's spelling
belongs to the framework rather than to whoever described it, so the value
under it there is one that pattern produced: the screen it built, the name it
chose. Declared `unknown`, that value is gone for every reader, while the piece
goes on rendering — the renderer reads `$UI` under a schema of its own. A
pattern test inspecting the screen, or another pattern reading it, gets `{}`.

```typescript
// Shown as alternative snippets.
// The screen this pattern renders, declared as a reference to someone else's.
type Wrong = { [NAME]: unknown; [UI]: unknown; label: string };
```

```typescript
// Shown as alternative snippets.
// The same result, naming what each field holds.
type Right = { [NAME]: string; [UI]: VNode; label: string };
```

The compiler rejects the first form: `pattern-result:opaque-reserved-key`,
raised at the `pattern()` call by `reserved-result-keys.ts` in
`packages/ts-transformers`. The rejection applies where an author can act —
`cf check`, deploy, candidate admission; the runtime's identity-pinned reload
of already-deployed stored source demotes it to a warning, so pieces that
predate the rule keep loading. It reaches the root of a **result** schema and
nothing else, which leaves two shapes legal and needed. Below the root, a
reserved key names a field of another piece, where `unknown` is what keeps the
field a reference to that piece's own screen rather than a copy, so the
controls in it stay bound to the piece that owns them. On the argument side, a
declaration has to keep accepting every value it accepted before, so a consumer
view of a result type holds `unknown` even where the producing type names
`VNode`. `unknown`'s own page states that producer/consumer split:
[`docs/common/concepts/types-and-schemas/unknown.md`](../../../common/concepts/types-and-schemas/unknown.md).

## What decides whether a read materializes

The schema of the **operand the value is read into**, not the schema the field
was declared with. A lift or handler that names the fields it wants gets them:
the read follows the link into the target and materializes them, and re-runs
when the target changes them.

```typescript
// Shown at module scope.
// The operand names the field, so this read follows the link and materializes.
const readLabel = lift<{ piece: { label?: string } }, string | undefined>(
  ({ piece }) => piece?.label,
);
```

Three rules decide whether such a read reaches the value:

**Name the property.** Naming it is what reliably overrides a declared field
schema. An operand of `entries?: any[]` can lower to `items: true`, and a `true`
schema defers to the schema the cell itself carries (`traverse.ts`,
`combineSchemaForLink`: a true reader schema adopts the link's schema) — with
`piece: unknown` still inside
it, so `entries[0].piece` is undefined. `entries?: { piece: any }[]` names the
property, and the piece materializes: the same read of
`entries[0].piece.nickname` yields the module's real nickname under the second
operand and `undefined` under the first.

Do not read `any[]` as always lowering to `items: true`. Type shrinking narrows
an operand from the accesses in the lift body, so a body that indexes a literal
position can get a structural schema that materializes, while the same
annotation with a variable index gets `items: true` and does not. Naming the
fields is what makes the read independent of that; `--show-transformed` below is
how to see which one you got.

**Apply the lift where the value is still a link.** A `.map()` at pattern-body
scope keeps each element reactive, so a lift applied inside it is a real lift
application on a link. The same `.map()` inside a `computed()` is not: the whole
`computed()` body becomes a single lift, and the `.map()` there is plain
JavaScript over the already-materialized list, where the field is already
`undefined`.

```typescript
// Shown at module scope.
const readEntryLabel = lift<{ piece: { label?: string } }, string | undefined>(
  ({ piece }) => piece?.label,
);

export default pattern<{ entries: { type: string; piece: unknown }[] }>(
  ({ entries }) => {
    // Each element is still a link here, so the lift reads through it. The
    // same expression inside a `computed()` would not.
    const labels = entries.map((entry) =>
      readEntryLabel({ piece: entry.piece as { label?: string } })
    );
    return { labels };
  },
);
```

**In a handler, ask for a cell.** A handler receives its operands as values, so
there is no link left to follow. Type the field as a `Cell<...>` and call
`get()` on it:

```typescript
// Shown at module scope.
interface ListEntry {
  type: string;
  piece: unknown;
}
type EntryHandle =
  & Omit<ListEntry, "piece">
  & { piece: Cell<Record<string, unknown>> };

const reportFirstLabel = handler<
  { result: Writable<unknown> },
  { entries: Writable<EntryHandle[]> }
>(({ result }, { entries }) => {
  result.set(entries.get()[0]?.piece?.get()?.label);
});
```

The declaring type and the operand type describe the same cell; the call site
casts between the two views. Casting **to** a `Cell<>` is rejected by the
transformer, so a handler that also builds new entries cannot take this view of
the list it writes: the entry it constructs would have to be cast into it.

## Confirming it

The emitted operand schema is the ground truth, and
`--show-transformed` prints it:

```bash
deno task cf check <pattern>.tsx --show-transformed --no-run
```

A field you expect to read shows as `{ type: "unknown" }` when the read will
stop at a reference — the field itself is there and truthy, its properties are
not — and as the shape you named when it will materialize.

## The shape that invites it

A pattern that holds a list of other pieces and types the element's piece field
`unknown` — because the element can hold any of several kinds — hits every arm
of this at once. Each feature reading a field off one of those pieces gets
`undefined` and silently falls back, and because the fallbacks differ per
feature (a generic label here, an empty dialog there) the single cause is
discovered once per feature rather than once.

Two fixes apply, and which one you need depends on where the read is. A read
that can go through a lift takes the operand that names the fields, per the
rules above. A value the holder needs for itself — the label it chose for an
entry, say — is better recorded on the entry beside the piece than read back
through it.

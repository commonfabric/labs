# Primitives: the composition contract

A **primitive** is a pattern designed to be embedded inside other patterns —
used as a JSX tag, not deployed standalone. Primitives own a slice of *logic
and model* (a confirm-action gate, a master/detail selection) while leaving
rendering to the host. They live under `packages/patterns/primitives/` and
form the `primitive` tier in
[`packages/patterns/index.md`](../../../packages/patterns/index.md).

**Status: nine occupants, all adopted by the pattern index** — see
[`packages/patterns/index.md`](../../../packages/patterns/index.md). An earlier
candidate (`EditableList`) was built, proven against real callers, and retired —
see [Lessons](#lessons-from-the-first-primitive) below, which is required
reading before building the next one. This document records the composition
contract that work validated (the contract holds; the candidate didn't) plus the
entry bar a new primitive must clear.

## Entry bar: adopter-first

Do not build a primitive from a duplication census alone. Before any code:

1. **Name a real adopter** — an existing, non-fixture pattern whose concrete
   code shrinks or simplifies, agreed in advance. "Future patterns will want
   this" is the orphaned-`suggestable/` failure mode; it doesn't count.
   A published pattern index counts as an adopter only on the same evidence: a
   shape sessions have actually built for themselves, read off the corpus, not
   a shape one might plausibly want. The primitives here were each chosen
   against an entry already in the index that rebuilt it from scratch.
2. **Two callers from different families** before the primitive is considered
   proven (one caller just reproduces that caller's needs with the serial
   numbers filed off).
3. **Kill criterion**: a primitive with no organic adopters that has also
   forced contract churn on its migrated callers gets re-inlined. The library
   must be allowed to shrink — it did once already.

## What a primitive exposes

In priority order:

1. **Cells + Streams pre-bound to the caller's data.** This is the real
   product. The caller passes a `Writable<T>` it owns; the primitive binds its
   handlers to that cell and returns the bound `Stream<>`s. The caller wires
   nothing by hand — passing the cell *is* the wiring.
2. **An optional default `[UI]`.** A static `VNode` giving a caller who just
   wants the thing a working experience for free. A caller who wants custom
   rendering simply does not render it.

### A primitive over an injected handle

A primitive whose input is a capability handle rather than a caller's cell —
`SqliteDb` is the one in use — exposes the same surface minus the mutation
half: it reads through the handle, and returns typed rows, counts, the pending
flag and the failure text as cells. What it owns is the query, and the query is
the whole reason it exists. A store's column semantics are not in the handle a
session is given: `describe_handle` discloses the tables and columns and says
nothing about which value means "deleted", so a session writing its own query
guesses, and a wrong guess returns zero rows over a full table rather than an
error. The primitive is where that knowledge is written down once, in code that
is tested against both spellings.

Such a primitive is left out of the `demo/` host, since a host that embeds one
has to hand it a database. Its pattern test builds one with `sqliteDatabase()`
and seeds it through a handler. Two things about that test are worth knowing
before writing another. A query the primitive declares no `reactOn` for does
not re-run after the seed, so the test drives one of the primitive's own
reactive inputs — the month, or the predicate it counts under — and that is
what reads the seeded rows. And
reading `[UI]` stores links to the session-scoped query results in the vnode
tree, which the runtime warns about; the test carries
`allowConsoleWarnings: true` and says why.

That's the whole surface. In particular, do **not** add string-addressed
("ByText"/"ByTitle") mutation layers "for agents": LLM tool-calls round-trip
item references through the serialization layer (cells/items serialize to
`@link` references and re-cellify on the way back), so an agent that has read
the data sends the item itself — the same call a JSX handler makes. Grounding
a natural-language phrase against the data is the agent's job, not extra API
surface on the primitive.

## The crux: a sub-pattern CAN mutate a parent-owned cell

This is the question that makes or breaks embedding, and the answer is **yes**.

When a parent writes:

```tsx
// Shown inside a pattern body.
const gate = SomePrimitive({ state: myCell }); // myCell: Writable<T>
```

the primitive receives the **same** reactive cell — not a copy. Handlers inside
the primitive that call `state.push(...)` / `state.set(...)` mutate the
parent's cell, and the change syncs back to the parent automatically. Evidence:

- [`reactivity.md`](../concepts/reactivity.md): `Writable<>` is *write intent*
  on a shared reactive cell, not a fresh cell.
- [`composition.md`](./composition.md): "Both patterns receive the same `items`
  cell — changes sync automatically."
- `packages/patterns/examples/cf-render.tsx`: the embedded `Counter` mutates the
  parent's `state.value` via its own handler.

Because of this, a primitive does **not** need the parent to pass in Streams or
handlers. The primitive defines the handlers, binds them to the cell it was
given, and hands the bound Streams back. (The escape hatch — a primitive that
genuinely cannot mutate its input, e.g. a cross-space owner-protected cell —
would instead expose Streams the parent wires to its own handlers.)

## Identity rules (collection primitives)

For primitives that own a list/set of items, core mutations address an item by
**live reference**, using the data model's own identity:

- Remove: `items.remove(item)` — same `equals()` machinery under the hood.
- Update/toggle: locate with `findIndex((x) => equals(x, item))` and, when it
  finds one (`i >= 0`), patch **through the element's cells** —
  `items.key(i).key(field).set(value)` (the same route `$checked`/`$value`
  two-way binding writes through). An unguarded `-1` addresses a key no array
  holds, and the write fails with a `TypeMismatchError`. Never
  replace the array slot with a fresh object literal
  (`items.set(current.toSpliced(i, 1, { ...old, ...changes }))`): a fresh
  literal re-mints the entity identity, so every previously-held reference to
  that item — a selection cell, any caller that read it before the update —
  stops `equals()`-matching and later mutations sent with it silently no-op.
  Structural mutations (remove, clear-completed) genuinely drop entries, so
  rebuilding the array there is correct.

Two things are explicitly **not** the identity model:

- **Array indices.** Index-based selection/mutation breaks under reordering and
  concurrent edits. Note also that a reordering has to be written into the cell
  the default `[UI]` maps, not derived beside it, or the rows never move — see
  [mapped-list-order-from-computed](../../development/debugging/gotchas/mapped-list-order-from-computed.md).
- **User-land id fields.** NEVER mint `id` properties (UUIDs, counters,
  timestamps) on items. The reactive fabric is an object graph, not a keyed
  database; synthetic ids fight the reactivity system (in `.map()` callbacks an
  `id` property is a Cell, not a string, so lookups fail silently). See
  [`identity.md`](../concepts/identity.md) ("No ID generation") and
  [Custom `id` Property Pitfall](../../development/debugging/gotchas/custom-id-property-pitfall.md).

**Agents are not an exception.** It is tempting to add a third addressing mode
— title/text matching or a serializable token — "because an LLM can't hold a
live reference." It can: tool-call arguments pass through the serialization
layer, which carries item references as `@link`s and re-cellifies them on
receipt. Reference addressing is the one identity story for code *and* agents.
(Per-caller natural-language conveniences like do-list's title-addressed
handlers are a caller's own agent API, justified by that caller's usage — they
are not part of a primitive contract.)

These rules are enforced as critic checks
(`docs/common/ai/pattern-critique-guide.md` §15) and applied across the real
list patterns (do-list, store-mapper, fair-share, shopping-list,
habit-tracker, project-list, budget-tracker, map-demo — the
identity-preserving update sweep, #4085).

## Headless vs default rendering

- **Default (rendered):** drop the primitive in your vdom and render its
  `[UI]`. The default UI may be opinionated about data shape; that assumption
  applies *only* to the default UI and must be documented on the item type.
- **Headless (logic only):** embed for the model, render your own markup,
  drive the exposed streams from your own event handlers. A headless caller
  may ignore the default UI's shape assumptions entirely.
- Schema-extras caveat: an index-signature passthrough carries **plain data
  only**. `additionalProperties: true` has no `asCell` marker, so a
  `Writable<>` / cell-link extra is **not** re-hydrated as a live Cell when
  read back through the schema. A nested *live* cell must be a typed field
  with `asCell`.
- Event-payload caveat: do not type stream payloads as `Partial<Item>` when
  `Item` carries `Default<>` annotations — the event schema fills absent
  fields with their defaults and clobbers `{ ...current, ...changes }` merges.
  Use a plain-optionals patch type.

### Why no render-prop / VNode input

A primitive does **not** accept a "render each row" callback or `VNode` input.
Render props and VNode-valued inputs fight the CTS transformer and the
reactive reconciler (`[UI]` must be a static VNode; passing functions/VNodes as
reactive inputs leads to "unexpected object" reconciler errors). The headless
path — consume cells + streams, render your own markup — achieves full custom
rendering without that machinery.

## Authoring checklist

- A named, real adopter exists before you write code (see entry bar).
- Item/state types carry whatever the model needs — **no `id` field**.
- Core handlers address items by live reference (`equals()` /
  `cell.remove(item)`); updates write through element cells, never slot
  replacement.
- Counts / derived values are **named `computed` cells** (so they resolve
  through `runSynced` + `.get()` in tests).
- `[UI]` is a static `VNode`; gate empty/non-empty with `ifElse` as a *child*
  of a static wrapper, never by wrapping `[UI]` in `computed()`.
- Default UI uses `$checked` / `$value` two-way binding — no setter handlers
  that write the same value back.
- No string-addressed mutation layers: agents pass references through
  tool-calls like any other caller.
- Tests include a **held-reference survival** sequence: stash an item in a
  `Writable` cell, mutate it through the primitive, then operate via the
  stashed reference and assert it still works.

## Lessons from the first primitive

`EditableList` (an editable, checkable list: reference-addressed
add/remove/update/toggle streams, counts, default checkbox-row UI) was built
to this contract, hardened through three review cycles, and then **retired
under the kill criterion** — both delivery paths failed against real callers:

- **Headless embeds grew their callers** (+22/+9 non-comment LOC on
  simple-list/do-list): callers with custom rows still hand-write everything
  the primitive doesn't model, *plus* the embed and shape-alignment. A
  logic-only embed can't shrink a caller whose code is mostly rendering — and
  with `equals()`-idiom handlers at 3–5 lines each, the logic being shared was
  too small to pay for the contract surface.
- **The rendered path had zero compatible callers**: every real checklist keys
  its text off `title`/`text` (not the primitive's `label`), and behind the
  key sits each caller's actual personality — archive splits, card wrappers,
  custom adders — that a generic default UI cannot express with behavior
  parity.

What survived is what you are reading: the contract, the identity rules (which
hardened eight real patterns in the identity-preserving update sweep), the
critic checks, and the held-reference test technique. The durable lesson on
**chunk size**: the duplication a census counts is necessary but not
sufficient — the reusable unit must also be *bigger than the glue needed to
adopt it* and *smaller than the per-caller personality it sits inside*.
Candidate primitives should be sized accordingly, and pure-logic helpers
(plain modules — the `(m)` tier in the Pattern Primitives design doc, PR
#4039) considered before sub-patterns.

## See also

- [Pattern Composition](./composition.md) — the embedding mechanics.
- [Reactivity](../concepts/reactivity.md) — why `Writable<>` shares a cell.
- The Pattern Primitives design doc (`docs/features/PATTERN_PRIMITIVES.md`,
  landing via PR #4039) — the census, tiers, and process this tier plugs into.

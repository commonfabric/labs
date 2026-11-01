---
name: pattern-implement
description: Build Common Fabric patterns and sub-patterns
user-invocable: false
---

Use the `cf` skill, or read `skills/cf/SKILL.md`, for CLI documentation when
running commands.

# Implement Pattern

## Core Rule

Match the implementation mode to the task.

For a top-level pattern, implement what the brief or spec describes, and any UX
or UI design that comes with it. Use sub-patterns only when they make the
implementation clearer.

For an isolated sub-pattern task, write one sub-pattern with minimal UI first so
data flow can be verified before polish.

**Always use `pattern<Input, Output>()`** - expose actions as `Stream<T>` for
testability.

## Order

1. Leaf patterns first (no dependencies on other patterns)
2. Container patterns (compose leaf patterns)
3. main.tsx last (composes everything)

## Read First

- The reads mandated by pattern-dev:
  `docs/common/ai/pattern-development-guide.md` (especially the SES authoring
  limits and escape-hatch guidance), `docs/common/concepts/reactivity.md`, and
  `docs/common/patterns/new-cells.md`
- `docs/common/patterns/` - generalizable pattern idioms
- `docs/common/concepts/action.md` - action() for local state
- `docs/common/concepts/handler.md` - handler() for reusable logic
- `docs/common/concepts/identity.md` - equals() for object comparison
- `docs/common/patterns/multi-user-patterns.md` - Presenting Identity (viewer
  via `#profile`, every participant rendered with `cf-profile-badge` bound to
  their stored profile cell — `cf-avatar` + snapshot only as an offline
  fallback, roster built by join storing the live profile cell) when the pattern
  has multiple people or a current-user concept

## Key Patterns

**action()** - Closes over local state in pattern body:

```tsx
const inputValue = new Writable("");
const submit = action(() => {
  items.push({ text: inputValue.get() });
  inputValue.set("");
});
```

Use `new Writable()` only for pattern-owned local cells initialized from static
values. Do not pass an input prop, mapped field, computed value, or other
reactive value into `new Writable()`. If the pattern receives writable state,
use that input cell directly; if a draft needs to copy from input state, copy in
an action or another valid reactive/event context.

This rule applies to the top-level pattern input object too. Do not initialize
local state with `new Writable(input.name || "")`,
`new Writable(input.items || [])`, `new Cell(input.field)`, or helper calls
around `input.field`. First decide whether each field is primary pattern state,
static local UI state, or draft/editing state:

- Primary pattern state: expose it in the `Input`/`Output` contract with
  `Default<>` and `Writable<>` as needed, then use the reactive input directly.
- Static local UI state: create it with `new Writable(...)` from static literals
  only.
- Draft/editing state: create it from a static value, then copy from input state
  inside an `action()` or another valid event/reactive context.

Transient UI state (active tab, selected item, filter text, open modal): apply
the PerSession new-tab test from the pattern-dev skill.

When a pattern needs explicit time or randomness, call the JavaScript built-ins
directly: `Date.now()` (or `new Date()`) for the clock and `Math.random()` for
entropy. These are gated inside a pattern sandbox — allowed only inside a
handler, where the clock is coarsened to one-second resolution — and throw a
`TimeCapabilityError` in a `computed()`/`lift()` or at pattern-body level. To
read a live clock reactively in a `computed()`, use the `#now` wish instead. If
a control is already bound to a cell, usually via `$value` or `$checked`, let
that binding own the control value. Use `oncf-change` / `oncf-input` only for
dependent state or other side effects.

Do not invoke streams or writes while assigning JSX event props. For example,
`onClick={selectItem.send(index)}` runs during render; use
`onClick={() => selectItem.send(index)}` or a bound `handler()` instead. This is
especially important inside `.map()` bodies because render-time writes can make
`raw:map` non-idempotent.

**handler()** - Reused with different bindings:

```tsx
const deleteItem = handler<void, { items: Writable<Item[]>; index: number }>(
  (_, { items, index }) => items.set(items.get().toSpliced(index, 1)),
);
// In JSX: onClick={deleteItem({ items, index })}
```

**Rendering sub-patterns** - Function calls and JSX both work (verified: both
forms pass `cf check` with a typed Output interface):

```tsx
// ✅ Function call form
return <>{items.map((item) => ItemPattern({ item, allItems: items }))}</>;

// ✅ JSX form
return <>{items.map((item) => <ItemPattern item={item} />)}</>;
```

The sub-pattern's Output type must include `[UI]: VNode` — see
`docs/common/patterns/composition.md`.

## Done When

- Pattern compiles: `deno task cf check pattern.tsx --no-run`
- The top-level UI or sub-pattern UI renders the behavior needed for the task
- New behavior is structured so tests can exercise it through typed streams,
  handlers, or observable state
- Ready for testing

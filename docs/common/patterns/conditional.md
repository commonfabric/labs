## Prefer Plain Ternaries

Use regular ternary operators directly in normal pattern code. On current main,
the transformer handles ordinary authored ternaries in JSX and most other
common value-expression positions, so you usually do not need to author
`ifElse()` directly.

```tsx
// Shown for illustration only.
// JSX expressions
{show ? <div>Content</div> : null}

// JSX prop/text values
<button disabled={loading}>
  {loading ? "Loading..." : "Load"}
</button>
<div style={{ opacity: done ? 0.6 : 1 }}>
  {done ? "Done" : "Todo"}
</div>

// Variable initializers
const modalTitle = editing ? "Edit Person" : "Add Person";

// Nested ternaries work too
{score >= 90 ? "A" : score >= 80 ? "B" : "C"}
```

This includes JSX expressions, common returned values, variable initializers,
object properties, logical `&&` / `||` forms, and many callback-local
expressions (pattern-owned sites and supported collection callbacks). If
you're debugging a less common site,
inspect the emitted source with
`deno task cf check <pattern>.tsx --show-transformed` rather than guessing
about the lowering.

One caveat: ternaries lower to `ifElse(cond, branchA, branchB)`, and both
branches are evaluated eagerly as arguments — they do not short-circuit. So
`{maybeItem ? maybeItem.label : "none"}` dereferences `.label` even when
`maybeItem` is null. Property access on a nullable reactive value inside a
branch needs `computed()` deferral; see
[Eager Ternary Branch Evaluation](../../development/debugging/gotchas/eager-ternary-branch-evaluation.md).

A ternary's result is a reference to the branch the condition selected, not a
copy of its value, and the reference carries that branch's schema. So an input
declared with a `Default` and returned through a ternary, or through `&&` or
`||`, reads as its default when the input holds no value, exactly as the input
itself does.

## Showing and Hiding Through a Prop

A ternary in child position renders nothing until its condition has a value,
so the element it guards stays out of view while the pattern loads. A pattern
that shows or hides an element through a prop instead, as
`style={{ display: shown }}`, loses that: the renderer drops a declaration
whose value is `undefined`, so until `shown` first runs the element is drawn
with its default display, which is visible. On a cold load that can be
seconds of controls and rows that should not be there.

Give such an element a static `hidden` as well:

```tsx
// Shown for illustration only.
<div hidden style={{ display: editorDisplay }}>
  {/* … */}
</div>
```

`hidden` keeps the element out of view until `editorDisplay` has a value,
and an inline `display` outranks `hidden` once it has one, so the computed
alone decides from then on. A `cf-` component honors `hidden` the same way.
FabriChat (`packages/patterns/fabrichat/`) hides per-viewer and per-session
controls this way, for the reason its `FabriChatMessageRow` states.

The element stays hidden for as long as the computed has no value for the
viewer. A computed that reads per-user or per-session state has a value for a
viewer only once something runs the pattern for that viewer, and a page that
only renders a piece, through `cf-render` for instance, does not run it. With
server execution off, nothing runs it for the viewer until an event of theirs
reaches it. An element every viewer must see takes its
display from a computed that reads shared state alone, which whichever runtime
runs the pattern computes for everyone. When the element is shown in one place
by shared state and in another by per-session state, as a FabriChat message is
in the conversation and in a thread, give each its own computed and choose
between them with a ternary on the prop, so that the shared case never reads
the per-session one.

## Keep `computed()` for Data, Not UI Gating

Inside a `computed()` body, ternaries and logical operators stay plain
JavaScript even when nested inside returned JSX. That means
`Writable<boolean>` values are still just truthy objects there — the most
common source of "conditional section always renders" bugs. The recursive
lowering does not rescue explicit compute callback bodies.

Use plain ternaries in normal pattern code instead of wrapping JSX in
`computed()`. If you're unsure whether a site lowers the way you expect,
inspect it with
`deno task cf check <pattern>.tsx --show-transformed`.

## See Also

- [computed()](../concepts/computed/computed.md) — when to derive data vs gate UI
- [View Switching](./view-switching.md) — switching between entire sub-patterns or cell references

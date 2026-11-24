# `(cellCall() ?? []).map(...)` nested in another `.map(...)` — if you mean the cell, just map the cell

**Symptom (pre-CT-1626 runtimes):** pattern instantiation aborts (no UI
renders, `cf test` fails fast) with one of these strings:

> Reactive reference from outer scope cannot be accessed via closure. Wrap the
> access in a computed() that passes the variable through, which
> handles this automatically.

> Cannot access cell via closure - reactive dependencies must be explicit
> parameters.

The construction-time abort was fixed at the transformer layer (CT-1626 /
PR #3726), but the shape remains a **code smell**: writing
`(cell.get() ?? []).map((p) => p.name)` inside a row `.map` hides the cell
behind a `?? []` guard. The `?? []` should be a clear signal that you mean a
plain array — if you mean the cell, just map the cell.

```tsx
// Shown for illustration only.
// 🚫 The anti-pattern: (reactiveCall() ?? plainFallback).map(…)
//    inside an outer .map((row) => …)
{rows.map((row) => (
  <div>
    {row.label}
    {(people.get() ?? []).map((p) => (
      <button onClick={() => setAssign.send({ name: p.name })}>{p.name}</button>
    ))}
  </div>
))}
```

## Three idiomatic recipes (in preference order)

### A — Map the cell directly (preferred)

```tsx
// Shown inside a pattern body.
{rows.map((row) => (
  <div>
    {row.label}
    {people.map((p) => (
      <button onClick={() => setAssign.send({ name: p.name })}>{p.name}</button>
    ))}
  </div>
))}
```

No `.get()`, no `??`. The transformer sees the cell receiver and handles
captured pattern-scope refs for you.

### B — Pre-bake into a top-level `computed`, then `.map`

When you need to *transform* the list first (filter empties, project to names,
etc.) — do it at the top level once, not per row:

```tsx
// Shown for illustration only.
const peopleNames = computed(() =>
  (people.get() ?? []).map((p) => p.name).filter((n) => (n ?? "").trim() !== "")
);

// …in JSX:
{rows.map((row) => (
  <div>
    {row.label}
    {peopleNames.map((name) => (
      <button onClick={() => setAssign.send({ name })}>{name}</button>
    ))}
  </div>
))}
```

The receiver is now a Reactive again; the transformer rewrites the inner
`.map`. Shipping example: `patterns/dev/factory-outputs/lot-watch/main.tsx`
— the hoisted `people` receiver, consumed inside the sightings rows by the
quick-pick chips
(`people.map((p) => … setAssignPersonName.send({ name: p.name }))`).

Note the contrast: the *top-level* `(people.get() ?? []).map(…)` inside a
`computed()` is fine; the *nested-per-row* form is the smell.

### C — Local `computed()` bridge inside the row callback

Only when neither A nor B is structurally possible:

```tsx
// Shown inside a pattern body.
{rows.map((row) => {
  const chips = computed(() => people.map((p) => p.name));
  return <div>{chips.map((n) => <button>{n}</button>)}</div>;
})}
```

Not to be confused with the
[perSession-in-mapped-computed gotcha](./persession-read-in-mapped-computed.md),
which fails *silently* at link-resolution time and has a different fix.

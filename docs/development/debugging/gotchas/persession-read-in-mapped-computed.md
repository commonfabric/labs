# perSession read inside a `computed()` nested in a mapped `computed()` list

**Symptom:** A list of rows has a per-row inline form (delete-confirm, edit form,
picker) gated on per-row open-state, computed *inside* the map:

```tsx
// Shown for illustration only.
{rows.map((row) => {
  const isOpen = computed(() => openTarget.get() === row.id); // openTarget is perSession
  return <>{isOpen ? <Form/> : <button onClick={() => open.send({ id: row.id })}/>}</>;
})}
```

Clicking the trigger does **nothing** — the `{isOpen ? … : …}` ternary never
flips. **No compile error, no runtime error** — just a permanently dead control.
Sibling buttons that mutate a **perSpace** cell work fine, and a *top-level*
perSession read (e.g. a tab gate `{selectedTab.get() === "x" ? …}`) reacts fine,
which makes it hard to localize.

## The boundary (verified by contrast)

The failure is tied to **what you're mapping**, not merely to reading a
perSession cell in a `.map()`:

- ❌ **FAILS — mapping a `computed()`/`lift`-produced list** (rows are plain
  objects). `lot-watch`'s `sightingRows = computed(() => sightings.get().map(…))`
  with a per-row `computed(() => guestTarget.get() === row.id)` never opened the
  form. (Verified before/after.)
- ✅ **WORKS — mapping a reactive cell/input directly.** `cozy-poll`'s
  `options.map((option) => { const isRemoveConfirm = computed(() =>
  removeConfirmTarget.get() === option.id); … })` opens **and** closes the
  confirm correctly. (Verified.) Here each mapped element is a live reactive
  handle, so the nested `computed` can still follow into the perSession cell.

Underlying this is a runner rule: following a link into a **narrower** scope
(`perSession` is narrower than `space`) is blocked from a space-scoped reading
context, **silently** (`packages/runner/src/scope.ts:61-69`, enforced via
`traverse.ts`/`link-resolution.ts`, pinned by `schema-links.test.ts`). When the
mapped rows are plain objects emitted by a `computed()`, the per-row `computed`
runs in that space-scoped context and the follow is blocked; mapping a live cell
keeps a per-element context that resolves. (The exact trigger isn't fully pinned —
treat "mapping a computed-produced list" as the danger sign, and verify.)

## Fix — bake the flag into the producing `computed()`

When the list comes from a `computed()`/`lift`, read the perSession cell once
at the top (a top-level read resolves) and emit a **plain boolean per row**, so
no per-row perSession follow is needed:

```tsx
// Shown for illustration only.
const rows = computed(() => {
  const openId = openTarget.get();            // read perSession HERE, at top level
  return myPerSpaceCell.get().map((r) => ({
    ...r,
    isOpen: openId === r.id,                  // plain boolean baked in
  }));
});
// …in JSX, read the plain field:
{rows.map((row) => (row.isOpen ? <Form/> : <button onClick={() => open.send({ id: row.id })}/>))}
```

This needs a `.get()`-able list cell — a pattern-local `new Writable.perSpace<T[]>`
or an input typed `PerSpace<Writable<T[]>>` (e.g. parking-coordinator's
`people?: PerSpace<PeopleCell>`). An input typed `PerSpace<T[]>` (bare array, e.g.
cozy-poll's `options`) intentionally has no `.get()` in the body — but it's
mapped **directly**, which is the case that already works, so it needs no fix.

### Substitutes that look right but FAIL (when mapping a computed-produced list)

- Lifting the session value into a `computed()` then feeding it to a
  row-producing `lift`/`computed` bridge: the derived list inherits **session
  scope** and renders an **empty** list when mapped in a space-scoped render.
- A per-row `computed()` bridge over `{ openId, id }` inside the map: never
  re-renders.
- `equals()` + a boxed reference via a lifted `computed`: never flips.

Setting the perSession cell from an `onClick`/action is **not** affected — only
the nested *read* (when mapping a computed-produced list) is.

### What baking it in costs under server execution

The producing `computed()` now reads the session's state, so under server
execution it runs once for every session, and so does everything downstream of
it; a client runtime runs only its own session's. Where that list is large or
feeds other derivations, keep the rows cells, render each with a row pattern
handed the row and the perSession cell as inputs, and read the cell at the row
pattern's top level. FabriChat's message row
(`packages/patterns/fabrichat/message-row.tsx`) reads its session's editor and
picker state that way, for each message cell of a list the room's `computed()`
produces. See
[per-viewer work](../../../common/patterns/multi-user-patterns.md#per-viewer-work).

**Verify:** deploy, click the per-row trigger, confirm the inline form opens
*and* closes. The minimal repro: a per-row `computed` over a perSession cell,
mapping a `computed(() => perSpaceCell.get())` list — perSpace control flips,
perSession doesn't.

**Known-good references:**
`lot-watch/main.tsx` (`sightingRows`, spot picker) and
`parking-coordinator/main.tsx` (`adminPeopleData`/`adminSpotsData`) both bake the
flag into the producing computed. `cozy-poll/main.tsx` maps `options`
directly and needs no change.

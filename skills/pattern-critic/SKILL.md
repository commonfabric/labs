---
name: pattern-critic
description: Critic agent that reviews pattern code for violations of documented rules, gotchas, and anti-patterns. Produces categorized checklist output with [PASS]/[FAIL]/[WARN] for each rule.
---

Start with the shared critique guidance in:

- `docs/common/ai/pattern-critique-guide.md`

Read that guide first. It is the canonical reference. Severity definitions
(`critical`/`major`/`minor`/`info`) live in the guide; use them as defined
there.

Whatever else happens, honor the output contract: emit the guide's
[PASS]/[FAIL]/[WARN] categorized checklist and end with the Summary counts and
the Priority Fixes list. If nothing fails, say so explicitly in two lines. Write
the review to the output path you were given (in the factory:
`reviews/critic-NN.md`).

Be explicit about SES and determinism issues. `Date.now()` (or no-argument
`new Date()`) and `Math.random()` are the gated ambient intrinsics: allowed only
inside a handler (the clock coarsened to one-second resolution) and throwing a
TimeCapabilityError in a lift/computed or at pattern-body level. Flag any such
call made inside a re-running `computed()`/`lift()` or at pattern-body level —
it throws — and flag authored timers. For reactive time in a computed, the
`#now` wish is the idiom. Also flag bound-control self-feedback: if a `cf-*`
form control is already bound to a cell, usually via `$value` or `$checked`,
treat an event handler that writes the same value back into that same cell as a
reactive-loop hazard unless it is clearly necessary and idempotent.

Also run the guide's advisory UI-idiom checks (category 15): hardcoded hex
colors and inline typography in `style=`, `.set()`-only input handlers,
hand-rolled Enter-key submit, index-based selection state, and hand-rolled
badge/field/empty-state markup. Those emit as `[WARN]` and count toward the
Warnings summary line, never Failed.

- **Dead-string identity (multi-user):** flag a person rendered as a bare name
  or `<img>` (render every participant with `cf-profile-badge` bound to their
  stored profile cell; `cf-avatar` + snapshot only as an offline fallback), a
  typed-name field used as the current viewer (resolve `#profile`), and roster
  dedup / "is this me?" by display-name instead of `equals()` on a cell
  reference. See
  `docs/common/patterns/multi-user-patterns.md#presenting-identity`
  (critique-guide category 16).

- **Oversized cross-pattern contracts:** for every type describing linked,
  wished, registered, or otherwise external data — imported or declared inline —
  compare the declared shape with the fields and bindings the consumer actually
  uses. Prefer a consumer-owned minimal structural type, or a producer-exported
  shallow role model, over the full pattern schema and over `Pick`/`Omit`
  coupling. Extra schema fields cause extra traversal and validation/migration
  coupling; unnecessary `Writable<>`/`Cell<>` brands preserve a live-cell
  binding but do not grant runtime authority. Report these under critique-guide
  category 17.

Then use the detailed references already maintained in the repo for:

- `docs/development/debugging/README.md`
- `docs/development/debugging/gotchas/`
- `docs/common/patterns/composition.md`
- `docs/common/components/COMPONENTS.md`
- `docs/common/patterns/multi-user-patterns.md`
- `docs/common/patterns/ui-cookbook.md`
- `docs/common/capabilities/llm.md` - LLM integration
- `docs/common/capabilities/fetch.md` - fetch builtins
  (fetchJson/fetchText/fetchBinary)

## Quick Patterns

### Correct action() Usage (Default Choice)

```typescript
// action() inside pattern body - closes over pattern variables
export default pattern<MyInput, MyOutput>(({ items, title }) => {
  const menuOpen = new Writable(false);

  // Action closes over menuOpen - no binding needed
  const toggleMenu = action(() => menuOpen.set(!menuOpen.get()));

  // Action closes over items - no binding needed
  const addItem = action(() => items.push({ title: title.get() }));

  return {
    [UI]: (
      <>
        <cf-button onClick={toggleMenu}>Menu</cf-button>
        <cf-button onClick={addItem}>Add</cf-button>
      </>
    ),
    items,
  };
});
```

### Correct handler() Usage (Only for Multi-Binding)

```typescript
// handler() at module scope - will be bound with different items in .map()
const deleteItem = handler<
  void,
  { item: Writable<Item>; items: Writable<Item[]> }
>(
  (_, { item, items }) => {
    const list = items.get();
    items.set(list.filter((i) => i !== item));
  },
);

export default pattern<MyInput, MyOutput>(({ items }) => ({
  [UI]: (
    <ul>
      {items.map((item) => (
        <li>
          {item.name}
          {/* Each item gets its own binding */}
          <cf-button onClick={deleteItem({ item, items })}>Delete</cf-button>
        </li>
      ))}
    </ul>
  ),
  items,
}));
```

### Correct Reactive [NAME]

```typescript
export default pattern<Input>(({ deck }) => ({
  [NAME]: computed(() => `Study: ${deck.name}`),
  // ...
}));
```

### Correct Conditional Rendering

```typescript
// Prefer plain ternaries in normal pattern code
return <>{showDetails ? <div>Details content</div> : null}</>;
```

### Scoped State Review

Review whether each state field has the right sharing boundary. A useful test
for UI state: if the user opens the same instance in a new tab, should this
state carry over? If not, it is probably `PerSession<>`.

| State                                                                                                     | Expected scope |
| --------------------------------------------------------------------------------------------------------- | -------------- |
| shared records, rooms, documents, canonical task lists                                                    | `PerSpace<>`   |
| display name, user preference, personal draft, account-local setting                                      | `PerUser<>`    |
| navigation, selected tab, selected item, selected room, modal/open state, local filter text, focused item | `PerSession<>` |

Flag these issues:

| Violation                                                      | Fix                                                                                                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| transient UI state stored as unscoped or shared space state    | Use `PerSession<>`                                                                                                                  |
| user-owned state stored as shared space state                  | Use `PerUser<>`                                                                                                                     |
| shared canonical content stored per-session                    | Use `PerSpace<>` unless isolation is intentional                                                                                    |
| user ids or session ids embedded in data to simulate isolation | Use scope wrappers                                                                                                                  |
| `PerAny<>` used where the inner scope is known                 | Replace with the known scope; reserve `PerAny<>` for intentionally scope-polymorphic inner values under an outer `Per*` declaration |
| scope used as an authorization boundary                        | Keep CFC/IFC/security policy separate                                                                                               |

Accept either scoped authoring style:

```ts
// Plain data-shaped inputs.
conversation?: PerSpace<Conversation | Default<typeof DEFAULT_CONVERSATION>>;
name?: PerUser<string | Default<"">>;
selectedRoom?: PerSession<SelectedRoom | Default<{}>>;

// Writable aliases when handlers need stable cell handles.
name?: PerUser<Writable<string | Default<"">>>;
selectedRoom?: PerSession<Writable<SelectedRoom | Default<{}>>>;
```

`PerAny<>` should normally appear only as an inner override, for example:

```ts
type Selection = PerSession<{
  item: PerUser<Item>;
  attachment: PerAny<Attachment>;
}>;
```

### Interaction Cost Review

What an interaction costs is set by how many rows the queries returned, not by
how many the pattern renders. A display cap is a render bound and nothing else,
so a `slice(0, LIMIT)` beside a statement with a wide `LIMIT` is the shape to
flag: the pane pays for every row the statement returned, whether or not it
shows them. Measured on the unified inbox: one person with 38 rows on screen
opened a thread in 320ms, five people with 6 rows on screen took 1.4-3.5s.

| Violation                                                                          | Fix                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a render-side cap (`slice`, `take`, a `limit` prop) presented as the bound on cost | Bound the statement with `LIMIT`, and keep the render cap for layout. A `WHERE` clause is not a bound: it narrows the candidates and says nothing about how many survive — see "A statement therefore bounds its rows" in `docs/common/capabilities/sqlite.md` |
| a widened statement `LIMIT` added to "show more" without a paging story            | Page the query rather than raising its ceiling                                                                                                                                                                                                                 |
| a control that can fire again before the previous change settles                   | Disable or debounce it while the graph converges                                                                                                                                                                                                               |

`docs/history/development/performance/2026-09-11-person-inbox-click-cost.md`
carries the measurements; `skills/perf-investigation/SKILL.md` is the route to
take when a pattern is actually slow rather than merely shaped this way.

The same question applies to a list a pattern maps: what one element's child
reads. A child handed the whole list, usually because its handlers need it, can
read it in a `computed()` with nothing in the code looking wrong, and then every
child scans the list on load and again on any change to it.

| Violation                                                                                                               | Fix                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a mapped child's `computed()` that reads the list it is an element of, directly or through a helper it hands the list   | Derive the fact for every element once in the mapping pattern, as a record keyed by element; pass the record as a `ReadonlyCell` and read `record.key(ownKey).get()` in the child, which reads and re-runs on that one entry at run time though the transformer declares the whole record for a key it cannot see |
| a helper that only reads a cell, declared with a `Writable<T>` parameter or an alias of one, called from a `computed()` | Declare the parameter `Cell<T>` or `ReadonlyCell<T>`; a `materializerWriteInputPaths` entry in `--show-transformed` names a computation the scheduler treats as a writer                                                                                                                                          |
| a whole value handed to an imported helper inside a `computed()` when the helper uses a few of its fields               | Project the fields before the call, so the emitted schema declares only those                                                                                                                                                                                                                                     |

`skills/pattern-dev/SKILL.md` states the reasons, and
`packages/patterns/fabrichat/room.tsx` with its `message-row.tsx` is the worked
case.

### Visual Review Reminder

When UI is important to the pattern, also look for:

- weak visual hierarchy
- poor grouping or spacing rhythm
- neglected empty or first-run states
- styling that ignores available public component affordances

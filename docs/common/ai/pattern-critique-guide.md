# Pattern Critique Guide

This is the canonical reference for reviewing Common Fabric patterns.

## Review Goals

A pattern review should check:

- documented convention violations
- correctness and robustness risks
- reactivity and data-flow issues
- maintainability and cohesion
- regressions when modifying existing code

Reviews should produce line-referenced findings where practical, concrete fix
guidance, and a short priority list at the end.

## Violation Categories

### 1. Module Scope

Check that these are not inside the pattern body:

| Violation | Fix |
|-----------|-----|
| `handler()` defined inside pattern | Move to module scope, or use `action()` instead |
| `lift()` immediately invoked (`lift(...)(args)`) | Use `computed()` or define lift at module scope |
| helper functions defined inside pattern | Move to module scope |
| top-level `let`, `var`, or class | Convert to `const` plain data, or move stateful logic into actions, handlers, or helpers |
| `setTimeout()` or `setInterval()` in authored pattern code | Use a reactive/runtime primitive instead; authored timers are not part of the sandbox and do not compile |

Allowed inside patterns:

- `computed()`
- `action()`
- `.map()` callbacks
- JSX event handlers

### 2. Reactivity

| Violation | Fix |
|-----------|-----|
| `[NAME]: someProp` | `[NAME]: computed(() => someProp)` |
| `[NAME]: \`text ${someProp}\`` | `[NAME]: computed(() => \`text ${someProp}\`)` |
| `new Writable(reactiveValue)` | Initialize empty, set in handler or action |
| `.get()` on computed or lift result | Access directly; only `Writable` uses `.get()` |
| `items.filter(...)` inline in JSX | Wrap in `computed()` outside JSX |
| `items.sort(...)` inline in JSX | Wrap in `computed()` outside JSX |
| `Date.now()`/`new Date()` or `Math.random()` in a `computed()` or `lift()`, or at pattern-body level | These built-ins throw a `TimeCapabilityError` outside a handler; read them in `action()`/`handler()`, or use the interval `#now/N` wish for reactive time (bare `#now` is a frozen one-shot) |
| `Date.now()`/`new Date()` or `Math.random()` inside a re-running computation (`computed()` or `lift()`) without clear intent | Move the snapshot into `action()`, `handler()`, or one-time initialization |
| nested computed with outer-scope reactive vars | Pre-compute with lift or an outer computed |
| `lift()` closing over reactive deps | Pass dependencies as explicit parameters |
| cells from composed patterns in `ifElse` | Wrap in a local `computed()` bridge |
| reactive computation inline in builder-call args, e.g. `join({ x: a ?? b.result })` | Hoist to a body-level const or `computed()` and bind that (the compiler rejects the inline form) |

### 3. Conditional Rendering

| Violation | Fix |
|-----------|-----|
| `onClick` or conditional UI inside `computed()` | Move the interactive element outside and use direct JSX conditionals |

Plain ternaries are generally valid in normal pattern code. Prefer direct
authored expressions over helper-owned conditional workarounds unless a site
has been explicitly verified as problematic.

### 4. Type System and Data Shape

| Violation | Fix |
|-----------|-----|
| array without `T[] | Default<[]>` where undefined would be invalid | Add a sensible default |
| missing `Writable<>` wrapper on values later mutated | Add `Writable<T>` to the relevant type |
| `Map` or `Set` in serialized cell data | Use plain objects or arrays |
| custom identity field where `equals()` is intended | Use `equals()` instead of ad hoc identity |

### 5. Binding

| Violation | Fix |
|-----------|-----|
| `checked={item.done}` | `$checked={item.done}` |
| `value={title}` | `$value={title}` |
| `$checked={item}` | `$checked={item.done}` |
| wrong event name | Use `oncf-send`, `oncf-input`, or `oncf-change` |
| cell-bound control (for example `$value={status}`) with `oncf-change` writing `status.set(...)` | Let the binding own the control value; use the handler only for dependent state or side effects |
| any `$`-binding (`$value`/`$checked`/`$profile`/…) inside a `computed(() => …)` subtree → throws *"Bidirectionally bound property … is not reactive"* and **blanks the whole render** | Hoist the `$`-binding to a **static** `[UI]` position; switch views with `ifElse(cond, staticA, staticB)` as a child of a static wrapper, or lift behind a `pattern<{…}>` sub-pattern. Repro: `packages/patterns/scope-bug-computed-vnode-blank/` |

### 6. Custom Component Props and Styling Affordances

Check that Common Fabric component props use the correct camelCase names and
that the implementation uses public styling affordances intentionally rather
than guessing at unsupported internals.

| Violation | Fix |
|-----------|-----|
| kebab-case props on `cf-*` | Use camelCase, for example `allowCustom` |
| styling through guessed shadow-internal selectors | Prefer documented custom properties, parts, or theme hooks |
| arbitrary one-off visual overrides where theme/custom properties would work | Prefer public styling affordances with fallbacks |

### 7. Handler Binding

| Violation | Fix |
|-----------|-----|
| state bound where runtime event data should be used | Bind only stable state and let event data arrive at runtime |
| handlers created repeatedly inside `.map()` | Create one shared handler and bind item-specific data |

### 8. Stream and Async Usage

| Violation | Fix |
|-----------|-----|
| `new Stream()` | It does not exist; the bound handler is the stream |
| `.subscribe()` on a stream | Return the stream from the pattern instead |
| `async/await` in handlers | Use reactive APIs such as `fetchJson()` instead |
| `await generateText(...)` | Call it in the pattern body and use `resultOf(request)` |
| `await generateObject(...)` | Call it in the pattern body and use `resultOf(request)` |

### 9. LLM Integration

| Violation | Fix |
|-----------|-----|
| array schema at the root of `generateObject` | Wrap it in an object such as `{ items: T[] }` |
| a pattern output field whose type is left to inference | Declare an explicit Output type, `pattern<Input, Output>(...)` |
| prompt derived from agent-written cells | Split the source cells to avoid loops |
| invalid model-name format | Use `vendor:model` |

### 10. Performance

| Violation | Fix |
|-----------|-----|
| handler created per item inside a loop | Create a shared handler and bind per item |
| expensive computation embedded directly in render loops | Pre-compute outside the loop |

### 11. Action vs Handler Choice

Prefer `action()` by default. Use `handler()` when different data must be bound
to different handler instantiations.

Fail when:

- `handler()` is used with no multi-binding need
- `action()` is created per item in a `.map()` and should be a shared handler

| Violation | Fix |
|-----------|-----|
| `handler()` used with no multi-binding scenario | Convert to `action()` inside the pattern body |
| `handler()` when all instantiations use the same data | Convert to `action()` |
| `action()` inside `.map()` creating one action per item | Use `handler()` at module scope with binding |

When to use `action()`:

- the handler is specific to one pattern
- it closes over pattern-scope variables
- all instantiations use the same closed-over data

When to use `handler()`:

- different data must be bound per instantiation
- the same handler implementation is reused in multiple places
- you are binding per-item behavior in `.map()`

### 12. Design Review

| Check | What to look for |
|-------|------------------|
| clear entity boundaries | each pattern represents one concept |
| actions match user intent | handler names match what the user wants to do |
| unidirectional data flow | parents own state, children receive props |
| normalized state | no duplicate data, single source of truth |
| self-documenting types | type names and field names are clear without comments |
| appropriate granularity | neither too fine nor too coarse |
| visual hierarchy | important content and actions read clearly at a glance |
| spacing and grouping | related elements are grouped; the layout does not collapse into a raw form dump |
| empty and first-run states | zero-data flows are understandable and actionable |
| theme/styling stance | theme hooks, custom properties, or parts are used intentionally when relevant |

### 13. Scoped State (PerSession / PerUser / PerSpace)

Review whether each state field has the right sharing boundary. A useful test
for UI state: if the user opens the same instance in a new tab, should this
state carry over? If not, it is probably `PerSession<>`.

| State | Expected scope |
|-------|----------------|
| shared records, rooms, documents, canonical task lists | `PerSpace<>` |
| display name, user preference, personal draft, account-local setting | `PerUser<>` |
| navigation, selected tab/item/room, modal state, local filter text, focused item | `PerSession<>` |

| Violation | Fix |
|-----------|-----|
| transient UI state stored as unscoped or shared space state | Use `PerSession<>` |
| user-owned state stored as shared space state | Use `PerUser<>` |
| shared canonical content stored per-session | Use `PerSpace<>` unless isolation is intentional |
| user ids or session ids embedded in data to simulate isolation | Use scope wrappers |
| `PerAny<>` used where the inner scope is known | Replace with the known scope |
| scope used as an authorization boundary | Keep CFC/IFC/security policy separate |

### 14. Regression Check

| Check | What to verify |
|-------|----------------|
| tests still pass | existing tests run cleanly after the change |
| type signatures preserved | or intentionally migrated with a clear reason |
| handlers still work | existing functionality is not broken |
| no unintended side effects | changes stay scoped to the intended area |

### 15. Unidiomatic UI Authoring (advisory)

Findings in this category are warnings, not failures: emit them as `[WARN]`
lines in the checklist, count them under `Warnings` in the summary, and treat
severity as `minor`. The tells below are seed examples, not a boundary — the
underlying principle is: if a shipped `cf-*` component or theme token already
expresses the intent, hand-rolling it is a warning. Where a tell here overlaps category 6's "arbitrary one-off visual
overrides" row, report it once, here, as `[WARN]` — not there as `[FAIL]`.

| Look for | Why it's wrong | Use instead |
|----------|----------------|-------------|
| hex color literals inside `style=` strings or style objects (e.g. `#6b7280`) | bypasses theming; breaks dark mode and per-space themes | `--cf-theme-color-*` semantic tokens (preferred) or `--cf-colors-*` palette tokens — note the plural: no singular `--cf-color-*` family exists |
| `font-size` / `font-weight` inside `style=` (e.g. `"font-size: 0.75rem; color: ..."`) | hand-rolled typography drifts off the type scale | `<cf-text variant="..." tone="...">` |
| a handler whose entire body is `cell.set(event.detail?.value ?? ...)`, wired to `oncf-input`/`oncf-change` | re-implements two-way binding as boilerplate | `$value` / `$checked` on the control |
| `if (event?.key === "Enter")` keydown handlers | re-implements submit by hand | `cf-input` emits `cf-submit` on Enter; multi-field forms use `cf-form` + a submit button |
| `Writable<number>` selection index plus index-adjustment logic when the list mutates | indexes go stale on reorder/insert/remove and force compensation code | hold the selected item itself in a `Writable<Item \| null>` — the stored link survives reorder and removal |
| minted identity fields on items: `id: crypto.randomUUID()` / counters / timestamps used to find rows (`findIndex((x) => x.id === id)`) | the data model already assigns array items stable entity identity; user-land ids fight it (in `.map()` callbacks an `id` property is a Cell, not a string, so lookups fail silently) — see `docs/common/concepts/identity.md` and `docs/development/debugging/gotchas/custom-id-property-pitfall.md` | address items by live reference: `items.remove(item)`, `findIndex((x) => equals(x, item))` |
| string-addressed mutation streams added "for agents" (`removeByText`, `updateByTitle`, id-token APIs) on a NEW pattern/primitive | LLM tool-calls round-trip item references through the serialization layer (`@link`s re-cellify on receipt) — agents send the item like any caller; a parallel string API duplicates identity | expose reference-addressed streams only; an agent grounds words against the data it read, then sends the reference |
| update handlers that replace an array slot with a fresh object literal (`items.set(current.toSpliced(i, 1, { ...current[i], ...changes }))`, or a `.map()` returning `{ ...i, field }` for the matched item) | a fresh literal re-mints the element's entity identity, orphaning every held reference — selection cells and earlier-read items stop `equals()`-matching, so later mutations with them silently no-op | patch fields through element cells: `items.key(i).key(field).set(value)`; structural remove/clear may still rebuild the array |
| inline `padding` + `border-radius` + `background` pill/badge blobs; hand-rolled label-above-input stacks; hand-rolled centered "no items" divs | re-implements shipped components, each slightly differently | `cf-badge` / `cf-chip`; `cf-field` for labeled controls; `cf-empty-state` for empty lists |

Do not warn on:

- `var(--cf-...)` references inside `style=` — tokens in inline style are the
  idiom for one-off layout. Exception: a reference to the undefined singular
  family with a hex fallback (e.g. `var(--cf-color-gray-500, #6b7280)`) is
  still a `[WARN]` — the token resolves to nothing, so the hex is what renders
- genuinely dynamic inline styles computed from data (positions, sizes,
  data-driven colors in charts or drag layers) where no static token applies
- `$selectedIndex` on `cf-picker` — that is the component's own API, not
  authored selection state
- a handler doing dependent work beyond the single `.set()` (though if the
  control is also cell-bound, the self-feedback rule in category 5 applies)
- `Escape` or arrow-key handlers — no component affordance covers those
- a domain field that happens to be called `id` because the DATA is identified
  externally (an API record id, a Google event id) and is never used to find
  rows in cells — the rule targets identity *minting* for row tracking
- existing, consumed natural-language agent APIs (e.g. do-list's
  `updateItemByTitle`, driven by the omnibox tools) — legacy surface with real
  callers; the rule targets NEW patterns adding parallel string identity
### 16. Identity & Authorship (multi-user)

Applies only to patterns with multiple people or a "current user" concept. **N/A for single-user patterns — do not penalize.**

| Check | What to verify | Fix |
|-------|----------------|-----|
| people rendered as data | a person shown as `{name}` text or a raw `<img>` | render **every** participant with `cf-profile-badge` bound to their profile cell; `cf-avatar` + snapshot only as an explicit offline fallback |
| others rendered as `cf-avatar` when a live cell exists | `cf-avatar` used for co-participants even though their `#profile` cell is (or could be) stored on join | store each joiner's profile cell in the shared roster and badge it — cross-space reads resolve (CT-1667/1687). `cf-avatar` is only for snapshot-only cases |
| current viewer | a "type your name" / "who am I" text field used as the viewer's identity | resolve via `wish({ query: "#profile" })` (+ `#profileName` / `#profileAvatar`) |
| per-user isolation | stored DIDs / user-ids / name strings used to fake isolation | use `PerUser` / `PerSpace` scope; let the scope select the instance |
| roster construction | a participant list built from typed names | join by profile cell: each viewer pushes their own live `#profile` cell (plus a `{ displayName, avatar }` snapshot fallback) into the shared roster |
| identity comparison | dedup or "is this me?" by display-name equality | compare a cell reference with `equals()`, never the mutable name |
| ownership / authorship | "who created / wrote this" stored as a bare name | snapshot the actor's profile, or attest with CFC `AuthoredByCurrentUser` / `RepresentsCurrentUser` |

See `docs/common/patterns/multi-user-patterns.md#presenting-identity` and `docs/common/components/COMPONENTS.md#identity-components`. Severity: a forgeable / dead-string **current-viewer** identity is MAJOR (wrong behavior across users); rendering others as name strings is MINOR–MAJOR per case; rendering a co-participant with `cf-avatar` when their live profile cell is available is MINOR (misses the trusted seal and live data).

**Do NOT flag** (false positives seen in review):

- A `computed()` or cell **bound into a handler-state slot typed as its plain value**
  (e.g. `viewerName: string` in a `handler<…, { viewerName: string }>`) is resolved
  to that plain value at dispatch. Reading it directly inside the handler body — no
  `.get()` — is correct. Do not report a "missing `.get()`"; adding `.get()` on a
  resolved string/number is the actual defect, and `cf check` would reject the
  handler-state type mismatch if the binding were unresolved.

### 17. Cross-Pattern Data Contracts

Review types used to read externally owned data: linked pieces, wish results,
registry entries, cells passed between independently evolving patterns, and
similar boundaries. A schema is a runtime projection and binding contract, not
just a TypeScript annotation. The consumer should name only the fields it reads
and the live-cell/stream bindings it actually uses.

| Violation | Fix |
|-----------|-----|
| another pattern's full `FooInput` or `FooOutput` is imported, aliased, or extended to type external data even though only a subset is used | declare a consumer-owned structural type containing exactly the fields and bindings used |
| `Pick<FooOutput, ...>` / `Omit<FooOutput, ...>` is used merely to avoid spelling the consumer contract | write the minimal local shape so unrelated producer type changes do not become consumer migrations |
| a consumer projection names fields it never reads, including `[UI]`, unrelated state, or mutation streams | remove them; undeclared fields are intentionally outside this relationship |
| a consumer requests a branded live cell (`Writable<>` / `Cell<>`) or stream when it needs only a projected value or does not use the stream | use the plain field type or omit the stream; `Writable<>` and `Cell<>` are equivalent aliases, not different authority levels |
| a producer's advertised reusable model contains its full pattern state or grows whenever one consumer needs another field | keep/export a shallow role model for the stable shared semantics; let specialized consumers own additional local projections |

This duplication is intentional. Narrow schemas avoid traversing unrelated
linked data, reduce validation failures across durable-data vintages, avoid
unnecessary live-cell and stream bindings, and let patterns migrate
independently. An extra required field whose value is unavailable or
incompatible invalidates its object; when that object is an array element, one
invalid element voids the entire array read. See
`packages/runner/test/traverse-required-links.test.ts` and
`docs/common/patterns/composition.md#keep-external-data-contracts-narrow`.

Do not flag a genuinely shared protocol (for example, a stream event or enum),
a cohesive domain model co-owned by one pattern family, a test intentionally
checking the complete public result, or a wrapper whose stated purpose is to
forward the complete contract. If the consumer demonstrably uses every field
and binding, the full contract may be honest. Also do not flag `[UI]` on a
sub-pattern's own output type: it is required for rendering that sub-pattern in
another pattern.

Severity is `minor` when the only current effect is unnecessary coupling.
Raise it to `major` when the oversized contract causes extra traversal,
validation, or migration failure.

## Output Format

The review should be emitted as a structured checklist with explicit pass/fail
calls, for example:

```text
## Pattern Review: main.tsx

### 1. Module Scope
- [PASS] No handler() inside pattern
- [FAIL] lift() immediately invoked (line 23)
  Fix: Use computed() or move lift to module scope

### 2. Reactivity
- [PASS] [NAME] properly wrapped
- [FAIL] new Writable(deck.name) uses reactive value (line 15)
  Fix: Initialize empty, set in action()

...

## Summary
- Passed: 22
- Failed: 3
- Warnings: 1
- N/A: 2

## Priority Fixes
1. [Line 15] new Writable() with reactive value
2. [Line 23] lift() inside pattern
3. [Line 45] Missing $ prefix on binding
```

## Severity and Prioritization

Use the shared severity taxonomy from the factory protocol:

- `critical` - breaks correctness or reactivity, or loses data. Examples: a
  reactive loop, `.get()` on a computed during render, `new Writable(reactiveValue)`,
  a handler that never fires.
- `major` - violates a documented rule with a user-visible effect. Examples:
  wrong binding so edits don't persist, wrong state scope leaking per-user
  state, SES/determinism violations.
- `minor` - convention or maintainability issue with no user-visible effect.
  Examples: `handler()` where `action()` suffices, helper defined inside the
  pattern body that happens to work.
- `info` - observation, no change required.

For modify-mode pre-build reviews, findings should also be easy for an
orchestrator to triage into:

- correctness or divergence risks that are `MUST-FIX`
- style or taste observations that are `NOTED`

Every non-trivial finding should include:

- line number or precise location
- why it matters
- what to change

## Useful References

- `docs/development/debugging/README.md`
- `docs/development/debugging/gotchas/`
- `docs/common/components/COMPONENTS.md`
- `docs/common/patterns/multi-user-patterns.md`
- `docs/common/capabilities/llm.md`
- `docs/common/capabilities/fetch.md`

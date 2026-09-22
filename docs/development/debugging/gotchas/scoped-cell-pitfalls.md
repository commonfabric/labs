# Scoped Cell Pitfalls

Practical gotchas encountered when building patterns with the scoped cell
instances feature (`PerSpace`, `PerUser`, `PerSession`, `PerAny`). See
`docs/specs/scoped-cell-instances.md` for the underlying model.

## 1. `.length` on a top-level scoped array doesn't lift reactively

**Symptom:** Output values derived as `users.length` (where `users` is a
top-level `PerSpace<T[]>` input) read as a stale snapshot or as `undefined`
from outside the pattern.

```typescript
// Shown inside a pattern body.
// WRONG - snapshots once, does not track reactively
const userCount = users.length;
```

```typescript
// Shown inside a pattern body.
// CORRECT - wrap in computed
const userCount = computed(() => users.length);
```

Nested property access through an object cell (e.g. `conversation.rooms.length`
where `conversation: PerSpace<{rooms: Room[]}>`) works fine — the problem is
specific to `.length` access directly on a scope-wrapped array cell.

## 2. Expose scoped outputs as plain types via `computed(() => cell.get())`

**Symptom:** Test assertions like `subject.users[0]?.name === "Alex"` return
`undefined` even after the underlying cell has the right value.

Returning a `PerSpace<User[]>` input directly as a pattern output leaves
consumers fighting the reactive traversal layer. Wrap arrays/strings in
`computed(() => cell.get())` so the output type is plain.

```typescript
// Shown for illustration only.
export interface MyOutput {
  users: readonly User[];     // plain type, not PerSpace<User[]>
  myName: string;
}

return {
  users: computed(() => users.get()),
  myName: computed(() => myName.get()),
  // ...
};
```

This mirrors what `packages/patterns/scrabble/scrabble.tsx` does for its
`players`, `board`, `bag` etc.

## 3. Don't `.get()` a per-scope cell from JSX `onClick`

**Symptom:** Type error `Property 'get' does not exist on type 'string & {
readonly [SCOPE_BRAND]?: "session" | undefined; }'`.

In the pattern body, scoped inputs (e.g. `joinName: PerSession<string>`) are
typed as the scope-branded value, not as a `Writable<string>` cell — so
`joinName.get()` does not compile.

```typescript
// Shown inside a pattern body.
// WRONG
<cf-button onClick={() => boundJoin.send({ name: joinName.get() })}>
  Join
</cf-button>
```

The idiom (used by `scoped-group-chat` and the new game patterns): make the
event payload optional, have the handler fall back to reading the draft cell
from its bound closure, and dispatch the bound stream directly.

```typescript
// Shown for illustration only.
// In handler
const joinAs = handler<{ name?: string }, { joinName: NameCell; ... }>(
  ({ name }, { joinName, ... }) => {
    const trimmed = (name ?? joinName.get()).trim();
    // ...
  },
);

// In JSX
<cf-button onClick={boundJoin}>Join</cf-button>
```

## 4. Initial-state assertions before any action can read `undefined`

**Symptom:** A pattern test asserts initial empty state and the framework
reports `Expected true, got undefined`.

Reactive output reads can resolve to `undefined` before defaults hydrate.
Scrabble's tests (`packages/patterns/scrabble/scrabble.test.tsx`) sidestep this
by always running an action before the first assertion. Follow the same
pattern: structure the test as a sequence of `{ action }, { assertion }` pairs
and skip the pre-action sanity check.

## 5. `scopedCell.get().map()` in a render computed throws until first sync — guard with `?? []`

**Symptom:** On a fresh space/session, a console **storm** of
`TypeError: Cannot read properties of undefined (reading 'map')` (often 100s,
re-thrown on every settle wave), and a whole section of UI silently fails to
render — including controls (Edit/Remove buttons, pickers) that should be there.
No single clear culprit; the error points at minified runtime frames.

**Cause:** A scoped cell's `.get()` returns `undefined` **until its first sync
settles** (the render-path counterpart of pitfall #4). A render-path `computed`
that chains an array method straight off it then throws:

```typescript
// Shown for illustration only.
// WRONG — throws while pendingVehicles (perSession) / people (perSpace) is
// still undefined before the first sync; the throw repeats every settle wave.
const rows = computed(() => pendingVehicles.get().map((v) => …));
const sorted = computed(() => [...people.get()].sort(…));      // "not iterable"
const active = computed(() => spots.get().filter((s) => s.active)); // "reading filter"
```

This bites **perSession** cells hardest (they reliably read `undefined` before
sync) but also **perSpace** on a cold space. A throwing **per-row** computed
inside a `.map()` (e.g. `activeSpotOpts = computed(() => spots.get().filter(…))`)
crashes that row's card, which is why its inline controls never appear.

```typescript
// Shown for illustration only.
// CORRECT — guard every render-path scoped read.
const rows = computed(() => (pendingVehicles.get() ?? []).map((v) => …));
const sorted = computed(() => [...(people.get() ?? [])].sort(…));
const active = computed(() => (spots.get() ?? []).filter((s) => s.active));
```

Note `Default<[]>` on the input type is **not** sufficient — the default hasn't
hydrated yet at the moment the computed first runs, so the `?? []` guard is still
required (this is why pitfall #4's "run an action first" trick works for tests
but render code can't). Handlers/actions run in a settled context, so the same
chained reads there are usually safe; the danger is the always-evaluating render
computeds. Fixed across `packages/patterns/factory-outputs/parking-coordinator/main.tsx`.

⚠️ **Don't take this `?? []` recipe into a NESTED `.map()`.** Inside an outer
`rows.map((row) => …)`, an inner `(cellCall() ?? []).map((el) => …)` whose
inner closure references any pattern-scope cell aborts pattern construction —
this is a *different* gotcha (the ts-transformer doesn't recognize binary-
expression receivers wrapping a reactive call, so no `mapWithPattern`
rewrite happens). The very guard that's correct at the top level is the thing
that breaks it nested. See
[closure-capture-in-nested-map.md](./closure-capture-in-nested-map.md) for
the three idiomatic alternatives (map the cell directly; pre-bake into a
top-level `computed`; local `computed()` bridge per row).

## 6. Don't share `perUser`/`perSession` cells through `PerSpace` data

**Symptom:** Other participants see "Unnamed user" / empty values where a
user's profile (or similar per-user record) should appear, while the owning
user sees their own data fine.

A user/session-scoped cell instance is isolated **by reader**
(`docs/specs/scoped-cell-instances.md`): the same link resolves to each
reader's own instance. So registering a `Writable.perUser.of(...)` cell in a
shared (`PerSpace`) list hands every other participant a link to *their own*
empty instance — the data can never propagate.

```typescript
// Shown as alternative snippets.
// WRONG — other users dereference this to their own empty instance.
const profile = Writable.perUser.of<TrustedProfile>(snapshot);
registerProfile(sharedProfiles, profile);

// CORRECT — mint a space-scoped cell; per-user distinctness comes from
// creation (per-invocation cause on each user's first save) plus a PerUser
// pointer that remembers which cell is "mine".
const profile = currentProfileCell(myProfile) ??
  Writable.perSpace.of<TrustedProfile>(snapshot);
myProfile.set({ profile });
registerProfile(sharedProfiles, profile);
```

Rule of thumb: scope controls _who reads which instance_, not _who owns the
data_. Anything that must be visible to other users belongs in a space-scoped
cell; use `PerUser` for the pointer, not the shared record. Fixed in
`packages/patterns/cfc-group-chat-demo/trusted.tsx`; guarded by the
multi-runtime test
`packages/patterns/integration/cfc-group-chat-demo-multi-runtime.test.ts`.

The runtime now **warns loudly at the write site** instead of leaving this a
fully silent hole for other readers: storing a narrower-scoped link in a
broader-scoped slot logs `Storing a <scope>-scoped link in <scope>-scoped
data …` (`data-updating.ts`, scope-isolation write guard; unit pins in
`packages/runner/test/data-updating.test.ts`). The warn fires where the
slot's shape says the author wanted shared data: the slot's schema doesn't
match `undefined` and has no effective `default`, **and** the parent schema
lists the slot in `required` (approximating — not proving — that a read
would reject the hole; rejection is ultimately judged against each reader's
combined schema). A required scoped target that is unavailable to a reader
rejects its containing object; use an optional, undefined-tolerant, or
defaulted slot only when partial visibility is intended. Direct slot writes
(`cell.key().set()`, bound handler cells) have no parent schema in view and
keep the warn even for slots that are optional through the parent — declare
the slot's scope or write through the parent object to silence those.
Optional, undefined-tolerant, or defaulted slots written through their parent
stay silent — per-reader resolution there degrades harmlessly, which is also
how the runtime's own scoped-link writes (`.asScope()` result links,
`navigateTo` result cells, argument setup wiring) stay quiet. If per-reader
resolution is genuinely intended on a strict slot, declare the slot's schema
scope (e.g. `PerUser<Cell<T>>` on the field type, or `scope: "user"` / a
scoped `asCell` entry in the schema). A declared scope is a **cap**: content
may be at most that narrow, so links at or broader than the cap are silent,
while a narrower-than-cap link (e.g. a session link in a `PerUser` field)
still warns.

## 7. `Math.random()` / `Date.now()` throw outside a handler

**Symptom:** `TypeError: secure mode %SharedMath%.random() throws` or a
`TimeCapabilityError` when the code runs.

The pattern sandbox gates the ambient intrinsics `Math.random()`, `Date.now()`,
and no-argument `new Date()`. They are allowed **inside a handler** (the clock
coarsened to one-second resolution; entropy passes through) and throw in a
lift/computed or at pattern-body level. Call the built-ins directly — they are
not importable helpers. This is not scope-specific but showed up while wiring up
an option-id generator in a scoped poll, where the generator ran inside a
handler.

```typescript
// Inside a handler.
const newId = () =>
  `o_${Date.now().toString(36)}_${
    Math.floor(Math.random() * 1e6).toString(36)
  }`;
```

For reactive time in a computed, read the live clock with the `#now` wish rather
than calling `Date.now()`.

## 8. `Writable<PerUser<T>>` and `PerUser<Writable<T>>` scope different things

**Symptom:** A child that should refuse a session-scoped cell passed into a
per-user argument reads it anyway.

`Writable<PerUser<T>>` puts the scope on the value (`scope: "user"` beside
`asCell: ["cell"]`). `PerUser<Writable<T>>` puts it on the handle
(`asCell: [{ kind: "cell", scope: "user" }]`). Both read a cell the caller
passes in, and a write through either handle lands in that cell's own
instance. They differ in what the scope constrains:

- The handle spelling caps which link the handle may follow. A passed cell
  narrower than the cap, such as a session cell in a `PerUser` slot, reads as
  missing.
- The value spelling scopes the slot's own content. A plain value written into
  the slot narrows into the user instance, so each user gets their own copy
  behind a base-slot redirect. It does not cap the handle, so a narrower passed
  cell is followed.

```typescript
// Shown for illustration only.
// A handle to a record the caller owns: scope the handle.
type RunRecord = PerUser<Writable<AgentRun>>;

// A per-user value the pattern keeps for itself: scope the value.
type Draft = Writable<PerUser<string>>;
```

When the slot exists to receive a reference to an existing cell, scope the
handle. `packages/runner/test/pattern-scope.test.ts` pins these behaviors.

## See Also

- `docs/specs/scoped-cell-instances.md` — the underlying scope model
- `packages/patterns/scoped-group-chat/` — canonical scope-aware pattern
- `packages/patterns/scrabble/scrabble.tsx` — name-as-identity idiom
- `packages/patterns/cozy-poll/` — applies all of the above
- `packages/patterns/scoped-user-directory/` — verification of the link-pointer
  technique (per-user pointer into a per-space array)

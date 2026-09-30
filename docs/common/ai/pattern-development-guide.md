# Pattern Development Guide

This is the canonical reference for building Common Fabric patterns.

## Core Working Style

- Plan before building. Scale the plan to the problem size.
- Start simple and keep the first implementation runnable.
- Reuse suitable indexed patterns and available data before authoring new behavior.
- Prefer one source file per small pattern. Compose patterns to achieve a larger
  goal; file organization does not determine component boundaries.
- Iterate through `Sketch -> Run -> Verify -> Improve`.
- Prefer validated docs and references over blindly copying an existing pattern.

## Planning Scale

Use enough planning for the task, but no more:

- simple pattern:
  - one file, types plus handlers plus UI together
  - minimal clarification needed
  - plan in a couple of sentences
- medium pattern:
  - maybe split schemas if types become hard to follow
  - clarify data shape and key actions up front
  - plan in a short list
- complex pattern:
  - identify entities, relationships, actions, and boundaries
  - compose existing patterns and identify the smallest missing capabilities
  - plan with structure, but do not over-specify the end state

Keep the user's goal in view. A larger goal can have a short implementation when
existing pieces already provide most of its behavior. If the design keeps
growing, revisit the available data and component contracts before adding more.

## Pattern Structure

Start with:

```text
packages/patterns/<name>/main.tsx
```

Only split into `schemas.tsx` or additional modules when:

- types become hard to follow
- a helper has clear reuse value
- the main file becomes harder to evolve than to split

These choices organize the source of one pattern. They do not require all of a
user's goal to live in one pattern. When the host provides a pattern index,
compose suitable indexed components through its `cf:pattern:<patternId>` imports.
Otherwise, compose available local patterns through ordinary file imports.
Connect their inputs and outputs, and author the smallest missing reusable
piece. A useful new component can then be contributed to the catalog for later
goals.

## Multi-User Patterns

For collaborative or identity-sensitive patterns, read
`docs/common/patterns/multi-user-patterns.md` before choosing the input and
output shape. Decide which state is shared across the space, which state belongs
to the active user, and which state is local to one session.

## Reusing CFC Helpers

For CFC policy code, check `packages/patterns/cfc/README.md` before copying
from an existing demo. Reuse the shared helpers there for common admin
registries, trusted UI actions, trusted surfaces, and prompt-injection
workflows.

Keep concrete policy vocabulary local to the pattern: integrity strings, label
atoms, resource subjects, value digests, demo fixtures, routes, and domain
models should usually stay beside the code that owns them.

If an existing helper is not enough and the code appears reusable, read
`docs/common/ai/cfc-helper-authoring-guide.md` before promoting it into
`packages/patterns/cfc/`.

## Development Loop: Sketch -> Run -> Iterate

Do not write the finished code up front. Write the minimum needed to see real
behavior:

1. Sketch
   - define the types
   - add one handler or action
   - render the simplest useful UI
2. Run it
   - use `deno task cf check <pattern>.tsx`
3. Verify
   - does it render?
   - do the core interactions fire?
   - do the values move the way you expect?
4. Iterate
   - add one more meaningful piece and rerun

If you cannot run what you have written, you have probably written too much
before validating enough.

## Verification Loop

Use the runtime, not just static reasoning:

- `deno task cf check <pattern>.tsx`
- `deno task cf check <pattern>.tsx --no-run` for faster type validation
- `deno task cf check <pattern>.tsx --show-transformed` when you need to
  inspect how the transformer lowered a conditional or reactive expression site
- `deno task cf test <pattern>.test.tsx` when tests are justified

Primary verification is still runtime behavior. Tests are for logic that is
awkward, fragile, or expensive to verify by clicking.

## Delegation and Review Rhythm

If your runtime supports delegation, the most useful split is usually:

- a code-writing role for implementation
- a deploy/runtime-testing role
- a critic/review role before release or first deploy

Use delegation to reduce context mixing, not to overcomplicate small tasks.
Simple patterns can stay in one session; larger or more failure-prone work
benefits from role separation.

## action() vs handler()

Default to `action()` when the behavior is specific to one pattern instance and
can close over pattern-local state.

Use `handler()` when:

- you need different bound data per instantiation
- the same implementation is reused across items or contexts
- you are binding per-item behavior inside `.map()`

Decision rule:

- if the behavior needs different data at different call sites, use `handler()`
- otherwise, use `action()`

### Correct `action()` usage

```tsx
// Shown inside a pattern body.
const Note = pattern<NoteInput, NoteOutput>(({ title, content }) => {
  const menuOpen = new Writable(false);

  const toggleMenu = action(() => menuOpen.set(!menuOpen.get()));
  const clearContent = action(() => content.set(""));

  return {
    [UI]: (
      <>
        <cf-button onClick={toggleMenu}>Menu</cf-button>
        <cf-button onClick={clearContent}>Clear</cf-button>
      </>
    ),
    content,
  };
});
```

### Correct `handler()` usage

```tsx
// Shown for illustration only.
const deleteItem = handler<void, { index: number; items: Writable<Item[]> }>(
  (_, { index, items }) => {
    const list = items.get();
    items.set(list.filter((_, itemIndex) => itemIndex !== index));
  },
);

const List = pattern<ListInput, ListOutput>(({ items }) => ({
  [UI]: (
    <ul>
      {items.map((item, index) => (
        <li>
          {item.name}
          <cf-button onClick={deleteItem({ index, items })}>Delete</cf-button>
        </li>
      ))}
    </ul>
  ),
  items,
}));
```

## SES Authoring Limits and Escape Hatches

Patterns now run inside a verified SES subset. The practical authoring rules
are:

- keep module scope declarative:
  - use `const`
  - define `pattern()`, `handler()`, `lift()`, schemas, and plain data
  - avoid top-level `let`, `var`, classes, or ad hoc mutable caches
- keep pattern-owned callback bodies straight-line:
  - avoid `let`, `var`, reassignment, and loop statements
  - prefer array methods, `computed()`, module-scope `lift()`, or a
    module-scope helper
- do not use authored timers or proxies:
  - `setTimeout()`, `setInterval()`, and `new Proxy()` are not part of the
    authored runtime surface and do not compile; drive timed work through the
    scheduler (`computed()`, handlers, streams) instead of your own clock
- read the clock and randomness through the ordinary built-ins, only where
  they belong:
  - use `Date.now()` (or `new Date()`) for the clock and `Math.random()` for
    randomness — inside a pattern these resolve to the gated sandbox
    intrinsics, not the host ones
  - call them from `action()`, `handler()`, or one-time initialization only.
    In a re-running computation (`computed()` or `lift()`) they throw a
    `TimeCapabilityError`, because an ambient clock/entropy read there would
    break idempotency. Inside a handler the clock is coarsened to one-second
    resolution.
  - for a live clock a `computed()` can react to, read the interval `#now`
    wish (`wish({ query: "#now/N" })`, N in seconds) instead. The bare `#now`
    wish is not a clock: it durably captures the piece's first-ever load time
    and never advances — right for a created-at stamp, wrong for anything
    that must track the current time

Locale-sensitive formatting works, with pinned defaults:

- `toLocaleDateString` / `toLocaleTimeString` / `toLocaleString` (and the
  Number, BigInt, and String locale methods) honor their arguments, but an
  omitted locale defaults to `"en-US"` and an omitted Date `timeZone` to
  `"UTC"` — never the host locale or timezone.
- Pass `timeZone` explicitly (an IANA name) to format in a specific zone. For
  viewer-local display, compose from the local getters (`getFullYear()`,
  `getDay()`, `getHours()`, …), which remain host-local; the sandbox exposes
  no way to obtain the viewer's IANA zone name, so `toLocale*` output is
  deterministic rather than viewer-local.
- Watch the mixed-zone trap: a `Date` constructed at *local* midnight (e.g.
  `new Date("2025-07-11T00:00:00")`) formatted without an explicit `timeZone`
  renders in UTC and can land on the previous day for zones east of UTC.
  Construct in UTC (`"…T00:00:00Z"`) or pass the matching `timeZone`.

```tsx
// Shown inside a pattern body.
const createItem = action(() => {
  items.push({
    id: `item-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    title: title.get(),
  });
});
```

If a pattern needs richer time, scheduling, or entropy behavior, prefer an
explicit runtime capability or service over hiding imperative state in authored
callbacks.

## Common Pitfalls

### Conditional JSX

Do not use `computed()` to gate JSX sections. Use direct authored expressions
instead, usually plain ternaries.

Prefer plain authored ternaries; they work in normal pattern code, not just in
JSX children. If a site behaves unexpectedly, inspect the emitted output with
`cf check --show-transformed` instead of guessing about the lowering. One
caveat: ternary branches are evaluated eagerly (no short-circuiting), so
property access on a nullable reactive value inside a branch needs `computed()`
deferral — see
`docs/development/debugging/gotchas/eager-ternary-branch-evaluation.md`.

```tsx
// Shown inside a pattern body.
// Wrong
{computed(() => {
  if (!showAdmin.get()) return null;
  return <div>{showForm ? <form>...</form> : null}</div>;
})}

// Right
{showAdmin
  ? <div>{showForm ? <form>...</form> : null}</div>
  : null}
```

Inside `computed()`, a `Writable<boolean>` is just a JS object and therefore
truthy. That leads to subtle incorrect rendering because ternaries inside the
`computed()` body are plain JS, not transformer-lowered conditionals.

That distinction matters because explicit computation callbacks like
`computed`, `lift`, `action`, and `handler` are preserved-JavaScript control-flow
boundaries. Inside those callback bodies, use `.get()` when you need the raw
boolean value.

### CORS and fetch builtins

Fetches currently run in the browser, so an absolute cross-origin URL only
works if that server sends CORS headers. RSS feeds, private APIs, and many XML
endpoints do not. For external web *page* content, read it through the
first-party `/api/agent-tools/web-read` or `/api/agent-tools/web-search`
endpoints, which fetch server-side. A CORS-blocked JSON API has no general
workaround yet, so if a brief depends on one, note the limitation rather than
silently shipping a pattern that cannot load it.

This is a current limitation of running fetches in the browser, expected to
lift as fetches move to runtime-managed egress; it is not a reason to prefer
relative URLs in general.

### Reactive Cycles

Do not call `.set()` on upstream cells from inside `computed()`. If the write
feeds back into the same reactive graph, the runtime will cycle and eventually
throw.

```tsx
// Shown for illustration only.
// Wrong
const sorted = computed(() => {
  const items = allItems.get();
  statusMessage.set(`${items.length} items`);
  return items.sort(compareFn);
});

// Right
const sorted = computed(() => [...allItems.get()].sort(compareFn));
const updateStatus = action(() => {
  statusMessage.set(`${allItems.get().length} items`);
});
```

Use `computed()` for derivation and `action()` for side effects.

### Bound Control Self-Feedback

If a control is already bound to a cell, usually via `$value` or `$checked`,
treat that binding as the control's primary value path. Do not add
`oncf-change` / `oncf-input` handlers that merely write the same value back
into that same cell.

```tsx
// Shown for illustration only.
// Wrong
<cf-select
  $value={entryType}
  items={typeItems}
  oncf-change={(event) => entryType.set(event.detail.value)}
/>

// Right
<cf-select
  $value={entryType}
  items={typeItems}
  oncf-change={(event) => syncCategoryForType.send(event.detail.value)}
/>
```

Use the handler only for dependent state updates or other side effects.

### Composition Contracts

When one pattern feeds another, output field names and input field names must
match exactly. There is no automatic name mapping. `chartData` and
`chartEntries` are different contracts.

Coordinate naming across related patterns before implementation. Mismatched
field names create silent friction later and are easy to miss during assembly.

Keep the receiving side's data contract as narrow as its actual reads and
writes. Pattern schemas select and validate runtime data and preserve requested
live-cell/stream bindings, so importing a producer's full `Input` or `Output`
type can fetch, bind, and migration-couple much more than the relationship
needs. Prefer a consumer-owned structural type containing only the required
fields. When several independent consumers share a genuine role, have the
producer export a shallow role model rather than its full pattern schema. See
`docs/common/patterns/composition.md#keep-external-data-contracts-narrow`.

## Workflow Guidance

The common operating rhythm is:

1. build the smallest coherent version
2. run it locally
3. review against the documented gotchas
4. deploy or runtime-check it in a representative environment
5. tighten or expand only after the earlier slice works

Always review before first deploy when the change is larger than a trivial fix.
The fast review step catches many convention and reactivity mistakes before
they become runtime debugging sessions.

At clear milestones, offer a commit or checkpoint so useful progress is not
left ephemeral.

## Documentation Priorities

Start with `docs/common/patterns/`.

For Pattern Factory Build and other implementation work that creates or
debugs stateful UI, read these foundational references before coding:

- `docs/common/concepts/reactivity.md`
- `docs/common/patterns/new-cells.md`

Then consult the targeted references as needed:

- `docs/common/concepts/types-and-schemas/`
- `docs/common/concepts/action.md`
- `docs/common/concepts/handler.md`
- `docs/common/workflows/pattern-testing.md`
- `docs/common/components/COMPONENTS.md`
- `docs/development/debugging/`

Prefer documentation over existing patterns in `packages/patterns/`. Existing
patterns are useful reference points but may include older idioms or locally
driven compromises.

# Reusable Handlers

Use `handler()` when you need to define event-handling logic once and bind it to different state at multiple call sites. **Default to [`action()`](./action.md)** — see that doc for the full decision guide.

## When to Use `handler()`

1. **Same logic, different state** - You want to reuse identical handler logic with different state
2. **Exported streams** - Other patterns need to call your handler via linking
3. **CLI testing** - You want to test handlers via `cf piece call` before building UI

## Basic Structure

```typescript
// Shown at module scope.
import { handler, Writable } from "commonfabric";

// Define at module scope (outside pattern body)
const increment = handler<EventType, StateType>((event, state) => {
  // event = data passed to .send()
  // state = state bound when handler is invoked
});
```

**Type annotations are required** - without them, parameters become `any`.

## Example: Reusable Counter Logic

```tsx
import { handler, pattern, Writable, UI } from "commonfabric";

// Define once at module scope
const increment = handler<void, { count: Writable<number> }>(
  (_, { count }) => count.set(count.get() + 1)
);

const decrement = handler<void, { count: Writable<number> }>(
  (_, { count }) => count.set(count.get() - 1)
);

export default pattern(() => {
  const counterA = new Writable(0);
  const counterB = new Writable(100);

  return {
    [UI]: (
      <div>
        {/* Same logic bound to different state */}
        <div>
          Counter A: {counterA}
          <cf-button onClick={increment({ count: counterA })}>+</cf-button>
          <cf-button onClick={decrement({ count: counterA })}>-</cf-button>
        </div>
        <div>
          Counter B: {counterB}
          <cf-button onClick={increment({ count: counterB })}>+</cf-button>
          <cf-button onClick={decrement({ count: counterB })}>-</cf-button>
        </div>
      </div>
    ),
  };
});
```

## Module Scope Requirement

The pattern transformer requires `handler()` to be defined **outside** the pattern body. Only the binding (passing state) happens inside:

```typescript
// Shown for illustration only.
// CORRECT - Define at module scope, bind inside pattern
const addItem = handler<{ title: string }, { items: Writable<Item[]> }>(
  ({ title }, { items }) => items.push({ title, done: false })
);

export default pattern(({ items }) => ({
  [UI]: <cf-button onClick={addItem({ items })}>Add</cf-button>,
  items,
}));

// WRONG - Defined inside pattern body
export default pattern(({ items }) => {
  const addItem = handler(...);  // Error: must be at module scope
  return { ... };
});
```

**Why:** The CTS transformer processes patterns at compile time and cannot handle closures over pattern-scoped variables in handlers.

Handlers also live on the verified SES module-scope surface. Define them once
at the top level, then pass any changing state through the binding object
instead of hiding it in module-scoped mutable variables.

## SES-Friendly Handlers

- Bind changing state explicitly. Avoid top-level mutable caches, counters, or
  class instances.
- Keep the handler callback direct and readable. If the body becomes too
  imperative, push complex logic into a helper and keep the bound state
  explicit.
- Call `Date.now()` and `Math.random()` directly when a handler needs a
  timestamp or a random value. Inside a handler these built-ins are allowed (the
  clock is coarsened to one-second resolution); in a lift/computed or at
  pattern-body level they throw a `TimeCapabilityError`. For reactive time in a
  computed, read the interval `#now/N` wish (bare `#now` is a frozen
  first-load capture, not a clock).
- Call `eventKey()`, not `Math.random()`, for an ID that has to name the event:
  a key for acting on a request at most once, or the ID of a record the event
  creates. A handler can run more than once for one event — a retry, or a
  client's speculative run before the server's — and `Math.random()` returns
  something different each time, while `eventKey()` returns the same key on
  every run of the event and a different one for every other event. A stream
  can re-admit an event id it has already handled, which gets the same key, so
  create a record addressed by the key only if it is absent.
  [The key of the event a handler handles](../../features/event-key.md) has the
  details.
- Timers are not part of the authored surface and do not compile, so drive
  timed work through the scheduler rather than reaching for `setTimeout()` or
  `setInterval()` in handler code.
- Call `currentPrincipal()` for the DID of the user the handler acts for, never
  a field of the event; [Handling Events](./action.md#who-the-action-acts-for)
  says what it does and does not tell you.

## Input Delivery Is Rate-Shaped

User input reaching your handlers is delivered in realtime during normal
interaction, including quick bursts of clicks. Sustained high-frequency input
(a held key's autorepeat, scripted rapid-fire events) is throttled to about one
delivery per second per pattern. Nothing is dropped: every event still arrives,
so a counter that counts clicks counts every click — the overflow just arrives
batched. There is intentionally no opt-out; the shaping is a security measure
that denies sandboxed patterns a fine-grained clock (see
[Timing side-channel mitigations](../../specs/sandboxing/TIMING_SIDE_CHANNELS.md)).

Continuous-motion gestures — drawing, or drag-tracking with a handler per
pointer-move — are out of scope for per-event handlers. Build continuous
controls on `$value`-style bidirectional bindings instead: those coalesce to
the latest value, so the bound cell always ends at the current state without
needing every intermediate event.

## Exporting Handlers as Streams

Handlers exposed in Output interfaces must be typed as `Stream<T>` — a
write-only channel that other pieces can trigger via `.send()` when linked.
Don't try to create streams directly: a bound handler **is** a
`Stream<EventType>`. Binding state to a module-scope handler produces the
stream, which you export in the return object:

```tsx
// Shown for illustration only.
import { handler, pattern, Stream, Writable, UI } from "commonfabric";

interface Output {
  addItem: Stream<{ title: string }>;  // Exported stream
}

const addItem = handler<{ title: string }, { items: Writable<Item[]> }>(
  ({ title }, { items }) => items.push({ title, done: false })
);

export default pattern<{}, Output>(({ items }) => ({
  [UI]: <div>...</div>,
  items,
  addItem: addItem({ items }),  // Export the bound handler
}));
```

Other patterns can then link to this pattern and call `linkedPattern.addItem.send({ title: "New" })`.

## Event Data and Void Handlers

The first type parameter is the event payload passed to `.send()`; use `void`
when the handler needs no event data:

```typescript
// Shown inside a pattern body.
// With event data
addItem({ items }).send({ title: "My Item" });

// Void handler - call .send() without arguments
const clearAll = handler<void, { items: Writable<Item[]> }>(
  (_, { items }) => items.set([])
);
clearAll({ items }).send();
```

An event arrives deeply frozen: neither it nor anything nested inside it can be
modified. Derive a new value rather than editing one in place. Sorting an array
the event carries is the case that catches people out, because the method that
reads most naturally is the one that mutates: `event.items.sort()` throws a
`TypeError`, where `[...event.items].sort()` sorts a copy and hands it back.

## CLI Testing

Export handlers to test them via CLI during development:

```bash
# Call a handler with JSON payload (flags go before the callable name)
deno task cf piece call --cell <ID> addItem '{"title": "Test"}'

# Step to process
deno task cf piece step --cell <ID>

# Verify state
deno task cf piece inspect --cell <ID>
```

See [Testing Handlers via CLI](../workflows/handlers-cli-testing.md) for the full workflow.
Runtime code that needs to invoke a handler stream directly should follow
[Invoking Handlers from Outside a Pattern](../../features/invoking-handlers-outside-a-pattern.md).

## Summary

**Default to `action()`** — only use `handler()` when you need to reuse the same logic with different state bindings or export it for other patterns. See [Handling Events](./action.md) for the decision table.

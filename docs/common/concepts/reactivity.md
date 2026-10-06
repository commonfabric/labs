# Reactivity and Write Access

## How Reactivity Works

Everything a pattern receives as input or derives with `computed()` is
reactive: when a value changes, everything that reads it updates
automatically. JSX references subscribe automatically — `{count}` re-renders
when `count` changes, with no wrapper needed. Inside `computed()`, `lift()`,
`action()`, and `handler()` bodies, read current values with `.get()`; those
reads are tracked as dependencies (in computed/lift). Derive data with
[computed()](./computed/computed.md) and gate UI with plain ternaries
([Conditional Rendering](../patterns/conditional.md)).

## Availability Is Reactive Control Flow

Single-result fetch and generation calls produce an `AsyncResult<T>`. Keep the
request when code needs to inspect loading or failure, and derive the ordinary
usable value with the zero-node `resultOf()` projection:

```tsx
// Shown for illustration only.
const repoRequest = fetchJson<Repo>({ url });
const repo = resultOf(repoRequest);
const title = computed(() => `${repo.owner}/${repo.name}`);

return isPending(repoRequest)
  ? <div>Loading…</div>
  : hasError(repoRequest)
    ? <div>{repoRequest.errorMessage}</div>
    : <h1>{title}</h1>;
```

While `repoRequest` is unavailable, computations which only consume `repo` do
not run; the same unavailable state propagates through their outputs. Once the
request contains a `Repo`, those computations resume with the non-optional
usable type. Guards opt only their own computation boundary into the reasons
they test, so code can render an error while continuing to wait through other
states. See [Fetching Data](../capabilities/fetch.md) and
[LLM Generation](../capabilities/llm.md) for the complete APIs.

Use `latestComplete()` when continuity is intentional. It waits for its entire
input to become usable, then keeps the last complete snapshot during later
pending, error, syncing, or schemaMismatch intervals:

```tsx
// Shown for illustration only.
const snapshot = latestComplete({ repo: repoRequest, ticket: ticketRequest });
```

This is an atomic join: neither field advances until both current requests are
usable. Inspect the original requests when the UI also needs the current error
or loading reason. Unlike `resultOf()`, `latestComplete()` creates a stateful
built-in node.

Availability policy is attached at the exact stable reactive path captured by
a computation. Hoist dynamic selection outside the computation so the
transformer can name that path:

```tsx
// Shown for illustration only.
const selectedRequest = requests[index];
const content = computed(() =>
  hasError(selectedRequest)
    ? <div>{selectedRequest.errorMessage}</div>
    : <RepoCard repo={resultOf(selectedRequest)} />
);
```

Writing `hasError(requests[index])` inside `computed()` is diagnosed because
the serialized policy cannot identify which array element the dynamic access
will select. Gating is capture-granular: if a computation captures a projected
result, it waits whenever that capture is unavailable even when the branch it
would have taken did not read the value.

When an unavailable value reaches JSX without an explicit guard, the affected
reactive slot starts blank; the rest of the surrounding render is unaffected.
After a usable value has rendered, a pending replacement keeps the last
element-rooted subtree visible but dimmed and non-interactive until usable data
returns. A retained bare text node stays visible but has no element on which to
apply the pending style or `inert`; it also has no interactive surface. Error,
syncing, and schemaMismatch values clear the affected prior content. Use
guards when the UI should show an explicit loading or failure state instead.

The public pattern type `AsyncResult<T>` is the availability union described
here. An unrelated internal memory utility also uses the name `AsyncResult`
with an error type parameter; it is not part of the pattern authoring API.

## Core Principle: Writable<> is About Write Access, Not Reactivity

**The most important thing to understand:** Everything in Common Fabric is reactive by default. The `Writable<>` wrapper in type signatures doesn't enable reactivity—it indicates **write intent**.

### The Rule

- **Use `Writable<T>`** in signatures ONLY when you need write access (`.set()`, `.update()`, `.push()`, `.key()`)
- **Omit `Writable<>`** for read-only access - the framework automatically provides reactive values

```tsx
// Shown for illustration only.
import { action, Default, Writable, UI, pattern } from 'commonfabric'

interface Item {}

// ✅ Read-only - No Writable<> needed (still reactive!)
interface ReadOnlyInput {
  count: number | Default<0>;         // Just display it (defaults to 0)
  items: Item[];                     // Just map/display
  userName: string;                  // Just show it
}

export const ReadOnly = pattern<ReadOnlyInput>(({ count, items, userName }) => {
  return {
    [UI]: (
      <div>
        <div>Count: {count}</div>              {/* Reactive! */}
        <div>User: {userName}</div>            {/* Reactive! */}
        {items.map(item => <div>{item}</div>)} {/* Reactive! */}
      </div>
    ),
  };
});

// ✅ Write access - Writable<> required
interface WritableInput {
  count: Writable<number | Default<0>>;  // Will call count.set()
  items: Writable<Item[]>;              // Will call items.push()
  title: Writable<string>;              // Will call title.set()
}

export default pattern<WritableInput>(({ count, items, title }) => {
  // action() closes over pattern state - the preferred way to mutate
  const increment = action(() => {
    count.set(count.get() + 1);
  });

  const addItem = action(() => {
    items.push({ title: "New" });
  });

  return {
    [UI]: (
      <div>
        {/* Display is still reactive */}
        <div>Count: {count}</div>

        {/* Can also mutate */}
        <cf-button onClick={increment}>Increment</cf-button>

        {/* Bidirectional binding */}
        <cf-input $value={title} />

        {/* Can also mutate */}
        <cf-button onClick={addItem}>Add Item</cf-button>
      </div>
    ),
  };
});
```

## Results Mirror the Rule: Writable<> in a Result Type Grants Write Access

The same principle applies to what a pattern (or `lift`/`computed`) **returns**.
Cell brands in a result type are exported capabilities, and they are preserved
end-to-end: the brand in the type becomes `asCell` in the generated result
schema, and consumers receive a live `Cell` — same identity, write access
included — not a dereferenced copy.

- **Include `Writable<T>`/`Cell<T>` in a result field** when you intend
  consumers to write to it (or bind it bidirectionally, e.g. `$value`).
- **Omit it** when consumers should only read — return the plain value
  (it's still reactive, as always).

```tsx
// Shown at module scope.
interface CounterOutput {
  count: Writable<number>;   // consumers may .set() / bind $value
  label: string;             // read-only view (still reactive)
}
```

**Export your result type.** Because the factory's result type references your
declared interface by name (`pattern<Input, Output>` produces a
`PatternFactory<…, Output>`), a non-exported `Output` interface fails
compilation with "Default export of the module has or is using private name
'Output'". The result type is the factory's public return contract — export it:

```tsx
// Shown for illustration only.
export interface CounterOutput { /* ... */ }
export default pattern<CounterInput, CounterOutput>(/* ... */);
```

This TypeScript visibility requirement does not make the full output type the
right input schema for every external consumer. A consumer that needs only a
subset should normally declare its own narrow structural projection; see
[Keep External Data Contracts Narrow](../patterns/composition.md#keep-external-data-contracts-narrow).

Consumers see exactly what the author returned — the factory's result type is
not stripped. A consumer that receives `Writable<GameState>` reads current
values with `.get()` inside `computed()`/`lift()`/handler bodies, just like a
`Writable<>` input:

```tsx
// Shown inside a pattern body.
const game = Battleship({});
const phase = computed(() => game.game.get().phase); // game.game: Writable<GameState>
```

## User-Input Updates Are Rate-Shaped

Reactive updates that originate from user input — a click reaching a handler,
a keystroke flowing through a `$value` binding into your computeds and JSX —
are delivered in realtime during normal interaction. Under sustained
high-frequency input (a held key, scripted rapid events), delivery is
throttled to about one update per second per pattern. Nothing is lost: every
handler event is still delivered (a counter counts every click), and a
`$value`-bound cell always shows the latest value when the update arrives.
There is intentionally no opt-out — the throttle is a security measure that
denies sandboxed patterns a fine-grained clock; see
[Timing side-channel mitigations](../../specs/sandboxing/TIMING_SIDE_CHANNELS.md).

Continuous-motion gestures (drawing, drag-tracking with a handler per
pointer-move) are out of scope. Build continuous controls on `$value`-style
bindings, which coalesce to the latest value, rather than on per-move event
handlers.

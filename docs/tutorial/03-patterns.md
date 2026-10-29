# Chapter 3 — Patterns: Programs as Reactive Graphs

A pattern is where cells get behavior: derived values, event handling, and a
UI. This chapter builds the mental model that makes everything else in
pattern authoring fall into place, then walks through a complete real
pattern from the repository.

## The mental model: the body runs once

If you come from React, unlearn one thing first. A React component is a
render function that re-runs on every change. A pattern is **not** that. A
pattern's body runs **once**, at instantiation, to *construct a graph*:
nodes for each derived value, each handler, and the UI. After that, the
runtime keeps the graph alive and re-executes individual *nodes* when their
inputs change. (This is the Solid.js model — components as setup code,
signals as the living thing — extended to durable state.)

This explains nearly every rule in this chapter before you read it:

- Values in the body are *graph handles*, not data. You can't
  `if (count > 3)` in the body — `count` has no value yet; the body runs
  before data flows. Conditional logic lives inside `computed()` or in JSX
  (which the compiler lowers into graph nodes, Chapter 7).
- Code that should re-run goes in a node (`computed`, `action`); code in the
  body runs exactly once, ever.
- The graph is *data* — it can be serialized, stored in a space, and
  re-instantiated by a server that never saw your source file.

## Anatomy of a pattern

The skeleton (`docs/common/concepts/pattern.md`):

```tsx
// Shown for illustration only.
import { Default, NAME, pattern, Stream, UI, type VNode, Writable } from "commonfabric";

interface CounterInput {
  value?: Writable<number | Default<0>>;
}

interface CounterOutput {
  [NAME]: string;        // display name of the piece
  [UI]: VNode;           // its rendered interface
  value: number;         // exposed state — linkable by other pieces
  increment: Stream<void>;  // exposed behavior — callable by others
}

export default pattern<CounterInput, CounterOutput>(({ value }) => {
  // ...build the graph...
  return { [NAME]: ..., [UI]: ..., value, increment: ... };
});
```

The pieces:

- **`pattern<Input, Output>(fn)`** — always supply *both* type parameters in
  real patterns. They aren't decoration: the compiler turns them into the
  schemas that drive subscriptions, linking, and tests. Untyped patterns
  can't have their actions called via `.send()` from tests or the CLI.
- **`[NAME]`** — a symbol key for the piece's display name. A static string
  is fine; derive it with `computed()` if it depends on state.
- **`[UI]`** — a symbol key for the piece's interface (a JSX tree). Chapter 4.
- **The return object is the public API.** Whatever you return — state,
  derived values, streams — is what other pieces can link to and what tests
  can drive. Output types mirror the returned object exactly and never use
  `Writable<>`; actions appear as `Stream<T>`.
- **`export default`** — the deployable entry point (the CLI looks for the
  `default` export).

Name interfaces `<PatternName>Input`/`<PatternName>Output`, not generic
`Input`/`Output`.

## Derived values: `computed()` (and when to reach for `lift()`)

`computed()` is the workhorse. Give it a closure; it becomes a graph node
that re-runs whenever anything it read changes:

```ts
// Shown inside a pattern body.
const itemCount = computed(() => items.get().length);
const activeItems = computed(() => items.get().filter((i) => !i.done));
const displayName = computed(() => `Counter: ${value.get()}`);
```

Dependencies are discovered automatically from what the closure actually
reads — no dependency arrays. Inside the closure you call `.get()`; the
result of `computed()` is itself a reactive value you can pass to JSX, other
computeds, or the return object.

`lift()` is the lower-level primitive `computed()` is built on
(`docs/common/concepts/computed/computed.md`): it turns a pure function into
a reusable reactive operator, and it must be declared at **module scope**:

```ts
// Shown inside a pattern body.
const addCells = lift(({ a, b }: { a: number; b: number }) => a + b);
// inside a pattern:
return { combined: addCells({ a, b }) };
```

Rule of thumb from the docs: it's almost always better to use `computed()`.
Reach for `lift()` only for a derivation you want to reuse across patterns
or call several times. (Old code and cautionary comments mention `derive()`;
it has been removed from the API — use `computed()`.)

One discipline: **`computed()` derives; it never writes.** Calling `.set()`
on an upstream cell inside a computed creates a reactive cycle — the
scheduler will re-run it until it hits its iteration limit and gives up
(Chapter 8).

## Events: `action()` and `handler()`

Cells change because event handlers change them. There are two ways to
declare a handler, and the difference is purely about *where the data comes
from*:

**`action(fn)` — defined inside the pattern body, closes over its state.**
This is the default choice for single-use behavior:

```ts
// Shown inside a pattern body.
const addItem = action((event: { title: string }) => {
  const trimmed = event.title.trim();
  if (trimmed) items.push({ title: trimmed, done: false });
});
```

**`handler<Event, Context>(fn)` — defined at module scope, bound later.**
`Event` is the payload `.send()` receives; `Context` is the state you bind
at the call site:

```ts
// Shown inside a pattern body.
const increment = handler<void, { value: Writable<number> }>(
  (_, { value }) => value.increment(1),
);

// inside the pattern body:
const boundIncrement = increment({ value });
```

The decision rule (`docs/common/ai/pattern-development-guide.md`): *if the
behavior needs different data at different call sites, use `handler()`;
otherwise use `action()`.* Handlers shine for per-item behavior bound inside
`.map()` loops and for logic reused across patterns.

Two hard rules, both consequences of compile-time graph construction:

1. **`handler()` and `lift()` must live at module scope.** The compiler
   cannot lift a handler that closes over pattern-body variables; you'll get
   an error if you try. (`action()` exists precisely to make the common
   closure case ergonomic — the compiler does the capture analysis for you.)
2. **Type annotations on `handler()` are required.** Without them the event
   and context are `any` *and* the runtime gets no schema for what the
   handler may read or write.

Either way, what you get back **is a `Stream`** — a stateless channel.
`boundIncrement.send()` fires it; JSX event attributes accept a stream
directly (`onClick={decrement}`) or a closure that sends
(`onClick={() => boundIncrement.send()}`). Returning a stream from the
pattern exports the behavior: any other piece, test, or CLI invocation can
call `counter.increment.send()`.

## A complete real pattern

This is `patterns/examples/counter/counter.tsx`, lightly trimmed. It uses
every concept above; read it top to bottom.

```tsx
import {
  action, computed, Default, handler, NAME, pattern, Stream, UI,
  type VNode, Writable,
} from "commonfabric";

interface CounterInput {
  value?: Writable<number | Default<0>>;
}

interface CounterOutput {
  [NAME]: string;
  [UI]: VNode;
  value: number;
  increment: Stream<void>;
  decrement: Stream<void>;
}

// Module-scope handler: reusable, bound to context at the call site.
const increment = handler<void, { value: Writable<number> }>(
  (_, { value }) => {
    value.increment(1);
  },
);

// Plain helper — pure functions are fine anywhere.
function ordinal(n: number): string {
  const num = n ?? 0;
  if (num % 10 === 1 && num % 100 !== 11) return `${num}st`;
  if (num % 10 === 2 && num % 100 !== 12) return `${num}nd`;
  if (num % 10 === 3 && num % 100 !== 13) return `${num}rd`;
  return `${num}th`;
}

const Counter = pattern<CounterInput, CounterOutput>(({ value }) => {
  // Bind the module-scope handler to this instance's state.
  const boundIncrement = increment({ value });

  // Pattern-body action: preferred for single-use behavior.
  const decrement = action(() => {
    value.increment(-1);
  });

  // Derived values.
  const displayName = computed(() => `Counter: ${value.get()}`);
  const ordinalDisplay = computed(() => ordinal(value.get()));

  return {
    [NAME]: displayName,
    [UI]: (
      <cf-screen>
        <cf-vstack gap="3" style="padding: 2rem; align-items: center;">
          <div style={{ fontSize: "3rem", fontWeight: "bold" }}>{value}</div>
          <div>Counter is the {ordinalDisplay} number</div>
          <cf-hstack gap="2">
            {/* onClick accepts a Stream directly... */}
            <cf-button variant="secondary" onClick={decrement}>
              - Decrement
            </cf-button>
            {/* ...or a closure that sends explicitly. */}
            <cf-button variant="primary" onClick={() => boundIncrement.send()}>
              + Increment
            </cf-button>
          </cf-hstack>
        </cf-vstack>
      </cf-screen>
    ),
    value,
    increment: boundIncrement,
    decrement,
  };
});

export default Counter;
```

Things worth noticing:

- `value.increment(1)`, not `value.set(value.get() + 1)`. `increment()` is a
  *mergeable* write (Chapter 2): two users clicking at once both count,
  because the server sums the increments instead of letting one
  read-modify-write clobber the other.
- `{value}` appears bare in JSX. No `.get()` — JSX expressions are reactive
  contexts, and the compiler wires the subscription (Chapter 7).
- The pure helper `ordinal()` is called *inside* a `computed()`. The
  computed node is the reactive boundary; the helper stays an ordinary
  function.
- `value`, `increment`, and `decrement` are all exported. A test (Chapter 6)
  drives this counter with `counter.increment.send()` and asserts on
  `counter.value` — no UI involved.

## What patterns may not do

Pattern code runs sandboxed under SES (hardened JavaScript — Chapter 10), so
some ambient capabilities are gated. `Date.now()` (or `new Date()`) and
`Math.random()` are the ordinary built-ins — nothing to import — but the
sandbox allows them only inside an action or handler (the clock coarsened to
one-second resolution) and throws if you call them in a `computed()`, a
`lift()`, or the pattern body. `setTimeout` and `new Proxy()` are missing
outright. Express "later" with reactivity rather than timers, and read a live
clock inside a `computed()` through the reactive `#now` wish. Determinism
isn't pedantry here: the same graph may be re-executed on a server, in another
browser, or replayed after a conflict retry — nondeterministic body code
would diverge.

---

**Next:** [Chapter 4 — UI](04-ui.md): giving the graph a face.
**Under the hood:** how the body-runs-once trick is implemented, and what
`computed`/`handler` compile into — [Chapter 7](07-compilation.md); how the
scheduler decides what to re-run — [Chapter 8](08-runtime-internals.md).

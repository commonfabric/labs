# Handling Events

Use `action()` to handle user events like button clicks, form submissions, and other interactions. Actions close over variables in your pattern, making them simple to write and easy to understand.

## Basic Usage

```tsx
import { action, pattern, Writable, UI } from 'commonfabric';

export default pattern(() => {
  const count = new Writable(0);

  // action() closes over `count` - no binding needed
  const increment = action(() => {
    count.set(count.get() + 1);
  });

  const decrement = action(() => {
    count.set(count.get() - 1);
  });

  return {
    [UI]: (
      <div>
        <div>Count: {count}</div>
        <cf-button onClick={decrement}>-</cf-button>
        <cf-button onClick={increment}>+</cf-button>
      </div>
    ),
  };
});
```

Actions are defined inside your pattern body and naturally close over any cells or state you need to modify. This is the most common and straightforward way to handle events.

## Actions with Event Data

When you need data from the event (like form input), the action receives it as a parameter:

```tsx
// Shown inside a pattern body.
const items = new Writable<string[]>([]);

const addItem = action((event: { title: string }) => {
  items.push(event.title);
});

// In JSX - pass data when calling
<cf-button onClick={() => addItem.send({ title: "New Item" })}>
  Add Item
</cf-button>
```

## Multiple Operations in One Action

Actions can perform multiple mutations in a single handler:

```tsx
// Shown inside a pattern body.
const resetGame = action(() => {
  score.set(0);
  lives.set(3);
  level.set(1);
  gameState.set("ready");
});
```

## SES Notes

Actions are still the default place for event-driven mutations, timestamps, and
one-off IDs.

- Keep action bodies simple and straight-line. Prefer `const` plus direct cell
  operations over `let`, `var`, reassignment, or loops.
- If the logic starts becoming imperative, move the heavy lifting into
  `computed()`, module-scope `lift()`, or a module-scope helper and keep the
  action as the trigger.
- Call `Date.now()` and `Math.random()` directly in authored pattern code.
  These built-ins are gated by the sandbox: allowed inside an action or handler
  (the clock is coarsened to one-second resolution), and they throw a
  `TimeCapabilityError` in a lift/computed or at pattern-body level. For
  reactive time in a computed, read the interval `#now/N` wish (bare `#now` is
  a frozen first-load capture, not a clock).
- Prefer capturing time/random snapshots in the action itself rather than
  inside a `computed()` that may re-run many times.
- For an ID that has to be the same every time the event is handled — a key
  for acting on a request at most once, or the ID of a record the action
  creates — call `eventKey()` rather than `Math.random()`.
  [The key of the event a handler handles](../../features/event-key.md) says
  why.

## Who the Action Acts For

`currentPrincipal()` returns the DID of the user an action or handler acts for:
the authenticated sender of the event it is handling. It returns `undefined`
when no one sent the event, so treat that as "no one" and refuse whatever needs
someone.

```tsx
// Shown inside a pattern body.
const claimedBy = new Writable<string>("");

const claimDonut = action(() => {
  const principal = currentPrincipal();
  if (principal === undefined) return;
  claimedBy.set(principal);
});
```

- The runtime supplies the value, and nothing in the event's data can change
  it. Never take a user's identity from a field of the event.
- It is _authority_, not _intent_. A handler that another pattern calls with
  `.send()` sees the user that pattern runs as, so the value says on whose
  behalf the action runs, not that the person asked for it. Where the person's
  own request matters, rely on a trusted UI gesture or an
  `AuthoredByCurrentUser` value instead.
- It is available only in an action or a handler for now. It throws in a
  pattern body, a `computed()` and a `lift()`. To show who is viewing, resolve
  their profile as [multi-user patterns](../patterns/multi-user-patterns.md)
  describes.

[The principal a handler acts for](../../features/current-principal.md) has the
details.

## When to Use `handler()` Instead

Use `action()` for most cases. Switch to `handler()` when you need to:

1. **Reuse the same logic with different state bindings**
2. **Export the handler for other patterns to call via linking**

```tsx
// Shown inside a pattern body.
// If you need the SAME logic bound to DIFFERENT state:
const increment = handler<void, { count: Writable<number> }>(
  (_, { count }) => count.set(count.get() + 1)
);

// Now you can bind it to different counters
const incrementA = increment({ count: counterA });
const incrementB = increment({ count: counterB });
```

See [Reusable Handlers](./handler.md) for the full `handler()` API.

## Inline Arrow Functions

For very simple one-liners, you can use arrow functions directly in JSX:

```tsx
// Shown as JSX element children.
<cf-button onClick={() => count.set(count.get() + 1)}>+</cf-button>
```

However, `action()` is preferred for:
- Multiple statements
- Better readability
- Giving the action a descriptive name
- Reusing the same action in multiple places

## Summary

| Approach | Use When |
|----------|----------|
| `action()` | Default choice - closes over pattern state |
| Arrow function | Simple one-liners in JSX |
| `handler()` | Reusable logic with different state bindings |

# Pattern Testing

Write automated tests for patterns using the same reactive system.

## Prerequisites

Before writing tests, ensure your pattern:

1. **Uses `pattern<Input, Output>()`** - Single-type patterns can't be properly tested
2. **Exports actions as `Stream<T>`** - Required for `instance.action.send()` to work

```typescript
// Shown at module scope.
// Pattern must have explicit Output type with Stream<T> for testable actions
interface MyOutput {
  count: number;
  increment: Stream<void>;  // ← Enables testing via .send()
}

export default pattern<MyInput, MyOutput>(({ count }) => {
  const increment = incrementHandler({ count });
  return { count, increment };  // ← Must return bound handler
});
```

If your pattern uses `pattern<State>()`, fix the pattern first. See [Pattern Types](../concepts/pattern.md#always-use-dual-type-parameters). A pattern that doesn't export its actions can still be driven through its UI — see [Firing a handler the pattern does not export](#firing-a-handler-the-pattern-does-not-export).

## Overview

Test patterns are patterns that test other patterns. They:
- Import and instantiate the pattern under test
- Define test actions using `action()`
- Define assertions using `assert(() => boolean)`
- Return a `[TESTS]` array that the runner executes sequentially

Test files end in `.test.tsx` and are run with `deno task cf test`.

## Quick Example

```tsx
// Shown at module scope.
import { action, assert, pattern } from "commonfabric";
import Counter from "./counter.tsx";

export default pattern(() => {
  // 1. Instantiate pattern under test with plain values
  const counter = Counter({ value: 0 });

  // 2. Define actions (trigger events on the pattern)
  const action_increment = action(() => {
    counter.increment.send();
  });

  // 3. Define assertions (reactive conditions that report their operands)
  const assert_is_zero = assert(() => counter.value === 0);
  const assert_is_one = assert(() => counter.value === 1);

  // 4. Return the test steps under the [TESTS] key
  return {
    [TESTS]: [
      { assertion: assert_is_zero },
      { action: action_increment },
      { assertion: assert_is_one },
    ],
  };
});
```

**Note:** Pass plain values when instantiating patterns in tests. The runtime creates independent writable cells automatically. Use `new Writable()` only when you need to test shared state behavior. See [Writable](../concepts/types-and-schemas/writable.md#passing-values-to-pattern-inputs) for details.

## Running Tests

```bash
# Run a specific test
deno task cf test packages/patterns/my-pattern/main.test.tsx

# Run with verbose output
deno task cf test packages/patterns/my-pattern/main.test.tsx --verbose

# Run all tests in a directory
deno task cf test packages/patterns/my-pattern/
```

### Testing labeled data

Use `cf test <file> --cfc-shell-posture --verbose --stats-threshold 0` to run
with the shell's `enforce-explicit` enforcement and `persist` flow labels.
Individual dials are `--cfc-enforcement-mode` and `--cfc-flow-labels`; the latter
accepts `off`, `derive` (the runtime's `observe`), `observe`, and `persist`.
The run prints the resolved posture. The
[CLI guide](../../../packages/cli/README.md#pattern-test-cfc-posture-and-labeled-fixtures)
shows how a test declares a local SQLite store with per-column `ifc` labels and
explains the per-step CFC preparation timings.

### Import roots

A test pattern's imports resolve within its root directory. Without `--root`,
`cf test` anchors at the nearest ancestor whose `deno.json(c)` declares a
package name — `packages/patterns` for this repository's patterns — so imports
that span the package (shared helpers such as `test/vnode-helpers.ts`, sibling
patterns, `cfc/` modules) resolve without a flag. A config file with no `name`,
such as a workspace member stub that only defines tasks, does not anchor the
root. Pass `--root` to anchor somewhere else; an import that climbs above the
root fails naming the import and the importing file. The CI "Pattern Unit
Tests" job (the `pattern-tests` target in `tasks/integration.ts`) passes
`--root packages/patterns` explicitly, so a bare local run resolves imports
the same way CI does.

## Test Step Format

Tests use a **discriminated union** format:

```tsx
// Shown inside a pattern body.
return {
  [TESTS]: [
    { action: action_do_something },     // Runner calls .send()
    { assertion: assert_something },     // Runner reads the assert() record
  ],
};
```

Each step is either `{ action: Stream<void> }` or `{ assertion }`, where the
assertion is the record `assert()` produces — see
[Write assertions with `assert()`](#write-assertions-with-assert) below.

## Walking the Rendered Tree

Both actions and assertions often need to reach into what a pattern rendered.
`packages/patterns/test/vnode-helpers.ts` is the one place those helpers live;
import from it rather than writing a private copy in a test file. Each helper
resolves cells as it walks, so a test does not have to unwrap reactive values
by hand.

Reading a single node:

- `readValue(value)` — resolves a cell to the value it holds, and passes
  anything else through unchanged.
- `propsOf(node)` — the node's props, or `undefined` when the node has none.
- `propValue(node, prop)` — one resolved prop off a node.
- `childNodes(node)` — the node's rendered children.
- `textContent(node)` — every text child in the subtree, concatenated. This
  reads text children only. Text a component carries in a prop, such as the
  `label` on a `cf-chip`, is not part of it — search for that prop instead.
- `hasText(node, expected)` — whether the subtree's text contains `expected`.
- `hasExactText(node, expected)` — whether the subtree's text, trimmed, equals
  `expected`.

Searching for a node:

- `findNode(root, predicate)` — the first node in the subtree the predicate
  accepts.
- `findNodeByProp(root, prop, expected)` — the first node whose `prop` resolves
  to `expected`. This is the way to assert on text a component carries in a
  prop.
- `findNodeById(root, id)` — the first node with that `id` prop.
- `findNodeByText(root, expected)` — the first node whose text contains
  `expected`.
- `findElement(root, name)` — the first element with that tag name, such as
  `"cf-image"`.
- `findElementByText(root, name, expected)` and
  `findElementByExactText(root, name, expected)` — the same search narrowed to
  a tag name.

## Writing Actions

Use `action()` to create void streams that trigger events on the pattern:

```tsx
// Shown inside a pattern body.
// Trigger a void handler
const action_reset = action(() => {
  game.reset.send();  // No argument needed for Stream<void>
});

// Trigger a handler with data
const action_add_item = action(() => {
  list.addItem.send({ name: "Test Item", quantity: 5 });
});

// Multiple operations in one action
const action_setup_game = action(() => {
  game.playerReady.send();
  game.startGame.send();
});
```

### Firing a handler the pattern does not export

A handler bound only in JSX can still be fired, so a pattern that keeps its
behavior behind a button does not have to change to be tested. The prop carries
a stream whether the handler was written inline or bound from module scope. Walk
the rendered tree to the node, read the prop, and send it an event:

```tsx
// Shown at module scope.
import { action, pattern, UI } from "commonfabric";
import { findElementByText, propsOf } from "../test/vnode-helpers.ts";
import MapDemo from "./map-demo.tsx";

export default pattern(() => {
  const subject = MapDemo({ areasOfInterest: [] });

  const action_add_area = action(() => {
    const button = findElementByText(subject[UI], "cf-button", "+ Add Area");
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  return { [TESTS]: [{ action: action_add_area }], subject };
});
```

`packages/patterns/map-demo.test.tsx` drives both an inline arrow and a bound
handler this way. `fireEvent(node, prop, event)` in the vnode helpers does the
same for any event prop, and fails when the node binds nothing under it;
`fireClick(node)` is its `onClick` case, with an empty event.
`packages/patterns/scoped-group-chat/submit-on-enter.test.tsx` presses Enter in
a `cf-input` by firing its `oncf-submit`.

Prefer an exported `Stream<T>` when you own the pattern: it states the entry
point in the output type. Use the tree walk when the handler belongs to the UI
and exporting it would only serve the test.

## Writing Assertions

Use `assert()` to state each condition a test checks:

```tsx
// Shown for illustration only.
// Simple equality
const assert_count_is_5 = assert(() => counter.value === 5);

// Complex conditions
const assert_all_items_valid = assert(() => {
  return list.items.every(item => item.quantity > 0);
});

// Multiple conditions
const assert_game_ready = assert(() => {
  return game.phase === "ready" && game.players.length === 2;
});
```

### Write assertions with `assert()`

A test step's `assertion` is the record `assert()` produces; a bare
`Reactive<boolean>` — a `computed()` or a plain cell — is a compile error.
This is what `assert()` buys. A bare boolean could only ever report the value
it produced, because the comparison ran inside a closure and its operands were
gone before the runner saw anything:

```
✗ assertion_1
    Expected true, got false
```

`assert()` records those operands as the assertion runs and reports them on
failure:

```
✗ assertion_1
    total <= budget
      total  = 45
      budget = 30
```

Each operand is labeled with the source text you wrote. `assert()` reports:

- the operands of the top-level operator — `total` and `budget` above
- the arguments of a call — `assert(() => inRange(value, low, high))` reports
  `value`, `low` and `high`
- for `&&`, `||`, `??` and `?:`, which side failed and the values behind it —
  `assert(() => x > 0 && y < 10)` reports `x > 0 = false` along with `x`

Short-circuiting is preserved, so an operand the assertion never evaluated is
never reported: if `x > 0` is false, `&&` never reads `y`, and nothing about
`y` appears. Literal operands are left out, since a literal renders to the text
you already wrote.

Values render the same way the rest of the runner renders them, so a mismatched
object or array shows its contents rather than `[object Object]`.

When a call's arguments say nothing — `items.every((i) => i.ok)`, whose only
argument is a function, or `items.includes("x")`, whose only argument is a
literal — the value reported is the receiver, `items`.

An assertion that recorded no operands at all has nothing to explain itself
with, so it reports the verdict alongside what you wrote:

```
✗ assertion_1
    Expected true, got false: ready
```

That usually means the assertion was a bare value. Compare it against what you
expect — `assert(() => ready === true)` — and the operands appear.

### Use `assert()` only for assertions

`assert()` carries a record of what it recorded, not a bare boolean, and a
record is always truthy. An `assert()` used as a *condition* would always take
the true branch:

```tsx
// Shown for illustration only.
const ready = assert(() => count.value === 5);
// Wrong: `ready` is a record, so this is always "yes".
const label = ifElse(ready, "yes", "no");
```

Reach for `computed()` for a reactive boolean you intend to read as a value,
and keep `assert()` for a test step's `assertion`.

Keep assertions deterministic. Do not call `Date.now()` or `Math.random()`
inside the assertion itself (they are gated and throw in a `computed()`
anyway). If the pattern stamps a timestamp or random ID, assert that the value
exists or changed in the expected place.

## Test Organization

### Naming Conventions

Use descriptive names that explain what the test verifies:

```tsx
// Shown for illustration only.
// Actions: action_<what_it_does>
const action_add_first_item = action(() => { ... });
const action_remove_all_items = action(() => { ... });

// Assertions: assert_<expected_state>
const assert_list_empty = assert(() => list.items.length === 0);
const assert_total_is_100 = assert(() => cart.total === 100);
```

### Logical Ordering

Put actions before the assertions that depend on them:

```tsx
// Shown inside a pattern body.
return {
  [TESTS]: [
    // Initial state
    { assertion: assert_starts_empty },

    // Add items
    { action: action_add_item },
    { assertion: assert_has_one_item },

    // Modify items
    { action: action_update_item },
    { assertion: assert_item_updated },

    // Remove items
    { action: action_remove_item },
    { assertion: assert_empty_again },
  ],
};
```

## Debugging Failed Tests

When a test fails, use the CLI to inspect pattern state:

### 1. Run with Verbose Mode

```bash
deno task cf test ./main.test.tsx --verbose
```

This shows which action ran before each assertion failure. An `assert()`
failure already names its operands and their values, which is usually enough to
see what went wrong without deploying anything.

### 2. Deploy and Inspect

Deploy the test pattern and use CLI commands to inspect state:

```bash
# Deploy the test pattern
deno task cf piece new ./main.test.tsx

# Get the piece ID from the output, then inspect
deno task cf piece inspect --cell <PIECE_ID>

# Get specific values
deno task cf cell get subject/items --cell <PIECE_ID>

# Step through manually (the reserved key is the literal `$TESTS`, quoted so
# the shell does not expand it)
deno task cf piece call --cell <PIECE_ID> '$TESTS/0/action'
deno task cf piece step --cell <PIECE_ID>
deno task cf cell get '$TESTS/1/assertion' --cell <PIECE_ID>
```

This diagnostic command deliberately deploys the test pattern as the executable
entry so its action and assertion cells can be inspected. A normal deployment
uses the subject pattern as the executable entry and attaches this test with
`--test ./main.test.tsx`.

### 3. Expose Debug Data

Add extra fields to your test pattern for debugging:

```tsx
// Shown for illustration only.
return {
  [TESTS]: [...],
  // Expose internals for debugging
  subject,
  debugState: computed(() => ({
    phase: game.phase,
    turn: game.currentTurn,
    scores: game.scores,
  })),
};
```

## Common Patterns

### Seeding Stored State

A scenario that needs the pattern under test to start with data already in it
passes that data as an argument. A literal is fine. A `computed()` is not, for
any input the pattern writes: an argument is a link, so the pattern's own state
would live in the derivation's output cell, and the next run of the derivation
replaces everything the pattern has written since. The rule and its read-only
counterpart are in
[Pattern Composition](../patterns/composition.md#an-input-the-sub-pattern-writes-takes-a-cell).

Timestamps are where this bites, because a test cannot read the ambient clock
from a pattern body and reaches for a `#now` wish instead. The interval form
advances on a wall-clock boundary partway through a long run, so a seed derived
from it re-runs then, and the pattern's state goes with it — which shows up as
a test that passes on a fast machine and loses one step's worth of writes on a
loaded one.

Give such an input a cell of its own and fill it from an action. An action is a
handler, so it can read the clock's current value and write a fixed number:

```tsx
// Shown inside a pattern body.
const nowCell = wish<number>({ query: "#now/300" });
const glazes = Writable.of<{ name: string; bakedAt: number }[]>([]);
const tray = DonutTray({ glazes });

const action_seed_glazes = action(() => {
  const now = nowCell.result;
  if (now === undefined) return;
  glazes.set([{ name: "maple", bakedAt: now - 86_400_000 }]);
});
```

Run that action as the first step, and assert the seed landed before anything
depends on it — reading the seeded value back, rather than only its absence
from a filtered view, so an unresolved wish fails the test instead of passing
it for the wrong reason.

### Testing Initial State

```tsx
// Shown inside a pattern body.
// Verify pattern initializes correctly
const assert_initial_count = assert(() => counter.value === 0);
const assert_initial_empty = assert(() => list.items.length === 0);

return {
  [TESTS]: [
    { assertion: assert_initial_count },
    { assertion: assert_initial_empty },
    // ... actions and more assertions
  ],
};
```

### Testing State Transitions

```tsx
// Shown inside a pattern body.
const action_start = action(() => game.start.send());
const action_pause = action(() => game.pause.send());
const action_resume = action(() => game.resume.send());

const assert_playing = assert(() => game.phase === "playing");
const assert_paused = assert(() => game.phase === "paused");

return {
  [TESTS]: [
    { action: action_start },
    { assertion: assert_playing },
    { action: action_pause },
    { assertion: assert_paused },
    { action: action_resume },
    { assertion: assert_playing },
  ],
};
```

### Testing Computed Values

```tsx
// Shown inside a pattern body.
const action_add_items = action(() => {
  cart.addItem.send({ price: 10, quantity: 2 });
  cart.addItem.send({ price: 5, quantity: 4 });
});

const assert_total_correct = assert(() => {
  // 10*2 + 5*4 = 40
  return cart.total === 40;
});
```

## Best Practices

1. **Self-contained test data**: Keep test data inside actions, not external variables
2. **One thing per assertion**: Each assertion should verify one specific condition
3. **Meaningful names**: Names should describe expected state, not implementation
4. **Test edge cases**: Include actions for empty states, boundaries, error conditions
5. **Expose subject**: Return the pattern under test for CLI debugging

## See Also

- [Testing Handlers via CLI](./handlers-cli-testing.md) - Manual CLI testing workflow
- [Pattern Testing Spec](../../specs/PATTERN_TESTING_SPEC.md) - Technical specification
- [Coverage in CI](../../development/COVERAGE.md) - How the pattern unit tests run here feed the coverage-debt gate
- [Patterns package test lanes](../../../packages/patterns/deno.jsonc) - Where each kind of test (plain Deno unit test, pattern test, integration test) lives in the patterns package and how each is discovered and run

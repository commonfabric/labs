# Pattern Testing System Specification

**Status:** Implemented (v2.3 - Explicit and Continuous VDOM Demand)
**Author:** Claude (with Gideon, Jordan, Berni)
**Date:** 2026-01-13

## Executive Summary

This specification defines a **pattern-native testing system** where tests are
themselves patterns. Test patterns (`.test.tsx` files) import and instantiate
the patterns they test, define test steps using a **discriminated union
format** (`{ action: ... }`, `{ assertion: ... }`, or an explicit harness
primitive), and are run via `cf test`.

**Key insight:** Tests should be patterns too. This dogfoods the pattern system, keeps testing infrastructure in userland, and allows test patterns to be inspected via CLI for debugging.

## Goals

1. **Patterns all the way down** - Tests are patterns, proving the system works
2. **Fast feedback loops** - Tests run with emulated storage (~10ms setup)
3. **Debuggability** - Inspect test patterns via CLI (`cf piece inspect`, `cf cell get`)
4. **Minimal infrastructure** - Reuse existing `piece step` machinery
5. **Self-contained tests** - Test logic lives inside actions, not external scripts

## Non-Goals

- Replacing existing CI integration tests
- Testing cross-piece linking (requires deployment)
- Testing browser DOM rendering, layout, or interaction
- External test runners (Jest, Vitest, etc.)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     cf test <pattern.test.tsx>              │
│  (compiles, runs, and validates test pattern results)       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Test Pattern (.test.tsx)                 │
│  ┌─────────────────┐  ┌─────────────────┐                   │
│  │ Pattern Under   │  │  Test Actions   │                   │
│  │ Test (imported) │  │  (Stream<void>) │                   │
│  └────────┬────────┘  └────────┬────────┘                   │
│           │                    │                            │
│           ▼                    ▼                            │
│  ┌─────────────────────────────────────────┐                │
│  │    Assertions (Cell<AssertRecord>)      │                │
│  │  (computed from pattern state)          │                │
│  └─────────────────────────────────────────┘                │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Runtime + StorageManager.emulate()             │
│  (In-memory, no I/O, ~10ms instantiation)                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Test Pattern Structure

A test pattern is a regular pattern file with `.test.tsx` extension that:

1. **Imports the pattern under test**
2. **Instantiates it with test data**
3. **Defines test actions using `action()`** (for triggering events on the pattern)
4. **Defines assertions as `assert(() => boolean)`** computed from pattern state
5. **Returns a `[TESTS]` array** of discriminated union objects

### Test Step Format (Discriminated Union)

The `[TESTS]` array is a discriminated union — each step is exactly one of the
shapes below. Keeping an assertion's `Cell` and an action's `Stream` in
separate members, rather than mixing the two in one array element, is what
avoids the declaration-emit errors TypeScript raises for such a mix:

```typescript
// Shown at module scope.
import type { AssertRecord } from "commonfabric";

type TestStep =
  | { assertion: Reactive<AssertRecord> } // from assert(() => condition)
  | {
    action: Stream<unknown>; // from action(() => handler.send())
    event?: unknown; // the payload, sent to the stream as authored
    trustedUi?: { surface: string; action: string };
  }
  | { render: VNode } // one headless VDOM demand window
  | { settle: true } // wait for full async settlement
  | { label: string } // announce a marker to other participants
  | { await: string }; // block until a participant announces it
```

An action step's `event` is the payload the stream receives, sent as authored:
an object arrives as an object. `trustedUi` names a trusted UI surface and the
control inside it, for an action that must originate from rendered UI under
enforcement.

`{ label }` and `{ await }` synchronize a multi-user test — a participant
announces reaching `label`, and another blocks on `await` until it is
announced. A single-user run has no participant to synchronize with, so both
are inert there: recognized, skipped, and absent from the reported results.

An assertion is an `AssertRecord` — `{ ok, source, parts }` — which `assert()`
is the only way to write; a bare `Reactive<boolean>` is a compile error. The
transformer rewrites the `assert` body to record each operand as it is
computed, so a failure can report the operands and their values instead of
only `false`. See
[Assertion diagnostics](../../packages/ts-transformers/README.md#assertion-diagnostics)
for the rewrite, and
[Pattern Testing](../common/workflows/pattern-testing.md#write-assertions-with-assert)
for the authoring side.

`cf test` does not mount a renderer by default. Under the pull scheduler, a
pattern's `$UI` is therefore not continuously demanded. A
`{ render: subject[UI] }` step materializes that VDOM through the worker
reconciler at the current test state, discards the resulting DOM operations,
waits for the recursively discovered UI computations to settle, and unmounts
before the next step. This is VDOM evaluation, not browser rendering.

For stress and performance runs, `CF_TEST_CONTINUOUS_UI=1` mounts the test
descriptor's exported `[UI]` before initial settlement and keeps it demanded
until cleanup. This opt-in mode applies independently to every multi-user
participant and does not change the semantics of explicit `render` steps.

### Example Test Pattern

```tsx
// Shown at module scope.
import { action, assert, pattern, Writable } from "commonfabric";
import ExpenseTracker from "./expense-tracker.tsx";

type Expense = { description: string; amount: number; category: string };

// Test pattern for expense tracker
export default pattern(() => {
  // 1. Instantiate the pattern under test with initial state
  const subject = ExpenseTracker({
    expenses: new Writable<Expense[]>([]),
  });

  // 2. Define test actions using action() - triggers events on the pattern
  const action_add_expense = action(() => {
    subject.addExpense.send({ description: "Coffee", amount: 5, category: "food" });
  });

  const action_add_another = action(() => {
    subject.addExpense.send({ description: "Gas", amount: 40, category: "transport" });
  });

  // 3. Define assertions as assert(() => boolean)
  const assert_has_one_expense = assert(() => {
    return subject.expenses.length === 1;
  });

  const assert_total_is_45 = assert(() => {
    return subject.result.totalAmount === 45;
  });

  const assert_categories_correct = assert(() => {
    const byCategory = subject.result.byCategory;
    return byCategory.food === 5 && byCategory.transport === 40;
  });

  // 4. Return the test steps under the [TESTS] key
  return {
    [TESTS]: [
      { action: action_add_expense },       // Runner calls .send()
      { assertion: assert_has_one_expense }, // Runner checks its `ok`
      { action: action_add_another },
      { assertion: assert_total_is_45 },
      { assertion: assert_categories_correct },
    ],
    // Expose subject for debugging (optional)
    subject,
  };
});
```

### Test Execution Flow

The `cf test` runner processes the `[TESTS]` array **in order**:

1. For each item in `[TESTS]`:
   - If it has `action` key: call `.send()`, then `await runtime.idle()`
   - If it has `assertion` key: demand it with `.sink()`, await the async work
     that demand started, then read `.pull()` once, which settles the
     scheduler before it takes the value; an `AssertRecord` passes when its
     `ok` is true, any other value passes when it equals `true`. That read is
     the only one, so a value arriving later is a failure.
2. Report pass/fail for each assertion
3. Await cleanup before returning the results

```
┌──────────────────────────────────────────────────────────────┐
│  [TESTS]: [                                                  │
│    { action: action1 },                                      │
│    { assertion: assert1 },                                   │
│    { action: action2 },                                      │
│    { assertion: assert2 },                                   │
│  ]                                                           │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  1. "action" in step? → step.action.send()                   │
│  2. await runtime.idle()                                     │
│  3. "assertion" in step? → demand, settle, one await pull()  │
│     ✓ PASS / ✗ FAIL                                          │
│  ... repeat for each step                                    │
└──────────────────────────────────────────────────────────────┘
```

**Note:** For `Stream<void>`, `.send()` can be called with no arguments. The event parameter is optional when `T` is `void`.

---

## Test Isolation

**Each test group gets a fresh pattern instance.** For now, a test pattern = one test group. Each run of `cf test` creates:

1. Fresh `StorageManager.emulate()`
2. Fresh `Runtime`
3. Fresh pattern instantiation

This ensures tests don't have interdependencies.

---

## CLI Command

### Usage

```bash
# Run a specific test pattern
cf test ./expense-tracker.test.tsx

# Run all test patterns in a directory
cf test ./patterns/
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--verbose` | Show detailed execution logs | false |
| `--compile-only` | Compile each file's program into the compile byte cache and run nothing; with `CF_COMPILE_CACHE_FILE` set, a later run of the same files compiles none of it | false |

Settlement and worker requests wait for completion without a wall-clock
limit. Runtime and worker errors still fail the run; an unannounced marker
fails with a deadlock report. Cleanup completes before results are returned.
CI bounds the overall run with its step and job limits. Cancel a local run
that never settles with Ctrl-C.

### Output

```
$ cf test ./expense-tracker.test.tsx

expense-tracker.test.tsx
  ✓ assert_has_one_expense (after action_add_expense)
  ✓ assert_total_is_45 (after action_add_another)
  ✓ assert_categories_correct

3 passed, 0 failed (47ms)
```

---

## Runner Implementation

### Algorithm

The runner itself is `packages/cli/lib/test-runner.ts`. The sketch below is a
reading aid for the shape of the loop, not a second copy of it: it leaves out
the convergence loop an action and a render step settle through, the read
accounting and error handling around each step, and the multi-user paths.
Behavior that matters belongs in the code and in the prose above — change one
of those and this sketch needs the same edit, so keep it short enough to be
worth having.

```typescript
// Shown for illustration only.
async function runTestPattern(testPath: string, options: TestOptions): Promise<TestResults> {
  // 1. Create emulated runtime (same as piece step)
  const identity = await Identity.fromPassphrase("test-runner");
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url)
  });
  // The runtime's OWN harness, never a second Engine: verified-load
  // registration, source maps and module hashes live on the engine that
  // evaluates the bundle, and splitting them breaks CFC verified bindings.
  const engine = runtime.harness;

  // 2. Compile and run the test pattern
  const program = await resolveLocalProgram(
    (resolver) => engine.resolve(resolver),
    { main: testPath, dataFilePaths: options.dataFilePaths },
  );
  const { main } = await engine.process(program, { noCheck: false, noRun: false });
  const testPatternFactory = main.default as Pattern;

  // 3. Instantiate the test pattern with proper space context
  const tx = runtime.edit();
  const resultCell = runtime.getCell(space, `test-pattern-result-${Date.now()}`, undefined, tx);
  const patternResult = runtime.run(tx, testPatternFactory, {}, resultCell);
  await tx.commit();
  await runtime.idle();

  // No renderer is mounted by default. Values run only when a test step
  // explicitly demands them.

  // 4. Get the [TESTS] array from pattern output
  const testsCell = patternResult.key(TESTS) as Cell<unknown>;
  const testsValue = testsCell.get();
  if (!Array.isArray(testsValue)) {
    throw new Error("Test pattern must return { [TESTS]: TestStep[] }");
  }

  // 5. Process tests in order using discriminated union format
  const results: TestResult[] = [];
  let lastActionIndex: number | null = null;
  let assertionCount = 0;
  let actionCount = 0;

  for (let i = 0; i < testsValue.length; i++) {
    const stepValue = testsValue[i] as {
      action?: unknown;
      assertion?: unknown;
      render?: unknown;
      settle?: boolean;
      label?: string;
      await?: string;
      event?: unknown;
      trustedUi?: { surface: string; action: string };
    };

    // Check discriminated union keys
    const isAction = "action" in stepValue;
    const isAssertion = "assertion" in stepValue;
    const isRender = "render" in stepValue;
    const isSettle = "settle" in stepValue;
    // Inert in a single-user run, but still a step the runner knows.
    const isMarker = "label" in stepValue || "await" in stepValue;

    if (isMarker) continue;

    if (!isAction && !isAssertion && !isRender && !isSettle) {
      throw new Error(`Test step at index ${i} has no supported discriminant`);
    }

    if (isAction) {
      // It's an action - invoke it via .key() access
      actionCount++;
      lastActionIndex = i;
      const actionStream = testsCell.key(i).key("action") as Stream<unknown>;
      // The step's payload, `undefined` for a plain void action. A
      // `trustedUi` step wraps it in the DOM provenance a renderer would
      // attach, so a write guarded by a UI contract sees a trusted gesture.
      actionStream.send(buildActionEvent(stepValue.event, stepValue.trustedUi));

      await runtime.idle();

    } else if (isAssertion) {
      // It's an assertion - read the value via .key() access. An assert(...)
      // carries a record of the operands it recorded; anything else carries a
      // bare boolean.
      assertionCount++;
      const assertCell = testsCell.key(i).key("assertion") as Cell<unknown>;
      // Demanding the assertion starts a lazy async builtin; the demand is
      // held across the wait so the work it starts stays reachable.
      const releaseDemand = assertCell.sink(() => {});
      let value: unknown;
      try {
        await runtime.settled();
        value = await assertCell.pull();
      } finally {
        releaseDemand();
      }
      const record = asAssertRecord(value);
      const passed = record ? record.ok : value === true;

      results.push({
        name: `assertion_${assertionCount}`,
        passed,
        afterAction: lastActionIndex !== null ? `action_${actionCount}` : null,
        error: passed
          ? undefined
          : record
          ? formatAssertRecord(record)
          : debugStr`Expected true, got $quote,long${value}`,
      });
    } else if (isRender) {
      await materializeTestVDOM(testsCell.key(i).key("render"), settleRuntime);
    } else {
      await runtime.settled();
    }
  }

  // 6. Cleanup. `dispose()` also closes the storage manager; a caller that
  // supplied its own passes `{ closeStorage: false }` and closes it itself.
  await runtime.dispose();

  return { results, path: testPath };
}
```

### Key Implementation Details

- **Discriminated union detection:** Check `"action" in step` vs `"assertion" in step`
- **Cell access via `.key()`:** Access test steps through reactive cell interface
- **Action payload:** The step's `event` reaches the stream as authored — an
  object arrives as an object — and a `trustedUi` step wraps it in the DOM
  provenance a renderer would attach. A plain void action carries no `event`
  and sends `undefined`.
- **Explicit VDOM demand:** A `render` step mounts the worker reconciler only
  for that step; DOM operations are discarded and demand is cleaned up

---

## Test Pattern Guidelines

### Do: Use `action()` for Test Actions

Use the `action()` helper to create void streams that trigger events on the pattern:

```tsx
// Shown inside a pattern body.
// ✅ Good - use action() to trigger pattern handlers
const action_add_expense = action(() => {
  subject.addExpense.send({ description: "Coffee", amount: 5, category: "food" });
});
```

### Do: Self-Contained Test Data

Test actions should contain all test data inside them:

```tsx
// Shown as alternative snippets.
// ✅ Good - hardcoded test data inside action
const action_add_expense = action(() => {
  subject.addExpense.send({ description: "Coffee", amount: 5, category: "food" });
});

// ❌ Bad - test data defined elsewhere
const testData = { description: "Coffee", amount: 5, category: "food" };
const action_add_expense = action(() => {
  subject.addExpense.send(testData);
});
```

### Do: Meaningful Assertion Names

Use descriptive assertion names:

```tsx
// Shown inside a pattern body.
// ✅ Good - name describes what's being tested
const assert_total_equals_45 = assert(() => subject.result.total === 45);
const assert_items_sorted_by_date = assert(() => isSorted(subject.items));

// ❌ Bad - generic names
const test1 = assert(() => subject.result.total === 45);
```

### Do: Use Discriminated Union Format

Wrap actions and assertions in their respective object format:

```tsx
// Shown inside a pattern body.
// ✅ Good - discriminated union format
return {
  [TESTS]: [
    { action: action_add_item },
    { assertion: assert_has_one_item },
    { action: action_remove_item },
    { assertion: assert_empty },
  ],
};

// ❌ Bad - flat array (causes TypeScript declaration emit issues)
return {
  [TESTS]: [action_add_item, assert_has_one_item, action_remove_item, assert_empty],
};
```

### Do: Order Tests Logically

Put actions before the assertions that depend on them:

```tsx
// Shown inside a pattern body.
return {
  [TESTS]: [
    { action: action_add_item },     // First, add an item
    { assertion: assert_has_one_item }, // Then, verify it was added
    { action: action_remove_item },  // Then, remove it
    { assertion: assert_empty },     // Then, verify it's empty
  ],
};
```

---

## Implementation Phases

### Phase 1: Core Runner (MVP) ✅ COMPLETE

**Deliverables:**
- [x] `cf test` command in CLI
- [x] Test pattern compilation and execution
- [x] Stream/Cell detection and processing
- [x] Basic pass/fail reporting
- [x] Example test pattern

**Files created:**
- `packages/cli/commands/test-command.ts`
- `packages/cli/lib/test-runner.ts`
- `packages/patterns/gideon-tests/test-reactivity-computed-derive-same/index.test.tsx`

### Phase 2: Developer Experience

**Deliverables:**
- [ ] Better assertion error messages (show expected vs actual)
- [ ] Test name extraction from cell/handler definitions
- [ ] `--verbose` mode with execution trace
- [ ] Directory scanning for `*.test.tsx` files
- [ ] Exit codes for CI integration

### Phase 3: Advanced Features

**Deliverables:**
- [ ] `--watch` mode for TDD
- [ ] Test pattern scaffolding (`cf test --scaffold pattern.tsx`)
- [ ] Parallel test execution
- [ ] Test coverage reporting (which pattern paths were exercised)

---

## Migration from v1

The v1 approach (external test harness with `@commonfabric/pattern-testing` package) has been deprecated and removed. The pattern-native approach provides:

- **Better debugging** - Deploy test pattern as piece
- **Consistency** - Tests use the same patterns as production
- **Simplicity** - No separate test harness to maintain

The `@commonfabric/pattern-testing` package has been removed from the codebase.

---

## Design Decisions

### Why patterns as tests?

1. **Dogfooding** - If patterns can't test themselves, something is wrong
2. **Debuggability** - Inspect test pattern state via CLI commands
3. **Minimal infrastructure** - Reuse `piece step` machinery
4. **Composability** - Test patterns can link to other patterns

### Why discriminated union format?

1. **Type safety** - Avoids TypeScript declaration emit errors with mixed arrays
2. **Explicit intent** - Clear whether a step is an action or assertion
3. **Extensible** - Can add more step types in the future (e.g., `{ wait: ms }`)

### Why sequential array instead of parallel?

1. **Simpler mental model** - Order matters, easy to reason about
2. **Explicit dependencies** - Actions before assertions is clear
3. **Deterministic** - Same order every time

### Why `action()` for test actions?

1. **Self-contained** - Tests don't need external test data
2. **Simpler runner** - Just call `.send()` (no arguments for void)
3. **Readable** - Test data is visible in the action body

### Why `assert(() => boolean)` for assertions?

1. **Reactive** - Assertions are computed from live pattern state
2. **Pattern-native** - Uses the same Cell system as patterns
3. **Debuggable** - Can inspect assertion cell values via CLI
4. **Self-explaining** - A failure reports the operands and their values,
   rather than only the boolean the comparison collapsed to

---

## Success Criteria

1. **Test patterns run in < 100ms** for typical patterns
2. **Test patterns can be deployed as pieces** for debugging
3. **The runner correctly detects Stream vs Cell<boolean>**
4. **The CI step and job limits bound a run that never settles**
5. **Error messages identify which assertion failed and why**, naming the
   operands of a failed `assert(...)` and the values they held

---

## Appendix: Full Example

### Pattern Under Test

```tsx
// counter.tsx
import { Cell, Default, handler, NAME, pattern, UI, type Stream } from "commonfabric";

const increment = handler<void, { value: Cell<number> }>(
  (_, { value }) => value.set(value.get() + 1)
);

const decrement = handler<void, { value: Cell<number> }>(
  (_, { value }) => value.set(value.get() - 1)
);

interface Input { value: number | Default<0>; }
interface Output { value: number; increment: Stream<void>; decrement: Stream<void>; }

export default pattern<Input, Output>(({ value }) => ({
  [NAME]: "Counter",
  [UI]: <div>{value}</div>,
  value,
  increment: increment({ value }),
  decrement: decrement({ value }),
}));
```

### Test Pattern

```tsx
// Shown at module scope.
// counter.test.tsx
import { Writable, action, assert, pattern } from "commonfabric";
import Counter from "./counter.tsx";

export default pattern(() => {
  // Instantiate counter with initial value
  const counter = Counter({ value: new Writable(0) });

  // Test actions - use action() to create void streams
  const action_increment = action(() => {
    counter.increment.send();  // No argument needed for void streams
  });

  const action_increment_twice = action(() => {
    counter.increment.send();
    counter.increment.send();
  });

  const action_decrement = action(() => {
    counter.decrement.send();
  });

  // Assertions - assert(() => boolean)
  const assert_starts_at_zero = assert(() => counter.value === 0);
  const assert_is_one = assert(() => counter.value === 1);
  const assert_is_three = assert(() => counter.value === 3);
  const assert_is_two = assert(() => counter.value === 2);

  return {
    [TESTS]: [
      { assertion: assert_starts_at_zero },  // Initial state check
      { action: action_increment },
      { assertion: assert_is_one },          // After 1 increment
      { action: action_increment_twice },
      { assertion: assert_is_three },        // After 2 more increments
      { action: action_decrement },
      { assertion: assert_is_two },          // After 1 decrement
    ],
  };
});
```

### Running the Test

```bash
$ deno task cf test ./counter.test.tsx

counter.test.tsx
  ✓ assertion_1
  ✓ assertion_2 (after action_1)
  ✓ assertion_3 (after action_2)
  ✓ assertion_4 (after action_3)

4 passed, 0 failed (32ms)
```

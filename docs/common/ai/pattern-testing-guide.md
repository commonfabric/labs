# Pattern Testing Guide

This is the canonical reference for testing Common Fabric patterns.

## Preconditions

Before writing tests, verify the pattern exposes an interface that tests can
exercise:

- `pattern<Input, Output>()`
- actions typed as `Stream<T>` where tests need to call `.send()`
- bound handlers returned from the pattern when the behavior is externally
  triggered

If those are missing, fix the pattern first. Tests cannot meaningfully drive
the pattern without a testable output contract.

## Preferred Test Scope

Write tests for:

- state transitions that are awkward to verify by clicking
- regressions that are easy to reintroduce
- edge cases with real branching logic

For Pattern Factory Build, prefer tests that cover the product contract rather
than only the happy path:

- first-run/default and sparse states
- primary add, remove, edit, toggle, or submit flows
- repeated actions and important state transitions
- validation, empty, partial, or edge-case branches from the spec
- helper or wrapper behavior that would otherwise only fail in a browser

Avoid tests for:

- code that is still only a sketch
- behavior that is obvious and cheap to validate interactively
- flows that are better validated in runtime or browser testing

## Test Command

```bash
deno task cf test <pattern>.test.tsx
```

Imports resolve from the nearest ancestor directory whose `deno.json(c)`
declares a package name (`packages/patterns` for this repository's patterns),
so imports that span the package — shared helpers, `cfc/` modules — work
without a flag. A failure naming an import that "escapes the program root"
means the file imports from above that root; pass `--root` naming a common
ancestor. CI runs these tests with `--root packages/patterns`.

If `cf test` fails, treat that as repair work. Preserve the failing command and
relevant output, isolate the smallest failing action/assertion when useful, fix
either the implementation or an invalid test contract, and rerun the test. A
failing pattern test is not a valid done state unless a concrete external,
tooling, or environment blocker prevents further repair.

For non-obvious `cf test` failures, read
`docs/development/debugging/README.md` before changing the test shape. Match the
exact error to the matrix and follow the linked doc. For Cell, Writable, or
reactive-value failures, also reread:

- `docs/common/concepts/reactivity.md`
- `docs/common/patterns/new-cells.md`

## Test File Shape

The usual shape is:

1. instantiate the pattern under test
2. define actions that trigger output streams or bound handlers
3. define assertions as `assert(() => boolean)`
4. return the test sequence in order

```tsx
// Shown at module scope.

import { action, assert, pattern } from "commonfabric";
import Pattern from "./pattern.tsx";

export default pattern(() => {
  const instance = Pattern({ /* input */ });

  const actionDoSomething = action(() => {
    instance.someAction.send();
  });

  const assertInitialState = assert(() => instance.someField === expectedValue);
  const assertAfterAction = assert(() => instance.someField === newValue);

  return {
    [TESTS]: [
      { assertion: assertInitialState },
      { action: actionDoSomething },
      { assertion: assertAfterAction },
    ],
  };
});
```

## Key Points

- write assertions with `assert()`; a step's `assertion` accepts only the
  record `assert()` produces, so a bare `computed()` boolean is a compile
  error, and a failed `assert()` reports its operands while a bare value cannot
- trigger actions with `.send()` when the output exposes streams
- use direct property access for assertions rather than `.get()` unless the API
  truly requires writable access
- keep scenario ordering readable; tests should tell the story of the state
  transition
- test a sub-pattern before building the next dependent layer when that helps
  isolate failures

## Reading a Failed Assertion

An `assert()` failure names the operands and the values they held:

```
✗ assertion_2 (after action_1)
    instance.total <= budget
      instance.total = 45
      budget         = 30
```

Read it before reaching for other tools. It tells you which side was wrong and
by how much, which is usually enough to locate the bug — no deploy, no
inspection of the running piece. Without the operands the record carries, only
the verdict survives — the comparison ran inside the closure and the boolean is
all that is left:

```
✗ assertion_2 (after action_1)
    Expected true, got false
```

A failure that reports the verdict ahead of the source had no operands worth
recording:

```
✗ assertion_2 (after action_1)
    Expected true, got false: instance.ready
```

Usually that means the assertion was a bare value rather than a comparison or
call. Compare against what you expect (`assert(() => instance.ready === true)`)
and the operands appear. The same happens when every operand is a literal,
since a literal renders to the text you already wrote.

Use `assert()` only for a test step's `assertion`. It carries a record rather
than a bare boolean, and a record is always truthy — so an `assert()` used as a
condition, in `ifElse()` or a JSX branch, would always take the true branch.
Use `computed()` for a reactive boolean you intend to read as a value.

## Headless VDOM Materialization

`cf test` remains headless and does not demand a pattern's `$UI` by default.
That is important under the pull scheduler: state and assertion computations
run because the harness pulls them, but conditional or nested VDOM can remain
dirty unless a renderer asks for it.

When a test specifically needs the VDOM evaluated at the current step, add an
explicit render step after the action that creates that state:

```tsx
// Shown for illustration only.
const subject = Pattern({});

return {
  [TESTS]: [
    { action: actionReachLateState },
    { render: subject[UI] },
    { assertion: assertLateState },
  ],
};
```

The step initially pulls the target through the renderer's VDOM schema, validates
the root value, and mounts the same worker reconciler implementation used by the
renderer. It discards the generated DOM operations, waits for recursively
discovered VDOM cells to settle, and immediately unmounts. It is transparent
to assertion counts, honors `skip: true`, and is supported in both single- and
multi-user tests.

This primitive does not create a browser DOM. Use browser tests for element
queries, layout, screenshots, accessibility-tree behavior, or real event
dispatch. Keep render steps targeted: each one evaluates a full VDOM subtree
and costs more than pulling a state assertion.

### Continuous `$UI` Stress Mode

For occasional stress, coverage, or performance runs, a test can also export
the subject's UI from its own descriptor:

```tsx
// Shown for illustration only.
return {
  [UI]: subject[UI],
  [TESTS]: [
    { action: actionReachLateState },
    { assertion: assertLateState },
  ],
};
```

Then enable a renderer-lifetime demand for that exported UI:

```bash
CF_TEST_CONTINUOUS_UI=1 deno task cf test <pattern>.test.tsx
```

The harness mounts `$UI` before its initial settle, keeps it demanded through
every action and assertion, and unmounts during cleanup. In multi-user tests,
each participant may export its own `[UI]`, which is mounted in that
participant's worker. The flag does not change `{ render: ... }` semantics;
those remain one-step checkpoints.

Continuous mode is deliberately opt-in because it broadens work and can expose
timing or performance behavior outside the deterministic unit-style contract.
For a detailed performance run, combine it with
`--verbose --stats-threshold 0` and pattern coverage as needed.

## Console Errors and Warnings Fail Tests

`cf test` fails a test when anything is logged at error or warn level during
the run phase, even if every assertion passes. Two channels are captured:
`console.error`/`console.warn` calls from pattern code, and error/warn-level
activity from the runtime's own loggers (reported by logger name and message
key). A clean run is part of the contract — a passing test that logs errors
hides real failures (this is how a production CFC commit-rejection shipped
behind green tests).

One runtime warning is worth knowing by name. `[logger:schema-view] …
(key: unselected-key-read)` means a lift read a field its input schema does not
select, and got `undefined` for a field the data holds. The schema is narrower
than the code: written by hand that way, or shrunk past a read the analysis that
derives it did not see. See
[lazy cell materialization](../../features/lazy-cell-materialization.md#reading-a-key-the-schema-does-not-select).

If a test intentionally provokes errors or warnings, opt out explicitly on the
returned descriptor — each flag covers only its own level:

```tsx
// Shown inside a pattern body.
return {
  [TESTS]: [/* ... */],
  allowConsoleErrors: true, // expected console/logger errors don't fail
  allowConsoleWarnings: true, // expected console/logger warnings don't fail
};
```

In multi-user tests the flags are per participant: one participant opting out
does not mask another participant's errors. (The same applies to the
pre-existing `allowRuntimeErrors` flag for scheduler-level errors; use
`expectRuntimeErrors: true | <count>` when the errors are the point — it
REQUIRES them, failing the run if none fire.)

## Multi-User Tests

A single-runtime test cannot exercise `PerUser`/`PerSession` scoping or
cross-client propagation — one runtime is one user and one session. For
patterns with multi-user behavior, export a `multiUserTest` descriptor as the
default export instead of a single test pattern. `cf test` then runs each
participant pattern in its own isolated runtime (own identity, own realm)
against one shared space on an in-process storage server.

```tsx
// Shown for illustration only.
import { action, assert, multiUserTest, pattern } from "commonfabric";
import Chat, { type ChatOutput } from "./pattern.tsx";

interface Setup {
  chat: ChatOutput;
}

// Instantiates the shared state ONCE; every participant runtime runs this
// same instance (like every browser tab does) and receives its result as
// the `setup` input.
export const setup = pattern(() => ({ chat: Chat({}) }));

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const save = action(() => setup.chat.saveProfile.send());
  const sees_bob = assert(() => /* ... */);
  return {
    [TESTS]: [
      { action: save },
      { label: "alice-saved" }, //  announce a marker
      { await: "bob-saved" }, //    park until bob announces
      { assertion: sees_bob },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  /* ... */
});

export default multiUserTest({ setup, participants: { alice, bob } });
```

Key points:

- A participant's steps run in order; cross-participant ordering happens
  ONLY at `{ label: "name" }` / `{ await: "name" }` markers. If every
  remaining participant is parked on an unannounced marker, the test fails
  with a deadlock report.
- Each participant gets its own identity. Use
  `{ pattern: aliceTab2, user: "alice" }` for a second session of an
  existing user (PerUser state shared, PerSession state isolated).
- A marker is a durable write in the shared space, so crossing
  `{ await: "name" }` means everything the announcing participant committed
  before `{ label: "name" }` has reached this runtime. An assertion is read
  once, there: a false value is a failure rather than a cue to wait longer.
  Put every assertion about another participant's state after the marker
  that carries it. A marker says what HAS arrived and nothing about what has
  not, so "other user does NOT see X yet" is still not something to assert —
  assert stable invariants instead.
- Pattern outputs a participant asserts on must be computed snapshots that
  always yield a REAL, STABLE value. In a runtime that didn't write the
  underlying scoped cell, the cell reads as `undefined` — and a computed that
  returns `undefined` (or a fresh `[]` per recompute) is indistinguishable
  from "not yet computed" for cross-runtime readers, so the assertion never
  sees the value the writing runtime holds. Normalize inside the computed
  (`trimmedName(name.get())`, `cell.get() ?? EMPTY_LIST` with a module-level
  constant).
- Read another runtime's arrays with INLINE literal indexing in the assertion
  body (`users?.[0]?.name === "Alice"`). `.map()`, loop-variable
  indexing, and module-level helper calls over the array resolve in the
  runtime that wrote it but NOT cross-runtime before a local write.
- A participant cannot read their own never-written `PerUser` array (e.g. an
  empty rack before joining); assert pre-join isolation via normalized
  primitives (`myName === ""`) instead.
- The example to copy:
  `packages/patterns/cfc-group-chat-demo/multi-user.test.tsx`; for the
  output-snapshot and inline-read idioms see
  `packages/patterns/scrabble/multi-user.test.tsx` and
  `packages/patterns/lunch-poll/multi-user.test.tsx`. The scope model
  background: `docs/common/patterns/multi-user-patterns.md` and
  `docs/development/debugging/gotchas/scoped-cell-pitfalls.md`.

## Testing Time and Randomness

If a pattern reads the clock with `Date.now()`/`new Date()` or draws entropy
with `Math.random()` (allowed inside a handler, coarsened to one-second
resolution for the clock), keep the assertions deterministic:

- prefer asserting that a value was set, changed, or has the expected shape
- avoid calling `Date.now()` or `Math.random()` inside a test `assert()`
  assertion — those built-ins throw a `TimeCapabilityError` in a computation
- if you need an exact value, capture it in the action under test and assert
  against the captured result rather than recomputing it in the assertion

## Done When

- the test file exists beside the pattern or in the expected local test layout
- the tests pass
- the test report explains what was covered and what was intentionally omitted
- the pattern still compiles after any interface changes made to support
  testing
- the pattern is ready for the next dependent sub-pattern or release step

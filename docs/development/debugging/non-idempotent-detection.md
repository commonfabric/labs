# Detecting Non-Idempotent Computations

Patterns define reactive computations (`computed`, `lift`) that must
be **idempotent**: given the same inputs, they must produce the same outputs.
When they don't, each run that repeats the same inputs changes state again. A
computation is not re-run for its own writes, but when its writes trigger
another computation whose writes trigger it in turn, the scheduler never
settles. This manifests as the UI churning, high CPU usage, and the system never
reaching a stable state.

Common causes:

- A `computed()` that calls `.set()` on a `Writable<>` with a value derived
  from a non-deterministic source such as `crypto.randomUUID()` (the ambient
  clock and entropy — `Date.now()`, `Math.random()` — no longer reach this
  failure mode: they throw a `TimeCapabilityError` inside a `computed()`/`lift()`
  rather than churning)
- Converting a `Set` to an array where iteration order varies between runs
- Appending to an array on each execution instead of replacing it
- Two actions forming a cycle: A writes cell X which triggers B, B writes
  cell Y which triggers A
- A mapped render body that invokes a stream or writes to state immediately,
  such as `onClick={stream.send(index)}` inside `.map(...)`, instead of passing
  a handler to run when the event fires. This often appears as
  `non-idempotent raw:map` or
  `Reactive graph did not settle ... Actions: raw:map`; see
  [Immediate Event Invocation](gotchas/immediate-event-invocation.md).

Scheduler-v2 reports a bounded non-convergence episode as a warning instead of
throwing an action error. The warning names the deferred actions and the
scheduler continues retrying them behind an escalating backoff, so use the
diagnosis below to distinguish a true cycle from a slow convergence wave. The
warning is emitted at most once per run of settle passes; the
`scheduler.non-settling` telemetry marker fires for every pass that defers work,
carrying the deferred actions' labels and their count, so `runtime.telemetry` is
where a second episode shows up. A marker reports a pass that exhausted its
convergence budget, which a wave taking several passes to converge also does, so
one marker is not on its own evidence of a cycle.

`cf check` compiles the pattern and evaluates its factory graph, but it does
not instantiate a piece or drive the runtime scheduler to idle. Scheduler
non-convergence therefore appears only when the piece actually runs (or in a
`cf test` that instantiates it), not during a compile-only `cf check`.

## Quick Start (Browser Console)

The fastest way to check for non-idempotent actions:

```javascript
// Shown inside a pattern body.
// Run diagnosis for 5 seconds (default)
await commonfabric.detectNonIdempotent()

// Run for a custom duration
await commonfabric.detectNonIdempotent(10000) // 10 seconds
```

This prints a table of non-idempotent actions and any cycles found, then returns
the full result object.

The result also includes a timed diagnosis window:

- `duration`: total wall-clock length of the window
- `busyTime`: how much of that window the scheduler spent executing work

If `busyTime / duration` is high but `nonIdempotent` and `cycles` are empty,
you are likely looking at broad fan-out or slow convergence rather than a true
non-idempotent loop.

How to interpret the output: an action is reported **non-idempotent** when its
reads were identical across runs but its writes differed — `differingWriteKeys`
names the offending cell paths, and `runs` holds the actual read/write values.
A **cycle** means two or more actions trigger each other in a loop (A writes a
cell that triggers B, B writes a cell that triggers A); even individually
idempotent actions can never settle inside a cycle.

### 4. Inline Recheck (`cf test`)

`cf test` enables an inline mode (`runtime.enableIdempotencyCheck()`): every
computation run is immediately followed by a second synchronous run against
post-commit state, and differing writes fail the test at the end
(`✗ N non-idempotent computation(s)`, listing each action and its differing
write keys). A test pattern can opt out by returning
`expectNonIdempotent: true` — note this *tolerates* violations, it does not
assert one is found.

Because the second run executes against the latest state, a concurrent write
landing between the first run and the recheck (another transaction's
commit/rollback, or a cross-runtime sync apply in multi-user tests) would make
a pure computation look non-idempotent. The recheck guards against this: when
writes differ, it compares both runs' read invariants and skips the report if
an input the action did not itself write moved between the runs. Self-caused
input moves (reading what it writes — the accumulator anti-pattern) and
equal-input nondeterminism (timestamps, random ordering) are still reported.

## Using the Console API

### Basic Usage

```javascript
// Shown inside a pattern body.
// Default: 5-second diagnosis window
const result = await commonfabric.detectNonIdempotent()
```

Output looks like:

```
┌─────────┬──────────────────────┬───────────────────────────┐
│ (index) │ action               │ differingWrites           │
├─────────┼──────────────────────┼───────────────────────────┤
│ 0       │ "action:myPattern:3" │ "space/entity/items"      │
└─────────┴──────────────────────┴───────────────────────────┘
Cycles: []
```

### Result Shape

The returned object has the complete diagnosis:

```typescript
interface SchedulerDiagnosisResult {
  nonIdempotent: NonIdempotentReport[];
  cycles: CycleReport[];
  duration: number;   // total wall-clock time of diagnosis window (ms)
  busyTime: number;   // time scheduler spent executing actions (ms)
}

interface NonIdempotentReport {
  actionId: string;
  actionInfo?: { patternName?: string; moduleName?: string };
  runs: {
    timestamp: number;
    reads: Record<string, unknown>;   // cell path -> value
    writes: Record<string, unknown>;  // cell path -> value
  }[];
  differingWriteKeys: string[];       // which write paths differed
}

interface CycleReport {
  cycle: { actionId: string; writesCell: string }[];
  timestamp: number;
}
```

A cycle chain reads as `A --[cell X]--> B --[cell Y]--> A`: each entry's
`writesCell` is the cell that triggered the next action in the loop.

## Other Entry Points

- **Debugger UI**: open the debugger panel (bug icon in the shell header), go
  to the **Diagnosis** tab, select a duration, click **Run Diagnosis**. Shows
  the same non-idempotent actions (expandable to read/write values per run)
  and causal cycle chains.
- **RuntimeClient** (tests or tooling):

```typescript
// Shown at module scope.
import { RuntimeClient } from "@commonfabric/runtime-client";

const result = await runtimeClient.detectNonIdempotent(5000);
if (result.nonIdempotent.length > 0) {
  console.warn("Non-idempotent actions detected:", result.nonIdempotent);
}
```

An empty result with a high `busyTime` means the system is doing significant
work that is *not* explained by non-idempotent actions or cycles — switch to
the fan-out workflow in [Debugging Settle Waves](./settle-wave-investigation.md).

## Common Patterns That Cause Non-Idempotency

### Set-to-Array Ordering

```typescript
// Shown as alternative snippets.
// BAD: Set iteration order can vary between identical inputs
const uniqueTags = computed(() => {
  const set = new Set(items.map(i => i.tag));
  tags.set([...set]); // order may differ each run
});

// GOOD: Sort after converting
const uniqueTags = computed(() => {
  const set = new Set(items.map(i => i.tag));
  tags.set([...set].sort());
});
```

### Timestamps or Random Values in computed()

```typescript
// Shown inside a pattern body.
// BAD: Date.now() in a computed() throws a TimeCapabilityError (rather than
// churning) — the ambient clock is denied to reactive contexts
const enriched = computed(() => {
  return items.map(i => ({ ...i, updatedAt: Date.now() }));
});

// GOOD: read the clock only in handlers (allowed there, coarsened to one
// second), or read the reactive #now wish for a value that updates on its own
const updateItem = handler<{}, { item: Item }>((_, { item }) => {
  item.updatedAt.set(Date.now());
});
```

### Appending Instead of Replacing

```typescript
// Shown inside a pattern body.
// BAD: Grows on every re-run
const log = computed(() => {
  entries.set([...entries.get(), newEntry]);
});

// GOOD: Derive the full value, don't append
const allEntries = computed(() => {
  return [...baseEntries, derivedEntry];
});
```

### Writing to a Writable Inside computed()

```typescript
// Shown as alternative snippets.
// BAD: Side-effecting computed — if the write triggers re-reads, it cycles
const derived = computed(() => {
  const value = expensiveCalculation(input);
  output.set(value); // triggers subscribers, which may re-trigger this
  return value;
});

// GOOD: Return the value; let the system propagate it
const derived = computed(() => {
  return expensiveCalculation(input);
});
```

## For AI Agents

When debugging a pattern that appears to be churning or causing high CPU:

1. Start local dev servers (`deno task dev-local` from repo root)
2. Open the browser console
3. Run `await commonfabric.detectNonIdempotent(5000)`
4. Check `result.nonIdempotent` — the `differingWriteKeys` tell you which cell
   paths are producing different values on re-runs
5. Check `result.cycles` — if present, two or more actions are triggering each
   other in a loop
6. Look at the `runs` array on each report to compare the actual read/write
   values and understand *why* the output differs
7. Fix the pattern: sort non-deterministic collections, avoid timestamps in
   `computed()`, don't `.set()` into a `Writable<>` from inside `computed()`
   unless the value is guaranteed stable

## See Also

- [Console Commands](./console-commands.md) — full `commonfabric.*` reference
- [Reactivity Issues](./reactivity-issues.md) — common reactivity problems
- [Performance quick tips](./gotchas/quick.md#performance-quick-tips) — handler and computed performance tips
- [@reactivity](../../common/concepts/reactivity.md) — reactivity system fundamentals

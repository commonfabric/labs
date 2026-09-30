# Browser Console Commands

The runtime registers debugging utilities on `globalThis.commonfabric` for
interactive use in the browser console. These work on the **main thread** — for
worker-side data, use the debugger UI or the IPC methods on `commonfabric.rt`
(see [Main Thread vs Worker](#main-thread-vs-worker)).

The [Common Tasks](#common-tasks) section covers the questions you ask most
often; the [API reference](#logger-access) sections below it cover every
command in detail. The [Quick Reference](#quick-reference) table is at the end.

## Common Tasks

### What data does the piece hold?

`readCell`, `readArgumentCell`, and `subscribeToCell` use `CellHandle` under
the hood, so they go through the same IPC path as the shell's own rendering.
All three default `space` to the current shell space and `did` to the piece ID
from the URL bar (`/<spaceName>/<pieceId>`). Override any default by passing an
options object. If you already have a full trigger-trace entity id such as
`of:baedrei...`, pass it as `id`.

[Common Fabric URLs](../../specs/fabric-urls.md) describes a possible future
browser route. No deployment is planned. These defaults continue to use the
space and piece selected by the current shell route.

```javascript
// Shown at module scope.
// Read the full output of the current piece
await commonfabric.readCell()

// Read a nested path
await commonfabric.readCell({ path: ["children", "1", "props", "variant"] })

// Read a specific piece in a specific space
await commonfabric.readCell({
  space: "did:key:z6Mkm...",
  did: "baedrei...",
  path: ["$UI"]
})

// Read a trigger-trace entity directly using its full id
await commonfabric.readCell({ space: "did:key:z6Mkm...", id: "of:baedrei..." })

// Read the piece's input/argument cell (prepends "argument" to the path)
await commonfabric.readArgumentCell()
await commonfabric.readArgumentCell({ path: ["name"] })
```

Always check the actual stored value before assuming a write failed — see
[browser-stale-ui](gotchas/browser-stale-ui.md).

### A handler looks like a no-op and the console shows nothing

Scheduler and CFC errors log to the pattern runtime's **worker** console, which
the page console — and therefore `agent-browser` — does not surface by
default. Call

```javascript
// Shown at module scope.
commonfabric.forwardWorkerConsole(true);
```

first, then reproduce. Without it, a handler failing inside the worker looks
identical to a handler that never ran.

### A sub-pattern's cell reads as `undefined` at the id you have

`instantiatePatternNode` (`packages/runner/src/runner.ts`) binds a sub-pattern
node's output spot twice, from the same cause, so both mints share a hash:

- the **identity bind** never sees the pattern's `derivedInternalCells`
  manifest, so it has no entity kind and always lands on `of:fid1:<hash>`. Its
  job is to name the child result cell as its `resultFor` cause, and it is the
  spot the resume owned-cell walk keys on;
- the **value bind** sees the manifest, so it mints under the descriptor's kind
  — and the child link is sent to whatever that bind produced, so that is the
  id holding the value.

Whether those are one entity or two therefore depends on the descriptor. The
URI scheme carries the kind, and the kind is part of the identity (see
[computed cell identity](../../specs/computed-cell-identity.md)):

- **descriptor classified `kind: "computed"`** — the value bind mints
  `computed:fid1:<hash>`, a **distinct entity from `of:fid1:<hash>`, differing
  only by scheme**. Nothing writes a value at the `of:` id, so a read there
  returns `undefined` for a perfectly healthy piece — that is the expected
  answer at that id, not evidence that a sub-piece is missing. Read the
  `computed:` id before concluding anything;
- **kindless descriptor** — the classifier declined the node, or
  `experimental.computedCellIds` is off (see
  [experimental options](../EXPERIMENTAL_OPTIONS.md)). Both binds land on the
  same `of:fid1:<hash>` entity, and the child link is written there. A read at
  the `of:` id returns the value, and there is no `computed:` sibling.

So an `undefined` read is only diagnostic once you have tried both ids:

```javascript
// Shown at module scope.
// Same hash, two possible kinds — try both before concluding anything.
await commonfabric.readCell({ space: "did:key:z6Mkm...", id: "of:fid1:HASH" })
await commonfabric.readCell({
  space: "did:key:z6Mkm...",
  id: "computed:fid1:HASH",
})
```

Where the pair does exist, the same trap applies to any offline scan that
enumerates a space by matching the `of:fid1:` prefix: it will not see the cells
holding sub-pattern children. In `cf inspect` output the distinction is there
but quiet — it abbreviates ids by stripping `of:` while keeping a `computed:`
scheme visible, so a bare `fid1:<hash>` in a row is the `of:` form and its
`computed:` sibling, when there is one, is a separate row.

### What's actually rendered?

```javascript
// Shown inside a pattern body.
await commonfabric.vdom.dump()    // pretty-print the VDOM tree
commonfabric.vdom.renders()       // list all active renderings
commonfabric.vdom.stats()         // node/listener counts per renderer
await commonfabric.vdom.tree()    // raw tree object (props as CellHandles)
```

Full documentation: [VDOM Debug Helpers](vdom-debug.md).

### Why is it churning?

```javascript
// Shown inside a pattern body.
// Run diagnosis for 5 seconds (default), prints table + returns result
await commonfabric.detectNonIdempotent()

// Custom duration; inspect the result
const result = await commonfabric.detectNonIdempotent(3000)
result.nonIdempotent   // actions with differing outputs for same inputs
result.cycles          // causal cycles (A -> B -> A)
result.busyTime        // ms the scheduler was busy during the window
result.duration        // total wall-clock duration of the diagnosis
```

High `busyTime` with empty `nonIdempotent`/`cycles` means broad fan-out, not a
true loop — see [Debugging Settle Waves](settle-wave-investigation.md). Full
guide: [Non-Idempotent Detection](non-idempotent-detection.md). The same call
is available via IPC: `await commonfabric.rt.detectNonIdempotent(5000)`.

### Handler does nothing?

A handler that silently does nothing is often an action-schema mismatch: the
runner flags actions whose current input doesn't validate against their
schema, and skips them.

```javascript
// Shown inside a pattern body.
// Active flags across all loggers — look for "action invalid input"
commonfabric.getLoggerFlagsBreakdown()
// {
//   "runner": {
//     "action invalid input": {
//       "action:myModule": { schema: {...}, raw: {...} }
//     }
//   }
// }
```

The flagged metadata shows the expected `schema` next to the `raw` value that
failed it. These flags are also surfaced in the debugger UI's "Data pending"
tab.

### Watching values during interaction

```javascript
// Shown inside a pattern body.
// Subscribe to live updates; logs timestamped values on every change
const cancel = commonfabric.subscribeToCell()
// Console: [debug] cell update [2025-08-10T...]: { $NAME: "My Piece", ... }

// Subscribe to a specific path (e.g. a variant prop deep in the vdom)
const cancelVariant = commonfabric.subscribeToCell({
  path: ["children", "1", "children", "0", "props", "variant"]
})

// Click buttons, observe updates... then clean up
cancelVariant()
```

To capture *who wrote* a value rather than just that it changed, arm the
transaction write watcher — see
[watchWrites / getWriteStackTrace](#watchwrites--getwritestacktrace).

### Using these via agent-browser eval

These utilities work well with `agent-browser eval` for automated debugging:

```bash
# Check if utils are available
agent-browser eval "typeof commonfabric.readCell"

# Read a cell (wrap in async IIFE since eval doesn't support top-level await)
agent-browser eval "(async () => {
  const v = await commonfabric.readCell();
  return JSON.stringify(v).slice(0, 500);
})()"

# Subscribe, interact, check console
agent-browser eval "window._cancel = commonfabric.subscribeToCell()"
agent-browser click @e5
agent-browser console  # Check for "[debug] cell update" entries
agent-browser eval "window._cancel()"
```

---

The remaining sections are the API reference. For the logger TypeScript API
used when *writing* runtime code (creating loggers, `timeStart`/`timeEnd`,
`logCountEvery`), see [logger-internals](../../features/logger-internals.md).

## Logger Access

```javascript
// Shown inside a pattern body.
// List all registered loggers (by module name)
Object.keys(commonfabric.logger)

// Access a specific logger
commonfabric.logger["runner"]
commonfabric.logger["runtime-client"]
```

## Enabling / Disabling Loggers

```javascript
// Shown inside a pattern body.
// Disable a noisy logger
commonfabric.logger["runner"].disabled = true

// Re-enable it
commonfabric.logger["runner"].disabled = false

// Set log level (only messages at this level or above are emitted)
commonfabric.logger["runner"].level = "debug"   // show everything
commonfabric.logger["runner"].level = "warn"    // only warn + error
```

Levels in ascending severity: `debug`, `info`, `warn`, `error`. When a logger
is disabled, messages are suppressed but **counts still increment**, so you can
track call volume even for silent loggers.

## Counts

```javascript
// Shown inside a pattern body.
// Total log calls across all loggers
commonfabric.getTotalLoggerCounts()

// Breakdown by logger name and message key
commonfabric.getLoggerCountsBreakdown()
// {
//   "runner": {
//     "validate-input": { debug: 0, info: 42, warn: 3, error: 0, total: 45 },
//     total: 45
//   },
//   total: 45
// }

// Counts for a single logger
commonfabric.logger["runner"].counts
// { debug: 0, info: 42, warn: 3, error: 0, total: 45 }

// Counts by message key for a single logger
commonfabric.logger["runner"].countsByKey

// Reset all counts
commonfabric.resetAllLoggerCounts()

// Reset counts for a single logger
commonfabric.logger["runner"].resetCounts()
```

## Timing

```javascript
// Shown inside a pattern body.
// Timing stats across all loggers, grouped by logger name
commonfabric.getTimingStatsBreakdown()
// {
//   "runtime-client": {
//     "ipc": { count: 2415, min: 0.1, max: 45.2, average: 1.9, p50: 1.5, p95: 6.8, ... },
//     "ipc/CellGet": { count: 1523, ... }
//   }
// }

// Timing stats for a single logger
commonfabric.logger["runtime-client"].timeStats

// Stats for a specific key path
commonfabric.logger["runtime-client"].getTimeStats("ipc/CellGet")
// { count, min, max, average, p50, p95, lastTime, lastTimestamp, cdf, ... }

// Reset all timing stats
commonfabric.resetAllTimingStats()
```

## Baselines (Measuring Deltas)

Baselines snapshot current counts and timing so you can measure what happens
during a specific interaction:

```javascript
// Shown inside a pattern body.
// Set baselines for all loggers
commonfabric.resetAllCountBaselines()
commonfabric.resetAllTimingBaselines()

// ... perform the interaction you want to measure ...

// Check deltas since baseline
commonfabric.logger["runner"].getCountDeltas()
// { debug: 2, info: 15, warn: 0, error: 0, total: 17 }

// Timing CDF since baseline is in each stat's .cdfSinceBaseline field
commonfabric.logger["runtime-client"].getTimeStats("ipc").cdfSinceBaseline
```

## Flags

Flags track named boolean state per ID (e.g. which actions have invalid
inputs), with optional metadata:

```javascript
// Shown inside a pattern body.
// Active flags across all loggers
commonfabric.getLoggerFlagsBreakdown()

// Flags for a single logger
commonfabric.logger["runner"].flags
```

The runner uses flags to track which actions currently have schema mismatches
(invalid arguments). These are surfaced in the debugger UI's "Data pending"
tab — see [Handler does nothing?](#handler-does-nothing) above.

## Main Thread vs Worker

These console commands access loggers on the **main thread** only. The runner
and most runtime code runs in a web worker, so its loggers are in a separate
`globalThis`. To access worker-side data:

- **Debugger UI**: Open the debugger panel and use the Logger and Scheduler tabs
  to view worker counts, timing, and flags.
- **IPC via `commonfabric.rt`**: The `RuntimeClient` is exposed on
  `commonfabric.rt` for console access:

```javascript
// Shown inside a pattern body.
// Fetch worker counts, timing, and flags
await commonfabric.rt.getLoggerCounts()

// Control worker loggers
await commonfabric.rt.setLoggerLevel("debug")         // all loggers
await commonfabric.rt.setLoggerLevel("debug", "runner") // specific logger
await commonfabric.rt.setLoggerEnabled(true)            // enable all
await commonfabric.rt.setLoggerEnabled(false, "runner") // disable one
```

For scheduler churn debugging, prefer the structured trace APIs (settle stats,
trigger trace, action-run trace below) and targeted loggers before raising the
whole `scheduler` module:

```javascript
// Shown inside a pattern body.
// Focus on nested piece/materialization runs
await commonfabric.rt.setLoggerEnabled(true, "runner.trigger-flow")
await commonfabric.rt.setLoggerLevel("debug", "runner.trigger-flow")

// Focus on wish() branch choice and query resolution
await commonfabric.rt.setLoggerEnabled(true, "runner.wish-flow")
await commonfabric.rt.setLoggerLevel("debug", "runner.wish-flow")

// See which raw stack frame was sampled for action/module labels
await commonfabric.rt.setLoggerEnabled(true, "builder.source-location")
await commonfabric.rt.setLoggerLevel("debug", "builder.source-location")
```

Because logger messages are lazily evaluated, expensive callback payloads only
run when the logger is enabled and the chosen level will actually emit them.

## Worker Settle Stats

Capture per-`execute()` settle-loop stats from the worker scheduler:

```javascript
// Shown inside a pattern body.
// Enable settle stats collection
await commonfabric.rt.setSettleStatsEnabled(true)

// Inspect the most recent execute() settle data
await commonfabric.rt.getSettleStats()
// {
//   iterations: [
//     {
//       workSetSize: 27,
//       orderSize: 27,
//       actionsRun: 27,
//       actions: [{ id, type }, ...],
//       durationMs: 348.4
//     },
//     ...
//   ],
//   totalDurationMs: 702.9,
//   settledEarly: true,
//   initialSeedCount: 0
// }

// Disable collection and clear the last captured value
await commonfabric.rt.setSettleStatsEnabled(false)
```

If you need the recent wave sequence rather than just the last settle result,
read the bounded history buffer:

```javascript
// Shown inside a pattern body.
await commonfabric.rt.setSettleStatsEnabled(true)
await commonfabric.rt.getSettleStatsHistory()
// [
//   { recordedAt, stats: { ... } },
//   ...
// ]
```

`getSettleStats()` returns only the **last** `execute()` call, so a trailing
empty settle pass can overwrite the interesting interaction. Prefer
`getSettleStatsHistory()` for note creation, reload, or navigation flows.

If you need live sampling while the interaction is still in progress, polling
is still useful:

```javascript
// Shown for illustration only.
await commonfabric.rt.setSettleStatsEnabled(true)

globalThis.__settleSamples = []
globalThis.__lastSettleSig = null
globalThis.__settlePoll = setInterval(() => {
  void commonfabric.rt.getSettleStats().then((stats) => {
    const sig = JSON.stringify(stats)
    if (sig !== globalThis.__lastSettleSig) {
      globalThis.__lastSettleSig = sig
      globalThis.__settleSamples.push({ at: performance.now(), stats })
    }
  })
}, 25)

// ... perform the interaction ...

clearInterval(globalThis.__settlePoll)
globalThis.__settleSamples
```

## Worker Action Run Trace

Capture the exact action ids that actually ran during one interaction:

```javascript
// Shown inside a pattern body.
// Reset and enable exact action-run tracing
await commonfabric.rt.setActionRunTraceEnabled(false)
await commonfabric.rt.setActionRunTraceEnabled(true)

// ... perform the interaction ...

await commonfabric.rt.idle()
const trace = await commonfabric.rt.getActionRunTrace()
trace.slice(-10)
```

Each trace entry contains:

- `recordedAt`
- `actionId`
- `actionType` (`"computation"` or `"effect"`)
- `parentActionId` when the scheduler knows the caller
- `durationMs`

To group by exact action id:

```javascript
// Shown inside a pattern body.
const trace = await commonfabric.rt.getActionRunTrace()
const counts = new Map()

for (const entry of trace) {
  const row = counts.get(entry.actionId) ?? {
    actionType: entry.actionType,
    count: 0,
    totalDurationMs: 0,
  }
  row.count += 1
  row.totalDurationMs += entry.durationMs
  counts.set(entry.actionId, row)
}

[...counts.entries()]
  .map(([actionId, row]) => ({
    actionId,
    actionType: row.actionType,
    count: row.count,
    totalDurationMs: Number(row.totalDurationMs.toFixed(1)),
  }))
  .sort((a, b) => b.count - a.count || b.totalDurationMs - a.totalDurationMs)
  .slice(0, 20)
```

To disable tracing and clear the ring buffer:

```javascript
// Shown inside a pattern body.
await commonfabric.rt.setActionRunTraceEnabled(false)
```

## Worker Trigger Trace

Capture structured change-to-action scheduling data from the worker scheduler:

```javascript
// Shown inside a pattern body.
// Reset and enable trigger tracing
await commonfabric.rt.setTriggerTraceEnabled(false)
await commonfabric.rt.setTriggerTraceEnabled(true)

// ... perform the interaction ...

// Read the bounded ring buffer
const trace = await commonfabric.rt.getTriggerTrace()
trace.slice(-5)
```

Each trace entry contains:

- the changed `space`, `entityId`, and `path`
- compact `before` / `after` value summaries
- the scheduling mode (`pull`; retained as an explicit field for trace schema
  clarity)
- the source writer action id when available
- each directly triggered action and its invalidation/suppression decision

To find repeated actions quickly:

```javascript
// Shown inside a pattern body.
const trace = await commonfabric.rt.getTriggerTrace()
const counts = new Map()

for (const entry of trace) {
  for (const action of entry.triggered) {
    counts.set(action.actionId, (counts.get(action.actionId) ?? 0) + 1)
  }
}

[...counts.entries()]
  .filter(([, count]) => count > 1)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
```

To disable tracing and clear the buffer:

```javascript
// Shown inside a pattern body.
await commonfabric.rt.setTriggerTraceEnabled(false)
```

### explainTriggerTrace

Group recent trigger-trace entries, resolve the hottest changed cells, and add
semantic summaries for the current values:

```javascript
// Shown inside a pattern body.
await commonfabric.explainTriggerTrace()

// Focus on broad root writes only
await commonfabric.explainTriggerTrace({ rootOnly: true })

// Limit how many hot changes are resolved
await commonfabric.explainTriggerTrace({ limit: 5 })

// Include the full current values in the returned result
await commonfabric.explainTriggerTrace({ includeCurrentValue: true })
```

This helper:

- groups `commonfabric.rt.getTriggerTrace()` by exact `space/entity/path`
- counts direct action schedules and downstream scheduled effects
- reads the hottest changed cells through `CellHandle`
- annotates them with shape hints like `ui-result`, `runtime-metadata-doc`,
  `default-app-or-home-state`, and `index-state`

## watchWrites / getWriteStackTrace

Arm a transaction-level write watcher for exact or prefix-matched logical cell
paths, then inspect the captured stacks after the interaction.

For accumulation tests, keep the same space across runs instead of creating a
fresh one each time. In the integration harness, set `SPACE_NAME=...` so note
creation keeps adding to one existing space.

```javascript
// Shown inside a pattern body.
// Watch all root writes in the current shell space
await commonfabric.watchWrites({
  space: commonfabric.space,
  path: [],
  match: "exact",
  label: "root writes in current space"
})

// ... perform the interaction ...

const trace = await commonfabric.getWriteStackTrace()
trace.slice(-5)
```

To watch one specific changed cell from trigger trace:

```javascript
// Shown at module scope.
await commonfabric.watchWrites({
  space: "did:key:z6Mkm...",
  id: "of:baedrei...",
  path: [],
  match: "exact",
  label: "default-app state"
})
```

Each recorded entry includes:

- the matched `space`, `entityId`, and logical `path`
- the match mode and optional label
- the written value kind
- the captured JavaScript stack at the transaction write callsite

Interpret repeated root writes in this order:

- `setup:setMetaRaw`: initial result metadata linkage
- `setup:setRawUntyped`: initial result or metadata-linked cell materialization
- `raw:setRawUntyped`: raw builtin/helper rewriting a result cell directly

If you want immediate log output instead of post-hoc inspection, enable the
focused worker logger before replaying the interaction:

```javascript
// Shown inside a pattern body.
await commonfabric.rt.setLoggerEnabled(true, "storage.write-trace")
await commonfabric.rt.setLoggerLevel("warn", "storage.write-trace")
```

Disable the watcher and clear the buffer by passing an empty matcher list:

```javascript
// Shown inside a pattern body.
await commonfabric.watchWrites([])
```

## Quick Reference

| Command | Description |
|---------|-------------|
| `commonfabric.logger["name"]` | Access a specific logger |
| `.disabled = true/false` | Enable/disable a logger |
| `.level = "debug"` | Set minimum log level |
| `.counts` | Get call counts |
| `.countsByKey` | Counts broken down by message key |
| `.timeStats` | All timing statistics |
| `.flags` | Active flags with metadata |
| `.resetCounts()` | Reset this logger's counts |
| `commonfabric.getTotalLoggerCounts()` | Total calls across all loggers |
| `commonfabric.getLoggerCountsBreakdown()` | Counts by logger and key |
| `commonfabric.getTimingStatsBreakdown()` | Timing by logger and key |
| `commonfabric.getLoggerFlagsBreakdown()` | Flags by logger |
| `commonfabric.resetAllLoggerCounts()` | Reset all counts |
| `commonfabric.resetAllTimingStats()` | Reset all timing |
| `commonfabric.resetAllCountBaselines()` | Set count baselines |
| `commonfabric.resetAllTimingBaselines()` | Set timing baselines |
| `commonfabric.rt` | RuntimeClient for worker IPC |
| `commonfabric.rt.setLoggerLevel(lvl, name?)` | Set worker logger level |
| `commonfabric.rt.setLoggerEnabled(on, name?)` | Enable/disable worker logger |
| `commonfabric.rt.getLoggerCounts()` | Get worker logger counts/timing/flags |
| `commonfabric.rt.setSettleStatsEnabled(on)` | Enable/disable worker settle stats |
| `commonfabric.rt.getSettleStats()` | Get the last worker settle stats payload |
| `commonfabric.rt.getSettleStatsHistory()` | Get recent worker settle stats history |
| `commonfabric.rt.setActionRunTraceEnabled(on)` | Enable/disable exact action-run tracing |
| `commonfabric.rt.getActionRunTrace()` | Get recent exact action-run entries |
| `commonfabric.rt.setTriggerTraceEnabled(on)` | Enable/disable worker trigger tracing |
| `commonfabric.rt.getTriggerTrace()` | Get recent worker trigger-trace entries |
| `commonfabric.rt.setWriteStackTraceMatchers(matchers)` | Watch matched transaction writes and clear old entries |
| `commonfabric.rt.getWriteStackTrace()` | Get recent transaction write stack traces |
| `commonfabric.vdom.renders()` | List active renderings |
| `commonfabric.vdom.tree(el?)` | Raw VDOM tree object |
| `commonfabric.vdom.dump(el?)` | Pretty-print VDOM tree |
| `commonfabric.vdom.stats()` | Node/listener counts per renderer |
| `commonfabric.vdom.nodeForId(id, el?)` | Look up DOM node by ID |
| `commonfabric.vdom.registry` | Raw active renders registry |
| `commonfabric.readCell(opts?)` | Read piece output cell (async) |
| `commonfabric.readArgumentCell(opts?)` | Read piece argument cell (async) |
| `commonfabric.subscribeToCell(opts?)` | Subscribe to cell updates, returns cancel fn |
| `commonfabric.watchWrites(opts?)` | Arm transaction write-stack tracing for matched writes |
| `commonfabric.getWriteStackTrace()` | Read captured transaction write stacks |
| `commonfabric.explainTriggerTrace(opts?)` | Group and annotate hot trigger-trace changes |
| `commonfabric.space` | Current space DID |
| `commonfabric.detectNonIdempotent(ms?)` | Run non-idempotent diagnosis (default 5s) |
| `commonfabric.rt.detectNonIdempotent(ms?)` | Same, via RuntimeClient IPC |

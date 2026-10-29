# Logger Internals (TypeScript API)

The runtime uses a structured logging system (`@commonfabric/utils/logger`)
across all packages. Loggers are tagged by module name, support severity
levels, and track call counts, timing stats, and flags — all accessible at
runtime. This page covers the TypeScript API for *writing* runtime code. For
inspecting loggers interactively from the browser console, see
[debugging/console-commands](../development/debugging/console-commands.md).

## Creating a Logger

```typescript
// Shown at module scope.
import { getLogger } from "@commonfabric/utils/logger";

// Create a logger for your module (disabled by default, debug level)
const logger = getLogger("my-module", { enabled: false, level: "debug" });

// Log with a message key (first arg) for metrics tracking
logger.info("processing-started", "Processing started");
logger.debug("cache-hit", () => ["Cache hit for", userId]); // lazy eval
logger.warn("rate-limit", "API rate limit approaching");
logger.error("save-failed", "Failed to save user", error);
```

`getLogger` returns the same instance if called twice with the same module
name. All registered loggers are stored on `globalThis.commonfabric.logger`.

Because logger messages are lazily evaluated, expensive callback payloads only
run when the logger is enabled and the chosen level will actually emit them.

## Log Levels

Four levels in ascending severity: `debug`, `info`, `warn`, `error`.

A logger only emits messages at or above its configured level. The default
level is `info`.

```typescript
// Shown inside a pattern body.
const logger = getLogger("verbose", { level: "debug" }); // show everything
logger.level = "warn"; // change at runtime — now only warn + error
```

In Deno, the `LOG_LEVEL` environment variable sets the default level for all
loggers that don't specify one explicitly.

## Enabling / Disabling Loggers

Each logger has a `disabled` property:

```typescript
// Shown inside a pattern body.
const logger = getLogger("noisy-module", { enabled: false });
// ...later, turn it on:
logger.disabled = false;
// ...turn it off again:
logger.disabled = true;
```

When disabled, messages are suppressed but **counts still increment**. This
lets you track call volume even for silent loggers.

## Call Counts

Every log call increments a counter, even when the logger is disabled or the
message is filtered by level.

```typescript
// Shown inside a pattern body.
logger.counts;       // { debug: 0, info: 5, warn: 1, error: 0, total: 6 }
logger.countsByKey;  // { "event-a": { debug: 0, info: 3, ... }, ... }
logger.resetCounts();
```

### Automatic Count Summaries

By default, a debug-level summary is emitted every 100 calls:

```
[DEBUG][my-module::12:34:56.789] my-module: 100 log calls made (debug: 20, info: 50, warn: 25, error: 5)
```

Configure or disable with `logCountEvery`:

```typescript
// Shown at module scope.
getLogger("chatty", { logCountEvery: 50 });  // every 50 calls
getLogger("quiet", { logCountEvery: 0 });    // disable summaries
```

## Timing

Loggers can track operation timing with reservoir-sampled percentiles:

```typescript
// Shown inside a pattern body.
// Start/end pattern
logger.timeStart("cell", "get");
// ... operation ...
logger.timeEnd("cell", "get");

// Direct measurement
logger.time(startTimestamp, "ipc", "CellGet");

// Either form with a detail naming this one measurement: it reaches the
// slowest measurements the key keeps and the emitted measure, not the key
logger.timeDetailed("the cell's id", startTimestamp, "ipc", "CellGet");

// Read stats
logger.getTimeStats("cell/get");
// { count, min, max, average, p50, p95, lastTime, slowest, cdf, ... }
// `slowest` holds the longest few, each with when it ended and its detail

logger.timeStats; // all timing stats for this logger
```

## Baselines

Baselines let you measure deltas — useful for profiling a specific interaction:

```typescript
// Shown inside a pattern body.
// Snapshot current state as baseline
logger.resetCountBaseline();
logger.resetTimingBaseline();

// ... do some work ...

// Get deltas since baseline
logger.getCountDeltas(); // { debug: 2, info: 5, ... }
// Timing CDF since baseline is in: stats.cdfSinceBaseline
```

## Flags

Flags track named boolean state per ID, with optional metadata. They're used
to surface runtime conditions like "this action has invalid input":

```typescript
// Shown at module scope.
// Set a flag with metadata
logger.flag("action invalid input", "action:myModule", true, {
  schema: { type: "object" },
  raw: currentRawValue,
});

// Clear the flag
logger.flag("action invalid input", "action:myModule", false);

// Read flags
logger.flags;
// { "action invalid input": { "action:myModule": { schema: ..., raw: ... } } }
```

The runner uses flags to track which actions currently have schema mismatches
(invalid arguments). These are surfaced in the debugger UI's "Data pending"
tab.

## Global Functions

These operate across all registered loggers:

| Function | Description |
|----------|-------------|
| `getTotalLoggerCounts()` | Sum of all log calls across all loggers |
| `getLoggerCountsBreakdown()` | Counts by logger name and message key |
| `getTimingStatsBreakdown()` | Timing stats by logger name and key |
| `getLoggerFlagsBreakdown()` | Active flags by logger name |
| `resetAllLoggerCounts()` | Reset all logger counts to zero |
| `resetAllTimingStats()` | Reset all timing statistics |
| `resetAllCountBaselines()` | Set count baselines for all loggers |
| `resetAllTimingBaselines()` | Set timing baselines for all loggers |

All are importable from `@commonfabric/utils/logger` and also registered on
`globalThis.commonfabric` for browser console access. See
[debugging/console-commands](../development/debugging/console-commands.md) for interactive
usage.

`setLoggerCountObserver()`, importable only, sets the process's one function
told of every call a logger counts, with the logger's module name, the message
key and the level. The module name is `undefined` for the unnamed global
`log`, which no registry entry holds. The function runs inside the logging
call, so it can read the caller's async context, which is how `cf test` tells
a co-hosted serving loop's counts apart from its test's.

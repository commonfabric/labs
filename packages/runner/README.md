# Runner

The Runner package provides a reactive runtime for executing patterns
(computational graphs) with automatic dependency tracking, state management, and
persistence.

## Key Features

- **Cell-based Reactivity**: Create, manage, and observe reactive data cells
- **Pattern Execution**: Run computational graphs defined as patterns
- **Automatic Dependency Tracking**: Changes propagate through your application
  automatically
- **Schema Validation**: Validate and transform data against JSON Schema
  definitions
- **Storage Integration**: Optional persistence and synchronization of data
- **Dependency Injection**: No singleton patterns - all services are injected
  through a central Runtime instance

## Collection aggregates

Array-valued `Cell` inputs support `count`, `sum`, `min`, `max`, `minBy`, and
`maxBy`. Their numeric contracts, callback forms, type-surface limits, and
maintenance costs are described in
[Incremental collection aggregates](../../docs/features/collection-aggregates.md).

## Action read accounting

`runtime.scheduler.setReadStatsEnabled(true)` enables transaction-scoped read
accounting for subsequent scheduler action runs. It is disabled by default.
`getActionStats(action)` exposes cumulative `reads` and `lastRunReads`;
`scheduler.run.complete` telemetry carries the per-run counts and authored
source location. Cumulative counts include only runs measured while enabled.

Proxy accesses include lazy schema views and query result proxies, including
elements materialized by array methods and iterators. Link resolutions count
stored-link traversal attempts through the resolver and schema traversal; a memo
hit performs no hop. Missing-target reads count, and a fast-path read followed
by a general-traversal fallback counts twice: the metric measures traversal
work, not distinct logical links. Document identity comes from the transaction's
replica records, so spaces and scope instances stay distinct. Dependencies count
the deep and shallow scheduling read addresses separately, compacted by the
scheduler's ordinary rules, at the end of action execution before commit
preparation. A fanned-out node reports each executed instance separately; this
count is not the union subscription retained for all instances.

When no collector is active, read sites check one shared boolean and perform no
counter lookup or allocation. While any collector is active in the same isolate,
unmeasured transactions also perform a lookup but do not accumulate counts.
Active collectors are keyed by the underlying transaction, so overlapping
runtimes do not attribute reads to each other. The `read-stats.bench.ts`
benchmark measures enabled versus disabled read-hook accounting over a reduction
of 1,000 linked rows. It excludes scheduler dependency compaction and commit
preparation.

Use access counts and run counts to test collection-size scaling after a
single-element edit. Pair them with runtime benchmarks: these counters measure
reactive read work, not the cost of arithmetic or maintaining an aggregate tree.

### Worker read accounting

`RuntimeClient.setReadStatsEnabled(true)` enables reactive action read counters
in the addressed worker. Await the request before starting the measured
interaction. Use `setTelemetryEnabled(true)` to receive completion events, or
read the action statistics through the existing graph diagnostics. Turning read
accounting off leaves cumulative statistics available and stops collecting new
samples. This control applies to that worker; it does not configure a server or
another browser's runtime.

## CFC preparation counters

`runtime.getCfcStats()` returns a snapshot of cumulative CFC counters;
`runtime.resetCfcStats()` clears them. `refusalDetailsRecorded` counts
structured details recorded by prepare gates. Writer-fit records these only for
`enforce-strict` refusals; lower modes retain the offending atoms in
`writer-fit(persist-and-flag)` diagnostics.

`consumedLabelWalks` counts full consumed-label collections, including
writer-fit attribution, sink-ceiling checks, and host release checks. Writer-fit
shares one collection across a prepare's refused write paths. Sink and host
checks may collect on succeeding operations too, so this counter measures work
rather than rejected commits. Both counters are measurement only and do not
affect CFC relevance, preparation, or enforcement.

`overlapWildcardQueries` and `overlapConcreteQueries` count label-index queries
during preparation, split by whether the query path contains `"*"`.
`authoritativeCoverCalls` counts carried label entries checked against source
authority, including checks answered from the preparation-local cover cache.
`flowTemplateContainers` counts container stamps and `flowTemplateEntriesMinted`
counts their three child templates (`shape`, `value`, and `followRef`). These
counters measure work before final entry coalescing; they do not count distinct
persisted entries.

## Architecture

The Runner has been refactored to eliminate singleton patterns in favor of
dependency injection through a central Runtime instance. This provides better
testability, isolation, and control over service configuration.

### Runtime-Centric Design

All services are now accessed through a `Runtime` instance:

```typescript
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache";

// Create a runtime instance with configuration
const runtime = new Runtime({
  apiUrl: new URL("https://example.com/"),
  // The StorageManager constructor is protected — use the factory methods
  // (`open()` for a remote server, `emulate()` for in-process testing)
  storageManager: StorageManager.open({
    memoryHost: new URL("https://example.com/"),
    as: myIdentitySigner,
  }),
  consoleHandler: myConsoleHandler, // Optional
  errorHandlers: [myErrorHandler], // Optional
  patternEnvironment: { apiUrl: "https://api.example.com" }, // Optional
  debug: false, // Optional
});

// Access services through the runtime
const cell = runtime.getCell("my-space", "my-cause", schema);
await cell.sync();
const pattern = await runtime.patternManager.compilePattern(program, {
  space: "my-space",
});

// Wait for all operations to complete
await runtime.idle();

// Clean up when done
await runtime.dispose();
```

## Code Organization

The Runner codebase is organized around several core concepts that work together
to provide a reactive runtime system. Here's a map of the key files and their
purposes:

### Core Files

- `src/index.ts`: The main entry point that exports the public API
- `src/runtime.ts`: Central orchestrator that creates and manages all services
- `src/cell.ts`: Defines the `Cell` abstraction and its implementation
- `src/runner.ts`: Instantiates patterns and manages their lifecycle
- `src/scheduler.ts` / `src/scheduler/`: Execution order, batching, and event
  dispatch for reactive updates
- `src/storage/`: The storage stack — transactions, the v2 memory-protocol
  client, and the local replica/cache layers
- `src/builder/`: The pattern/handler/lift builder surface (migrated from the
  former `@commonfabric/builder` package; see `createBuilder`)
- `src/builtins/`: Built-in modules (`map`, `ifElse`, `fetchJson`, `llm`,
  `sqliteDatabase`, ...)
- `src/pattern-manager.ts`: Handles pattern loading, compilation, and caching
- `src/module.ts`: Manages module registration and retrieval
- `src/cfc/`: Contextual flow control (information-flow labels and policy)
- `src/sandbox/`: SES sandboxing and verified pattern evaluation

## Core Concepts

### Documents vs Cell Abstractions

One of the most important concepts to understand in the Runner is the
relationship between stored documents and cells:

- **Documents** are the persistence units: entity-id-addressed values that live
  in a space and are read and written through storage transactions
  (`src/storage/`). They are what the memory server versions and synchronizes.

- **Cell**: The user-facing abstraction that provides a reactive view over one
  or more documents. Cells are defined by schemas and can traverse document
  relationships through sigil-based links.

Storage transactions handle the low-level persistence concerns, while Cells
provide the higher-level programming model with schema validation, reactivity,
and relationship traversal. When you're working with data in the Runner, you'll
almost always interact with Cells rather than with raw storage reads and writes.

### Schema and Validation

The schema system defines both the structure of data and how it's represented in
storage:

- Schemas are based on JSON Schema with extensions for reactivity and references
- Each Cell has an associated schema that validates its data
- Schemas can define nested cells with `asCell: ["cell"]`
- Schema validation happens automatically when setting values

### Sigil-based Links

Cells can reference other cells through a unified sigil-based linking system.
This approach replaces the previous distinction between CellLinks and Aliases.

- **Sigil Links**: A flexible, JSON-based format for representing references to
  other cells. They can be simple links to other documents or write-redirects
  (previously aliases).
- These mechanisms allow building complex, interconnected data structures
- The system automatically traverses links when needed

### Pattern System

Patterns define computational graphs that process data:

- Created with the builder surface (`createBuilder` from this package — trusted
  host-side construction) or authored as `.tsx` patterns compiled by the CTS
  transformer
- Define inputs, outputs, and transformation logic
- Can be composed into larger patterns
- Executed by the Runner with automatic dependency tracking

### Storage Layer

The storage system handles persistence and synchronization:

- Multiple storage implementations (emulated in-process, remote memory-v2
  server)
- Document-based persistence model with transactional commits
- Identity-based access control
- Synchronization through a publish/subscribe mechanism
- Conflict detection by read watermark: a commit whose reads went stale is
  rejected, and the scheduler re-runs the affected computation against the newer
  inputs and commits again

### Reactivity System

The reactivity system is what makes the Runner dynamic:

- Based on observable patterns and subscriptions
- Changes automatically propagate through the system
- Fine-grained updates minimize unnecessary recalculations

### Scheduler

A reactive commit conflict waits for ordered catch-up and scoped recovery pulls
before the scheduler queues its retry. Output reads excluded from scheduling
still participate in validation and repair. The pending-commit barrier includes
recovery; a retired registration or a runtime closing its storage cannot requeue
the delayed retry. Fresh input changes remain eligible to run while recovery is
pending.

The scheduler manages the execution order of reactive updates:

- Ensures updates happen in a predictable order
- Batches related updates for efficiency
- Bounds the scheduling work a non-converging graph can demand, deferring the
  offending actions rather than running them without limit. This bounds
  scheduling, not computation: a loop inside a single computation body still
  runs to completion or not at all
- Provides hooks for synchronization points via `idle()`

## Core Components

### Cells

Cells are reactive data containers that notify subscribers when their values
change. They support various operations and can be linked to form complex data
structures.

Cells are now created through the Runtime instance rather than global functions:

```typescript
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import { Identity } from "@commonfabric/identity";

// Connect to the remote memory-v2 server
const signer = await Identity.fromPassphrase("example-passphrase");
const storageManager = StorageManager.open({
  memoryHost: new URL("https://example.com/"),
  as: signer,
});

// Create a runtime instance first
const runtime = new Runtime({
  apiUrl: new URL("https://examplehost.com"),
  storageManager,
});
```

```typescript
const space = signer.did();

// Create a cell with schema and default values
const settingsCell = runtime.getCell(
  space, // The space this cell belongs to
  "settings", // Causal ID - a string identifier
  { // JSON Schema with default values
    type: "object",
    properties: {
      theme: { type: "string" },
      fontSize: { type: "number" },
    },
    default: { theme: "dark", fontSize: 14 },
  },
);

// Create a related cell using an object with references as causal ID
// This establishes a semantic relationship between cells
const profileCell = runtime.getCell(
  space, // The space this cell belongs to
  { parent: settingsCell, id: "profile" }, // Causal ID with reference to parent
  { // JSON Schema with default values
    type: "object",
    properties: {
      name: { type: "string" },
      language: { type: "string" },
    },
    default: { name: "User", language: "en" },
  },
);

// Two cells with the same causal ID will be synced automatically
// when using storage, even across different instances

// Get values
const settings = settingsCell.get();

// Subscribe to changes BEFORE mutating, so the callback observes both the
// initial value and the update.
// sink() will immediately call the callback with the current value,
// and then call it again whenever the value changes
const cleanup = settingsCell.sink((value) => {
  console.log("Settings value:", value); // Called immediately, then on changes
  // Sees theme "dark" (the default) initially, then "system" after the
  // update below commits

  // Can return a cleanup function that will be called when unsubscribing
  // or before the next callback invocation
  return () => {
    console.log("Cleaning up subscription for value:", value);
  };
});

// Mutations require a transaction (outside handlers, open one explicitly
// with runtime.edit(); inside handlers the runtime provides it)
const tx = runtime.edit();
settingsCell.withTx(tx).set({ theme: "light", fontSize: 16 });

// Work with nested properties
const themeProperty = settingsCell.key("theme");
themeProperty.withTx(tx).set("system");
await tx.commit();

// Clean up subscription when done
cleanup();
```

### Cells with Type-Safe Schemas

Using cells with schemas is highly recommended as it provides type checking,
validation, and automatic transformation of data. The `Schema<>` helper
(exported from this package's builder surface) provides TypeScript type
inference.

> **Why these examples seed with a transaction.** This is untransformed embedder
> code, so nothing here instantiates a piece: in transformer-compiled `.tsx`
> patterns, declared defaults (`Default<>`) become schema defaults and the
> initial state is written to storage when the piece is instantiated. Without
> that instantiation write, a schema `default` stays **virtual** — readable, but
> backed by a read-only `data:` document — so writing through a nested cell it
> materialized throws `ReadOnlyAddressError`, links resolve against stored
> values only, and nested-path subscriptions see `undefined`. The examples below
> therefore seed initial state with an explicit `runtime.edit()` transaction
> before mutating through nested cells or resolving links.

```typescript
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import type { JSONSchema } from "@commonfabric/runner";
import { Identity } from "@commonfabric/identity";

// Connect to the remote memory-v2 server
const signer = await Identity.fromPassphrase("example-passphrase");
const storageManager = StorageManager.open({
  memoryHost: new URL("https://example.com/"),
  as: signer,
});

// Create runtime instance
const runtime = new Runtime({
  apiUrl: new URL("https://examplehost.com"),
  storageManager,
});
```

```typescript
// Define a schema with type assertions for TypeScript inference
const userSchema = {
  type: "object",
  properties: {
    id: { type: "number" },
    name: { type: "string" },
    settings: {
      type: "object",
      properties: {
        theme: { type: "string" },
        notifications: { type: "boolean" },
      },
      // Make settings a nested cell that can be observed independently
      asCell: ["cell"],
      default: { theme: "light", notifications: true },
    },
    tags: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["id", "name"],
  default: {
    id: 123,
    name: "Alice",
    tags: [],
    // settings will use its own default value
  },
} as const satisfies JSONSchema;

// Create a cell with schema validation
const userCell = runtime.getCell(
  signer.did(),
  "user-123", // Causal ID - identifies this particular user
  userSchema, // Schema for validation, typing, and default values
);

// Schema defaults are readable immediately — but they are VIRTUAL (backed
// by a read-only data: document), so seed the cell with a real write
// before mutating through nested cells.
const seed = runtime.edit();
userCell.withTx(seed).set({
  id: 123,
  name: "Alice",
  tags: [],
  settings: { theme: "light", notifications: true },
});
await seed.commit();

// Access the typed data
const user = userCell.get();
console.log(user.name); // "Alice"

// Access nested cells
const settingsCell = user.settings; // This is a cell
const settings = settingsCell.get();
console.log(settings.theme); // "light"

// Update nested cells (mutations require a transaction)
const tx = runtime.edit();
settingsCell.withTx(tx).set({ theme: "dark", notifications: false });
await tx.commit();

// Re-read through the parent for the updated view — a nested-cell handle
// obtained from an earlier get() keeps observing its earlier snapshot
console.log(userCell.get().settings.get());
// { theme: "dark", notifications: false }

// Key navigation preserves schema
const nameCell = userCell.key("name");
console.log(nameCell.get()); // "Alice"
```

### Running Patterns

Patterns define computational graphs that process data. Patterns are created
through the builder surface and executed by the Runner, which manages
dependencies and updates results automatically.

```typescript
import { createBuilder, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import { Identity } from "@commonfabric/identity";

// Connect to the remote memory-v2 server
const signer = await Identity.fromPassphrase("example-passphrase");
const storageManager = StorageManager.open({
  memoryHost: new URL("https://example.com/"),
  as: signer,
});

// Create runtime instance
const runtime = new Runtime({
  apiUrl: new URL("https://examplehost.com"),
  storageManager,
});
```

```typescript
// Obtain the trusted builder surface for host-side pattern construction.
// (.tsx pattern sources instead go through the CTS transformer, which also
// generates their schemas.)
const { commonfabric } = createBuilder({
  unsafeHostTrust: runtime.createUnsafeHostTrust({
    reason: "embedder example",
  }),
});
const { pattern, lift } = commonfabric;

// Define a pattern: the implementation function comes first; explicit
// argument/result schemas are optional trailing parameters.
const double = lift((x: number) => x * 2);
const doubleNumberPattern = pattern<{ value: number }>(({ value }) => ({
  result: double(value),
}));

// Allocate the input and result cells inside a transaction.
const space = signer.did();
const tx = runtime.edit();
const input = runtime.getCell<number>(space, "double-input", undefined, tx);
input.withTx(tx).set(5);
const resultCell = runtime.getCell<{ result?: number }>(
  space,
  "calculation-result",
  undefined,
  tx,
);

// Run the pattern. Passing the input CELL (not a literal) keeps the
// argument reactive: later writes to it re-derive the result.
const result = runtime.run(
  tx,
  doubleNumberPattern,
  { value: input },
  resultCell,
);
runtime.prepareTxForCommit(tx);
await tx.commit();

// Await the computation graph to settle, then pull the result cell's view
await runtime.idle();
await result.pull();
console.log(result.get()); // { result: 10 }

// Update the input and watch the result change automatically
const update = runtime.edit();
input.withTx(update).set(10);
await update.commit();
await runtime.idle();
await result.pull();
console.log(result.get()); // { result: 20 }

// Stop pattern execution when no longer needed
runtime.runner.stop(result);
```

### Storage

The storage system provides persistence for cells and synchronization across
clients.

Remote memory connections use native WebSockets in browsers and for plain `ws:`
URLs. Deno `wss:` connections use the `ws` package through Deno's Node TLS stack
to avoid the native TLS flush bug tracked in
[denoland/deno#36862](https://github.com/denoland/deno/issues/36862). This
backend can be removed once the pinned Deno release includes the upstream fix.
It uses Fabric's message compression, with WebSocket per-message compression
disabled. Its send promise waits for local write completion; Fabric's protocol
replies remain the authority for committed writes.

```typescript
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import { Identity } from "@commonfabric/identity";

// Create identity for authentication
const signer = await Identity.fromPassphrase("my-passphrase");

// Create storage manager (for production, use StorageManager.open() with remote storage)
const storageManager = StorageManager.open({
  as: signer,
  memoryHost: new URL("https://example.com/"),
});

// Create a runtime instance with configuration
const runtime = new Runtime({
  apiUrl: new URL("https://examplehost.com"),
  storageManager,
  consoleHandler: myConsoleHandler, // Optional
  errorHandlers: [myErrorHandler], // Optional
  patternEnvironment: { apiUrl: "https://api.example.com" }, // Optional
  debug: false, // Optional
});
```

```typescript
const space = signer.did();

// Create (or address) a cell and sync it with storage
const cell = runtime.getCell(space, "sync-example");
await cell.sync();

// Address an existing document by entity id, then sync it
const byId = runtime.getCellFromEntityId(space, "of:fid1:...");
await byId.sync();

// Wait for all pending sync operations to complete
await runtime.storageManager.synced();

// When cells with the same causal ID are synced across instances,
// they will automatically be kept in sync with the latest value
```

## Advanced Features

### Reactive Data Transformation

You can map and transform data using cells with schemas:

```typescript
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import type { JSONSchema } from "@commonfabric/runner";
import { Identity } from "@commonfabric/identity";

// Connect to the remote memory-v2 server
const signer = await Identity.fromPassphrase("example-passphrase");
const storageManager = StorageManager.open({
  memoryHost: new URL("https://example.com/"),
  as: signer,
});

// Create runtime instance
const runtime = new Runtime({
  apiUrl: new URL("https://examplehost.com"),
  storageManager,
});
```

```typescript
const space = signer.did();

// Original data source cell. Note: schema defaults are VIRTUAL — links
// resolve against stored values, so seed the source with a real write.
const sourceCell = runtime.getCell(
  space,
  "source-data",
  {
    type: "object",
    properties: {
      id: { type: "number" },
      metadata: {
        type: "object",
        properties: {
          createdAt: { type: "string" },
          type: { type: "string" },
        },
      },
      tags: {
        type: "array",
        items: { type: "string" },
      },
    },
  },
);
const seed = runtime.edit();
sourceCell.withTx(seed).set({
  id: 1,
  metadata: { createdAt: "2023-01-01", type: "user" },
  tags: ["tag1", "tag2"],
});
await seed.commit();

// Create a mapping cell that reorganizes the data by writing sigil LINKS
// into it (setRaw writes the links themselves rather than link targets).
const mappingCell = runtime.getCell(
  space,
  "data-mapping",
  {
    type: "object",
    properties: {
      id: { type: "number" },
      changes: {
        type: "array",
        items: { type: "string" },
      },
      kind: { type: "string" },
      firstTag: { type: "string" },
    },
  },
);
const tx = runtime.edit();
mappingCell.withTx(tx).setRaw({
  // References to source cell values using sigil links
  id: sourceCell.key("id").getAsLink(),
  // Turn single value to array
  changes: [sourceCell.key("metadata").key("createdAt").getAsLink()],
  // Rename field and uplift from nested element
  kind: sourceCell.key("metadata").key("type").getAsLink(),
  // Reference to first array element
  firstTag: sourceCell.key("tags").key(0).getAsLink(),
});
await tx.commit();
await runtime.idle();

// Reads resolve through the links to the source values
await mappingCell.pull();
console.log(mappingCell.get());
// {
//   id: 1,
//   changes: ["2023-01-01"],
//   kind: "user",
//   firstTag: "tag1"
// }
```

### Nested Reactivity

Cells can react to changes in deeply nested structures:

```typescript
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import { Identity } from "@commonfabric/identity";

// Connect to the remote memory-v2 server
const signer = await Identity.fromPassphrase("example-passphrase");
const storageManager = StorageManager.open({
  memoryHost: new URL("https://example.com/"),
  as: signer,
});

// Create runtime instance
const runtime = new Runtime({
  apiUrl: new URL("https://examplehost.com"),
  storageManager,
});
```

```typescript
const space = signer.did();
const rootCell = runtime.getCell(
  space,
  "nested-example",
  {
    type: "object",
    properties: {
      value: { type: "string" },
      current: {
        type: "object",
        properties: {
          label: { type: "string" },
        },
        // Make nested object a cell so it can be observed independently
        asCell: ["cell"],
      },
    },
  },
);

// Seed the cell with a real write (schema defaults are virtual and do not
// materialize nested cells on their own)
const seed = runtime.edit();
rootCell.withTx(seed).set({
  value: "root",
  current: { label: "nested" },
});
await seed.commit();

// Subscribe to changes in the whole cell
// This callback is called immediately with the current value,
// and then again whenever the value changes
rootCell.sink((value) => {
  console.log("Root changed:", value); // Called immediately with initial value

  // Also subscribe to changes in the nested property
  // (this is a cell because we used asCell: ["cell"] in the schema)
  // This inner sink is also called immediately with the current nested value
  const cancel = value.current.sink((nestedValue) => {
    console.log("Nested value:", nestedValue); // Called immediately, then on changes
  });

  // Return a cleanup function that will be called when unsubscribing
  // or before the next callback invocation
  return () => {
    console.log("Root subscription cancelled");
    cancel(); // Clean up nested subscription
  };
});

// Subscribe to a specific nested path
rootCell.key("current").key("label").sink((value) => {
  console.log("Label value:", value); // Called immediately with "nested"
});

// Changing values requires a transaction and triggers the callbacks
const tx = runtime.edit();
rootCell.key("current").key("label").withTx(tx).set("updated");
await tx.commit();
// This will log (after the commit propagates):
// "Nested value: { label: 'updated' }"
// "Label value: updated"
// The ROOT callback does NOT re-fire: `asCell` gives `current` its own
// document, so the root's stored value (a link to it) is unchanged —
// exactly the isolation that makes nested cells independently observable.
```

## Migration from Singleton Pattern

Previous versions of the Runner used global singleton functions. These have been
replaced with Runtime instance methods:

```typescript
// OLD (deprecated):
import { getCell, idle, storage } from "@commonfabric/runner";
const cell = getCell(space, cause, schema);
await cell.sync();
await idle();

// NEW (current):
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import { Identity } from "@commonfabric/identity";

const signer = await Identity.fromPassphrase("my-passphrase");
const storageManager = StorageManager.open({
  memoryHost: new URL("https://example.com/"),
  as: signer,
});

const runtime = new Runtime({
  apiUrl: new URL("https://examplehost.com"),
  storageManager,
});
const cell = runtime.getCell(space, cause, schema);
await cell.sync();
await runtime.idle();
```

### Key Changes

- `getCell()` → `runtime.getCell()`
- `getCellFromLink()` → `runtime.getCellFromLink()`
- `getDocByEntityId()` → `runtime.getCellFromEntityId()`
- `storage.*` → `runtime.storageManager` / storage transactions
- `idle()` → `runtime.idle()`
- `run()` → `runtime.run(tx, ...)`
- Storage configuration now happens in Runtime constructor

### Runtime Configuration

The Runtime constructor accepts a configuration object (excerpt — see
`RuntimeOptions` in `src/runtime.ts` for the full surface, and
`runtime-presets.ts` for the first-party preset assembly):

```typescript
interface RuntimeOptions {
  apiUrl: URL; // Required: runtime host
  storageManager: IStorageManager; // Required: storage manager implementation
  consoleHandler?: ConsoleHandler; // Optional: custom console handling
  errorHandlers?: ErrorHandler[]; // Optional: error handling
  patternEnvironment?: PatternEnvironment; // Optional: pattern env vars
  debug?: boolean; // Optional: debug logging
}
```

### Storage Manager

Storage manager is used by runtime to open storage providers when reading or
writing documents into a corresponding space.

```ts
export interface IStorageManager {
  open(space: MemorySpace): IStorageProvider;
}
```

The storage manager opens storage providers for different memory spaces. The
StorageManager provides convenient factory methods:

```ts
import { StorageManager } from "@commonfabric/runner/storage/cache";
import { Identity } from "@commonfabric/identity";

const signer = await Identity.fromPassphrase("my-passphrase");

// For production - remote storage
const remoteStorageManager = StorageManager.open({
  memoryHost: new URL("https://example.com/"),
  as: signer,
});

// Tests only (requires importing `storage/cache.deno` instead):
// const testStorageManager = StorageManager.emulate({ as: signer });
```

`@commonfabric/runner/storage/cache` provides the production implementation of
the `IStorageManager` interface:

- `StorageManager.open({ memoryHost, as })` — remote memory-v2 server

## TypeScript Support

All APIs are fully typed with TypeScript to provide excellent IDE support and
catch errors at compile time.

## Data Flow in the Runner

Understanding the data flow in the Runner helps visualize how different
components interact:

1. **Input** → Data enters the system through Cell updates or pattern executions
2. **Validation** → Schema validation ensures data conforms to expected
   structure (so far only on get, not yet on write)
3. **Processing** → Patterns transform data according to their logic
4. **Reactivity** → Changes propagate to dependent cells and patterns through
   the unified sigil-based linking system
5. **Storage** → Updated data is persisted to storage if configured
6. **Synchronization** → Changes are synchronized across clients if enabled

This flow happens automatically once set up, allowing developers to focus on
business logic rather than managing data flow manually.

## Cross-space child source ownership

A cross-space child with a recorded source origin or source revision history
owns its stored pattern and arguments. Reinstantiating its parent resumes that
stored state, including owner edits that detached the origin. Untracked nested
children continue to take their pattern and inputs from the parent.

This independent input ownership starts when the origin or history is recorded.
A parent release's new literals and bindings do not replace the child's stored
arguments. Existing links remain reactive to their original targets; moving or
replacing a parent-internal target does not retarget the child. Preserve those
targets or explicitly update the child's inputs as its owner, for example with
`cf piece apply`, using the retained child's input contract.

For a space-scoped child, resume waits for the parent transaction to commit and
retains the parent demand root across cold loading. Parent teardown cancels only
the start it owns; a replacement or independently started child keeps running.
Scoped serving children resume through their per-actor program coordinator.

## Service Architecture

The Runtime coordinates several core services:

- **Scheduler**: Manages execution order and batching of reactive updates
- **Storage**: Handles persistence and synchronization with configurable
  backends
- **PatternManager**: Loads, compiles, and caches pattern definitions
- **ModuleRegistry**: Manages module registration and retrieval for patterns
- **Runner**: Executes patterns and manages their lifecycle
- **Engine** (`runtime.harness`): Provides the execution environment for pattern
  code

All services receive the Runtime instance as a dependency, enabling proper
isolation and testability without global state.

`PatternManager.compileOrGetPattern()` snapshots its program input before
starting compilation. Its in-memory cache and concurrent-request deduplication
use that complete program content: source files, entry point and export,
retained source roots, and attached data-file names. Query-result views with
identical content share a compiled pattern across cell addresses. Changing a
program's content selects the cache entry for that content and compiles it on a
miss. Changes to the caller's input after a request begins do not change the
program being compiled. Requests with and without a space use separate cache
entries, so a source-only result cannot satisfy a durable compile. With CFC
enforcement, concurrent requests targeting different spaces register source and
compiled closure replication into each requested space. Those writes participate
in the runtime's durability barrier. With CFC disabled, compilation still uses
the requested space for fabric imports but does not replicate closures.

## Contributing

See the project's main contribution guide for details on development workflow,
testing, and submitting changes.

## Private DID inboxes

`InboxClient` from `@commonfabric/runner/inbox` provides signed generic
delivery, private recipient reads, and durable deduplication. See
[DID inboxes](../../docs/features/did-inboxes.md) for the wire contract.
`ACLManager.grant(did, "READ" | "WRITE")` adds access monotonically inside the
conflict-retried transaction, preserving existing WRITE or OWNER grants.
Delivery and access changes are separate operations; callers own their workflow
and must not replay a grant after an independent revocation.

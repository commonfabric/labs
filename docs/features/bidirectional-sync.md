# Bidirectional Sync with External Canonical Source

This guide covers how to build reliable bidirectional synchronization between
Common Fabric cells and an external system (filesystem, API, etc.) where the
**external source is canonical** — meaning it is the source of truth, and local
state is a reflection of it.

## Core Principles

### 1. Atomic Transactions with CAS Semantics

All actions in the Common Fabric runtime (`computed()`, `action()`, `handler()`)
are atomic and have compare-and-swap (CAS) transaction guarantees. When code
reads data and then writes data, the runtime collects all mutations (`.set()`,
`.push()`, etc.) and applies them atomically at commit time. If any value that
was read has changed since the transaction began, the commit is aborted and the
action retries with the new data.

This is a powerful primitive for sync: you never have a half-applied state, and
you never silently lose a concurrent edit.

### 2. Local Edit Queue

Collect local edits into an array cell. Each edit describes the user's intent
(e.g., "rename file X to Y", "create item Z"). The queue is append-only during
normal operation.

Optimistically apply edits on top of the synced state in the same atomic
transaction that enqueues them. This gives instant UI feedback. Since the
external source is canonical, the next sync will overwrite the local state with
the real data — and that's fine. The optimistic state is just a bridge until the
sync catches up.

### 3. External Source Wins

On each sync cycle, read the full state from the external source and write it
into cells. This overwrites any locally-modified state. Local edits survive
because they live in the edit queue, which gets applied to the external source
_before_ reading it back.

### 4. Anti-Backsliding via Single Transaction

To prevent the window where synced state temporarily reverts a pending edit:

- In a **single transaction**, apply pending edits to the external source, read
  back the canonical state, write it to cells, and clear the edit queue.
- If the transaction fails, it's because a new local edit was appended. Since
  the queue is append-only, just retry — catch up with the newest edits and try
  again.
- Optionally move applied edits to an `appliedEdits` array for audit/UI
  purposes.

### 5. Stable Identity via `Cell.for()`

When writing items that have an external canonical ID, use
`Cell.for(externalId).set(...)` to create the data. This ensures that links
created in the fabric point to stable cells derived from the canonical ID,
rather than ephemeral cells that get replaced on each sync.

This is especially important for items inside arrays — without stable IDs, every
sync would create new cells and break any existing links.

### 6. Write Redirect Links for In-Flight Edits

When a local edit creates a new item (before it has a canonical ID), the edit
allocates a new cell. Once the external source assigns a canonical ID, create a
write redirect link from the edit-allocated cell to the canonical cell. This
ensures any links created between the edit and the sync remain valid.

```typescript
import type { Cell } from "@commonfabric/runner";

// `editCell` is the cell the edit allocated before the item had a canonical
// ID. `canonicalCell` is the cell that ID names. After this write, anything
// holding the edit's cell writes through to the canonical one.
export function redirectToCanonical<T>(
  editCell: Cell<T>,
  canonicalCell: Cell<T>,
): void {
  const resolved = editCell.resolveAsCell();
  resolved.setRawUntyped(
    canonicalCell.getAsWriteRedirectLink({ base: resolved }),
  );
}
```

---

## Filesystem Daemon Sync

This is the primary pattern: a long-running daemon process that watches a
directory and keeps cells in sync with the filesystem.

### Architecture

```
┌──────────────┐       ┌──────────┐       ┌──────────────┐
│  Pattern UI  │──────▶│  Cells   │◀──────│    Daemon    │
│  (user edits │       │  (state  │       │  (fs watcher │
│   via queue) │       │  + queue)│       │   + syncer)  │
└──────────────┘       └──────────┘       └──────────────┘
                                                 │
                                          ┌──────┴──────┐
                                          │  Filesystem  │
                                          │  (canonical) │
                                          └─────────────┘
```

### Daemon Setup

A daemon runs outside any pattern, so it starts from a `Runtime` it built
itself and from cells it looked up on a deployed piece. Before the first sync
cycle, bring those cells and the storage layer up to date:

```typescript
import type { Cell, Runtime } from "@commonfabric/runner";

export async function prepare(
  runtime: Runtime,
  stateCell: Cell<unknown>,
  editsCell: Cell<unknown>,
): Promise<void> {
  await Promise.all([
    stateCell.sync(),
    editsCell.sync(),
    runtime.storageManager.synced(),
  ]);
}
```

### Scheduling the Sync

Two things ask for a sync: the filesystem changed, or the pattern appended an
edit. Both funnel into one scheduler that runs at most one cycle at a time.
When a request arrives while a cycle is running, `syncAgain` records it and a
trailing cycle picks it up. The worst case is a cycle that re-reads the
filesystem, finds nothing new, and writes nothing.

```typescript
import type { Cell } from "@commonfabric/runner";
import { debounce } from "@std/async";

// One full compare-and-swap cycle: `doSyncCycle` from the next section, with
// its runtime, cells and paths already bound.
declare function doSync(): Promise<void>;

export function scheduleSyncs(
  editsCell: Cell<unknown[]>,
  watchPath: string,
): { dispose: () => void } {
  let syncInProgress = false;
  let syncAgain = false;

  async function sync(): Promise<void> {
    if (syncInProgress) {
      syncAgain = true;
      return;
    }
    syncInProgress = true;
    try {
      do {
        syncAgain = false;
        await doSync();
      } while (syncAgain);
    } finally {
      syncInProgress = false;
    }
  }

  // Coalesce the burst of events a single save produces into one cycle.
  const debouncedSync = debounce(sync, 100);

  function scheduleSync(): void {
    syncAgain = true;
    debouncedSync();
  }

  const watcher = Deno.watchFs(watchPath, { recursive: true });
  (async () => {
    for await (const _event of watcher) scheduleSync();
  })();

  const cancelEditsSink = editsCell.sink(scheduleSync);

  scheduleSync(); // Initial sync.

  return {
    dispose() {
      watcher.close();
      cancelEditsSink();
    },
  };
}
```

### The Sync Cycle

One cycle applies the pending edits to the filesystem, reads the filesystem
back into cells, and clears the queue — all as a single compare-and-swap
transaction. If the commit fails, a new edit arrived while the cycle was
running, and the cycle repeats against the longer queue.

```typescript
import type { Cell, MemorySpace, Runtime } from "@commonfabric/runner";
import { popFrame, pushFrameFromCause } from "@commonfabric/runner";

/** What the user asked for, recorded before it reaches the filesystem. */
type Edit =
  | { type: "create"; name: string; pendingId?: string }
  | { type: "rename"; id: string; name: string }
  | { type: "delete"; id: string };

interface Item {
  id: string;
  name: string;
}

interface State {
  items: Item[];
}

/** An edit the filesystem refused. */
interface FailedEdit {
  edit: Edit;
  error: string;
}

/** The cells the pattern and the daemon share. */
interface SyncCells {
  state: Cell<State>;
  edits: Cell<Edit[]>;
  appliedEdits: Cell<Edit[]>;
  failedEdits: Cell<FailedEdit[]>;
}

// Applies one edit to the filesystem. A "create" comes back with the ID the
// filesystem assigned to the new item.
declare function applyEditToFilesystem(
  edit: Edit,
  watchPath: string,
): { canonicalId?: string };

// Reads the whole directory and builds the cell structure, using the cell
// constructor for stable identity. See "Building State with Stable Identity".
declare function buildStateFromFs(
  watchPath: string,
  cellFor: (cause: unknown) => Cell<Item>,
): State;

// Tells a broken environment apart from an edit that cannot succeed. See
// "Error Handling: Failed Edits".
declare function isSystemError(error: unknown): boolean;

// Points the cell an optimistic create allocated at the canonical cell. See
// "Write Redirect Links for In-Flight Edits".
declare function redirectToCanonical<T>(
  editCell: Cell<T>,
  canonicalCell: Cell<T>,
): void;

// An edit the pattern enqueued against an item that had not reached the
// filesystem yet names that item by its pending ID. Once the filesystem has
// assigned the real one, swap it in.
function resolveEdit(edit: Edit, pendingToCanonical: Map<string, string>): Edit {
  if (edit.type === "create") return edit;
  const canonicalId = pendingToCanonical.get(edit.id);
  return canonicalId === undefined ? edit : { ...edit, id: canonicalId };
}

export async function doSyncCycle(
  runtime: Runtime,
  space: MemorySpace,
  cells: SyncCells,
  watchPath: string,
  cellFor: (cause: unknown) => Cell<Item>,
  // The cells the pattern allocated for items it created optimistically,
  // keyed by the position of the create edit in the queue.
  tempCells: Map<number, Cell<Item>>,
  // Pending IDs the pattern minted, mapped to the IDs the filesystem assigned.
  // This one outlives the cycle: an edit naming a pending ID can arrive long
  // after the create that minted it was synced.
  pendingToCanonical: Map<string, string>,
): Promise<void> {
  // How far into the queue the filesystem has already been taken. It lives
  // outside the retry loop, so a retry does not apply an edit twice.
  let editWatermark = 0;
  // Canonical IDs learned on an earlier attempt, kept across retries.
  const editIdMap = new Map<Edit, string>();
  // What became of each edit the filesystem has already seen. These accumulate
  // across retries for the same reason the watermark does: an aborted attempt
  // still applied its edits to disk, and the commit that finally lands is the
  // only one that gets to record them.
  const applied: Edit[] = [];
  const failed: FailedEdit[] = [];
  let committed = false;

  while (!committed) {
    // Which optimistic-create cells this attempt redirected. Reset per
    // attempt, because an aborted commit undoes the redirects with it.
    const redirected: number[] = [];

    // Let any in-flight storage traffic settle first.
    await runtime.storageManager.synced();

    const tx = runtime.edit();
    const frame = pushFrameFromCause("fs-sync", {
      runtime,
      tx,
      space,
      inHandler: true,
    });

    try {
      // Bind the cells to this transaction, so every read and write below
      // belongs to the same compare-and-swap unit.
      const txState = cells.state.withTx(tx);
      const txEdits = cells.edits.withTx(tx);
      const txApplied = cells.appliedEdits.withTx(tx);
      const txFailed = cells.failedEdits.withTx(tx);

      const edits = txEdits.get();

      // 1. Apply the edits past the watermark to the filesystem. On the first
      //    attempt the watermark is 0, so every edit is applied. On a retry
      //    only the edits that arrived since are applied; the earlier ones
      //    are already on disk.
      for (let i = editWatermark; i < edits.length; i++) {
        const original = edits[i];
        const edit = resolveEdit(original, pendingToCanonical);
        try {
          const { canonicalId } = applyEditToFilesystem(edit, watchPath);
          if (canonicalId !== undefined) {
            editIdMap.set(original, canonicalId);
            if (original.type === "create" && original.pendingId !== undefined) {
              pendingToCanonical.set(original.pendingId, canonicalId);
            }
          }
          applied.push(edit);
        } catch (error) {
          if (isSystemError(error)) {
            // The environment is broken. Leave the edit in the queue and
            // stop, so an operator can fix the condition and restart.
            throw new Error(
              `System error applying edit: ${(error as Error).message}. ` +
                `Edit remains in queue. Fix the issue and restart.`,
            );
          }
          // The edit cannot succeed as written. Record it and carry on.
          failed.push({ edit, error: (error as Error).message });
        }
      }
      editWatermark = edits.length;

      // 2. Read the whole filesystem state back and write it to cells.
      txState.set(buildStateFromFs(watchPath, cellFor));

      // 3. Redirect the cells the pattern allocated for optimistic creates
      //    at the cells their canonical IDs now name. These writes go through
      //    the transaction, so a failed commit rolls them back and the next
      //    attempt has to make them again.
      for (const [index, tempCell] of tempCells) {
        const canonicalId = editIdMap.get(edits[index]);
        if (canonicalId === undefined) continue;
        redirectToCanonical(tempCell, cellFor(canonicalId));
        redirected.push(index);
      }

      // 4. Clear the queue, and record what happened to every edit this cycle
      //    has processed, including the ones an earlier attempt applied.
      txApplied.push(...applied);
      txFailed.push(...failed);
      txEdits.set([]);
    } finally {
      popFrame(frame);
    }

    // 5. Commit. A failure means a new edit was appended while this cycle was
    //    running, so go round again and catch up. The watermark keeps the
    //    filesystem from receiving the earlier edits a second time.
    const { error } = await tx.commit().settled;
    if (!error) {
      committed = true;
      // The redirects are durable now, so stop offering those cells.
      for (const index of redirected) tempCells.delete(index);
    }
  }
}
```

### Building State with Stable Identity

> **TODO(seefeld):** `Cell.for()` in handler frames creates cells scoped to that
> handler invocation. For importers operating outside a pattern, we need a shared
> frame so `Cell.for()` produces consistent cells across the whole import. Current
> workaround: `pushFrameFromCause` with a stable cause string. This needs
> platform-level support.

The `buildStateFromFs` function (or equivalent) **must** use `Cell.for()` for
every sub-item that has an external canonical ID. A daemon runs outside a
pattern, so it is handed the cell constructor rather than reaching for a bound
`Cell`:

```typescript
import type { Cell } from "@commonfabric/runner";

interface Item {
  id: string;
  name: string;
  path: string;
}

interface State {
  items: Item[];
}

interface FsState {
  items: Array<{ canonicalId: string; name: string; path: string }>;
}

export function buildStateFromFs(
  fsState: FsState,
  cellFor: (cause: unknown) => Cell<Item>,
): State {
  return {
    items: fsState.items.map((item) =>
      // `for()` derives the cell from the canonical ID, so the same ID always
      // names the same cell and links to this item survive across syncs.
      // `set()` hands back the cell, which stands in for the item's value
      // inside the structure being built.
      cellFor(item.canonicalId).set({
        id: item.canonicalId,
        name: item.name,
        path: item.path,
      }) as unknown as Item
    ),
  };
}
```

This is not a post-processing step — it must happen as part of constructing the
state structure. If you write the structure first and then try to set up
`Cell.for()` mappings afterward, the items in the array will have ephemeral cell
IDs that break on every sync.

### Don't Diff — Let the Runtime Do It

When writing the full state to cells, write the entire structure at once with a
single `.set()`. Don't manually diff old vs. new state. The cell infrastructure
diffs internally and only persists the minimal changes.

Only consider manual diffing once the dataset is too large to load into memory
at once. You're far from that threshold.

### Process Safety: Lockfiles

Only one daemon instance should run per sync target. Use a lockfile with the
daemon's PID:

```typescript
export function acquireLock(lockPath: string): boolean {
  try {
    // Creating the file exclusively is the atomic step: two daemons racing
    // for the same target cannot both succeed.
    Deno.writeTextFileSync(lockPath, String(Deno.pid), { createNew: true });
    return true;
  } catch {
    try {
      const existingPid = parseInt(Deno.readTextFileSync(lockPath), 10);
      // Throws when no such process exists.
      Deno.kill(existingPid, "SIGCONT");
      return false; // The other daemon is running; its lock stands.
    } catch {
      // The lock names a process that is gone. Reclaim it.
      Deno.writeTextFileSync(lockPath, String(Deno.pid));
      return true;
    }
  }
}

export function releaseLock(lockPath: string): void {
  try {
    Deno.removeSync(lockPath);
  } catch {
    // Already gone.
  }
}

export function releaseLockOnExit(lockPath: string): void {
  globalThis.addEventListener("unload", () => releaseLock(lockPath));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    Deno.addSignalListener(signal, () => {
      releaseLock(lockPath);
      Deno.exit(0);
    });
  }
}
```

### Error Handling: Failed Edits

Not all edit failures are equal. Two categories require different strategies:

- **System errors** (permissions, disk full, network timeout): The environment
  is broken — retrying won't help until an operator intervenes. **Keep the
  failed edit in the queue** (don't clear it) and **crash the daemon with a
  clear error message.** The operator fixes the condition (frees disk, fixes
  permissions), restarts the daemon, and the edit applies naturally on the next
  sync cycle.
- **Conflict errors** (file was deleted externally, path collision): The edit
  can't succeed as-is and won't succeed on retry either. Move to a `failedEdits`
  queue and surface to the user for reformulation. The daemon continues running.

Step 1 of the sync cycle is where the two are told apart. The test itself looks
at what the filesystem reported:

```typescript
export function isSystemError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("permission denied") ||
    message.includes("no space left") ||
    message.includes("disk full") ||
    message.includes("enospc") ||
    message.includes("eacces");
}
```

A system error throws out of the cycle before the transaction commits, so the
queue is never cleared and every pending edit is preserved. A conflict error
joins the `failed` list, which the cycle commits to `failedEdits` alongside the
edits that succeeded.

### Why This Works: CAS Atomicity and the No-Loss Guarantee

The sync loop above has a subtle but critical correctness property: **no user
edit is ever lost or temporarily reverted, even under concurrent modification.**
This section explains which parts of the code are load-bearing and why.

#### The core invariant

Every sync cycle performs these steps in a single CAS transaction:

1. Read `editsCell` (the pending edit queue)
2. Apply those edits to the filesystem
3. Read the filesystem back into `stateCell`
4. Clear `editsCell`

The transaction reads `editsCell` at step 1 and writes it at step 4. If a user
appends a new edit between steps 1 and 4, the CAS check fails at commit time —
the value of `editsCell` changed since we read it. The transaction aborts and
retries.

This is the key mechanism: **the edit queue is both the input and the sentinel.**
Reading it at the start and clearing it at the end means any concurrent append
is automatically detected.

#### What the watermark protects

When a transaction retries, we don't want to re-apply edits that already made it
to the filesystem. The `editWatermark` in `doSyncCycle` tracks how far we got:

```
First attempt:  edits = [A, B]    → apply A, B to fs → watermark = 2
                tx fails (user appended C)
Retry:          edits = [A, B, C] → skip A, B (watermark) → apply C → watermark = 3
```

The watermark lives outside the `while (!committed)` loop but inside
`doSyncCycle`, so it survives across CAS retries within a single sync cycle but
resets between cycles. The `editIdMap` works the same way — canonical IDs
discovered during earlier attempts are preserved across retries.

The `applied` and `failed` lists must live out there too, and for a reason that
is easy to miss. An aborted attempt still wrote its edits to the filesystem,
and the watermark makes sure the next attempt skips them. So if those lists
were rebuilt per attempt, the commit that finally lands would record only the
last attempt's edits. Every edit an earlier attempt applied would vanish from
`appliedEdits`, and, worse, every edit an earlier attempt rejected would vanish
from `failedEdits` without ever reaching the user who has to reformulate it.
Accumulating both lists across attempts is what makes the winning commit a
complete record of the cycle.

The redirects go the other way. Each one is a write through the transaction, so
an aborted commit rolls it back and the next attempt has to make it again. That
is why a `tempCells` entry is only dropped after a commit succeeds. Drop one
earlier and the retry skips a redirect that no longer exists, leaving an
optimistically created item pointing at a cell nothing writes to.

#### Why there's no backsliding

"Backsliding" means: user edits a file, sees the optimistic update in the UI,
then momentarily sees the old state before the sync catches up. This can't
happen because the optimistic apply and the queue append happen in the same
atomic transaction on the pattern side (see the `onRename` handler). And on the
daemon side, the state overwrite and the queue clear happen in the same atomic
transaction. There is no window where `stateCell` reflects the old filesystem
content while `editsCell` is empty.

If those were separate transactions — clear the queue, then update state — a
reader between the two would see: edits gone, state not yet updated. The single
transaction eliminates this window.

#### Why append-only matters

The edit queue is append-only during normal operation. Edits are only removed by
the daemon (step 4: `txEdits.set([])`). This means:

- A CAS retry always sees the original edits plus any new ones — never fewer.
- The watermark is always valid: edits before the watermark are the same objects
  in the same order.
- The daemon never needs to reconcile a partially-modified queue.

If edits could be removed or reordered by the UI, the watermark would be
meaningless and the retry logic would need to diff against the filesystem to
figure out what's already applied.

#### The concurrency guard's role

The `syncInProgress` / `syncAgain` guard in `scheduleSyncs` is not about
correctness — CAS handles that. It's about efficiency. Without it, rapid
filesystem changes or edit queue appends would spawn overlapping sync cycles,
each doing redundant filesystem reads. The guard serializes sync cycles so at
most one runs at a time, and the `syncAgain` flag ensures a trailing cycle picks
up anything that arrived mid-sync.

#### Summary of load-bearing parts

| Code                             | What it protects                              |
| -------------------------------- | --------------------------------------------- |
| `txEdits.get()` + `txEdits.set([])` in same tx | No-loss guarantee: CAS detects concurrent appends |
| `txState.set(...)` in same tx    | No-backsliding: state and queue are always consistent |
| `editWatermark`                  | No double-apply: filesystem edits aren't repeated on retry |
| `editIdMap` outside retry loop   | Canonical IDs survive CAS retries             |
| `applied`/`failed` outside retry loop | The winning commit records every edit the cycle processed |
| `tempCells` entries dropped after commit | A rolled-back redirect is made again on the retry |
| `pendingToCanonical` across cycles | Edits naming a pending ID still reach the right item |
| Append-only queue                | Watermark validity: prefix is stable across retries |
| `syncInProgress` guard           | Efficiency: one sync at a time, no redundant fs reads |

---

## Pattern (UI) Side

The pattern that presents this synced state to users is straightforward because
the daemon handles all the complexity.

### Rendering

Render directly from the synced state cell. No local state management, no
optimistic-update tracking in the UI layer.

```tsx
// Shown at module scope.
interface Item {
  id: string;
  name: string;
}

interface State {
  items: Item[];
}

const myPattern = pattern<{ state: State; edits: Edit[] }>(
  ({ state, edits }) => {
    return (
      <div>
        {state.items.map((item) => <div>{item.name}</div>)}
      </div>
    );
  },
);
```

### Editing

On user interaction, atomically (via `action()` or `handler()`) do two things:

1. Append the edit to the edit queue
2. Optimistically apply the change to the local state

```tsx
// Shown at module scope.
const onRename = handler<
  { name: string },
  { item: Writable<Item>; edits: Writable<Edit[]> }
>((event, { item, edits }) => {
  // Enqueue the edit
  edits.push({ type: "rename", id: item.get().id, name: event.name });

  // Optimistic update — will be overwritten by next sync
  item.key("name").set(event.name);
});
```

Because both mutations happen in a single atomic transaction, the UI never sees
an inconsistent state.

### Rendering Pending State

There are two simple approaches — choose based on your UI needs:

**Option A: Inline pending state.** Link the edit data directly into the state
structure. It renders while it's there, and automatically disappears when the
sync overwrites the state. No cleanup logic needed — reactivity handles it.

**Option B: Render the queues.** Show the `edits` array (pending) and
`appliedEdits` array (done) directly. This works well for progress indicators or
"syncing..." badges.

```tsx
// Shown as JSX element children.
{edits.length > 0 && (
  <span className="sync-badge">Syncing {edits.length} changes...</span>
)}
```

---

## API / Webhook Sync

API-based sync (e.g., syncing GitHub issues) shares the same core principles as
filesystem sync but differs in important ways:

- **Operations are asynchronous and may fail independently.** A single "apply
  edits" step may involve multiple API calls, some of which succeed and some
  fail.
- **Reading canonical state requires an API call** that may be slow or
  rate-limited, unlike reading the filesystem which is effectively instant.
- **There is no filesystem as a merge point.** The daemon pattern uses the
  filesystem as an implicit merge layer (write edits to files, read files back).
  With an API, you need explicit merge logic.

For webhook infrastructure details, see
[docs/specs/webhook-ingress/README.md](../specs/webhook-ingress/README.md).

### Edits as Lifecycle Entities

In filesystem sync, edits are simple intent records that get applied and cleared
in a single transaction. API sync can't do that — API calls take time, may fail,
and may be confirmed asynchronously via webhook. So each edit becomes a
first-class entity with its own lifecycle:

```
pending → in-flight → succeeded | failed
```

An edit carries:

- **type** — the action (e.g., `"create-issue"`, `"close-pr"`, `"add-star"`)
- **target** — cell reference or canonical ID indicating where to render this
  edit (e.g., "this belongs on the issues list", "this belongs on PR #42")
- **payload** — the data for the action
- **stage** — `pending`, `in-flight`, `succeeded`, or `failed`
- **error** — error info when `failed`
- **timestamps** — `createdAt`, `sentAt`, `resolvedAt`

```typescript
// Shown at module scope.
interface ApiEdit {
  type: string;
  target: CellReference; // Where this edit should render
  payload: Record<string, unknown>;
  stage: "pending" | "in-flight" | "succeeded" | "failed";
  error?: string;
  createdAt: number;
  sentAt?: number;
  resolvedAt?: number;
}
```

A computed index maps targets to their pending edits for efficient lookup:

```typescript
// Shown inside a pattern body.
const editsByTarget = computed(() => {
  const index = new Map<CellReference, ApiEdit[]>();
  for (const edit of editsCell.get()) {
    if (edit.stage === "pending" || edit.stage === "in-flight") {
      const list = index.get(edit.target) ?? [];
      list.push(edit);
      index.set(edit.target, list);
    }
  }
  return index;
});
```

#### Heavy vs. Lightweight Actions

Not all edits are treated the same:

- **Heavy actions** (create issue, close PR, merge branch): Do NOT optimistically
  apply to local state. Instead, render the edit itself as a pending action in the
  UI — a grayed-out card with a spinner. When the API responds or a webhook
  confirms success, write the real entity with `Cell.for(canonicalId)`. No write
  redirects are needed because the edit was never materialized as a cell in the
  state structure.

- **Lightweight actions** (star, emoji react, label toggle): CAN be optimistically
  applied to local state, just like filesystem edits. The next sync overwrites
  with canonical data.

The key insight: heavy actions avoid the write-redirect complexity entirely by
keeping the edit and the canonical entity as separate things until confirmation.

### Outbound: Triggering API Actions

When the user performs an action:

1. **Create the edit** — atomically append to the edits cell with
   `stage: "pending"`
2. **Fire the API call** — immediately dispatch the request and advance to
   `stage: "in-flight"`
3. **On success** — write the canonical entity via `Cell.for(canonicalId)`,
   advance edit to `succeeded`, clean up
4. **On failure** — mark edit as `failed` with error info

```typescript
// Shown for illustration only.
const createIssue = handler<{ edits: ApiEdit[] }>(
  ({ edits }, title: string, body: string) => {
    const edit: ApiEdit = {
      type: "create-issue",
      target: issueListRef,
      payload: { title, body },
      stage: "pending",
      createdAt: Date.now(),
    };
    edits.push(edit);

    // Fire immediately — runs after the transaction commits
    queueMicrotask(async () => {
      edit.stage = "in-flight";
      edit.sentAt = Date.now();
      try {
        const result = await github.createIssue({ title, body });
        // Write canonical entity
        Cell.for(`issue:${result.number}`).set({
          number: result.number,
          title: result.title,
          body: result.body,
          state: result.state,
        });
        edit.stage = "succeeded";
        edit.resolvedAt = Date.now();
      } catch (err) {
        edit.stage = "failed";
        edit.error = err.message;
        edit.resolvedAt = Date.now();
      }
    });
  },
);
```

> **Future:** A retry mechanism for edits that never got a response (network
> failure, process restart). For now, assume we always get a response — either
> immediately from the API call or asynchronously via webhook.

### Inbound: Webhook Incremental Updates

Webhooks deliver events as they happen. Each event is applied as an incremental
update in a single transaction:

```typescript
// Shown for illustration only.
async function handleWebhookEvent(event: WebhookEvent) {
  // Deduplicate via event ID (idempotency)
  if (processedEvents.has(event.id)) return;
  processedEvents.add(event.id);

  // Handle out-of-order delivery: ignore stale updates
  const existing = Cell.for(`issue:${event.issue.number}`).get();
  if (existing && existing.updatedAt > event.issue.updatedAt) return;

  // Apply the update
  Cell.for(`issue:${event.issue.number}`).set({
    number: event.issue.number,
    title: event.issue.title,
    body: event.issue.body,
    state: event.issue.state,
    updatedAt: event.issue.updatedAt,
  });

  // If this confirms a pending edit, advance it
  const pendingEdit = findMatchingEdit(event);
  if (pendingEdit) {
    pendingEdit.stage = "succeeded";
    pendingEdit.resolvedAt = Date.now();
  }
}
```

Key considerations:

- **Idempotency** — Deduplicate via event ID. Webhooks may be delivered more than
  once.
- **Ordering** — Use timestamps or sequence numbers to ignore stale updates.
  If event B has an older timestamp than data you already have, skip it.
- **Confirming edits** — When a webhook confirms an action you initiated, advance
  the corresponding edit to `succeeded`.

For webhook infrastructure, see
[docs/specs/webhook-ingress/README.md](../specs/webhook-ingress/README.md).

### Consistency Backstop: Full Rebuild

Webhooks are best-effort. To catch missed events, drift, and eventual consistency
gaps, periodically (or on user request) run a full rebuild:

```typescript
// Shown for illustration only.
async function fullRebuild() {
  // Read everything from the API
  const allIssues = await github.listAllIssues();
  const allPRs = await github.listAllPullRequests();

  // Write full structure in a single transaction
  const tx = runtime.edit();
  const frame = pushFrameFromCause("github-importer", { runtime, tx, space });
  try {
    stateCell.set({
      issues: allIssues.map((issue) =>
        Cell.for(`issue:${issue.number}`).set({
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          updatedAt: issue.updatedAt,
        })
      ),
      pullRequests: allPRs.map((pr) =>
        Cell.for(`pr:${pr.number}`).set({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          updatedAt: pr.updatedAt,
        })
      ),
    });
  } finally {
    popFrame(frame);
  }
  await tx.commit().settled;
}
```

This is the same pattern as filesystem sync: read everything, write with
`Cell.for()`, single transaction. The only difference is the data source.

### Pattern (UI) Integration for API Sync

The pattern renders canonical state as normal, plus overlays pending and failed
edits at the appropriate locations:

```tsx
// Shown for illustration only.
const issueList = pattern<{ state: State; edits: ApiEdit[] }>(
  ({ state, edits }) => {
    const pendingEdits = computed(() =>
      edits.filter((e) =>
        e.target === issueListRef &&
        (e.stage === "pending" || e.stage === "in-flight")
      )
    );
    const failedEdits = computed(() =>
      edits.filter((e) => e.target === issueListRef && e.stage === "failed")
    );

    return (
      <div>
        {/* Canonical state */}
        {state.issues.map((issue) => <IssueCard issue={issue} />)}

        {/* Pending edits: grayed-out cards with spinner */}
        {pendingEdits.map((edit) => (
          <div class="pending-card">
            <Spinner /> {edit.payload.title}
          </div>
        ))}

        {/* Failed edits: error + retry/cancel */}
        {failedEdits.map((edit) => (
          <div class="failed-card">
            <span class="error">{edit.error}</span>
            <button onClick={() => retryEdit(edit)}>Retry</button>
            <button onClick={() => cancelEdit(edit)}>Cancel</button>
          </div>
        ))}
      </div>
    );
  },
);
```

Succeeded edits auto-disappear: once a webhook or full rebuild writes the
canonical entity, the edit is marked `succeeded` and filtered out of the pending
display. No manual cleanup needed — reactivity handles it.

---

## Applied Edits Lifecycle

The `appliedEdits` array records edits that were successfully synced. Its
lifecycle is TBD per use case. Some options:

- **Keep it simple.** Since this is O(user operations), the array stays small
  enough that unbounded growth is not a concern in practice.
- **Date-based history.** Periodically move old entries to a dated archive cell
  (e.g., `appliedEdits-2026-02-27`), keeping the active array short.
- **Fixed window.** Keep the last N entries and discard older ones.
- **Pattern-driven cleanup.** Let the UI pattern clear `appliedEdits` after
  rendering confirmation to the user.

Start simple (keep everything in the array) and add cleanup when you actually
need it.

---

## Summary

| Concern                | Solution                                               |
| ---------------------- | ------------------------------------------------------ |
| Atomicity              | CAS transactions — all mutations commit or retry       |
| Optimistic updates     | Apply edits to local state in same tx as enqueue       |
| External canonical     | Overwrite local state from external source each sync   |
| Anti-backsliding       | Single tx: apply edits + update state + clear queue    |
| Stable identity        | `Cell.for(externalId)` for canonical-ID-bearing items   |
| In-flight link safety  | Write redirect links from temp cells to canonical ones |
| Process safety         | Lockfile with PID, stale lock recovery                 |
| System edit failures   | Keep in queue, crash daemon, operator restarts         |
| Conflict edit failures | Move to failedEdits queue, surface to user             |
| UI pending state       | Render from edit queue; auto-clears on sync            |
| Edit lifecycle         | Staged entities: pending → in-flight → succeeded/failed |
| Heavy actions          | Render as pending edits, not optimistic state          |
| Webhook sync           | Incremental updates via `Cell.for()`; full rebuild as backstop |

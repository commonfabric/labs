# FUSE Reliability Design

## Purpose

This document describes an implementation plan for making `@commonfabric/fuse`
safe under backend stalls, transport failures, CFC writeback, and platform FUSE
quirks while preserving normal filesystem behavior for ordinary programs.

The normative API contract lives in `docs/specs/fuse-filesystem/`. This package
document is implementation-specific: it names current code seams, proposed
actors/FSMs, deadline and backpressure policy, rollout phases, and test targets.

## Current Baseline

The implementation already has several reliability foundations:

- `mod.ts` tracks pending async FUSE replies with `trackPendingFuseReply()` and
  defers kernel invalidation until pending replies drain.
- `handles.ts` owns per-handle write buffers, truncate state, dirty flags,
  versioning, range checks, and per-handle CFC authorization.
- `mod.ts` schedules safety-net flushes for transports that do not reliably send
  `flush`/`release`, and keeps the write statistics that `.status` reports.
- `cell-bridge.ts` exposes `.status` as a generated file: the write path leaves
  it alone, and a lookup or a bare stat renders it from current state and
  publishes what a following read serves. A getattr that carries an already-open
  descriptor is the exception — it reports that descriptor's snapshot, size and
  publish time both, rather than publishing again, so the descriptor's reads
  stay consistent. It also marks the mount disconnected/read-only on transport
  errors, and reconnects with capped exponential backoff.
- `cell-bridge.ts` serializes and coalesces per-piece-property rebuilds, dedupes
  in-flight hydrations, stages rebuilds under pending roots and reconciles them
  onto the live subtree in place so inodes stay stable, and invalidates the
  exact cache entries a rebuild changed.
- `cfc-writeback.ts` persists prepared CFC writeback records, tracks crash-point
  states, and reconciles records after a subtree rebuild.

The main gap is that several mutating paths still acknowledge FUSE success
before the Common Fabric operation has reached a clear commit or acceptance
boundary. That improves responsiveness but makes normal tools vulnerable to
silent backend failure, transport loss, or CFC finalize failure.

## Target Posture

Treat the daemon as a bounded-latency POSIX adapter, not a best-effort RPC
proxy. Every FUSE request should enter a tracked lifecycle: copy transient
arguments, start a deadline, optionally register interrupt handling, enqueue
under bounded concurrency, and reply exactly once.

For the default mode, mutating operations are commit-confirmed: FUSE reports
success only after local validation, CFC authorization, backend mutation or
runtime acceptance, and safe projection invalidation/reconciliation reach the
operation's success boundary. Local-ack or offline-queue behavior may exist only
as an explicit compatibility mode and must be visible in `.status`.

## Core Invariants

1. **Exactly one reply per request.** Every received low-level request reaches
   one terminal reply path. Timeout, cancellation, success, and error paths race
   through one `replyOnce` guard.
2. **Bounded wait.** No request waits indefinitely for backend I/O, reconnect,
   rebuild, CFC reconciliation, or invalidation. Deadlines resolve to standard
   errno values.
3. **No default local-ack for mutations.** A mutating syscall reports success
   only after the operation reaches its configured Common Fabric boundary.
4. **Visible tree equals confirmed projection.** Shared `FsTree` state should
   not expose optimistic creates, deletes, renames, symlinks, or cell writes.
   Only handle-private buffers may be speculative.
5. **Per-cell ordering.** Mutations serialize per logical
   `(space, entity, cell)` unless the backend provides stronger
   ordered/idempotent write primitives.
6. **Handlers are non-idempotent.** One buffered handler write maps to at most
   one runtime send. Never auto-retry handler invocations after timeout or
   reconnect without a future idempotency-key contract.
7. **CFC fails closed.** Missing, stale, or incomplete labels remain
   incomplete/fail-closed. FUSE produces and reconciles annotations; gVisor owns
   sandbox observation policy.
8. **Backpressure is explicit.** Queue saturation, degraded state, or backend
   unavailability become visible errno/status outcomes, not unbounded memory or
   silent pending success.

## Request Lifecycle

Introduce a small `FuseRequestSlot` wrapper in `mod.ts` or a helper module:

```text
received
  -> validating
  -> queued
  -> running
  -> replying
  -> replied

received/validating/queued/running
  -> timed-out
  -> replying
  -> replied
```

Each slot records:

- operation name, inode, path/name copies, file handle, and logical ref when
  known;
- start time, deadline, and timeout reason;
- whether an interrupt was observed;
- reply state and errno/data summary;
- associated mutation operation ID, if any.

Callbacks must copy names, buffers, and file-info fields they need before
returning to libfuse. The slot owns the reply pointer until `replyOnce()` fires.
`forget`-style operations remain special: they use no normal reply but still
must stay on the high-priority cleanup lane.

### Suggested Deadlines

Initial values should be constants surfaced through `.status`:

| Operation class                       | Soft deadline   |
| ------------------------------------- | --------------- |
| cached metadata/read                  | 50 ms           |
| cold lookup/hydration                 | 2 s             |
| `readdir` page                        | 5 s             |
| cell content write/flush              | 30 s            |
| handler runtime acceptance            | 30 s            |
| source pattern update                 | 60 s            |
| `fsync` / explicit durability barrier | 60-120 s        |
| reconnect probe                       | 5 s per attempt |

Linux `request_timeout` and macFUSE `daemon_timeout` should be treated as hard
provider safety nets above these internal deadlines. Provider hard timeouts may
abort or eject the entire mount, so they are not normal control flow.

## Actor Boundaries

The implementation does not need a new framework. Treat existing modules as
actors with explicit ownership and bounded mailboxes.

| Actor                | Existing home                              | Responsibility                                                                                                                                                                                       |
| -------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FUSE adapter         | `mod.ts`                                   | Low-level callback translation, local deterministic validation, request slots, errno replies, pending-reply tracking. It should not call backend mutation APIs directly once the coordinator exists. |
| Handle actor         | `handles.ts`                               | Open-file state, write buffers, truncate state, dirty/version flags, max file size, flush/release dedupe.                                                                                            |
| Mutation coordinator | new module, e.g. `mutation-coordinator.ts` | Per-cell queues, operation deadlines, commit ordering, timeout classification, result-to-errno mapping, `.status` operation metrics.                                                                 |
| Projection actor     | `cell-bridge.ts`                           | Space connection, hydration, subscriptions, queued rebuilds, source tree rebuilds, cache invalidation scheduling.                                                                                    |
| CFC writeback actor  | `cfc-writeback.ts`                         | Prepare/finalize records, stale-generation detection, recovery persistence, diagnostics, and reconciliation.                                                                                         |
| Connection actor     | `cell-bridge.ts` initially                 | `online -> suspect -> readOnly/reconnecting -> online` transitions, reconnect backoff, synced/reconciled gating before writes resume.                                                                |

## Supervisor, Worker, and Process Isolation

Deno Workers are useful as an inner responsiveness boundary, but they are not a
hard recovery boundary for native FFI or FUSE provider wedges. Workers run in
the same OS process as their creator. `Worker.terminate()` can stop JavaScript
execution and message processing, but it should be treated as best-effort for a
worker blocked inside native libfuse/FFI code, a blocking FFI helper thread, or
a provider/kernel call that never returns.

The first process-boundary architecture should stay Deno-only:

```text
cf fuse mount --background
  -> Deno supervisor process
       -> Deno FUSE child process that loads libfuse and owns the mount
            -> optional Deno Worker for libfuse session and hot FUSE state
            -> child control plane for heartbeat, status, and graceful unmount
```

The supervisor process must not load libfuse or call Deno FFI. Its job is to
spawn the FUSE child, track its PID/process group, monitor heartbeat/status,
request graceful unmount, escalate to platform abort/force-unmount, and kill or
restart the child when needed.

The Deno FUSE child owns the libfuse session, callbacks, `FsTree`, `CellBridge`,
CFC writeback store, request deadlines, and mutation coordinator. This is
already enough to create a real kill/restart boundary: if the child wedges in
native/libfuse/provider code, the supervisor remains schedulable because it is a
separate OS process.

An optional worker inside the child can keep the child process control plane
responsive if the FUSE session's JavaScript event loop stalls. It should not be
used as the only supervisor for production reliability. If the worker gets
wedged in native code, the containing child process may still retain native
threads, libfuse state, mount state, or corrupted address-space state. The hard
reset boundary is the child process.

Design rules:

- If the libfuse session runs in a worker, keep the hot filesystem state in that
  worker too: `FsTree`, callbacks, handle map, mutation coordinator, CFC
  writeback integration, deadlines, and reply guards. Avoid serializing every
  filesystem operation across worker messages.
- Keep the child-process control plane small: heartbeat, status snapshots,
  graceful `fuse_session_exit`/unmount request, and final process exit.
- Keep the external supervisor outside any process that has loaded libfuse. It
  owns wall-clock containment, forced unmount/abort, and process kill/restart.
- Request deadlines still live inside the FUSE request lifecycle. A supervisor
  can abort a mount, but it cannot provide clean per-operation errno replies
  once the session worker is wedged.

Initial implementation may remain single-process while the mutation coordinator
and request deadlines are built. The first isolation step should then be the
Deno supervisor + Deno FUSE child split above, not a worker-only refactor. A
worker-only refactor is worthwhile only if JavaScript event-loop coupling is the
dominant problem and native/provider wedges are not observed.

A Rust component should be a sidecar executable, not a Deno extension, if it is
introduced for reliability. A Rust extension loaded into Deno would share the
same process-boundary problem as Deno FFI. A Rust sidecar can replace the Deno
FUSE child later if hand-maintained FFI structs, signal handling, or libfuse
threading inside the Deno child remains fragile, while preserving the same Deno
supervisor contract.

## Mutation Operation FSM

All mutating operations should use one common FSM:

```text
queued
  -> validating
  -> cfc-prepared
  -> applying
  -> syncing
  -> projecting
  -> finalizing
  -> succeeded

validating/applying/syncing/projecting/finalizing
  -> failed-known(errno)
  -> timed-out-unknown
  -> disconnected-readonly
```

`failed-known(errno)` means the operation definitely failed before committing or
the backend returned a definite error. `timed-out-unknown` means the daemon can
no longer tell whether the backend will eventually commit; return `ETIMEDOUT`,
record the operation in `.status`, and never replay automatically unless the
operation has an idempotency key.

Human and agent diagnostics must preserve that distinction. `.status` should
show whether the last mutation was a known failure, a timed-out unknown, or an
accepted operation whose downstream reactive effects may still be settling, so
normal errno-style failures remain debuggable from both shell clients and
cf-harness runs.

### Success Boundaries

| Operation                                | Default success boundary                                                                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| scalar / `.json` cell write              | local validation and CFC authorization passed; `cell.set()` resolved; backend sync/acceptance completed; projection invalidation or rebuild is scheduled safely.             |
| `[FS]` projection write                  | parsed content applied to the corresponding cells; required deletes/updates completed; projection invalidation or rebuild is scheduled safely.                               |
| source write                             | `piece.setPattern()` resolved with a commit receipt; error log updated. A projection finalize failure after the commit degrades to a recorded warning, never a failed write. |
| handler write                            | runtime accepted the invocation and sync/idle boundary completed. Downstream reactive effects may settle later.                                                              |
| create/mkdir/unlink/rmdir/rename/symlink | parent/common cell mutation resolved and the shared `FsTree` is updated from confirmed state or safely invalidated for rebuild.                                              |
| CFC writeback                            | trusted prepare was valid when required; mutation succeeded; finalize/reconcile was recorded, or incomplete/fail-closed state was persisted.                                 |

`create`/`mkdir` must not depend on the sandboxed program calling `setxattr`
afterward. Normal programs should run unchanged against `/fabric`; any required
CFC write intent must be supplied by gVisor's kernel-space policy path before
FUSE commits the mutation. In the current gVisor FUSE prototype, gVisor blocks
unprivileged sandbox writes to protected CFC xattr names at the syscall layer,
then its kernel CFC hooks update internal label state and emit ordinary
`FUSE_SETXATTR` requests for `trusted.cfc.*` names. FUSE should therefore treat
protected CFC xattrs as trusted only under that gVisor mediation assumption; a
non-xattr side channel or explicit discriminator would be a future transport
change, not current behavior. The local `user.commonfabric.cfc.*` compatibility
bridge remains only for testing/integration and is not a sandbox trust boundary.
In observe or explicit compatibility mode, a create without complete trusted
intent may proceed only with incomplete/fail-closed annotations and diagnostics.
Enforcing-mode create is app-visible only after the entry is fully labeled and
committed, or it fails with a normal errno.

Implementation bridge: the current code has mediated prepare/finalize xattrs and
persisted `CfcWritebackStore` records; it does not yet have hidden quarantine
dentries or a separate quarantine namespace. The quarantine step must add a
private `QuarantineStore` beside the confirmed `FsTree`. Quarantine records must
not be inserted into parent child maps, readdir indexes, or kernel-visible
inode/dentry state, and normal `lookup`, `readdir`, `readdirplus`, `getattr`,
`access`, `open`, and `opendir` must never consult the store. Records should be
keyed at least by `{ operationId, parentRef, name, expectedGeneration }`, with
operation type, prepared/finalized label state, timestamps, and diagnostics as
record data.

Only trusted completion/finalize handling, trusted abort handling, startup
recovery, and TTL garbage collection may read `QuarantineStore`. Completion must
match by operation ID and validate parent ref, target name, operation type,
generation, and prepared/finalized labels before publishing anything into the
normal projection. FUSE should scan quarantine records on startup and
periodically at runtime, aborting records older than the configured TTL; one
hour is the initial target unless active trusted completion is in progress.
Post-create xattrs are separate modeled metadata operations; they may not
retroactively authorize a usable entry or lower confidentiality/integrity
labels.

## Backpressure Policy

Add bounded queues before backend work:

- global active backend mutations: start with 32;
- per-space active backend mutations: start with 16;
- per-cell active mutation: 1, with bounded pending queue;
- high-priority cleanup lane for `forget`, interrupts, `release`, and watchdog
  cleanup;
- bounded rebuild queue per piece prop, continuing to coalesce stale rebuilds;
- max buffered handle bytes retains the current virtual file limit.

Admission failure should be explicit. For normal blocking filesystem calls, wait
within the request deadline; if no slot opens, return `ETIMEDOUT` or `EIO` based
on state. Reserve `EAGAIN` for documented retryable races, not ordinary
overload.

## Connection and Degraded Modes

Connection state should be explicit in `.status` and should control mutation
admission:

```text
online
  -> suspect
  -> readOnly-reconnecting
  -> reconciling
  -> online
```

When transport failure is detected, remove write bits as the current
`buildStat()` path already does, reject new mutations with `EROFS` or `EIO`,
continue serving cached reads where safe, and probe reconnect with capped
exponential backoff. Before writes resume, the connection actor should require
backend sync plus any needed CFC/writeback reconciliation.

## Invalidation and Platform Policy

Keep invalidation out of active callback/reply paths. The existing pending-reply
drain before `notify_inval_entry` / `notify_inval_inode` is a core safety rule,
especially for FUSE-T.

- On Linux, use deferred invalidation when supported, falling back to short TTLs
  on `ENOSYS` or repeated failures.
- On macOS/FUSE-T, assume provider-specific cache and call-order behavior.
  Prefer short TTLs and deferred/no invalidation over synchronous reverse
  invalidation while the kernel is waiting on the daemon.
- Never store logs, state files, or watchdog artifacts inside the mounted tree;
  that can deadlock the daemon by re-entering its own mount.

## Watchdog and Abort Strategy

The daemon can guarantee bounded replies only while its event loop and native
FFI calls continue to make progress. A supervisor should provide outer
containment:

- heartbeat timestamp from the FUSE process;
- last completed request ID and pending request count;
- Linux fusectl `waiting` count when available;
- last backend success/failure and reconnect state;
- controlled unmount/abort/kill path when heartbeat stops and waiting requests
  remain.

On Linux, aborting the FUSE connection is the reliable last-resort escape for a
wedged daemon. On macOS, forced unmount and provider-specific timeout/eject
behavior are the last resort; this must be documented as weaker than a daemon
deadline guarantee.

### Hang Classes

The reliability architecture prevents or contains several classes of hangs, but
it cannot make every kernel/provider failure recoverable from inside the daemon.

| Hang class                                                          | Prevented by this design?        | Containment                                                                                                                                                             |
| ------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend promise never resolves                                      | Yes                              | Request deadlines, mutation timeouts, and connection degraded mode reply with errno instead of waiting forever.                                                         |
| Deadlock caused by reverse invalidation during a pending FUSE reply | Yes                              | Keep invalidation deferred until pending replies drain; fall back to short TTLs when notify is unsafe or unsupported.                                                   |
| Unbounded write/rebuild backlog                                     | Yes                              | Bounded mutation/rebuild queues and explicit timeout/error outcomes.                                                                                                    |
| Transport disconnect after a started mutation                       | Partially                        | New writes fail fast while disconnected; started operations become known failure or timed-out unknown and are not auto-replayed.                                        |
| Daemon event loop still alive but request progress stops            | Partially                        | Supervisor detects heartbeat/request-progress mismatch and aborts/unmounts externally.                                                                                  |
| Deno process blocked inside a native libfuse/provider call          | Not from inside the process      | External supervisor must force unmount/abort/kill. Consider isolating riskier FFI/session work in an expendable child process if this recurs.                           |
| Kernel/provider task wedges and does not return to userspace        | Not by daemon architecture alone | Linux fusectl abort may release waiters; macOS depends on provider forced unmount/eject behavior and may require process kill, force unmount, or reboot in worst cases. |

Therefore the product guarantee should be phrased as two layers:

1. **Daemon-level guarantee:** if the FUSE daemon remains schedulable and can
   call reply functions, every request reaches data or errno by its deadline.
2. **Containment guarantee:** if the daemon or provider stops making progress,
   an external supervisor detects it and attempts platform-specific abort,
   unmount, and process cleanup within a bounded wall-clock interval.

If experiments still produce unkillable kernel waits, the next architecture step
is stronger process isolation: run the libfuse session in a small supervised
child whose only job is kernel/FUSE I/O, keep backend state and operation logs
in the parent or a separate durable process, and treat child replacement/remount
as the recovery path. That adds IPC complexity, so it should be triggered by
real provider wedges rather than used as the first implementation step.

## Observability

Extend `.status` before changing behavior so experiments are visible:

```json
{
  "requests": {
    "inFlight": 0,
    "completed": 0,
    "timedOut": 0,
    "lastTimeoutAt": null
  },
  "mutations": {
    "queued": 0,
    "inFlight": 0,
    "succeeded": 0,
    "failed": 0,
    "unknown": 0,
    "perCellQueueMax": 0
  },
  "connection": {
    "state": "online",
    "lastError": null,
    "reconnectAttempts": 0
  },
  "deadlines": {
    "cellWriteMs": 30000,
    "handlerMs": 30000,
    "sourceWriteMs": 60000
  }
}
```

The existing write stats and CFC writeback counts should remain, but operation
IDs and unknown outcomes need first-class counters so agents and humans can tell
the difference between success, known failure, and timed-out unknown state.

## Rollout Plan

1. **Document and instrument current behavior.** Add request/mutation counters,
   deadline constants, and status fields without changing semantics.
2. **Extract request slots.** Centralize exactly-once replies and timeout paths
   in `mod.ts`; add tests for reply races using fake callbacks where possible.
3. **Add mutation coordinator for handle writes.** Keep `write(2)` as
   buffer-copy acknowledgment, but make `flush` and `fsync` wait for commit or
   return errno.
4. **Move namespace mutations behind the coordinator.** Stop optimistic shared
   tree updates for create/mkdir/unlink/rmdir/rename/symlink; update or
   invalidate the tree after backend success.
5. **Integrate CFC writeback.** Use existing prepare/finalize persistence and
   reconciliation inside the operation FSM, including timeout and
   stale-generation status.
6. **Add degraded-mode gates.** New writes fail fast while disconnected or
   reconciling; cached reads continue where safe.
7. **Split supervisor from FUSE child.** Teach `cf fuse mount --background` to
   run a Deno supervisor process that does not load libfuse, then spawn a Deno
   FUSE child that owns the mount, heartbeat, and status stream.
8. **Add watchdog escalation.** The supervisor monitors heartbeat/status and
   performs platform-appropriate graceful unmount, abort/force-unmount,
   process-group kill, and restart.
9. **Escalate to Rust sidecar only if needed.** If the Deno FFI child remains
   fragile after the process split, replace the child with a Rust sidecar binary
   while keeping the same supervisor/watchdog shape.

## Test Plan

- Unit-test request slot `replyOnce`, timeout, and interrupt races.
- Unit-test mutation coordinator ordering, per-cell serialization, queue
  saturation, and unknown timeout classification.
- Extend `handles.test.ts` for flush/release dedupe and commit-confirmed errors.
- Extend `cell-bridge.test.ts` for disconnected/read-only transitions and
  reconnect gating before writes resume.
- Extend `cfc-writeback.test.ts` for operation FSM integration with stale,
  malformed, missing, committed, failed, and timed-out prepare/finalize paths.
- Add fault-injection tests with never-resolving `cell.set()`, rejected backend
  writes, late success after timeout, transport closed, and subscription storms.
- Add platform smoke tests that wrap shell commands in `timeout` and verify they
  terminate with data or errno rather than hanging.

## Non-Goals

- Replacing the Deno/libfuse implementation with Rust or a second daemon.
- Making local-ack/offline queueing the default filesystem behavior.
- Automatically retrying non-idempotent handler invocations.
- Treating `user.commonfabric.cfc.*` as trusted enforcement input.
- Guaranteeing recovery from kernel/provider hard lockups without an external
  supervisor or forced unmount path.

## Open Questions

1. What backend primitive is the canonical commit/acceptance boundary for cell
   writes: `cell.set()` resolution, `manager.synced()`, subscription
   observation, or a new write receipt?
2. Should namespace mutations update the nearest common parent value in one cell
   write to avoid partial copy/delete behavior?
3. What operation ID or idempotency mechanism is needed for safe retries of cell
   writes, source updates, and future handler invocation contracts?
4. Which deadline defaults should be user-configurable, and which should be hard
   package constants?
5. How should `.status` expose detailed operation records without leaking CFC or
   transcript-sensitive metadata?

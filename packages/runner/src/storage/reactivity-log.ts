import { normalizeCellScope } from "../scope.ts";
import type {
  Activity,
  IMemorySpaceAddress,
  Metadata,
  StorageTransactionRejected,
  TransactionReactivityLog,
} from "./interface.ts";

const ignoreReadForSchedulingMarker: unique symbol = Symbol(
  "ignoreReadForSchedulingMarker",
);

// A read tagged with this marker is still recorded for CFC/scheduling, but
// carries NO value-equality concurrency precondition: read() does not mark its
// document `validated` (so the client validate()/claim() pass skips it), and
// buildReads DOWNGRADES it — rather than dropping the read outright, it replaces
// it with a nonRecursive existence read at the cell's PARENT path (the
// structural target threaded from handleCellSet). Set transaction-wide
// by the UI-input blind-leaf-write mode (see markUiInputBlindWriteTx) so a scalar
// `$value` overwrite is a last-write-wins write on its leaf value (removing the
// own-write-race "stale confirmed read" conflict: a write to the cell's own
// value sits below the parent read, so TIER-2 nonRecursive overlap does not
// fire) while still failing fast on a concurrent WHOLE-DOC delete/replace
// (TIER-1 set/delete is path-blind) or a reshape of the parent or any ancestor
// (TIER-2 fires at-or-above the read path) — a clean ConflictError instead of a
// raw "missing path" throw at patch read-materialization. Orthogonal to
// scheduling: reactivity/subscriptions are unaffected (only ignoreReadForScheduling
// gates those).
const ignoreReadForCommitMarker: unique symbol = Symbol(
  "ignoreReadForCommitMarker",
);

const markReadAsAttemptedWriteMarker: unique symbol = Symbol(
  "markReadAsAttemptedWriteMarker",
);

const allowMutableTransactionReadMarker: unique symbol = Symbol(
  "allowMutableTransactionReadMarker",
);

const internalVerifierReadMarker: unique symbol = Symbol(
  "internalVerifierReadMarker",
);

const linkResolutionProbeMarker: unique symbol = Symbol(
  "linkResolutionProbeMarker",
);

const dereferenceResolutionProbeMarker: unique symbol = Symbol(
  "dereferenceResolutionProbeMarker",
);

const mergeableOpReadMarker: unique symbol = Symbol(
  "mergeableOpReadMarker",
);

const writeDestinationReadMarker: unique symbol = Symbol(
  "writeDestinationReadMarker",
);

export const ignoreReadForScheduling: Metadata = {
  [ignoreReadForSchedulingMarker]: true,
};

export const ignoreReadForCommit: Metadata = {
  [ignoreReadForCommitMarker]: true,
};

export const markReadAsAttemptedWrite: Metadata = {
  [markReadAsAttemptedWriteMarker]: true,
};

export const allowMutableTransactionRead: Metadata = {
  [allowMutableTransactionReadMarker]: true,
};

export const internalVerifierRead: Metadata = {
  [internalVerifierReadMarker]: true,
};

/**
 * Runtime-owned prepare reads whose internal classification is permanent.
 * Native journals seal records carrying this exact metadata object and can
 * omit them from candidate consumed-read scans while retaining the full log.
 */
export const stableInternalVerifierRead: Metadata = Object.freeze({
  ...ignoreReadForScheduling,
  ...internalVerifierRead,
});

/**
 * A pending output reused by a write still needs its publication accepted.
 * The shared identity selects this commit-only read for wave acceptance and
 * foreign-space handoff without classifying ordinary verifier probes as writes.
 */
export const pendingWriteElisionRead: Metadata = {
  ...ignoreReadForScheduling,
  ...internalVerifierRead,
};

/**
 * Marks the "is there a link here?" probe reads issued by link resolution.
 * They stay in the journal (reactivity must re-resolve when a link appears
 * or changes), and flow-label derivation classifies them as `followRef`
 * observations (observation classes, C0 §4): a probe consumes the pointer's
 * own label (link-origin / `observes:"followRef"` entries) but never the
 * target's content label — that still arrives only when something actually
 * reads the target's value (SC-8 / blind-passing).
 */
export const linkResolutionProbe: Metadata = {
  [linkResolutionProbeMarker]: true,
};

/**
 * Marks a link probe issued inside the resolver that follows links on behalf
 * of a content read. The probe itself is runtime machinery; the target read is
 * the observation and is checked independently.
 */
export const dereferenceResolutionProbe: Metadata = {
  ...linkResolutionProbe,
  [dereferenceResolutionProbeMarker]: true,
};

/**
 * Marks the reads a mergeable write (push / addUnique / increment / the keyed
 * ops) issues as part of building its own write — the value it reads to compute
 * the change. The commit's read-set builder drops these (and the write-target
 * attempted-writes and the cfc label) from conflict detection so the op merges,
 * while a handler's OWN explicit read of the same cell is left in place, so a
 * conditional mergeable write still conflicts-and-retries. Does not affect
 * scheduling.
 */
export const mergeableOpRead: Metadata = {
  [mergeableOpReadMarker]: true,
};

/**
 * Marks the reads the write machinery makes of the region it is about to
 * write: the stream-marker probe that chooses between an event send and a
 * stored write, and the diff's read of each destination path. Each answer
 * decides how and whether to write, never what is written, and where a
 * stored link sends the write somewhere else the walk reads that slot again
 * without this marker. CFC flow-label derivation excludes these from the
 * transaction's join (spec §18.6.2,
 * `docs/specs/cfc-write-destination-reads.md`). Scheduling, conflict
 * detection and the attempted-write record are unaffected, and the same
 * stream-marker probe made outside the write path carries no marker.
 */
export const writeDestinationRead: Metadata = {
  [writeDestinationReadMarker]: true,
};

export function isReadIgnoredForScheduling(meta?: Metadata): boolean {
  return meta?.[ignoreReadForSchedulingMarker] === true;
}

export function isReadIgnoredForCommit(meta?: Metadata): boolean {
  return meta?.[ignoreReadForCommitMarker] === true;
}

// Rejection listeners, registered per inner transaction (CT-1950). A
// rejected commit's promise resolves only after finalizeRejection's
// read-repair gate — the caller's retry needs the repaired base — but the
// commit's FATE is sealed the moment the rejection is received, and the
// verdict-gated effect layer (verdict callbacks, outbox clearing) must not
// wait out the repair round trip; commit callbacks ride the promise and DO
// wait. The transaction registers its verdict resolver at commit() entry;
// the push path notifies every contributing source at rejection receipt,
// and finalizeRejection covers the cascade paths. Rejections only: an
// accept does not seal a multi-space commit's aggregate fate, so accepts
// keep resolving the verdict with the final result.
const commitRejectionListeners = new WeakMap<
  object,
  (rejection: StorageTransactionRejected) => void
>();

export function registerCommitRejectionListener(
  tx: object,
  listener: (rejection: StorageTransactionRejected) => void,
): void {
  commitRejectionListeners.set(tx, listener);
}

export function notifyCommitRejected(
  tx: object,
  rejection: StorageTransactionRejected,
): void {
  const listener = commitRejectionListeners.get(tx);
  if (listener !== undefined) {
    commitRejectionListeners.delete(tx);
    listener(rejection);
  }
}

// Fan-out coverage waits, recorded per transaction (CT-1950). The push path
// resolves its result at the server verdict and records the parked
// application's promise here; the transaction layer drains the record so
// that its commit() promise resolves only once the subscribed view reflects
// the committed write. The split exists so post-commit effects gated on
// durability alone (verdict callbacks, the outbox flush) can hook the
// verdict instead of inheriting the fan-out window.
const coverageWaits = new WeakMap<object, Promise<void>[]>();

export function recordCoverageWait(tx: object, wait: Promise<void>): void {
  const waits = coverageWaits.get(tx);
  if (waits === undefined) {
    coverageWaits.set(tx, [wait]);
  } else {
    waits.push(wait);
  }
}

export function takeCoverageWaits(tx: object): Promise<void>[] {
  const waits = coverageWaits.get(tx);
  if (waits === undefined) {
    return [];
  }
  coverageWaits.delete(tx);
  return waits;
}

const uiInputBlindWriteTxs = new WeakSet<object>();
const durableReadTxs = new WeakSet<object>();

/** Iterates a transaction and its wrappers once each. */
export function* transactionLayers(tx: object): Generator<object> {
  let current: object | undefined = tx;
  const seen = new Set<object>();
  while (current && !seen.has(current)) {
    seen.add(current);
    yield current;
    current = (current as { tx?: object }).tx;
  }
}

/**
 * Transaction-level UI-input "blind leaf overwrite" mode. handleCellSet marks
 * the transaction around a scalar `$value` set (and unmarks before
 * prepareTxForCommit, so CFC boundary-commit read-then-writes keep their
 * preconditions); while marked, read() tags every read with `ignoreReadForCommit`
 * and skips `validated`, so the write carries no value-equality precondition on
 * its leaf (last-write-wins, which is correct for raw scalar UI input) — buildReads
 * downgrades the tagged reads to a single nonRecursive entity-root existence read,
 * which still catches a concurrent whole-doc delete/replace. Read-modify-write
 * and structured (array/object) writes are NOT marked and retain compare-and-set.
 * Both the wrapper and the inner storage transaction(s) are marked, since
 * read()/buildReads run on the inner one; the chain walk tolerates extra wrapper
 * layers.
 */
export function markUiInputBlindWriteTx(tx: object): void {
  for (const layer of transactionLayers(tx)) uiInputBlindWriteTxs.add(layer);
}
export function unmarkUiInputBlindWriteTx(tx: object): void {
  for (const layer of transactionLayers(tx)) uiInputBlindWriteTxs.delete(layer);
}
export function isUiInputBlindWriteTx(tx: object): boolean {
  return uiInputBlindWriteTxs.has(tx);
}

/**
 * Marks an authored direct-capability transaction to read the durable replica
 * view. Its values and commit basis both exclude process-local speculation,
 * which cannot be named by a commit sent to the server.
 */
export function markDurableReadTx(tx: object): void {
  for (const layer of transactionLayers(tx)) durableReadTxs.add(layer);
}

export function isDurableReadTx(tx: object): boolean {
  for (const layer of transactionLayers(tx)) {
    if (durableReadTxs.has(layer)) return true;
  }
  return false;
}

const lazyMaterializationTxs = new WeakSet<object>();

/**
 * Lazy materialization: a marked transaction hands a reader views that resolve
 * each path as it is touched, rather than a value built in one pass before the
 * reader looks at any of it.
 *
 * The mark also decides how a view treats the transaction it was made against.
 * Unmarked, a query-result proxy is a standing handle: it resolves the
 * transaction on every access, so a holder keeps reading current state after
 * that transaction has finished — which long-lived consumers depend on, an LLM
 * tool call dispatched later and a SQLite result flushed post-commit among
 * them. Marked, a view keeps the transaction it was created with, so the value
 * it describes stays the value that was there when it was taken, and reading
 * after that transaction finishes throws rather than quietly reading from
 * committed state.
 *
 * Nothing outside the mark changes, so an unmarked transaction reads exactly as
 * it did before lazy materialization existed. Marked on the same wrapper chain
 * as the marks above, so a wrapper and the transaction it wraps read alike.
 */
export function markLazyMaterializationTx(tx: object): void {
  for (const layer of transactionLayers(tx)) lazyMaterializationTxs.add(layer);
}
export function unmarkLazyMaterializationTx(tx: object): void {
  for (const layer of transactionLayers(tx)) {
    lazyMaterializationTxs.delete(layer);
  }
}
export function isLazyMaterializationTx(tx: object): boolean {
  // Walk the chain rather than testing the object: a wrapper built over a
  // transaction that was marked earlier has never been marked itself, and must
  // still report the mark of what it wraps.
  for (const layer of transactionLayers(tx)) {
    if (lazyMaterializationTxs.has(layer)) return true;
  }
  return false;
}

// A refusal recorded on the transaction, so it survives being caught. A reader
// can swallow a `SchemaMismatchError` — its own `try`/`catch`, or an `await`
// that discards the rejection — and still hand back a plausible-looking result.
// The runner reads the mark after the body returns and disposes of the run as
// an argument that did not resolve either way.
const schemaRefusals = new WeakMap<object, unknown>();

export function noteSchemaRefusalTx(tx: object, refusal: unknown): void {
  for (const layer of transactionLayers(tx)) {
    if (!schemaRefusals.has(layer)) schemaRefusals.set(layer, refusal);
  }
}

export function takeSchemaRefusalTx(tx: object): unknown {
  for (const layer of transactionLayers(tx)) {
    const refusal = schemaRefusals.get(layer);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

// Only this refusal, and only where it is the one recorded: a view that catches
// a mismatch it asked for is the one clearing it, and a different refusal held
// on the same transaction is somebody else's and still owed to the runner.
export function clearSchemaRefusalTx(tx: object, refusal: unknown): void {
  for (const layer of transactionLayers(tx)) {
    if (schemaRefusals.get(layer) === refusal) schemaRefusals.delete(layer);
  }
}

// Renderer-input (user-keystroke `$value`) provenance for timing-mitigation
// cell-flip shaping (plan B, channels 4/5). Unlike the blind-write mark above —
// which is cleared before commit — this one must SURVIVE to commit time so the
// scheduler can recognize a renderer-input change at the storage-notification
// choke point (via `notification.source`) and shape the resulting subscriber
// wake. It is a superset marker: set on the same UI-input writes, never cleared.
// See docs/specs/sandboxing/TIMING_SIDE_CHANNELS.md.
const rendererInputTxs = new WeakSet<object>();

export function markRendererInputTx(tx: object): void {
  for (const layer of transactionLayers(tx)) rendererInputTxs.add(layer);
}
export function isRendererInputTx(tx: object): boolean {
  return rendererInputTxs.has(tx);
}

// The structural existence/shape precondition for a blind UI-input write: the
// PARENT address of the cell being set. handleCellSet computes it from the cell's
// resolved write link — where the LOGICAL write path is known — because buildReads
// only sees the optimized, sometimes element-level diff and cannot recover it.
// Stored persistently (NOT cleared by unmark, unlike the blind mark) so buildReads
// can read it at commit time and emit one nonRecursive read there: that conflicts
// with a concurrent whole-doc delete (TIER-1, path-blind) and with a reshape of
// the parent or any ancestor (TIER-2 nonRecursive overlap fires at-or-above the
// read path) as a clean ConflictError, while a write to the cell's own subtree
// (its value, including array elements) sits BELOW the parent and does not
// conflict — keeping the own-write race conflict-free.
export type BlindStructuralTarget = {
  id: string;
  space: string;
  scope?: unknown;
  // The cell's parent path (the leaf path with its last segment dropped); `[]`
  // for a write at the entity root.
  path: readonly (string | number)[];
};
const blindStructuralTargets = new WeakMap<object, BlindStructuralTarget>();

export function setBlindStructuralTarget(
  tx: object,
  target: BlindStructuralTarget,
): void {
  for (const layer of transactionLayers(tx)) {
    blindStructuralTargets.set(layer, target);
  }
}
export function getBlindStructuralTarget(
  tx: object,
): BlindStructuralTarget | undefined {
  for (const layer of transactionLayers(tx)) {
    const target = blindStructuralTargets.get(layer);
    if (target !== undefined) return target;
  }
  return undefined;
}

export function isReadMarkedAsAttemptedWrite(meta?: Metadata): boolean {
  return meta?.[markReadAsAttemptedWriteMarker] === true;
}

export function isMergeableOpRead(meta?: Metadata): boolean {
  return meta?.[mergeableOpReadMarker] === true;
}

export function isWriteDestinationRead(meta?: Metadata): boolean {
  return meta?.[writeDestinationReadMarker] === true;
}

export function isMutableTransactionReadAllowed(meta?: Metadata): boolean {
  return meta?.[allowMutableTransactionReadMarker] === true;
}

export function isInternalVerifierRead(meta?: Metadata): boolean {
  return meta?.[internalVerifierReadMarker] === true;
}

export function isLinkResolutionProbe(meta?: Metadata): boolean {
  return meta?.[linkResolutionProbeMarker] === true;
}

export function isDereferenceResolutionProbe(meta?: Metadata): boolean {
  return meta?.[dereferenceResolutionProbeMarker] === true;
}

const schedulerDependencyReadMarker: unique symbol = Symbol(
  "schedulerDependencyReadMarker",
);

/**
 * Marks reads performed by the scheduler's dependency seeding
 * (populateDeclaredSchedulerReads and friends): they materialize declared
 * dependencies so the reactivity log covers them for subscriptions, but
 * they are scheduling machinery, not handler consumption (§8.10.1:
 * dependency-discovery reads must not count as consumed inputs). Flow-label
 * derivation excludes them; the action body's own reads carry the taint.
 */
export const schedulerDependencyRead: Metadata = {
  [schedulerDependencyReadMarker]: true,
};

export function isSchedulerDependencyRead(meta?: Metadata): boolean {
  return meta?.[schedulerDependencyReadMarker] === true;
}

const machineryReadMarker: unique symbol = Symbol(
  "machineryReadMarker",
);

/**
 * Marks reads the runtime's op-instantiation/wiring machinery issues while
 * setting operations up or plumbing their results: binding node IO
 * (write-redirect resolution), collecting static redirect write targets,
 * dependency seeding's input/output materialization, result-write plumbing
 * (`sendValueToBinding`), and the list coordinators' container scaffolding
 * (presence probes, slot-identity diffs, `length` during instantiation).
 * Sibling of `schedulerDependencyRead` (§8.10.1: dependency-discovery reads
 * are not consumed inputs) but deliberately NARROWER in effect, and what it
 * excludes depends on what the marked read observed. A marked read that
 * materializes CONTENT still consumes its ordinary labels (link-origin
 * pointer labels, concrete structure/derived entries — exactly what it
 * consumed before templates existed); only runtime-minted `*`-path TEMPLATE
 * consumption is excluded (template-population §3.1/§6). The machinery
 * reading a plumbing container's child paths is the runtime wiring up
 * operations, not an application observing a slot — letting those reads
 * consume membership/slot templates smeared one reconcile's J into the next
 * op's action chain (measured: the phase-B pointwise map suite), which is
 * what kept the generic pure-link mint route disabled in Stage A (the SC-8
 * remainder).
 *
 * A marked read that observed only WHICH REFERENCE sits at a slot consumes
 * nothing at all. §4.6.3's reference-identity row is for a standalone
 * observation — a read the computation made and did something with — and a
 * probe under this marker is the runtime moving a reference from one slot to
 * another. The link write that finishes the move carries the source's label
 * to the destination slot, so the pointer's protection arrives there
 * pointwise; joining it into the flow stamp as well spreads it over
 * everything else the wiring transaction wrote. `forEachFlowObservation` in
 * `cfc/prepare.ts` skips such a probe alongside the ones a dereference trace
 * covers.
 *
 * Stamp discipline: mark ONLY scopes whose every read the machinery itself
 * issues — pattern/handler code must never execute inside a marked scope.
 * Over-marking an application observation under-taints (the forbidden
 * direction); a missed machinery read merely leaves residual over-taint
 * (acceptable, additive-safe).
 *
 * That discipline is what the reference-identity skip above rests on, and the
 * skip is what an over-marked scope now costs. A marked scope whose reads the
 * machinery issues writes the reference onward, and the link write puts the
 * label at the slot that receives it. A marked scope containing an
 * application read that computes plain content from WHICH reference sits at a
 * slot has no such slot to put the label at, so the clause lands nowhere a
 * content read takes it. Before the skip an over-marked probe still consumed
 * the pointer label; now it consumes nothing, so a scope whose contents are
 * not entirely the runtime's own must not carry this marker.
 */
export const machineryRead: Metadata = {
  [machineryReadMarker]: true,
};

export function isMachineryRead(meta?: Metadata): boolean {
  return meta?.[machineryReadMarker] === true;
}

const excludeReadFromConflictMarker: unique symbol = Symbol(
  "excludeReadFromConflictMarker",
);

/**
 * Marks reads that resolve a REFERENCE rather than consume a value, so they must
 * NOT be recorded as commit-time conflict dependencies. Building an asCell
 * argument follows its write-redirect link (followPointer reads the target's
 * shape), but the handler depends on the referent's VALUE only if it reads
 * THROUGH the cell in its body — those reads are recorded separately and stay
 * unmarked. The marked materialization reads remain in the journal for
 * reactivity; only buildReads (the conflict set) excludes them. This is the same
 * mechanism #4199 applied to Cell.set's link resolution, here applied to the
 * argument-materialization seam where the probe's over-conflict actually lives.
 * Orthogonal to schedulerDependencyRead and attemptedWrite.
 */
export const excludeReadFromConflict: Metadata = {
  [excludeReadFromConflictMarker]: true,
};

export function isReadExcludedFromConflict(meta?: Metadata): boolean {
  return meta?.[excludeReadFromConflictMarker] === true;
}

export function reactivityLogFromActivities(
  activities: Iterable<Activity>,
): TransactionReactivityLog {
  const log: TransactionReactivityLog = {
    reads: [],
    shallowReads: [],
    writes: [],
  };
  for (const activity of activities) {
    if ("read" in activity && activity.read) {
      const ignored = isReadIgnoredForScheduling(activity.read.meta);
      const attempted = isReadMarkedAsAttemptedWrite(activity.read.meta);
      if (ignored && !attempted) continue;
      const address: IMemorySpaceAddress = {
        space: activity.read.space,
        scope: normalizeCellScope(activity.read.scope),
        id: activity.read.id,
        path: [...activity.read.path],
      };
      if (attempted) {
        log.attemptedWrites ??= [];
        log.attemptedWrites.push(address);
      }
      if (ignored) continue;
      if (activity.read.nonRecursive === true) {
        log.shallowReads.push(address);
      } else {
        log.reads.push(address);
      }
      continue;
    }
    if ("write" in activity && activity.write) {
      log.writes.push({
        space: activity.write.space,
        scope: normalizeCellScope(activity.write.scope),
        id: activity.write.id,
        path: [...activity.write.path],
      });
    }
  }
  return log;
}

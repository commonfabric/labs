/**
 * Retention of a serving runtime across an idle park (serving-loop.md §1,
 * "Parking"). An idle park releases the lease and stops the loop; the
 * runtime, fenced so that it commits nothing, waits here for the space's
 * next tenure, which serves with it when nothing has touched the space in
 * between. The `ExecutorHost` owns the retained instances and decides how
 * long each is kept.
 */

import type { PostCommitSideEffect } from "../cfc/types.ts";
import type { Runtime } from "../runtime.ts";
import type {
  CommitError,
  IExtendedStorageTransaction,
  IStorageNotification,
  MemorySpace,
  Result,
  StorageNotification,
  TransactionSealDestination,
  Unit,
} from "../storage/interface.ts";
import { abandonRunnerAcceptanceEffects } from "./runner-acceptance.ts";

/** Why a parked runtime can no longer be handed to a successor tenure. */
export type ParkedRuntimeTaint =
  /** Something in the runtime tried to commit while it was parked. */
  | "write"
  /** Its storage took in a change while it was parked. */
  | "storage";

/** The runtime a tenure hands over when it parks idle, and how to end it. */
export type ParkedRuntimeHandle = {
  runtime: Runtime;

  /** Disposes the runtime and whatever its factory built beside it. */
  dispose: () => Promise<void>;

  /** The space the runtime served. */
  space: MemorySpace;

  /** The space's store head (`Engine.serverSeq()`) when its tenure parked. */
  head: number;
};

/**
 * A serving runtime kept after its tenure parked idle
 * (serving-loop.md §1, "Parking"), so that the space's next tenure can
 * serve with it instead of building a fresh one — which would recompile
 * and re-evaluate the space's patterns, restart every demanded piece, and
 * re-sync each piece's documents.
 *
 * While parked the runtime is fenced: every transaction it closes is
 * refused at a seal destination that commits nothing, and a storage
 * subscription watches for anything its replica takes in. Either one
 * taints it, and a tainted runtime is never handed on. {@link take} hands
 * it on only while the store head is still the one its tenure parked at,
 * so the successor starts from exactly the state the parked tenure held
 * over exactly the store it last saw. Anything else — a write attempted,
 * a change delivered, a commit landed — and the successor builds fresh,
 * as it would with no retention at all.
 */
export class ParkedServingRuntime {
  #handle: ParkedRuntimeHandle | undefined;
  #taint: ParkedRuntimeTaint | undefined;
  #onTainted: ((taint: ParkedRuntimeTaint) => void) | undefined;
  #watching = true;

  readonly #fence: TransactionSealDestination = {
    seal: (_tx: IExtendedStorageTransaction) => {
      this.noteRefusedWrite();
      return Promise.resolve<Result<Unit, CommitError>>({
        error: {
          name: "StorageTransactionAborted",
          message: "the serving runtime is parked: its space's tenure has " +
            "ended and released the execution lease, so nothing it closes " +
            "commits (serving-loop.md §1, Parking)",
          reason: new Error(PARKED_RUNTIME_WRITE_REFUSED),
        },
      });
    },
    deferSealedEffects: (
      _tx: IExtendedStorageTransaction,
      effects: readonly PostCommitSideEffect[],
    ) => {
      abandonRunnerAcceptanceEffects(effects, PARKED_RUNTIME_WRITE_REFUSED);
      return true;
    },
  };

  readonly #watcher: IStorageNotification = {
    next: (notification: StorageNotification) => {
      if (!this.#watching) return { done: true };
      if (carriesChange(notification)) this.#tainted("storage");
      return undefined;
    },
  };

  /**
   * Constructs an instance which fences `handle.runtime`: installs the
   * refusing seal destination and the storage watcher. The runtime must
   * have no seal destination installed, which is the state a parked
   * tenure leaves it in.
   */
  constructor(handle: ParkedRuntimeHandle) {
    this.#handle = handle;
    handle.runtime.installSealDestination(this.#fence);
    handle.runtime.storageManager.subscribe(this.#watcher);
  }

  /** The space the runtime served. */
  get space(): MemorySpace | undefined {
    return this.#handle?.space;
  }

  /**
   * Called once, synchronously, when the runtime becomes tainted. It runs
   * inside whatever tainted the runtime — a storage notification, a seal —
   * so a callback that disposes the runtime defers that work.
   */
  set onTainted(callback: ((taint: ParkedRuntimeTaint) => void) | undefined) {
    this.#onTainted = callback;
  }

  /**
   * Records that a write from this runtime was refused because its tenure
   * had parked — at the fence, or at the parked tenure's own seal
   * destination for a transaction opened before the park.
   */
  noteRefusedWrite(): void {
    this.#tainted("write");
  }

  /**
   * Hands the runtime to a successor tenure when it is untainted and
   * `head` — the space's store head now — is the head its tenure parked
   * at; returns `undefined` otherwise, leaving the runtime for
   * {@link dispose}. A runtime handed on is unfenced and no longer
   * watched, and this instance holds nothing afterwards.
   */
  take(
    head: number,
  ): Pick<ParkedRuntimeHandle, "runtime" | "dispose"> | undefined {
    const handle = this.#handle;
    if (handle === undefined || this.#taint !== undefined) return undefined;
    if (head !== handle.head) return undefined;
    this.#handle = undefined;
    this.#stopWatching(handle.runtime);
    handle.runtime.clearSealDestination();
    return { runtime: handle.runtime, dispose: handle.dispose };
  }

  /**
   * Disposes the runtime unless it was handed on. The fence stays
   * installed through the dispose, so nothing teardown closes commits.
   */
  async dispose(): Promise<void> {
    const handle = this.#handle;
    if (handle === undefined) return;
    this.#handle = undefined;
    this.#stopWatching(handle.runtime);
    await handle.dispose();
  }

  /**
   * Detaches the storage watcher. A manager without `unsubscribe()` drops it
   * at its next notification instead, which the watcher answers as done.
   */
  #stopWatching(runtime: Runtime): void {
    this.#watching = false;
    runtime.storageManager.unsubscribe?.(this.#watcher);
  }

  /** Records the first taint of a runtime still held, and reports it. */
  #tainted(taint: ParkedRuntimeTaint): void {
    if (this.#taint !== undefined || this.#handle === undefined) return;
    this.#taint = taint;
    this.#onTainted?.(taint);
  }
}

/** The reason carried by a write refused at a parked runtime's fence. */
export const PARKED_RUNTIME_WRITE_REFUSED = "parked-runtime-write-refused";

/**
 * Whether `notification` reports anything the replica took in: a reset or
 * a revert always does, and every other kind does when it carries at
 * least one change.
 */
function carriesChange(notification: StorageNotification): boolean {
  if (notification.type === "reset" || notification.type === "revert") {
    return true;
  }
  for (const _change of notification.changes) return true;
  return false;
}

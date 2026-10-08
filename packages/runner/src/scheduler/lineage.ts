import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { QueuedEvent } from "./types.ts";

export type OriginStatus = "pending" | "confirmed" | "failed";

interface OriginRecord {
  status: OriginStatus;
  events: Set<QueuedEvent>;
  pieceStops: Array<() => void>;

  /** Whether the scheduler runs the origin's work again once it fails. */
  rerun: boolean;
}

/**
 * Speculation lineage (scheduler-v2 §7.6 / I10): tracks work launched by a
 * transaction so it can be released on commit success or cancelled on
 * failure. Records are created lazily on first launch and removed when the
 * origin settles and its launches are flushed.
 */
export class SpeculationLineage {
  #byOrigin = new Map<IExtendedStorageTransaction, OriginRecord>();

  /** The origins whose work the scheduler runs again once they fail. */
  #runsAgain = new WeakSet<IExtendedStorageTransaction>();

  readonly #hooks: {
    /**
     * Drop and settle a not-yet-dispatched event from the queue, logging
     * `reason` at debug rather than as a warning when `quiet`.
     */
    dropQueuedEvent: (
      event: QueuedEvent,
      reason: string,
      quiet: boolean,
    ) => void;

    /** Wake the scheduler (parked cross-space events become ready). */
    queueExecution: () => void;

    onError: (error: unknown) => void;
  };

  constructor(
    hooks: {
      /**
       * Drop and settle a not-yet-dispatched event from the queue, logging
       * `reason` at debug rather than as a warning when `quiet`.
       */
      dropQueuedEvent: (
        event: QueuedEvent,
        reason: string,
        quiet: boolean,
      ) => void;

      /** Wake the scheduler (parked cross-space events become ready). */
      queueExecution: () => void;

      onError: (error: unknown) => void;
    },
  ) {
    this.#hooks = hooks;
  }

  #recordFor(origin: IExtendedStorageTransaction): OriginRecord {
    let record = this.#byOrigin.get(origin);
    if (!record) {
      // A read-only transaction (cell.send() forwards its tx as the origin,
      // which in read contexts is runtime.readTx()) never commits: it is not
      // a speculative launch. Treat it as confirmed — "pending" would park
      // cross-space events forever and addCommitCallback() throws on it.
      const originStatus = origin.isReadOnly?.()
        ? "done"
        : origin.status().status;
      record = {
        status: originStatus === "done"
          ? "confirmed"
          : originStatus === "error"
          ? "failed"
          : "pending",
        events: new Set(),
        pieceStops: [],
        rerun: false,
      };
      this.#byOrigin.set(origin, record);
      if (record.status !== "pending") return record;

      origin.addCommitCallback((_tx, result) => {
        const settled = this.#byOrigin.get(origin);
        if (!settled) return;
        settled.status = result.error ? "failed" : "confirmed";
        if (result.error) {
          // An origin run again sends its follow-ups again under the re-run's
          // own transaction, so dropping this attempt's is routine.
          for (const event of settled.events) {
            try {
              this.#hooks.dropQueuedEvent(
                event,
                settled.rerun
                  ? `Event dropped: speculative origin failed and runs again before ${event.id} dispatched`
                  : `Event dropped: speculative origin failed before ${event.id} dispatched`,
                settled.rerun,
              );
            } catch (error) {
              this.#hooks.onError(error);
            }
          }
          settled.events.clear();
          for (const stop of settled.pieceStops) {
            try {
              stop();
            } catch (error) {
              this.#hooks.onError(error);
            }
          }
          settled.pieceStops.length = 0;
          this.#byOrigin.delete(origin);
        } else {
          // Success: compensation is moot, but the EVENTS must stay
          // registered — still-queued descendants (e.g. cross-space parked
          // ones) keep asking originStatus() until they dispatch and
          // release(). Clearing them here would let the first release()
          // delete the record and strand the rest.
          settled.pieceStops.length = 0;
          if (settled.events.size === 0) {
            this.#byOrigin.delete(origin);
          }
        }
        this.#hooks.queueExecution();
      });
    }
    return record;
  }

  recordEvent(origin: IExtendedStorageTransaction, event: QueuedEvent): void {
    this.#recordFor(origin).events.add(event);
  }

  recordPieceStop(origin: IExtendedStorageTransaction, stop: () => void): void {
    this.#recordFor(origin).pieceStops.push(stop);
  }

  /**
   * Notes that the scheduler runs `origin`'s work again once `origin` fails,
   * so the follow-up events its failure drops are logged at debug rather than
   * as warnings. Called before the settle callback that does the dropping:
   * ahead of an abort to run again, and from the origin's settled outcome
   * ahead of a stale-basis retry. {@link runsAgain} reports the note
   * afterwards, for a
   * follow-up that dispatched before its origin failed.
   */
  noteRerun(origin: IExtendedStorageTransaction): void {
    this.#runsAgain.add(origin);
    const record = this.#byOrigin.get(origin);
    if (record) record.rerun = true;
  }

  /**
   * Whether {@link noteRerun} noted that the scheduler runs `origin`'s work
   * again once it fails.
   */
  runsAgain(origin: IExtendedStorageTransaction): boolean {
    return this.#runsAgain.has(origin);
  }

  /** Called when an event is dispatched or dropped. */
  release(origin: IExtendedStorageTransaction, event: QueuedEvent): void {
    const record = this.#byOrigin.get(origin);
    if (!record) return;
    record.events.delete(event);
    if (
      record.status !== "pending" && record.events.size === 0 &&
      record.pieceStops.length === 0
    ) {
      this.#byOrigin.delete(origin);
    }
  }

  originStatus(origin: IExtendedStorageTransaction): OriginStatus {
    return this.#byOrigin.get(origin)?.status ??
      // Unknown origin ⇒ no active lineage record remains. A still-queued
      // event with an already-failed origin creates a failed record and is
      // dropped before release; successful origins keep the record until
      // release(). This fallback is therefore after settlement/release — and
      // must be "confirmed": "pending" would park a cross-space event forever,
      // since the commit callback that wakes it has already fired.
      "confirmed";
  }
}

import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { QueuedEvent } from "./types.ts";

export type OriginStatus = "pending" | "confirmed" | "failed";

interface OriginRecord {
  status: OriginStatus;
  events: Set<QueuedEvent>;
  pieceStops: Array<() => void>;
}

/**
 * Speculation lineage (scheduler-v2 §7.6 / I10): tracks work launched by a
 * transaction so it can be released on commit success or cancelled on
 * failure. Records are created lazily on first launch and removed when the
 * origin settles and its launches are flushed.
 */
export class SpeculationLineage {
  #byOrigin = new Map<IExtendedStorageTransaction, OriginRecord>();

  readonly #hooks: {
    /** Drop and settle a not-yet-dispatched event from the queue. */
    dropQueuedEvent: (event: QueuedEvent, reason: string) => void;

    /** Wake the scheduler (parked cross-space events become ready). */
    queueExecution: () => void;

    onError: (error: unknown) => void;
  };

  constructor(
    hooks: {
      /** Drop and settle a not-yet-dispatched event from the queue. */
      dropQueuedEvent: (event: QueuedEvent, reason: string) => void;

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
      };
      this.#byOrigin.set(origin, record);
      if (record.status !== "pending") return record;

      origin.addCommitCallback((_tx, result) => {
        const settled = this.#byOrigin.get(origin);
        if (!settled) return;
        settled.status = result.error ? "failed" : "confirmed";
        if (result.error) {
          for (const event of settled.events) {
            try {
              this.#hooks.dropQueuedEvent(
                event,
                `Event dropped: speculative origin failed before ${event.id} dispatched`,
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

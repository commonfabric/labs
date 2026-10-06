/**
 * A local job's browser host: the channel one job's browser operations
 * travel to the client that shows them, and their results travel back on.
 *
 * A job declares on enqueue that its caller can host a browser, under a
 * profile that admits one. The caller then holds the job's host stream
 * open, on which each operation arrives as a `request` event, and posts
 * each result back naming the operation it answers. The socket's token is
 * the authority, as for every other route: the stream and the results are
 * bound to the job, and only a caller the host let reach the socket can
 * name it.
 *
 * The semantics are the console's (`cf-harness/console/browser-host.ts`):
 * the host answers every operation it is sent, one at a time; when the run
 * withdraws one the host already holds, the stream says so with a
 * `withdraw` event, and the host's answer to it is the acknowledgment — no
 * later operation reaches the host until it arrives. When the job ends the
 * stream says `close`, and anything outstanding settles as `session-ended`.
 *
 * Unlike the console's, the stream is resumable. The caller is usually a
 * relay (the Common Fabric Service fronting a client device), so a dropped
 * stream is a dropped connection rather than a host that went away: the
 * channel outlives it, and the next attach is sent everything still owed —
 * each delivered operation the host has not answered, each withdrawal it has
 * not acknowledged — before the operations that follow. A second attach
 * replaces the first. The host recognizes an operation it already holds by
 * its id.
 *
 * Nothing here waits on a clock. An operation waits until the host answers
 * it, the job ends, or the run aborts it — a hand-off waits for the owner,
 * however long that takes, and a host that never comes back leaves the job
 * waiting until it is cancelled.
 */

import {
  type BrowserHostOperation,
  type BrowserHostResult,
  type HarnessBrowserHost,
  isBrowserHostResult,
} from "@commonfabric/cf-harness/contracts/browser-host";

/** The event an operation for the host arrives under. */
export const LOCAL_BROWSER_HOST_REQUEST_EVENT = "request";

/** The event that withdraws an operation the host holds. */
export const LOCAL_BROWSER_HOST_WITHDRAW_EVENT = "withdraw";

/** The event that tells the host the job is over. */
export const LOCAL_BROWSER_HOST_CLOSE_EVENT = "close";

/** What {@link LocalJobBrowserHost.acceptResult} made of a posted result. */
export type LocalBrowserHostAcceptance =
  | "accepted"
  | "duplicate"
  | "unknown"
  | "invalid";

/** What the job view shows of a host, for inspection. */
export interface LocalBrowserHostView {
  state: "open" | "closed";

  /** Whether a stream is attached now. */
  attached: boolean;

  /** Operations delivered and not yet answered, withdrawn ones included. */
  outstanding: number;

  /** Of those, the ones the run withdrew. */
  withdrawn: number;
}

const encoder = new TextEncoder();

/** Helper for the stream, which writes one server-sent event. */
const frame = (event: string, data: unknown): Uint8Array =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/** One operation delivered to the host and not yet answered. */
interface Outstanding {
  operation: BrowserHostOperation;

  /** Settles the run's call; absent once the run withdrew it. */
  settle?: (result: BrowserHostResult) => void;
}

/** One job's channel to its browser host. */
export class LocalJobBrowserHost implements HarnessBrowserHost {
  /** Operations not yet delivered, in the order the run sent them. */
  readonly #queued = new Map<
    string,
    { operation: BrowserHostOperation; settle: Outstanding["settle"] }
  >();

  /** Operations delivered and not answered, in delivery order. */
  readonly #outstanding = new Map<string, Outstanding>();

  /** Operations answered, so a repeated answer reads as one. */
  readonly #answered = new Set<string>();

  #stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  #ended: string | undefined;
  #nextId = 0;

  /**
   * Sends `operation` to the host and resolves with its answer. Resolves with
   * `session-ended` when the job has ended, or ends while the operation is
   * outstanding. Rejects with the signal's reason when `signal` aborts first,
   * withdrawing the operation.
   */
  perform(
    operation: BrowserHostOperation,
    signal?: AbortSignal,
  ): Promise<BrowserHostResult> {
    if (this.#ended !== undefined) {
      return Promise.resolve({ status: "session-ended", message: this.#ended });
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    const id = String(++this.#nextId);
    return new Promise<BrowserHostResult>((resolve, reject) => {
      const onAbort = () => {
        if (this.#queued.delete(id)) {
          reject(signal?.reason);
          return;
        }
        const outstanding = this.#outstanding.get(id);
        if (outstanding?.settle !== undefined) {
          outstanding.settle = undefined;
          this.#send(LOCAL_BROWSER_HOST_WITHDRAW_EVENT, { id });
        }
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#queued.set(id, {
        operation,
        settle: (result) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(result);
        },
      });
      this.#flush();
    });
  }

  /**
   * The host's stream: everything still owed, then each operation as it is
   * sent. Replaces a stream already attached, which ends. A closed channel's
   * stream says `close` and ends.
   */
  attach(): ReadableStream<Uint8Array> {
    if (this.#ended !== undefined) {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(frame(LOCAL_BROWSER_HOST_CLOSE_EVENT, {}));
          controller.close();
        },
      });
    }
    let mine: ReadableStreamDefaultController<Uint8Array> | undefined;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        mine = controller;
        // A stream whose reader went away has already dropped itself
        // (`cancel`), so the one held is live and closes cleanly.
        const previous = this.#stream;
        this.#stream = controller;
        previous?.close();
        for (const [id, { operation, settle }] of this.#outstanding) {
          controller.enqueue(
            frame(LOCAL_BROWSER_HOST_REQUEST_EVENT, { id, operation }),
          );
          if (settle === undefined) {
            controller.enqueue(
              frame(LOCAL_BROWSER_HOST_WITHDRAW_EVENT, { id }),
            );
          }
        }
        this.#flush();
      },
      cancel: () => {
        // A dropped stream leaves the channel open for the next attach.
        if (this.#stream === mine) this.#stream = undefined;
      },
    });
  }

  /**
   * Hands in the host's answer to operation `id`. The answer to a withdrawn
   * operation acknowledges the withdrawal and lets the next operation reach
   * the host, whatever it holds. A second answer to an answered operation is
   * `duplicate`, and the first stands. An answer for an operation the host was never sent is
   * `unknown`. One that is not a result is `invalid`, and settles the
   * operation as `failed` rather than leaving it waiting.
   */
  acceptResult(id: unknown, result: unknown): LocalBrowserHostAcceptance {
    if (typeof id !== "string") return "unknown";
    if (this.#answered.has(id)) return "duplicate";
    const outstanding = this.#outstanding.get(id);
    if (outstanding === undefined) return "unknown";
    this.#outstanding.delete(id);
    this.#answered.add(id);
    // A withdrawn operation's answer is the acknowledgment, whatever it
    // holds: nobody reads it, as on the console.
    if (outstanding.settle === undefined) {
      this.#flush();
      return "accepted";
    }
    const valid = isBrowserHostResult(result);
    outstanding.settle?.(
      valid ? result : {
        status: "failed",
        message:
          "the browser host answered with something that is not a result",
      },
    );
    this.#flush();
    return valid ? "accepted" : "invalid";
  }

  /**
   * Ends the channel because the job ended: the host is told, its stream
   * closes, and anything outstanding settles as `session-ended`.
   */
  close(): void {
    if (this.#ended !== undefined) return;
    const message = "the job has ended";
    this.#ended = message;
    const settles = [
      ...[...this.#queued.values()].map(({ settle }) => settle),
      ...[...this.#outstanding.values()].map(({ settle }) => settle),
    ];
    this.#queued.clear();
    this.#outstanding.clear();
    for (const settle of settles) {
      settle?.({ status: "session-ended", message });
    }
    this.#send(LOCAL_BROWSER_HOST_CLOSE_EVENT, {});
    this.#stream?.close();
    this.#stream = undefined;
  }

  /** What the job view shows of this channel. */
  view(): LocalBrowserHostView {
    return {
      state: this.#ended === undefined ? "open" : "closed",
      attached: this.#stream !== undefined,
      outstanding: this.#outstanding.size,
      withdrawn:
        [...this.#outstanding.values()].filter(({ settle }) =>
          settle === undefined
        ).length,
    };
  }

  /**
   * Delivers the queued operations, once there is a stream and the host owes
   * no acknowledgment of a withdrawn operation.
   */
  #flush(): void {
    if (this.#stream === undefined) return;
    for (const { settle } of this.#outstanding.values()) {
      if (settle === undefined) return;
    }
    for (const [id, { operation, settle }] of this.#queued) {
      this.#queued.delete(id);
      this.#outstanding.set(id, { operation, settle });
      this.#send(LOCAL_BROWSER_HOST_REQUEST_EVENT, { id, operation });
    }
  }

  /**
   * Writes one event to the attached stream, if any. A stream whose reader
   * went away has dropped itself (`cancel`), and what it missed is replayed
   * on the next attach.
   */
  #send(event: string, data: unknown): void {
    this.#stream?.enqueue(frame(event, data));
  }
}

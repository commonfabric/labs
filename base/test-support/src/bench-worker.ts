/**
 * The near side of a benchmark that measures a crossing to a worker.
 *
 * A benchmark of this shape sends one message, waits for the far side to
 * acknowledge it, and counts the round trip as one iteration. That is what a
 * `Deno.bench()` iteration can measure -- a pipeline of overlapping sends would
 * report throughput while the harness is timing latency -- and it is the shape
 * the connections these benchmarks stand in for actually use.
 *
 * One worker serves a whole run. A fresh one per iteration would measure worker
 * startup, which is milliseconds against the microseconds of a payload and
 * would swamp everything such a benchmark is trying to see.
 *
 * The far side is a module of the benchmark's own, since what it should do with
 * a message is the benchmark's question. What this fixes is the near side:
 * holding one request in flight, settling it against the ack, and failing
 * rather than hanging when the worker cannot answer.
 */

/**
 * What a far side reports. One boolean and, on failure, why.
 *
 * Deliberately this small: a reply carrying any part of what was sent would put
 * a second clone of it on the return leg and bury the cost being measured.
 */
export type BenchWorkerAck = {
  readonly ok: boolean;
  readonly error?: string;
};

/** The outstanding request's settlement, held while it is in flight. */
type PendingRequest = {
  readonly resolve: () => void;
  readonly reject: (reason: Error) => void;
};

/**
 * A worker held for a whole benchmark run, with one message outstanding at a
 * time.
 *
 * @typeParam Request What the benchmark posts. The far side reads it; nothing
 *   here does.
 */
export class BenchWorker<Request> {
  readonly #worker: Worker;
  #pending: PendingRequest | undefined;

  /**
   * A failure the worker reported with nothing in flight, kept so the next
   * send reports it instead of waiting for an ack that cannot come.
   */
  #terminal: Error | undefined;

  /**
   * Constructs an instance, starting the worker.
   *
   * @param moduleUrl The far side's module, as `import.meta.resolve()` gives
   *   it.
   */
  constructor(moduleUrl: string) {
    this.#worker = new Worker(moduleUrl, { type: "module" });

    this.#worker.onmessage = (ev: MessageEvent<BenchWorkerAck>) => {
      const pending = this.#pending;

      this.#pending = undefined;

      if (ev.data.ok) {
        pending?.resolve();
      } else {
        pending?.reject(new Error(`Far side refused: ${ev.data.error}`));
      }
    };

    // A worker that fails to start, or throws where nothing catches, sends no
    // ack -- and a benchmark waiting on one that will never arrive hangs rather
    // than failing, which is the worst way for a measurement to end. Both
    // routes below settle a request in flight AND record the failure, because
    // the first of them can arrive before the first send: a worker that dies
    // during startup has nothing to reject, and without the record every later
    // send would wait on it.
    // A far side that posts something uncloneable throws where it posts, which
    // arrives here as well: `postMessage()` refuses on the sending side rather
    // than the receiving one, so an acknowledgement that cannot cross is an
    // error rather than a `messageerror`. The ack this harness defines is a
    // boolean and a string, so neither can arise from a far side that conforms.
    this.#worker.onerror = (ev: ErrorEvent) => {
      // Handled here, so it stops here: an error left to its default course
      // reaches the host as an unhandled worker error and takes the process
      // with it, which ends the run rather than the measurement.
      ev.preventDefault();
      this.#fail(new Error(`Far side failed: ${ev.message}`));
    };
  }

  /**
   * Sends one request and settles when the far side acknowledges it.
   *
   * @throws If the far side reports failure, or has already failed. An
   *   unexamined ack is what makes a benchmark measure the wrong thing
   *   silently.
   */
  send(request: Request): Promise<void> {
    if (this.#terminal !== undefined) return Promise.reject(this.#terminal);

    if (this.#pending !== undefined) {
      // One at a time is what an iteration measures, so a second send would be
      // measuring something else -- and it would take the first one's
      // acknowledgement, leaving that request unsettled and this one settled by
      // an answer to a message it did not send. Refused rather than queued: a
      // benchmark that overlaps sends has the wrong shape, and hiding that
      // behind a queue would let it report throughput while timing latency.
      return Promise.reject(
        new Error("A request is already in flight; sends do not overlap."),
      );
    }

    return new Promise((resolve, reject) => {
      this.#pending = { resolve, reject };

      try {
        this.#worker.postMessage(request);
      } catch (cause) {
        // A request that cannot be cloned never reaches the far side, so
        // nothing will acknowledge it and it is not in flight. Clearing before
        // rejecting is what keeps the refusal above from latching: the record
        // exists only for a request the far side has actually been given.
        //
        // The worker itself is unharmed -- what failed is this request rather
        // than the crossing -- so no terminal failure is recorded and the next
        // send proceeds.
        this.#pending = undefined;
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  /**
   * Stops the worker.
   *
   * Anything in flight is settled as failed first. Terminating leaves an
   * acknowledgement unable to arrive, so a request left pending would wait for
   * one forever -- and a benchmark closing its worker in a `finally` is exactly
   * where that would strand a caller.
   */
  close(): void {
    this.#fail(new Error("Far side was closed."));
    this.#worker.terminate();
  }

  /** Settles anything in flight with `error`, and records it for later sends. */
  #fail(error: Error): void {
    const pending = this.#pending;

    this.#pending = undefined;
    this.#terminal = error;
    pending?.reject(error);
  }
}

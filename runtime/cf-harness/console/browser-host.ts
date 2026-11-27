/**
 * The console's end of a browser host: the channel one turn's browser
 * operations travel to the host that shows them, and their results travel
 * back on.
 *
 * The host is a client that declared, when it started the task, that it can
 * host a browser. The console answered it with a token for that turn, and
 * nobody else holds it. The host then holds a stream open, on which each
 * operation arrives as an event, and posts each result back naming the
 * operation it answers. The token is what binds the stream and the results to
 * that client: a request that names the turn without it is refused.
 *
 * Each operation arrives with the session it addresses, and the host answers
 * every operation it is sent, one at a time in each session. When the run
 * withdraws one the host already holds, the stream says so with a `withdraw`
 * event; the host stops it if it can, and answers it as it ended, and that
 * answer is the acknowledgment: no later operation for that session reaches
 * the host until it arrives, so nothing the host does for a withdrawn call
 * overlaps what comes next in its session. Other sessions carry on.
 *
 * Nothing here waits on a clock. An operation waits until the host answers
 * it, the host's stream ends, the turn ends, or the run aborts it — a
 * hand-off waits for the owner, however long that takes.
 */

import { timingSafeEqual } from "@std/crypto/timing-safe-equal";

import {
  type BrowserHostOperation,
  browserHostQueueOf,
  type BrowserHostRefusalResult,
  type BrowserHostRequest,
  browserHostRequestProblem,
  type BrowserHostResult,
  type HarnessBrowserHost,
  isBrowserHostResult,
} from "../src/contracts/browser-host.ts";
import { sseFrame } from "./sse.ts";

/** The SSE event name an operation for the host arrives under. */
export const BROWSER_HOST_REQUEST_EVENT = "request";

/** The SSE event name that withdraws an operation the host holds. */
export const BROWSER_HOST_WITHDRAW_EVENT = "withdraw";

/** The SSE event name that tells the host the turn is over. */
export const BROWSER_HOST_CLOSE_EVENT = "close";

const encoder = new TextEncoder();

/** One operation the run is waiting on. */
interface PendingOperation {
  /** The queue it is ordered in, as `browserHostQueueOf` names it. */
  queue: string | undefined;

  /** Its `request` event, as the stream carries it. */
  frame: string;

  /**
   * Settles the run's call with the host's answer, or with `failed` when the
   * answer is not a result for the operation, and returns whether it was one.
   */
  settle(answer: unknown): boolean;
}

/** What an answer that is not a result settles its operation as. */
const NOT_A_RESULT: BrowserHostRefusalResult = {
  status: "failed",
  message: "the browser host answered with something that is not a result",
};

/** What {@link ConsoleBrowserHost.acceptResult} made of a posted result. */
export type BrowserHostResultAcceptance = "accepted" | "unknown" | "invalid";

/**
 * One turn's channel to its browser host. The harness calls
 * {@link perform}; the console's routes attach the host's stream and hand in
 * its results.
 */
export class ConsoleBrowserHost implements HarnessBrowserHost {
  readonly #token: Uint8Array;

  /**
   * Operations not yet on the stream, in the order the run sent them: the
   * host has not attached, or has not yet answered an operation the run
   * withdrew in the same queue.
   */
  readonly #queued = new Map<string, PendingOperation>();

  /** Operations on the stream that the host has not answered. */
  readonly #delivered = new Map<string, PendingOperation>();

  /** Withdrawn operations the host has not answered, and their queues. */
  readonly #withdrawn = new Map<string, string | undefined>();

  #stream: ReadableStreamDefaultController<Uint8Array> | undefined;

  /**
   * Why the channel takes no more operations, once it does not: the host's
   * stream ended, or the turn did.
   */
  #ended: string | undefined;
  #nextId = 0;

  /** Constructs the channel for a host holding `token`. */
  constructor(token: string) {
    this.#token = encoder.encode(token);
  }

  /** Whether `token` is the one this channel was minted with. */
  admits(token: unknown): boolean {
    if (typeof token !== "string") {
      return false;
    }
    const candidate = encoder.encode(token);
    return candidate.byteLength === this.#token.byteLength &&
      timingSafeEqual(candidate, this.#token);
  }

  /**
   * Sends `request` to the host and resolves with its answer. Resolves with
   * `invalid`, sending nothing, when the request is malformed, and with
   * `session-ended` when the host's stream or the turn has ended, or ends
   * while the operation is outstanding. Rejects with the signal's reason when
   * `signal` aborts first, withdrawing the operation.
   */
  perform<O extends BrowserHostOperation>(
    request: BrowserHostRequest<O>,
    signal?: AbortSignal,
  ): Promise<BrowserHostResult<O>> {
    const problem = browserHostRequestProblem(request);
    if (problem !== undefined) {
      return Promise.resolve({ status: "invalid", message: problem });
    }
    if (this.#ended !== undefined) {
      return Promise.resolve({ status: "session-ended", message: this.#ended });
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    const id = String(++this.#nextId);
    const { session, operation } = request;
    const queue = browserHostQueueOf(request);
    return new Promise<BrowserHostResult<O>>((resolve, reject) => {
      const onAbort = () => {
        if (!this.#queued.delete(id) && this.#delivered.delete(id)) {
          this.#withdrawn.set(id, queue);
          this.#stream?.enqueue(encoder.encode(
            sseFrame(BROWSER_HOST_WITHDRAW_EVENT, JSON.stringify({ id })),
          ));
        }
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#queued.set(id, {
        queue,
        frame: sseFrame(
          BROWSER_HOST_REQUEST_EVENT,
          JSON.stringify({ id, session, operation }),
        ),
        settle: (answer) => {
          signal?.removeEventListener("abort", onAbort);
          const valid = isBrowserHostResult(answer, request);
          resolve(valid ? answer : NOT_A_RESULT);
          return valid;
        },
      });
      this.#flush();
    });
  }

  /**
   * The host's stream: every operation not yet delivered, then each one as
   * it is sent. The first attach is the only one; the channel ends when the
   * stream does, since a host that went away holds no session to continue
   * in. Returns `undefined` when the channel already has a stream or has
   * ended.
   */
  attach(): ReadableStream<Uint8Array> | undefined {
    if (this.#stream !== undefined || this.#ended !== undefined) {
      return undefined;
    }
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#stream = controller;
        this.#flush();
      },
      cancel: () => {
        this.#stream = undefined;
        this.#end("the browser host's connection ended");
      },
    });
  }

  /**
   * Hands in the host's answer to operation `id`. The answer to a withdrawn
   * operation acknowledges the withdrawal, and lets the next operation for
   * its session reach the host. An answer for an operation nobody is waiting
   * on is `unknown`. One that is not a result for the operation is `invalid`,
   * and settles the operation as `failed` rather than leaving it waiting: the
   * host answered, and what it answered is not something the run can read,
   * which is a refusal rather than an observation.
   */
  acceptResult(id: unknown, result: unknown): BrowserHostResultAcceptance {
    if (typeof id !== "string") {
      return "unknown";
    }
    if (this.#withdrawn.delete(id)) {
      this.#flush();
      return "accepted";
    }
    // Only an operation the host was sent can be answered: one still queued
    // has not reached it, and an answer for it is not one.
    const delivered = this.#delivered.get(id);
    if (delivered === undefined) {
      return "unknown";
    }
    this.#delivered.delete(id);
    return delivered.settle(result) ? "accepted" : "invalid";
  }

  /** Keeps a quiet stream visibly alive through proxies between the two. */
  ping(beat: number): void {
    if (this.#stream !== undefined) {
      this.#stream.enqueue(encoder.encode(`: ${beat}\n\n`));
    }
  }

  /**
   * Ends the channel because the turn ended: the host is told, its stream
   * closes, and anything outstanding settles as `session-ended`.
   */
  close(): void {
    if (this.#ended !== undefined) {
      return;
    }
    this.#end("the turn has ended");
    const stream = this.#stream;
    this.#stream = undefined;
    stream?.enqueue(encoder.encode(sseFrame(BROWSER_HOST_CLOSE_EVENT, "{}")));
    stream?.close();
  }

  /**
   * Writes the queued operations to the stream, once there is one, except
   * those in a queue where the host owes an answer to a withdrawn operation.
   */
  #flush(): void {
    if (this.#stream === undefined) {
      return;
    }
    const held = new Set(this.#withdrawn.values());
    for (const [id, pending] of this.#queued) {
      if (pending.queue !== undefined && held.has(pending.queue)) {
        continue;
      }
      this.#queued.delete(id);
      this.#delivered.set(id, pending);
      this.#stream.enqueue(encoder.encode(pending.frame));
    }
  }

  /**
   * Helper for `close()` and the stream's end, which stops the channel and
   * settles everything outstanding as `session-ended`.
   */
  #end(reason: string): void {
    this.#ended ??= reason;
    const message = this.#ended;
    const pending = [...this.#queued.values(), ...this.#delivered.values()];
    this.#queued.clear();
    this.#delivered.clear();
    this.#withdrawn.clear();
    for (const operation of pending) {
      operation.settle({ status: "session-ended", message });
    }
  }
}

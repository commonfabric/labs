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
 * The host answers every operation it is sent, one at a time. When the run
 * withdraws one the host already holds, the stream says so with a `withdraw`
 * event; the host stops it if it can, and answers it as it ended, and that
 * answer is the acknowledgment: no later operation reaches the host until it
 * arrives, so nothing the host does for a withdrawn call overlaps what comes
 * next.
 *
 * Nothing here waits on a clock. An operation waits until the host answers
 * it, the host's stream ends, the turn ends, or the run aborts it — a
 * hand-off waits for the owner, however long that takes.
 */

import { timingSafeEqual } from "@std/crypto/timing-safe-equal";

import {
  type BrowserHostOperation,
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

/** One operation sent to the host and not yet answered. */
interface PendingOperation {
  settle(result: BrowserHostResult): void;
}

/** What {@link ConsoleBrowserHost.acceptResult} made of a posted result. */
export type BrowserHostResultAcceptance = "accepted" | "unknown" | "invalid";

/**
 * One turn's channel to its browser host. The harness calls
 * {@link perform}; the console's routes attach the host's stream and hand in
 * its results.
 */
export class ConsoleBrowserHost implements HarnessBrowserHost {
  readonly #token: Uint8Array;
  readonly #pending = new Map<string, PendingOperation>();

  /**
   * Operations not yet on the stream, by id: the host has not attached, or
   * has not yet answered an operation the run withdrew.
   */
  readonly #queued = new Map<string, string>();

  /** Operations on the stream that the host has not answered. */
  readonly #delivered = new Set<string>();

  /** Withdrawn operations the host has not answered. */
  readonly #withdrawn = new Set<string>();

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
   * Sends `operation` to the host and resolves with its answer. Resolves with
   * `session-ended` when the host's stream or the turn has ended, or ends
   * while the operation is outstanding. Rejects with the signal's reason when
   * `signal` aborts first, withdrawing the operation.
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
        this.#pending.delete(id);
        if (!this.#queued.delete(id) && this.#delivered.delete(id)) {
          this.#withdrawn.add(id);
          this.#stream?.enqueue(encoder.encode(
            sseFrame(BROWSER_HOST_WITHDRAW_EVENT, JSON.stringify({ id })),
          ));
        }
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        settle: (result) => {
          signal?.removeEventListener("abort", onAbort);
          this.#pending.delete(id);
          this.#delivered.delete(id);
          resolve(result);
        },
      });
      this.#queued.set(
        id,
        sseFrame(BROWSER_HOST_REQUEST_EVENT, JSON.stringify({ id, operation })),
      );
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
   * operation acknowledges the withdrawal, and lets the next operation reach
   * the host. An answer for an operation nobody is waiting on is `unknown`.
   * One that is not a result is `invalid`, and settles the operation as
   * `failed` rather than leaving it waiting: the host answered, and what it
   * answered is not something the run can read, which is a refusal rather
   * than an observation.
   */
  acceptResult(id: unknown, result: unknown): BrowserHostResultAcceptance {
    if (typeof id === "string" && this.#withdrawn.delete(id)) {
      this.#flush();
      return "accepted";
    }
    // Only an operation the host was sent can be answered: one still queued
    // has not reached it, and an answer for it is not one.
    const pending = typeof id === "string" && this.#delivered.has(id)
      ? this.#pending.get(id)
      : undefined;
    if (pending === undefined) {
      return "unknown";
    }
    if (!isBrowserHostResult(result)) {
      pending.settle({
        status: "failed",
        message:
          "the browser host answered with something that is not a result",
      });
      return "invalid";
    }
    pending.settle(result);
    return "accepted";
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
   * Writes the queued operations to the stream, once there is one and the
   * host owes no answer to a withdrawn operation.
   */
  #flush(): void {
    if (this.#stream === undefined || this.#withdrawn.size > 0) {
      return;
    }
    for (const [id, frame] of this.#queued) {
      this.#stream.enqueue(encoder.encode(frame));
      this.#delivered.add(id);
    }
    this.#queued.clear();
  }

  #end(reason: string): void {
    this.#ended ??= reason;
    this.#queued.clear();
    this.#withdrawn.clear();
    const message = this.#ended;
    for (const pending of [...this.#pending.values()]) {
      pending.settle({ status: "session-ended", message });
    }
  }
}

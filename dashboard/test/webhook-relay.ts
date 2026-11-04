/**
 * A stand-in for the GitHub webhook relay, for the tests of what the
 * dashboard does with its deliveries: it accepts connections, writes each
 * delivery to the connection open as the relay frames it, and ends the
 * connection when asked.
 */

import {
  type GitHubDelivery,
  GitHubWebhooks,
  type RelayConnection,
} from "../github-webhooks.ts";
import type { GitHubRun } from "../github-runs.ts";

const ENCODER = new TextEncoder();

/** One connection the stand-in accepted. */
interface Accepted {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  closed: PromiseWithResolvers<void>;
}

/** The relay, as far as the dashboard sees it. */
export class FakeRelay {
  #accepted: Accepted[] = [];
  #refusing = false;
  #webhooks: GitHubWebhooks;

  /** Constructs an instance with a subscriber that connects to it. */
  constructor() {
    this.#webhooks = new GitHubWebhooks(() => this.#accept());
  }

  /** The subscriber connected to this relay. */
  get webhooks(): GitHubWebhooks {
    return this.#webhooks;
  }

  /** How many connections the subscriber has opened. */
  get connections(): number {
    return this.#accepted.length;
  }

  /** Sets whether a connection asked for is refused. */
  set refusing(refusing: boolean) {
    this.#refusing = refusing;
  }

  /**
   * Has the subscriber connect, and resolves once the connection is heard,
   * which a first delivery shows.
   */
  async open(): Promise<void> {
    await this.webhooks.connect();
    await this.deliver("ping", { zen: "Keep it logically awesome." });
  }

  /**
   * Writes a delivery of `event` carrying `payload` to the connection open,
   * and resolves once the subscriber has handed it to its listeners. With
   * `form`, the body is form-encoded, as a webhook set to that content type
   * sends it.
   */
  deliver(
    event: string,
    payload: unknown,
    form = false,
  ): Promise<GitHubDelivery> {
    const json = JSON.stringify(payload);
    const body = form
      ? new URLSearchParams({ payload: json }).toString()
      : json;
    const type = form
      ? "application/x-www-form-urlencoded"
      : "application/json";
    return this.write(ENCODER.encode(
      "POST /webhook HTTP/1.1\r\n" +
        `x-github-event: ${event}\r\n` +
        `Content-Type: ${type}\r\n` +
        `Content-Length: ${ENCODER.encode(body).length}\r\n\r\n` +
        body,
    ));
  }

  /**
   * Writes `request` to the connection open as one frame, in pieces of
   * `piece` bytes, and resolves with the next delivery the subscriber hands
   * to its listeners.
   */
  write(request: Uint8Array, piece = Infinity): Promise<GitHubDelivery> {
    const next = Promise.withResolvers<GitHubDelivery>();
    const stop = this.webhooks.listen((delivery) => {
      stop();
      next.resolve(delivery);
    });
    const frame = new Uint8Array(4 + request.length);
    new DataView(frame.buffer).setUint32(0, request.length);
    frame.set(request, 4);
    this.writeBytes(frame, piece);
    return next.promise;
  }

  /** Writes `bytes` to the connection open, in pieces of `piece` bytes. */
  writeBytes(bytes: Uint8Array, piece = Infinity): void {
    const open = this.#accepted.at(-1);
    if (open === undefined) throw new Error("no connection is open");
    for (let at = 0; at < bytes.length; at += piece) {
      void open.writer.write(bytes.slice(at, at + piece));
    }
  }

  /**
   * Resolves once the subscriber has closed the connection open when this is
   * called.
   */
  closed(): Promise<void> {
    const open = this.#accepted.at(-1);
    if (open === undefined) throw new Error("no connection is open");
    return open.closed.promise;
  }

  /**
   * Ends the connection open, and resolves once the subscriber has closed
   * its end.
   */
  async end(): Promise<void> {
    const open = this.#accepted.at(-1);
    if (open === undefined) throw new Error("no connection is open");
    void open.writer.close();
    await open.closed.promise;
  }

  /** Helper for the subscriber's connect, which accepts a connection. */
  #accept(): Promise<RelayConnection> {
    if (this.#refusing) {
      return Promise.reject(new Error("connection refused"));
    }
    const closed = Promise.withResolvers<void>();
    const { readable, writable } = new TransformStream<Uint8Array>();
    this.#accepted.push({ writer: writable.getWriter(), closed });
    return Promise.resolve({ readable, close: () => closed.resolve() });
  }
}

/**
 * The payload of a `workflow_run` delivery reporting `run`, a run of the
 * workflow at `path` with id `workflowId` in `repo`, whose default branch is
 * `main`.
 */
export function workflowRunPayload(
  repo: string,
  run: GitHubRun,
  path = ".github/workflows/ci.yml",
  workflowId = 1,
) {
  return {
    action: run.status === "completed" ? "completed" : "in_progress",
    repository: { full_name: repo, default_branch: "main" },
    workflow_run: { name: "CI", ...run, path, workflow_id: workflowId },
  };
}

/** The payload of a `push` delivery moving `ref` of `repo` to `after`. */
export function pushPayload(repo: string, ref: string, after = "a".repeat(40)) {
  return {
    ref,
    after,
    repository: { full_name: repo, default_branch: "main" },
  };
}

/**
 * Subscribes to the GitHub webhook relay, which passes each delivery of the
 * organization's webhook to every connection open to it the moment GitHub
 * makes the delivery. The relay keeps no deliveries for a subscriber that is
 * not connected, and a delivery it cannot pass on ends that subscriber's
 * connection, so a connection that is still open has carried every delivery
 * made since it opened. The relay is described in `github-webhook-relay/` in
 * the infra repository.
 *
 * A reader of GitHub data relies on that through `Freshness`: what it read
 * stays current for as long as the connection open when it read is still
 * heard and no delivery that could change the data has arrived since. When
 * that cannot be said, because the relay is not connected or has fallen
 * silent, the reader reads GitHub again on its own schedule, as it would with
 * no relay at all.
 *
 * Each delivery reaches the relay as a frame: the length of the HTTP request
 * GitHub made, as a 32-bit big-endian unsigned integer, and then that request.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";
import type { GitHubRun } from "./github-runs.ts";

/** One delivery of the organization's webhook. */
export interface GitHubDelivery {
  /** The kind of activity, from the `X-GitHub-Event` header. */
  readonly event: string;

  /** The body GitHub signed, parsed. */
  readonly payload: unknown;
}

/** A connection to the relay, as far as a subscriber uses one. */
export interface RelayConnection {
  readonly readable: ReadableStream<Uint8Array>;
  close(): void;
}

/** Opens a connection to the relay. */
export type RelayConnect = () => Promise<RelayConnection>;

/** Identifies one connection to the relay. */
export type RelayStream = { readonly opened: number };

/**
 * How long a connection can carry nothing before it is replaced. A connection
 * whose far end has gone carries nothing and does not end, and the
 * organization's webhook delivers many times a minute while anyone is
 * working.
 */
export const RELAY_QUIET_MS = 2 * 60_000;

/**
 * How long a connection vouches for what was read under it. GitHub does not
 * promise to make every delivery, and a repository outside the organization
 * sends none, so data the relay vouches for is read again this long after it
 * was read even when no delivery has said it changed.
 */
export const RELAY_VOUCH_MS = 15 * 60_000;

const DECODER = new TextDecoder();

/** The connection open, and whether to replace it once it ends. */
interface Open {
  readonly stream: RelayStream;
  readonly frames: FrameReader;
  replace: boolean;
}

/** The relay's connection, and the deliveries it carries. */
export class GitHubWebhooks {
  #connect: RelayConnect | undefined;
  #listeners = new Set<(delivery: GitHubDelivery) => void>();
  #open: Open | undefined;
  #opening: Promise<void> | undefined;
  #refused = false;
  #heard = false;
  #heardAt = -Infinity;
  #deliveries = 0;

  /**
   * Constructs an instance which opens its connections through `connect`, or
   * which never connects when `connect` is undefined.
   */
  constructor(connect?: RelayConnect) {
    this.#connect = connect;
  }

  /** How many deliveries have arrived, over every connection. */
  get deliveries(): number {
    return this.#deliveries;
  }

  /**
   * The connection now open, once it has carried a delivery, which shows that
   * the relay has started writing to it, and until it ends or has carried
   * nothing for RELAY_QUIET_MS; otherwise `undefined`.
   */
  get stream(): RelayStream | undefined {
    return this.#open !== undefined && this.#heard &&
        Date.now() - this.#heardAt < RELAY_QUIET_MS
      ? this.#open.stream
      : undefined;
  }

  /**
   * Returns whether the relay vouches for what was read at `readAt`, a time
   * in milliseconds, under `stream`: whether `stream` is the connection now
   * open and heard, so that every delivery made since it was first heard has
   * arrived, and the read is less than RELAY_VOUCH_MS old.
   */
  vouchesFor(stream: RelayStream | undefined, readAt: number): boolean {
    return stream !== undefined && stream === this.stream &&
      Date.now() - readAt < RELAY_VOUCH_MS;
  }

  /**
   * Calls `listener` with each delivery as it arrives, after `deliveries`
   * counts it, until the function this returns is called. A listener that
   * throws ends the connection, since what it holds may then be wrong.
   */
  listen(listener: (delivery: GitHubDelivery) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Opens a connection to the relay unless one is open or opening, and
   * resolves once the attempt has opened one or failed. A connection that
   * cannot be opened is left for the next call, and logged unless the attempt
   * before it failed too. An open connection that has carried nothing for
   * RELAY_QUIET_MS is ended and replaced, as is one that carried a delivery
   * and then ended.
   */
  connect(): Promise<void> {
    const open = this.#open;
    if (open !== undefined) {
      if (Date.now() - this.#heardAt >= RELAY_QUIET_MS) {
        open.replace = true;
        open.frames.cancel();
      }
      return Promise.resolve();
    }
    const connect = this.#connect;
    if (connect === undefined) return Promise.resolve();
    this.#opening ??= connect().then(
      (connection) => {
        this.#refused = false;
        void this.#hear(connection);
      },
      (error) => {
        if (this.#refused) return;
        this.#refused = true;
        console.error(
          "GitHub webhook relay: could not connect:",
          error instanceof Error ? error.message : String(error),
        );
      },
    ).finally(() => {
      this.#opening = undefined;
    });
    return this.#opening;
  }

  /**
   * Helper for `connect()`, which reads `connection` until it ends, or until
   * it carries a delivery that cannot be read or that a listener fails to
   * take in.
   */
  async #hear(connection: RelayConnection): Promise<void> {
    const open: Open = {
      stream: { opened: Date.now() },
      frames: new FrameReader(connection.readable),
      replace: false,
    };
    this.#open = open;
    this.#heard = false;
    this.#heardAt = open.stream.opened;
    try {
      for (;;) {
        const prefix = await open.frames.read(4);
        if (prefix === undefined) break;
        const length = new DataView(
          prefix.buffer,
          prefix.byteOffset,
          prefix.byteLength,
        ).getUint32(0);
        const request = await open.frames.read(length);
        if (request === undefined) break;
        this.#heardAt = Date.now();
        this.#heard = true;
        open.replace = true;
        const delivery = parseDelivery(request);
        if (delivery === undefined || !isReadable(delivery)) break;
        if (!this.#dispatch(delivery)) break;
      }
    } catch (error) {
      console.error(
        "GitHub webhook relay: the connection failed:",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.#open = undefined;
      open.frames.release();
      try {
        connection.close();
      } catch {
        // A connection that has already closed has nothing left to close.
      }
    }
    if (open.replace) void this.connect();
  }

  /**
   * Helper for `#hear()`, which counts `delivery` and hands it to every
   * listener, and returns whether they all took it in.
   */
  #dispatch(delivery: GitHubDelivery): boolean {
    this.#deliveries++;
    let taken = true;
    for (const listener of this.#listeners) {
      try {
        listener(delivery);
      } catch (error) {
        taken = false;
        console.error(
          `GitHub webhook relay: a ${delivery.event} listener failed:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return taken;
  }
}

/**
 * The relay's connection for the running dashboard, at the `host:port` the
 * `GITHUB_WEBHOOK_RELAY` environment variable names, by default the stage
 * relay's subscriber address. An empty `GITHUB_WEBHOOK_RELAY` turns it off.
 * Nothing connects until the server calls `connect()`.
 */
export const githubWebhooks = new GitHubWebhooks(
  relayAddress(
    Deno.env.get("GITHUB_WEBHOOK_RELAY") ??
      "github-webhooks.stage.commonfabric.dev:8081",
  ),
);

/**
 * Returns the `RelayConnect` for the relay at `address`, as `host:port`, with
 * TCP keepalive on each connection, or `undefined` for an empty address. An
 * address that names no host and port fails each connection.
 */
export function relayAddress(address: string): RelayConnect | undefined {
  if (address === "") return undefined;
  return async () => {
    const { hostname, port } = new URL(`tcp://${address}`);
    if (port === "") throw new Error(`"${address}" names no port`);
    const connection = await Deno.connect({
      hostname: hostname.replace(/^\[(.*)\]$/, "$1"),
      port: Number(port),
    });
    connection.setKeepAlive(true);
    return connection;
  };
}

/**
 * Says whether what a reader last read from GitHub is still current, by the
 * relay's account: whether the connection open when the read started is
 * still heard, and no delivery that `changes` picks out has arrived since.
 */
export class Freshness {
  #webhooks: GitHubWebhooks;
  #changedAt = 0;
  #stream: RelayStream | undefined;
  #readAt = 0;
  #readStartedAt = -Infinity;

  /**
   * Constructs an instance which watches `webhooks` for the deliveries
   * `changes` says may change the data.
   */
  constructor(
    webhooks: GitHubWebhooks,
    changes: (delivery: GitHubDelivery) => boolean,
  ) {
    this.#webhooks = webhooks;
    webhooks.listen((delivery) => {
      if (changes(delivery)) this.#changedAt = webhooks.deliveries;
    });
  }

  /** Whether the data last read is current. */
  get current(): boolean {
    return this.#webhooks.vouchesFor(this.#stream, this.#readStartedAt) &&
      this.#changedAt <= this.#readAt;
  }

  /**
   * Marks a read starting now, and returns the function to call once it has
   * succeeded, from which `current` answers for the data it read.
   */
  reading(): () => void {
    const stream = this.#webhooks.stream;
    const at = this.#webhooks.deliveries;
    const startedAt = Date.now();
    return () => {
      this.#stream = stream;
      this.#readAt = at;
      this.#readStartedAt = startedAt;
    };
  }
}

/** A workflow run's activity, as a `workflow_run` delivery reports it. */
export interface WorkflowRunActivity {
  /** The repository, as "owner/name". */
  readonly repo: string;

  /** The repository's default branch. */
  readonly defaultBranch: string;

  /** The workflow's id. */
  readonly workflowId: number;

  /** The workflow's file name, such as `ci.yml`. */
  readonly workflowFile: string;

  /** The run as it stands after the activity. */
  readonly run: GitHubRun & { readonly path: string };
}

/** The workflow run activity `delivery` reports, if it reports any. */
export function workflowRunOf(
  delivery: GitHubDelivery,
): WorkflowRunActivity | undefined {
  if (delivery.event !== "workflow_run") return undefined;
  const payload = delivery.payload;
  if (!isObjectNotArray(payload)) return undefined;
  const repository = repositoryOf(payload);
  const run = payload.workflow_run;
  if (repository === undefined || !isObjectNotArray(run)) return undefined;
  const {
    id,
    name,
    path,
    workflow_id: workflowId,
    event,
    head_branch: headBranch,
    head_sha: headSha,
    status,
    conclusion,
    run_attempt: runAttempt,
    display_title: displayTitle,
    created_at: createdAt,
    run_started_at: runStartedAt,
    updated_at: updatedAt,
    html_url: htmlUrl,
    head_commit: headCommit,
  } = run;
  const message = isObjectNotArray(headCommit) ? headCommit.message : null;
  if (
    typeof id !== "number" || typeof name !== "string" ||
    typeof path !== "string" || typeof workflowId !== "number" ||
    typeof event !== "string" ||
    !(typeof headBranch === "string" || headBranch === null) ||
    typeof headSha !== "string" || typeof status !== "string" ||
    !(typeof conclusion === "string" || conclusion === null) ||
    typeof runAttempt !== "number" || typeof displayTitle !== "string" ||
    typeof createdAt !== "string" ||
    !(typeof runStartedAt === "string" || runStartedAt === null) ||
    typeof updatedAt !== "string" || typeof htmlUrl !== "string" ||
    !(headCommit === null || typeof message === "string")
  ) return undefined;
  return {
    ...repository,
    workflowId,
    workflowFile: path.slice(path.lastIndexOf("/") + 1),
    run: {
      id,
      name,
      path,
      event,
      head_branch: headBranch,
      head_sha: headSha,
      status,
      conclusion,
      run_attempt: runAttempt,
      display_title: displayTitle,
      created_at: createdAt,
      // A run that has not started yet may name no start, and is listed as
      // starting when it was created.
      run_started_at: runStartedAt ?? createdAt,
      updated_at: updatedAt,
      html_url: htmlUrl,
      head_commit: typeof message === "string" ? { message } : null,
    },
  };
}

/** An update of a branch or tag, as a `push` delivery reports it. */
export interface PushActivity {
  /** The repository, as "owner/name". */
  readonly repo: string;

  /** The repository's default branch. */
  readonly defaultBranch: string;

  /** The ref updated, such as `refs/heads/main`. */
  readonly ref: string;

  /** The commit the ref was moved to; all zeros when it was deleted. */
  readonly after: string;
}

/** The update `delivery` reports, if it is a push. */
export function pushOf(delivery: GitHubDelivery): PushActivity | undefined {
  if (delivery.event !== "push") return undefined;
  const payload = delivery.payload;
  if (!isObjectNotArray(payload)) return undefined;
  const { ref, after } = payload;
  if (typeof ref !== "string" || typeof after !== "string") return undefined;
  const repository = repositoryOf(payload);
  return repository && { ...repository, ref, after };
}

/**
 * Returns whether `a` and `b` name the same repository, as "owner/name",
 * which GitHub reads without regard to letter case.
 */
export function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Helper for `workflowRunOf()` and `pushOf()`, which reads the repository a
 * delivery's payload names.
 */
function repositoryOf(
  payload: Record<string, unknown>,
): { repo: string; defaultBranch: string } | undefined {
  const repository = payload.repository;
  if (!isObjectNotArray(repository)) return undefined;
  const { full_name: repo, default_branch: defaultBranch } = repository;
  return typeof repo === "string" && typeof defaultBranch === "string"
    ? { repo, defaultBranch }
    : undefined;
}

/**
 * Helper for `GitHubWebhooks`, which reads the delivery an HTTP request from
 * GitHub carries, or logs why it carries none and returns `undefined`.
 */
function parseDelivery(request: Uint8Array): GitHubDelivery | undefined {
  const end = headEnd(request);
  if (end === -1) {
    console.error("GitHub webhook relay: a request had no end to its head");
    return undefined;
  }
  const headers = new Map<string, string>();
  for (
    const line of DECODER.decode(request.subarray(0, end)).split("\r\n").slice(
      1,
    )
  ) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers.set(
        line.slice(0, colon).trim().toLowerCase(),
        line.slice(colon + 1).trim(),
      );
    }
  }
  const event = headers.get("x-github-event");
  if (event === undefined) {
    console.error("GitHub webhook relay: a request named no event");
    return undefined;
  }
  const body = DECODER.decode(request.subarray(end + 4));
  try {
    const form = headers.get("content-type")?.startsWith(
      "application/x-www-form-urlencoded",
    );
    const json = form ? new URLSearchParams(body).get("payload") : body;
    if (json === null) throw new Error("the form carries no payload");
    return { event, payload: JSON.parse(json) };
  } catch (error) {
    console.error(
      `GitHub webhook relay: a ${event} delivery could not be read:`,
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}

/**
 * Helper for `GitHubWebhooks`, which returns whether the dashboard can read
 * what `delivery` says, or logs why it cannot. A `workflow_run` or `push`
 * delivery whose payload lacks what the dashboard reads of it could have
 * changed what the dashboard holds.
 */
function isReadable(delivery: GitHubDelivery): boolean {
  const unreadable = delivery.event === "workflow_run" &&
      workflowRunOf(delivery) === undefined ||
    delivery.event === "push" && pushOf(delivery) === undefined;
  if (unreadable) {
    console.error(
      `GitHub webhook relay: a ${delivery.event} delivery did not carry ` +
        "what the dashboard reads of one",
    );
  }
  return !unreadable;
}

/**
 * Helper for `parseDelivery()`, which returns where the empty line ending
 * `request`'s head starts, or -1 when it has none.
 */
function headEnd(request: Uint8Array): number {
  for (let i = 0; i + 3 < request.length; i++) {
    if (
      request[i] === 13 && request[i + 1] === 10 && request[i + 2] === 13 &&
      request[i + 3] === 10
    ) return i;
  }
  return -1;
}

/** Reads a byte stream in pieces of the lengths asked for. */
class FrameReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #chunks: Uint8Array[] = [];
  #held = 0;

  constructor(readable: ReadableStream<Uint8Array>) {
    this.#reader = readable.getReader();
  }

  /**
   * Reads the next `length` bytes, or returns `undefined` when the stream
   * ends first.
   */
  async read(length: number): Promise<Uint8Array | undefined> {
    while (this.#held < length) {
      const { done, value } = await this.#reader.read();
      if (done) return undefined;
      this.#chunks.push(value);
      this.#held += value.length;
    }
    this.#held -= length;
    const first = this.#chunks[0];
    if (first !== undefined && first.length >= length) {
      // The bytes asked for are in one chunk, and are handed out in place.
      this.#take(first, length);
      return first.subarray(0, length);
    }
    const bytes = new Uint8Array(length);
    for (let filled = 0; filled < length;) {
      const chunk = this.#chunks[0];
      const taken = Math.min(chunk.length, length - filled);
      bytes.set(chunk.subarray(0, taken), filled);
      filled += taken;
      this.#take(chunk, taken);
    }
    return bytes;
  }

  /** Ends the stream, so that a read under way returns `undefined`. */
  cancel(): void {
    // A stream that failed rejects the cancel as it does the read under way,
    // which reports the failure.
    this.#reader.cancel().catch(() => {});
  }

  /** Stops reading the stream. */
  release(): void {
    this.#reader.releaseLock();
  }

  /** Helper for `read()`, which drops `length` bytes from `chunk`, the first. */
  #take(chunk: Uint8Array, length: number): void {
    if (length === chunk.length) this.#chunks.shift();
    else this.#chunks[0] = chunk.subarray(length);
  }
}

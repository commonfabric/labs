/**
 * The local job API: HTTP on a private Unix socket, the one door local
 * callers hand the runner work through. Reaching the socket is the
 * authority — it is created mode 0600 beside a token file of the same mode,
 * and every request carries that token as a bearer — so a caller that can
 * name a profile is one the host let in. The routes:
 *
 * - `GET /health` — the lane is serving.
 * - `POST /jobs` — enqueue `{caller, profile, idempotencyKey, task,
 *   instructions?, context?, resultSchema, tools?, maxModelTurns?}`;
 *   answers `201` with the new job, or `200` with the one the key already
 *   names for the same request.
 * - `GET /jobs?limit=n` — the newest jobs, newest first.
 * - `GET /jobs/<id>` — one job.
 * - `POST /jobs/<id>/cancel` — ask a job to stop.
 * - `GET /jobs/<id>/events?after=<seq>` — the job's events after `seq` as
 *   server-sent events, then each new one as it is appended, ending after
 *   the job's terminal state. `Last-Event-ID` resumes the same way.
 *
 * A refusal is `{ok: false, code, error}` with a 4xx status.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";

import { narrowLocalJobProfile } from "./profiles.ts";
import type { LocalJobProfiles } from "./profiles.ts";
import {
  LOCAL_JOB_TERMINAL_STATES,
  type LocalJobEvent,
  type LocalJobRequest,
  type LocalJobStore,
} from "./store.ts";

/** Longest idempotency key, caller or profile name a request may carry. */
const MAX_NAME_LENGTH = 200;

/** How often an open event stream says it is alive when nothing happens. */
export const LOCAL_JOB_HEARTBEAT_MS = 15_000;

/** What the API answers requests with. */
export interface LocalJobApiOptions {
  store: LocalJobStore;
  profiles: LocalJobProfiles;

  /** The bearer token every request must carry. */
  token: string;

  /** Starts queued jobs; called after an enqueue. */
  kick: () => void;

  /** Asks a job to stop. */
  cancel: (id: string) => unknown;

  /** Whether the runner's Fabric lane is running, for `/health`. */
  fabricLane?: () => boolean;

  /** The keep-alive interval of an event stream. */
  heartbeatMs?: number;

  /** Aborted when the service stops; every open event stream then ends. */
  stopping?: AbortSignal;
}

/** Helper for answers, which writes a JSON body with `status`. */
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Helper for answers, which writes a refusal. */
const refuse = (status: number, code: string, error: string): Response =>
  json(status, { ok: false, code, error });

/** Helper for enqueue, which reads a request body or names what is wrong. */
const enqueueRequestOf = (
  value: unknown,
):
  | {
    caller: string;
    profile: string;
    idempotencyKey: string;
    request: LocalJobRequest;
  }
  | { error: string } => {
  if (!isObjectNotArray(value)) return { error: "The body must be an object." };
  const {
    caller,
    profile,
    idempotencyKey,
    task,
    instructions,
    context,
    resultSchema,
    tools,
    maxModelTurns,
  } = value as Record<string, unknown>;
  const name = (field: unknown) =>
    typeof field === "string" && field.length > 0 &&
    field.length <= MAX_NAME_LENGTH;
  if (!name(caller) || !name(profile) || !name(idempotencyKey)) {
    return {
      error:
        "`caller`, `profile` and `idempotencyKey` must be nonempty strings.",
    };
  }
  if (typeof task !== "string" || task.length === 0) {
    return { error: "`task` must be a nonempty string." };
  }
  if (instructions !== undefined && typeof instructions !== "string") {
    return { error: "`instructions` must be a string." };
  }
  if (!isObjectNotArray(resultSchema) && typeof resultSchema !== "boolean") {
    return { error: "`resultSchema` must be a JSON schema." };
  }
  if (
    tools !== undefined &&
    (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string"))
  ) {
    return { error: "`tools` must be a list of tool names." };
  }
  if (
    maxModelTurns !== undefined &&
    (typeof maxModelTurns !== "number" || !Number.isInteger(maxModelTurns) ||
      maxModelTurns < 1)
  ) {
    return { error: "`maxModelTurns` must be a whole number of 1 or more." };
  }
  return {
    caller: caller as string,
    profile: profile as string,
    idempotencyKey: idempotencyKey as string,
    request: {
      task,
      ...(instructions !== undefined ? { instructions } : {}),
      ...(context !== undefined ? { context } : {}),
      resultSchema,
      ...(tools !== undefined ? { tools: tools as string[] } : {}),
      ...(maxModelTurns !== undefined ? { maxModelTurns } : {}),
    },
  };
};

/** Helper for the stream, which writes one event as a server-sent event. */
const sse = (event: LocalJobEvent): string =>
  `id: ${event.seq}\nevent: ${event.kind}\ndata: ${
    JSON.stringify({ seq: event.seq, at: event.at, ...event.body })
  }\n\n`;

/** Whether an event ends its job's stream. */
const isTerminal = (event: LocalJobEvent): boolean =>
  event.kind === "state" &&
  LOCAL_JOB_TERMINAL_STATES.has(event.body.state as never);

/**
 * Helper for `GET /jobs/<id>/events`, which streams the job's stored events
 * after `after`, then each new one, and ends after its terminal state.
 */
const eventStream = (
  options: LocalJobApiOptions,
  id: string,
  after: number,
  signal: AbortSignal,
): Response => {
  const { store } = options;
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // The reader already went away.
        }
      };
      const send = (event: LocalJobEvent) => {
        controller.enqueue(encoder.encode(sse(event)));
        if (isTerminal(event)) close();
      };
      // The store tells subscribers of an event as its write commits, and
      // this runs without yielding, so subscribing and then reading what is
      // stored sends every event once: none can land between the two, and
      // the terminal event is the last a job has.
      unsubscribe = store.subscribe((jobId, event) => {
        if (jobId === id) send(event);
      });
      for (const event of store.events(id, after)) send(event);
      if (closed) return;
      if (LOCAL_JOB_TERMINAL_STATES.has(store.get(id)!.state)) {
        close();
        return;
      }
      // A peer that goes silent is the one case a timer is for: the stream
      // says it is alive so a reader can tell a quiet job from a dead socket.
      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, options.heartbeatMs ?? LOCAL_JOB_HEARTBEAT_MS);
      signal.addEventListener("abort", close, { once: true });
      options.stopping?.addEventListener("abort", close, { once: true });
    },
    cancel() {
      unsubscribe();
      clearInterval(heartbeat);
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    },
  });
};

/** Builds the API's request handler. */
export const createLocalJobApi = (
  options: LocalJobApiOptions,
) =>
async (request: Request): Promise<Response> => {
  if (request.headers.get("authorization") !== `Bearer ${options.token}`) {
    return refuse(401, "unauthorized", "The request carries no valid token.");
  }
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter((part) => part !== "");
  const { store } = options;

  if (request.method === "GET" && url.pathname === "/health") {
    return json(200, {
      ok: true,
      lanes: { local: true, fabric: options.fabricLane?.() ?? false },
    });
  }

  if (parts[0] !== "jobs") {
    return refuse(404, "not_found", "No such route.");
  }

  if (parts.length === 1) {
    if (request.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "20");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return refuse(
          400,
          "invalid_request",
          "`limit` must be a whole number from 1 to 100.",
        );
      }
      return json(200, { jobs: store.list(limit) });
    }
    if (request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return refuse(400, "invalid_request", "The body must be JSON.");
      }
      const read = enqueueRequestOf(body);
      if ("error" in read) return refuse(400, "invalid_request", read.error);
      const profile = options.profiles.get(read.profile);
      if (profile === undefined) {
        return refuse(
          400,
          "unknown_profile",
          `The host names no profile \`${read.profile}\`.`,
        );
      }
      const narrowed = narrowLocalJobProfile(profile, read.request);
      if ("refusal" in narrowed) {
        return refuse(400, "beyond_profile", narrowed.refusal);
      }
      const enqueued = store.enqueue(
        read.caller,
        read.profile,
        read.idempotencyKey,
        read.request,
      );
      if ("conflict" in enqueued) {
        return refuse(409, "idempotency_conflict", enqueued.conflict);
      }
      if (enqueued.created) options.kick();
      return json(enqueued.created ? 201 : 200, { job: enqueued.job });
    }
    return refuse(405, "method_not_allowed", "Use GET or POST.");
  }

  const id = parts[1];
  if (store.get(id) === undefined) {
    return refuse(404, "not_found", `No job \`${id}\`.`);
  }
  if (parts.length === 2 && request.method === "GET") {
    return json(200, { job: store.get(id) });
  }
  if (
    parts.length === 3 && parts[2] === "cancel" && request.method === "POST"
  ) {
    options.cancel(id);
    return json(200, { job: store.get(id) });
  }
  if (parts.length === 3 && parts[2] === "events" && request.method === "GET") {
    const after = Number(
      url.searchParams.get("after") ??
        request.headers.get("last-event-id") ?? "0",
    );
    if (!Number.isInteger(after) || after < 0) {
      return refuse(
        400,
        "invalid_request",
        "`after` must be a whole number of 0 or more.",
      );
    }
    return eventStream(options, id, after, request.signal);
  }
  return refuse(404, "not_found", "No such route.");
};

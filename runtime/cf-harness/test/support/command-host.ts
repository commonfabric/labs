/**
 * A command endpoint for tests: `GET /commands` and `POST /command` served on
 * a loopback port by the test's own answers, with every request it received
 * recorded. Close it with `await using`.
 */

import { COMMAND_RUN_ID_HEADER } from "../../src/loom-commands.ts";

/** One request the host received. */
export interface CommandHostRequest {
  method: string;
  path: string;

  /** The run-id header's value, or `null` when the request had none. */
  runId: string | null;

  /** The decoded JSON body of a `POST`. */
  body?: unknown;
}

/** What the host answers with. */
export interface CommandHostAnswers {
  /** `GET /commands`; a manifest of no commands when absent. */
  list?: (request: Request) => Response | Promise<Response>;

  /** `POST /command`, given the decoded body; `{ ok: true }` when absent. */
  run?: (body: unknown, request: Request) => Response | Promise<Response>;
}

/** A running host, its base URL, and what it received. */
export interface CommandHost extends AsyncDisposable {
  url: string;
  requests: CommandHostRequest[];
}

/** Starts a host answering with `answers`. */
export const startCommandHost = (
  answers: CommandHostAnswers = {},
): CommandHost => {
  const requests: CommandHostRequest[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      const path = new URL(request.url).pathname;
      const runId = request.headers.get(COMMAND_RUN_ID_HEADER);
      if (request.method === "GET" && path === "/commands") {
        requests.push({ method: "GET", path, runId });
        return answers.list?.(request) ?? Response.json({ commands: [] });
      }
      if (request.method === "POST" && path === "/command") {
        const body: unknown = await request.json();
        requests.push({ method: "POST", path, runId, body });
        return answers.run?.(body, request) ?? Response.json({ ok: true });
      }
      requests.push({ method: request.method, path, runId });
      return new Response("not found", { status: 404 });
    },
  );
  return {
    url: `http://127.0.0.1:${server.addr.port}`,
    requests,
    [Symbol.asyncDispose]: () => server.shutdown(),
  };
};

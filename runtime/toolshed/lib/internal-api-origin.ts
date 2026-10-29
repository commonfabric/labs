/**
 * The internal API origin (`API_INTERNAL_URL`): where this process's own
 * runtimes send the requests they address to the toolshed's public origin,
 * and how the server establishes, before any of them exists, that the origin
 * is its own listener.
 *
 * `API_URL` is the public origin, and it keeps every role that names this
 * deployment: what clients dial, the audience the signed invite and inbox
 * routes check, the base of returned webhook and ingest URLs, what
 * `/api/meta` describes, and what the runtimes record as a space's host and
 * compare source origins against. The runtimes also address their own
 * pattern-source loads, compiles and API calls to it, and on a deployment
 * those requests leave through the public path and come back in. The
 * internal origin changes only where such a request is sent: a fetch given to
 * every runtime this process constructs rewrites a request addressed to the
 * public origin onto the internal one and leaves every other request alone.
 * Nothing records, compares or publishes the internal origin.
 *
 * The internal origin decides whose bytes this server compiles
 * (verification-coverage.md OW55), so a configured value is checked rather
 * than taken: once the listener is bound, and before any runtime exists, the
 * server sends `GET /api/meta` to the origin carrying a one-time token, and
 * the listener's startup gate records whether a request carrying that token
 * arrived at this process. Only that arrival verifies the origin; an answer
 * alone does not, since another toolshed, or anything else bound to the
 * address, could answer. The check does not cover a proxy between the two
 * that forwards the probe and alters later responses; `self` names a port
 * this process has bound, where no such proxy can sit, and an explicit
 * origin is the operator's statement that nothing sits on it.
 */

import type { RuntimeFetch } from "@commonfabric/runner";
import type { env as ToolshedEnv } from "@/env.ts";

/** The request header the startup probe carries its one-time token in. */
export const STARTUP_PROBE_HEADER = "x-cf-startup-probe";

/**
 * The fetch this process's runtimes use when an internal origin is set: a
 * request addressed to the public origin is sent to the internal one, with
 * its path, query and request unchanged; any other request goes where it
 * was addressed. `undefined` when no internal origin is set, so the caller
 * leaves the runtime on the platform fetch.
 */
export function selfDirectedFetch(
  config: Pick<ToolshedEnv, "API_URL" | "API_INTERNAL_URL">,
): RuntimeFetch | undefined {
  if (config.API_INTERNAL_URL === undefined) return undefined;
  return rewritingFetch(config.API_URL, config.API_INTERNAL_URL);
}

/** A fetch sending requests addressed to `publicOrigin` to `internalOrigin`. */
export function rewritingFetch(
  publicOrigin: string,
  internalOrigin: string,
): RuntimeFetch {
  const from = new URL(publicOrigin).origin;
  const to = new URL(internalOrigin);
  return (input, init) => {
    const addressed = requestUrl(input);
    if (addressed === undefined || addressed.origin !== from) {
      return globalThis.fetch(input, init);
    }
    const target = new URL(
      `${addressed.pathname}${addressed.search}${addressed.hash}`,
      to,
    );
    return globalThis.fetch(
      input instanceof Request ? new Request(target, input) : target,
      init,
    );
  };
}

/** The URL `input` addresses, or `undefined` when it does not parse as one. */
function requestUrl(input: RequestInfo | URL): URL | undefined {
  try {
    return new URL(input instanceof Request ? input.url : input);
  } catch (cause) {
    if (!(cause instanceof TypeError)) throw cause;
    return undefined;
  }
}

/**
 * A request handler for the listener while the internal origin is being
 * verified. Until `admit()` is called it answers 503 to every request but
 * the server's own probe, `GET /api/meta` carrying `token`, which it passes
 * through and records. Nothing else can be served yet: no runtime exists,
 * and a Memory session opened on this listener now would precede the serving
 * host that must observe it. The Mode A private listener is separate and
 * not gated here.
 */
export function startupGate<Info>(
  handler: (request: Request, info: Info) => Response | Promise<Response>,
  token: string,
): {
  fetch: (request: Request, info: Info) => Response | Promise<Response>;
  admit(): void;
  probeArrived(): boolean;
} {
  let admitted = false;
  let arrived = false;
  return {
    fetch(request, info) {
      if (admitted) return handler(request, info);
      if (
        request.method === "GET" &&
        new URL(request.url).pathname === "/api/meta" &&
        request.headers.get(STARTUP_PROBE_HEADER) === token
      ) {
        arrived = true;
        return handler(request, info);
      }
      return new Response("Starting: verifying the internal API origin.\n", {
        status: 503,
        headers: { "retry-after": "1", "content-type": "text/plain" },
      });
    },
    admit() {
      admitted = true;
    },
    probeArrived() {
      return arrived;
    },
  };
}

export type InternalApiOriginVerdict =
  | { verified: true }
  | { verified: false; reason: string };

/** How long the startup probe waits for `/api/meta` before refusing. */
export const INTERNAL_API_ORIGIN_PROBE_TIMEOUT_MS = 5_000;

/**
 * Whether `origin` is this process's listener: `GET /api/meta` sent there
 * with `token` must be answered 2xx and, decisively, must have arrived at
 * this process (`probeArrived`, the startup gate's record). A redirect is
 * not followed: an origin that sends its callers elsewhere is not the
 * listener it was meant to name. The reason names what happened, with the
 * cause a failed connection carries, so an operator can tell an unbound
 * port from a refused certificate from another process answering.
 */
export async function verifyInternalApiOrigin(options: {
  origin: string;
  token: string;
  probeArrived: () => boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<InternalApiOriginVerdict> {
  const probe = new URL("/api/meta", options.origin);
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(probe, {
      headers: {
        accept: "application/json",
        [STARTUP_PROBE_HEADER]: options.token,
      },
      redirect: "error",
      signal: AbortSignal.timeout(
        options.timeoutMs ?? INTERNAL_API_ORIGIN_PROBE_TIMEOUT_MS,
      ),
    });
  } catch (error) {
    return {
      verified: false,
      reason: `${probe} did not answer: ${describeError(error)}`,
    };
  }
  await response.body?.cancel();
  if (!response.ok) {
    return { verified: false, reason: `${probe} answered ${response.status}` };
  }
  if (!options.probeArrived()) {
    return {
      verified: false,
      reason: `${probe} answered, but the request did not reach this ` +
        "process: another listener answers there",
    };
  }
  return { verified: true };
}

/**
 * `error`'s message with the messages of its causes, outermost first. Deno's
 * fetch reports every connection failure as "fetch failed" and keeps what
 * happened (a refused connection, a rejected certificate) in `cause`.
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && depth < 5; depth++) {
    const message = current instanceof Error
      ? current.message
      : String(current);
    if (parts[parts.length - 1] !== message) parts.push(message);
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(": ");
}

/**
 * The startup sequence once the listener is bound with an internal origin
 * set: verify the origin; refused, say why and exit, since running on would
 * compile another process's bytes; verified, construct the runtimes, admit
 * the listener and signal readiness, in that order, so no runtime exists
 * before the origin is known and no request is served before a runtime is.
 * A shutdown that began meanwhile ends the sequence without a verdict, since
 * the aborted listener, not the origin, failed the probe.
 */
export async function admitInternalApiOrigin(deps: {
  origin: string;
  verify: () => Promise<InternalApiOriginVerdict>;
  startRuntimes: () => void;
  admit: () => void;
  onListening?: () => void;
  shuttingDown: () => boolean;
  exit: (code: number) => never;
  log: (line: string) => void;
  error: (line: string, cause?: unknown) => void;
}): Promise<void> {
  let verdict: InternalApiOriginVerdict;
  try {
    verdict = await deps.verify();
  } catch (error) {
    verdict = { verified: false, reason: describeError(error) };
  }
  if (deps.shuttingDown()) return;
  if (!verdict.verified) {
    deps.error(
      `API_INTERNAL_URL ${deps.origin} is not this server: ${verdict.reason}`,
    );
    deps.exit(1);
  }
  deps.log(`Internal API origin ${deps.origin} reaches this server`);
  try {
    deps.startRuntimes();
  } catch (error) {
    deps.error("Failed to start runtimes:", error);
    deps.exit(1);
  }
  deps.admit();
  deps.onListening?.();
}

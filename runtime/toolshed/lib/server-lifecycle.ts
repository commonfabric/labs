/**
 * How the toolshed server starts and stops: constructing its runtimes,
 * binding its listener, and shutting down. Each function is given what it
 * acts on, so `index.ts` only supplies the process's own (`Deno.serve`,
 * `Deno.exit`, the memory server, the console).
 */
import type { Runtime } from "@commonfabric/runner";
import type { Server as MemoryServer } from "@commonfabric/memory/v2/server";
import { normalizeInviteHost } from "@commonfabric/memory/space-invites";
import type env from "@/env.ts";
import { announceCloneIfServed } from "@/lib/clone-banner.ts";
import {
  admitInternalApiOrigin,
  startupGate,
  verifyInternalApiOrigin,
} from "@/lib/internal-api-origin.ts";
import { runShutdown } from "@/lib/shutdown.ts";

type Log = (...data: unknown[]) => void;

/** The memory server's hooks for the verbs the serving loop runs. */
export type ServingHooks = Pick<
  MemoryServer,
  "setPatternLifecycleHandler" | "setServedRequestHandler"
>;

/**
 * Constructs this process's runtime with `createRuntime` and returns it, then
 * starts the serving loop's host with `startServingHost`. When that starts a
 * loop, which it does only under `EXPERIMENTAL_SERVER_EXECUTION`, the memory
 * server's verb hooks are pointed at it, so a memory session, or a crossing
 * another process sends this one as the owner of its target space, takes the
 * verbs while the loop runs. A runtime that fails to construct is logged and
 * rethrown.
 */
export function startRuntimes(deps: {
  signerDid: string;
  memoryUrl: string;
  createRuntime: () => Runtime;
  /** Starts the serving loop's host, and returns whether it started a loop. */
  startServingHost: () => boolean;
  memoryServer: ServingHooks;
  lifecycleHandler: Parameters<ServingHooks["setPatternLifecycleHandler"]>[0];
  servedHandler: Parameters<ServingHooks["setServedRequestHandler"]>[0];
  log: Log;
  error: Log;
}): Runtime {
  deps.log(`Initializing runtime with signer ${deps.signerDid}...`);
  let runtime: Runtime;
  try {
    runtime = deps.createRuntime();
  } catch (error) {
    deps.error("Failed to initialize runtime:", error);
    throw error;
  }
  deps.log("Runtime initialized successfully");
  deps.log("Configured to remote storage:", deps.memoryUrl);
  if (deps.startServingHost()) {
    deps.memoryServer.setPatternLifecycleHandler(deps.lifecycleHandler);
    deps.memoryServer.setServedRequestHandler(deps.servedHandler);
  }
  return runtime;
}

/**
 * The server's signal handler. The first call stops the listener with
 * `abort`, unhooks the serving loop's verbs, stops its host, closes the
 * memory system and flushes buffered telemetry, then exits through `exit`:
 * with `0`, or with `1` when a step failed or the steps outlasted `limitMs`,
 * so whoever started the server learns that from its exit status. A call
 * while that runs is logged and changes nothing; the signal listeners stay
 * installed during shutdown so that a second signal arrives here, rather than
 * ending the process before the memory system has closed.
 */
export function createShutdown(deps: {
  abort: () => void;
  memoryServer: ServingHooks;
  stopServingHost: () => Promise<void>;
  closeMemory: () => Promise<void>;
  flushTelemetry: () => Promise<void>;
  limitMs: number;
  exit: (code: number) => void;
  log: Log;
}): { handle: () => Promise<void>; inProgress: () => boolean } {
  let inProgress = false;
  return {
    inProgress: () => inProgress,
    async handle() {
      if (inProgress) {
        deps.log("Shutdown already in progress...");
        return;
      }
      inProgress = true;
      deps.log("Shutdown signal received, closing server...");
      const code = await runShutdown(async () => {
        deps.abort();
        deps.log("Closing memory system...");
        deps.memoryServer.setPatternLifecycleHandler(undefined);
        deps.memoryServer.setServedRequestHandler(undefined);
        await deps.stopServingHost();
        await deps.closeMemory();
        deps.log("Memory system closed successfully");
        await deps.flushTelemetry();
      }, deps.limitMs);
      deps.log(code === 0 ? "Shutdown complete" : "Shutdown failed");
      deps.exit(code);
    },
  };
}

/** What `startServer()` serves with and reports through. */
export interface ServerStartDeps {
  env: Pick<
    typeof env,
    | "HOST"
    | "PORT"
    | "MEMORY_DIR"
    | "DB_PATH"
    | "EXPOSE_GC"
    | "API_URL"
    | "API_INTERNAL_URL"
  >;
  handler: Deno.ServeHandler<Deno.NetAddr>;
  serve: (
    options: Deno.ServeTcpOptions,
    handler: Deno.ServeHandler<Deno.NetAddr>,
  ) => unknown;
  startRuntimes: () => void;
  /** Stops the listener when aborted. */
  signal: AbortSignal;
  shuttingDown: () => boolean;
  exposeGarbageCollector: () => void;
  /** The fetch the internal API origin's startup probe is sent with. */
  probeFetch: typeof fetch;
  onListening?: () => void;
  exit: (code: number) => never;
  log: Log;
  error: Log;
}

/**
 * Binds the listener with `serve`, and constructs the runtimes before it
 * binds, or, with `API_INTERNAL_URL` set, once the listener is up and the
 * origin is verified to be this server's own, with every request but the
 * verification probe answered 503 until then. `onListening` is called once
 * the server serves. The returned promise resolves then, and never rejects in
 * production, where `exit` does not return. A port already in use exits with
 * `3`, so that a caller can tell a port collision from other startup
 * failures and retry on a different port; any other failure to bind exits
 * with `1`.
 */
export function startServer(deps: ServerStartDeps): Promise<void> {
  const { env, log, error } = deps;
  log(`Server is starting on port http://${env.HOST}:${env.PORT}`);
  // A rehearsal clone keeps the source space's DID, so nothing else in this
  // log distinguishes it from production. Announce it before anything else.
  announceCloneIfServed(
    { memoryDir: env.MEMORY_DIR, dbPath: env.DB_PATH },
    log,
  );
  // Before any worker starts, so that the flag never changes while another
  // thread runs.
  if (env.EXPOSE_GC) {
    deps.exposeGarbageCollector();
    log(
      "EXPOSE_GC=true: /api/health/collected-memory collects garbage on request",
    );
  }
  // The signed routes check every first-party proof against this origin rather
  // than the host the client dialed, so a wrong API_URL refuses every
  // correctly signed client. Say it before anyone signs anything, normalized
  // the way those routes normalize it.
  log("Configured first-party authority:", normalizeInviteHost(env.API_URL));
  // Where this process's own runtimes send their self-addressed requests.
  // Unset, that is API_URL and the runtimes start before the listener. Set,
  // it must be this server's own listener, verified once the listener is up
  // and before any runtime exists to fetch from it.
  const origin = env.API_INTERNAL_URL;
  const token = crypto.randomUUID();
  const gate = origin === undefined
    ? undefined
    : { origin, ...startupGate(deps.handler, token) };
  if (gate === undefined) {
    deps.startRuntimes();
  } else {
    log("Configured internal API origin:", gate.origin);
  }

  const listening = Promise.withResolvers<void>();
  const onListen = ({ port, hostname }: Deno.NetAddr) => {
    const ready = () => {
      log(`Server running on http://${hostname}:${port}`);
      deps.onListening?.();
    };
    if (gate === undefined) {
      ready();
      listening.resolve();
      return;
    }
    listening.resolve(
      admitInternalApiOrigin({
        origin: gate.origin,
        verify: () =>
          verifyInternalApiOrigin({
            origin: gate.origin,
            token,
            probeArrived: gate.probeArrived,
            fetch: deps.probeFetch,
          }),
        startRuntimes: deps.startRuntimes,
        admit: gate.admit,
        onListening: ready,
        shuttingDown: deps.shuttingDown,
        exit: deps.exit,
        log,
        error,
      }).catch((failure) => {
        // Nothing above is expected to throw; a throw here would otherwise
        // leave the gate closed and a background launch's parent waiting.
        error("Internal API origin check failed:", failure);
        deps.exit(1);
      }),
    );
  };

  try {
    deps.serve({
      hostname: env.HOST,
      port: env.PORT,
      signal: deps.signal,
      onError: (failure: unknown) => {
        error("Server error:", failure);
        return new Response("Internal Server Error", { status: 500 });
      },
      onListen,
    }, gate?.fetch ?? deps.handler);
  } catch (failure) {
    if (failure instanceof Deno.errors.AddrInUse) {
      error(`Port ${env.PORT} is already in use`);
      deps.exit(3);
    }
    error("Failed to start server:", failure);
    deps.exit(1);
  }
  return listening.promise;
}

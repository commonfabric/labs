import type { Runtime } from "@commonfabric/runner";
import { servedRequestHandler } from "@commonfabric/runner/executor/served-requests";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { exposeGarbageCollector } from "@commonfabric/runner/collected-memory";
import app from "@/app.ts";
import {
  backgroundLogFile,
  classifyLaunch,
  logUncaughtErrors,
  redirectConsoleToFile,
  runBackgroundParent,
  writeListeningMarker,
} from "@/background.ts";
import env from "@/env.ts";
import { toolshedClientBuild } from "@/lib/build-info.ts";
import { identity } from "@/lib/identity.ts";
import { selfDirectedFetch } from "@/lib/internal-api-origin.ts";
import { createToolshedRuntime } from "@/runtime-options.ts";
import {
  memory,
  memoryEngineStoreUrl,
  memoryServer,
} from "@/routes/storage/memory.ts";
import {
  startServerExecutionHost,
  stopServerExecutionHost,
} from "@/lib/server-execution.ts";
import { shutdownOpenTelemetry } from "@/lib/otel.ts";
import { lifecycleRequestHandler } from "@/lib/pattern-lifecycle-handler.ts";
import {
  createShutdown,
  startRuntimes,
  startServer,
} from "@/lib/server-lifecycle.ts";

/**
 * The server's runtime, assigned when the server starts it; `undefined` in
 * any process that is not the server.
 */
let runtime: Runtime;
export { runtime };

export type AppType = typeof app;

if (import.meta.main) {
  // Read at each call, since a background launch redirects the console.
  const log = (...data: unknown[]) => console.log(...data);
  const error = (...data: unknown[]) => console.error(...data);
  const ac = new AbortController();
  const shutdown = createShutdown({
    abort: () => ac.abort(),
    memoryServer,
    stopServingHost: stopServerExecutionHost,
    closeMemory: () => memory.close(),
    flushTelemetry: shutdownOpenTelemetry,
    limitMs: 10_000,
    exit: Deno.exit,
    log,
  });
  Deno.addSignalListener("SIGINT", shutdown.handle);
  Deno.addSignalListener("SIGTERM", shutdown.handle);

  // This process's runtimes: the webhook runtime and, under
  // EXPERIMENTAL_SERVER_EXECUTION, the serving loop's host. Both address
  // their own pattern-source, compile and API requests to API_URL, or to
  // API_INTERNAL_URL when that is set (lib/internal-api-origin.ts).
  const startProcessRuntimes = () => {
    const fetch = selfDirectedFetch(env);
    runtime = startRuntimes({
      signerDid: identity.did(),
      memoryUrl: env.MEMORY_URL,
      createRuntime: () =>
        createToolshedRuntime(
          env,
          StorageManager.open({
            memoryHost: new URL(env.MEMORY_URL),
            as: identity,
            clientBuild: toolshedClientBuild(),
            // This runtime keeps a session on every space a webhook, ingest
            // or token write touched for as long as the process runs, and no
            // one waits on what those spaces compute through it. As demand,
            // those sessions would keep each such space served until a
            // restart.
            demand: false,
          }),
        ),
      startServingHost: () =>
        startServerExecutionHost({
          server: memoryServer,
          identity,
          apiUrl: new URL(env.API_URL),
          store: memoryEngineStoreUrl,
          memoryUrl: new URL(env.MEMORY_URL),
          ...(fetch !== undefined ? { fetch } : {}),
        }) !== undefined,
      memoryServer,
      lifecycleHandler: lifecycleRequestHandler,
      servedHandler: servedRequestHandler({ server: memoryServer }),
      log,
      error,
    });
  };

  const serve = (onListening?: () => void) =>
    void startServer({
      env,
      handler: app.fetch,
      serve: Deno.serve,
      startRuntimes: startProcessRuntimes,
      signal: ac.signal,
      shuttingDown: () => shutdown.inProgress() || ac.signal.aborted,
      exposeGarbageCollector,
      probeFetch: fetch,
      ...(onListening !== undefined ? { onListening } : {}),
      exit: Deno.exit,
      log,
      error,
    });

  const backgroundLog = backgroundLogFile();
  if (backgroundLog) {
    // This process is the server half of a background launch. Its request
    // logger already targets the log file (pino-logger.ts reads the same
    // environment variable); route console output there too, so stdout carries
    // only the readiness marker, and record uncaught errors that would
    // otherwise reach a discarded stderr.
    redirectConsoleToFile(backgroundLog);
    logUncaughtErrors();
    serve(writeListeningMarker);
  } else {
    const launch = classifyLaunch(Deno.args);
    if (launch.background) {
      // Spawn the server as a background child and wait for it to bind; this
      // call exits the process once the child is listening (or has failed to
      // start).
      await runBackgroundParent({
        execPath: Deno.execPath(),
        mainModule: import.meta.url,
        serverArgs: launch.serverArgs,
        logFile: launch.logFile,
      });
    } else {
      serve();
    }
  }
}

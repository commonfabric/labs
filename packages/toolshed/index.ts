import type { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { normalizeInviteHost } from "@commonfabric/memory/space-invites";
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
import { announceCloneIfServed } from "@/lib/clone-banner.ts";
import { identity } from "@/lib/identity.ts";
import { createToolshedRuntime } from "@/runtime-options.ts";
import { memory, memoryServer } from "@/routes/storage/memory.ts";
import {
  startServerExecutionHost,
  stopServerExecutionHost,
} from "@/lib/server-execution.ts";
import { shutdownOpenTelemetry } from "@/lib/otel.ts";
// Create a global runtime instance for the server
let runtime: Runtime;

// Initialize runtime with storage and signer
// FIXME(ja): should we do this even on memory-only toolsheds?
const initializeRuntime = () => {
  try {
    console.log(`Initializing runtime with signer ${identity.did()}...`);

    // Options assembly (the MEMORY_URL/API_URL split, EXPERIMENTAL_* wiring)
    // lives in runtime-options.ts, where it is unit-tested (CT-1814).
    runtime = createToolshedRuntime(
      env,
      StorageManager.open({
        memoryHost: new URL(env.MEMORY_URL),
        as: identity,
      }),
    );
    console.log("Runtime initialized successfully");
    console.log("Configured to remote storage:", env.MEMORY_URL);
  } catch (error) {
    console.error("Failed to initialize runtime:", error);
    throw error;
  }
};

// Export runtime for use in other parts of the application
export { runtime };

export type AppType = typeof app;

// Graceful shutdown with timeout
const ac = new AbortController();
let isShuttingDown = false;
const SHUTDOWN_TIMEOUT = 10000; // 10 seconds

const handleShutdown = async () => {
  if (isShuttingDown) {
    console.log("Shutdown already in progress...");
    return;
  }

  isShuttingDown = true;
  console.log("Shutdown signal received, closing server...");

  // Create a timeout promise
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Shutdown timed out")), SHUTDOWN_TIMEOUT);
  });

  try {
    // Race between graceful shutdown and timeout
    await Promise.race([
      (async () => {
        // Remove signal listeners to prevent multiple shutdown attempts
        Deno.removeSignalListener("SIGINT", handleShutdown);
        Deno.removeSignalListener("SIGTERM", handleShutdown);

        ac.abort();

        console.log("Closing memory system...");
        await stopServerExecutionHost();
        const result = await memory.close();
        if ("error" in result) {
          console.error("Error closing memory:", result.error);
        } else {
          console.log("Memory system closed successfully");
        }

        // Flush buffered spans so the last batch isn't dropped on exit. No-op
        // when telemetry is disabled; bounded by the SHUTDOWN_TIMEOUT race above.
        await shutdownOpenTelemetry();
      })(),
      timeoutPromise,
    ]);
  } catch (err) {
    console.error("Error during shutdown:", err);
  }

  console.log("Shutdown complete");
  Deno.exit(0);
};

// Start server with the abort controller
function startServer(onListening?: () => void) {
  console.log(`Server is starting on port http://${env.HOST}:${env.PORT}`);
  // A rehearsal clone keeps the source space's DID, so nothing else in this
  // log distinguishes it from production. Announce it before anything else.
  announceCloneIfServed({ memoryDir: env.MEMORY_DIR, dbPath: env.DB_PATH });
  // The signed routes check every first-party proof against this origin rather
  // than the host the client dialed, so a wrong API_URL refuses every
  // correctly signed client. Say it before anyone signs anything, normalized
  // the way those routes normalize it.
  console.log(
    "Configured first-party authority:",
    normalizeInviteHost(env.API_URL),
  );
  initializeRuntime();
  // Server-execution v2 (stage F): under EXPERIMENTAL_SERVER_EXECUTION
  // this process hosts the serving loop; OFF (the default) this is a
  // no-op and toolshed is byte-identical to today.
  startServerExecutionHost({
    server: memoryServer,
    identity,
    apiUrl: new URL(env.API_URL),
  });

  const serverOptions = {
    hostname: env.HOST,
    port: env.PORT,
    signal: ac.signal,
    onError: (error: unknown) => {
      console.error("Server error:", error);
      return new Response("Internal Server Error", { status: 500 });
    },
    onListen: ({ port, hostname }: { port: number; hostname: string }) => {
      console.log(`Server running on http://${hostname}:${port}`);
      onListening?.();
    },
  };

  try {
    Deno.serve(serverOptions, app.fetch);
  } catch (err) {
    if (err instanceof Deno.errors.AddrInUse) {
      console.error(`Port ${env.PORT} is already in use`);
      // Distinct exit code so callers can tell a port collision from other
      // startup failures and retry on a different port.
      Deno.exit(3);
    }
    console.error("Failed to start server:", err);
    Deno.exit(1);
  }
}

Deno.addSignalListener("SIGINT", handleShutdown);
Deno.addSignalListener("SIGTERM", handleShutdown);

if (import.meta.main) {
  const backgroundLog = backgroundLogFile();
  if (backgroundLog) {
    // This process is the server half of a background launch. Its request
    // logger already targets the log file (pino-logger.ts reads the same
    // environment variable); route console output there too, so stdout carries
    // only the readiness marker, and record uncaught errors that would
    // otherwise reach a discarded stderr.
    redirectConsoleToFile(backgroundLog);
    logUncaughtErrors();
    startServer(writeListeningMarker);
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
      startServer();
    }
  }
}

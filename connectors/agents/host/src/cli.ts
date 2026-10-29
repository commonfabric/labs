import { loadAgentsHostConfig } from "./config.ts";
import { AGENTS_HOST_USAGE, parseAgentsHostCliOptions } from "./cli-options.ts";
import { CollectionRequestQueue } from "./collection-request-queue.ts";
import { type RunningAgentsHost, startAgentsHost } from "./start.ts";

export interface AgentsHostCliDependencies {
  readEnv: (key: string) => string | undefined;
  start: typeof startAgentsHost;
  addSignalListener: typeof Deno.addSignalListener;
  removeSignalListener: typeof Deno.removeSignalListener;
  scheduleEvery: (
    intervalMs: number,
    callback: () => void,
  ) => () => void;
  log: typeof console.log;
  error: typeof console.error;
}

const defaultDependencies: AgentsHostCliDependencies = {
  readEnv: (key) => Deno.env.get(key),
  start: startAgentsHost,
  addSignalListener: Deno.addSignalListener,
  removeSignalListener: Deno.removeSignalListener,
  scheduleEvery: (intervalMs, callback) => {
    const interval = setInterval(callback, intervalMs);
    return () => clearInterval(interval);
  },
  log: console.log,
  error: console.error,
};

export async function runAgentsHostCli(
  argv: string[] = Deno.args,
  dependencies: AgentsHostCliDependencies = defaultDependencies,
): Promise<number> {
  let running: RunningAgentsHost | undefined;
  const startupAbort = new AbortController();
  const shutdown = Promise.withResolvers<"SIGINT" | "SIGTERM">();
  let startupCancellation: Error | undefined;
  let startupInProgress = false;
  let stopAttempted = false;
  let collectionRequests: CollectionRequestQueue | undefined;
  let stopPeriodicCollection: (() => void) | undefined;
  const installedSignals: Array<[Deno.Signal, () => void]> = [];

  const terminate = (signal: "SIGINT" | "SIGTERM") => {
    if (startupInProgress && !startupAbort.signal.aborted) {
      startupCancellation = new Error(`received ${signal}`);
      startupAbort.abort(startupCancellation);
    }
    shutdown.resolve(signal);
  };
  const onSigint = () => terminate("SIGINT");
  const onSigterm = () => terminate("SIGTERM");
  const onSighup = () => {
    if (!collectionRequests) {
      dependencies.log("Ignoring SIGHUP while startup is still in progress");
      return;
    }
    const result = collectionRequests.request("SIGHUP");
    if (result === "queued") {
      dependencies.log(
        "SIGHUP received; one follow-up full collection is pending",
      );
    } else if (result === "already-queued") {
      dependencies.log(
        "SIGHUP received; the pending full collection already covers it",
      );
    }
  };
  const addSignal = (signal: Deno.Signal, listener: () => void) => {
    dependencies.addSignalListener(signal, listener);
    installedSignals.push([signal, listener]);
  };

  try {
    const options = parseAgentsHostCliOptions(argv, dependencies.readEnv);
    if (options.help) {
      dependencies.log(AGENTS_HOST_USAGE);
      return 0;
    }
    const config = await loadAgentsHostConfig(options.configPath);

    addSignal("SIGINT", onSigint);
    addSignal("SIGTERM", onSigterm);
    addSignal("SIGHUP", onSighup);
    startupInProgress = true;
    try {
      running = await dependencies.start({
        apiUrl: options.apiUrl,
        identityPath: options.identityPath,
        ownerDid: config.ownerDid,
        space: options.space,
        sources: config.sources,
        checkoutRoots: config.checkoutRoots,
        commandProducers: config.commandProducers,
        debugView: options.debugView,
        acceptCommands: !options.once,
        signal: startupAbort.signal,
      });
      if (!options.once) {
        collectionRequests = new CollectionRequestQueue(async (reason) => {
          dependencies.log(`${reason} collection started`);
          try {
            const sessionCount = await running!.host.synchronize(reason);
            dependencies.log(
              `${reason} collection completed with ${sessionCount} sessions`,
            );
          } catch (error) {
            dependencies.error(`${reason} collection failed: ${error}`);
          }
        });
      }
    } finally {
      startupInProgress = false;
    }
    dependencies.log(
      `Agent host synchronized ${running.initialSessionCount} sessions in ${running.spaceDid}`,
    );
    dependencies.log(
      `Command cell: ${running.host.health().target.cells.commands}`,
    );
    dependencies.log(
      `Receipt cell: ${running.host.health().target.cells.receipts}`,
    );
    dependencies.log(`Command ledger: ${running.ledgerPath}`);
    if (running.debugPieceId) {
      dependencies.log(`Debug view piece: ${running.debugPieceId}`);
    }
    for (const producer of running.commandProducers) {
      dependencies.log(
        `Command producer ${producer.id}: ${producer.commandCellId} (piece ${producer.piece})`,
      );
    }

    if (options.once) {
      stopAttempted = true;
      await running.stop("once-complete");
      return 0;
    }

    if (config.collectionIntervalMs > 0) {
      stopPeriodicCollection = dependencies.scheduleEvery(
        config.collectionIntervalMs,
        () => collectionRequests?.request("periodic"),
      );
    }
    dependencies.log(
      config.collectionIntervalMs > 0
        ? `Ready; collecting every ${config.collectionIntervalMs}ms, send SIGHUP to collect sooner, or SIGINT/SIGTERM to stop`
        : "Ready; send SIGHUP to collect again, or SIGINT/SIGTERM to stop",
    );
    const signal = await shutdown.promise;
    dependencies.log(`${signal} received; shutting down`);
    stopPeriodicCollection?.();
    stopPeriodicCollection = undefined;
    const collectionDrain = collectionRequests?.close();
    stopAttempted = true;
    await running.stop(signal);
    await collectionDrain;
    return 0;
  } catch (error) {
    if (running && !stopAttempted) {
      stopAttempted = true;
      await running.stop("cli-error").catch((stopError) => {
        dependencies.error(`Agent host cleanup failed: ${stopError}`);
      });
    }
    if (!running && error === startupCancellation) return 0;
    dependencies.error(
      `Agent host failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  } finally {
    stopPeriodicCollection?.();
    await collectionRequests?.close();
    for (const [signal, listener] of installedSignals.reverse()) {
      dependencies.removeSignalListener(signal, listener);
    }
  }
}

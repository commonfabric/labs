import {
  createGithubGraphqlTransport,
  GithubClient,
} from "@commonfabric/github-connector/client";
import { resolveGithubToken } from "./auth.ts";
import { CollectionRequestQueue } from "./collection-request-queue.ts";
import { GITHUB_HOST_USAGE, parseGithubHostCliOptions } from "./cli-options.ts";
import { loadGithubHostConfig } from "./config.ts";
import {
  type GithubFabricRuntime,
  openGithubFabricRuntime,
} from "./fabric-runtime.ts";
import { GithubHost } from "./host.ts";
import {
  GithubHostProcessLock,
  githubTargetProcessLockPath,
} from "./process-lock.ts";

export interface GithubHostCliDependencies {
  readEnv: (key: string) => string | undefined;
  resolveToken: typeof resolveGithubToken;
  openFabric: typeof openGithubFabricRuntime;
  acquireProcessLock: (
    path: string,
  ) => Promise<{ release(): Promise<void> }>;
  createClient: (token: string, endpoint: string) => GithubClient;
  addSignalListener: typeof Deno.addSignalListener;
  removeSignalListener: typeof Deno.removeSignalListener;
  scheduleEvery: (intervalMs: number, callback: () => void) => () => void;
  log: typeof console.log;
  error: typeof console.error;
}

const defaultDependencies: GithubHostCliDependencies = {
  readEnv: (key) => Deno.env.get(key),
  resolveToken: resolveGithubToken,
  openFabric: openGithubFabricRuntime,
  acquireProcessLock: GithubHostProcessLock.acquire,
  createClient: (token, endpoint) =>
    new GithubClient(createGithubGraphqlTransport({ token, endpoint })),
  addSignalListener: Deno.addSignalListener,
  removeSignalListener: Deno.removeSignalListener,
  scheduleEvery: (intervalMs, callback) => {
    const interval = setInterval(callback, intervalMs);
    return () => clearInterval(interval);
  },
  log: console.log,
  error: console.error,
};

/** Run the laptop GitHub host until one collection or a shutdown signal. */
export async function runGithubHostCli(
  argv: string[] = Deno.args,
  dependencies: GithubHostCliDependencies = defaultDependencies,
): Promise<number> {
  let fabric: GithubFabricRuntime | undefined;
  let host: GithubHost | undefined;
  let queue: CollectionRequestQueue | undefined;
  let stopPeriodic: (() => void) | undefined;
  let activeCollection: AbortController | undefined;
  let processLock: { release(): Promise<void> } | undefined;
  const shutdown = Promise.withResolvers<"SIGINT" | "SIGTERM">();
  const installedSignals: Array<[Deno.Signal, () => void]> = [];
  const addSignal = (signal: Deno.Signal, listener: () => void) => {
    dependencies.addSignalListener(signal, listener);
    installedSignals.push([signal, listener]);
  };

  try {
    const options = parseGithubHostCliOptions(argv, dependencies.readEnv);
    if (options.help) {
      dependencies.log(GITHUB_HOST_USAGE);
      return 0;
    }
    const config = await loadGithubHostConfig(options.configPath);
    const token = await dependencies.resolveToken(dependencies.readEnv);
    fabric = await dependencies.openFabric({
      ...options,
      githubHost: new URL(config.graphqlEndpoint).host,
      githubAccount: config.account,
    });
    processLock = await dependencies.acquireProcessLock(
      await githubTargetProcessLockPath(
        options.apiUrl,
        fabric.spaceDid,
        `${new URL(config.graphqlEndpoint).host}/${config.account}`,
      ),
    );
    const client = dependencies.createClient(token, config.graphqlEndpoint);
    host = new GithubHost({
      client,
      target: fabric.target,
      spaceDid: fabric.spaceDid,
    });
    await host.start();

    const collect = async (reason: string) => {
      const controller = new AbortController();
      activeCollection = controller;
      dependencies.log(`${reason} GitHub collection started`);
      try {
        const count = await host!.synchronize(reason, controller.signal);
        dependencies.log(
          `${reason} GitHub collection completed with ${count} pull requests`,
        );
      } catch (error) {
        dependencies.error(
          `${reason} GitHub collection failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (options.once) throw error;
      } finally {
        if (activeCollection === controller) activeCollection = undefined;
      }
    };

    try {
      await collect("initial");
    } catch {
      return 1;
    }
    dependencies.log(
      `GitHub pull-request index: ${fabric.target.indexCellId()}`,
    );
    dependencies.log(`GitHub host health: ${fabric.target.healthCellId()}`);
    if (options.once) {
      await host.stop();
      return 0;
    }

    queue = new CollectionRequestQueue(collect);
    const terminate = (signal: "SIGINT" | "SIGTERM") => {
      activeCollection?.abort(new Error(`received ${signal}`));
      shutdown.resolve(signal);
    };
    const onSigint = () => terminate("SIGINT");
    const onSigterm = () => terminate("SIGTERM");
    const onSighup = () => queue?.request("SIGHUP");
    addSignal("SIGINT", onSigint);
    addSignal("SIGTERM", onSigterm);
    addSignal("SIGHUP", onSighup);
    if (config.collectionIntervalMs > 0) {
      stopPeriodic = dependencies.scheduleEvery(
        config.collectionIntervalMs,
        () => queue?.request("periodic"),
      );
    }
    dependencies.log(
      config.collectionIntervalMs > 0
        ? `Ready; collecting every ${config.collectionIntervalMs}ms, send SIGHUP to collect sooner, or SIGINT/SIGTERM to stop`
        : "Ready; send SIGHUP to collect again, or SIGINT/SIGTERM to stop",
    );
    const signal = await shutdown.promise;
    dependencies.log(`${signal} received; shutting down`);
    stopPeriodic?.();
    stopPeriodic = undefined;
    await queue.close();
    await host.stop();
    return 0;
  } catch (error) {
    dependencies.error(
      `GitHub host failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  } finally {
    stopPeriodic?.();
    activeCollection?.abort(new Error("GitHub host is stopping"));
    await queue?.close();
    for (const [signal, listener] of installedSignals.reverse()) {
      dependencies.removeSignalListener(signal, listener);
    }
    if (fabric) {
      await fabric.runtime.settled(Infinity).catch((error) =>
        dependencies.error(`GitHub runtime did not settle: ${error}`)
      );
      await fabric.runtime.storageManager.synced().catch((error) =>
        dependencies.error(`GitHub runtime did not synchronize: ${error}`)
      );
      await fabric.runtime.dispose().catch((error) =>
        dependencies.error(`GitHub runtime cleanup failed: ${error}`)
      );
    }
    await processLock?.release().catch((error) =>
      dependencies.error(`GitHub process-lock cleanup failed: ${error}`)
    );
  }
}

import { CommandLedger } from "@commonfabric/agents-connector/command-ledger";
import { createAgentDriver } from "@commonfabric/agents-connector/create-driver";
import type {
  AgentDriver,
  AgentSourceConfig,
} from "@commonfabric/agents-connector/types";
import type { Runtime } from "@commonfabric/runner";
import {
  bindCommandProducers,
  type BoundCommandProducer,
} from "./command-producers.ts";
import type { CommandProducerConfig } from "./config.ts";
import {
  deployAgentSessionsDebugView,
  describeAgentFabricTarget,
} from "./debug-view.ts";
import {
  type AgentFabricRuntime,
  openAgentFabricRuntime,
} from "./fabric-runtime.ts";
import { AgentsHost } from "./host.ts";
import {
  AgentsHostProcessLock,
  defaultTargetProcessLockPath,
} from "./process-lock.ts";
import { defaultTargetLedgerPath } from "./target-state.ts";
import { abortable } from "./abort.ts";

function failureSummary(failures: unknown[]): string {
  return failures.map((error) =>
    error instanceof Error ? error.message : String(error)
  ).join("; ");
}

export interface StartAgentsHostOptions {
  apiUrl: string;
  identityPath: string;
  ownerDid: string;
  space: string;
  sources: AgentSourceConfig[];
  checkoutRoots?: string[];
  commandProducers?: CommandProducerConfig[];
  targetLockPath?: string;
  debugView?: boolean;
  acceptCommands?: boolean;
  signal?: AbortSignal;
  createDriver?: (config: AgentSourceConfig) => AgentDriver;
}

interface HostProcessLock {
  release(): Promise<void>;
}

export interface StartAgentsHostDependencies {
  openFabric: typeof openAgentFabricRuntime;
  targetLockPath: typeof defaultTargetProcessLockPath;
  acquireProcessLock: (path: string) => Promise<HostProcessLock>;
  ledgerPath: typeof defaultTargetLedgerPath;
  deployDebugView: typeof deployAgentSessionsDebugView;
  bindCommandProducers: typeof bindCommandProducers;
  openLedger: typeof CommandLedger.open;
  describeTarget: typeof describeAgentFabricTarget;
  createHost: (
    options: ConstructorParameters<typeof AgentsHost>[0],
  ) => AgentsHost;
}

const defaultDependencies: StartAgentsHostDependencies = {
  openFabric: openAgentFabricRuntime,
  targetLockPath: defaultTargetProcessLockPath,
  acquireProcessLock: AgentsHostProcessLock.acquire,
  ledgerPath: defaultTargetLedgerPath,
  deployDebugView: deployAgentSessionsDebugView,
  bindCommandProducers,
  openLedger: CommandLedger.open,
  describeTarget: describeAgentFabricTarget,
  createHost: (options) => new AgentsHost(options),
};

export class RunningAgentsHost {
  readonly host: AgentsHost;
  readonly runtime: Runtime;
  readonly #graphRuntime?: Runtime;
  readonly spaceDid: string;
  readonly debugPieceId?: string;
  readonly commandProducers: readonly BoundCommandProducer[];
  readonly initialSessionCount: number;
  readonly ledgerPath: string;
  readonly #processLocks: HostProcessLock[];
  #stopTask?: Promise<void>;

  constructor(options: {
    host: AgentsHost;
    fabric: AgentFabricRuntime;
    debugPieceId?: string;
    commandProducers?: readonly BoundCommandProducer[];
    initialSessionCount: number;
    ledgerPath: string;
    processLocks: HostProcessLock[];
  }) {
    this.host = options.host;
    this.runtime = options.fabric.runtime;
    this.#graphRuntime = options.fabric.graphRuntime;
    this.spaceDid = options.fabric.spaceDid;
    this.debugPieceId = options.debugPieceId;
    this.commandProducers = [...(options.commandProducers ?? [])];
    this.initialSessionCount = options.initialSessionCount;
    this.ledgerPath = options.ledgerPath;
    this.#processLocks = [...options.processLocks];
  }

  stop(reason = "requested"): Promise<void> {
    this.#stopTask ??= this.#stop(reason);
    return this.#stopTask;
  }

  async #stop(reason: string): Promise<void> {
    const failures: unknown[] = [];
    await this.host.stop(reason).catch((error) => failures.push(error));
    await this.runtime.settled(Infinity).catch((error) => failures.push(error));
    await this.runtime.storageManager.synced().catch((error) =>
      failures.push(error)
    );
    await this.#graphRuntime?.dispose().catch((error) => failures.push(error));
    await this.runtime.dispose().catch((error) => failures.push(error));
    for (const lock of [...this.#processLocks].reverse()) {
      await lock.release().catch((error) => failures.push(error));
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `agent host shutdown completed with failures: ${
          failureSummary(failures)
        }`,
      );
    }
  }
}

export async function startAgentsHost(
  options: StartAgentsHostOptions,
  dependencies: StartAgentsHostDependencies = defaultDependencies,
): Promise<RunningAgentsHost> {
  const processLocks: HostProcessLock[] = [];
  const startupTasks = new Set<Promise<unknown>>();
  let fabric: AgentFabricRuntime | undefined;
  let host: AgentsHost | undefined;
  let healthOwnership = false;
  const healthOwnershipStarted = Promise.withResolvers<void>();
  const trackStartup = <T>(task: Promise<T>): Promise<T> => {
    startupTasks.add(task);
    task.then(
      () => startupTasks.delete(task),
      () => startupTasks.delete(task),
    );
    return task;
  };
  const waitForStartup = <T>(task: Promise<T>): Promise<T> =>
    abortable(trackStartup(task), options.signal);
  try {
    options.signal?.throwIfAborted();
    fabric = await dependencies.openFabric({
      ...options,
      deferStorageClaim: true,
    });
    options.signal?.throwIfAborted();
    const targetLockPath = options.targetLockPath ??
      await dependencies.targetLockPath(
        options.apiUrl,
        fabric.spaceDid,
        fabric.ownerDid,
      );
    options.signal?.throwIfAborted();
    processLocks.push(await dependencies.acquireProcessLock(targetLockPath));
    options.signal?.throwIfAborted();
    await waitForStartup(fabric.target.claimStorage());
    options.signal?.throwIfAborted();
    const ledgerPath = await dependencies.ledgerPath(
      options.apiUrl,
      fabric.spaceDid,
      fabric.ownerDid,
    );
    options.signal?.throwIfAborted();
    processLocks.push(
      await dependencies.acquireProcessLock(`${ledgerPath}.lock`),
    );
    options.signal?.throwIfAborted();
    const debugPieceId = options.debugView === false
      ? undefined
      : await waitForStartup(
        dependencies.deployDebugView(
          fabric.manager,
          fabric.target,
          undefined,
          options.signal,
        ),
      );
    options.signal?.throwIfAborted();
    const commandProducers = options.commandProducers?.length
      ? await waitForStartup(
        dependencies.bindCommandProducers(
          fabric.manager,
          fabric.target,
          options.commandProducers,
          options.signal,
        ),
      )
      : [];
    options.signal?.throwIfAborted();
    const ledger = await waitForStartup(
      dependencies.openLedger(ledgerPath),
    );
    options.signal?.throwIfAborted();
    host = dependencies.createHost({
      sources: options.sources,
      checkoutRoots: options.checkoutRoots,
      target: fabric.target,
      targetDescription: dependencies.describeTarget(
        fabric.target,
        fabric.spaceDid,
        debugPieceId,
        commandProducers,
      ),
      ledger,
      createDriver: options.createDriver ?? createAgentDriver,
    });
    const hostStartTask = trackStartup(host.start({
      signal: options.signal,
      acceptCommands: options.acceptCommands !== false &&
        fabric.target.commandsAreBound(),
      deferHealthUntilReady: true,
      onHealthOwnership: () => {
        healthOwnership = true;
        healthOwnershipStarted.resolve();
      },
    }));
    const beforeOwnership = await abortable(
      Promise.race([
        hostStartTask.then((sessionCount) => ({
          phase: "complete" as const,
          sessionCount,
        })),
        healthOwnershipStarted.promise.then(() => ({
          phase: "owned" as const,
        })),
      ]),
      options.signal,
    );
    const initialSessionCount = beforeOwnership.phase === "complete"
      ? beforeOwnership.sessionCount
      : await hostStartTask;
    return new RunningAgentsHost({
      host,
      fabric,
      debugPieceId,
      commandProducers,
      initialSessionCount,
      ledgerPath,
      processLocks,
    });
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    const outstandingStartupTasks = [...startupTasks];
    if (options.signal?.aborted && !healthOwnership) {
      const stopTask = host?.stop("startup-cancelled", {
        flushPendingReceipts: false,
        interruptInFlight: true,
        publishHealth: false,
      });
      const startupResults = await Promise.allSettled(outstandingStartupTasks);
      for (const result of startupResults) {
        if (
          result.status === "rejected" &&
          result.reason !== options.signal.reason
        ) {
          cleanupFailures.push(result.reason);
        }
      }
      const stopResults = await Promise.allSettled(
        stopTask ? [stopTask] : [],
      );
      for (const result of stopResults) {
        if (result.status === "rejected") {
          cleanupFailures.push(result.reason);
        }
      }
      await fabric?.runtime.settled(Infinity).catch((settledError) => {
        cleanupFailures.push(settledError);
      });
      await fabric?.graphRuntime?.dispose().catch((disposeError) => {
        cleanupFailures.push(disposeError);
      });
      await fabric?.runtime.dispose().catch((disposeError) => {
        cleanupFailures.push(disposeError);
      });
    } else {
      const stopReason = options.signal?.aborted
        ? "startup-owned-shutdown"
        : "startup-failed";
      await host?.stop(stopReason).catch((stopError) => {
        cleanupFailures.push(stopError);
      });
      await fabric?.runtime.settled(Infinity).catch((settledError) => {
        cleanupFailures.push(settledError);
      });
      await fabric?.graphRuntime?.dispose().catch((disposeError) => {
        cleanupFailures.push(disposeError);
      });
      await fabric?.runtime.dispose().catch((disposeError) => {
        cleanupFailures.push(disposeError);
      });
    }
    if (options.signal?.aborted && healthOwnership) {
      const startupResults = await Promise.allSettled(outstandingStartupTasks);
      for (const result of startupResults) {
        if (
          result.status === "rejected" &&
          result.reason !== options.signal.reason
        ) {
          cleanupFailures.push(result.reason);
        }
      }
    }
    for (const processLock of processLocks.reverse()) {
      await processLock.release().catch((lockError) => {
        cleanupFailures.push(lockError);
      });
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        `agent host startup and cleanup failed: ${
          failureSummary([error, ...cleanupFailures])
        }`,
      );
    }
    throw error;
  }
}

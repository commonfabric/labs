/**
 * In-process equivalents of a toolshed running the server-execution ON
 * posture: a memory server with an `ExecutorHost` serving loop attached to
 * it, the host's runtimes built by the same {@link servingRuntimeFactory}
 * toolshed uses. A test that runs its runtimes ON needs one of these, because
 * a memory server with no serving loop accepts the events an ON client sends
 * and never delivers them.
 *
 * Two shapes, by how the test's clients connect:
 *
 * - {@link startServingMemoryServer} is reached in-process only, by
 *   `EmulatedStorageManager.connectTo(served.server, ...)`. Its session opens
 *   are authorized by `authorizeLoopbackSessionOpen()`: the serving runtimes'
 *   signed opens are verified, as toolshed's are, and a client's unsigned
 *   open is trusted as the principal it names.
 * - {@link listenServingMemoryServer} also listens on a localhost websocket,
 *   at `url`, for runtimes built with the `remoteClient` preset — in this
 *   realm, in a Deno Worker, or in a subprocess. Its session opens are
 *   verified signatures, as toolshed's are.
 *
 * Either runs its loop on this thread over a non-persistent store, or, as a
 * toolshed does under `SERVER_EXECUTION_WORKER`, in a Worker of this process
 * over a store in a temporary directory ({@link ServingMemoryServerOptions}'
 * `worker`).
 *
 * The loop's work runs in the serving context, so a test hosting its clients
 * in the same realm tells their output apart with {@link inServingContext}.
 *
 * Neither publishes a posture on `/api/meta`, so a client that adopts its
 * server's flags resolves the posture from its own environment and default;
 * a test pairs one of these with clients resolving ON. The host is a process
 * enabler of the ambient server-execution flag while it lives, so a runtime in
 * the same realm that asks for the OFF posture does not get it.
 *
 * Deno-only, because the listening shape uses `Deno.serve` and the worker
 * shape a temporary directory.
 */

import { toFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import {
  getLoggerCountsBreakdown,
  getTimingStatsBreakdown,
} from "@commonfabric/logger";
import type { ExperimentalOptions } from "../runtime.ts";
import { newLoopbackServer } from "../storage/v2-emulate.ts";
import { ExecutorHost, type ExecutorHostOptions } from "./host.ts";
import {
  servingRuntimeFactory,
  type ServingRuntimeFactoryOptions,
} from "./serving-runtime.ts";
import {
  type ServingLoopHandle,
  ServingWorker,
} from "./serving-worker-host.ts";
import type { SpaceServerPolicy } from "./space-server.ts";

export { inServingContext } from "./serving-context.ts";

/** A memory server with a serving loop attached, for one test to own. */
export interface ServingMemoryServer extends AsyncDisposable {
  /** The memory server, for in-process clients and for the host's hooks. */
  readonly server: MemoryV2Server.Server;

  /**
   * The serving loop attached to {@link ServingMemoryServer.server}: its
   * counters, its close, and its `ExecutorHost` when it runs on this thread.
   */
  readonly host: ServingLoopHandle;

  /** The identity the serving runtimes open their sessions as. */
  readonly serviceIdentity: Identity;

  /**
   * Resolves once the memory server has applied every commit it received and
   * sent the fan-out they produced. The serving loop's own waves are not part
   * of this: a served consequence of an event may still be in flight.
   */
  idle(): Promise<void>;

  /** Closes the serving loop, then the memory server. */
  close(): Promise<void>;
}

/** A {@link ServingMemoryServer} that also listens on a localhost websocket. */
export interface ListeningServingMemoryServer extends ServingMemoryServer {
  /** Where a `remoteClient` runtime finds this server, as `apiUrl` too. */
  readonly url: URL;
}

/** What both shapes of serving memory server take. */
export type ServingMemoryServerOptions =
  & {
    /**
     * The serving runtimes' session identity, and the host's service
     * identity. Default: a freshly generated one.
     */
    serviceIdentity?: Identity;

    /**
     * Experimental flags for the serving runtimes, beneath the ones every
     * serving runtime forces. Default: none.
     */
    experimental?: ExperimentalOptions;

    /** As `servingRuntimeFactory()` takes it. */
    prepareStorageManager?: ServingRuntimeFactoryOptions[
      "prepareStorageManager"
    ];

    /**
     * The serving runtimes' outbound `fetch`, as `servingRuntimeFactory()`
     * takes it. A test that stubs its own runtime's `fetch` passes the same
     * stub here, since a served handler's fetches go through this one.
     */
    fetch?: ServingRuntimeFactoryOptions["fetch"];

    /** As `servingRuntimeFactory()` takes it. */
    moduleByteCache?: ServingRuntimeFactoryOptions["moduleByteCache"];

    /**
     * Whether each served space gets its default pattern on activation.
     * Default: `false`, which is the switch the serving loop keeps for tests;
     * a deployment always ensures them.
     */
    ensureSpaceRoots?: boolean;

    /**
     * Whether the serving loop runs in a Worker of this process, over a store
     * in a temporary directory, as a toolshed's does under
     * `SERVER_EXECUTION_WORKER`. Default: `true` when that variable is the
     * literal `true` in this process's environment, so a run with it set
     * runs every test that leaves this unset under the worker. A worker
     * takes no closure, so `prepareStorageManager`, `fetch`,
     * `moduleByteCache`, a policy field holding a function, and the host's
     * diagnostic hooks other than `onActivationSettled` and `onSpaceParked`
     * are refused under it; a test that needs one says `false` here.
     *
     * The environment fills three more of the policy's fields when they are
     * left unset, as a toolshed's bootstrap does: `storeReadThrough` takes
     * `true` when `SERVER_EXECUTION_STORE_READ_THROUGH` is the literal
     * `true`, `overlapWaveCommit` takes `true` when
     * `SERVER_EXECUTION_OVERLAP_COMMIT` is, and `flushDeadlineMs` and
     * `flushDeadlineMaxMs` take `SERVER_EXECUTION_FLUSH_DEADLINE_MS` and
     * `SERVER_EXECUTION_FLUSH_DEADLINE_MAX_MS` when those are positive
     * decimal integers.
     */
    worker?: boolean;
  }
  & Omit<
    ExecutorHostOptions,
    "server" | "serviceIdentity" | "createRuntime" | "ensureSpaceRoots"
  >;

/** The temporary directory a worker-mode server keeps its spaces in. */
type TemporaryStore = { url: URL; remove: () => Promise<void> };

const temporaryStore = async (): Promise<TemporaryStore> => {
  const directory = await Deno.makeTempDir({
    prefix: "serving-memory-server-",
  });
  return {
    url: toFileUrl(`${directory}/`),
    remove: () => Deno.remove(directory, { recursive: true }),
  };
};

/**
 * Whether a serving memory server given `options` runs its loop in a worker,
 * by their own `worker` or else by the environment. A caller that hands the
 * loop a closure only where the loop shares its thread asks this first.
 */
export function runsInWorker(
  options: Pick<ServingMemoryServerOptions, "worker"> = {},
): boolean {
  return options.worker ?? Deno.env.get("SERVER_EXECUTION_WORKER") === "true";
}

/** The longest delay a timer takes; a longer one fires at once. */
const TIMER_DELAY_MAX_MS = 2_147_483_647;

/**
 * The loop's policy, with what `policy` leaves unset taken from the
 * environment as the toolshed bootstrap takes it: the store read-through
 * from `SERVER_EXECUTION_STORE_READ_THROUGH` and the overlapped wave commit
 * from `SERVER_EXECUTION_OVERLAP_COMMIT`, each on for the literal `true`,
 * and the flush deadline and the cap it grows to from
 * `SERVER_EXECUTION_FLUSH_DEADLINE_MS` and
 * `SERVER_EXECUTION_FLUSH_DEADLINE_MAX_MS`, positive decimal integers of
 * milliseconds. A lane sets the first two to run every test that leaves them
 * unset under the posture; a benchmark sets the others to measure a cadence.
 */
const policyFromEnvironment = (
  policy: SpaceServerPolicy | undefined,
): SpaceServerPolicy | undefined => {
  let resolved = policy;
  if (
    resolved?.storeReadThrough === undefined &&
    Deno.env.get("SERVER_EXECUTION_STORE_READ_THROUGH") === "true"
  ) {
    resolved = { ...resolved, storeReadThrough: true };
  }
  if (
    resolved?.overlapWaveCommit === undefined &&
    Deno.env.get("SERVER_EXECUTION_OVERLAP_COMMIT") === "true"
  ) {
    resolved = { ...resolved, overlapWaveCommit: true };
  }
  // A positive decimal integer, as the toolshed bootstrap reads it; a
  // fraction, an exponent or a prefix would select a cadence the toolshed
  // refuses. The deadline arms a timer, and a delay past a timer's range
  // fires at once, so a value past it reads as unset rather than as a
  // cadence of immediate cuts.
  const milliseconds = (name: string): number | undefined => {
    const raw = Deno.env.get(name) ?? "";
    const value = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0;
    return value > 0 && value <= TIMER_DELAY_MAX_MS ? value : undefined;
  };
  if (resolved?.flushDeadlineMs === undefined) {
    const deadline = milliseconds("SERVER_EXECUTION_FLUSH_DEADLINE_MS");
    if (deadline !== undefined) {
      resolved = { ...resolved, flushDeadlineMs: deadline };
    }
  }
  if (resolved?.flushDeadlineMaxMs === undefined) {
    const max = milliseconds("SERVER_EXECUTION_FLUSH_DEADLINE_MAX_MS");
    if (max !== undefined) resolved = { ...resolved, flushDeadlineMaxMs: max };
  }
  return resolved;
};

/**
 * Starts a {@link ServingMemoryServer} reached in-process only, over a fresh
 * non-persistent store, or a temporary file store under the worker.
 */
export async function startServingMemoryServer(
  options: ServingMemoryServerOptions & {
    /** The serving runtimes' patterns and compile base. */
    apiUrl: URL;

    /**
     * The memory server's fan-out cadence, as `newLoopbackServer()` takes it.
     * Default: `0`, a flush on the next turn of the event loop.
     */
    subscriptionRefreshDelayMs?: number | "manual";
  },
): Promise<ServingMemoryServer> {
  const {
    apiUrl,
    subscriptionRefreshDelayMs = 0,
    ...hostOptions
  } = options;
  const serviceIdentity = options.serviceIdentity ?? await Identity.generate();
  const worker = runsInWorker(options);
  const store = worker ? await temporaryStore() : undefined;
  const server = newLoopbackServer({
    store: store?.url ??
      new URL(`memory://serving-memory-server-${crypto.randomUUID()}`),
    subscriptionRefreshDelayMs,
  });
  return await attachServingLoop({
    server,
    apiUrl,
    serviceIdentity,
    options: hostOptions,
    worker,
    idle: () => server.idle(),
    close: async () => {
      await server.close();
      await store?.remove();
    },
  });
}

/**
 * Starts a {@link ListeningServingMemoryServer} on an ephemeral localhost
 * port, over a fresh non-persistent store, or a temporary file store under
 * the worker. Plain HTTP requests are answered as
 * `StandaloneMemoryServer.start()` answers them, by `serve` first.
 */
export async function listenServingMemoryServer(
  options: ServingMemoryServerOptions & {
    /**
     * The serving runtimes' patterns and compile base. Default: this
     * server's own `url`, which `serve` answers pattern requests on.
     */
    apiUrl?: URL;

    /**
     * Answers the plain HTTP requests this address receives, as
     * `StandaloneMemoryServer.start()` takes it.
     */
    serve?: (
      request: Request,
    ) => Response | undefined | Promise<Response | undefined>;

    /**
     * The memory server's access-list mode. When given, the service identity
     * is the server's one delegating principal, as a toolshed running server
     * execution lists its own process identity, and no principal is a
     * service principal. Absent, the server has no access-list
     * configuration at all: `off`, with no delegating principal.
     */
    aclMode?: MemoryV2Server.MemoryAclMode;
  } = {},
): Promise<ListeningServingMemoryServer> {
  const { apiUrl, serve: answer, aclMode, ...hostOptions } = options;
  const serviceIdentity = options.serviceIdentity ?? await Identity.generate();
  const worker = runsInWorker(options);
  const store = worker ? await temporaryStore() : undefined;
  const standalone = StandaloneMemoryServer.start({
    ...(aclMode !== undefined
      ? { acl: { mode: aclMode, delegatingDids: [serviceIdentity.did()] } }
      : {}),
    ...(answer !== undefined ? { serve: answer } : {}),
    ...(store === undefined ? {} : { store: store.url }),
  });
  const served = await attachServingLoop({
    server: standalone.server,
    apiUrl: apiUrl ?? standalone.url,
    serviceIdentity,
    options: hostOptions,
    worker,
    idle: () => standalone.idle(),
    close: async () => {
      await standalone.close();
      await store?.remove();
    },
  });
  return { ...served, url: standalone.url };
}

/**
 * The options of a serving memory server a worker cannot take: each is a
 * closure, which the worker's port does not carry.
 */
const WORKER_REFUSED_OPTIONS = [
  "prepareStorageManager",
  "fetch",
  "moduleByteCache",
  "decorateWaveCommitSink",
  "createWaveCommitSink",
  "onWaveCycle",
  "onEventDrainPass",
  "onEventDeferred",
  "onDrainInFlightSkip",
  "onEffectRetired",
] as const satisfies ReadonlyArray<keyof ServingMemoryServerOptions>;

/**
 * Helper for both shapes, which attaches the loop to `server`, on this
 * thread or in a worker, and ties the two lifetimes together.
 */
async function attachServingLoop(params: {
  server: MemoryV2Server.Server;
  apiUrl: URL;
  serviceIdentity: Identity;
  options: ServingMemoryServerOptions;
  worker: boolean;
  idle: () => Promise<void>;
  close: () => Promise<void>;
}): Promise<ServingMemoryServer> {
  const { serviceIdentity } = params;
  const {
    serviceIdentity: _serviceIdentity,
    worker: _worker,
    experimental,
    prepareStorageManager,
    fetch,
    moduleByteCache,
    ensureSpaceRoots = false,
    ...hostOptions
  } = params.options;
  const policy = policyFromEnvironment(hostOptions.policy);
  let loop: ServingLoopHandle;
  if (params.worker) {
    const refused: string[] = WORKER_REFUSED_OPTIONS.filter((name) =>
      params.options[name] !== undefined
    );
    for (const [field, value] of Object.entries(policy ?? {})) {
      if (typeof value === "function") refused.push(`policy.${field}`);
    }
    if (refused.length > 0) {
      await params.close();
      throw new Error(
        `a serving memory server in a worker takes no ${
          refused.join(", ")
        }: each is a closure, which the worker's port does not carry; ` +
          "pass `worker: false` to run the loop on this thread",
      );
    }
    let worker: ServingWorker | undefined;
    try {
      worker = new ServingWorker({
        server: params.server,
        identity: serviceIdentity,
        apiUrl: params.apiUrl,
        ensureSpaceRoots,
        ...(policy === undefined ? {} : { policy }),
        ...(experimental === undefined ? {} : { experimental }),
        ...(hostOptions.onActivationSettled === undefined
          ? {}
          : { onActivationSettled: hostOptions.onActivationSettled }),
        ...(hostOptions.onSpaceParked === undefined
          ? {}
          : { onSpaceParked: hostOptions.onSpaceParked }),
      });
      await worker.ready;
    } catch (error) {
      await worker?.close();
      await params.close();
      throw error;
    }
    loop = {
      stats: () => worker.stats(),
      diagnostics: () => worker.diagnostics(),
      host: undefined,
      close: () => worker.close(),
    };
  } else {
    const host = new ExecutorHost({
      ...hostOptions,
      ...(policy === undefined ? {} : { policy }),
      ensureSpaceRoots,
      server: params.server,
      serviceIdentity: serviceIdentity.did(),
      createRuntime: servingRuntimeFactory({
        server: params.server,
        identity: serviceIdentity,
        apiUrl: params.apiUrl,
        experimental,
        prepareStorageManager,
        ...(fetch !== undefined ? { fetch } : {}),
        ...(moduleByteCache !== undefined ? { moduleByteCache } : {}),
      }),
    });
    loop = {
      stats: () => host.stats(),
      diagnostics: () =>
        Promise.resolve({
          loggerCounts: getLoggerCountsBreakdown(),
          timingStats: getTimingStatsBreakdown(),
        }),
      host,
      close: () => host.close(),
    };
  }
  let closed: Promise<void> | undefined;
  const close = () =>
    closed ??= (async () => {
      try {
        await loop.close();
      } finally {
        await params.close();
      }
    })();
  return {
    server: params.server,
    host: loop,
    serviceIdentity,
    idle: params.idle,
    close,
    [Symbol.asyncDispose]: close,
  };
}

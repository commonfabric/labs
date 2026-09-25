/**
 * In-process equivalents of a toolshed running the server-execution ON
 * posture: a memory server over a non-persistent store with an
 * `ExecutorHost` serving loop attached to it, the host's runtimes built by
 * the same {@link servingRuntimeFactory} toolshed uses. A test that runs its
 * runtimes ON needs one of these, because a memory server with no serving
 * loop accepts the events an ON client sends and never delivers them.
 *
 * Two shapes, by how the test's clients connect:
 *
 * - {@link startServingMemoryServer} is reached in-process only, by
 *   `EmulatedStorageManager.connectTo(served.server, ...)`. Its session opens
 *   are authorized the way `newLoopbackServer()`'s are, by the principal the
 *   envelope names.
 * - {@link listenServingMemoryServer} also listens on a localhost websocket,
 *   at `url`, for runtimes built with the `remoteClient` preset — in this
 *   realm, in a Deno Worker, or in a subprocess. Its session opens are
 *   verified signatures, as toolshed's are.
 *
 * Neither publishes a posture on `/api/meta`, so a client that adopts its
 * server's flags resolves the posture from its own environment and default;
 * a test pairs one of these with clients resolving ON. The host is a process
 * enabler of the ambient server-execution flag while it lives, so a runtime in
 * the same realm that asks for the OFF posture does not get it.
 *
 * Deno-only, because the listening shape uses `Deno.serve`.
 */

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import type { ExperimentalOptions } from "../runtime.ts";
import { newLoopbackServer } from "../storage/v2-emulate.ts";
import { ExecutorHost, type ExecutorHostOptions } from "./host.ts";
import {
  servingRuntimeFactory,
  type ServingRuntimeFactoryOptions,
} from "./serving-runtime.ts";

/** A memory server with a serving loop attached, for one test to own. */
export interface ServingMemoryServer extends AsyncDisposable {
  /** The memory server, for in-process clients and for the host's hooks. */
  readonly server: MemoryV2Server.Server;

  /** The serving loop attached to {@link ServingMemoryServer.server}. */
  readonly host: ExecutorHost;

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
     * Whether each served space gets its default pattern on activation.
     * Default: `false`, which is the switch the serving loop keeps for tests;
     * a deployment always ensures them.
     */
    ensureSpaceRoots?: boolean;
  }
  & Omit<
    ExecutorHostOptions,
    "server" | "serviceIdentity" | "createRuntime" | "ensureSpaceRoots"
  >;

/**
 * Starts a {@link ServingMemoryServer} reached in-process only, over a fresh
 * non-persistent store.
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
  const server = newLoopbackServer({
    store: new URL(`memory://serving-memory-server-${crypto.randomUUID()}`),
    subscriptionRefreshDelayMs,
  });
  return attachServingLoop({
    server,
    apiUrl,
    serviceIdentity,
    options: hostOptions,
    idle: () => server.idle(),
    close: () => server.close(),
  });
}

/**
 * Starts a {@link ListeningServingMemoryServer} on an ephemeral localhost
 * port, over a fresh non-persistent store. Plain HTTP requests are answered
 * as `StandaloneMemoryServer.start()` answers them, by `serve` first.
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
  } = {},
): Promise<ListeningServingMemoryServer> {
  const { apiUrl, serve: answer, ...hostOptions } = options;
  const serviceIdentity = options.serviceIdentity ?? await Identity.generate();
  const standalone = StandaloneMemoryServer.start(
    answer !== undefined ? { serve: answer } : {},
  );
  const served = attachServingLoop({
    server: standalone.server,
    apiUrl: apiUrl ?? standalone.url,
    serviceIdentity,
    options: hostOptions,
    idle: () => standalone.idle(),
    close: () => standalone.close(),
  });
  return { ...served, url: standalone.url };
}

/**
 * Helper for both shapes, which attaches the host to `server` and ties the
 * two lifetimes together.
 */
function attachServingLoop(params: {
  server: MemoryV2Server.Server;
  apiUrl: URL;
  serviceIdentity: Identity;
  options: ServingMemoryServerOptions;
  idle: () => Promise<void>;
  close: () => Promise<void>;
}): ServingMemoryServer {
  const { serviceIdentity } = params;
  const {
    serviceIdentity: _serviceIdentity,
    experimental,
    prepareStorageManager,
    ensureSpaceRoots = false,
    ...hostOptions
  } = params.options;
  const host = new ExecutorHost({
    ...hostOptions,
    ensureSpaceRoots,
    server: params.server,
    serviceIdentity: serviceIdentity.did(),
    createRuntime: servingRuntimeFactory({
      server: params.server,
      identity: serviceIdentity,
      apiUrl: params.apiUrl,
      experimental,
      prepareStorageManager,
    }),
  });
  let closed: Promise<void> | undefined;
  const close = () =>
    closed ??= (async () => {
      try {
        await host.close();
      } finally {
        await params.close();
      }
    })();
  return {
    server: params.server,
    host,
    serviceIdentity,
    idle: params.idle,
    close,
    [Symbol.asyncDispose]: close,
  };
}

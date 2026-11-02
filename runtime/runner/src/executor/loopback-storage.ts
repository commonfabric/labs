/**
 * The serving runtime's loopback storage plane (serving-loop.md §1 plane
 * (a)): a StorageManager whose home-space session connects to the memory
 * server, in process or over transports that reach it on the thread that
 * holds it, as the only commit path the loop's runtime uses, with the same
 * signed `session.open` production clients present. With a route
 * (`serving-loop-owner-routing.md`), every other space's session dials that
 * space's owner the same way, so a foreign read is a session with the owner,
 * which wakes it on every commit there. No parallel auth scheme: the
 * session's principal is the service identity, verified by whatever
 * `authorizeSessionOpen` the host process configured, which is what makes
 * the read-row admission (protocol.md §2) meaningful in production.
 */

import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import type { SessionDescriptor } from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import {
  type ClientBuild,
  type ClientInfo,
  createClientInfo,
} from "@commonfabric/memory/v2/client-info";
import type { LoopbackMemoryServer } from "./host-memory-server.ts";
import type { SpaceHostRegistration } from "../space-host.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../storage/v2.ts";
import {
  createSignedSessionOpenAuth,
  MEMORY_FIRST_HANDSHAKE_ATTEMPTS,
} from "../storage/v2-remote-session.ts";
import type { RouteOptions } from "./routed-plane.ts";
import { runInServingContext } from "./serving-context.ts";

/**
 * Where a loopback session connects: the memory server reached in-process,
 * or a factory of transports that reach it another way, such as a port to
 * the thread that holds it.
 */
export type LoopbackPlane =
  | LoopbackMemoryServer
  | { createTransport(): MemoryClient.Transport };

/**
 * The options of a loopback storage manager: a storage manager's, and the
 * deployment's route to each space's owner
 * (`serving-loop-owner-routing.md`), over which every session but the home
 * space's (`servingHomeSpace`) reaches its space's owner instead of the
 * plane: the sessions of the spaces the runtime reads across, and a session
 * signed by a key other than the manager's own, the genesis of a space the
 * serving runtime creates signed by that space's key. A manager with a
 * route and no home space routes every session.
 */
export type LoopbackOptions = Omit<Options, "memoryHost" | "spaceHostMap"> & {
  route?: Pick<RouteOptions, "createTransport">;
};

/**
 * `inner` with its receiver wrapped by `wrapReceiver`, every other member
 * delegated. A transport is a class instance as often as a plain object,
 * and a spread of one keeps no method of its class, so each member is
 * named here, and `executor-loopback-storage.test.ts` holds the list to the type's
 * members: a member the type gains and this leaves out is a member every
 * loopback session loses. An optional member `inner` lacks is absent here
 * too, since the client reads a member's presence as a capability.
 */
export function delegatingTransport(
  inner: MemoryClient.Transport,
  wrapReceiver: (
    next: (payload: string) => void,
  ) => (payload: string) => void,
): MemoryClient.Transport {
  return {
    ...(inner.supportsMessageCompression === undefined ? {} : {
      supportsMessageCompression: inner.supportsMessageCompression,
    }),
    ...(inner.supportsRouterStreaming === undefined ? {} : {
      supportsRouterStreaming: inner.supportsRouterStreaming,
    }),
    ...(inner.messageLimits === undefined
      ? {}
      : { messageLimits: inner.messageLimits }),
    send: (payload) => inner.send(payload),
    close: () => inner.close(),
    ...(inner.reset === undefined ? {} : { reset: () => inner.reset!() }),
    setReceiver: (next) => inner.setReceiver(wrapReceiver(next)),
    ...(inner.setCloseReceiver === undefined ? {} : {
      setCloseReceiver: (receiver: (error?: Error) => void) =>
        inner.setCloseReceiver!(receiver),
    }),
    ...(inner.setMessageCompressionEnabled === undefined ? {} : {
      setMessageCompressionEnabled: (enabled: boolean) =>
        inner.setMessageCompressionEnabled!(enabled),
    }),
    ...(inner.setRoutedMessagesEnabled === undefined ? {} : {
      setRoutedMessagesEnabled: (
        ...args: Parameters<
          NonNullable<MemoryClient.Transport["setRoutedMessagesEnabled"]>
        >
      ) => inner.setRoutedMessagesEnabled!(...args),
    }),
    ...(inner.delivered === undefined
      ? {}
      : { delivered: () => inner.delivered!() }),
  };
}

class LoopbackSessionFactory implements SessionFactory {
  readonly supportsAclBootstrap = true;

  readonly #plane: LoopbackPlane;
  readonly #route: Pick<RouteOptions, "createTransport"> | undefined;

  /** The space the manager serves, whose session stays on the plane. */
  readonly #home: MemorySpace | undefined;

  /** The manager's own signer, which every session but a genesis is signed by. */
  readonly #as: Signer;

  readonly #onServerFrame?: (frame: string) => void;
  readonly #clientInfo: Readonly<ClientInfo>;

  constructor(
    plane: LoopbackPlane,
    route: Pick<RouteOptions, "createTransport"> | undefined,
    home: MemorySpace | undefined,
    as: Signer,
    onServerFrame?: (frame: string) => void,
    clientBuild?: ClientBuild,
  ) {
    this.#plane = plane;
    this.#route = route;
    this.#home = home;
    this.#as = as;
    this.#onServerFrame = onServerFrame;
    this.#clientInfo = createClientInfo(clientBuild);
  }

  /**
   * The route a session on `space` signed by `signer` takes to the space's
   * owner, if any: with a route, every session but the home space's own,
   * signed by the manager's own key, is routed.
   */
  #routeFor(
    space: MemorySpace,
    signer: Signer,
  ): Pick<RouteOptions, "createTransport"> | undefined {
    if (this.#route === undefined) return undefined;
    return space === this.#home && signer.did() === this.#as.did()
      ? undefined
      : this.#route;
  }

  /**
   * The transport of a session on `space` signed by `signer`: the route's to
   * the space's owner where `#routeFor` routes it, the plane's otherwise.
   * Each server frame is taken in the serving context and reported AFTER
   * the session has taken it.
   */
  #transport(space: MemorySpace, signer: Signer): MemoryClient.Transport {
    const route = this.#routeFor(space, signer);
    const inner = route !== undefined
      ? route.createTransport(space)
      : "createTransport" in this.#plane
      ? this.#plane.createTransport()
      : MemoryClient.loopback(this.#plane);
    const report = this.#onServerFrame;
    return delegatingTransport(
      inner,
      (next) => (payload) =>
        runInServingContext(true, () => {
          next(payload);
          report?.(payload);
        }),
    );
  }

  async create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions: MemoryClient.MountOptions = {},
  ) {
    if (signer === undefined) {
      throw new Error(
        "loopback serving sessions require the service identity signer",
      );
    }
    // A routed session dials the owner over the network, with the handshake
    // attempts the routed plane gives its own sessions.
    const client = await MemoryClient.connect({
      transport: this.#transport(space, signer),
      client: this.#clientInfo,
      ...(this.#routeFor(space, signer) === undefined
        ? {}
        : { firstHandshakeAttempts: MEMORY_FIRST_HANDSHAKE_ATTEMPTS }),
    });
    try {
      const session = await client.mount(
        space,
        mountOptions,
        (
          targetSpace: string,
          descriptor: SessionDescriptor,
          context: MemoryClient.SessionOpenAuthContext,
        ) =>
          createSignedSessionOpenAuth(
            signer,
            targetSpace as MemorySpace,
            descriptor,
            context,
          ),
      );
      return { client, session };
    } catch (error) {
      // A failed mount must not leak the in-process connection (repeated
      // auth/transient failures would accumulate server-side sessions) —
      // the same close-before-rethrow RemoteSessionFactory.create does.
      await client.close().catch(() => {});
      throw error;
    }
  }
}

/**
 * The SpaceServer's storage manager: in-process transport, signed
 * session-open, the service identity as `as`. One manager per serving
 * runtime (per space activation) — the ExecutorHost's runtime factory
 * constructs and disposes it with the runtime.
 */
export class LoopbackStorageManager extends StorageManager {
  static connect(
    plane: LoopbackPlane,
    options: LoopbackOptions,
    /** DIAGNOSTIC (tests): each frame the server sends to this manager's
     * sessions, reported once the session has taken it. A session's own
     * termination arrives this way and nothing else reports it, so a test
     * that has to act after one waits on this. */
    onServerFrame?: (frame: string) => void,
  ): LoopbackStorageManager {
    const { route, ...rest } = options;
    return new LoopbackStorageManager(
      {
        ...rest,
        // Placeholder: the loopback session factory never resolves a
        // storage address against this.
        memoryHost: new URL("memory://loopback"),
      },
      new LoopbackSessionFactory(
        plane,
        route,
        rest.servingHomeSpace,
        rest.as,
        onServerFrame,
        rest.clientBuild,
      ),
    );
  }

  /**
   * Loopback sessions are in-process — there is no per-space host to
   * resolve, so a site-table host hint can never take effect. Refuse
   * honestly (as the emulated loopback manager does) rather than accept
   * a registration that resets the provisional replica while every new
   * session still uses the co-hosted server.
   */
  override registerSpaceHostDetailed(): SpaceHostRegistration {
    return { accepted: false, reason: "no-remote-resolution" };
  }
}

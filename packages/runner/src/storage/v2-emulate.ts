import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import type { SpaceHostRegistration } from "../space-host.ts";
import { type Options, type SessionFactory, StorageManager } from "./v2.ts";

const emulatedMemoryAudience = "did:key:z6Mk-runner-emulated-memory";

/**
 * Build a stock in-process memory server for loopback storage managers: the
 * principal-passthrough authorizer, an emulated audience, and optionally a
 * fan-out cadence — `"manual"` disables timer-driven fan-out entirely:
 * either explicit synchronization point (`flushSessions()`, or `idle()`,
 * which drains held fan-out to keep its quiescence contract) delivers it.
 * The controlled-staleness shape.
 */
export const newLoopbackServer = (options?: {
  audience?: string;
  subscriptionRefreshDelayMs?: number | "manual";
  store?: URL;

  /** A registry the caller owns (tests): the registry's own detached-session
   * TTL decides how long a closed connection's sessions — and their watches,
   * i.e. their DEMAND — linger, and pruning against it is lazy, so a test
   * that has to observe a session GONE removes it rather than waiting the
   * window out. Absent, the server's default registry and resume window
   * apply. */
  sessions?: MemoryV2Server.SessionRegistry;
}): MemoryV2Server.Server =>
  new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: {
      audience: options?.audience ?? emulatedMemoryAudience,
    },
    ...(options?.subscriptionRefreshDelayMs !== undefined
      ? { subscriptionRefreshDelayMs: options.subscriptionRefreshDelayMs }
      : {}),
    ...(options?.store !== undefined ? { store: options.store } : {}),
    ...(options?.sessions !== undefined ? { sessions: options.sessions } : {}),
  });

class EmulatedSessionFactory implements SessionFactory {
  readonly #getServer: () => MemoryV2Server.Server;

  constructor(
    getServer: () => MemoryV2Server.Server,
  ) {
    this.#getServer = getServer;
  }

  async create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions: MemoryV2Client.MountOptions = {},
  ) {
    const transport = MemoryV2Client.loopback(this.#getServer());
    const client = await MemoryV2Client.connect({ transport });
    const session = await client.mount(
      space,
      mountOptions,
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: {
          principal: signer?.did(),
        },
      }),
    );
    return { client, session };
  }
}

export class EmulatedStorageManager extends StorageManager {
  #serverFactory: () => MemoryV2Server.Server;
  #server?: MemoryV2Server.Server;
  #ownsServer = true;

  static emulate(
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): EmulatedStorageManager {
    return new this(
      {
        ...options,
        // Placeholder: the emulated session factory is loopback and never
        // resolves a storage address against this.
        memoryHost: new URL("memory://"),
      },
      // Single-manager emulation wants prompt fan-out: a zero-delay flush
      // keeps marker delivery in the same scheduling class as the request
      // round trips that stage it (each is one turn of the event loop), so
      // awaited commits settle without wall-clock coalescing.
      //
      // The turn is the point here, not the delay. A deployed server does
      // its own work on microtasks and then the sync frame crosses a real
      // boundary before any client sees it. Fan-out that arrives inside the
      // committing caller's own microtask cascade puts a client where no
      // deployment puts it, and leaves whatever races live at that boundary
      // invisible. Zero is as short as the boundary gets; it is still a
      // boundary.
      //
      // Harnesses that share one server across managers use connectTo()
      // and pick their own cadence — "manual" for controlled-staleness
      // premises that depend on frames NOT spreading until the test says.
      () => newLoopbackServer({ subscriptionRefreshDelayMs: 0 }),
    );
  }

  /**
   * Connect a manager to an externally owned shared server: several managers
   * on one server model several real sessions, where data written by one
   * reaches another only through an explicit per-space server
   * query/subscription. Fan-out keeps the server's own cadence (no
   * flush-on-send nudge), and the CALLER owns the server's lifecycle —
   * closing this manager does not close the shared server.
   */
  static connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): EmulatedStorageManager {
    const manager = new this(
      { ...options, memoryHost: new URL("memory://") },
      () => server,
    );
    manager.#ownsServer = false;
    return manager;
  }

  protected constructor(
    options: Options,
    serverFactory: () => MemoryV2Server.Server,
  ) {
    const serverHolder: { get: () => MemoryV2Server.Server } = {
      get: () => {
        throw new Error("Emulated server requested before initialization");
      },
    };
    super(
      options,
      new EmulatedSessionFactory(() => serverHolder.get()),
    );
    this.#serverFactory = serverFactory;
    serverHolder.get = () => this.server();
  }

  /**
   * Emulated sessions are loopback — there is no per-space host to
   * resolve, so a host hint can never take effect. Refuse honestly
   * rather than inherit an acceptance that routes nothing.
   */
  override registerSpaceHostDetailed(): SpaceHostRegistration {
    return { accepted: false, reason: "no-remote-resolution" };
  }

  override async close(): Promise<void> {
    await super.close();
    if (this.#server && this.#ownsServer) {
      await this.#server.close();
    }
  }

  protected server(): MemoryV2Server.Server {
    this.#server ??= this.#serverFactory();
    return this.#server;
  }
}

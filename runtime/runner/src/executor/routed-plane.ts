/**
 * The routed plane (docs/plans/serving-loop-owner-routing.md): how a serving
 * host reaches a space other than the ones it serves, through that space's
 * owner. The host keeps one routed session per target space, open as the
 * service identity with the delegated READ binding, on a transport the route
 * addresses to the owner. A session opens when something first needs it and
 * closes once every scope that needed it is disposed; a SpaceServer's tenure
 * holds one scope, so a session outlives no tenure that used it. The owner's
 * side is `served-requests.ts`.
 */

import type { FabricPlainObject } from "@commonfabric/api";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import type { SessionDescriptor } from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import {
  type ClientBuild,
  type ClientInfo,
  createClientInfo,
} from "@commonfabric/memory/v2/client-info";
import {
  createSignedSessionOpenAuth,
  createStorageAddressResolver,
  MEMORY_FIRST_HANDSHAKE_ATTEMPTS,
  toSpaceWebSocketAddress,
  WebSocketTransport,
} from "../storage/v2-remote-session.ts";
import type {
  ServedAppendEntry,
  ServedAppendResult,
} from "./served-requests.ts";

/** How a host reaches the owner of any space: the deployment's route. */
export type RouteOptions = {
  /** A transport addressed to the owner of `space`. */
  createTransport: (space: MemorySpace) => MemoryClient.Transport;

  /** How a routed session's open authenticates, as the service identity. */
  sessionOpenAuth: MemoryClient.SessionOpenAuthFactory;

  /** Application and build the routed sessions report. */
  clientBuild?: ClientBuild;
};

/**
 * One user of the plane's sessions, held for a tenure. Each call opens the
 * target's session when the plane has none, and `dispose()` lets the plane
 * close the sessions no other scope uses.
 */
export type RoutedScope = {
  /**
   * Sends one delegated event append into `space` through its owner. The
   * entry's position on the session is the plane's to number, so the owner
   * keys the append by a pair no other append on that session has.
   */
  append(
    space: MemorySpace,
    entry: Omit<ServedAppendEntry, "localSeq">,
  ): Promise<ServedAppendResult>;

  /**
   * Calls `onChange` each time the owner pushes a change the session
   * watches, the document `id` in `space` among them, until the returned
   * function is called. The push is the owner's, so a commit from whichever
   * process made it reaches the caller. A session's watches share one push,
   * so a caller reads the document itself to learn whether its own changed.
   */
  watchDocument(
    space: MemorySpace,
    id: string,
    onChange: () => void,
  ): Promise<() => void>;

  /** Releases the scope's hold on every session it used. */
  dispose(): void;
};

/** An error the memory server answered a `served` request with. */
export type ServedRefusal = Error & { code: string };

/** Whether `error` is a served refusal, and with `code` when given. */
export const isServedRefusal = (
  error: unknown,
  code?: string,
): error is ServedRefusal =>
  error instanceof Error && error.name === "ServedRequestRefusal" &&
  (code === undefined || (error as { code?: unknown }).code === code);

/**
 * The route over a deployment's memory WebSocket endpoint: each space's
 * session dials `address` with the space named in the query, which is how
 * the deployment's proxy picks the owner, and opens signed by `signer`.
 */
export const webSocketRoute = (
  address: URL,
  signer: Signer,
  clientBuild?: ClientBuild,
): RouteOptions => {
  const resolve = createStorageAddressResolver(address);
  return {
    createTransport: (space) =>
      new WebSocketTransport(toSpaceWebSocketAddress(resolve(space), space)),
    sessionOpenAuth: (
      space: string,
      descriptor: SessionDescriptor,
      context: MemoryClient.SessionOpenAuthContext,
    ) =>
      createSignedSessionOpenAuth(
        signer,
        space as MemorySpace,
        descriptor,
        context,
      ),
    ...(clientBuild === undefined ? {} : { clientBuild }),
  };
};

/** A routed session to one target space's owner, and its position counter. */
type RoutedSession = {
  /** The connection the session is open on, closed with the session. */
  client: MemoryClient.Client;

  /** The session, open as the service identity bound to the space's owner. */
  session: MemoryClient.SpaceSession;

  /** The position of the last append sent on the session, from zero. */
  localSeq: number;
};

/**
 * A host's routed sessions, one per target space, as the file header
 * describes. Scopes use the sessions; the plane opens and closes them.
 */
export class RoutedPlane {
  readonly #options: RouteOptions;
  readonly #clientInfo: Readonly<ClientInfo>;

  /** The session per target space, from the moment its open starts. */
  readonly #sessions = new Map<string, Promise<RoutedSession>>();

  /** The scopes that have used each target space's session. */
  readonly #users = new Map<string, Set<RoutedScope>>();

  /** Closes in flight, which `close()` waits out. */
  readonly #closing = new Set<Promise<void>>();

  #closed = false;

  constructor(options: RouteOptions) {
    this.#options = options;
    this.#clientInfo = createClientInfo(options.clientBuild);
  }

  /** DIAGNOSTIC (tests): the spaces a session is open or opening to. */
  get accessForTestingOnly(): { readonly sessionSpaces: readonly string[] } {
    return { sessionSpaces: [...this.#sessions.keys()] };
  }

  /** A new user of the plane's sessions, to be disposed once it is done. */
  scope(): RoutedScope {
    const scope: RoutedScope = {
      append: (space, entry) => this.#append(scope, space, entry),
      watchDocument: (space, id, onChange) =>
        this.#watchDocument(scope, space, id, onChange),
      dispose: () => this.#release(scope),
    };
    return scope;
  }

  /** Closes every session; a scope used after this fails its calls. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const space of [...this.#sessions.keys()]) this.#closeSession(space);
    this.#users.clear();
    await Promise.all([...this.#closing]);
  }

  /** Sends `entry` on `space`'s session, numbered after its last append. */
  async #append(
    scope: RoutedScope,
    space: MemorySpace,
    entry: Omit<ServedAppendEntry, "localSeq">,
  ): Promise<ServedAppendResult> {
    const routed = await this.#use(scope, space);
    const sent: ServedAppendEntry = { ...entry, localSeq: ++routed.localSeq };
    const result = await routed.session.runServed(
      "append",
      sent as unknown as FabricPlainObject,
    );
    const { seq, deduped } = result as Partial<ServedAppendResult>;
    if (typeof deduped !== "boolean") {
      throw new Error(
        `the owner of ${space} answered an append with no verdict`,
      );
    }
    return { deduped, ...(typeof seq === "number" ? { seq } : {}) };
  }

  /** Adds a watch for `id` on `space`'s session and wakes `onChange` on it. */
  async #watchDocument(
    scope: RoutedScope,
    space: MemorySpace,
    id: string,
    onChange: () => void,
  ): Promise<() => void> {
    const { session } = await this.#use(scope, space);
    const watchId = `routed:${id}`;
    const view = await session.watchAdd([{
      id: watchId,
      kind: "graph",
      // A watch for the wake alone: the document's value is read from the
      // shared store, so the walk follows nothing.
      query: {
        roots: [{ id, scope: "space", selector: { path: [], schema: false } }],
      },
    }]);
    const results = view.subscribe();
    let watching = true;
    void (async () => {
      while (watching) {
        const next = await results.next();
        if (next.done) return;
        onChange();
      }
    })();
    // The removal is sent on a session the scope may be releasing at the
    // same time, and a session that closed first has no watch to remove.
    return () => {
      watching = false;
      void results.return?.();
      void session.watchRemoveSync([watchId]).catch(() => {});
    };
  }

  /** Marks `scope` a user of `space`'s session and returns the session. */
  #use(scope: RoutedScope, space: MemorySpace): Promise<RoutedSession> {
    if (this.#closed) {
      return Promise.reject(new Error("the routed plane is closed"));
    }
    let users = this.#users.get(space);
    if (users === undefined) {
      users = new Set();
      this.#users.set(space, users);
    }
    users.add(scope);
    let session = this.#sessions.get(space);
    if (session === undefined) {
      session = this.#open(space);
      this.#sessions.set(space, session);
      // A session that could not open is forgotten, so the next use dials
      // again. The use that failed reports the failure to its caller.
      session.catch(() => {
        if (this.#sessions.get(space) === session) {
          this.#sessions.delete(space);
        }
      });
    }
    return session;
  }

  /** Dials `space`'s owner and opens the session, or closes what it dialed. */
  async #open(space: MemorySpace): Promise<RoutedSession> {
    const transport = this.#options.createTransport(space);
    const client = await MemoryClient.connect({
      transport,
      client: this.#clientInfo,
      firstHandshakeAttempts: MEMORY_FIRST_HANDSHAKE_ATTEMPTS,
    });
    try {
      const session = await client.mount(
        space,
        { actingAs: "space-owner" },
        this.#options.sessionOpenAuth,
      );
      return { client, session, localSeq: 0 };
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  /** Forgets `scope` and closes the sessions it was the last user of. */
  #release(scope: RoutedScope): void {
    for (const [space, users] of [...this.#users]) {
      if (!users.delete(scope) || users.size > 0) continue;
      this.#users.delete(space);
      this.#closeSession(space);
    }
  }

  /** Closes `space`'s session once open, and tracks the close for `close()`. */
  #closeSession(space: string): void {
    const session = this.#sessions.get(space);
    if (session === undefined) return;
    this.#sessions.delete(space);
    const closing = session.then(({ client }) => client.close()).catch(
      () => {},
    ).finally(() => {
      this.#closing.delete(closing);
    });
    this.#closing.add(closing);
  }
}

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
import {
  encodeMemoryBoundary,
  type GraphQueryResult,
  type ServedRequestKind,
  type SessionDescriptor,
} from "@commonfabric/memory/v2";
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
import type { ServedAclChangeData } from "./served-acl-change.ts";
import type {
  ServedAppendEntry,
  ServedAppendResult,
} from "./served-requests.ts";
import type { WaveSpaceCommit } from "./wave.ts";

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
   * Sends `batch`, a foreign wave batch into `space`, through its owner,
   * which commits it as the sender's own sink would (protocol.md §2b) and
   * answers with the seq it committed at. The owner's refusal is thrown as
   * a `ServedRefusal`; a failure to reach the owner is thrown as whatever
   * the transport raised. Numbered like an append.
   */
  commit(space: MemorySpace, batch: WaveSpaceCommit): Promise<{ seq: number }>;

  /**
   * Sends `change`, a served run's change to the access list of `space`,
   * through its owner, which admits and commits it as its own server would
   * (`Server.commitServedAclChange()`), and answers with the seq of the
   * commit, or with none where the change left the list as it was. Refusals
   * and failures are thrown as `commit` throws them. Numbered like an append.
   */
  acl(
    space: MemorySpace,
    change: ServedAclChangeData,
  ): Promise<{ seq?: number }>;

  /**
   * Calls `onChange` each time the owner pushes a change the session
   * watches, the document `id` in `space` among them, until the returned
   * function is called. The push is the owner's, so a commit from whichever
   * process made it reaches the caller. A session's watches share one push,
   * which wakes every watcher on the session, so a caller reads the
   * document itself to learn whether its own changed.
   */
  watchDocument(
    space: MemorySpace,
    id: string,
    onChange: () => void,
  ): Promise<() => void>;

  /**
   * Releases the scope's hold on every session it used. A call on the scope
   * after this fails, so a user that outlives its own close opens nothing.
   */
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
/** The id of the server's watch on document `id` for a routed session. */
const routedWatchId = (id: string): string => `routed:${id}`;

type RoutedSession = {
  /** The connection the session is open on, closed with the session. */
  client: MemoryClient.Client;

  /** The session, open as the service identity bound to the space's owner. */
  session: MemoryClient.SpaceSession;

  /** The position of the last crossing sent on the session, from zero. */
  localSeq: number;

  /**
   * The watchers of each document watched on the session. The server holds
   * one watch per document, added with its first watcher and removed with
   * its last, and one subscription to the session's view wakes them all.
   */
  watchers: Map<string, Set<() => void>>;

  /** The subscription the watchers share, open while any document is watched. */
  subscription?: AsyncIterator<GraphQueryResult>;
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

  /** The scopes disposed, which no call opens a session for again. */
  readonly #disposed = new WeakSet<RoutedScope>();

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
      commit: (space, batch) => this.#commit(scope, space, batch),
      acl: (space, change) => this.#acl(scope, space, change),
      watchDocument: (space, id, onChange) =>
        this.#watchDocument(scope, space, id, onChange),
      dispose: () => {
        this.#disposed.add(scope);
        this.#release(scope);
      },
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

  /** Sends `entry` on `space`'s session, numbered after its last crossing. */
  async #append(
    scope: RoutedScope,
    space: MemorySpace,
    entry: Omit<ServedAppendEntry, "localSeq">,
  ): Promise<ServedAppendResult> {
    const result = await this.#run(scope, space, "append", entry);
    const { seq, deduped } = result as Partial<ServedAppendResult>;
    if (typeof deduped !== "boolean") {
      throw new Error(
        `the owner of ${space} answered an append with no verdict`,
      );
    }
    return { deduped, ...(typeof seq === "number" ? { seq } : {}) };
  }

  /** Sends `batch` on `space`'s session, in the memory boundary's encoding. */
  async #commit(
    scope: RoutedScope,
    space: MemorySpace,
    batch: WaveSpaceCommit,
  ): Promise<{ seq: number }> {
    const result = await this.#run(scope, space, "commit", {
      batch: encodeMemoryBoundary(batch as unknown as FabricPlainObject),
    });
    const { seq } = result as { seq?: unknown };
    if (typeof seq !== "number") {
      throw new Error(`the owner of ${space} answered a commit with no seq`);
    }
    return { seq };
  }

  /** Sends `change` on `space`'s session. */
  async #acl(
    scope: RoutedScope,
    space: MemorySpace,
    change: ServedAclChangeData,
  ): Promise<{ seq?: number }> {
    const result = await this.#run(scope, space, "acl", { change });
    const { seq } = result as { seq?: unknown };
    return typeof seq === "number" ? { seq } : {};
  }

  /**
   * Sends one `served` request of `kind` on `space`'s session, with `body`
   * and the number after the session's last crossing, and returns the
   * owner's answer. A session whose server advertises no `servedRequests`
   * is replaced, so the next crossing dials the owner afresh: the server
   * advertises the capability exactly while its loop runs, and a session
   * opened while it did not is told nothing when it starts to.
   */
  async #run(
    scope: RoutedScope,
    space: MemorySpace,
    kind: ServedRequestKind,
    body: object,
  ): Promise<FabricPlainObject> {
    const opened = this.#use(scope, space);
    const routed = await opened;
    const sent = { ...body, localSeq: ++routed.localSeq };
    try {
      return await routed.session.runServed(
        kind,
        sent as unknown as FabricPlainObject,
      );
    } catch (error) {
      if (
        isServedRefusal(error, "served-unsupported") &&
        this.#sessions.get(space) === opened
      ) {
        this.#replace(space, routed);
      }
      throw error;
    }
  }

  /**
   * Closes `space`'s session, `routed`, and where documents are watched on
   * it opens the next session with those watches added, so a watcher
   * outlives the session it registered on and the next crossing finds the
   * session open. A watcher set moves to the next session as it is, which is
   * what its cancellation finds there.
   */
  #replace(space: MemorySpace, routed: RoutedSession): void {
    this.#closeSession(space);
    if (routed.watchers.size === 0) return;
    const next = this.#open(space).then(async (session) => {
      try {
        for (const [id, watchers] of routed.watchers) {
          session.watchers.set(id, watchers);
          await this.#addWatch(session, id);
        }
        return session;
      } catch (error) {
        await session.client.close().catch(() => {});
        throw error;
      }
    });
    this.#sessions.set(space, next);
    next.catch(() => {
      if (this.#sessions.get(space) === next) this.#sessions.delete(space);
    });
  }

  /**
   * Wakes `onChange` on each push of `space`'s session, with the document
   * `id` watched there from its first watcher to its last.
   */
  async #watchDocument(
    scope: RoutedScope,
    space: MemorySpace,
    id: string,
    onChange: () => void,
  ): Promise<() => void> {
    const routed = await this.#use(scope, space);
    let watchers = routed.watchers.get(id);
    if (watchers === undefined) {
      watchers = new Set();
      routed.watchers.set(id, watchers);
      try {
        await this.#addWatch(routed, id);
      } catch (error) {
        // The document is not watched, so its next watcher adds the watch.
        if (routed.watchers.get(id) === watchers) routed.watchers.delete(id);
        throw error;
      }
    }
    watchers.add(onChange);
    // The removal goes to the session the document is watched on by then,
    // which a replacement may have opened since; a session that closed
    // first has no watch to remove, and the scope may be releasing it at the
    // same time.
    return () => {
      if (!watchers.delete(onChange) || watchers.size > 0) return;
      void this.#sessions.get(space)?.then((current) => {
        if (current.watchers.get(id) !== watchers) return;
        current.watchers.delete(id);
        void current.session.watchRemoveSync([routedWatchId(id)]).catch(
          () => {},
        );
        if (current.watchers.size === 0 && current.subscription !== undefined) {
          void current.subscription.return?.();
          current.subscription = undefined;
        }
      }).catch(() => {});
    };
  }

  /**
   * Adds the server's watch on document `id` to `routed`'s session, and the
   * session's one subscription where it has none yet.
   */
  async #addWatch(routed: RoutedSession, id: string): Promise<void> {
    const view = await routed.session.watchAdd([{
      id: routedWatchId(id),
      kind: "graph",
      // A watch for the wake alone: the document's value is read from the
      // shared store, so the walk follows nothing.
      query: {
        roots: [{
          id,
          scope: "space",
          selector: { path: [], schema: false },
        }],
      },
    }]);
    if (routed.subscription === undefined) {
      routed.subscription = this.#subscribe(routed, view);
    }
  }

  /**
   * Subscribes to `view` and wakes every watcher on `routed` for each push,
   * until the subscription is returned or the view closes. The view's
   * iterators compete for each push, so one iterator per session is what
   * lets every watcher see every push.
   */
  #subscribe(
    routed: RoutedSession,
    view: { subscribe(): AsyncIterator<GraphQueryResult> },
  ): AsyncIterator<GraphQueryResult> {
    const results = view.subscribe();
    void (async () => {
      for (;;) {
        const next = await results.next();
        if (next.done) return;
        for (const watchers of [...routed.watchers.values()]) {
          for (const wake of [...watchers]) wake();
        }
      }
    })();
    return results;
  }

  /** Marks `scope` a user of `space`'s session and returns the session. */
  #use(scope: RoutedScope, space: MemorySpace): Promise<RoutedSession> {
    if (this.#closed) {
      return Promise.reject(new Error("the routed plane is closed"));
    }
    if (this.#disposed.has(scope)) {
      return Promise.reject(new Error("the routed scope is disposed"));
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
      return { client, session, localSeq: 0, watchers: new Map() };
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

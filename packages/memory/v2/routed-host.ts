/**
 * Private Mode A toolshed endpoints. The authenticated router link carries
 * proof control; single-use ticketed sockets carry one client's Memory data.
 */

// @ts-types="@types/ws"
import WebSocket from "ws";

import { sha256 } from "@commonfabric/content-hash";
import { type Identity, isCanonicalEd25519DID } from "@commonfabric/identity";
import { isPlainObject } from "@commonfabric/utils/types";

import { encodeMemoryBoundary, type ServerMessage } from "../v2.ts";
import {
  decodeRoutedFrame,
  parseRoutedJson,
  ROUTED_DEFAULT_SLOT_LIMIT,
  ROUTED_QUEUE_LIMIT,
  routedCollectionSize,
  routedFlags,
  routedIdentifier,
  routedObject,
} from "./routed-parser.ts";
import {
  equalRoutedBytes,
  readRoutedBase64,
  readRoutedHex,
  readRoutedProof,
  requireRouted,
  routedHex,
  type RoutedProof,
  RoutedReader,
  type RoutedStatement,
  RoutedWriter,
  verifyRoutedProof,
  verifyRoutedRecord,
} from "./routed-wire.ts";
import type { RoutedEpochStore } from "./routed-epochs.ts";
import type { Server } from "./server.ts";

type Backend = ReturnType<Server["connectRouted"]>;
type Grant = { statement: RoutedStatement; digest: string };
/** One session's quota use: its watch IDs and views, and its holdings. */
type Usage = { principal: string; count: number; holdings: number };
/** Sessions, watches and holdings summed over the sessions of a scope. */
type Totals = { sessions: number; watches: number; holdings: number };
const NO_USAGE: Readonly<Totals> = { sessions: 0, watches: 0, holdings: 0 };
type Context = {
  id: Uint8Array;
  /** `id` in hex, as the link names it. */
  idHex: string;
  flags: Uint8Array;
  spaces: Map<string, number>;
  /** Usage by session, and by each open in flight; see `#setUsage`. */
  usage: Map<string, Usage>;
  totals: Totals;
  grants: Map<string, Grant>;
  released: Set<string>;
  /**
   * Unexpired statements this context accepted, by principal and challenge.
   * A released principal's are marked, and cannot admit it again.
   */
  accepted: Map<string, Accepted>;
  /** IDs of the tickets issued for it and not yet redeemed or expired. */
  tickets: Set<string>;
  backend?: Backend;
  socket?: WebSocket;
  closed: boolean;
};
type Accepted = {
  principal: string;
  digest: string;
  exp: number;
  released: boolean;
};

/**
 * Capacity a toolshed admits from routers, from its Mode A policy config.
 * A context is one client connection's use of this toolshed through one
 * router; "router" counts everything one router link carries, and
 * "toolshed" everything this toolshed admits from every router. Watches and
 * holdings are summed over sessions.
 */
export interface RoutedHostLimits {
  /** Client contexts on one router link; at least the router's workers. */
  contextsPerLink: number;
  /**
   * Private sockets from every router: links, data sockets and handshakes.
   */
  sockets: number;
  /**
   * Tickets issued and neither redeemed nor expired, from every router. A
   * ticket counts from its issue until a data socket redeems it, its
   * context closes or 15 s pass.
   */
  tickets: number;
  /** Principals authenticated in one context at once, as the router's own. */
  principalsPerContext: number;
  /**
   * Principals one context remembers until their statements expire,
   * released ones included; creating a space proves its key here, so this
   * bounds the spaces one connection creates per statement lifetime.
   */
  principalHistoryPerContext: number;
  /**
   * Unexpired client proofs one context holds: at least one for each
   * remembered principal and a renewal for each active one.
   */
  proofsPerContext: number;
  /**
   * Requests one context has unanswered on its data socket: at least the
   * router's per-connection requests in flight, which may all go to one
   * toolshed.
   */
  requestsPerContext: number;
  sessionsPerContext: number;
  sessionsPerRouter: number;
  sessionsPerToolshed: number;
  sessionsPerPrincipal: number;
  watchesPerContext: number;
  watchesPerRouter: number;
  watchesPerToolshed: number;
  watchesPerPrincipal: number;
  holdingsPerContext: number;
  holdingsPerRouter: number;
  holdingsPerToolshed: number;
  holdingsPerPrincipal: number;
  /**
   * JSON values in one frame a data socket receives, counted as the router
   * counts them: one per value, keys free. A frame over it closes the
   * socket. Must equal the router's `max_frame_slots` (a check for the infra
   * preflight, beside the limits it compares already), and a client's
   * `ROUTED_FRAME_SLOTS` must not exceed it. Sized by the deployment's
   * largest sync frame against the router worker's memory, not by this
   * toolshed.
   */
  frameSlots: number;
}

/**
 * Sized for the proof of concept and a second router. Per-context limits
 * equal the router's per-connection ones, so a toolshed never refuses what
 * its router admitted to one connection. The router README's capacity
 * section has the load model, which inputs are measured and which assumed,
 * and how to size for other loads and router counts.
 */
export const DEFAULT_ROUTED_HOST_LIMITS: Readonly<RoutedHostLimits> = {
  contextsPerLink: 512,
  sockets: 2048,
  tickets: 2048,
  principalsPerContext: 16,
  principalHistoryPerContext: 128,
  proofsPerContext: 160,
  requestsPerContext: 1024,
  sessionsPerContext: 1200,
  sessionsPerRouter: 8192,
  sessionsPerToolshed: 16384,
  sessionsPerPrincipal: 2400,
  watchesPerContext: 40960,
  watchesPerRouter: 262144,
  watchesPerToolshed: 524288,
  watchesPerPrincipal: 81920,
  holdingsPerContext: 327680,
  holdingsPerRouter: 2097152,
  holdingsPerToolshed: 4194304,
  holdingsPerPrincipal: 655360,
  frameSlots: ROUTED_DEFAULT_SLOT_LIMIT,
};

/**
 * Watch IDs one session may hold. The parser admits at most this many in one
 * request, and a client sends a session's whole set in one
 * `session.watch.set` when it restores the session, so a session may not
 * hold more than one request can carry; it stays fixed.
 */
const WATCHES_PER_SESSION = 1024;
/** Views one session may hold; bounds one frame, so it stays fixed. */
const VIEWS_PER_SESSION = 64;

/**
 * `overrides` over the defaults. Capacity is the deployment's to size, so
 * only consistency is checked: each limit is a positive integer, the
 * per-context, per-router and per-toolshed limits nest, a context's proofs
 * cover its principal history and a renewal for each active principal, and
 * a link's contexts can each hold a ticket. {@link routedHostLimitsFor}
 * checks the limits that depend on how many routers a toolshed admits.
 *
 * @throws If a limit is unknown, not a positive safe integer, or out of order.
 */
export function routedHostLimits(
  overrides: Partial<RoutedHostLimits> = {},
): RoutedHostLimits {
  for (const key of Object.keys(overrides)) {
    requireLimit(Object.hasOwn(DEFAULT_ROUTED_HOST_LIMITS, key), key);
  }
  const limits = { ...DEFAULT_ROUTED_HOST_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    requireLimit(Number.isSafeInteger(value) && value > 0, key);
  }
  for (const kind of ["sessions", "watches", "holdings"] as const) {
    const context = limits[`${kind}PerContext`],
      router = limits[`${kind}PerRouter`],
      toolshed = limits[`${kind}PerToolshed`],
      principal = limits[`${kind}PerPrincipal`];
    requireLimit(context <= router, `${kind}PerContext`);
    requireLimit(router <= toolshed, `${kind}PerRouter`);
    requireLimit(principal <= toolshed, `${kind}PerPrincipal`);
  }
  requireLimit(
    limits.principalsPerContext <= limits.principalHistoryPerContext,
    "principalsPerContext",
  );
  requireLimit(
    limits.principalHistoryPerContext + limits.principalsPerContext <=
      limits.proofsPerContext,
    "proofsPerContext",
  );
  requireLimit(limits.contextsPerLink <= limits.tickets, "tickets");
  return limits;
}

/**
 * {@link routedHostLimits} for a toolshed that admits `routers` routers:
 * every router's contexts at once fit the sockets, with each link's own, and
 * the tickets.
 *
 * @throws As {@link routedHostLimits}, or if the limits do not fit `routers`.
 */
export function routedHostLimitsFor(
  overrides: Partial<RoutedHostLimits>,
  routers: number,
): RoutedHostLimits {
  const limits = routedHostLimits(overrides);
  requireLimit(Number.isSafeInteger(routers) && routers > 0, "routers");
  requireLimit(
    limits.sockets >= routers * (limits.contextsPerLink + 1),
    "sockets",
  );
  requireLimit(limits.tickets >= routers * limits.contextsPerLink, "tickets");
  return limits;
}

/** Throws a configuration error naming the limit that failed. */
function requireLimit(ok: boolean, field: string): void {
  if (!ok) throw new Error(`invalid routed limit: ${field}`);
}

/** Why the toolshed answered one request with a denial. */
type RefusalReason =
  | "session-limit"
  | "watch-limit"
  | "holdings-limit"
  | "frame-limit"
  | "session-not-held"
  | "principal-expired"
  | "principal-not-held";
/** Refusals that pass on their own, so the client holds the session. */
const RETRIABLE_REFUSALS: ReadonlySet<RefusalReason> = new Set([
  "session-limit",
  "watch-limit",
  "holdings-limit",
  "principal-expired",
]);

/**
 * A request refused on its own: answered, not a closed socket. A capacity
 * refusal, or one for a grant that expired in flight, is marked retriable;
 * one past a fixed bound on what a session holds (`frame-limit`), or for a
 * session or principal the context no longer holds, is final.
 */
class RoutedRequestRefusal extends Error {
  constructor(readonly reason: RefusalReason) {
    super(`Routed memory ${reason}`);
  }
  get retriable(): boolean {
    return RETRIABLE_REFUSALS.has(this.reason);
  }
}

/** Why the toolshed refused a proof, which closes its context. */
type ProofRefusalReason =
  | "proof-limit"
  | "principal-limit"
  | "principal-history-limit";
class RoutedProofRefusal extends Error {
  constructor(readonly reason: ProofRefusalReason) {
    super(`Routed memory ${reason}`);
  }
}

type Link = {
  router: string;
  epoch: Uint8Array;
  /** `epoch` in hex, as the ledger names it. */
  epochHex: string;
  peer: string;
  socket: WebSocket;
  contexts: Map<string, Context>;
  /**
   * The live context holding each accepted statement, keyed as `accepted`
   * is: a statement serves one live context at a time. A context's entries
   * leave with it, and none outlive the link or a restart.
   */
  claims: Map<string, Context>;
  sequence: number;
  closed: boolean;
};
type Ticket = {
  id: string;
  context: Context;
  link: Link;
  expires: number;
};

/** Private listener policy, independent of toolshed HTTP or service grants. */
export interface RoutedHostOptions {
  server: Server;
  identity: Identity;
  deployment: string;
  /** Exact router identities and their network source addresses. */
  routers: ReadonlyMap<string, ReadonlySet<string>>;
  /** Synchronous authoritative ownership epoch, absent for unowned spaces. */
  ownership: (space: string) => number | undefined;
  /** Unix seconds; tests can drive the same verifier deterministically. */
  now?: () => number;
  /** Durable link epochs and router revocations, kept across restart. */
  epochs: RoutedEpochStore;
  /** Capacity, over {@link DEFAULT_ROUTED_HOST_LIMITS}. */
  limits?: Partial<RoutedHostLimits>;
}

/** Toolshed authority for authenticated router links and their Mode A tickets. */
export class RoutedMemoryHost {
  #options: RoutedHostOptions;
  #limits: RoutedHostLimits;
  #links = new Map<string, Link>();
  /**
   * Tickets issued and not yet redeemed, oldest first; each expires 15 s
   * after issue. A ticket leaves when a data socket redeems it, when it
   * expires, or with its context, so a ticket found here is unspent.
   */
  #tickets = new Map<string, Ticket>();
  #sockets = new Set<WebSocket>();

  #closed = false;
  #revoked = new Set<string>();
  /** Session usage per router, per principal and in all; see `#setUsage`. */
  #routerTotals = new Map<string, Totals>();
  #principalTotals = new Map<string, Totals>();
  #toolshedTotals: Totals = { ...NO_USAGE };

  /**
   * Requires enforced ACLs, explicit ACL documents (a space with no history
   * admits only its own DID, to write its genesis) and an engine-turn fence.
   */
  constructor(options: RoutedHostOptions) {
    requireRouted(
      options.server.options.acl?.mode === "enforce" &&
        options.server.options.ownsSpace !== undefined &&
        options.server.options.requireExplicitAcl === true,
    );
    requireRouted(
      options.deployment.length > 0 && options.deployment.length <= 256 &&
        options.routers.size <= 16,
    );
    for (const [router, peers] of options.routers) {
      requireRouted(
        isCanonicalEd25519DID(router) && peers.size > 0 && peers.size <= 4,
      );
      requireRouted(
        !options.server.options.acl?.serviceDids?.includes(router) &&
          !options.server.options.acl?.delegatingDids?.includes(router),
      );
    }
    this.#limits = routedHostLimitsFor(
      options.limits ?? {},
      options.routers.size,
    );
    this.#options = options;
  }

  /** Ends one router's links, tickets, contexts and sessions. */
  revokeRouter(router: string): void {
    this.#revoked.add(router);
    const link = this.#links.get(router);
    if (link !== undefined) this.#closeLink(link);
    try {
      this.#options.epochs.revoke(router);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** Revokes contexts whose ownership has been withdrawn or advanced. */
  fenceOwnership(): void {
    for (const link of this.#links.values()) {
      for (const context of [...link.contexts.values()]) {
        if (
          [...context.spaces].some(([space, epoch]) =>
            this.#options.ownership(space) !== epoch
          )
        ) this.#closeContext(link, context);
      }
    }
  }

  /** Closes the private host and every socket it admitted or is negotiating. */
  close(): void {
    this.#closed = true;
    for (const link of [...this.#links.values()]) this.#closeLink(link);
    for (const socket of this.#sockets) safeClose(socket);
    this.#sockets.clear();
  }

  /** Whether a network peer may enter the bounded private handshake. */
  acceptsPeer(peer: string): boolean {
    return !this.#closed && this.#sockets.size < this.#limits.sockets &&
      [...this.#options.routers].some(([router, peers]) =>
        !this.#revoked.has(router) && !this.#options.epochs.revoked(router) &&
        peers.has(peer)
      );
  }

  /** Admits a socket framed by the private listener, never Deno's fragment collector. */
  accept(socket: WebSocket, endpoint: string, peer: string): void {
    if (
      !this.acceptsPeer(peer) ||
      !["/memory/router-link", "/memory/router-data"].includes(endpoint)
    ) {
      safeClose(socket);
      return;
    }
    socket.binaryType = "arraybuffer";
    this.#sockets.add(socket);
    socket.addEventListener("close", () => this.#sockets.delete(socket), {
      once: true,
    });
    if (endpoint === "/memory/router-link") this.#attachLink(socket, peer);
    else this.#attachData(socket, peer);
  }

  #audit(
    link: Link,
    context: Context,
    verdict: string,
    space?: string,
    reason?: string,
  ): void {
    console.info(
      JSON.stringify({
        event: "routed-memory-verdict",
        router: link.router,
        context: context.idHex,
        toolshed: this.#options.identity.did(),
        space,
        verdict,
        reason,
      }),
    );
  }

  #now(): number {
    return this.#options.now?.() ?? Math.floor(Date.now() / 1000);
  }

  /**
   * Drops tickets that expired unredeemed. A redeemed ticket left when it
   * was redeemed, a closed context's tickets leave with it, and a closed
   * link closes its contexts.
   */
  #pruneTickets(): void {
    const now = this.#now();
    for (const [id, ticket] of this.#tickets) {
      if (ticket.expires > now) break;
      this.#tickets.delete(id);
      ticket.context.tickets.delete(id);
    }
  }

  /** Closes one context and drops the statements it accepted. */
  #closeContext(link: Link, context: Context): void {
    if (context.closed) return;
    context.closed = true;
    this.#audit(link, context, "context-closed");
    context.backend?.close();
    if (context.socket !== undefined) safeClose(context.socket);
    this.#clearUsage(link, context);
    context.grants.clear();
    for (const key of context.accepted.keys()) link.claims.delete(key);
    context.accepted.clear();
    link.contexts.delete(context.idHex);
    for (const id of context.tickets) this.#tickets.delete(id);
    context.tickets.clear();
  }

  #closeLink(link: Link): void {
    if (link.closed) return;
    link.closed = true;
    for (const context of [...link.contexts.values()]) {
      this.#closeContext(link, context);
    }
    try {
      this.#options.epochs.retire(
        link.router,
        link.epochHex,
        this.#now(),
      );
    } catch {
      // The ledger latches unhealthy, so later admissions fail closed.
    }
    safeClose(link.socket);
    if (this.#links.get(link.router) === link) this.#links.delete(link.router);
  }

  #attachLink(socket: WebSocket, peer: string): void {
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const issued = this.#now();
    let link: Link | undefined;
    let pendingBytes = 0;
    let pending = 0;
    let chain = Promise.resolve();
    const deadline = setTimeout(() => safeClose(socket), 5000);
    queueMicrotask(() => {
      void new RoutedWriter("mlh1").text(this.#options.identity.did()).fixed(
        nonce,
      ).time(issued)
        .blob(
          routedFlags({
            ...this.#options.server.memoryProtocolFlags(),
            connectionAuth: true,
            routedAuthV1: true,
          }, false),
        )
        .sign(this.#options.identity).then((bytes) =>
          sendBounded(socket, bytes)
        ).catch(() => safeClose(socket));
    });
    socket.addEventListener("close", () => {
      clearTimeout(deadline);
      if (link !== undefined) this.#closeLink(link);
    }, { once: true });
    socket.addEventListener("message", (event: { data: unknown }) => {
      if (
        !(event.data instanceof ArrayBuffer) || event.data.byteLength > 4096 ||
        ++pending > 32 || (pendingBytes += event.data.byteLength) > 128 * 1024
      ) {
        safeClose(socket);
        return;
      }
      const bytes = new Uint8Array(event.data);
      chain = chain.then(async () => {
        requireRouted(socket.readyState === WebSocket.OPEN && !this.#closed);
        if (link === undefined) {
          const r = new RoutedReader(bytes.slice(0, -64), "mlc1");
          requireRouted(r.text() === this.#options.deployment);
          const router = r.text();
          requireRouted(
            !this.#revoked.has(router) &&
              this.#options.routers.get(router)?.has(peer),
          );
          requireRouted(r.text() === this.#options.identity.did());
          const epoch = r.fixed(16);
          requireRouted(
            equalRoutedBytes(r.fixed(32), nonce) && this.#now() < issued + 60,
          );
          r.end();
          await verifyRoutedRecord(bytes, router);
          requireRouted(
            socket.readyState === WebSocket.OPEN &&
              !this.#revoked.has(router) &&
              this.#options.routers.get(router)?.has(peer),
          );
          requireRouted(!this.#options.epochs.revoked(router));
          this.#options.epochs.consume(router, routedHex(epoch));
          const prior = this.#links.get(router);
          if (prior !== undefined) this.#closeLink(prior);
          link = {
            router,
            epoch,
            epochHex: routedHex(epoch),
            peer,
            socket,
            contexts: new Map(),
            claims: new Map(),
            sequence: 0,
            closed: false,
          };
          this.#links.set(router, link);
          clearTimeout(deadline);
          sendBounded(socket, new TextEncoder().encode("mlo1"));
        } else {
          const r = new RoutedReader(bytes, "mlq1");
          const sequence = r.time();
          requireRouted(sequence === link.sequence + 1 && !link.closed);
          link.sequence = sequence;
          const op = r.fixed(1)[0];
          const payload = r.blob();
          r.end();
          let result: Uint8Array;
          let status = 0;
          try {
            result = await this.#control(link, op, payload);
          } catch {
            status = 1;
            result = new Uint8Array();
          }
          requireRouted(!link.closed);
          sendBounded(
            socket,
            new RoutedWriter("mls1").time(sequence).fixed(
              new Uint8Array([status]),
            ).blob(result).bytes,
          );
        }
      }).catch(() => {
        if (link !== undefined) this.#closeLink(link);
        else safeClose(socket);
      }).finally(() => {
        pending--;
        pendingBytes -= bytes.length;
      });
    });
  }

  async #control(
    link: Link,
    op: number,
    payload: Uint8Array,
  ): Promise<Uint8Array> {
    this.#pruneTickets();
    requireRouted(
      !link.closed && !this.#revoked.has(link.router) &&
        this.#options.routers.get(link.router)?.has(link.peer),
    );
    if (op === 3) {
      requireRouted(payload.length === 16);
      const context = link.contexts.get(routedHex(payload));
      if (context !== undefined) this.#closeContext(link, context);
      return new Uint8Array();
    }
    if (op === 1) {
      const r = new RoutedReader(payload, "mat1");
      const id = r.fixed(16);
      const flags = r.blob();
      const parsed = parseRoutedJson(
        new TextDecoder("utf-8", { fatal: true }).decode(flags),
        ROUTED_DEFAULT_SLOT_LIMIT,
      );
      requireRouted(equalRoutedBytes(routedFlags(parsed), flags));
      const space = r.text();
      const epoch = r.time();
      r.end();
      requireRouted(
        isCanonicalEd25519DID(space) && epoch > 0 &&
          this.#options.ownership(space) === epoch,
      );
      let context = link.contexts.get(routedHex(id));
      if (context === undefined) {
        requireRouted(link.contexts.size < this.#limits.contextsPerLink);
        context = {
          id,
          idHex: routedHex(id),
          flags,
          spaces: new Map(),
          usage: new Map(),
          totals: { ...NO_USAGE },
          grants: new Map(),
          released: new Set(),
          accepted: new Map(),
          tickets: new Set(),
          closed: false,
        };
        link.contexts.set(routedHex(id), context);
      }
      requireRouted(
        !context.closed && equalRoutedBytes(context.flags, flags) &&
          (context.spaces.has(space) ||
            context.spaces.size < this.#limits.sessionsPerContext),
      );
      requireRouted(
        !context.spaces.has(space) || context.spaces.get(space) === epoch,
      );
      context.spaces.set(space, epoch);
      requireRouted(this.#tickets.size < this.#limits.tickets);
      const ticketBytes = crypto.getRandomValues(new Uint8Array(32));
      const ticketId = routedHex(ticketBytes);
      this.#tickets.set(ticketId, {
        id: ticketId,
        context,
        link,
        expires: this.#now() + 15,
      });
      context.tickets.add(ticketId);
      return ticketBytes;
    }
    if (op === 6) {
      const r = new RoutedReader(payload, "mvp1");
      const id = r.fixed(16);
      const flags = r.blob();
      requireRouted(
        equalRoutedBytes(
          routedFlags(
            parseRoutedJson(
              new TextDecoder("utf-8", { fatal: true }).decode(flags),
              ROUTED_DEFAULT_SLOT_LIMIT,
            ),
          ),
          flags,
        ),
      );
      const proof = readRoutedProof(r.blob());
      r.end();
      let context = link.contexts.get(routedHex(id));
      if (context === undefined) {
        requireRouted(link.contexts.size < this.#limits.contextsPerLink);
        context = {
          id,
          idHex: routedHex(id),
          flags,
          spaces: new Map(),
          usage: new Map(),
          totals: { ...NO_USAGE },
          grants: new Map(),
          released: new Set(),
          accepted: new Map(),
          tickets: new Set(),
          closed: false,
        };
        link.contexts.set(routedHex(id), context);
      }
      requireRouted(equalRoutedBytes(context.flags, flags));
      await this.#admitProof(link, context, proof);
      return new Uint8Array();
    }
    if (op === 2) {
      const r = new RoutedReader(payload, "map1");
      const ticket = this.#tickets.get(routedHex(r.fixed(32)));
      const proof = readRoutedProof(r.blob());
      r.end();
      // A redeemed ticket is no longer in `#tickets`, so it admits no proof.
      requireRouted(
        ticket !== undefined && ticket.link === link &&
          !ticket.context.closed && ticket.expires > this.#now(),
      );
      const context = ticket.context;
      await this.#admitProof(link, context, proof);
      return new Uint8Array();
    }
    const r = new RoutedReader(payload, op === 4 ? "mrl1" : "mas1");
    const context = link.contexts.get(routedHex(r.fixed(16)));
    requireRouted(context !== undefined && !context.closed);
    if (op === 4) {
      const principal = r.text();
      r.end();
      requireRouted(isCanonicalEd25519DID(principal));
      if (!context.grants.has(principal) || context.released.has(principal)) {
        return new Uint8Array();
      }
      for (const accepted of context.accepted.values()) {
        if (accepted.principal === principal) accepted.released = true;
      }
      context.released.add(principal);
      context.backend?.releasePrincipal(principal);
    } else {
      requireRouted(op === 5);
      const space = r.text();
      const epoch = r.time();
      r.end();
      requireRouted(
        isCanonicalEd25519DID(space) && epoch > 0 &&
          this.#options.ownership(space) === epoch &&
          (context.spaces.has(space) ||
            context.spaces.size < this.#limits.sessionsPerContext),
      );
      requireRouted(
        !context.spaces.has(space) || context.spaces.get(space) === epoch,
      );
      context.spaces.set(space, epoch);
    }
    return new Uint8Array();
  }

  async #admitProof(
    link: Link,
    context: Context,
    proof: RoutedProof,
  ): Promise<void> {
    try {
      const statement = await verifyRoutedProof(proof, {
        router: link.router,
        deployment: this.#options.deployment,
        epoch: link.epoch,
        context: context.id,
        now: this.#now(),
      });
      requireRouted(
        !link.closed && !context.closed && statement.exp > this.#now() &&
          !this.#options.routers.has(statement.principal) &&
          this.#options.epochs.healthy,
      );
      const now = this.#now();
      const digest = routedHex(sha256(proof.statement));
      const key = `${statement.principal}:${routedHex(statement.challenge)}`;
      // A statement serves one live context; once that context closes,
      // another may present it until it expires.
      const owner = link.claims.get(key);
      requireRouted(owner === undefined || owner === context);
      const prior = context.accepted.get(key);
      requireRouted(
        prior === undefined || prior.digest === digest && !prior.released,
      );
      for (const [key, accepted] of context.accepted) {
        if (accepted.exp > now) continue;
        context.accepted.delete(key);
        link.claims.delete(key);
      }
      // A released principal whose statement has expired admits nothing
      // more, so the history forgets it, as the router's does; creating a
      // space releases its key once its genesis commits.
      for (const [principal, grant] of context.grants) {
        if (grant.statement.exp <= now && context.released.has(principal)) {
          context.grants.delete(principal);
          context.released.delete(principal);
        }
      }
      const held = (principal: string) =>
        (context.grants.get(principal)?.statement.exp ?? 0) > now &&
        !context.released.has(principal);
      if (
        prior === undefined &&
        context.accepted.size >= this.#limits.proofsPerContext
      ) throw new RoutedProofRefusal("proof-limit");
      if (
        !held(statement.principal) &&
        [...context.grants.keys()].filter(held).length >=
          this.#limits.principalsPerContext
      ) throw new RoutedProofRefusal("principal-limit");
      if (
        !context.grants.has(statement.principal) &&
        context.grants.size >= this.#limits.principalHistoryPerContext
      ) throw new RoutedProofRefusal("principal-history-limit");
      context.accepted.set(key, {
        principal: statement.principal,
        digest,
        exp: statement.exp,
        released: false,
      });
      link.claims.set(key, context);
      context.grants.set(statement.principal, { statement, digest });
      this.#audit(link, context, "proof-accepted");
      context.released.delete(statement.principal);
      context.backend?.admitRoutedPrincipal(statement.principal, statement.exp);
    } catch (error) {
      this.#audit(
        link,
        context,
        "proof-denied",
        undefined,
        error instanceof RoutedProofRefusal ? error.reason : undefined,
      );
      this.#closeContext(link, context);
      if (!this.#options.epochs.healthy) this.close();
      throw error;
    }
  }

  /**
   * Sets one session's usage in its context, or removes it when `usage` is
   * undefined, and moves every total it counts toward by the difference, so
   * a capacity check reads totals instead of summing sessions.
   */
  #setUsage(
    link: Link,
    context: Context,
    key: string,
    usage: Usage | undefined,
  ): void {
    const prior = context.usage.get(key);
    if (prior !== undefined) this.#count(link.router, context, prior, -1);
    if (usage === undefined) context.usage.delete(key);
    else {
      context.usage.set(key, usage);
      this.#count(link.router, context, usage, 1);
    }
  }

  #count(router: string, context: Context, usage: Usage, sign: 1 | -1) {
    const add = (totals: Totals) => {
      totals.sessions += sign;
      totals.watches += sign * usage.count;
      totals.holdings += sign * usage.holdings;
    };
    add(context.totals);
    add(this.#toolshedTotals);
    for (
      const [totals, key] of [
        [this.#routerTotals, router],
        [this.#principalTotals, usage.principal],
      ] as const
    ) {
      let scope = totals.get(key);
      if (scope === undefined) totals.set(key, scope = { ...NO_USAGE });
      add(scope);
      if (scope.sessions === 0) totals.delete(key);
    }
  }

  #clearUsage(link: Link, context: Context): void {
    for (const key of [...context.usage.keys()]) {
      this.#setUsage(link, context, key, undefined);
    }
  }

  /**
   * The capacity limit that `principal`'s change to `context` passed, if
   * any: sessions, watches or holdings, per context, router link, toolshed
   * or principal. Only that principal's totals moved, so only its own are
   * read.
   */
  #overCapacity(
    link: Link,
    context: Context,
    principal: string,
  ): RefusalReason | undefined {
    const l = this.#limits;
    const scopes: [Totals, "Context" | "Router" | "Toolshed" | "Principal"][] =
      [
        [context.totals, "Context"],
        [this.#routerTotals.get(link.router) ?? NO_USAGE, "Router"],
        [this.#toolshedTotals, "Toolshed"],
        [this.#principalTotals.get(principal) ?? NO_USAGE, "Principal"],
      ];
    for (
      const [kind, reason] of [
        ["sessions", "session-limit"],
        ["watches", "watch-limit"],
        ["holdings", "holdings-limit"],
      ] as const
    ) {
      for (const [totals, scope] of scopes) {
        if (totals[kind] > l[`${kind}Per${scope}`]) return reason;
      }
    }
    return undefined;
  }

  #attachData(socket: WebSocket, peer: string): void {
    let ticket: Ticket | undefined;
    let backend: Backend | undefined;
    let compression = false;
    let failed = false;
    let pendingBytes = 0;
    const pending = new Set<string>();
    const sessions = new Map<
      string,
      {
        space: string;
        principal: string;
        watches: Set<string>;
        holdings: number;
        views: number;
      }
    >();
    const opens = new Map<
      string,
      {
        space: string;
        principal: string;
        holdings: number;
        reservation: string;
        priorReservation?: {
          principal: string;
          count: number;
          holdings: number;
        };
      }
    >();
    const mutations = new Map<string, {
      key: string;
      session: {
        space: string;
        principal: string;
        watches: Set<string>;
        holdings: number;
        views: number;
      };
      watches: Set<string>;
      holdings: number;
      views: number;
      prior?: { principal: string; count: number; holdings: number };
    }>();
    const closes = new Map<string, string>();
    let chain = Promise.resolve();
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const issued = this.#now();
    queueMicrotask(() => {
      void new RoutedWriter("mdh1").text(this.#options.identity.did()).fixed(
        nonce,
      ).time(issued)
        .sign(this.#options.identity).then((bytes) =>
          sendBounded(socket, bytes)
        ).catch(() => safeClose(socket));
    });
    const deadline = setTimeout(() => safeClose(socket), 5000);
    const fail = () => {
      failed = true;
      if (ticket !== undefined && ticket.context.socket === socket) {
        this.#closeContext(ticket.link, ticket.context);
      } else {
        backend?.close();
        safeClose(socket);
      }
    };
    socket.addEventListener("close", () => {
      clearTimeout(deadline);
      fail();
    }, { once: true });
    const send = (message: ServerMessage): void => {
      if (
        socket.readyState !== WebSocket.OPEN || ticket?.context.closed ||
        ticket?.link.closed
      ) return;
      if (message.type === "hello.ok") message.flags.routedAuthV1 = true;
      if (message.type === "response") {
        pending.delete(message.requestId);
        const mutation = mutations.get(message.requestId);
        mutations.delete(message.requestId);
        if (mutation !== undefined) {
          if (!sessions.has(mutation.key)) {
            this.#setUsage(
              ticket!.link,
              ticket!.context,
              mutation.key,
              undefined,
            );
          } else if (message.error !== undefined) {
            this.#setUsage(
              ticket!.link,
              ticket!.context,
              mutation.key,
              mutation.prior,
            );
          } else {
            mutation.session.watches = mutation.watches;
            mutation.session.holdings = mutation.holdings;
            mutation.session.views = mutation.views;
          }
        }
        const closed = closes.get(message.requestId);
        closes.delete(message.requestId);
        if (closed !== undefined && message.error === undefined) {
          sessions.delete(closed);
          this.#setUsage(ticket!.link, ticket!.context, closed, undefined);
        }
        const open = opens.get(message.requestId);
        if (open !== undefined) {
          this.#audit(
            ticket!.link,
            ticket!.context,
            message.error === undefined ? "session-admitted" : "session-denied",
            open.space,
          );
        }
        opens.delete(message.requestId);
        if (open !== undefined) {
          this.#setUsage(
            ticket!.link,
            ticket!.context,
            open.reservation,
            message.error !== undefined && sessions.has(open.reservation)
              ? open.priorReservation
              : undefined,
          );
        }
        if (
          open !== undefined && isPlainObject(message.ok) &&
          typeof message.ok.sessionId === "string"
        ) {
          const key = `${open.space} ${message.ok.sessionId}`;
          const prior = sessions.get(key);
          sessions.set(key, {
            ...open,
            watches: prior?.watches ?? new Set(),
            holdings: open.holdings,
            views: prior?.views ?? 0,
          });
          this.#setUsage(ticket!.link, ticket!.context, key, {
            principal: open.principal,
            count: (prior?.watches.size ?? 0) + (prior?.views ?? 0),
            holdings: open.holdings,
          });
        }
      }
      if (message.type === "session/revoked") {
        const key = `${message.space} ${message.sessionId}`;
        sessions.delete(key);
        this.#setUsage(ticket!.link, ticket!.context, key, undefined);
      }
      sendBounded(socket, encodeMemoryBoundary(message));
    };
    socket.addEventListener("message", (event: { data: unknown }) => {
      const frame = typeof event.data === "string"
        ? event.data
        : event.data instanceof ArrayBuffer
        ? new Uint8Array(event.data)
        : undefined;
      if (
        frame === undefined ||
        (pendingBytes += typeof frame === "string"
            ? new TextEncoder().encode(frame).length
            : frame.length) > ROUTED_QUEUE_LIMIT
      ) {
        fail();
        return;
      }
      const frameBytes = typeof frame === "string"
        ? new TextEncoder().encode(frame).length
        : frame.length;
      // The request this frame carries, once its identifier is checked, so a
      // refusal at a capacity limit can answer it.
      let refusedRequest: string | undefined;
      chain = chain.then(async () => {
        requireRouted(
          !failed && socket.readyState === WebSocket.OPEN && !this.#closed,
        );
        const parsed = decodeRoutedFrame(
          frame,
          compression,
          this.#limits.frameSlots,
        );
        const body = parsed.body;
        if (ticket === undefined) {
          requireRouted(
            typeof frame === "string" && body.type === "hello" &&
              body.protocol === "memory" && Object.keys(body).every((key) =>
                ["type", "protocol", "flags", "routerTicket", "routerBinding"]
                  .includes(key)
              ),
          );
          const id = routedHex(readRoutedHex(body.routerTicket, 32));
          const selected = this.#tickets.get(id);
          // Check the live ticket before signature verification, then recheck
          // after its await and atomically consume it against this socket nonce.
          requireRouted(
            selected !== undefined &&
              selected.expires > this.#now() && !selected.link.closed &&
              !selected.context.closed && selected.link.peer === peer,
          );
          requireRouted(
            equalRoutedBytes(routedFlags(body.flags), selected.context.flags),
          );
          const binding = new RoutedReader(
            await verifyRoutedRecord(
              readRoutedBase64(body.routerBinding),
              selected.link.router,
            ),
            "mdb1",
          );
          requireRouted(
            binding.text() === selected.link.router &&
              binding.text() === this.#options.deployment &&
              binding.text() === this.#options.identity.did(),
          );
          requireRouted(
            equalRoutedBytes(binding.fixed(16), selected.link.epoch) &&
              equalRoutedBytes(binding.fixed(16), selected.context.id),
          );
          requireRouted(
            routedHex(binding.fixed(32)) === selected.id &&
              equalRoutedBytes(binding.fixed(32), nonce) &&
              binding.time() === issued,
          );
          requireRouted(
            equalRoutedBytes(binding.fixed(32), sha256(selected.context.flags)),
          );
          binding.end();
          // Signature verification yields. Recheck the exact live ticket and
          // atomically consume it only after binding it to this socket's nonce.
          // Another socket may have redeemed it meanwhile, which removed it.
          requireRouted(
            !failed && socket.readyState === WebSocket.OPEN &&
              this.#tickets.get(selected.id) === selected &&
              selected.expires > this.#now() &&
              this.#now() < issued + 15 && !selected.link.closed &&
              !selected.context.closed &&
              !this.#revoked.has(selected.link.router),
          );
          // Spent tickets are dropped here, not kept until their context
          // closes: a context redeems one for every data socket it opens,
          // and kept ones would fill `limits.tickets` and refuse every
          // later ticket on the toolshed.
          this.#tickets.delete(selected.id);
          selected.context.tickets.delete(selected.id);
          ticket = selected;
          clearTimeout(deadline);
          const context = selected.context;
          const prior = context.socket;
          context.backend?.close();
          this.#clearUsage(selected.link, context);
          context.socket = socket;
          backend = this.#options.server.connectRouted(
            send,
            (space) =>
              !context.closed && !selected.link.closed &&
              context.spaces.has(space) &&
              context.spaces.get(space) === this.#options.ownership(space),
          );
          context.backend = backend;
          if (prior !== undefined && prior !== socket) {
            safeClose(prior);
          }
          for (const [principal, grant] of context.grants) {
            if (grant.statement.exp > this.#now()) {
              backend.admitRoutedPrincipal(principal, grant.statement.exp);
              if (context.released.has(principal)) {
                backend.releasePrincipal(principal);
              }
            }
          }
          compression = routedObject(body.flags).messageCompressionV1 === true;
          const { routerTicket: _ticket, routerBinding: _binding, ...hello } =
            body;
          await backend.receive(`fvj1:${JSON.stringify(hello)}`);
          return;
        }
        requireRouted(
          !failed && socket.readyState === WebSocket.OPEN &&
            backend !== undefined && ticket.context.socket === socket &&
            !ticket.link.closed && !ticket.context.closed,
        );
        requireRouted(
          ![
            "routerTicket",
            "routerBinding",
            "forwarded",
            "contextId",
            "upstream",
            "host",
            "authorization",
            "invocation",
            "actingAs",
            "statement",
          ].some((key) => body[key] !== undefined),
        );
        if (body.type === "memory.compression") {
          requireRouted(typeof body.enabled === "boolean");
          routedIdentifier(body.requestId);
          sendBounded(
            socket,
            encodeMemoryBoundary({
              type: "memory.compression",
              requestId: body.requestId,
              enabled: false,
            }),
          );
          return;
        }
        requireRouted(
          parsed.space !== undefined &&
            ticket.context.spaces.has(parsed.space) &&
            ticket.context.spaces.get(parsed.space) ===
              this.#options.ownership(parsed.space),
        );
        routedIdentifier(body.requestId);
        requireRouted(
          !pending.has(body.requestId) &&
            pending.size < this.#limits.requestsPerContext,
        );
        pending.add(body.requestId);
        refusedRequest = body.requestId;
        if (body.type === "session.open") {
          requireRouted(typeof body.principal === "string");
          // The router forwards an open only for a principal it holds, so
          // one this context no longer holds crossed a release or an expiry
          // on the way. An expired grant passes once the router has the
          // client sign again; a released or unknown principal does not.
          const grant = ticket.context.grants.get(body.principal);
          if (
            grant === undefined || ticket.context.released.has(body.principal)
          ) throw new RoutedRequestRefusal("principal-not-held");
          if (grant.statement.exp <= this.#now()) {
            throw new RoutedRequestRefusal("principal-expired");
          }
          const session = routedObject(body.session);
          requireRouted(session.actingAs === undefined);
          if (sessions.size + opens.size >= this.#limits.sessionsPerContext) {
            throw new RoutedRequestRefusal("session-limit");
          }
          const priorKey = typeof session.sessionId === "string"
            ? `${parsed.space} ${session.sessionId}`
            : undefined;
          const prior = priorKey === undefined
            ? undefined
            : sessions.get(priorKey);
          requireRouted(
            prior === undefined || prior.principal === body.principal,
          );
          // The parser admits a list or a record of holdings, and this
          // counts either; the Memory server then reads a list only.
          const holdings = body.holdings === undefined
            ? prior?.holdings ?? 0
            : routedCollectionSize(body.holdings);
          const reservation = prior === undefined
            ? `pending ${body.requestId}`
            : priorKey!;
          // Registered first, so a refusal's answer undoes the reservation.
          opens.set(body.requestId, {
            space: parsed.space,
            principal: body.principal,
            holdings,
            reservation,
            priorReservation: ticket.context.usage.get(reservation),
          });
          this.#setUsage(ticket.link, ticket.context, reservation, {
            principal: body.principal,
            count: (prior?.watches.size ?? 0) + (prior?.views ?? 0),
            holdings,
          });
          const over = this.#overCapacity(
            ticket.link,
            ticket.context,
            body.principal,
          );
          if (over !== undefined) throw new RoutedRequestRefusal(over);
        } else {
          routedIdentifier(body.sessionId);
          const session = sessions.get(`${parsed.space} ${body.sessionId}`);
          // A session revoked after the router forwarded this request, as
          // the creating session is once its genesis ACL commits: the
          // revocation notice is already on its way to the router, which
          // then denies the session's requests itself, so this one is
          // denied as the router would deny it.
          if (session === undefined) {
            throw new RoutedRequestRefusal("session-not-held");
          }
          requireRouted(session.space === parsed.space);
          if (
            body.type === "session.watch.set" ||
            body.type === "session.watch.add"
          ) {
            requireRouted(Array.isArray(body.watches));
            const watches = body.type === "session.watch.set"
              ? new Set<string>()
              : new Set(session.watches);
            for (const watch of body.watches) {
              const id = routedObject(watch).id;
              routedIdentifier(id);
              watches.add(id);
            }
            const key = `${parsed.space} ${body.sessionId}`;
            const holdings = body.holdings === undefined
              ? session.holdings
              : routedCollectionSize(body.holdings);
            // The parser does not look at `views`, so this is where one
            // that is neither a list nor a record is refused as malformed.
            const views = body.views === undefined
              ? session.views
              : routedCollectionSize(body.views);
            // Fixed bounds on what one session holds, refused for good and
            // answered. The parser bounds the watch IDs of one request, so
            // only a `session.watch.add` can exceed the session's bound, by
            // adding to the IDs it already holds; that breaks no rule of
            // the protocol, so it does not close the socket. The router
            // refuses either before forwarding and counts views as watches,
            // as this does.
            if (
              watches.size > WATCHES_PER_SESSION || views > VIEWS_PER_SESSION
            ) {
              throw new RoutedRequestRefusal("frame-limit");
            }
            // Registered first, so a refusal's answer undoes the reservation.
            mutations.set(body.requestId, {
              key,
              session,
              watches,
              holdings,
              views,
              prior: ticket.context.usage.get(key),
            });
            this.#setUsage(ticket.link, ticket.context, key, {
              principal: session.principal,
              count: watches.size + views,
              holdings,
            });
            const over = this.#overCapacity(
              ticket.link,
              ticket.context,
              session.principal,
            );
            if (over !== undefined) throw new RoutedRequestRefusal(over);
          }
        }
        // Retain the frame's queue budget until its protected Memory turn ends.
        // Control-link revocation can still close/fence that turn independently.
        if (
          body.type === "session.close" && typeof body.sessionId === "string"
        ) {
          const key = `${parsed.space} ${body.sessionId}`;
          closes.set(body.requestId, key);
        }
        await backend.receive(parsed.payload);
      }).catch((error) => {
        if (!(error instanceof RoutedRequestRefusal)) return fail();
        // One refused request is denied; the socket and its other sessions
        // go on, and the answer undoes any reservation.
        const requestId = refusedRequest;
        if (requestId === undefined || ticket === undefined) return fail();
        this.#audit(
          ticket.link,
          ticket.context,
          "request-refused",
          undefined,
          error.reason,
        );
        try {
          send({
            type: "response",
            requestId,
            error: {
              name: "AuthorizationError",
              message: "Routed memory request denied",
              ...(error.retriable ? { retriable: true } : {}),
            },
          } as ServerMessage);
        } catch {
          // The answer would pass the socket's output bound, which has
          // closed it; the context goes with it, as for any failed send.
          fail();
        }
      }).finally(() => {
        pendingBytes -= frameBytes;
      });
    });
  }
}

function safeClose(socket: WebSocket): void {
  if (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  ) {
    try {
      socket.close(1008, "Routed memory connection ended");
    } catch { /* A concurrent transport close already ended the socket. */ }
  }
}

function sendBounded(socket: WebSocket, bytes: string | Uint8Array): void {
  const size = typeof bytes === "string"
    ? new TextEncoder().encode(bytes).length
    : bytes.length;
  if (socket.bufferedAmount + size > ROUTED_QUEUE_LIMIT) {
    safeClose(socket);
    throw new Error("Routed memory output limit");
  }
  socket.send(bytes instanceof Uint8Array ? bytes.slice() : bytes);
}

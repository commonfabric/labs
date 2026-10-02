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
  ROUTED_QUEUE_LIMIT,
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
type Context = {
  id: Uint8Array;
  flags: Uint8Array;
  spaces: Map<string, number>;
  watches: Map<string, { principal: string; count: number; holdings: number }>;
  grants: Map<string, Grant>;
  released: Set<string>;
  accepted: Map<string, { digest: string; exp: number }>;
  backend?: Backend;
  socket?: WebSocket;
  closed: boolean;
};
type Link = {
  router: string;
  epoch: Uint8Array;
  peer: string;
  socket: WebSocket;
  contexts: Map<string, Context>;
  closedContexts: Set<string>;
  sequence: number;
  closed: boolean;
};
type Ticket = {
  id: string;
  context: Context;
  link: Link;
  expires: number;
  redeemed: boolean;
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
  /** Durable tombstones, consumed before link admission and retained across restart. */
  epochs: RoutedEpochStore;
}

/** Toolshed authority for authenticated router links and their Mode A tickets. */
export class RoutedMemoryHost {
  #options: RoutedHostOptions;
  #links = new Map<string, Link>();
  #tickets = new Map<string, Ticket>();
  #sockets = new Set<WebSocket>();

  #closed = false;
  #revoked = new Set<string>();

  /** Requires enforced ACLs, explicit ACL documents and an engine-turn fence. */
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
    return !this.#closed && this.#sockets.size < 512 &&
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

  #audit(link: Link, context: Context, verdict: string, space?: string): void {
    console.info(
      JSON.stringify({
        event: "routed-memory-verdict",
        router: link.router,
        context: routedHex(context.id),
        toolshed: this.#options.identity.did(),
        space,
        verdict,
      }),
    );
  }

  #now(): number {
    return this.#options.now?.() ?? Math.floor(Date.now() / 1000);
  }

  #pruneTickets(): void {
    const now = this.#now();
    for (const [id, ticket] of this.#tickets) {
      if (
        (!ticket.redeemed && ticket.expires <= now) || ticket.link.closed ||
        ticket.context.closed
      ) this.#tickets.delete(id);
    }
  }

  #closeContext(link: Link, context: Context): void {
    if (context.closed) return;
    context.closed = true;
    this.#audit(link, context, "context-closed");
    link.closedContexts.add(routedHex(context.id));
    try {
      for (const principal of context.grants.keys()) {
        this.#options.epochs.release(
          link.router,
          this.#options.deployment,
          routedHex(link.epoch),
          routedHex(context.id),
          principal,
          this.#now(),
        );
      }
    } catch {
      this.#closed = true;
      for (const other of [...this.#links.values()]) this.#closeLink(other);
    }
    context.backend?.close();
    if (context.socket !== undefined) safeClose(context.socket);
    context.watches.clear();
    context.grants.clear();
    context.accepted.clear();
    link.contexts.delete(routedHex(context.id));
    for (const [id, ticket] of this.#tickets) {
      if (ticket.context === context) this.#tickets.delete(id);
    }
  }

  #closeLink(link: Link): void {
    if (link.closed) return;
    link.closed = true;
    for (const context of [...link.contexts.values()]) {
      this.#closeContext(link, context);
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
            peer,
            socket,
            contexts: new Map(),
            closedContexts: new Set(),
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
      requireRouted(
        !link.closedContexts.has(routedHex(id)) &&
          link.closedContexts.size < 4096,
      );
      const flags = r.blob();
      const parsed = parseRoutedJson(
        new TextDecoder("utf-8", { fatal: true }).decode(flags),
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
        requireRouted(link.contexts.size < 256);
        context = {
          id,
          flags,
          spaces: new Map(),
          watches: new Map(),
          grants: new Map(),
          released: new Set(),
          accepted: new Map(),
          closed: false,
        };
        link.contexts.set(routedHex(id), context);
      }
      requireRouted(
        !context.closed && equalRoutedBytes(context.flags, flags) &&
          (context.spaces.has(space) || context.spaces.size < 64),
      );
      requireRouted(
        !context.spaces.has(space) || context.spaces.get(space) === epoch,
      );
      context.spaces.set(space, epoch);
      requireRouted(this.#tickets.size < 2048);
      const ticketBytes = crypto.getRandomValues(new Uint8Array(32));
      const ticketId = routedHex(ticketBytes);
      this.#tickets.set(ticketId, {
        id: ticketId,
        context,
        link,
        expires: this.#now() + 15,
        redeemed: false,
      });
      return ticketBytes;
    }
    if (op === 6) {
      const r = new RoutedReader(payload, "mvp1");
      const id = r.fixed(16);
      requireRouted(
        !link.closedContexts.has(routedHex(id)) &&
          link.closedContexts.size < 4096,
      );
      const flags = r.blob();
      requireRouted(
        equalRoutedBytes(
          routedFlags(
            parseRoutedJson(
              new TextDecoder("utf-8", { fatal: true }).decode(flags),
            ),
          ),
          flags,
        ),
      );
      const proof = readRoutedProof(r.blob());
      r.end();
      let context = link.contexts.get(routedHex(id));
      if (context === undefined) {
        requireRouted(link.contexts.size < 256);
        context = {
          id,
          flags,
          spaces: new Map(),
          watches: new Map(),
          grants: new Map(),
          released: new Set(),
          accepted: new Map(),
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
      requireRouted(
        ticket !== undefined && ticket.link === link &&
          !ticket.context.closed &&
          !ticket.redeemed && ticket.expires > this.#now(),
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
      try {
        this.#options.epochs.release(
          link.router,
          this.#options.deployment,
          routedHex(link.epoch),
          routedHex(context.id),
          principal,
          this.#now(),
        );
      } catch (error) {
        this.close();
        throw error;
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
          (context.spaces.has(space) || context.spaces.size < 64),
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
          !this.#options.routers.has(statement.principal),
      );
      const digest = routedHex(sha256(proof.statement));
      const key = `${statement.principal}:${routedHex(statement.challenge)}`;
      const prior = context.accepted.get(key);
      requireRouted(prior === undefined || prior.digest === digest);
      for (const [key, accepted] of context.accepted) {
        if (accepted.exp <= this.#now()) context.accepted.delete(key);
      }
      requireRouted(
        (prior !== undefined || context.accepted.size < 128) &&
          ((context.grants.get(statement.principal)?.statement.exp ?? 0) >
                  this.#now() && !context.released.has(statement.principal) ||
            [...context.grants].filter(([principal, grant]) =>
                grant.statement.exp > this.#now() &&
                !context.released.has(principal)
              ).length < 8),
      );
      requireRouted(
        context.grants.has(statement.principal) || context.grants.size < 64,
      );
      this.#options.epochs.claim({
        router: link.router,
        deployment: this.#options.deployment,
        principal: statement.principal,
        challenge: routedHex(statement.challenge),
        digest,
        epoch: routedHex(link.epoch),
        context: routedHex(context.id),
        exp: statement.exp,
      }, this.#now());
      context.accepted.set(key, { digest, exp: statement.exp });
      context.grants.set(statement.principal, { statement, digest });
      this.#audit(link, context, "proof-accepted");
      context.released.delete(statement.principal);
      context.backend?.admitRoutedPrincipal(statement.principal, statement.exp);
    } catch (error) {
      this.#audit(link, context, "proof-denied");
      this.#closeContext(link, context);
      if (!this.#options.epochs.healthy) this.close();
      throw error;
    }
  }

  #quota(link: Link, context: Context): void {
    const all = [...this.#links.values()].flatMap((l) =>
      [...l.contexts.values()].map((c) => ({
        router: l.router,
        context: c,
        entries: [...c.watches.values()],
      }))
    );
    const total = (
      entries: { count: number; holdings: number }[],
      field: "count" | "holdings",
    ) => entries.reduce((sum, item) => sum + item[field], 0);
    const entries = all.flatMap((item) => item.entries);
    const router = all.filter((item) => item.router === link.router).flatMap((
      item,
    ) => item.entries);
    const local = [...context.watches.values()];
    requireRouted(
      local.length <= 64 && router.length <= 1024 && entries.length <= 4096,
    );
    requireRouted(
      total(local, "count") <= 1024 && total(router, "count") <= 4096 &&
        total(entries, "count") <= 8192,
    );
    requireRouted(
      total(local, "holdings") <= 8192 && total(router, "holdings") <= 32768 &&
        total(entries, "holdings") <= 65536,
    );
    for (const principal of new Set(local.map((item) => item.principal))) {
      const owned = entries.filter((item) => item.principal === principal);
      requireRouted(
        owned.length <= 128 && total(owned, "count") <= 2048 &&
          total(owned, "holdings") <= 16384,
      );
    }
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
            ticket!.context.watches.delete(mutation.key);
          } else if (message.error !== undefined) {
            if (mutation.prior === undefined) {
              ticket!.context.watches.delete(mutation.key);
            } else ticket!.context.watches.set(mutation.key, mutation.prior);
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
          ticket!.context.watches.delete(closed);
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
          if (
            message.error !== undefined &&
            open.priorReservation !== undefined &&
            sessions.has(open.reservation)
          ) {
            ticket!.context.watches.set(
              open.reservation,
              open.priorReservation,
            );
          } else ticket!.context.watches.delete(open.reservation);
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
          ticket!.context.watches.set(key, {
            principal: open.principal,
            count: (prior?.watches.size ?? 0) + (prior?.views ?? 0),
            holdings: open.holdings,
          });
        }
      }
      if (message.type === "session/revoked") {
        const key = `${message.space} ${message.sessionId}`;
        sessions.delete(key);
        ticket!.context.watches.delete(key);
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
      chain = chain.then(async () => {
        requireRouted(
          !failed && socket.readyState === WebSocket.OPEN && !this.#closed,
        );
        const parsed = decodeRoutedFrame(frame, compression);
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
            selected !== undefined && !selected.redeemed &&
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
          requireRouted(
            !failed && socket.readyState === WebSocket.OPEN &&
              !selected.redeemed && selected.expires > this.#now() &&
              this.#now() < issued + 15 && !selected.link.closed &&
              !selected.context.closed &&
              !this.#revoked.has(selected.link.router),
          );
          selected.redeemed = true;
          ticket = selected;
          clearTimeout(deadline);
          const context = selected.context;
          const prior = context.socket;
          context.backend?.close();
          context.watches.clear();
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
        requireRouted(!pending.has(body.requestId) && pending.size < 256);
        pending.add(body.requestId);
        if (body.type === "session.open") {
          requireRouted(
            typeof body.principal === "string" &&
              ticket.context.grants.has(body.principal) &&
              !ticket.context.released.has(body.principal) &&
              ticket.context.grants.get(body.principal)!.statement.exp >
                this.#now(),
          );
          const session = routedObject(body.session);
          requireRouted(
            session.actingAs === undefined && sessions.size + opens.size < 64,
          );
          const priorKey = typeof session.sessionId === "string"
            ? `${parsed.space} ${session.sessionId}`
            : undefined;
          const prior = priorKey === undefined
            ? undefined
            : sessions.get(priorKey);
          requireRouted(
            prior === undefined || prior.principal === body.principal,
          );
          const holdings = body.holdings === undefined
            ? prior?.holdings ?? 0
            : (body.holdings as unknown[]).length;
          const reservation = prior === undefined
            ? `pending ${body.requestId}`
            : priorKey!;
          const priorReservation = ticket.context.watches.get(reservation);
          ticket.context.watches.set(reservation, {
            principal: body.principal,
            count: (prior?.watches.size ?? 0) + (prior?.views ?? 0),
            holdings,
          });
          this.#quota(ticket.link, ticket.context);
          opens.set(body.requestId, {
            space: parsed.space,
            principal: body.principal,
            holdings,
            reservation,
            priorReservation,
          });
        } else {
          routedIdentifier(body.sessionId);
          const session = sessions.get(`${parsed.space} ${body.sessionId}`);
          requireRouted(session?.space === parsed.space);
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
            const prior = ticket.context.watches.get(key)?.count ?? 0;
            const usage = [...this.#links.values()].flatMap((link) =>
              [...link.contexts.values()].map((context) => ({
                router: link.router,
                context,
                entries: [...context.watches.values()],
              }))
            );
            const contextTotal =
              [...ticket.context.watches.values()].reduce((sum, entry) =>
                sum + entry.count, 0) - prior + watches.size;
            const routerTotal = usage.filter((entry) =>
              entry.router === ticket!.link.router
            ).reduce((sum, entry) =>
              sum + entry.entries.reduce((total, item) =>
                total + item.count, 0), 0) - prior + watches.size;
            const principalTotal = usage.reduce((sum, entry) =>
              sum + entry.entries.filter((item) =>
                item.principal === session.principal
              ).reduce((total, item) =>
                total + item.count, 0), 0) - prior + watches.size;
            const total = usage.reduce((sum, entry) =>
              sum + entry.entries.reduce((count, item) =>
                count + item.count, 0), 0) - prior + watches.size;
            requireRouted(
              watches.size <= 1024 && contextTotal <= 1024 &&
                routerTotal <= 4096 && principalTotal <= 2048 && total <= 8192,
            );
            const holdings = body.holdings === undefined
              ? session.holdings
              : (body.holdings as unknown[]).length;
            const views = body.views === undefined
              ? session.views
              : (body.views as unknown[]).length;
            requireRouted(views <= 64);
            const priorUsage = ticket.context.watches.get(key);
            ticket.context.watches.set(key, {
              principal: session.principal,
              count: watches.size + views,
              holdings,
            });
            this.#quota(ticket.link, ticket.context);
            mutations.set(body.requestId, {
              key,
              session,
              watches,
              holdings,
              views,
              prior: priorUsage,
            });
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
      }).catch(fail).finally(() => {
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

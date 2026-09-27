import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type PresenceRecord,
} from "../v2.ts";
import {
  connect,
  loopback,
  type PresenceEvent,
  type SpaceSession,
  type Transport,
} from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  TEST_SESSION_OPEN_AUDIENCE,
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const ROOM = "room-0123456789abcdefghijklmnop";

const createServer = (name: string): Server =>
  new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://memory-v2-presence-client-${name}`),
    subscriptionRefreshDelayMs: "manual",
  });

/**
 * A transport whose server connection can be dropped and re-established, so
 * a client reconnects through it; frames the server sends reach the client
 * as they are sent.
 */
class ReconnectableTransport implements Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connection: ReturnType<Server["connect"]> | null = null;
  #connections = 0;
  readonly #server: Server;

  constructor(server: Server) {
    this.#server = server;
  }

  get connections(): number {
    return this.#connections;
  }

  async send(payload: string): Promise<void> {
    await this.#connect().receive(payload);
  }

  close(): Promise<void> {
    this.disconnect();
    return Promise.resolve();
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  disconnect(): void {
    this.#connection?.close();
    this.#connection = null;
    this.#closeReceiver(new Error("disconnect"));
  }

  #connect(): ReturnType<Server["connect"]> {
    if (this.#connection === null) {
      this.#connections++;
      this.#connection = this.#server.connect((message) => {
        this.#receiver(encodeMemoryBoundary(message));
      });
    }
    return this.#connection;
  }
}

/** Collects a room's events and lets a test wait for the next one. */
class Observer {
  events: PresenceEvent[] = [];
  #waiting: ((event: PresenceEvent) => void)[] = [];

  readonly observe = (event: PresenceEvent): void => {
    this.events.push(event);
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const resolve of waiting) resolve(event);
  };

  /** Resolves with the next event of `kind` delivered after this call. */
  next<Kind extends PresenceEvent["kind"]>(
    kind: Kind,
  ): Promise<Extract<PresenceEvent, { kind: Kind }>> {
    return new Promise((resolve) => {
      const wait = (event: PresenceEvent) => {
        if (event.kind === kind) {
          resolve(event as Extract<PresenceEvent, { kind: Kind }>);
        } else {
          this.#waiting.push(wait);
        }
      };
      this.#waiting.push(wait);
    });
  }
}

const mountBoth = async (
  server: Server,
  space: string,
): Promise<{
  a: SpaceSession;
  b: SpaceSession;
  close: () => Promise<void>;
}> => {
  const clientA = await connect({ transport: loopback(server) });
  const clientB = await connect({ transport: loopback(server) });
  const a = await clientA.mount(space, {}, testSessionOpenAuthFactory);
  const b = await clientB.mount(space, {}, testSessionOpenAuthFactory);
  return {
    a,
    b,
    close: async () => {
      await clientA.close();
      await clientB.close();
      await server.close();
    },
  };
};

describe("v2-presence-client", () => {
  describe("joinPresenceRoom()", () => {
    it("delivers the room's snapshot on join and a peer's publications after it", async () => {
      const server = createServer("join");
      const space = "did:key:z6Mk-presence-client-join";
      const { a, b, close } = await mountBoth(server, space);
      const clientC = await connect({ transport: loopback(server) });
      try {
        const c = await clientC.mount(space, {}, testSessionOpenAuthFactory);
        const observerA = new Observer();
        const observerB = new Observer();
        const observerC = new Observer();
        const membershipB = await b.joinPresenceRoom(ROOM, observerB.observe);
        const membershipA = await a.joinPresenceRoom(ROOM, observerA.observe);
        expect(observerA.events).toEqual([{
          kind: "snapshot",
          participantId: membershipA.participantId,
          participants: [],
        }]);
        const upsertForB = observerB.next("upsert");
        membershipA.publish({
          name: "Ada",
          facets: { caret: { focused: true } },
        });
        const recordA: PresenceRecord = {
          participantId: membershipA.participantId,
          principal: TEST_SESSION_OPEN_PRINCIPAL,
          revision: 1,
          name: "Ada",
          facets: { caret: { focused: true } },
        };
        expect((await upsertForB).participant).toEqual(recordA);
        // B joined before A published, so its snapshot was empty and the
        // record reached it as an upsert; C joins after, and finds the
        // record in its snapshot.
        const membershipC = await c.joinPresenceRoom(ROOM, observerC.observe);
        expect(observerC.events).toEqual([{
          kind: "snapshot",
          participantId: membershipC.participantId,
          participants: [recordA],
        }]);
        expect(membershipB.participantId).not.toBe(membershipA.participantId);
        expect(observerA.events).toHaveLength(1);
      } finally {
        await clientC.close();
        await close();
      }
    });

    it("shares one membership between two observers and leaves after the last one", async () => {
      const server = createServer("shared");
      const space = "did:key:z6Mk-presence-client-shared";
      const { a, close } = await mountBoth(server, space);
      try {
        const first = new Observer();
        const second = new Observer();
        const membershipFirst = await a.joinPresenceRoom(ROOM, first.observe);
        const membershipSecond = await a.joinPresenceRoom(ROOM, second.observe);
        expect(membershipSecond.participantId).toBe(
          membershipFirst.participantId,
        );
        expect(second.events).toEqual([{
          kind: "snapshot",
          participantId: membershipFirst.participantId,
          participants: [],
        }]);
        expect(server.presenceMemberCount(space, ROOM)).toBe(1);
        await membershipFirst.leave();
        await membershipFirst.leave();
        expect(server.presenceMemberCount(space, ROOM)).toBe(1);
        await membershipSecond.leave();
        expect(server.presenceMemberCount(space, ROOM)).toBe(0);
      } finally {
        await close();
      }
    });

    it("sends only the latest of the publications made in one tick", async () => {
      const server = createServer("coalesce");
      const space = "did:key:z6Mk-presence-client-coalesce";
      const { a, b, close } = await mountBoth(server, space);
      try {
        const observerB = new Observer();
        await b.joinPresenceRoom(ROOM, observerB.observe);
        const membershipA = await a.joinPresenceRoom(ROOM, () => {});
        const upsert = observerB.next("upsert");
        membershipA.publish({ name: "Ada", facets: {} });
        membershipA.publish({ name: "Ada Lovelace", facets: {} });
        const { participant } = await upsert;
        expect(participant.revision).toBe(2);
        expect(participant.name).toBe("Ada Lovelace");
        // The relay pushes in the order it accepts, so had the first
        // publication been sent its upsert would have arrived before this.
        expect(observerB.events.filter((event) => event.kind === "upsert"))
          .toHaveLength(1);
      } finally {
        await close();
      }
    });

    it("throws for a publication outside the relay's bounds before sending it", async () => {
      const server = createServer("bounds");
      const space = "did:key:z6Mk-presence-client-bounds";
      const { a, close } = await mountBoth(server, space);
      try {
        const membership = await a.joinPresenceRoom(ROOM, () => {});
        expect(() => membership.publish({ name: " ", facets: {} })).toThrow(
          "Presence name",
        );
        expect(() => membership.publish({ name: "Ada", facets: { Caret: {} } }))
          .toThrow("facet name");
      } finally {
        await close();
      }
    });

    it("reports a publication the relay refuses as a failure", async () => {
      const server = createServer("refused");
      const space = "did:key:z6Mk-presence-client-refused";
      // Every publish is rewritten on the way to the server so that it
      // carries a name the relay refuses.
      const inner = loopback(server);
      const rewriting: Transport = {
        ...inner,
        send(payload) {
          const message = decodeMemoryBoundary(payload) as {
            type?: string;
            name?: string;
          };
          if (message.type === "presence.publish") {
            return inner.send(encodeMemoryBoundary({ ...message, name: "" }));
          }
          return inner.send(payload);
        },
      };
      const client = await connect({ transport: rewriting });
      try {
        const session = await client.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        const observer = new Observer();
        const membership = await session.joinPresenceRoom(
          ROOM,
          observer.observe,
        );
        const failure = observer.next("failure");
        membership.publish({ name: "Ada", facets: {} });
        expect((await failure).error.name).toBe("PresenceError");
      } finally {
        await client.close();
        await server.close();
      }
    });

    it("refuses to join when the server does not advertise `presenceV1`", async () => {
      const { presenceV1: _presenceV1, ...flags } = getMemoryProtocolFlags();
      let receiver = (_payload: string) => {};
      const transport: Transport = {
        send(payload) {
          const message = decodeMemoryBoundary(payload) as {
            type?: string;
            requestId?: string;
          };
          if (message.type === "hello") {
            receiver(encodeMemoryBoundary({
              type: "hello.ok",
              protocol: MEMORY_PROTOCOL,
              flags,
              sessionOpen: {
                audience: TEST_SESSION_OPEN_AUDIENCE,
                challenge: { value: "challenge:old", expiresAt: 1_000_000 },
              },
            }));
          } else if (message.type === "session.open") {
            receiver(encodeMemoryBoundary({
              type: "response",
              requestId: message.requestId!,
              ok: {
                sessionId: "session:old",
                sessionToken: "token:old",
                serverSeq: 0,
                sessionOpen: {
                  audience: TEST_SESSION_OPEN_AUDIENCE,
                  challenge: { value: "challenge:next", expiresAt: 1_000_000 },
                },
              },
            }));
          }
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
        setReceiver(next) {
          receiver = next;
        },
        setCloseReceiver() {},
      };
      const client = await connect({ transport });
      try {
        const session = await client.mount(
          "did:key:z6Mk-presence-client-old-server",
          {},
          testSessionOpenAuthFactory,
        );
        await expect(session.joinPresenceRoom(ROOM, () => {})).rejects.toThrow(
          "does not support presence",
        );
      } finally {
        await client.close();
      }
    });
  });

  describe("reconnect", () => {
    it("rejoins with a new participant id and republishes the last record", async () => {
      const server = createServer("reconnect");
      const space = "did:key:z6Mk-presence-client-reconnect";
      const transportA = new ReconnectableTransport(server);
      const clientA = await connect({ transport: transportA });
      const clientB = await connect({ transport: loopback(server) });
      try {
        const a = await clientA.mount(space, {}, testSessionOpenAuthFactory);
        const b = await clientB.mount(space, {}, testSessionOpenAuthFactory);
        const observerA = new Observer();
        const observerB = new Observer();
        await b.joinPresenceRoom(ROOM, observerB.observe);
        const membershipA = await a.joinPresenceRoom(ROOM, observerA.observe);
        const firstId = membershipA.participantId;
        const firstUpsert = observerB.next("upsert");
        membershipA.publish({
          name: "Ada",
          facets: { caret: { focused: true } },
        });
        await firstUpsert;

        const removed = observerB.next("remove");
        const rejoined = observerA.next("snapshot");
        const republished = observerB.next("upsert");
        transportA.disconnect();
        expect((await removed).participantId).toBe(firstId);
        const snapshot = await rejoined;
        expect(snapshot.participantId).not.toBe(firstId);
        expect(membershipA.participantId).toBe(snapshot.participantId);
        expect(snapshot.participants.map((record) => record.name)).toEqual([]);
        const { participant } = await republished;
        expect(participant).toEqual({
          participantId: snapshot.participantId,
          principal: TEST_SESSION_OPEN_PRINCIPAL,
          revision: 2,
          name: "Ada",
          facets: { caret: { focused: true } },
        });
        expect(transportA.connections).toBe(2);
      } finally {
        await clientA.close();
        await clientB.close();
        await server.close();
      }
    });

    it("ends every room with a failure when the session is taken over", async () => {
      const server = createServer("takeover");
      const space = "did:key:z6Mk-presence-client-takeover";
      const { a, b, close } = await mountBoth(server, space);
      const successor = await connect({ transport: loopback(server) });
      try {
        const observerA = new Observer();
        const observerB = new Observer();
        await b.joinPresenceRoom(ROOM, observerB.observe);
        const membershipA = await a.joinPresenceRoom(ROOM, observerA.observe);
        const upsert = observerB.next("upsert");
        membershipA.publish({ name: "Ada", facets: {} });
        await upsert;
        const failure = observerA.next("failure");
        const removed = observerB.next("remove");
        await successor.mount(space, {
          sessionId: a.sessionId,
          sessionToken: a.sessionToken,
        }, testSessionOpenAuthFactory);
        expect((await failure).error.name).toBe("SessionRevokedError");
        expect((await removed).participantId).toBe(membershipA.participantId);
        await membershipA.leave();
        expect(server.presenceMemberCount(space, ROOM)).toBe(1);
      } finally {
        await successor.close();
        await close();
      }
    });
  });
});

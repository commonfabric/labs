import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { defer } from "@commonfabric/utils/defer";

import {
  connect,
  type SessionAuth,
  type SessionOpenAuthContext,
  type Transport,
} from "../v2/client.ts";
import { verifyConnectionAuthorization } from "../v2/connection-auth.ts";
import { Server } from "../v2/server.ts";
import { verifySessionOpenAuthorization } from "../v2/session-open-auth.ts";
import { alice, bob, mallory, space as spaceIdentity } from "./principal.ts";
import { principalOf } from "./support/connection-auth.ts";
import { ServerTransport } from "./support/server-transport.ts";

const AUDIENCE = bob.did();
const SPACES = [
  "did:key:z6Mk-client-connection-auth-one",
  "did:key:z6Mk-client-connection-auth-two",
  "did:key:z6Mk-client-connection-auth-three",
];

type Options = {
  /** Whether the host verifies `connection.auth`; it does unless `false`. */
  connectionAuth?: boolean;

  /** Principals whose `connection.auth` the host refuses, permanently. */
  refused?: Set<string>;

  /**
   * The server's clock, in unix seconds, which a test moves; the real one
   * when left out.
   */
  clock?: { now: number };

  /** How long a challenge the server issues lives, in seconds. */
  challengeTtlSeconds?: number;
};

const createServer = (name: string, options: Options = {}): Server =>
  new Server({
    store: new URL(`memory://memory-v2-client-connection-auth-${name}`),
    subscriptionRefreshDelayMs: "manual",
    authorizeSessionOpen: verifySessionOpenAuthorization,
    ...(options.connectionAuth === false ? {} : {
      authorizeConnection: async (message, context) => {
        const principal = await verifyConnectionAuthorization(message, {
          ...context,
          ...(options.clock === undefined
            ? {}
            : { nowSeconds: options.clock.now }),
        });
        if (options.refused?.has(principal)) {
          throw Object.assign(new Error(`${principal} is refused`), {
            name: "AuthorizationError",
          });
        }
        return principal;
      },
    }),
    sessionOpenAuth: {
      audience: AUDIENCE,
      ...(options.clock === undefined
        ? {}
        : { nowSeconds: () => options.clock!.now }),
      ...(options.challengeTtlSeconds === undefined
        ? {}
        : { challengeTtlSeconds: options.challengeTtlSeconds }),
    },
  });

const principalsIn = (server: Server, space: string): (string | undefined)[] =>
  server.accessForTestingOnly.sessionsForSpace(space).map((session) =>
    session.principal
  );

describe("Client connection authentication", () => {
  describe("mount()", () => {
    it("authenticates a key once for sessions mounted together in several spaces", async () => {
      const server = createServer("once");
      const transport = new ServerTransport(server);
      const client = await connect({ transport });
      try {
        await Promise.all(
          SPACES.map((space) => client.mount(space, {}, principalOf(alice))),
        );
        expect(transport.sentTypes).toEqual([
          "hello",
          "connection.auth",
          "session.open",
          "session.open",
          "session.open",
        ]);
        for (const message of transport.sent.slice(2)) {
          expect(message.principal).toBe(alice.did());
          expect(message.invocation).toBeUndefined();
          expect(message.authorization).toBeUndefined();
        }
        for (const space of SPACES) {
          expect(principalsIn(server, space)).toEqual([alice.did()]);
        }
      } finally {
        await client.close();
        await server.close();
      }
    });

    it("mounts sessions as two keys on one connection", async () => {
      const server = createServer("two-keys");
      const transport = new ServerTransport(server);
      const client = await connect({ transport });
      try {
        await client.mount(SPACES[0], {}, principalOf(alice));
        await client.mount(SPACES[0], {}, principalOf(spaceIdentity));
        expect(principalsIn(server, SPACES[0]).sort()).toEqual(
          [alice.did(), spaceIdentity.did()].sort(),
        );
        expect(
          transport.sentTypes.filter((type) => type === "connection.auth"),
        ).toHaveLength(2);
      } finally {
        await client.close();
        await server.close();
      }
    });

    it("rejects with a permanent `AuthorizationError` for a key the server refuses", async () => {
      const server = createServer("refused", {
        refused: new Set([mallory.did()]),
      });
      const client = await connect({ transport: new ServerTransport(server) });
      try {
        const refused = await client.mount(SPACES[0], {}, principalOf(mallory))
          .then(() => undefined, (error: Error) => error);
        expect(refused?.name).toBe("AuthorizationError");
        expect((refused as { retriable?: boolean }).retriable).toBeUndefined();
        expect(
          (await client.mount(SPACES[0], {}, principalOf(alice))).sessionId,
        ).toBeDefined();
      } finally {
        await client.close();
        await server.close();
      }
    });

    it("signs each `session.open`, one at a time, for a server that does not advertise `connectionAuth`", async () => {
      const server = createServer("signed-opens", { connectionAuth: false });
      const transport = new ServerTransport(server);
      const client = await connect({ transport });
      try {
        await Promise.all(
          SPACES.map((space) => client.mount(space, {}, principalOf(alice))),
        );
        expect(transport.sentTypes).toEqual([
          "hello",
          "session.open",
          "session.open",
          "session.open",
        ]);
        for (const message of transport.sent.slice(1)) {
          expect(message.principal).toBeUndefined();
          expect(message.invocation).toBeDefined();
        }
        for (const space of SPACES) {
          expect(principalsIn(server, space)).toEqual([alice.did()]);
        }
      } finally {
        await client.close();
        await server.close();
      }
    });

    it("asks for a challenge when the one it holds has expired", async () => {
      // The server's clock is decades behind the client's, so every
      // challenge it issues has expired by the client's clock.
      const server = createServer("expired", { clock: { now: 1_000_000 } });
      const transport = new ServerTransport(server);
      const client = await connect({ transport });
      try {
        await client.mount(SPACES[0], {}, principalOf(alice));
        expect(transport.sentTypes).toEqual([
          "hello",
          "connection.challenge",
          "connection.auth",
          "session.open",
        ]);
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  describe("mount() against a server whose clock runs ahead", () => {
    it("asks for a challenge when the server refuses the one it holds as expired", async () => {
      // By this clock the challenge is live; by the server's, moved on
      // after issuing it, it has expired, and the refusal says so.
      const clock = { now: Math.floor(Date.now() / 1000) };
      const server = createServer("server-clock-ahead", {
        clock,
        challengeTtlSeconds: 30,
      });
      const transport = new ServerTransport(server);
      const client = await connect({ transport });
      try {
        clock.now += 60;
        await client.mount(SPACES[0], {}, principalOf(alice));
        expect(transport.sentTypes).toEqual([
          "hello",
          "connection.auth",
          "connection.challenge",
          "connection.auth",
          "session.open",
        ]);
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  describe("release()", () => {
    it("ends a key's authentication, which a later mount as that key renews", async () => {
      const server = createServer("release");
      const transport = new ServerTransport(server);
      const client = await connect({ transport });
      try {
        await client.mount(SPACES[0], {}, principalOf(spaceIdentity));
        await client.release(spaceIdentity.did());
        transport.clearSent();
        await client.mount(SPACES[1], {}, principalOf(spaceIdentity));
        expect(transport.sentTypes).toEqual([
          "connection.auth",
          "session.open",
        ]);
      } finally {
        await client.close();
        await server.close();
      }
    });

    it("sends nothing for a key the client has not authenticated", async () => {
      const server = createServer("release-unknown");
      const transport = new ServerTransport(server);
      const client = await connect({ transport });
      try {
        await client.release(alice.did());
        expect(transport.sentTypes).toEqual(["hello"]);
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  describe("reconnecting", () => {
    it("authenticates each key once and restores every session", async () => {
      const server = createServer("reconnect");
      const transport = new ServerTransport(server);
      const client = await connect({ transport });
      try {
        const sessions = await Promise.all(
          SPACES.map((space) => client.mount(space, {}, principalOf(alice))),
        );
        transport.clearSent();
        transport.drop();
        await client.restoreConnection();
        await Promise.all(sessions.map((session) => session.whenRestored()));
        expect(transport.sentTypes.toSorted()).toEqual([
          "connection.auth",
          "hello",
          "session.open",
          "session.open",
          "session.open",
        ]);
        expect(transport.sentTypes.slice(0, 2)).toEqual([
          "hello",
          "connection.auth",
        ]);
        expect(
          (await sessions[0].queryGraph({ roots: [] })).serverSeq,
        ).toBe(0);
      } finally {
        await client.close();
        await server.close();
      }
    });

    it("restores a session while another space's session is still opening", async () => {
      const server = createServer("reconnect-concurrent");
      const transport = new ServerTransport(server);
      const client = await connect({ transport });
      const gate = defer<void>();
      try {
        const [slow, fast] = await Promise.all(
          SPACES.slice(0, 2).map((space) =>
            client.mount(space, {}, principalOf(alice))
          ),
        );
        server.accessForTestingOnly.engineOpener = (opening, open) =>
          opening === slow.space
            ? gate.promise.then(() => open(opening))
            : open(opening);
        transport.drop();
        const restored = client.restoreConnection();
        await fast.whenRestored();
        expect((await fast.queryGraph({ roots: [] })).serverSeq).toBe(0);
        gate.resolve();
        await restored;
        await slow.whenRestored();
      } finally {
        gate.resolve();
        await client.close();
        await server.close();
      }
    });

    it("mounts a session that was started while the reconnect's `hello` was pending", async () => {
      // The mount waits for the reconnect, restores included, and then
      // authenticates over a challenge of the new connection.
      const server = createServer("mount-during-reconnect");
      const inner = new ServerTransport(server);
      const helloGate = defer<void>();
      const helloHeld = defer<void>();
      let holdHello = false;
      const transport: Transport = {
        async send(payload) {
          if (holdHello && payload.includes('"hello"')) {
            holdHello = false;
            helloHeld.resolve();
            await helloGate.promise;
          }
          await inner.send(payload);
        },
        close: () => inner.close(),
        setReceiver: (receiver) => inner.setReceiver(receiver),
        setCloseReceiver: (receiver) => inner.setCloseReceiver(receiver),
      };
      const client = await connect({ transport });
      try {
        const first = await client.mount(SPACES[0], {}, principalOf(alice));
        holdHello = true;
        inner.drop();
        const mounting = client.mount(SPACES[1], {}, principalOf(alice));
        await helloHeld.promise;
        inner.clearSent();
        helloGate.resolve();
        const second = await mounting;
        await first.whenRestored();
        expect(inner.sentTypes).toEqual([
          "hello",
          "connection.auth",
          "session.open",
          "session.open",
        ]);
        expect((await second.queryGraph({ roots: [] })).serverSeq).toBe(0);
      } finally {
        helloGate.resolve();
        await client.close();
        await server.close();
      }
    });

    it("mounts a session whose `connection.auth` was being signed when the connection dropped", async () => {
      // The signature is over a challenge of the connection that is gone,
      // so the mount signs again on the new one, after the restores.
      const server = createServer("signing-across-drop");
      const transport = new ServerTransport(server);
      const client = await connect({ transport });
      const signing = defer<void>();
      const held = principalOf(spaceIdentity);
      const slowSigner = {
        ...held,
        authorizeConnection: async (context: SessionOpenAuthContext) => {
          await signing.promise;
          return await held.authorizeConnection(context);
        },
      };
      try {
        const first = await client.mount(SPACES[0], {}, principalOf(alice));
        const mounting = client.mount(SPACES[1], {}, slowSigner);
        transport.clearSent();
        transport.drop();
        signing.resolve();
        const second = await mounting;
        await first.whenRestored();
        expect(transport.sentTypes.slice(0, 2)).toEqual([
          "hello",
          "connection.auth",
        ]);
        expect(
          transport.sent.filter((message) => message.type === "connection.auth")
            .map((
              message,
            ) => (message.invocation as { iss: string; challenge: string })),
        ).toEqual([
          { iss: alice.did(), challenge: expect.any(String) },
          { iss: spaceIdentity.did(), challenge: expect.any(String) },
        ].map(expect.objectContaining));
        expect((await second.queryGraph({ roots: [] })).serverSeq).toBe(0);
      } finally {
        signing.resolve();
        await client.close();
        await server.close();
      }
    });

    it("mounts a session whose signed `session.open` was being signed when the connection dropped", async () => {
      // Against a server without `connectionAuth`, the restores' signed
      // opens are not held behind the mount's, which signs again after them.
      const server = createServer("signed-open-across-drop", {
        connectionAuth: false,
      });
      const transport = new ServerTransport(server);
      const client = await connect({ transport });
      const signing = defer<void>();
      const held = principalOf(alice);
      const slowSigner: SessionAuth = {
        ...held,
        authorizeSessionOpen: async (space, session, context) => {
          await signing.promise;
          return await held.authorizeSessionOpen(space, session, context);
        },
      };
      try {
        const first = await client.mount(SPACES[0], {}, held);
        const mounting = client.mount(SPACES[1], {}, slowSigner);
        transport.clearSent();
        transport.drop();
        signing.resolve();
        const second = await mounting;
        await first.whenRestored();
        expect(transport.sentTypes).toEqual([
          "hello",
          "session.open",
          "session.open",
        ]);
        expect((await second.queryGraph({ roots: [] })).serverSeq).toBe(0);
      } finally {
        signing.resolve();
        await client.close();
        await server.close();
      }
    });

    it("terminates the sessions of a key refused permanently, and restores the others", async () => {
      const refused = new Set<string>();
      const server = createServer("reconnect-refused", { refused });
      const transport = new ServerTransport(server);
      const client = await connect({ transport });
      try {
        const kept = await client.mount(SPACES[0], {}, principalOf(alice));
        const lost = await client.mount(SPACES[1], {}, principalOf(mallory));
        refused.add(mallory.did());
        transport.drop();
        await client.restoreConnection();
        expect(lost.closeError?.name).toBe("AuthorizationError");
        expect(kept.closeError).toBeUndefined();
        expect((await kept.queryGraph({ roots: [] })).serverSeq).toBe(0);
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  describe("SpaceSession.close()", () => {
    it("sends `session.close` for the session and leaves the connection's others open", async () => {
      const server = createServer("session-close");
      const transport = new ServerTransport(server);
      const client = await connect({ transport });
      try {
        const closing = await client.mount(SPACES[0], {}, principalOf(alice));
        const staying = await client.mount(SPACES[1], {}, principalOf(alice));
        transport.clearSent();
        await closing.close();
        await client.delivered();
        expect(transport.sent).toEqual([{
          type: "session.close",
          requestId: expect.any(String),
          space: SPACES[0],
          sessionId: closing.sessionId,
        }]);
        expect((await staying.queryGraph({ roots: [] })).serverSeq).toBe(0);
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
});

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricPlainObject } from "@commonfabric/api";
import { connect, loopback } from "../v2/client.ts";
import {
  type ServedRequestCall,
  type ServedRequestHandler,
  Server,
} from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  SERVED_REQUEST_MAX_BYTES,
  type ServerMessage,
} from "../v2.ts";

const AUDIENCE = "did:key:z6Mk-served-audience";
const SPACE = "did:key:z6Mk-served-space";
const SERVICE = "did:key:z6Mk-served-service";
const ALICE = "did:key:z6Mk-served-alice";

/** A raw connection to `server`, which records what the server sends. */
class Wire {
  readonly #connection: ReturnType<Server["connect"]>;
  readonly #sent: ServerMessage[] = [];
  readonly #waiting = new Map<
    string,
    (response: ResponseMessage<FabricPlainObject>) => void
  >();

  constructor(server: Server) {
    this.#connection = server.connect((message) => {
      const waiter = message.type === "response"
        ? this.#waiting.get(message.requestId)
        : undefined;
      if (waiter === undefined) {
        this.#sent.push(message);
        return;
      }
      this.#waiting.delete((message as ResponseMessage<unknown>).requestId);
      waiter(message as ResponseMessage<FabricPlainObject>);
    });
  }

  /** Hands `message` to the server, as a socket's frame would arrive. */
  receive(message: FabricPlainObject): Promise<void> {
    return this.#connection.receive(encodeMemoryBoundary(message));
  }

  /** Removes and returns the oldest message nothing was waiting for. */
  next(): ServerMessage | undefined {
    return this.#sent.shift();
  }

  /**
   * Returns the response to `requestId`: one already sent, or the one the
   * server sends next for it.
   */
  response(requestId: string): Promise<ResponseMessage<FabricPlainObject>> {
    const index = this.#sent.findIndex((message) =>
      message.type === "response" && message.requestId === requestId
    );
    if (index >= 0) {
      return Promise.resolve(
        this.#sent.splice(index, 1)[0] as ResponseMessage<FabricPlainObject>,
      );
    }
    const { promise, resolve } = Promise.withResolvers<
      ResponseMessage<FabricPlainObject>
    >();
    this.#waiting.set(requestId, resolve);
    return promise;
  }

  close(): void {
    this.#connection.close();
  }
}

describe("served", () => {
  const servers: Server[] = [];
  const wires: Wire[] = [];

  afterEach(async () => {
    for (const wire of wires.splice(0)) wire.close();
    for (const server of servers.splice(0)) await server.close();
  });

  /** A server whose delegating class is `SERVICE` alone. */
  const newServer = (mode: "off" | "enforce" = "off"): Server => {
    const server = new Server({
      store: new URL(`memory://served-${crypto.randomUUID()}`),
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen(message) {
        const issuer = message.invocation?.iss;
        return typeof issuer === "string" ? issuer : undefined;
      },
      sessionOpenAuth: { audience: AUDIENCE },
      acl: { mode, delegatingDids: [SERVICE] },
    });
    servers.push(server);
    return server;
  };

  /** Says `hello` on a new connection and returns it with the `hello.ok`. */
  const greet = async (
    server: Server,
  ): Promise<{ wire: Wire; hello: HelloOkMessage }> => {
    const wire = new Wire(server);
    wires.push(wire);
    await wire.receive({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: getMemoryProtocolFlags(),
    });
    const hello = wire.next() as HelloOkMessage;
    expect(hello.type).toBe("hello.ok");
    return { wire, hello };
  };

  /** Opens a session on `SPACE` as `principal`, and returns its id. */
  const openSession = async (
    server: Server,
    principal: string,
    session: { actingAs?: "space-owner" } = {},
  ): Promise<{ wire: Wire; sessionId: string }> => {
    const { wire, hello } = await greet(server);
    const requestId = crypto.randomUUID();
    await wire.receive({
      type: "session.open",
      requestId,
      space: SPACE,
      session,
      invocation: {
        iss: principal,
        aud: hello.sessionOpen!.audience,
        challenge: hello.sessionOpen!.challenge.value,
      },
    });
    const response = await wire.response(requestId) as ResponseMessage<
      { sessionId: string }
    >;
    expect(response.error).toBeUndefined();
    return { wire, sessionId: response.ok!.sessionId };
  };

  /** Sends one `served` request and returns its id. */
  const request = async (
    wire: Wire,
    sessionId: string,
    kind = "append",
    body: FabricPlainObject = { eventId: "e-1" },
  ): Promise<string> => {
    const requestId = crypto.randomUUID();
    await wire.receive({
      type: "served",
      requestId,
      space: SPACE,
      sessionId,
      kind,
      body,
    });
    return requestId;
  };

  /** A handler that records each call and returns a fixed result. */
  const recording = (): {
    calls: ServedRequestCall[];
    handler: ServedRequestHandler;
  } => {
    const calls: ServedRequestCall[] = [];
    return {
      calls,
      handler: (call) => {
        calls.push(call);
        return Promise.resolve({ ok: { seq: 7, deduped: false } });
      },
    };
  };

  describe("hello", () => {
    it("advertises `servedRequests` only while a handler is installed", async () => {
      const server = newServer();
      expect((await greet(server)).hello.flags.servedRequests).toBe(false);

      server.setServedRequestHandler(recording().handler);
      expect((await greet(server)).hello.flags.servedRequests).toBe(true);

      server.setServedRequestHandler(undefined);
      expect((await greet(server)).hello.flags.servedRequests).toBe(false);
    });
  });

  describe("request", () => {
    it("returns the handler's result, called with the session's space, principal and id", async () => {
      const server = newServer();
      const { calls, handler } = recording();
      server.setServedRequestHandler(handler);
      const { wire, sessionId } = await openSession(server, SERVICE);

      const response = await wire.response(
        await request(wire, sessionId, "append", { eventId: "e-9" }),
      );

      expect(response.error).toBeUndefined();
      expect(response.ok).toEqual({ seq: 7, deduped: false });
      expect(calls).toEqual([{
        space: SPACE,
        principal: SERVICE,
        sessionId,
        kind: "append",
        body: { eventId: "e-9" },
      }]);
    });

    it("refuses with `forbidden` a principal outside the delegating class, without calling the handler", async () => {
      const server = newServer();
      const { calls, handler } = recording();
      server.setServedRequestHandler(handler);
      const { wire, sessionId } = await openSession(server, ALICE);

      const response = await wire.response(await request(wire, sessionId));

      expect(response.error).toEqual({
        name: "ServedRequestRefusal",
        code: "forbidden",
        message: expect.any(String),
      });
      expect(calls).toEqual([]);
    });

    it("refuses with `unavailable` when no handler is installed", async () => {
      const server = newServer();
      const { wire, sessionId } = await openSession(server, SERVICE);

      const response = await wire.response(await request(wire, sessionId));

      expect(response.error).toEqual({
        name: "ServedRequestRefusal",
        code: "unavailable",
        message: expect.any(String),
      });
    });

    it("admits a request under `enforce` from the service's session bound to the owner of a space that grants the service nothing, and refuses the owner's own", async () => {
      const server = newServer("enforce");
      const { calls, handler } = recording();
      server.setServedRequestHandler(handler);
      // The space's genesis, as creating a space writes it: the one write
      // the space identity makes without a grant.
      const genesis = await openSession(server, SPACE);
      const written = crypto.randomUUID();
      await genesis.wire.receive({
        type: "transact",
        requestId: written,
        space: SPACE,
        sessionId: genesis.sessionId,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: `of:${SPACE}`,
            value: { value: { [ALICE]: "OWNER" } },
          }],
        },
      });
      expect((await genesis.wire.response(written)).error).toBeUndefined();

      // The routed plane's open: the service identity, bound to the owner.
      const routed = await openSession(server, SERVICE, {
        actingAs: "space-owner",
      });
      const admitted = await routed.wire.response(
        await request(routed.wire, routed.sessionId),
      );
      expect(admitted.error).toBeUndefined();
      expect(calls.map((call) => call.principal)).toEqual([SERVICE]);

      // The owner holds every grant on the space and is still not the
      // delegating class, so the owner's session sends no crossing.
      const owner = await openSession(server, ALICE);
      const refused = await owner.wire.response(
        await request(owner.wire, owner.sessionId),
      );
      expect(refused.error?.code).toBe("forbidden");
      expect(calls.length).toBe(1);
    });

    it("returns a handler's refusal under its own code", async () => {
      const server = newServer();
      server.setServedRequestHandler(() =>
        Promise.resolve({
          refusal: { code: "refused", message: "no such stream" },
        })
      );
      const { wire, sessionId } = await openSession(server, SERVICE);

      const response = await wire.response(await request(wire, sessionId));

      expect(response.error).toEqual({
        name: "ServedRequestRefusal",
        code: "refused",
        message: "no such stream",
      });
    });

    it("refuses with `internal` when the handler throws", async () => {
      const server = newServer();
      server.setServedRequestHandler(() =>
        Promise.reject(new Error("the sink closed"))
      );
      const { wire, sessionId } = await openSession(server, SERVICE);

      const response = await wire.response(await request(wire, sessionId));

      expect(response.error?.name).toBe("ServedRequestRefusal");
      expect(response.error?.code).toBe("internal");
      expect(response.error?.message).toContain("the sink closed");
    });

    it("refuses a request on a session the connection has not opened", async () => {
      const server = newServer();
      const { calls, handler } = recording();
      server.setServedRequestHandler(handler);
      const { wire } = await greet(server);

      const response = await wire.response(
        await request(wire, "never-opened"),
      );

      expect(response.error?.name).toBe("SessionError");
      expect(calls).toEqual([]);
    });

    it("refuses an unknown kind as an unreadable message", async () => {
      const server = newServer();
      const { calls, handler } = recording();
      server.setServedRequestHandler(handler);
      const { wire, sessionId } = await openSession(server, SERVICE);

      const requestId = await request(wire, sessionId, "delete");

      expect((await wire.response(requestId)).error?.name).toBe(
        "InvalidMessageError",
      );
      expect(calls).toEqual([]);
    });

    it("refuses with `payload-too-large` a request past the direct bound, without calling the handler", async () => {
      const server = newServer();
      const { calls, handler } = recording();
      server.setServedRequestHandler(handler);
      const { wire, sessionId } = await openSession(server, SERVICE);

      const response = await wire.response(
        await request(wire, sessionId, "append", {
          payload: "x".repeat(SERVED_REQUEST_MAX_BYTES),
        }),
      );

      expect(response.error?.name).toBe("ServedRequestRefusal");
      expect(response.error?.code).toBe("payload-too-large");
      expect(calls).toEqual([]);
    });
  });

  describe("client", () => {
    it("sends a request through `runServed` and returns the handler's result", async () => {
      const server = newServer();
      const { calls, handler } = recording();
      server.setServedRequestHandler(handler);
      const client = await connect({ transport: loopback(server) });
      try {
        const session = await client.mount(
          SPACE,
          {},
          (_space, _descriptor, context) => ({
            invocation: {
              iss: SERVICE,
              aud: context.audience,
              challenge: context.challenge.value,
            },
            authorization: {},
          }),
        );

        const result = await session.runServed("append", { eventId: "e-c" });

        expect(result).toEqual({ seq: 7, deduped: false });
        expect(calls.map(({ kind, body }) => [kind, body])).toEqual([[
          "append",
          { eventId: "e-c" },
        ]]);
      } finally {
        await client.close();
      }
    });

    it("raises `served-unsupported` without sending when the server advertises no handler", async () => {
      const server = newServer();
      const client = await connect({ transport: loopback(server) });
      try {
        const session = await client.mount(
          SPACE,
          {},
          (_space, _descriptor, context) => ({
            invocation: {
              iss: SERVICE,
              aud: context.audience,
              challenge: context.challenge.value,
            },
            authorization: {},
          }),
        );

        const failure = await session.runServed("append", {}).then(
          () => undefined,
          (error: unknown) => error as Error & { code?: string },
        );

        expect(failure?.name).toBe("ServedRequestRefusal");
        expect(failure?.code).toBe("served-unsupported");
      } finally {
        await client.close();
      }
    });
  });
});

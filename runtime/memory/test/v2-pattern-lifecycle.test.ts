import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import type { FabricPlainObject } from "@commonfabric/api";
import { aclDocId } from "../acl.ts";
import * as Engine from "../v2/engine.ts";
import { connect, loopback } from "../v2/client.ts";
import {
  type PatternLifecycleCall,
  type PatternLifecycleHandler,
  Server,
} from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  PATTERN_LIFECYCLE_MAX_BYTES,
  type ResponseMessage,
  type ServerMessage,
} from "../v2.ts";
import { ROUTED_PART_BYTES, ROUTED_QUEUE_LIMIT } from "../v2/routed-limits.ts";
import {
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const AUDIENCE = "did:key:z6Mk-pattern-lifecycle-audience";
const SPACE = "did:key:z6Mk-pattern-lifecycle-space";
const ALICE = "did:key:z6Mk-pattern-lifecycle-alice";
const BOB = "did:key:z6Mk-pattern-lifecycle-bob";

/** A raw connection to `server`, which records what the server sends. */
class Wire {
  readonly #connection: ReturnType<Server["connect"]>;
  readonly #sent: ServerMessage[] = [];
  readonly #waiting = new Map<
    string,
    (response: ResponseMessage<FabricPlainObject>) => void
  >();

  #refusing = false;
  #refusingNext = false;

  constructor(server: Server) {
    this.#connection = server.connect((message) => {
      if (this.#refusing) throw new Error("the socket has closed");
      if (this.#refusingNext) {
        this.#refusingNext = false;
        throw new Error("the message could not be encoded");
      }
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

  /** Whether the server has sent a response to `requestId` yet. */
  answered(requestId: string): boolean {
    return this.#sent.some((message) =>
      message.type === "response" && message.requestId === requestId
    );
  }

  /** Makes the next send throw, and the sends after it go through. */
  refuseNextSend(): void {
    this.#refusingNext = true;
  }

  /** Makes every later send throw, as a transport whose socket closed does. */
  refuseSends(): void {
    this.#refusing = true;
  }

  close(): void {
    this.#connection.close();
  }
}

describe("pattern.lifecycle", () => {
  const servers: Server[] = [];
  const wires: Wire[] = [];

  afterEach(async () => {
    for (const wire of wires.splice(0)) wire.close();
    for (const server of servers.splice(0)) await server.close();
  });

  const serverWith = (
    options: { acl?: boolean } = {},
  ): Server => {
    const server = new Server({
      store: new URL(`memory://pattern-lifecycle-${crypto.randomUUID()}`),
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen(message) {
        const issuer = message.invocation?.iss;
        return typeof issuer === "string" ? issuer : undefined;
      },
      sessionOpenAuth: { audience: AUDIENCE },
      ...(options.acl === true ? { acl: { mode: "enforce" as const } } : {}),
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
  ): Promise<{ wire: Wire; sessionId: string }> => {
    const { wire, hello } = await greet(server);
    const requestId = crypto.randomUUID();
    await wire.receive({
      type: "session.open",
      requestId,
      space: SPACE,
      session: {},
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

  /** Sends one `pattern.lifecycle` request and returns its id. */
  const request = async (
    wire: Wire,
    sessionId: string,
    body: FabricPlainObject = { program: { main: "/main.tsx" } },
  ): Promise<string> => {
    const requestId = crypto.randomUUID();
    await wire.receive({
      type: "pattern.lifecycle",
      requestId,
      space: SPACE,
      sessionId,
      verb: "upload",
      body,
    });
    return requestId;
  };

  /** A handler that records each call and returns a fixed receipt. */
  const recording = (): {
    calls: PatternLifecycleCall[];
    handler: PatternLifecycleHandler;
  } => {
    const calls: PatternLifecycleCall[] = [];
    return {
      calls,
      handler: (call) => {
        calls.push(call);
        return Promise.resolve({ ok: { pattern: "receipt" } });
      },
    };
  };

  describe("hello", () => {
    it("advertises `patternLifecycle` only while a handler is installed", async () => {
      const server = serverWith();
      expect((await greet(server)).hello.flags.patternLifecycle).toBe(false);

      server.setPatternLifecycleHandler(recording().handler);
      expect((await greet(server)).hello.flags.patternLifecycle).toBe(true);

      server.setPatternLifecycleHandler(undefined);
      expect((await greet(server)).hello.flags.patternLifecycle).toBe(false);
    });
  });

  describe("request", () => {
    it("returns the handler's receipt, called as the session's principal", async () => {
      const server = serverWith();
      const { calls, handler } = recording();
      server.setPatternLifecycleHandler(handler);
      const { wire, sessionId } = await openSession(server, ALICE);

      const response = await wire.response(
        await request(wire, sessionId, { program: { main: "/a.tsx" } }),
      );

      expect(response.error).toBeUndefined();
      expect(response.ok).toEqual({ pattern: "receipt" });
      expect(calls).toEqual([{
        space: SPACE,
        principal: ALICE,
        verb: "upload",
        body: { program: { main: "/a.tsx" } },
      }]);
    });

    it("refuses with `server-execution-off` when no handler is installed", async () => {
      const server = serverWith();
      const { wire, sessionId } = await openSession(server, ALICE);

      const response = await wire.response(await request(wire, sessionId));

      expect(response.error).toEqual({
        name: "PatternLifecycleRefusal",
        code: "server-execution-off",
        message: expect.any(String),
      });
    });

    it("returns a handler's refusal under its own code", async () => {
      const server = serverWith();
      server.setPatternLifecycleHandler(() =>
        Promise.resolve({
          refusal: { code: "slug-taken", message: "The slug names a piece" },
        })
      );
      const { wire, sessionId } = await openSession(server, ALICE);

      const response = await wire.response(await request(wire, sessionId));

      expect(response.error).toEqual({
        name: "PatternLifecycleRefusal",
        code: "slug-taken",
        message: "The slug names a piece",
      });
    });

    it("refuses with `internal` when the handler throws", async () => {
      const server = serverWith();
      server.setPatternLifecycleHandler(() =>
        Promise.reject(new Error("the loop closed"))
      );
      const { wire, sessionId } = await openSession(server, ALICE);

      const response = await wire.response(await request(wire, sessionId));

      expect(response.error?.name).toBe("PatternLifecycleRefusal");
      expect(response.error?.code).toBe("internal");
      expect(response.error?.message).toContain("the loop closed");
    });

    it("refuses a request on a session the connection has not opened", async () => {
      const server = serverWith();
      const { calls, handler } = recording();
      server.setPatternLifecycleHandler(handler);
      const { wire } = await greet(server);

      const response = await wire.response(
        await request(wire, "never-opened"),
      );

      expect(response.error?.name).toBe("SessionError");
      expect(calls).toEqual([]);
    });

    it("refuses an unknown verb as an unreadable message", async () => {
      const server = serverWith();
      const { calls, handler } = recording();
      server.setPatternLifecycleHandler(handler);
      const { wire, sessionId } = await openSession(server, ALICE);
      const requestId = crypto.randomUUID();

      await wire.receive({
        type: "pattern.lifecycle",
        requestId,
        space: SPACE,
        sessionId,
        verb: "delete",
        body: {},
      });

      expect((await wire.response(requestId)).error?.name).toBe(
        "InvalidMessageError",
      );
      expect(calls).toEqual([]);
    });

    it("refuses with `payload-too-large` a request past the byte bound, without calling the handler", async () => {
      const server = serverWith();
      const { calls, handler } = recording();
      server.setPatternLifecycleHandler(handler);
      const { wire, sessionId } = await openSession(server, ALICE);

      // Two bytes a character: past the byte bound with fewer characters
      // than the bound counts.
      const response = await wire.response(
        await request(wire, sessionId, {
          source: "é".repeat(PATTERN_LIFECYCLE_MAX_BYTES / 2 + 1),
        }),
      );

      expect(response.error?.code).toBe("payload-too-large");
      expect(calls).toEqual([]);
    });
  });

  describe("authority", () => {
    const seedAcl = async (server: Server) => {
      Engine.applyCommit(await server.engineForSpace(SPACE), {
        space: SPACE,
        sessionId: "acl-seed",
        commitClass: "system",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: aclDocId(SPACE),
            value: { value: { [ALICE]: "OWNER", [BOB]: "READ" } },
          }],
        },
      });
    };

    it("runs the verb for a principal holding WRITE", async () => {
      const server = serverWith({ acl: true });
      await seedAcl(server);
      const { calls, handler } = recording();
      server.setPatternLifecycleHandler(handler);
      const { wire, sessionId } = await openSession(server, ALICE);

      const response = await wire.response(await request(wire, sessionId));

      expect(response.error).toBeUndefined();
      expect(calls.map(({ principal }) => principal)).toEqual([ALICE]);
    });

    it("refuses with `forbidden` a principal holding only READ, without calling the handler", async () => {
      const server = serverWith({ acl: true });
      await seedAcl(server);
      const { calls, handler } = recording();
      server.setPatternLifecycleHandler(handler);
      const { wire, sessionId } = await openSession(server, BOB);

      const response = await wire.response(await request(wire, sessionId));

      expect(response.error?.name).toBe("PatternLifecycleRefusal");
      expect(response.error?.code).toBe("forbidden");
      expect(calls).toEqual([]);
    });
  });

  describe("ordering", () => {
    // A verb can take seconds. The frame that carries one has to be done
    // with as soon as the verb has started, or every later frame for the
    // space on this connection, and under a router the request's credit,
    // waits for the whole verb.

    it("finishes handling the frame while the verb is still running, and answers when it settles", async () => {
      const server = serverWith();
      const release = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      server.setPatternLifecycleHandler(async () => {
        started.resolve();
        await release.promise;
        return { ok: { pattern: "late" } };
      });
      const { wire, sessionId } = await openSession(server, ALICE);

      const requestId = await request(wire, sessionId);
      await started.promise;
      expect(wire.answered(requestId)).toBe(false);

      const closeId = crypto.randomUUID();
      await wire.receive({
        type: "session.close",
        requestId: closeId,
        space: SPACE,
        sessionId: "another-session",
      });
      expect(wire.answered(closeId)).toBe(true);

      release.resolve();
      expect((await wire.response(requestId)).ok).toEqual({ pattern: "late" });
    });

    it("reports an answer its transport refuses instead of leaving it unhandled", async () => {
      const server = serverWith();
      server.setPatternLifecycleHandler(() =>
        Promise.resolve({ ok: { pattern: "late" } })
      );
      const { wire, sessionId } = await openSession(server, ALICE);
      const reported = Promise.withResolvers<unknown[]>();
      using _logged = stub(console, "error", (...args: unknown[]) => {
        reported.resolve(args);
      });
      wire.refuseSends();

      await request(wire, sessionId);

      const [message, error] = await reported.promise;
      expect(message).toContain("could not be sent");
      expect(error).toBeInstanceOf(Error);
    });

    it("answers with `internal` when the receipt cannot be sent but a refusal can", async () => {
      const server = serverWith();
      server.setPatternLifecycleHandler(() =>
        Promise.resolve({ ok: { pattern: "late" } })
      );
      const { wire, sessionId } = await openSession(server, ALICE);
      using _logged = stub(console, "error", () => {});
      wire.refuseNextSend();

      const response = await wire.response(await request(wire, sessionId));

      expect(response.error?.name).toBe("PatternLifecycleRefusal");
      expect(response.error?.code).toBe("internal");
    });
  });

  describe("client", () => {
    const mounted = async (server: Server) => {
      const client = await connect({ transport: loopback(server) });
      const session = await client.mount(
        SPACE,
        {},
        testSessionOpenAuthFactory,
      );
      return { client, session };
    };

    const testServer = (): Server => {
      const server = new Server({
        store: new URL(`memory://pattern-lifecycle-${crypto.randomUUID()}`),
        subscriptionRefreshDelayMs: 0,
        ...testSessionOpenServerOptions,
      });
      servers.push(server);
      return server;
    };

    it("returns the receipt the handler returns", async () => {
      const server = testServer();
      const { calls, handler } = recording();
      server.setPatternLifecycleHandler(handler);
      const { client, session } = await mounted(server);

      try {
        expect(await session.runPatternLifecycle("setsrc", { piece: "p" }))
          .toEqual({ pattern: "receipt" });
        expect(calls).toEqual([{
          space: SPACE,
          principal: TEST_SESSION_OPEN_PRINCIPAL,
          verb: "setsrc",
          body: { piece: "p" },
        }]);
      } finally {
        await client.close();
      }
    });

    it("throws a refusal carrying the server's code", async () => {
      const server = testServer();
      server.setPatternLifecycleHandler(() =>
        Promise.resolve({ refusal: { code: "incompatible", message: "no" } })
      );
      const { client, session } = await mounted(server);

      try {
        const error = await session.runPatternLifecycle("setsrc", {}).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).name).toBe("PatternLifecycleRefusal");
        expect((error as Error & { code?: string }).code).toBe(
          "incompatible",
        );
      } finally {
        await client.close();
      }
    });

    it("throws `lifecycle-unsupported` without sending, against a server that does not advertise the flag", async () => {
      const server = testServer();
      const { client, session } = await mounted(server);
      const { calls, handler } = recording();
      // Installed after the client's `hello`, so the flag that client holds
      // is still the one from before.
      server.setPatternLifecycleHandler(handler);

      try {
        const error = await session.runPatternLifecycle("upload", {}).then(
          () => undefined,
          (error: unknown) => error as Error & { code?: string },
        );
        expect(error?.code).toBe("lifecycle-unsupported");
        expect(calls).toEqual([]);
      } finally {
        await client.close();
      }
    });

    /** The code a lifecycle call fails with, or `undefined` if it returned. */
    const codeOf = (call: Promise<unknown>) =>
      call.then(
        () => undefined,
        (error: unknown) => (error as Error & { code?: string }).code,
      );

    it("throws `payload-too-large` without sending, for a request past the byte bound", async () => {
      const server = testServer();
      const { calls, handler } = recording();
      server.setPatternLifecycleHandler(handler);
      const { client, session } = await mounted(server);

      try {
        // Two bytes a character, so the request passes the byte bound
        // with fewer characters than the bound counts.
        expect(
          await codeOf(session.runPatternLifecycle("upload", {
            source: "é".repeat(PATTERN_LIFECYCLE_MAX_BYTES / 2 + 1),
          })),
        ).toBe("payload-too-large");
        expect(calls).toEqual([]);
      } finally {
        await client.close();
      }
    });

    it("sends a request past the routed bound on a direct connection, and refuses it without sending on a connection bounded as a routed one is", async () => {
      const server = testServer();
      const { calls, handler } = recording();
      server.setPatternLifecycleHandler(handler);
      const body = { source: "x".repeat(ROUTED_QUEUE_LIMIT + 1) };
      const direct = await mounted(server);
      const bounded = await connect({
        transport: loopback(server, {
          messageLimits: {
            bytes: ROUTED_PART_BYTES,
            values: null,
            whole: ROUTED_QUEUE_LIMIT,
          },
        }),
      });

      try {
        const session = await bounded.mount(
          SPACE,
          {},
          testSessionOpenAuthFactory,
        );
        expect(await direct.session.runPatternLifecycle("upload", body))
          .toEqual({ pattern: "receipt" });
        expect(await codeOf(session.runPatternLifecycle("upload", body)))
          .toBe("payload-too-large");
        expect(calls).toHaveLength(1);
      } finally {
        await direct.client.close();
        await bounded.close();
      }
    });
  });
});

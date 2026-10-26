import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type ServerMessage,
} from "../v2.ts";
import { connect, type Transport } from "../v2/client.ts";
import { createClientInfo, parseClientInfo } from "../v2/client-info.ts";
import { verifyConnectionAuthorization } from "../v2/connection-auth.ts";
import { Server, SessionRegistry } from "../v2/server.ts";
import { verifySessionOpenAuthorization } from "../v2/session-open-auth.ts";
import { alice, bob } from "./principal.ts";
import { principalOf } from "./support/connection-auth.ts";
import { ServerTransport } from "./support/server-transport.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-client-info";
const BUILD = { application: "shell", gitSha: "a".repeat(40) };

describe("client-info", () => {
  describe("createClientInfo()", () => {
    it("reports whole milliseconds when the clock returns a fractional time", () => {
      using _clock = stub(Date, "now", () => 1_700_000_000_000.3918);
      const report = createClientInfo(BUILD);
      expect(report.startedAt).toBe(1_700_000_000_000);
      expect(parseClientInfo(report)).toEqual(report);
    });

    it("rejects an invalid application name supplied by the embedder", () => {
      expect(() => createClientInfo({ ...BUILD, application: "line\nfeed" }))
        .toThrow("Invalid memory client build metadata");
    });
  });

  it("bounds reports and copies only recognized fields", () => {
    const report = createClientInfo(BUILD);
    expect(Object.isFrozen(report)).toBe(true);
    expect(report.generation).toBe(1);
    expect(parseClientInfo({ ...report, futureField: "ignored" })).toEqual(
      report,
    );
    for (
      const invalid of [
        null,
        [],
        {},
        { ...report, application: "x".repeat(65) },
        { ...report, application: "line\nfeed" },
        { ...report, gitSha: "abbreviated" },
        { ...report, instanceId: "x".repeat(129) },
        { ...report, instanceId: "a/b" },
        { ...report, generation: 0 },
        { ...report, generation: 1.5 },
        { ...report, generation: Number.MAX_SAFE_INTEGER + 1 },
        { ...report, startedAt: -1 },
      ]
    ) expect(parseClientInfo(invalid)).toBeNull();
    expect(parseClientInfo({ ...report, gitSha: null })?.gitSha).toBeNull();
  });

  it("reports noncanonical host build labels as unknown without preventing connection", () => {
    for (const gitSha of [null, "", "abc1234", "dev-checkout"]) {
      expect(createClientInfo({ application: "toolshed", gitSha }).gitSha)
        .toBeNull();
    }
    expect(
      createClientInfo({ application: "toolshed", gitSha: "AB".repeat(20) })
        .gitSha,
    ).toBe("ab".repeat(20));
  });

  for (const connectionAuth of [false, true]) {
    it(`retains identity on resume with connectionAuth=${connectionAuth}`, async () => {
      const sessions = new SessionRegistry();
      const server = new Server({
        sessions,
        store: new URL(`memory://client-info-resume-${connectionAuth}`),
        authorizeSessionOpen: verifySessionOpenAuthorization,
        ...(connectionAuth
          ? { authorizeConnection: verifyConnectionAuthorization }
          : {}),
        sessionOpenAuth: { audience: bob.did() },
        minimumClientGeneration: 1,
      });
      const transport = new ServerTransport(server);
      const report = createClientInfo(BUILD);
      const client = await connect({ transport, client: report });
      try {
        const session = await client.mount(SPACE, {}, principalOf(alice));
        await session.watchSet([{
          id: "schema",
          kind: "graph",
          query: {
            roots: [{
              id: "cid:historical-schema",
              selector: { path: [], schema: false },
            }],
          },
        }]);
        for (const forget of [false, true]) {
          if (forget) sessions.remove(SPACE, session.sessionId);
          transport.drop();
          await client.restoreConnection();
          const interests = sessions.documentInterests({
            space: SPACE,
            id: "cid:historical-schema",
          });
          expect(interests.sessions).toHaveLength(1);
          expect(interests.sessions[0]).toMatchObject({
            sessionId: session.sessionId,
            principal: alice.did(),
            client: report,
          });
        }
        const opens = transport.sent.filter((message) =>
          message.type === "session.open"
        );
        expect(opens).toHaveLength(3);
        for (const open of opens) {
          expect(open.session).toMatchObject({ client: report });
        }
        await session.queryGraph({ roots: [] });
      } finally {
        await client.close();
        await server.close();
      }
    });
  }

  for (
    const [minimum, generation, admitted] of [
      [0, undefined, true],
      [1, undefined, false],
      [2, 1, false],
      [1, 1, true],
      [1, 2, true],
    ] as const
  ) {
    it(`admits generation ${generation} at floor ${minimum}: ${admitted}`, async () => {
      const sessions = new SessionRegistry();
      const options = {
        ...testSessionOpenServerOptions,
        store: new URL(
          `memory://client-info-admission-${minimum}-${generation}`,
        ),
        sessions,
        minimumClientGeneration: Number(minimum),
      };
      const server = new Server(options);
      // Mutating the caller's options cannot change a running server's floor.
      options.minimumClientGeneration = 100;
      let engineOpened = false;
      if (!admitted) {
        server.accessForTestingOnly.engineOpener = () => {
          engineOpened = true;
          throw new Error("Rejected clients must not open storage");
        };
      }
      const messages: ServerMessage[] = [];
      const connection = server.connect((message) => messages.push(message));
      const report = generation === undefined
        ? undefined
        : { ...createClientInfo(BUILD), generation };
      try {
        await connection.receive(encodeMemoryBoundary({
          type: "hello",
          protocol: MEMORY_PROTOCOL,
          flags: getMemoryProtocolFlags(),
        }));
        const hello = messages.shift();
        if (hello?.type !== "hello.ok") throw new Error("Expected hello.ok");
        await connection.receive(encodeMemoryBoundary({
          type: "session.open",
          requestId: "open",
          space: SPACE,
          session: report === undefined ? {} : { client: report },
          invocation: {
            aud: hello.sessionOpen?.audience,
            challenge: hello.sessionOpen?.challenge.value,
          },
          authorization: {},
        }));
        const response = messages.find((message) =>
          message.type === "response"
        );
        if (admitted) {
          expect(response).not.toHaveProperty("error");
          expect(sessions.sessionsForSpace(SPACE)).toHaveLength(1);
          expect(sessions.sessionsForSpace(SPACE)[0].client).toEqual(report);
        } else {
          expect(response).toMatchObject({
            error: {
              name: "AuthorizationError",
              message: expect.stringContaining("Client update required"),
            },
          });
          expect(engineOpened).toBe(false);
          expect(sessions.sessionsForSpace(SPACE)).toEqual([]);
        }
      } finally {
        connection.close();
        await server.close();
      }
    });
  }
  it("terminates a refused resume without replaying commits or watches", async () => {
    const before = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://client-generation-before"),
    });
    const after = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://client-generation-after"),
      minimumClientGeneration: 2,
    });
    let receiver = (_payload: string) => {};
    let closeReceiver = (_error?: Error) => {};
    let connection = before.connect((message) =>
      receiver(encodeMemoryBoundary(message))
    );
    let replaced = false;
    let holdCommit = false;
    const held = Promise.withResolvers<void>();
    const afterMessages: string[] = [];
    const transport: Transport = {
      async send(payload) {
        const message = decodeMemoryBoundary(payload) as { type: string };
        if (replaced) {
          afterMessages.push(message.type);
        }
        if (holdCommit && message.type === "transact") {
          held.resolve();
          return;
        }
        await connection.receive(payload);
      },
      close() {
        connection.close();
        return Promise.resolve();
      },
      setReceiver(next) {
        receiver = next;
      },
      setCloseReceiver(next) {
        closeReceiver = next;
      },
    };
    const client = await connect({ transport });
    try {
      const session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
      await session.watchSet([{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: "of:fid1:expression-result",
            selector: { path: [], schema: false },
          }],
        },
      }]);
      holdCommit = true;
      const pending = session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:fid1:expression-result",
          value: { value: "stale result" },
        }],
      });
      const refusal = expect(pending).rejects.toMatchObject({
        name: "AuthorizationError",
        message: expect.stringContaining("Client update required"),
      });
      await held.promise;
      connection.close();
      connection = after.connect((message) =>
        receiver(encodeMemoryBoundary(message))
      );
      replaced = true;
      holdCommit = false;
      closeReceiver(new Error("backend replaced"));
      await client.restoreConnection();
      await refusal;
      await expect(session.watchAdd([])).rejects.toMatchObject({
        name: "AuthorizationError",
        message: expect.stringContaining("Client update required"),
      });
      expect(afterMessages).toEqual(["hello", "session.open"]);
    } finally {
      await client.close();
      await before.close();
      await after.close();
    }
  });
});

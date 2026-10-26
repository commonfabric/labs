import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import type { FabricValue } from "@commonfabric/api";
import { hashOf, isFabricPlainObject } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import { decodeMemoryBoundary, encodeMemoryBoundary } from "../v2.ts";
import { connect, type Transport } from "../v2/client.ts";
import { createClientInfo, parseClientInfo } from "../v2/client-info.ts";
import { verifyConnectionAuthorization } from "../v2/connection-auth.ts";
import { Server, SessionRegistry } from "../v2/server.ts";
import { verifySessionOpenAuthorization } from "../v2/session-open-auth.ts";
import { alice, bob } from "./principal.ts";
import { principalOf } from "./support/connection-auth.ts";
import { ServerTransport } from "./support/server-transport.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";

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

  it("refuses to construct a server with client retirement enabled", () => {
    for (
      const minimumClientGeneration of [
        1,
        2,
        -1,
        0.5,
        NaN,
        Infinity,
        null,
        "0",
        "1",
        {},
      ]
    ) {
      expect(() =>
        new Server({
          ...testSessionOpenServerOptions,
          store: new URL("memory://client-retirement-disabled"),
          // An untyped host can still supply a nonzero setting.
          minimumClientGeneration: minimumClientGeneration as 0,
        })
      ).toThrow("Client retirement is disabled");
    }
  });

  it("rejects stripping or invalidating a valid signed report in transit", async () => {
    for (const replacement of [undefined, { gitSha: "future" }]) {
      const server = new Server({
        store: new URL(`memory://client-info-tamper-${crypto.randomUUID()}`),
        authorizeSessionOpen: verifySessionOpenAuthorization,
        sessionOpenAuth: { audience: bob.did() },
      });
      const inner = new ServerTransport(server);
      const client = await connect({
        transport: wireReportTransport(inner, replacement, false),
      });
      try {
        await expect(client.mount(SPACE, {}, principalOf(alice))).rejects
          .toMatchObject({
            name: "AuthorizationError",
            message: "memory session.open authorization mismatch",
          });
      } finally {
        await client.close();
        await server.close();
      }
    }
  });

  for (const connectionAuth of [false, true]) {
    const report = createClientInfo(BUILD);
    for (
      const [name, wireReport, expected] of [
        ["absent", undefined, undefined],
        ["null", null, undefined],
        ["non-record", [], undefined],
        [
          "long application",
          { ...report, application: "a".repeat(65) },
          undefined,
        ],
        ["future SHA", { ...report, gitSha: "b".repeat(64) }, undefined],
        ["invalid generation", { ...report, generation: "future" }, undefined],
        ["fractional start time", { ...report, startedAt: 1.5 }, undefined],
        ["future generation", { ...report, generation: 2 }, {
          ...report,
          generation: 2,
        }],
        ["additional field", { ...report, futureField: "ignored" }, report],
      ] as const
    ) {
      it(`opens and restores with ${name} attribution and connectionAuth=${connectionAuth}`, async () => {
        const sessions = new SessionRegistry();
        const server = new Server({
          sessions,
          store: new URL(
            `memory://client-info-optional-${connectionAuth}-${
              name.replaceAll(" ", "-")
            }`,
          ),
          authorizeSessionOpen: verifySessionOpenAuthorization,
          ...(connectionAuth
            ? { authorizeConnection: verifyConnectionAuthorization }
            : {}),
          sessionOpenAuth: { audience: bob.did() },
          minimumClientGeneration: 0,
        });
        const inner = new ServerTransport(server);
        const client = await connect({
          transport: wireReportTransport(inner, wireReport),
        });
        try {
          const session = await client.mount(SPACE, {}, principalOf(alice));
          for (const restore of [false, true]) {
            if (restore) {
              inner.drop();
              await client.restoreConnection();
            }
            await session.queryGraph({ roots: [] });
            const registered = sessions.sessionsForSpace(SPACE);
            expect(registered).toHaveLength(1);
            expect(registered[0].client).toEqual(expected);
            expect(registered[0].principal).toBe(alice.did());
          }
          expect(inner.sentTypes.filter((type) => type === "session.open"))
            .toHaveLength(2);
        } finally {
          await client.close();
          await server.close();
        }
      });
    }
  }
});

/** Simulates a peer whose signed report uses another attribution shape. */
function wireReportTransport(
  inner: ServerTransport,
  report: FabricValue,
  resign = true,
): Transport {
  return {
    async send(payload) {
      const decoded = decodeMemoryBoundary(payload);
      if (
        isFabricPlainObject(decoded) && decoded.type === "session.open" &&
        isFabricPlainObject(decoded.session)
      ) {
        const message = { ...decoded };
        const session = { ...decoded.session };
        if (report === undefined) delete session.client;
        else session.client = report;
        message.session = session;
        if (
          resign && isFabricPlainObject(message.invocation) &&
          isFabricPlainObject(message.invocation.args)
        ) {
          message.invocation = {
            ...message.invocation,
            args: { ...message.invocation.args, session },
          };
          const signature = await alice.sign(hashOf(message.invocation).bytes);
          if (signature.error) throw signature.error;
          message.authorization = { signature: new FabricBytes(signature.ok) };
        }
        payload = encodeMemoryBoundary(message);
      }
      await inner.send(payload);
    },
    close: () => inner.close(),
    setReceiver: (receiver) => inner.setReceiver(receiver),
    setCloseReceiver: (receiver) => inner.setCloseReceiver(receiver),
  };
}

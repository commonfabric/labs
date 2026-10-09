import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  connect,
  loopback,
  type SpaceSession,
  type Transport,
} from "../v2/client.ts";
import { getSessionReports, Server } from "../v2/server.ts";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type ServerMessage,
  type SessionReport,
} from "../v2.ts";
import {
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const space = "did:key:z6Mk-memory-v2-server-session-reports-space";

const trip: SessionReport = {
  kind: "echo-breaker",
  event: "trip",
  document: { id: "of:fid1:shared", scopeKey: "space" },
  action: "cf:module/abc:__cfLift_1:xyz",
};

const clear: SessionReport = {
  ...trip,
  event: "clear",
  reason: "convergence",
  renewals: 2,
  trippedMs: 1500,
};

describe("server", () => {
  describe("sessionReports()", () => {
    let server: Server;

    beforeEach(() => {
      server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://memory-v2-server-session-reports"),
        subscriptionRefreshDelayMs: "manual",
      });
    });

    afterEach(async () => {
      await server.close();
    });

    /** Opens a session on `server`, returning it with its client. */
    const openSession = async (): Promise<{
      client: Awaited<ReturnType<typeof connect>>;
      session: SpaceSession;
      sessionId: string;
    }> => {
      const client = await connect({ transport: loopback(server) });
      const session = await client.mount(space, {}, testSessionOpenAuthFactory);
      const [held] = server.accessForTestingOnly.sessionsForSpace(space);
      expect(held).toBeDefined();
      return { client, session, sessionId: held!.id };
    };

    it("advertises the capability to a client", async () => {
      const { client } = await openSession();
      expect(client.serverFlags?.sessionReportV1).toBe(true);
    });

    it("leaves the capability out of the client's own `hello`", async () => {
      // An older routed host refuses a `hello` carrying a flag it does not
      // know, so the capability travels only in `hello.ok`.

      const inner = loopback(server);
      const sent: unknown[] = [];
      const transport: Transport = Object.assign(Object.create(inner), {
        send: (payload: string) => {
          sent.push(decodeMemoryBoundary(payload));
          return inner.send(payload);
        },
      });
      const client = await connect({ transport });
      const hello = sent.find((frame) =>
        (frame as { type?: unknown }).type === "hello"
      ) as { flags: Record<string, unknown> } | undefined;
      expect(hello).toBeDefined();
      expect(hello!.flags).not.toHaveProperty("sessionReportV1");
      expect(client.serverFlags?.sessionReportV1).toBe(true);
      await client.close();
    });

    it("records a report a session sends, under its session and principal", async () => {
      const { session, sessionId } = await openSession();
      await session.sendReport(trip);
      const report = server.sessionReports();
      expect(report.echoBreaker.trips).toBe(1);
      expect(report.recent).toEqual([{
        ...trip,
        at: expect.any(Number),
        space,
        session: sessionId,
        principal: TEST_SESSION_OPEN_PRINCIPAL,
      }]);
    });

    it("records a clear under how the trip ended", async () => {
      const { session } = await openSession();
      await session.sendReport(trip);
      await session.sendReport(clear);
      const report = server.sessionReports();
      expect(report.echoBreaker.clears).toEqual({
        convergence: 1,
        quiet: 0,
        retired: 0,
        evicted: 0,
      });
      expect(report.recent.map((entry) => entry.event)).toEqual([
        "trip",
        "clear",
      ]);
    });

    it("sends nothing for a report the server would refuse as malformed", async () => {
      // The server answers an unparseable message under no request id, so a
      // client that sent one would wait on it until the connection dropped.

      const { session } = await openSession();
      await session.sendReport({ ...trip, action: "cf:lift\nforged" });
      expect(server.sessionReports().echoBreaker.trips).toBe(0);
    });

    it("returns the live server's reports from `getSessionReports()`", async () => {
      const { session } = await openSession();
      await session.sendReport(trip);
      expect(getSessionReports()?.echoBreaker.trips).toBe(1);
    });

    it("refuses a report naming a session not open on the connection, and records nothing", async () => {
      const { client } = await openSession();
      await expect(client.request({
        type: "session.report",
        requestId: "report-for-nobody",
        space,
        sessionId: "not-a-session",
        report: trip,
      })).rejects.toThrow("Session is not open on this connection");
      expect(server.sessionReports().echoBreaker.trips).toBe(0);
    });

    it("sends nothing to a server that does not advertise the capability", async () => {
      // The flags the client parsed at `hello` are what `sendReport` reads, so
      // clearing the capability there stands for a server that never had it.

      const { client, session } = await openSession();
      client.serverFlags!.sessionReportV1 = false;
      await session.sendReport(trip);
      expect(server.sessionReports().echoBreaker.trips).toBe(0);
    });

    it("refuses a report sent before `hello`", async () => {
      const messages: ServerMessage[] = [];
      const connection = server.connect((message) => messages.push(message));
      await connection.receive(encodeMemoryBoundary({
        type: "session.report",
        requestId: "early",
        space,
        sessionId: "session:none",
        report: trip,
      }));
      expect(messages).toEqual([{
        type: "response",
        requestId: "early",
        error: {
          name: "ProtocolError",
          message: "memory hello is required first",
        },
      }]);
      expect(server.sessionReports().echoBreaker.trips).toBe(0);
    });

    it("answers a malformed report as an unparseable message", async () => {
      const messages: ServerMessage[] = [];
      const connection = server.connect((message) => messages.push(message));
      await connection.receive(encodeMemoryBoundary({
        type: "hello",
        protocol: MEMORY_PROTOCOL,
        flags: getMemoryProtocolFlags(),
      }));
      messages.length = 0;
      await connection.receive(encodeMemoryBoundary({
        type: "session.report",
        requestId: "malformed",
        space,
        sessionId: "session:none",
        report: { ...trip, document: { id: "of:fid1:shared", scope: "space" } },
      }));
      expect(messages).toEqual([{
        type: "response",
        requestId: "invalid",
        error: {
          name: "InvalidMessageError",
          message: "Unable to parse memory message",
        },
      }]);
      expect(server.sessionReports().echoBreaker.trips).toBe(0);
    });
  });
});

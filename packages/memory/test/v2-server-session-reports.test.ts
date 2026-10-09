import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { connect, loopback, type SpaceSession } from "../v2/client.ts";
import { getSessionReports, Server } from "../v2/server.ts";
import type { SessionReport } from "../v2.ts";
import {
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const space = "did:key:z6Mk-memory-v2-server-session-reports-space";

const trip: SessionReport = {
  kind: "echo-breaker",
  event: "trip",
  document: { id: "of:fid1:shared", scope: "space" },
  action: "cf:module/abc:__cfLift_1:xyz",
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
  });
});

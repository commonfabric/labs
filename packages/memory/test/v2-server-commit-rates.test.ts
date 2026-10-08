import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { connect, loopback } from "../v2/client.ts";
import { getCommitRates, Server } from "../v2/server.ts";
import {
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const space = "did:key:z6Mk-memory-v2-server-commit-rates-space";

const setOperation = (id: string) => ({
  op: "set" as const,
  id,
  value: { value: { written: true } },
});

describe("server", () => {
  describe("commitRates()", () => {
    let server: Server;

    beforeEach(() => {
      server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://memory-v2-server-commit-rates"),
        subscriptionRefreshDelayMs: "manual",
      });
    });

    afterEach(async () => {
      await server.close();
    });

    /** Opens a session on `server` and returns its id. */
    const openSession = async (): Promise<string> => {
      const client = await connect({ transport: loopback(server) });
      await client.mount(space, {}, testSessionOpenAuthFactory);
      const [session] = server.accessForTestingOnly.sessionsForSpace(space);
      expect(session).toBeDefined();
      return session!.id;
    };

    it("reports a session's accepted and rejected commits under its principal, with their operations", async () => {
      const sessionId = await openSession();
      const accepted = await server.transact({
        type: "transact",
        requestId: "commit-1",
        space,
        sessionId,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [setOperation("of:one"), setOperation("of:two")],
        },
      });
      expect(accepted.error).toBeUndefined();
      // A precondition the first commit falsified refuses the second.
      const rejected = await server.transact({
        type: "transact",
        requestId: "commit-2",
        space,
        sessionId,
        commit: {
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          preconditions: [{ kind: "entity-absent", id: "of:one" }],
          operations: [setOperation("of:three")],
        },
      });
      expect(rejected.error?.name).toBe("PreconditionFailedError");

      const report = server.commitRates();
      expect(report.activeSpaces).toBe(1);
      expect(report.spaces).toEqual([{
        space,
        minute: { accepted: 1, rejected: 1, operations: 3 },
        tenMinutes: { accepted: 1, rejected: 1, operations: 3 },
        activeWriters: 1,
        writers: [{
          session: sessionId,
          principal: TEST_SESSION_OPEN_PRINCIPAL,
          minute: { accepted: 1, rejected: 1, operations: 3 },
          tenMinutes: { accepted: 1, rejected: 1, operations: 3 },
        }],
      }]);
    });

    it("reports a commit from an unknown session as rejected, without a principal", async () => {
      const response = await server.transact({
        type: "transact",
        requestId: "commit-1",
        space,
        sessionId: "session:nobody",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [setOperation("of:one")],
        },
      });
      expect(response.error?.name).toBe("SessionError");
      const [rates] = server.commitRates().spaces;
      expect(rates.minute).toEqual({
        accepted: 0,
        rejected: 1,
        operations: 1,
      });
      expect(rates.writers).toStrictEqual([{
        session: "session:nobody",
        minute: { accepted: 0, rejected: 1, operations: 1 },
        tenMinutes: { accepted: 0, rejected: 1, operations: 1 },
      }]);
    });

    it("is what `getCommitRates()` reports for the newest live server, until that server closes", async () => {
      const sessionId = await openSession();
      await server.transact({
        type: "transact",
        requestId: "commit-1",
        space,
        sessionId,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [setOperation("of:one")],
        },
      });
      const newer = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://memory-v2-server-commit-rates-newer"),
        subscriptionRefreshDelayMs: "manual",
      });
      try {
        expect(getCommitRates()).toEqual(newer.commitRates());
        expect(getCommitRates()?.spaces).toEqual([]);
      } finally {
        await newer.close();
      }
      expect(getCommitRates()).toEqual(server.commitRates());
      expect(getCommitRates()?.spaces.map((entry) => entry.space)).toEqual([
        space,
      ]);
      await server.close();
      expect(
        getCommitRates()?.spaces.some((entry) => entry.space === space),
      ).toBeFalsy();
    });
  });
});

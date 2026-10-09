import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { connect, loopback } from "../v2/client.ts";
import { applyCommit, applyWaveCommit, serverSeq } from "../v2/engine.ts";
import {
  acquireExecutionLease,
  executionLeaseHolder,
} from "../v2/execution-lease.ts";
import { getCommitRates, Server } from "../v2/server.ts";
import { resetServerExecutionConfig, setServerExecutionConfig } from "../v2.ts";
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

    it("counts a commit whose decision threw as rejected, with no operations when it carried no list of them", async () => {
      await expect(server.transact({
        type: "transact",
        requestId: "commit-1",
        space,
        sessionId: "session:nobody",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: undefined as never,
        },
      })).rejects.toThrow();
      const [rates] = server.commitRates().spaces;
      expect(rates.minute).toEqual({
        accepted: 0,
        rejected: 1,
        operations: 0,
      });
    });

    it("reports the server's own direct writes under its direct session, without a principal", async () => {
      await server.writeDocument(space, "of:direct", { written: true });
      const [rates] = server.commitRates().spaces;
      expect(rates.space).toBe(space);
      expect(rates.minute).toEqual({
        accepted: 1,
        rejected: 0,
        operations: 1,
      });
      expect(rates.writers.length).toBe(1);
      expect(rates.writers[0].session.startsWith("server:")).toBe(true);
      expect(rates.writers[0].principal).toBeUndefined();
    });

    it("reports commits applied to the space's engine directly, as a served wave commit is", async () => {
      // The serving loop's sink commits through the engine's entry points
      // rather than through `transact()`, under the service session that
      // holds the space's execution lease.
      const engine = await server.engineForSpace(space);
      const holder = executionLeaseHolder("did:key:z6Mk-commit-rates-service");
      expect(acquireExecutionLease(engine, { space, holder })).toBeTruthy();
      applyCommit(engine, {
        sessionId: holder,
        space,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [setOperation("of:served-one")],
        },
      });
      // A derived-class commit is admitted only with server execution on.
      setServerExecutionConfig(true);
      try {
        applyWaveCommit(engine, {
          sessionId: holder,
          space,
          commitClass: "derived",
          holder,
          commit: {
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [
              setOperation("of:served-two"),
              setOperation("of:served-three"),
            ],
          },
          waveBasis: { basisSeq: serverSeq(engine), rebasedHeads: [] },
        });
      } finally {
        resetServerExecutionConfig();
      }
      expect(() =>
        applyCommit(engine, {
          sessionId: holder,
          space,
          commit: {
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            preconditions: [{ kind: "entity-absent", id: "of:served-one" }],
            operations: [setOperation("of:served-four")],
          },
        })
      ).toThrow();
      const [rates] = server.commitRates().spaces;
      expect(rates.writers).toStrictEqual([{
        session: holder,
        minute: { accepted: 2, rejected: 1, operations: 4 },
        tenMinutes: { accepted: 2, rejected: 1, operations: 4 },
      }]);
    });

    it("reports a commit that named no space under the engine's own space", async () => {
      const engine = await server.engineForSpace(space);
      applyCommit(engine, {
        sessionId: "session:unnamed",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [setOperation("of:unnamed")],
        },
      });
      const report = server.commitRates();
      expect(report.spaces.map((entry) => entry.space)).toEqual([space]);
      expect(report.spaces[0].writers.map((writer) => writer.session))
        .toEqual(["session:unnamed"]);
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

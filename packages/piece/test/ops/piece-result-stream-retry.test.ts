/**
 * Verifies that Piece result-stream edits reuse one caller identity across
 * transaction retries. Under server execution each attempt appends outside
 * the transaction it may later discard, so identity reuse prevents a duplicate
 * durable event.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import { createSession, Identity } from "@commonfabric/identity";
import { type Pattern, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { PieceController } from "../../src/ops/piece-controller.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("piece result stream retry");

/** Runtime identity behavior exercised while the transaction retries. */
type RetryIdentityMode = "session" | "without-session" | "replace-session";

/** Runs one forced-retry result-stream edit and records its send identities. */
async function runRetryScenario(
  identityMode: RetryIdentityMode = "session",
  serverExecution = true,
) {
  const storageManager = StorageManager.emulate({ as: signer });
  let runtime: Runtime | undefined;
  try {
    const activeRuntime = runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution },
    });
    const session = await createSession({
      identity: signer,
      spaceName: "piece-result-stream-retry-" + crypto.randomUUID(),
    });
    const pieces = new PiecesController(session, activeRuntime);
    await pieces.synced();

    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          event: { type: "number", asCell: ["stream"] },
        },
        required: ["event"],
      },
      resultSchema: {
        type: "object",
        properties: {
          event: { type: "number", asCell: ["stream"] },
        },
        required: ["event"],
      },
      result: {
        event: { $alias: { cell: "argument", path: ["event"] } },
      },
      nodes: [],
    };
    const piece = await pieces.runPersistent(
      activeRuntime.unsafeTrustPattern(pattern, {
        reason: "piece result stream retry test fixture",
      }),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    const stream = pieces.getArgument(piece).key("event");
    const received: unknown[] = [];
    const removeHandler = activeRuntime.scheduler.addEventHandler(
      (_tx, event) => {
        received.push(event);
      },
      stream.getAsNormalizedFullLink(),
    );

    const provider = storageManager.open(pieces.getSpace());
    const originalAbsences = provider.unexaminedAbsences;
    const originalPresentCount = provider.presentCount;
    const originalPendingLoadGeneration = storageManager.pendingLoadGeneration
      .bind(storageManager);
    const originalLoadsSettled = storageManager.loadsSettled.bind(
      storageManager,
    );
    const replica = provider.replica;
    const originalEnqueue = replica.enqueueEventAppend;
    if (originalAbsences === undefined || originalEnqueue === undefined) {
      throw new Error("test storage does not support event reconciliation");
    }
    const cellSet = spy(Object.getPrototypeOf(piece), "set");
    const initialIdentity = activeRuntime.scopeKeyIdentity;
    let currentIdentity = identityMode === "without-session"
      ? { principal: initialIdentity.principal }
      : initialIdentity;
    if (identityMode !== "session") {
      Object.defineProperty(activeRuntime, "scopeKeyIdentity", {
        configurable: true,
        get: () => currentIdentity,
      });
    }

    // Force one absence-reconciliation round: the edit's first attempt waits
    // on a fabricated in-flight load, finds its document present, and
    // re-runs; the second attempt finds nothing present and commits.
    let reconciliationCalls = 0;
    const eventIds: string[] = [];
    provider.unexaminedAbsences = () => [{
      space: pieces.getSpace(),
      id: "of:forced-reconciliation",
      scope: "space",
    }];
    storageManager.pendingLoadGeneration = () => 1;
    storageManager.loadsSettled = () => {
      reconciliationCalls++;
      if (
        reconciliationCalls === 1 && identityMode === "replace-session"
      ) {
        currentIdentity = {
          principal: initialIdentity.principal,
          sessionId: `replacement-${crypto.randomUUID()}`,
        };
      }
      return Promise.resolve();
    };
    provider.presentCount = () => reconciliationCalls === 1 ? 1 : 0;
    replica.enqueueEventAppend = (append) => {
      eventIds.push(append.eventId);
      return Promise.resolve({ delivered: true });
    };
    try {
      await controller.result.set(7, ["event"]);
      await activeRuntime.idle();

      const streamSends = cellSet.calls.flatMap(({ args }) => {
        const options = args[2] as
          | { eventId?: string; session?: string }
          | undefined;
        return options?.eventId === undefined ? [] : [options];
      });

      return {
        eventIds,
        initialSessionId: initialIdentity.sessionId,
        received,
        reconciliationCalls,
        runtimeId: activeRuntime.id,
        sessionId: activeRuntime.scopeKeyIdentity.sessionId,
        streamSends,
      };
    } finally {
      if (identityMode !== "session") {
        Reflect.deleteProperty(activeRuntime, "scopeKeyIdentity");
      }
      provider.unexaminedAbsences = originalAbsences;
      provider.presentCount = originalPresentCount;
      storageManager.pendingLoadGeneration = originalPendingLoadGeneration;
      storageManager.loadsSettled = originalLoadsSettled;
      replica.enqueueEventAppend = originalEnqueue;
      cellSet.restore();
      removeHandler();
    }
  } finally {
    try {
      await runtime?.dispose();
    } finally {
      await storageManager.close();
    }
  }
}

describe("piece-controller", () => {
  describe("result stream edits", () => {
    it("submits one event identity across transaction attempts", async () => {
      const result = await runRetryScenario();

      expect(result.sessionId).toBeDefined();
      expect(result.reconciliationCalls).toBe(2);
      expect(result.streamSends).toHaveLength(2);
      expect(
        result.streamSends.every(({ session }) => session === result.sessionId),
      ).toBe(true);
      expect(new Set(result.streamSends.map(({ eventId }) => eventId)).size)
        .toBe(1);
      expect(new Set(result.eventIds).size).toBe(1);
      expect(result.received).toEqual([7]);
    });

    it("uses the runtime identity when the storage session is absent", async () => {
      const result = await runRetryScenario("without-session");

      expect(result.sessionId).toBeUndefined();
      expect(result.reconciliationCalls).toBe(2);
      expect(result.streamSends).toHaveLength(2);
      expect(
        result.streamSends.every(({ session }) => session === result.runtimeId),
      ).toBe(true);
      expect(new Set(result.streamSends.map(({ eventId }) => eventId)).size)
        .toBe(1);
      expect(new Set(result.eventIds).size).toBe(1);
      expect(result.received).toEqual([7]);
    });

    it("retains the original session when it is replaced between attempts", async () => {
      const result = await runRetryScenario("replace-session");

      expect(result.initialSessionId).toBeDefined();
      expect(result.sessionId).not.toBe(result.initialSessionId);
      expect(result.reconciliationCalls).toBe(2);
      expect(result.streamSends).toHaveLength(2);
      expect(
        result.streamSends.every(({ session }) =>
          session === result.initialSessionId
        ),
      ).toBe(true);
      expect(new Set(result.streamSends.map(({ eventId }) => eventId)).size)
        .toBe(1);
      expect(new Set(result.eventIds).size).toBe(1);
      expect(result.received).toEqual([7]);
    });

    it("keeps transaction-scoped event identity without server execution", async () => {
      const result = await runRetryScenario("session", false);

      expect(result.reconciliationCalls).toBe(2);
      expect(result.streamSends).toEqual([]);
      expect(result.eventIds).toEqual([]);
      expect(result.received).toEqual([7]);
    });
  });
});

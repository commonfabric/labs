import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Pattern } from "../src/builder/types.ts";
import { ensurePieceRunning } from "../src/ensure-piece-running.ts";
import {
  getDerivedInternalCell,
  getMetaCell,
  type NormalizedFullLink,
} from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { setResultCell } from "../src/result-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { ServedEventFailureOutcome } from "../src/scheduler/types.ts";
import { trustPattern } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

type CommitRefusal = { name: string; message: string };

// Refuse the next commit reaching the emulated memory server and let every
// later one through, the way a serving side that advanced a document the
// commit's basis names refuses one commit and accepts its successor.
function rejectNextTransact(
  runtime: Runtime,
  error: CommitRefusal,
): () => void {
  type Response = {
    type: "response";
    requestId: string;
    error: CommitRefusal;
  };
  const server = (runtime.storageManager as unknown as {
    server(): {
      transact(
        message: { requestId: string },
        publish?: (response: Response) => void,
      ): Promise<Response>;
    };
  }).server();
  const original = server.transact.bind(server);
  let armed = true;
  server.transact = (message, publish) => {
    if (!armed) return original(message, publish);
    armed = false;
    const response: Response = {
      type: "response",
      requestId: message.requestId,
      error,
    };
    publish?.(response);
    return Promise.resolve(response);
  };
  return () => {
    server.transact = original;
  };
}

describe("scheduler event drop predicate", () => {
  // Every case here puts one piece into the state a refused instantiation
  // commit leaves it in: the registration stands, its pattern graph is
  // retired, and the one re-instantiation the runner schedules is waiting on
  // a caught-up view. Nothing is registered for the piece's stream in that
  // state, and `ensurePieceRunning` reports the piece as started.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let handlerEvents: unknown[];
  let restoreTransact: (() => void) | undefined;
  let releaseRetry: (() => void) | undefined;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: true },
    });
    handlerEvents = [];
  });

  afterEach(async () => {
    releaseRetry?.();
    await runtime.runner.idlePieceInstantiationSettlements();
    restoreTransact?.();
    await runtime.dispose();
    await storageManager.close();
  });

  // Start a piece whose instantiation commit is refused, and return the link
  // of the stream its handler is bound to. The pattern instantiates a child
  // piece: instantiation must carry durable writes of its own, or its commit
  // settles locally and no refusal can reach it.
  async function startPieceWithRetiredGraph(): Promise<NormalizedFullLink> {
    const childPattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" }, output: { type: "number" } },
      },
      resultSchema: {},
      result: { $alias: { partialCause: "output", path: [], defer: 1 } },
      nodes: [
        {
          module: { type: "passthrough" },
          inputs: {
            value: { $alias: { cell: "argument", path: ["input"], defer: 1 } },
          },
          outputs: {
            value: { $alias: { partialCause: "output", path: [], defer: 1 } },
          },
        },
      ],
    };
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { value: { type: "number" } },
      },
      resultSchema: {
        type: "object",
        properties: { events: { type: "object" }, seen: { type: "number" } },
      },
      derivedInternalCells: [
        { partialCause: "events", schema: { asCell: ["stream"] } },
        { partialCause: "seen", schema: { default: 0 } },
        { partialCause: "child" },
      ],
      result: {
        events: { $alias: { partialCause: "events", path: [] } },
        seen: { $alias: { partialCause: "seen", path: [] } },
      },
      nodes: [
        {
          module: {
            type: "javascript",
            wrapper: "handler",
            implementation: (event: unknown, ctx: { seen: number }) => {
              handlerEvents.push(event);
              ctx.seen = (ctx.seen ?? 0) + 1;
            },
          },
          inputs: {
            $event: { $alias: { partialCause: "events", path: [] } },
            $ctx: { seen: { $alias: { partialCause: "seen", path: [] } } },
          },
          outputs: { seen: { $alias: { partialCause: "seen", path: [] } } },
        },
        {
          module: { type: "pattern", implementation: childPattern },
          inputs: { input: { $alias: { cell: "argument", path: ["value"] } } },
          outputs: { $alias: { partialCause: "child", path: [] } },
        },
      ],
    };
    const patternIdentity = {
      identity: "test-drop-predicate",
      symbol: "default",
    };
    runtime.patternManager.associatePatternIdentity(
      trustPattern(runtime, pattern),
      patternIdentity,
    );

    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      space,
      "drop-predicate-result",
      undefined,
      tx,
    );
    const argumentCell = getMetaCell(resultCell, "argument", tx);
    const eventsCell = getDerivedInternalCell(resultCell, {
      partialCause: "events",
    }, tx);
    const seenCell = getDerivedInternalCell(resultCell, {
      partialCause: "seen",
    }, tx);
    resultCell.setRaw({
      events: eventsCell.getAsWriteRedirectLink(),
      seen: seenCell.getAsWriteRedirectLink(),
    });
    resultCell.setMetaRaw(
      "patternIdentity",
      patternIdentity,
      rawMetaWriteAuthorization,
    );
    resultCell.setMetaRaw(
      "argument",
      argumentCell.getAsWriteRedirectLink(),
      rawMetaWriteAuthorization,
    );
    setResultCell(eventsCell, resultCell);
    setResultCell(seenCell, resultCell);
    argumentCell.set({ value: 1 });
    await tx.commit();

    restoreTransact = rejectNextTransact(runtime, {
      name: "ConflictError",
      message: "stale confirmed read: of:drop-predicate-result at seq 0 " +
        "conflicted with seq 1",
    });
    // Hold the re-instantiation at its readiness gate, so the piece stays in
    // the state under test for as long as the case needs it.
    const parked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    releaseRetry = release.resolve;
    runtime.awaitCommitRetryReadiness = () => {
      parked.resolve();
      return release.promise;
    };

    await runtime.runner.start(resultCell);
    await parked.promise;
    return eventsCell.getAsNormalizedFullLink();
  }

  it("reports a piece whose graph is retired as started", async () => {
    const eventsLink = await startPieceWithRetiredGraph();

    expect(await ensurePieceRunning(runtime, eventsLink)).toBe(true);
  });

  it("defers a served event sent while its piece's graph is retired", async () => {
    const eventsLink = await startPieceWithRetiredGraph();
    const outcomes: ServedEventFailureOutcome[] = [];

    runtime.scheduler.queueEvent(
      eventsLink,
      { type: "add-module" },
      true,
      undefined,
      false,
      {
        eventId: "evt:add-module",
        served: {
          streamEntry: { sidecarId: "of:stream-events", index: 0, seq: 1 },
          onFailure: (outcome) => outcomes.push(outcome),
        },
      },
    );
    await runtime.idle();

    expect(handlerEvents).toEqual([]);
    expect(outcomes).toEqual([{
      kind: "deferred",
      message: expect.any(String),
    }]);
  });

  it("holds a later-arrived served event behind the deferred one", async () => {
    const eventsLink = await startPieceWithRetiredGraph();
    const followerLink: NormalizedFullLink = {
      ...eventsLink,
      id: "of:follower-stream",
    };
    const followerOutcomes: ServedEventFailureOutcome[] = [];
    const followerEvents: unknown[] = [];
    runtime.scheduler.addEventHandler((_tx, value) => {
      followerEvents.push(value);
    }, followerLink);

    runtime.scheduler.queueEvent(
      eventsLink,
      { type: "add-module" },
      true,
      undefined,
      false,
      {
        eventId: "evt:add-module",
        served: {
          streamEntry: { sidecarId: "of:stream-events", index: 0, seq: 1 },
        },
      },
    );
    runtime.scheduler.queueEvent(
      followerLink,
      { type: "follower" },
      true,
      undefined,
      false,
      {
        eventId: "evt:follower",
        served: {
          streamEntry: { sidecarId: "of:stream-follower", index: 0, seq: 2 },
          onFailure: (outcome) => followerOutcomes.push(outcome),
        },
      },
    );
    await runtime.idle();

    expect(followerEvents).toEqual([]);
    expect(followerOutcomes).toEqual([{
      kind: "deferred",
      cause: "arrival-barrier",
      blockedBy: "evt:add-module",
    }]);
  });
});

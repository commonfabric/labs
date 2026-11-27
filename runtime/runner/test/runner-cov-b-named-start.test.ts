/**
 * How a run that names its piece first reports a preparation that failed: a
 * scoped default whose seeding transaction did not commit.
 */

import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";
import { stampSpeculationRunContext } from "../src/speculation/overlay-destination.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { commitRefusal } from "./support/intercept-piece-start-commit.ts";

const owner = await Identity.fromPassphrase("runner-cov-b named start owner");
const visitor = await Identity.fromPassphrase(
  "runner-cov-b named start visitor",
);
const space = owner.did();

const resultSchema = {
  type: "object",
  properties: {
    draft: { type: "object", asCell: ["cell"] },
  },
  required: ["draft"],
} as const satisfies JSONSchema;

/**
 * A pattern owning a draft that starts from `{ title: "" }`, per user unless
 * `perSpace`.
 */
function draftHolder(runtime: Runtime, perSpace = false) {
  const { pattern, Cell } = createTrustedBuilder(runtime).commonfabric;
  const scoped = perSpace ? Cell.perSpace : Cell.perUser;
  return pattern(
    () => ({ draft: scoped.of<{ title: string }>({ title: "" }) }),
    { type: "object", properties: {} },
    resultSchema,
  );
}

describe("runner named start", () => {
  let server: MemoryV2Server.Server;
  let opened: { runtime: Runtime; manager: EmulatedStorageManager }[];

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    opened = [];
  });

  afterEach(async () => {
    for (const { runtime, manager } of opened) {
      await manager.synced();
      await runtime.dispose();
      await manager.close();
    }
    await server.close();
  });

  function openRuntime(as: Identity, serverExecution = false) {
    const manager = EmulatedStorageManager.connectTo(server, { as });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      ...(serverExecution ? { experimental: { serverExecution } } : {}),
    });
    opened.push({ runtime, manager });
    return runtime;
  }

  it("reports the start as failed, naming the defaults, when seeding a scoped default does not commit", async () => {
    const first = openRuntime(owner);
    await first.runSynced(
      first.getCell(space, "draft holder", resultSchema),
      draftHolder(first),
      {},
    );
    await first.idle();

    const second = openRuntime(visitor);
    const piece = second.getCell(space, "draft holder", resultSchema);
    const pattern = draftHolder(second);
    await piece.sync();
    const failures: { actionId: string; error: unknown }[] = [];
    second.pieceStartCommitFailureObserver = (failure) => {
      failures.push(failure);
    };
    // The seed is the first `editWithRetry()` after the name-sync lands.
    const editWithRetry = second.editWithRetry.bind(second);
    let refused = 0;
    second.runner.accessForTestingOnly.dependencySyncer = async (
      cell,
      synced,
      inputs,
      sync,
    ) => {
      const landed = await sync(cell, synced, inputs);
      second.editWithRetry = ((fn: never) => {
        second.editWithRetry = editWithRetry;
        refused++;
        void fn;
        return Promise.resolve({ error: commitRefusal("seed refused") });
      }) as typeof second.editWithRetry;
      return landed;
    };
    const errorLog = console.error;
    console.error = () => {};
    try {
      const tx = second.edit();
      second.run(tx, pattern, {}, piece);
      expect((await tx.commit().settled).error).toBeUndefined();
      await second.idle();
    } finally {
      console.error = errorLog;
      second.editWithRetry = editWithRetry;
      second.runner.accessForTestingOnly.dependencySyncer = undefined;
    }

    expect(refused).toBe(1);
    const draftId = piece.key("draft").resolveAsCell()
      .getAsNormalizedFullLink().id;
    expect(failures.map(({ actionId, error }) => [
      actionId,
      (error as Error).message,
    ])).toEqual([[
      `piece-run/${piece.getAsNormalizedFullLink().id}`,
      `Could not initialize scoped defaults ${draftId}: seed refused`,
    ]]);
    expect(second.runner.isRunning(piece)).toBe(false);
    expect(piece.key("draft").resolveAsCell().getRawUntyped())
      .toBeUndefined();
  });

  it("commits a run given no transaction itself, and starts the piece once its name-sync lands", async () => {
    const first = openRuntime(owner);
    await first.runSynced(
      first.getCell(space, "draft holder", resultSchema),
      draftHolder(first),
      {},
    );
    await first.idle();

    const second = openRuntime(visitor);
    const piece = second.getCell(space, "draft holder", resultSchema);
    await piece.sync();
    let named = 0;
    second.runner.accessForTestingOnly.dependencySyncer = (
      cell,
      synced,
      inputs,
      sync,
    ) => {
      named++;
      return sync(cell, synced, inputs);
    };
    try {
      second.run(undefined, draftHolder(second), {}, piece);
      expect(second.runner.isRunning(piece)).toBe(false);
      await second.idle();
    } finally {
      second.runner.accessForTestingOnly.dependencySyncer = undefined;
    }

    expect(named).toBe(1);
    expect(second.runner.isRunning(piece)).toBe(true);
    expect(piece.key("draft").resolveAsCell().getRawUntyped())
      .toEqual({ title: "" });
  });

  it("seeds no scoped default when the start is stopped as its seeding transaction opens", async () => {
    const first = openRuntime(owner);
    await first.runSynced(
      first.getCell(space, "draft holder", resultSchema),
      draftHolder(first),
      {},
    );
    await first.idle();

    const second = openRuntime(visitor);
    const piece = second.getCell(space, "draft holder", resultSchema);
    await piece.sync();
    // The seed is the first `editWithRetry()` after the name-sync lands; the
    // piece is stopped just before its callback runs.
    const editWithRetry = second.editWithRetry.bind(second);
    let seeded: unknown = "not called";
    second.runner.accessForTestingOnly.dependencySyncer = async (
      cell,
      synced,
      inputs,
      sync,
    ) => {
      const landed = await sync(cell, synced, inputs);
      second.editWithRetry = ((fn, ...rest) => {
        second.editWithRetry = editWithRetry;
        second.runner.stop(piece);
        return editWithRetry((tx) => {
          seeded = fn(tx);
          return seeded;
        }, ...rest);
      }) as typeof second.editWithRetry;
      return landed;
    };
    try {
      const tx = second.edit();
      second.run(tx, draftHolder(second), {}, piece);
      expect((await tx.commit().settled).error).toBeUndefined();
      await second.idle();
    } finally {
      second.editWithRetry = editWithRetry;
      second.runner.accessForTestingOnly.dependencySyncer = undefined;
    }

    expect(seeded).toBeUndefined();
    expect(second.runner.isRunning(piece)).toBe(false);
    expect(piece.key("draft").resolveAsCell().getRawUntyped())
      .toBeUndefined();
  });

  it("installs nothing when the start is stopped as its transaction opens", async () => {
    const first = openRuntime(owner);
    await first.runSynced(
      first.getCell(space, "space draft holder", resultSchema),
      draftHolder(first, true),
      {},
    );
    await first.idle();

    const second = openRuntime(visitor);
    const piece = second.getCell(space, "space draft holder", resultSchema);
    await piece.sync();
    // The start's transaction is the first one opened after the name-sync
    // lands; the piece is stopped as it opens.
    const edit = second.edit.bind(second);
    let stopped = 0;
    second.runner.accessForTestingOnly.dependencySyncer = async (
      cell,
      synced,
      inputs,
      sync,
    ) => {
      const landed = await sync(cell, synced, inputs);
      second.edit = ((options) => {
        second.edit = edit;
        stopped++;
        second.runner.stop(piece);
        return edit(options);
      }) as typeof second.edit;
      return landed;
    };
    const errorLog = console.error;
    const errors: unknown[] = [];
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const tx = second.edit();
      second.run(tx, draftHolder(second, true), {}, piece);
      expect((await tx.commit().settled).error).toBeUndefined();
      await second.idle();
    } finally {
      console.error = errorLog;
      second.edit = edit;
      second.runner.accessForTestingOnly.dependencySyncer = undefined;
    }

    expect(stopped).toBe(1);
    expect(errors).toEqual([]);
    expect(second.runner.isRunning(piece)).toBe(false);
  });

  it("drops an authored run that waited on a speculative name-sync when the piece is stopped before it lands", async () => {
    const first = openRuntime(owner);
    await first.runSynced(
      first.getCell(space, "draft holder", resultSchema),
      draftHolder(first),
      {},
    );
    await first.idle();

    const second = openRuntime(visitor, true);
    const piece = second.getCell(space, "draft holder", resultSchema);
    const pattern = draftHolder(second);
    await piece.sync();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let syncs = 0;
    second.runner.accessForTestingOnly.dependencySyncer = async (
      cell,
      synced,
      inputs,
      sync,
    ) => {
      syncs++;
      entered.resolve();
      await release.promise;
      return await sync(cell, synced, inputs);
    };
    try {
      const speculative = second.edit();
      stampSpeculationRunContext(speculative, {
        actionId: "speculative-draft-start",
        kind: "derivation",
      });
      second.run(speculative, pattern, {}, piece);
      expect((await speculative.commit().settled).error).toBeUndefined();
      await entered.promise;

      const authored = second.edit();
      second.run(authored, pattern, {}, piece);
      expect((await authored.commit().settled).error).toBeUndefined();
      second.runner.stop(piece);
    } finally {
      release.resolve();
      await second.idle();
      second.runner.accessForTestingOnly.dependencySyncer = undefined;
    }

    // The authored run's own name-sync, which would seed the default, never
    // starts.
    expect(syncs).toBe(1);
    expect(second.runner.isRunning(piece)).toBe(false);
    expect(piece.key("draft").resolveAsCell().getRawUntyped())
      .toBeUndefined();
  });
});

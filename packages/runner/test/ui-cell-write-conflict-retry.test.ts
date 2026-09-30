// The cfc-group-chat-demo :133 stall's missing CONSUMER, pinned at the
// runner seam (register: verification-coverage.md OW45's PHASE-3 groupchat
// observation; rootcause §2b; live evidence: 4/4 tap-instrumented reds,
// each `stale confirmed read … conflicted with …` on the piece argument
// doc's `hostMessageDraft`, 2026-08-27).
//
// Mechanism, in three layers:
//  1. ENGINE (already pinned in
//     packages/memory/test/cellset-structural-precondition.test.ts): a
//     blind `$value` write threads a shape precondition at its cell's
//     PARENT; a concurrent structure change there admits first and the
//     engine refuses the write as `stale confirmed read` — a ConflictError
//     the ruled vocabulary classifies RETRYABLE (storage/rejection.ts:
//     catch-up, then a fresh read converges). Under server execution a
//     serving wave routinely lands exactly such structure (the first /cfc
//     labelMap stamp, a sibling key add) on the argument doc concurrently
//     with typing.
//  2. CONSUMER (this file): the UI write path (handleCellSet/handleCellPush
//     → applyCellWrite) fired `tx.commit()` and dropped the result, so the
//     retryable rejection's readyToRetry gate had no consumer: the USER'S
//     INPUT was silently and permanently lost — no retry, no log, no
//     counter — while every served derivation over the draft (the send
//     button's disabled state) stayed correctly stale forever.
//  3. LIVE (the integration file): cfc-group-chat-demo.test.ts:133 red
//     5/6 at 23cf68e7d running alone, every red store missing the draft.
//
// The cross-replica staleness itself cannot be manufactured in this
// in-process harness — it propagates shared state synchronously (the
// recorded limitation in the engine test's own header) — so the conflict
// here is INJECTED on the first commit attempt in the engine's exact
// stale-read shape, and a vocabulary pin below keeps the injected shape
// honest against the classifier the retry protocol actually consults.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { DEFAULT_MAX_RETRIES, Runtime } from "../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { ArrivalLog } from "./support/serving-waits.ts";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import {
  isRetryableCommitRejection,
  isStaleReadConflict,
} from "../src/storage/rejection.ts";

const spaceSigner = await Identity.fromPassphrase("ui-cell-write space");
const space = spaceSigner.did() as MemorySpace;
const aliceSigner = await Identity.fromPassphrase("ui-cell-write alice");

const schema = {
  type: "object",
  properties: {
    drafts: {
      type: "object",
      properties: {
        message: { type: "string" },
        other: { type: "string" },
      },
    },
  },
} as const;

type Doc = { drafts: { message?: string; other?: string } };

/**
 * The engine's stale-read rejection, byte-shaped like the live tap evidence
 * (`stale confirmed read: <id> at seq N conflicted with seq M`), with the
 * catch-up gate a real rejection carries. `readyToRetry` resolves when the
 * given release does, so a pin can hold a retry in the readiness wait while
 * a newer write overtakes it.
 */
const staleReadConflict = (release: Promise<void> = Promise.resolve()) => ({
  name: "ConflictError" as const,
  message: "stale confirmed read: of:test-doc at seq 1 conflicted with seq 2",
  readyToRetry: () => release,
});

/**
 * Intercept the commits of the next `count` transactions `runtime.edit()`
 * creates: each intercepted commit aborts its transaction (discarding the
 * staged ops, exactly like a refused export) and reports the injected
 * stale-read conflict instead of reaching storage. Later transactions
 * commit for real.
 *
 * Each interception is recorded on `rejections`, so a test that has to
 * act between an attempt's rejection and its retry waits on the
 * rejection itself rather than on a counter turning over.
 */
const injectConflictOnNextCommits = (
  runtime: Runtime,
  count: number,
  makeRejection: () => ReturnType<typeof staleReadConflict>,
): {
  rejections: ArrivalLog<void>;
  intercepted: () => number;
  restore: () => void;
} => {
  const realEdit = runtime.edit.bind(runtime);
  const rejections = new ArrivalLog<void>();
  let remaining = count;
  const patched = (): IExtendedStorageTransaction => {
    const tx = realEdit();
    if (remaining > 0) {
      remaining--;
      const realCommit = tx.commit.bind(tx);
      let used = false;
      tx.commit = (options?: Parameters<typeof realCommit>[0]) => {
        if (used) return realCommit(options);
        used = true;
        const rejection = makeRejection();
        tx.abort(rejection);
        rejections.record();
        return Promise.resolve({ error: rejection as never });
      };
    }
    return tx;
  };
  (runtime as unknown as { edit: () => IExtendedStorageTransaction }).edit =
    patched;
  return {
    rejections,
    intercepted: () => rejections.entries.length,
    restore: () => {
      (runtime as unknown as { edit: () => IExtendedStorageTransaction })
        .edit = realEdit;
    },
  };
};

const uiWriteLostCount = (): number => {
  const breakdown = getLoggerCountsBreakdown() as Record<
    string,
    Record<string, { total?: number } | number | undefined> | undefined
  >;
  const entry = breakdown["runtime.ui-cell-write"]?.["lost"];
  if (entry === undefined) return 0;
  return typeof entry === "number" ? entry : entry.total ?? 0;
};

describe("UI cell write conflict retry (the :133 stall's consumer seam)", () => {
  let server: MemoryV2Server.Server;
  let manager: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    manager = EmulatedStorageManager.connectTo(server, { as: aliceSigner });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await manager.close();
    await server.close();
  });

  it("keeps the injected rejection honest against the ruled vocabulary", () => {
    const rejection = staleReadConflict();
    expect(isRetryableCommitRejection(rejection)).toBe(true);
    expect(isStaleReadConflict(rejection)).toBe(true);
  });

  it("a blind UI write whose commit is conflict-rejected still lands durably (retried, not dropped)", async () => {
    // Seed the doc so the write below edits established state.
    const seed = runtime.edit();
    const cell = runtime.getCell<Doc>(space, "ui-write-retry", schema, seed);
    cell.withTx(seed).set({ drafts: { message: "seed" } });
    const seeded = await seed.commit();
    expect(seeded.error).toBeUndefined();

    const leaf = cell.key("drafts").key("message");
    const injection = injectConflictOnNextCommits(
      runtime,
      1,
      () => staleReadConflict(),
    );
    try {
      // THE USER ACT: the UI write path's blind shape. The first commit
      // attempt is rejected exactly the way the live race rejects it; the
      // pin is that the typed value still becomes durable. Pre-fix the
      // write path fire-and-forgets the commit, so the value is simply
      // gone — the watched RED of the :133 stall.
      const outcome = await runtime.commitUiCellWrite(leaf, "typed", {
        blind: true,
        supersedeKey: "ui-write-retry-lane",
      });
      expect(outcome.error).toBeUndefined();
      expect(injection.intercepted()).toBe(1);
    } finally {
      injection.restore();
    }

    // The commit resolved, so the retry has landed; the local view
    // catches up once the runtime is quiescent.
    await runtime.idle();
    expect(leaf.get()).toBe("typed");

    // Durable, not overlay: a fresh reader session sees it.
    const readerManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    const readerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerManager,
    });
    try {
      const readerCell = readerRuntime.getCell<Doc>(
        space,
        "ui-write-retry",
        schema,
      );
      await readerCell.sync();
      await waitForCellValue<string>(
        readerRuntime,
        readerCell.key("drafts").key("message"),
        (message) => message === "typed",
        { stuckLabel: "the reader to see the typed draft message" },
      );
    } finally {
      await readerRuntime.dispose();
      await readerManager.close();
    }
  });

  it("a retry writes the lane's newest value, never its own (no LWW inversion, no vacuous-owner strand)", async () => {
    const seed = runtime.edit();
    const cell = runtime.getCell<Doc>(space, "ui-write-lww", schema, seed);
    cell.withTx(seed).set({ drafts: { message: "seed" } });
    const seeded = await seed.commit();
    expect(seeded.error).toBeUndefined();

    const leaf = cell.key("drafts").key("message");
    let releaseRetry!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const injection = injectConflictOnNextCommits(
      runtime,
      1,
      () => staleReadConflict(held),
    );
    try {
      // w1 ("old") conflicts and parks in the readiness wait...
      const w1 = runtime.commitUiCellWrite(leaf, "old", {
        blind: true,
        supersedeKey: "ui-write-lww-lane",
      });
      await injection.rejections.reached(1);
      // ...while w2 ("new") lands on the same lane.
      const w2Outcome = await runtime.commitUiCellWrite(leaf, "new", {
        blind: true,
        supersedeKey: "ui-write-lww-lane",
      });
      expect(w2Outcome.error).toBeUndefined();
      // Release w1's retry: it re-issues the lane's NEWEST value ("new"),
      // never its own "old" — the LWW-inversion guard. And because the
      // retry re-issues rather than declining, a newer call that resolved
      // VACUOUSLY (its set no-oped against the older write's optimistic
      // layer — the d05-diagnosed live shape) cannot strand the value:
      // the older loop still lands the newest value on the repaired base.
      releaseRetry();
      const w1Outcome = await w1;
      expect(w1Outcome.error).toBeUndefined();
      expect(w1Outcome.ok).toBe("committed");
    } finally {
      injection.restore();
    }

    // Both writes have resolved, so nothing further is in flight; the
    // released retry's own re-issue is behind `w1` above. Draining the
    // runtime and flushing its manager is ordered after both, so the
    // value read here is the surviving one — "new", not the retry's
    // own "old".
    await runtime.idle();
    await runtime.storageManager.synced();
    expect(leaf.get()).toBe("new");
  });

  it("a conflicted CAS push is NOT retried — the stale read-modify-write premise must not re-commit (cubic/codex P1 on #6477)", async () => {
    const seed = runtime.edit();
    const cell = runtime.getCell<Doc>(space, "ui-write-cas", schema, seed);
    cell.withTx(seed).set({ drafts: { message: "seed" } });
    const seeded = await seed.commit();
    expect(seeded.error).toBeUndefined();

    const leaf = cell.key("drafts").key("message");
    const lostBefore = uiWriteLostCount();
    const injection = injectConflictOnNextCommits(
      runtime,
      1,
      () => staleReadConflict(),
    );
    try {
      // A push's value embeds a read-modify-write premise resolved on the
      // main thread; a conflict means that premise is stale, and re-running
      // `set` with the same resolved value against fresh state could erase
      // an intervening writer's append. So the CAS class takes ONE attempt:
      // the conflict surfaces loudly instead of retrying.
      const outcome = await runtime.commitUiCellWrite(leaf, "stale-cas", {
        blind: false,
      });
      expect(outcome.error?.name).toBe("ConflictError");
      expect(injection.intercepted()).toBe(1);
    } finally {
      injection.restore();
    }
    expect(uiWriteLostCount()).toBeGreaterThan(lostBefore);
    // The stale value never lands — not on the first attempt (rejected)
    // and not through any retry. A retry would be work this runtime
    // owns, so draining it and flushing its manager is ordered after
    // one.
    await runtime.idle();
    await runtime.storageManager.synced();
    expect(leaf.get()).toBe("seed");
  });

  it("an exhausted retry budget surfaces the loss loudly instead of silently", async () => {
    const seed = runtime.edit();
    const cell = runtime.getCell<Doc>(space, "ui-write-loss", schema, seed);
    cell.withTx(seed).set({ drafts: { message: "seed" } });
    const seeded = await seed.commit();
    expect(seeded.error).toBeUndefined();

    const leaf = cell.key("drafts").key("message");
    const lostBefore = uiWriteLostCount();
    const injection = injectConflictOnNextCommits(
      runtime,
      DEFAULT_MAX_RETRIES + 1,
      () => staleReadConflict(),
    );
    try {
      const outcome = await runtime.commitUiCellWrite(leaf, "doomed", {
        blind: true,
        supersedeKey: "ui-write-loss-lane",
      });
      expect(outcome.error?.name).toBe("ConflictError");
      expect(injection.intercepted()).toBe(DEFAULT_MAX_RETRIES + 1);
    } finally {
      injection.restore();
    }
    // The loss is COUNTED (visible to a run's census) — never silent again.
    expect(uiWriteLostCount()).toBeGreaterThan(lostBefore);
  });
});

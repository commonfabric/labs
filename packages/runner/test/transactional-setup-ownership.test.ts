import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { getMetaLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTransactionCommitReceipt } from "../src/storage/commit-receipt.ts";
import type { RuntimeTelemetryEvent } from "../src/telemetry.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("transactional setup ownership");
const space = signer.did();

describe("transactional setup ownership", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("keeps a shared child reactive when a newer setup commits first", async () => {
    // Two runs of one computation overlap: the first materializes the child and
    // then aborts, while the second commits in between. Only the first run
    // materializes anything — the second finds the pattern unchanged and writes
    // no child setup at all — so the aborting run is the one that installed the
    // registration and the memo, and it is the one that has to take them back.
    // The requirement is that the child comes back and stays reactive, not that
    // any particular bookkeeping survives the abort untouched.

    // Whether a child has been memoized yet, read from the runner's memoize
    // marker: it is what tells a commit of the computation's own transaction
    // from one issued before any child was materialized.
    let childMemoized = false;
    runtime.telemetry.addEventListener("telemetry", (event: Event) => {
      const { marker } = (event as RuntimeTelemetryEvent).detail;
      if (marker.type === "runner.result-pattern.memoize") childMemoized = true;
    });
    const originalEdit = runtime.edit.bind(runtime);
    type TestTx = ReturnType<typeof originalEdit>;
    type CommitResult = Awaited<ReturnType<TestTx["commit"]>["settled"]>;
    type HeldCommit = {
      tx: TestTx;
      commit: TestTx["commit"];
      promise: Promise<CommitResult>;
      resolve: (result: CommitResult) => void;
      result?: CommitResult;
    };
    const firstCaptured = Promise.withResolvers<void>();
    const secondCaptured = Promise.withResolvers<void>();
    const held: HeldCommit[] = [];
    let sourceAction: Action | undefined;

    runtime.edit = ((...args: Parameters<typeof originalEdit>) => {
      const tx = originalEdit(...args);
      const originalCommit = tx.commit.bind(tx);
      tx.commit = (() => {
        const action = tx.tx.sourceAction;
        if (
          held.length >= 2 || action === undefined ||
          !childMemoized ||
          (sourceAction !== undefined && action !== sourceAction)
        ) {
          return originalCommit();
        }
        const completion = Promise.withResolvers<CommitResult>();
        held.push({
          tx,
          commit: originalCommit,
          promise: completion.promise,
          resolve: completion.resolve,
        });
        if (held.length === 1) {
          sourceAction = action as Action;
          firstCaptured.resolve();
        } else {
          secondCaptured.resolve();
        }
        return createTransactionCommitReceipt(completion.promise);
      }) as typeof tx.commit;
      return tx;
    }) as typeof runtime.edit;

    try {
      const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
      const childPattern = pattern<{ value: number }>(({ value }) => ({
        doubled: lift((input: number) => input * 2)(value),
      }));
      const makeChild = lift(({ value }: { value: number }) =>
        childPattern({ value })
      );
      const parentPattern = pattern<{ value: number }>(({ value }) => ({
        child: makeChild({ value }),
      }));
      const setupTx = runtime.edit();
      const parent = runtime.getCell(
        space,
        "same-pattern child owner",
        undefined,
        setupTx,
      );
      const result = runtime.run(
        setupTx,
        parentPattern,
        { value: 3 },
        parent,
      );
      expect((await setupTx.commit().settled).error).toBeUndefined();
      const initialPull = result.pull();

      await firstCaptured.promise;
      if (sourceAction === undefined) {
        throw new Error("action transaction had no source");
      }
      await runtime.scheduler.run(sourceAction);
      await secondCaptured.promise;

      const newerCommit = await held[1].commit().settled;
      expect(newerCommit.error).toBeUndefined();
      held[1].result = newerCommit;
      held[1].resolve(newerCommit);
      expect(held[0].tx.abort("the original setup aborted").error)
        .toBeUndefined();
      const abortedCommit = await held[0].commit().settled;
      held[0].result = abortedCommit;
      held[0].resolve(abortedCommit);
      await initialPull;
      // The abort's take-back re-materializes the child (possibly under a new
      // id); drain the in-flight re-setup before resolving the child, so the
      // captured argument link belongs to the live child rather than the
      // doomed one.
      await clock.settle();
      await runtime.scheduler.idleWithPendingCommits();

      const child = result.key("child").resolveAsCell();
      expect(await child.key("doubled").pull()).toBe(6);
      const argumentLink = getMetaLink(child, "argument");
      expect(argumentLink).toBeDefined();
      const updateTx = runtime.edit();
      runtime.getCellFromLink<{ value: number }>(
        argumentLink!,
        undefined,
        updateTx,
      ).set({ value: 4 });
      expect((await updateTx.commit().settled).error).toBeUndefined();
      await runtime.scheduler.idleWithPendingCommits();
      expect(await child.key("doubled").pull()).toBe(8);
      runtime.runner.stop(parent);
    } finally {
      runtime.edit = originalEdit;
      for (const heldCommit of held) {
        if (heldCommit.result !== undefined) continue;
        if (heldCommit.tx.status().status === "ready") {
          heldCommit.tx.abort("shared child ownership test finished");
        }
        const result = await heldCommit.commit().settled;
        heldCommit.result = result;
        heldCommit.resolve(result);
      }
      await Promise.all(held.map(({ promise }) => promise));
    }
  });

  it("produces a mapped result after its child setup aborts", async () => {
    const { cell, lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const operation = pattern<{ element: number }>(({ element }) =>
      lift((value: number) => value * 2)(element)
    );
    const parentPattern = pattern(() => {
      const items = cell<number[]>([]);
      return {
        items,
        mapped: (items as unknown as {
          mapWithPattern(
            operation: unknown,
            params: Record<string, never>,
          ): unknown;
        }).mapWithPattern(operation, {}),
      };
    });
    const setupTx = runtime.edit();
    const parent = runtime.getCell<{
      items: number[];
      mapped: number[];
    }>(space, "aborted map child setup", undefined, setupTx);
    const result = runtime.run(setupTx, parentPattern, {}, parent);
    expect((await setupTx.commit().settled).error).toBeUndefined();
    const stopReading = result.key("mapped").sink(() => {});
    await runtime.scheduler.idleWithPendingCommits();

    const originalRun = runtime.runner.run;
    let firstSetupAborted = false;
    let childSetups = 0;
    runtime.runner.run = ((...args: Parameters<typeof originalRun>) => {
      const run = Reflect.apply(originalRun, runtime.runner, args);
      const options = args[4] as
        | { doNotUpdateOnPatternChange?: boolean }
        | undefined;
      if (options?.doNotUpdateOnPatternChange !== true) return run;

      childSetups++;
      if (childSetups === 1) {
        const childTx = args[0];
        if (childTx === undefined) {
          throw new Error("map child setup had no transaction");
        }
        const originalCommit = childTx.commit.bind(childTx);
        childTx.commit = (() => {
          expect(childTx.abort("abort the first map child setup").error)
            .toBeUndefined();
          firstSetupAborted = true;
          return originalCommit();
        }) as typeof childTx.commit;
      }
      return run;
    }) as typeof runtime.runner.run;

    try {
      const updateTx = runtime.edit();
      result.key("items").withTx(updateTx).set([1]);
      expect((await updateTx.commit().settled).error).toBeUndefined();
      await runtime.scheduler.idleWithPendingCommits();

      expect(firstSetupAborted).toBe(true);
      expect(await result.key("mapped").pull()).toEqual([2]);
    } finally {
      runtime.runner.run = originalRun;
      stopReading();
    }
  });
});

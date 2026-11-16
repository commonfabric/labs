/**
 * The failure arms of the runner's two commit-gated starts: a piece start
 * deferred until the transaction that asked for it commits, and a pattern
 * run the same way (`runPatternAfterSuccessfulCommit()`, the navigate
 * receipt's shape).
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import type { DeferredStartCommitter } from "../src/runner.ts";
import { Runtime } from "../src/runtime.ts";
import { entityKey } from "../src/scheduler/keys.ts";
import { commitRefusal } from "./support/intercept-piece-start-commit.ts";
import {
  createTrustedBuilder,
  trustPattern,
} from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("deferred start failures");
const space = signer.did();

describe("deferred-start-failures", () => {
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
    runtime.runner.accessForTestingOnly.deferredStartCommitter = undefined;
    await runtime.dispose();
    await storageManager.close();
  });

  const key = (cell: Cell<unknown>) =>
    entityKey(cell.getAsNormalizedFullLink(), runtime.scopeKeyIdentity);

  // Records what the runner logger reports at error level, logging it as
  // usual, with the console's copy discarded.
  const captureErrors = () => {
    const logged = spy(getLogger("runner"), "error");
    const printed = stub(console, "error", () => {});
    return {
      reports: () => logged.calls.map((call) => call.args),
      [Symbol.dispose]: () => {
        logged.restore();
        printed.restore();
      },
    };
  };

  const doubling = (): Pattern => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    return pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
  };

  // A pattern whose one node runs `instantiate` as the start instantiates it.
  const instantiating = (instantiate: () => void): Pattern =>
    trustPattern(runtime, {
      argumentSchema: {},
      resultSchema: {},
      result: {},
      nodes: [{
        module: {
          type: "raw",
          implementation: () => {
            instantiate();
            return () => {};
          },
        },
        inputs: {},
        outputs: {},
      }],
    });

  // Commits each start transaction through `commit`, the runner's own step.
  const commitStartsWith = (committer: DeferredStartCommitter): void => {
    runtime.runner.accessForTestingOnly.deferredStartCommitter = committer;
  };

  // Each case is driven twice over: once through a start the runner defers
  // until the transaction that ran the piece commits, and once through
  // `runPatternAfterSuccessfulCommit()`. `defer()` runs `pattern` as the
  // piece `name`, calls `beforeCommit` with the start's cancel handle, commits,
  // and returns the result cell.
  const arms: {
    name: string;
    commitRefused: string;
    commitRejected: string;
    startFailed: string;
    defer(
      name: string,
      pattern: Pattern,
      beforeCommit?: (cancel: () => void) => void,
    ): Promise<Cell<unknown>>;
  }[] = [{
    name: "a deferred piece start",
    commitRefused: "Error committing deferred start transaction",
    commitRejected: "Deferred start transaction commit rejected",
    startFailed: "Deferred start failed",
    defer: async (name, pattern, beforeCommit) => {
      // `editWithRetry()` asks the runner to defer the starts its action
      // makes until the action's transaction commits.
      const outcome = await runtime.editWithRetry((tx) => {
        const run = runtime.runner.accessForTestingOnly.runWithStartOwnership(
          tx,
          pattern,
          { value: 3 },
          runtime.getCell(space, name, undefined, tx),
        );
        beforeCommit?.(run.cancelDeferredStart!);
      });
      expect(outcome.error).toBeUndefined();
      return runtime.getCell(space, name);
    },
  }, {
    name: "a deferred pattern run",
    commitRefused: "Error committing deferred cross-space pattern transaction",
    commitRejected: "Deferred cross-space pattern transaction rejected",
    startFailed: "Deferred cross-space pattern failed",
    defer: async (name, pattern, beforeCommit) => {
      const tx = runtime.edit();
      const cancel = runtime.runner.accessForTestingOnly
        .runPatternAfterSuccessfulCommit(
          tx,
          runtime.getCell(space, name, undefined, tx),
          pattern,
          { value: 3 },
          false,
        );
      beforeCommit?.(cancel);
      expect((await tx.commit().settled).error).toBeUndefined();
      return runtime.getCell(space, name);
    },
  }];

  for (const arm of arms) {
    describe(arm.name, () => {
      it("leaves the piece running when its start commits", async () => {
        const result = await arm.defer(`${arm.name} committed`, doubling());
        await clock.settle();
        expect(runtime.runner.cancels.has(key(result))).toBe(true);
      });

      it("starts nothing when its start is cancelled before the transaction commits", async () => {
        let commits = 0;
        commitStartsWith((_startTx, _cell, commit) => {
          commits++;
          return commit();
        });
        const result = await arm.defer(
          `${arm.name} cancelled`,
          doubling(),
          (cancel) => cancel(),
        );
        await clock.settle();
        expect(commits).toBe(0);
        expect(runtime.runner.cancels.has(key(result))).toBe(false);
      });

      it("stops the piece and logs the refusal when its start's commit is refused", async () => {
        const failure = commitRefusal("injected refusal of the start");
        commitStartsWith((startTx) => {
          startTx.abort(failure.message);
          return Promise.resolve({ error: failure });
        });
        using errors = captureErrors();
        const result = await arm.defer(`${arm.name} refused`, doubling());
        await clock.settle();
        expect(runtime.runner.cancels.has(key(result))).toBe(false);
        expect(errors.reports()).toContainEqual([
          "tx-commit-error",
          arm.commitRefused,
          failure,
        ]);
      });

      it("stops the piece and logs the rejection when its start's commit rejects", async () => {
        const failure = new Error("injected rejection of the start");
        commitStartsWith((startTx) => {
          startTx.abort(failure.message);
          return Promise.reject(failure);
        });
        using errors = captureErrors();
        const result = await arm.defer(`${arm.name} rejected`, doubling());
        await clock.settle();
        expect(runtime.runner.cancels.has(key(result))).toBe(false);
        expect(errors.reports()).toContainEqual([
          "tx-commit-error",
          arm.commitRejected,
          failure,
        ]);
      });

      it("commits nothing and logs the failure when instantiating the piece throws", async () => {
        const failure = new Error("injected instantiation failure");
        let commits = 0;
        commitStartsWith((_startTx, _cell, commit) => {
          commits++;
          return commit();
        });
        using errors = captureErrors();
        const result = await arm.defer(
          `${arm.name} failed`,
          instantiating(() => {
            throw failure;
          }),
        );
        await clock.settle();
        expect(commits).toBe(0);
        expect(runtime.runner.cancels.has(key(result))).toBe(false);
        expect(errors.reports()).toContainEqual([
          "runner-start",
          arm.startFailed,
          failure,
        ]);
      });

      it("commits nothing when the piece is stopped while it is instantiated", async () => {
        const name = `${arm.name} stopped`;
        let commits = 0;
        commitStartsWith((_startTx, _cell, commit) => {
          commits++;
          return commit();
        });
        const result = await arm.defer(
          name,
          instantiating(() =>
            runtime.runner.stop(runtime.getCell(space, name))
          ),
        );
        await clock.settle();
        expect(commits).toBe(0);
        expect(runtime.runner.cancels.has(key(result))).toBe(false);
      });
    });
  }
});

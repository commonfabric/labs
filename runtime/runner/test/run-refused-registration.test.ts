import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTransactionCommitReceipt } from "../src/storage/commit-receipt.ts";
import type {
  CommitError,
  IExtendedStorageTransaction,
  Result,
  Unit,
} from "../src/storage/interface.ts";
import { interceptTransaction } from "./support/intercept-transaction.ts";
import { staleReadRefusal } from "./support/refuse-event-commit.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

/**
 * `Runner.run()` over a result whose registration a refused run installed: a
 * run that installs a registration in a transaction a server refuses for a
 * stale basis keeps the registration, and the next run of the same result has
 * to retire it, so that the setup that run re-issues instantiates the graph
 * again rather than reusing one whose setup writes never landed.
 */

const signer = await Identity.fromPassphrase("run refused registration");
const space = signer.did();

type CommitCallback = (
  tx: IExtendedStorageTransaction,
  result: Result<Unit, CommitError>,
) => void;

/**
 * A transaction whose commit the server refuses for a stale basis: its writes
 * are discarded, and every commit callback registered on it is told so.
 */
function refusedTransaction(
  runtime: Runtime,
  of: string,
): IExtendedStorageTransaction {
  const underlying = runtime.edit();
  const callbacks: CommitCallback[] = [];
  const refusal = staleReadRefusal(space, of, () => Promise.resolve());
  const tx = interceptTransaction(underlying, (method, args, proceed) => {
    if (method === "addCommitCallback") {
      callbacks.push(args[0] as CommitCallback);
      return undefined;
    }
    if (method === "commit") {
      underlying.abort(refusal.message);
      for (const callback of callbacks) callback(tx, { error: refusal });
      return createTransactionCommitReceipt(
        Promise.resolve({ error: refusal }),
      );
    }
    return proceed();
  });
  return tx;
}

describe("Runner", () => {
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

  const registrationOf = (result: Cell<unknown>) => {
    const { id } = result.getAsNormalizedFullLink();
    return [...runtime.runner.cancels.entries()].find(([key]) =>
      key.endsWith(`/${id}`)
    )?.[1];
  };

  const runOnce = (cause: string) => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const doubled = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((n: number) => n * 2)(value),
    }));
    const result = runtime.getCell<{ doubled: number }>(space, cause);
    return { doubled, result };
  };

  describe("run() after a run whose transaction was refused", () => {
    it("installs a fresh registration for the result", async () => {
      const { doubled, result } = runOnce("refused run, rerun");
      const refused = refusedTransaction(
        runtime,
        result.getAsNormalizedFullLink().id,
      );
      runtime.runner.run(refused, doubled, { value: 1 }, result);
      await refused.commit().settled;
      const installed = registrationOf(result);
      expect(installed).toBeDefined();

      const tx = runtime.edit();
      runtime.runner.run(tx, doubled, { value: 1 }, result);
      expect((await tx.commit().settled).error).toBeUndefined();

      const reinstalled = registrationOf(result);
      expect(reinstalled).toBeDefined();
      expect(reinstalled).not.toBe(installed);
    });

    it("installs a fresh registration for a result started in its own right, which keeps that lifetime", async () => {
      const { doubled, result } = runOnce("refused run, started, rerun");
      const refused = refusedTransaction(
        runtime,
        result.getAsNormalizedFullLink().id,
      );
      runtime.runner.run(refused, doubled, { value: 1 }, result);
      await refused.commit().settled;
      const installed = registrationOf(result);
      expect(installed).toBeDefined();
      expect(await runtime.runner.start(result)).toBe(true);

      const tx = runtime.edit();
      runtime.runner.run(tx, doubled, { value: 1 }, result);
      expect((await tx.commit().settled).error).toBeUndefined();

      const reinstalled = registrationOf(result);
      expect(reinstalled).toBeDefined();
      expect(reinstalled).not.toBe(installed);

      // An enclosing pattern releasing it leaves a result started in its own
      // right running.
      runtime.runner.releaseChild(result, undefined);
      expect(runtime.runner.isRunning(result)).toBe(true);
    });
  });
});

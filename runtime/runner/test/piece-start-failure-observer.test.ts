import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import {
  commitRefusal,
  interceptPieceStartCommit,
} from "./support/intercept-piece-start-commit.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("piece start failure observer");
const space = signer.did();

describe("pieceStartCommitFailureObserver", () => {
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

  // A piece this runtime ran and then stopped, so a start instantiates its
  // graph again and commits the setup writes in a transaction of its own.
  const stoppedPiece = async (name: string): Promise<Cell<unknown>> => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const doubling = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const tx = runtime.edit();
    const cell = runtime.getCell(space, name, undefined, tx);
    runtime.run(tx, doubling, { value: 3 }, cell);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    runtime.runner.stop(cell);
    return cell;
  };

  // Starts `cell` with its start's commit refused, and returns the rejection
  // `startWithCommit()` settles with and what the runner logger warned.
  const startRefused = async (cell: Cell<unknown>) => {
    const refusal = commitRefusal("injected refusal of the start commit");
    const intercepted = interceptPieceStartCommit(runtime, { refusal });
    const warned = spy(getLogger("runner"), "warn");
    const printed = stub(console, "warn", () => {});
    const reported = stub(console, "error", () => {});
    try {
      const rejection = await runtime.runner.startWithCommit(cell).then(
        () => undefined,
        (error: unknown) => error,
      );
      return {
        refusal,
        rejection,
        warnings: warned.calls.map(({ args: [key, ...messages] }) => ({
          key,
          parts: messages.flatMap((message) => {
            const resolved = typeof message === "function"
              ? message()
              : message;
            return Array.isArray(resolved) ? resolved : [resolved];
          }),
        })),
      };
    } finally {
      reported.restore();
      printed.restore();
      warned.restore();
      intercepted.restore();
    }
  };

  it("receives a refused start's failure", async () => {
    const cell = await stoppedPiece("observed start failure");
    const observed: unknown[] = [];
    runtime.pieceStartCommitFailureObserver = ({ error }) => {
      observed.push(error);
    };
    const { refusal, rejection, warnings } = await startRefused(cell);
    expect(observed).toEqual([refusal]);
    expect(String(rejection)).toContain(refusal.message);
    expect(warnings.map(({ key }) => key)).not.toContain(
      "piece-start-commit-observer-failed",
    );
  });

  it("warns of an observer that throws, and rejects with the refusal all the same", async () => {
    const cell = await stoppedPiece("observer throws");
    const observerFailure = new Error("injected observer failure");
    runtime.pieceStartCommitFailureObserver = () => {
      throw observerFailure;
    };
    const { refusal, rejection, warnings } = await startRefused(cell);
    expect(String(rejection)).toContain(refusal.message);
    expect(warnings).toContainEqual({
      key: "piece-start-commit-observer-failed",
      parts: ["pieceStartCommitFailureObserver threw", observerFailure],
    });
    expect(runtime.runner.isRunning(cell)).toBe(false);
  });
});

/**
 * What a builtin's abandoned-request ending reports when its own write cannot
 * commit.
 *
 * The ending is the last thing that happens for a request that was staged and
 * never sent. When its writeback is refused, a reader of the result cells sees
 * whatever was there before rather than the refusal, and nothing downstream is
 * left to say so — which is why the ending reports it, naming the builtin whose
 * cells were left as they were and the rejection that stopped it.
 *
 * A report only runs when the write underneath it fails, so a suite that does
 * not construct the failure covers it or not according to how the run happened
 * to be scheduled. This case constructs it: `settleAbandonedRequest` takes the
 * runtime it commits through, so the case hands it one whose commits are
 * refused. `docs/development/COVERAGE.md` ("Failure reports reached only when
 * the operation fails") carries the reasoning.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { settleAbandonedRequest } from "../src/builtins/abandoned-request.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTransactionCommitReceipt } from "../src/storage/commit-receipt.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

/**
 * The refusal the case injects. `AuthorizationError` without the server's
 * `retriable` marker is outside the retryable vocabulary, so `editWithRetry`
 * reports it after a single commit rather than retrying against it.
 */
const REFUSAL = {
  name: "AuthorizationError",
  message: "the space refused the write",
};

describe("settleAbandonedRequest", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pristineEdit: Runtime["edit"];
  let reported: unknown[][];
  let originalError: typeof console.error;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    pristineEdit = runtime.edit.bind(runtime);
    reported = [];
    originalError = console.error;
    console.error = (...args: unknown[]) => {
      reported.push(args);
    };
  });

  afterEach(async () => {
    console.error = originalError;
    // Hand the runtime its real commits back before teardown: a disposal whose
    // own writes are refused reports failures that belong to no case.
    // deno-lint-ignore no-explicit-any
    (runtime as any).edit = pristineEdit;
    await runtime.dispose({ closeStorage: false });
    await storageManager.close();
  });

  /** Refuse the commit of every transaction this runtime opens from now on. */
  function refuseCommits(): () => number {
    let commits = 0;
    // deno-lint-ignore no-explicit-any
    (runtime as any).edit = (...args: Parameters<Runtime["edit"]>) => {
      const opened: IExtendedStorageTransaction = pristineEdit(...args);
      // deno-lint-ignore no-explicit-any
      (opened as any).commit = () => {
        commits++;
        opened.abort(REFUSAL);
        return createTransactionCommitReceipt(
          Promise.resolve({ error: REFUSAL }),
        );
      };
      return opened;
    };
    return () => commits;
  }

  it("names the builtin and the rejection when the writeback is refused", async () => {
    const tx = runtime.edit();
    const result = runtime.getCell<{ error?: string }>(
      space,
      "settle-writeback-target",
      undefined,
      tx,
    );
    await tx.commit().settled;

    const commits = refuseCommits();
    let wrote = false;
    await settleAbandonedRequest(
      runtime,
      "fetchJson",
      "fetchJson:refused-writeback",
      (settleTx) => {
        wrote = true;
        result.withTx(settleTx).set({ error: "refused" });
      },
    );

    // The write ran and its commit was the thing refused, so the report is
    // about a writeback that was attempted rather than one that never was.
    expect(wrote).toBe(true);
    expect(commits()).toBe(1);
    const [message, detail] = reported[0] ?? [];
    expect(String(message)).toContain("[fetchJson]");
    expect(String(message)).toContain("was rejected");
    expect(detail).toEqual({ rejection: REFUSAL.message });
  });
});

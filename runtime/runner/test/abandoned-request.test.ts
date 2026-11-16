/**
 * How a builtin's abandoned-request ending commits, and what it reports when it
 * cannot land: whether its transaction is attributed to the builtin; under the
 * serving posture, which path it commits through, a completion or a
 * `bookkeeping` stamp, and what it does when the run that staged the request
 * carried no identity; and the report when its own write cannot commit.
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

import {
  type AbandonedRequest,
  settleAbandonedRequest,
} from "../src/builtins/abandoned-request.ts";
import { effectCompletionKeyOf } from "../src/executor/effect-completion.ts";
import { Runtime, type ServerRunInfo } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTransactionCommitReceipt } from "../src/storage/commit-receipt.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();
const requester = { principal: "did:key:requester", sessionId: "session" };

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
      {
        builtinId: "fetchJson",
        effectKey: "fetchJson:refused-writeback",
        identity: undefined,
        scope: "space",
        attributeToBuiltin: true,
      },
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

  for (const attributeToBuiltin of [true, false]) {
    it(`${attributeToBuiltin ? "attributes" : "does not attribute"} the ending's transaction to the builtin when asked ${attributeToBuiltin ? "to" : "not to"}`, async () => {
      let ending: IExtendedStorageTransaction | undefined;
      await settleAbandonedRequest(
        runtime,
        {
          builtinId: "generateText",
          effectKey: "generateText:attribution",
          identity: undefined,
          scope: "space",
          attributeToBuiltin,
        },
        (tx) => {
          ending = tx;
        },
      );

      expect(runtime.cfcEnforcementMode).not.toBe("disabled");
      expect(ending?.getCfcState().implementationIdentity).toEqual(
        attributeToBuiltin
          ? { kind: "builtin", builtinId: "generateText" }
          : undefined,
      );
    });
  }

  it("commits a user-scoped ending without an identity as a completion on a serving runtime without server execution", async () => {
    // No serving loop runs without server execution, so nothing seals into a
    // wave, and the ending commits as it does on a client.

    const servingManager = StorageManager.emulate({ as: signer });
    const serving = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: servingManager,
      servingPosture: true,
      experimental: { serverExecution: false },
    });
    try {
      let ending: IExtendedStorageTransaction | undefined;
      await settleAbandonedRequest(
        serving,
        {
          builtinId: "streamData",
          effectKey: "streamData:unserved",
          identity: undefined,
          scope: "user",
          attributeToBuiltin: true,
        },
        (tx) => {
          ending = tx;
        },
      );

      expect(ending).toBeDefined();
      expect(effectCompletionKeyOf(ending!)).toBe("streamData:unserved");
      expect(reported).toEqual([]);
    } finally {
      await serving.dispose({ closeStorage: false });
      await servingManager.close();
    }
  });

  describe("under the serving posture", () => {
    let servingManager: ReturnType<typeof StorageManager.emulate>;
    let serving: Runtime;
    let stamps: ServerRunInfo[];
    let carriage: boolean;

    beforeEach(() => {
      servingManager = StorageManager.emulate({ as: signer });
      serving = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: servingManager,
        servingPosture: true,
        experimental: { serverExecution: true },
      });
      stamps = [];
      carriage = false;
      // The serving loop's two answers the helper asks for, without a loop:
      // whether the request went out under a carriage it still holds, and
      // what the ending was stamped as.
      serving.hasDispatchedEffectCarriage = () => carriage;
      const stamp = serving.stampServerRun.bind(serving);
      serving.stampServerRun = (tx, info) => {
        stamps.push(info);
        stamp(tx, info);
      };
    });

    afterEach(async () => {
      await serving.dispose({ closeStorage: false });
      await servingManager.close();
    });

    /** Settles an ending for `request` and reports what its transaction was. */
    async function settle(request: Partial<AbandonedRequest>) {
      let ending: IExtendedStorageTransaction | undefined;
      await settleAbandonedRequest(
        serving,
        {
          builtinId: "fetchJson",
          effectKey: "fetchJson:served",
          identity: undefined,
          scope: "space",
          attributeToBuiltin: true,
          ...request,
        },
        (tx) => {
          ending = tx;
        },
      );
      return {
        ending,
        completionKey: ending === undefined
          ? undefined
          : effectCompletionKeyOf(ending),
      };
    }

    it("stamps the ending as a bookkeeping run carrying the identity when no request went out", async () => {
      const { completionKey } = await settle({ identity: requester });

      expect(completionKey).toBeUndefined();
      expect(stamps).toEqual([{
        actionId: "fetchJson/abandoned/fetchJson:served",
        kind: "bookkeeping",
        scopeKeyIdentity: requester,
      }]);
    });

    it("commits the ending as a completion while the request's work runs under its carriage", async () => {
      carriage = true;
      const { completionKey } = await settle({
        identity: requester,
        scope: "user",
      });

      expect(completionKey).toBe("fetchJson:served");
      expect(stamps).toEqual([]);
    });

    it("stamps a space-scoped ending without an identity when the staging run carried none", async () => {
      const { ending } = await settle({});

      expect(ending).toBeDefined();
      expect(stamps).toEqual([{
        actionId: "fetchJson/abandoned/fetchJson:served",
        kind: "bookkeeping",
      }]);
    });

    for (const scope of ["user", "session"] as const) {
      it(`writes nothing and names the builtin for a ${scope}-scoped ending without an identity`, async () => {
        // The wave would resolve the result cells against the service's own
        // session: the service's instance, not the requester's.

        const { ending } = await settle({ scope });

        expect(ending).toBeUndefined();
        expect(stamps).toEqual([]);
        const [message, detail] = reported[0] ?? [];
        expect(String(message)).toContain("[fetchJson]");
        expect(String(message)).toContain("carried no scope-key identity");
        expect(detail).toEqual({ effectKey: "fetchJson:served" });
      });
    }
  });
});

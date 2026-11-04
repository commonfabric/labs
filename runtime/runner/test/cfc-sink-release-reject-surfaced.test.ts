import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import {
  createSinkRequestPolicyInput,
  enqueueSinkRequestPostCommitEffect,
} from "../src/cfc/sink-request.ts";
import type { PostCommitSideEffect } from "../src/cfc/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("inline-sink-release-metrics");

describe("CFC sink-release reject surfacing", () => {
  let storage: EmulatedStorageManager | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    const activeRuntime = runtime;
    const activeStorage = storage;
    runtime = undefined;
    storage = undefined;
    try {
      await activeRuntime?.dispose({ closeStorage: false });
    } finally {
      await activeStorage?.close();
    }
  });

  // A failed release check skips dispatch and reports the refusal through
  // the committed transaction's diagnostics and counters.

  it("notes a release reject on the transaction and skips the send", async () => {
    const request = createFrozenRequestSnapshot({
      url: "https://example.com/release-reject",
    });

    let captured: PostCommitSideEffect | undefined;
    const enqueueTx = {
      enqueuePostCommitEffect: (e: PostCommitSideEffect) => {
        captured = e;
      },
      recordCfcWritePolicyInput: () => {},
    } as unknown as IExtendedStorageTransaction;

    let flushed = false;
    let released = 0;
    let abandoned = false;
    enqueueSinkRequestPostCommitEffect(
      enqueueTx,
      "fetchJson",
      "fetchJson:release-reject",
      request,
      "fetchJson-start",
      () => {
        flushed = true;
      },
      {
        onReleaseRejected: () => released++,
        onRejected: () => abandoned = true,
      },
    );
    expect(captured).toBeDefined();

    // Commit-time policy input carries a DIFFERENT request than the prepared
    // snapshot, so release verification fails.
    const noted: Array<{ sink: string; effectId: string; detail: string }> = [];
    const mismatchingInputs = [
      createSinkRequestPolicyInput(
        "fetchJson",
        "fetchJson:release-reject",
        createFrozenRequestSnapshot({ url: "https://evil.example.com" }),
      ),
    ];
    const committedTx = {
      getCfcState: () => ({
        writePolicyInputs: mismatchingInputs,
        prepare: {
          status: "prepared",
          digest: "x",
          input: { writePolicyInputs: mismatchingInputs },
        },
      }),
      noteCfcSinkReleaseReject: (
        info: { sink: string; effectId: string; detail: string },
      ) => {
        noted.push(info);
      },
    } as unknown as IExtendedStorageTransaction;

    await captured!.flush!(committedTx);

    expect(flushed).toBe(false); // fail-closed: send skipped
    expect(released).toBe(1);
    expect(abandoned).toBe(false);
    expect(noted.length).toBe(1);
    expect(noted[0].sink).toBe("fetchJson");
    expect(noted[0].effectId).toBe("fetchJson:release-reject");
    expect(noted[0].detail).toContain("mismatch");
  });

  for (const refused of [true, false]) {
    it(
      refused
        ? "excludes refused inline sinks from flush counts"
        : "counts a released inline sink once",
      async () => {
        storage = EmulatedStorageManager.emulate({ as: signer });
        runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: storage,
        });
        const tx = runtime.edit();
        const request = createFrozenRequestSnapshot({
          url: "https://example.com/inline-release-metrics",
        });
        const effectId = "fetchJson:inline-release-metrics";
        let dispatched = 0;
        let released = 0;
        enqueueSinkRequestPostCommitEffect(
          tx,
          "fetchJson",
          effectId,
          request,
          "fetchJson-start",
          () => {
            dispatched++;
          },
          { onReleaseRejected: () => released++ },
        );
        tx.prepareCfc();
        const state = tx.getCfcState();
        const prepared = state.prepare;
        if (prepared.status !== "prepared") {
          throw new Error("Expected a prepared sink request");
        }
        using _state = refused
          ? stub(tx, "getCfcState", () => ({
            ...state,
            prepare: {
              ...prepared,
              input: {
                ...prepared.input,
                writePolicyInputs: [
                  createSinkRequestPolicyInput(
                    "fetchJson",
                    effectId,
                    createFrozenRequestSnapshot({
                      url: "https://other.example",
                    }),
                  ),
                ],
              },
            },
          }))
          : undefined;

        expect((await tx.commit().settled).error).toBeUndefined();
        await tx.postCommitEffectsSettled();
        expect(dispatched).toBe(refused ? 0 : 1);
        expect(released).toBe(refused ? 1 : 0);
        expect(runtime.getCfcStats().sinkReleaseRejects).toBe(refused ? 1 : 0);
        expect(runtime.getCfcStats().cfcOutboxFlushes).toBe(refused ? 0 : 1);
      },
    );
  }
});

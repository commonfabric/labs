import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import {
  createSinkRequestPolicyInput,
  enqueueSinkRequestPostCommitEffect,
  verifySinkRequestRelease,
} from "../src/cfc/sink-request.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("test cfc sink request policy");
describe("CFC sink request policy", () => {
  it("accepts matching sink-request policy inputs and rejects mismatches", () => {
    const request = createFrozenRequestSnapshot({
      url: "https://example.com/api",
      options: {
        method: "POST",
        headers: {
          "x-test": "initial",
        },
      },
    });

    const tx = {
      getCfcState: () => ({
        writePolicyInputs: [{
          kind: "sink-request",
          effectId: "fetchJson:abc123",
          sink: "fetchJson",
          request,
        }],
      }),
    } as unknown as {
      getCfcState(): {
        writePolicyInputs: readonly [{
          kind: "sink-request";
          effectId: string;
          sink: string;
          request: typeof request;
        }];
      };
    };

    expect(
      verifySinkRequestRelease(tx, "fetchJson", "fetchJson:abc123", request),
    ).toBeUndefined();

    expect(
      verifySinkRequestRelease(tx, "fetchJson", "fetchJson:abc123", {
        ...request,
        options: {
          ...request.options,
          headers: {
            "x-test": "mutated",
          },
        },
      }),
    ).toContain("mismatch");
  });

  it("deduplicates identical sink requests by idempotency key", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();

    const request = createFrozenRequestSnapshot({
      url: "https://example.com/api",
    });

    let flushCount = 0;
    enqueueSinkRequestPostCommitEffect(
      tx,
      "fetchJson",
      "fetchJson:dedupe",
      request,
      "fetchJson-start",
      () => {
        flushCount++;
      },
    );
    enqueueSinkRequestPostCommitEffect(
      tx,
      "fetchJson",
      "fetchJson:dedupe",
      request,
      "fetchJson-start",
      () => {
        flushCount++;
      },
    );

    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();
    expect(flushCount).toBe(1);

    await runtime.dispose();
    await storageManager.close();
  });

  it("releases sink requests from the prepared snapshot even if live tx state changes later", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();

    const request = createFrozenRequestSnapshot({
      url: "https://example.com/prepared-snapshot",
    });

    let flushCount = 0;
    enqueueSinkRequestPostCommitEffect(
      tx,
      "fetchJson",
      "fetchJson:prepared-snapshot",
      request,
      "fetchJson-start",
      () => {
        flushCount++;
      },
    );

    tx.prepareCfc();

    // Post-prepare tampering with the live tx state is rejected at the
    // source: getCfcState() is a read-only view (#4517), so the swap this
    // test used to simulate never lands — and the prepared snapshot still
    // releases the request.
    const state = tx.getCfcState() as {
      writePolicyInputs: ReturnType<typeof createSinkRequestPolicyInput>[];
    };
    expect(() => {
      state.writePolicyInputs[0] = createSinkRequestPolicyInput(
        "fetchJson",
        "fetchJson:prepared-snapshot",
        createFrozenRequestSnapshot({
          url: "https://example.com/mutated-state",
        }),
      );
    }).toThrow("read-only");

    const result = await tx.commit().settled;
    expect(result.error).toBeUndefined();
    expect(flushCount).toBe(1);

    await runtime.dispose();
    await storageManager.close();
  });

  it("does not double-send sink requests across a retry that aborts before commit", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const request = createFrozenRequestSnapshot({
      url: "https://example.com/retry",
    });

    let flushCount = 0;
    let attempts = 0;

    const result = await runtime.editWithRetry((tx) => {
      attempts++;
      enqueueSinkRequestPostCommitEffect(
        tx,
        "fetchJson",
        "fetchJson:retry-effect",
        request,
        "fetchJson-start",
        () => {
          flushCount++;
        },
      );

      if (attempts === 1) {
        tx.abort("force retry");
      }
    }, 1);

    expect(result.error).toBeUndefined();
    expect(attempts).toBe(2);
    expect(flushCount).toBe(1);

    await runtime.dispose();
    await storageManager.close();
  });
});

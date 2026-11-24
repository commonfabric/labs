import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { gatedSinkRequestExists } from "../../src/cfc/prepare.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { ExtendedStorageTransaction } from "../../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("cfc-gated-sink-request");

/** Records a request to `sink` in `tx`. */
const requestTo = (tx: IExtendedStorageTransaction, sink: string) =>
  tx.recordCfcWritePolicyInput({
    kind: "sink-request",
    effectId: `${sink}:effect`,
    sink,
    request: { url: "https://example.com" },
  });

describe("gatedSinkRequestExists()", () => {
  it("returns `true` once a request goes to a sink with a ceiling, and not before", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcSinkMaxConfidentiality: { fetchJson: [] },
    });
    try {
      const tx = runtime.edit();
      expect(gatedSinkRequestExists(tx)).toBe(false);
      requestTo(tx, "unceilinged");
      expect(gatedSinkRequestExists(tx)).toBe(false);
      requestTo(tx, "fetchJson");
      expect(gatedSinkRequestExists(tx)).toBe(true);
      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("returns `false` for a transaction no runtime gave ceilings", async () => {
    // A runtime sets the ceilings on every transaction it opens. One wrapped
    // around the store directly carries none, so no request it records is
    // gated.
    const storageManager = StorageManager.emulate({ as: signer });
    try {
      const tx = new ExtendedStorageTransaction(storageManager.edit());
      requestTo(tx, "fetchJson");
      expect(tx.getCfcState().writePolicyInputs).toHaveLength(1);
      expect(gatedSinkRequestExists(tx)).toBe(false);
      tx.abort();
    } finally {
      await storageManager.close();
    }
  });
});

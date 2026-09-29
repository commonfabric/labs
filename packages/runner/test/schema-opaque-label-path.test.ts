import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { getCarriedCfcLabelView } from "../src/cfc/label-view-state.ts";
import { Runtime } from "../src/runtime.ts";
import { validateAndTransform } from "../src/schema.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

describe("validateAndTransform()", () => {
  it("keeps opaque carried labels on nested properties literally named value", async () => {
    const signer = await Identity.fromPassphrase("opaque-label-path");
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      storageManager: storage,
      apiUrl: new URL(import.meta.url),
    });
    try {
      const path = [...Array(7).fill("value"), "leaf"];
      const label = { confidentiality: ["private"], integrity: ["author"] };
      const cell = runtime.getCell(signer.did(), "opaque-label-path");
      const projected = validateAndTransform(runtime, runtime.readTx(), {
        link: {
          ...cell.getAsNormalizedFullLink(),
          schema: { type: "object", asCell: ["opaque"] },
        },
        cfcLabelView: { version: 1, entries: [{ path, label }] },
      });
      expect(getCarriedCfcLabelView(projected)).toEqual({
        version: 1,
        entries: [{ path, label }],
      });
    } finally {
      await runtime.dispose({ closeStorage: false });
      await storage.close();
    }
  });
});

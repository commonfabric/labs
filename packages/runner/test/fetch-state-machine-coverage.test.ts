import {
  isPending,
  UNAVAILABLE_PENDING,
} from "@commonfabric/data-model/availability";
import { Identity } from "@commonfabric/identity";
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { fetchText } from "../src/builtins/fetch.ts";
import { computeInputHashFromValue } from "../src/builtins/fetch-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

describe("fetch state-machine edge paths", () => {
  it("retains and monitors a live persisted request claim", async () => {
    const signer = await Identity.fromPassphrase("fetch state-machine");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const setup = runtime.edit();
    const url = "https://example.test/value.txt";
    const inputHash = computeInputHashFromValue({ url });
    const inputs = runtime.getCell<{ url: string }>(
      signer.did(),
      "inputs",
      undefined,
      setup,
    );
    const parent = runtime.getCell(signer.did(), "parent", undefined, setup);
    const cells = Object.fromEntries(
      ["pending", "result", "error", "internal"].map((
        key,
      ) => [
        key,
        runtime.getCell<any>(
          signer.did(),
          { fetchText: { [key]: [] } },
          undefined,
          setup,
        ),
      ]),
    );
    inputs.set({ url });
    cells.pending.set(true);
    cells.result.setRaw(UNAVAILABLE_PENDING);
    cells.internal.set({
      inputHash,
      requestId: "persisted-owner",
      lastActivity: Date.now(),
    });
    await setup.commit().settled;
    const tx = runtime.edit();
    const effects: unknown[] = [];
    tx.enqueuePostCommitEffect = (effect) => {
      effects.push(effect);
    };
    const cancels: Array<() => void> = [];
    let sent: unknown;
    const action = fetchText(
      inputs,
      (_tx, value) => sent = value,
      (cancel) => cancels.push(cancel),
      [],
      parent,
      runtime,
    );

    try {
      action(tx);
      expect(sent).toBeDefined();
      expect(isPending(cells.result.withTx(tx).getRaw())).toBe(true);
      expect(cells.internal.withTx(tx).getRaw()).toMatchObject({
        requestId: "persisted-owner",
      });
      expect(effects).toHaveLength(1);
    } finally {
      cancels.forEach((cancel) => cancel());
      tx.abort();
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

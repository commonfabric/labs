import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const source = await Deno.readTextFile(
  new URL(
    "../../ts-transformers/test/fixtures/closures/map-nested-terminal-captures.input.tsx",
    import.meta.url,
  ),
);

describe("nested array terminal chains", () => {
  it("retains enclosing captures and reacts to their changes", async () => {
    const identity = await Identity.fromPassphrase("nested terminal captures");
    const storage = StorageManager.emulate({ as: identity });
    const errors: unknown[] = [];
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      errorHandlers: [(error) => {
        errors.push(error);
      }],
    });
    let cancel: (() => void) | undefined;
    try {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: source }],
      });
      const tx = runtime.edit();
      const inputs = runtime.getCell<{ groups: string[]; rows: string[] }>(
        identity.did(),
        "inputs",
        undefined,
        tx,
      );
      inputs.set({ groups: ["soil plant"], rows: ["soil plant", "soil"] });
      const result = runtime.run(
        tx,
        compiled,
        inputs,
        runtime.getCell(
          identity.did(),
          "result",
          compiled.resultSchema,
          tx,
        ),
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      cancel = result.sink(() => {});
      expect(await result.pull()).toEqual({ matches: [[2]] });

      const changeGroup = runtime.edit();
      inputs.withTx(changeGroup).key("groups").set(["water"]);
      expect((await changeGroup.commit()).error).toBeUndefined();
      expect(await result.pull()).toEqual({ matches: [[0]] });

      const changeRows = runtime.edit();
      inputs.withTx(changeRows).key("rows").set(["water"]);
      expect((await changeRows.commit()).error).toBeUndefined();
      expect(await result.pull()).toEqual({ matches: [[1]] });

      const clearRows = runtime.edit();
      inputs.withTx(clearRows).key("rows").set([]);
      expect((await clearRows.commit()).error).toBeUndefined();
      expect(await result.pull()).toEqual({ matches: [[]] });
      expect(errors).toEqual([]);
    } finally {
      cancel?.();
      await runtime.dispose({ closeStorage: false });
      await storage.close();
    }
  });
});

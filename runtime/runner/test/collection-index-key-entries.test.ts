import { Identity } from "@commonfabric/identity";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

describe("collection index key entries", () => {
  for (const mode of ["groupBy", "keyBy"] as const) {
    it(`round trips ${mode} primitive and cross-space Cell keys through authored branches`, async () => {
      const signer = await Identity.fromPassphrase("tagged-index-entries");
      const remoteSigner = await Identity.fromPassphrase("tagged-index-remote");
      const storage = StorageManager.emulate({ as: signer });
      let runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      let cancel: (() => void) | undefined;
      try {
        const program = {
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: `
          import {pattern, Writable, Cell} from "commonfabric";
          interface Row {title: string; label: string; owner: Cell<string>; useOwner: boolean}
          export default pattern<{rows: Writable<Row[]>; row: string}>(({rows, row}) => {
            const groups = rows.${mode}(row => row.useOwner ? row.owner : row.label);
            return {checks: groups.keyEntries().map(entry => ({
              kind: entry.kind,
              title: entry.kind === "cell"
                ? ${
              mode === "groupBy"
                ? 'groups.lookup(entry.cell).map(row => row.title).join(",")'
                : "groups.lookup(entry.cell)?.title"
            } + row
                : ${
              mode === "groupBy"
                ? 'groups.lookup(entry.value).map(row => row.title).join(",")'
                : "groups.lookup(entry.value)?.title"
            } + row,
            }))};
          });
        `,
          }],
        };
        const compiled = await runtime.patternManager.compilePattern(program);
        const remoteTx = runtime.edit();
        const remote = runtime.getCell<string>(
          remoteSigner.did(),
          "key",
          undefined,
          remoteTx,
        );
        remote.set("equal");
        expect((await remoteTx.commit().settled).error).toBeUndefined();
        const tx = runtime.edit();
        const local = runtime.getCell<string>(
          signer.did(),
          "key",
          undefined,
          tx,
        );
        local.set("equal");
        const rows = runtime.getCell<
          {
            title: string;
            label: string;
            owner: Cell<string>;
            useOwner: boolean;
          }[]
        >(signer.did(), "rows", undefined, tx);
        const originalRows = [
          { title: "Primitive", label: "equal", owner: local, useOwner: false },
          { title: "Local", label: "equal", owner: local, useOwner: true },
          { title: "Remote", label: "equal", owner: remote, useOwner: true },
        ];
        rows.set(originalRows);
        const result = runtime.run(
          tx,
          compiled,
          { rows, row: "!" },
          runtime.getCell<{ checks: { kind: string; title: string }[] }>(
            signer.did(),
            "result",
            compiled.resultSchema,
            tx,
          ),
        );
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        cancel = result.sink(() => {});
        await runtime.idle();
        const checks = await result.key("checks").pull();
        expect(checks).toHaveLength(3);
        expect(checks[0]).toEqual({ kind: "value", title: "Primitive!" });
        expect(checks.slice(1)).toEqual(expect.arrayContaining([
          { kind: "cell", title: "Local!" },
          { kind: "cell", title: "Remote!" },
        ]));
        const changeContents = runtime.edit();
        local.withTx(changeContents).set("different contents");
        expect((await changeContents.commit().settled).error).toBeUndefined();
        await runtime.idle();
        expect(await result.key("checks").pull()).toEqual(checks);
        const remove = runtime.edit();
        rows.withTx(remove).set([]);
        expect((await remove.commit().settled).error).toBeUndefined();
        await runtime.idle();
        expect(await result.key("checks").pull()).toEqual([]);
        const reinsert = runtime.edit();
        rows.withTx(reinsert).set(originalRows);
        expect((await reinsert.commit().settled).error).toBeUndefined();
        await runtime.idle();
        expect(await result.key("checks").pull()).toEqual(checks);
        await storage.synced();
        const resultLink = result.getAsNormalizedFullLink();
        cancel();
        cancel = undefined;
        runtime.runner.stop(result);
        await runtime.dispose({ closeStorage: false });
        runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: storage,
        });
        await runtime.patternManager.compilePattern(program, {
          space: signer.did(),
        });
        const restored = runtime.getCellFromLink<
          { checks: { kind: string; title: string }[] }
        >(resultLink);
        cancel = restored.sink(() => {});
        expect(await runtime.start(restored)).toBe(true);
        await runtime.idle();
        expect(await restored.key("checks").pull()).toEqual(checks);
      } finally {
        cancel?.();
        await runtime.dispose({ closeStorage: false });
        await storage.close();
      }
    });
  }
});

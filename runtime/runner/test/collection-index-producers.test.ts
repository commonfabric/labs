import { Identity } from "@commonfabric/identity";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { RuntimeTelemetryEvent } from "../src/telemetry.ts";

interface Row {
  /** Displayed field independent of the selected key. */
  title: string;

  /** Primitive key when identity grouping is disabled. */
  label: string;

  /** Identity key without a dependency on its stored text. */
  owner: Cell<string>;

  /** Selects the key domain. */
  useOwner: boolean;
}

describe("collection index producers", () => {
  it("omits bare and fallthrough selector returns when undefined is shadowed", async () => {
    const signer = await Identity.fromPassphrase("index-shadowed-undefined");
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    let cancel: (() => void) | undefined;
    try {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `
          import {pattern, Writable} from "commonfabric";
          export default pattern<{rows: Writable<{label: string}[]>}>(({rows}) => {
            const bare = rows.groupBy((row): undefined => {
              const undefined = row.label;
              return;
            });
            const fallthrough = rows.keyBy((row): undefined => {
              const undefined = row.label;
            });
            return {bare: bare.keys(), fallthrough: fallthrough.keys()};
          });
        `,
        }],
      });
      const tx = runtime.edit();
      const result = runtime.run(
        tx,
        compiled,
        { rows: [{ label: "" }, { label: "A" }] },
        runtime.getCell<{ bare: string[]; fallthrough: string[] }>(
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
      expect(await result.pull()).toEqual({ bare: [], fallthrough: [] });
    } finally {
      cancel?.();
      await runtime.dispose({ closeStorage: false });
      await storage.close();
    }
  });

  it("keeps primitive and Cell keys distinct and preserves a unique winner on reorder", async () => {
    const signer = await Identity.fromPassphrase("authored-index-producers");
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    const cancellations: (() => void)[] = [];
    try {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `
          import { pattern, Writable, Cell } from "commonfabric";
          interface Row { title: string; label: string; owner: Cell<string>; useOwner: boolean }
          export default pattern<{ rows: Writable<Row[]>; owner: Cell<string> }>(({rows, owner}) => {
            const groups = rows.groupBy(row => row.useOwner ? row.owner : row.label);
            const unique = rows.keyBy(row => {
              const label = row.label;
              return label !== "" ? label : undefined;
            });
            return {
              members: groups.lookup(owner).map(row => row.title),
              names: groups.lookup("equal").map(row => row.title),
              winner: unique.lookup("equal")?.title,
            };
          });
        `,
        }],
      });
      let tx = runtime.edit();
      const owner = runtime.getCell<string>(
        signer.did(),
        "owner",
        undefined,
        tx,
      );
      const otherOwner = await Identity.fromPassphrase(
        "index-owner-other-space",
      );
      const otherTx = runtime.edit();
      const other = runtime.getCell<string>(
        otherOwner.did(),
        "owner",
        undefined,
        otherTx,
      );
      other.set("equal");
      expect((await otherTx.commit().settled).error).toBeUndefined();
      owner.set("equal");
      const first = runtime.getCell<Row>(signer.did(), "first", undefined, tx);
      const second = runtime.getCell<Row>(
        signer.did(),
        "second",
        undefined,
        tx,
      );
      const primitive = runtime.getCell<Row>(
        signer.did(),
        "primitive",
        undefined,
        tx,
      );
      first.set({ title: "First", label: "equal", owner, useOwner: true });
      second.set({
        title: "Second",
        label: "equal",
        owner: other,
        useOwner: true,
      });
      primitive.set({
        title: "Primitive",
        label: "equal",
        owner,
        useOwner: false,
      });
      const rows = runtime.getCell<Row[]>(signer.did(), "rows", undefined, tx);
      rows.set([first, second, primitive]);
      const output = runtime.run(
        tx,
        compiled,
        { rows, owner },
        runtime.getCell<
          {
            members: string[];
            names: string[];
            winner: string | undefined;
          }
        >(signer.did(), "result", compiled.resultSchema, tx),
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      cancellations.push(output.sink(() => {}));
      await runtime.idle();
      expect(output.key("members").get()).toEqual(["First"]);
      expect(output.key("names").get()).toEqual(["Primitive"]);
      const winner = output.key("winner").get();
      expect(["First", "Second", "Primitive"]).toContain(winner);
      let writingRuns = 0;
      const collect = (event: Event) => {
        const marker = (event as RuntimeTelemetryEvent).marker;
        if (
          marker.type === "scheduler.run.complete" &&
          marker.actionInfo?.writes?.length
        ) writingRuns++;
      };
      runtime.telemetry.addEventListener("telemetry", collect);
      try {
        tx = runtime.edit();
        owner.withTx(tx).set("changed contents");
        expect((await tx.commit().settled).error).toBeUndefined();
        await runtime.idle();
        expect(output.key("members").get()).toEqual(["First"]);
        expect(writingRuns).toBe(0);
        tx = runtime.edit();
        rows.withTx(tx).set([primitive, second, first]);
        expect((await tx.commit().settled).error).toBeUndefined();
        await runtime.idle();
        expect(output.key("winner").get()).toBe(winner);
        tx = runtime.edit();
        second.withTx(tx).key("owner").set(owner);
        expect((await tx.commit().settled).error).toBeUndefined();
        await runtime.idle();
        expect(output.key("members").get()).toEqual(
          expect.arrayContaining(["First", "Second"]),
        );
        expect(output.key("members").get()).toHaveLength(2);
        expect(writingRuns).toBeGreaterThan(0);
        const winningRow = [first, second, primitive].find((row) =>
          row.key("title").get() === winner
        )!;
        tx = runtime.edit();
        winningRow.withTx(tx).key("label").set("");
        expect((await tx.commit().settled).error).toBeUndefined();
        await runtime.idle();
        expect(output.key("winner").get()).not.toBe(winner);
        expect(
          ["First", "Second", "Primitive"].filter((title) => title !== winner),
        )
          .toContain(output.key("winner").get());
      } finally {
        runtime.telemetry.removeEventListener("telemetry", collect);
      }
    } finally {
      for (const cancel of cancellations) cancel();
      await runtime.dispose({ closeStorage: false });
      await storage.close();
    }
  });
  it("rejects object keys and index-dependent selector callbacks at compilation", async () => {
    const signer = await Identity.fromPassphrase("invalid-index-selectors");
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      for (
        const expression of [
          "rows.groupBy(row => ({label: row.label}))",
          "rows.keyBy((row, index) => index)",
        ]
      ) {
        await expect(runtime.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: `
              import {pattern, Writable} from "commonfabric";
              export default pattern<{rows: Writable<{label: string}[]>}>(({rows}) => {
                return {index: ${expression}};
              });
            `,
          }],
        })).rejects.toThrow(/not assignable/);
      }
    } finally {
      await runtime.dispose({ closeStorage: false });
      await storage.close();
    }
  });
});

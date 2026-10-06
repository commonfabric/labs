import { Identity } from "@commonfabric/identity";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

interface Row {
  /** Key read by the compiled selector. */
  label: string;
  /** Payload consumed from the observed bucket. */
  title: string;
}

/** Compiled producer updates preserve independent lookup demand. */
describe("collection index invalidation", () => {
  for (const method of ["groupBy", "keyBy"] as const) {
    it(`keeps an unrelated ${method} lookup consumer idle and runs it when its bucket changes`, async () => {
      const signer = await Identity.fromPassphrase(
        `index-invalidation-${method}`,
      );
      const storage = EmulatedStorageManager.emulate({ as: signer });
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
          import { pattern, Writable } from "commonfabric";
          interface Row { label: string; title: string }
          export default pattern<{ rows: Writable<Row[]> }>(({ rows }) => {
            const index = rows.${method}(row => row.label);
            return { selected: index.lookup("A"), index };
          });
        `,
          }],
        });
        let consumerRuns = 0;
        const { pattern, lift } = createTrustedBuilder(runtime).commonfabric;
        const observe = lift(({ selected }: { selected?: unknown }) => {
          consumerRuns++;
          return Array.isArray(selected)
            ? selected.length
            : selected === undefined
            ? 0
            : 1;
        }, {
          type: "object",
          properties: { selected: {} },
        }, { type: "number" });
        const observer = pattern<{ selected: unknown }>(({ selected }) =>
          observe({ selected })
        );
        let tx = runtime.edit();
        const first = runtime.getCell<Row>(
          signer.did(),
          "observed-row",
          undefined,
          tx,
        );
        const other = runtime.getCell<Row>(
          signer.did(),
          "unrelated-row",
          undefined,
          tx,
        );
        first.set({ label: "A", title: "Observed" });
        other.set({ label: "B", title: "Other" });
        const rows = runtime.getCell<Row[]>(
          signer.did(),
          "rows",
          undefined,
          tx,
        );
        rows.set([first, other]);
        const producer = runtime.run(
          tx,
          compiled,
          { rows },
          runtime.getCell<{ selected: unknown; index: { keys: string[] } }>(
            signer.did(),
            "producer",
            compiled.resultSchema,
            tx,
          ),
        );
        const output = runtime.run(tx, observer, {
          selected: producer.key("selected"),
        }, runtime.getCell<number>(signer.did(), "observer", undefined, tx));
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        cancel = output.sink(() => {});
        await runtime.settled(Infinity);
        expect(output.get()).toBe(1);
        const row = { label: "A", title: "Observed" };
        expect(producer.key("selected").get()).toEqual(
          method === "groupBy" ? [row] : row,
        );
        expect(consumerRuns).toBeGreaterThan(0);
        consumerRuns = 0;
        tx = runtime.edit();
        // Moving B to a previously absent C changes both unrelated buckets and occupied-key enumeration.
        other.withTx(tx).key("label").set("C");
        expect((await tx.commit().settled).error).toBeUndefined();
        await runtime.settled(Infinity);
        expect(consumerRuns).toBe(0);
        expect(await producer.key("index").key("keys").pull()).toEqual([
          "A",
          "C",
        ]);
        expect(output.get()).toBe(1);
        tx = runtime.edit();
        first.withTx(tx).key("label").set("D");
        expect((await tx.commit().settled).error).toBeUndefined();
        await runtime.settled(Infinity);
        expect(consumerRuns).toBeGreaterThan(0);
        expect(output.get()).toBe(0);
      } finally {
        cancel?.();
        await runtime.dispose({ closeStorage: false });
        await storage.close();
      }
    });
  }
});

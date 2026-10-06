import { Identity } from "@commonfabric/identity";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { RuntimeTelemetryEvent } from "../src/telemetry.ts";

interface Row {
  /** Lookup key shared by several distinct source rows. */
  label: string;

  /** Payload used to validate the selected source. */
  title: string;
}

describe("collection index initialization", () => {
  for (const operator of ["keyBy", "groupBy"] as const) {
    for (const size of [32, 128]) {
      it(`keeps ${operator} initialization within its read budget at ${size} rows`, async () => {
        await using cleanup = new AsyncDisposableStack();
        const identity = await Identity.fromPassphrase(
          `${operator}-index-budget-${size}`,
        );
        const storage = EmulatedStorageManager.emulate({ as: identity });
        cleanup.defer(() => storage.close());
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: storage,
          experimental: { lazyMaterialization: true, serverExecution: false },
        });
        cleanup.defer(() => runtime.dispose({ closeStorage: false }));
        const compiled = await runtime.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: `
            import {pattern, Writable} from "commonfabric";
            export default pattern<{rows:Writable<{label:string;title:string}[]>}>(({rows})=>{
              const index=rows.${operator}(row=>row.label);
              return {value:${
              operator === "keyBy"
                ? 'index.lookup("key-0")?.title'
                : 'index.lookup("key-0").map(row=>row.title)'
            }};
            });
          `,
          }],
        });
        const tx = runtime.edit();
        const cells: Cell<Row>[] = [];
        for (let i = 0; i < size; i++) {
          const cell = runtime.getCell<Row>(
            identity.did(),
            `row-${i}`,
            undefined,
            tx,
          );
          cell.set({ label: `key-${i % 4}`, title: `Row ${i}` });
          cells.push(cell.withTx());
        }
        const rows = runtime.getCell<Row[]>(
          identity.did(),
          "rows",
          undefined,
          tx,
        );
        rows.set(cells);
        let runs = 0;
        let proxyReads = 0;
        const collect = (event: Event) => {
          const marker = (event as RuntimeTelemetryEvent).marker;
          if (marker.type !== "scheduler.run.complete") return;
          runs++;
          proxyReads += marker.reads?.proxyAccesses ?? 0;
        };
        runtime.scheduler.setReadStatsEnabled(true);
        runtime.telemetry.addEventListener("telemetry", collect);
        cleanup.defer(() =>
          runtime.telemetry.removeEventListener("telemetry", collect)
        );
        const result = runtime.run(
          tx,
          compiled,
          { rows },
          runtime.getCell<{ value?: string | string[] }>(
            identity.did(),
            "result",
            compiled.resultSchema,
            tx,
          ),
        );
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        cleanup.defer(result.sink(() => {}));
        await runtime.idle();
        const eligible = Array.from(
          { length: size / 4 },
          (_, i) => `Row ${i * 4}`,
        );
        if (operator === "keyBy") {
          expect(eligible).toContain(result.key("value").get());
        } else {
          expect(result.key("value").get()).toEqual(
            expect.arrayContaining(eligible),
          );
          expect(result.key("value").get()).toHaveLength(eligible.length);
        }
        expect(runs).toBeGreaterThan(size);
        expect(proxyReads).toBeGreaterThan(size);
        expect(proxyReads).toBeLessThanOrEqual(4 * size + 64);
      });
    }
  }
});

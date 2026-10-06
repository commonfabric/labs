// Reports completed action-body reads for equivalent compiled collection loops.

import { Identity } from "@commonfabric/identity";

import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { type RuntimeTelemetryEvent } from "../src/telemetry.ts";

async function report(): Promise<void> {
  for (const size of [32, 128, 512]) {
    for (const mode of ["computed", "lift-wide", "lift-narrow"]) {
      const identity = await Identity.fromPassphrase(
        `collection-loop-${size}-${mode}`,
      );
      const storage = StorageManager.emulate({ as: identity });
      let runtime: Runtime | undefined;
      let cancel: (() => void) | undefined;
      let counts = {
        runs: 0,
        writingRuns: 0,
        proxyAccesses: 0,
        linkResolutions: 0,
        distinctDocuments: 0,
        registeredDependencies: 0,
      };
      const collect = (event: Event) => {
        const marker = (event as RuntimeTelemetryEvent).marker;
        if (marker.type !== "scheduler.run.complete") return;
        counts.runs++;
        if (marker.actionInfo?.writes?.length) counts.writingRuns++;
        if (marker.reads) {
          for (
            const key of [
              "proxyAccesses",
              "linkResolutions",
              "distinctDocuments",
              "registeredDependencies",
            ] as const
          ) counts[key] += marker.reads[key];
        }
      };
      try {
        runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: storage,
        });
        const isComputed = mode === "computed";
        const declaration = isComputed
          ? ""
          : "const sumRows=lift(({rows}: {rows: " +
            (mode === "lift-wide" ? "Row" : "{amount:number}") +
            "[]}) => rows.reduce((sum,row)=>sum+row.amount,0));";
        const body = isComputed
          ? "computed(() => rows.reduce((sum, row) => sum + row.amount, 0))"
          : "sumRows({rows})";
        const compiled = await runtime.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: `
    import {pattern, computed, lift} from "commonfabric";
    interface Row { amount:number; title:string }
    ${declaration}
    export default pattern<{rows:Row[]}>(({rows})=>({value:${body}}));
   `,
          }],
        });
        const tx = runtime.edit();
        const cells: Cell<{ amount: number; title: string }>[] = [];
        for (let i = 0; i < size; i++) {
          const cell = runtime.getCell<{ amount: number; title: string }>(
            identity.did(),
            `row-${i}`,
            undefined,
            tx,
          );
          cell.set({ amount: i, title: `Row ${i}` });
          cells.push(cell.withTx());
        }
        const rows = runtime.getCell<{ amount: number; title: string }[]>(
          identity.did(),
          "rows",
          undefined,
          tx,
        );
        rows.set(cells);
        runtime.scheduler.setReadStatsEnabled(true);
        runtime.telemetry.addEventListener("telemetry", collect);
        const result = runtime.run(
          tx,
          compiled,
          { rows },
          runtime.getCell<{ value: number }>(
            identity.did(),
            "result",
            compiled.resultSchema,
            tx,
          ),
        );
        runtime.prepareTxForCommit(tx);
        if ((await tx.commit().settled).error) {
          throw new Error("Initialization commit failed");
        }
        cancel = result.sink(() => {});
        await runtime.idle();
        const initial = result.key("value").get();
        const expected = size * (size - 1) / 2;
        if (initial !== expected) throw new Error("Incorrect initial sum");
        const steps = [{ phase: "initialize", ...counts }];
        for (const phase of ["unread title", "read amount"]) {
          counts = {
            runs: 0,
            writingRuns: 0,
            proxyAccesses: 0,
            linkResolutions: 0,
            distinctDocuments: 0,
            registeredDependencies: 0,
          };
          const edit = runtime.edit();
          if (phase === "unread title") {
            cells[size - 1].withTx(edit).key("title").set("Updated");
          } else cells[size - 1].withTx(edit).key("amount").set(size);
          if ((await edit.commit().settled).error) {
            throw new Error("Edit commit failed");
          }
          await runtime.idle();
          const value = result.key("value").get();
          if (value !== expected + (phase === "read amount" ? 1 : 0)) {
            throw new Error(`Incorrect sum after ${phase}`);
          }
          steps.push({ phase, ...counts });
        }
        console.log(
          "LOOP_SCALE=" +
            JSON.stringify({
              size,
              mode,
              lazyMaterialization: runtime.experimental.lazyMaterialization,
              steps,
            }),
        );
      } finally {
        runtime?.telemetry.removeEventListener("telemetry", collect);
        try {
          cancel?.();
        } finally {
          try {
            await runtime?.dispose({ closeStorage: false });
          } finally {
            await storage.close();
          }
        }
      }
    }
  }
}

await report().catch((error: unknown) => {
  console.error(error);
  Deno.exitCode = 1;
});

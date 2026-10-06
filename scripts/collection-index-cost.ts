/** Measures completed index action bodies across separate maintenance phases. */
import { Identity } from "@commonfabric/identity";
import { utf8Compare } from "@commonfabric/utils/utf8";
import { expect } from "@std/expect";

import { listElementKeys } from "../packages/runner/src/builtins/list-element-keys.ts";
import type { Cell } from "../packages/runner/src/cell.ts";
import { Runtime } from "../packages/runner/src/runtime.ts";
import { EmulatedStorageManager } from "../packages/runner/src/storage/v2-emulate.ts";
import type { RuntimeTelemetryEvent } from "../packages/runner/src/telemetry.ts";

interface Row {
  label: string;
  title: string;
}

async function main() {
  for (const operator of ["groupBy", "keyBy"] as const) {
    for (const distribution of ["unique", "four-buckets"] as const) {
      for (const size of [32, 128, 512]) {
        await using cleanup = new AsyncDisposableStack();
        const identity = await Identity.fromPassphrase(
          `index-maintenance-${operator}-${distribution}-${size}`,
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
          import { pattern, Writable } from "commonfabric";
          interface Row { label: string; title: string }
          export default pattern<{ rows: Writable<Row[]>; selected: string }>(
            ({ rows, selected }) => {
              const index = rows.${operator}(row => row.label);
              return { value: ${
              operator === "groupBy"
                ? "index.lookup(selected).map(row => row.title)"
                : "index.lookup(selected)?.title"
            } };
            },
          );
          `,
          }],
        });
        const tx = runtime.edit();
        const model: Row[] = Array.from({ length: size }, (_, i) => ({
          label: `key-${distribution === "unique" ? i : i % 4}`,
          title: `Row ${i}`,
        }));
        const cells: Cell<Row>[] = model.map((row, i) => {
          const cell = runtime.getCell<Row>(
            identity.did(),
            `row-${i}`,
            undefined,
            tx,
          );
          cell.set(row);
          return cell.withTx();
        });
        let members = model.map((_, i) => i);
        let selectedKey = "key-0";
        const rows = runtime.getCell<Row[]>(
          identity.did(),
          "rows",
          undefined,
          tx,
        );
        rows.set(cells);
        const selected = runtime.getCell<string>(
          identity.did(),
          "selected",
          undefined,
          tx,
        );
        selected.set(selectedKey);
        const emptyCounts = () => ({
          runs: 0,
          proxyAccesses: 0,
          linkResolutions: 0,
          enumerationRuns: 0,
        });
        let counts = emptyCounts();
        runtime.scheduler.setReadStatsEnabled(true);
        const collect = (event: Event) => {
          const marker = (event as RuntimeTelemetryEvent).marker;
          if (marker.type !== "scheduler.run.complete") return;
          counts.runs++;
          counts.proxyAccesses += marker.reads?.proxyAccesses ?? 0;
          counts.linkResolutions += marker.reads?.linkResolutions ?? 0;
          if (marker.actionId.includes("collectionIndexKeys")) {
            counts.enumerationRuns++;
          }
        };
        runtime.telemetry.addEventListener("telemetry", collect);
        cleanup.defer(() =>
          runtime.telemetry.removeEventListener("telemetry", collect)
        );
        const result = runtime.run(
          tx,
          compiled,
          { rows, selected },
          runtime.getCell<{
            value?: string | string[];
          }>(identity.did(), "result", compiled.resultSchema, tx),
        );
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        cleanup.defer(result.sink(() => {}));
        await runtime.idle();
        const measurements: {
          phase: string;
          runs: number;
          proxyAccesses: number;
          linkResolutions: number;
          enumerationRuns: number;
        }[] = [];
        let previous: string | string[] | undefined;
        const record = (phase: string) => {
          measurements.push({ phase, ...counts });
          const occurrences = listElementKeys(members.map((i) => cells[i]));
          const expected = [...occurrences]
            .filter(([position]) =>
              model[members[position]].label === selectedKey
            )
            .sort((a, b) => utf8Compare(a[1], b[1]))
            .map(([position]) => model[members[position]].title);
          const value = result.key("value").get();
          if (operator === "groupBy") {
            expect(value).toEqual(expected);
          } else expect(value).toBe(expected[0]);
          expect(counts.enumerationRuns).toBe(0);
          if (phase === "membership reorder") expect(value).toEqual(previous);
          previous = typeof value === "string" || value === undefined
            ? value
            : [...value];
          return value;
        };
        const initial = record("initialization");
        const title = typeof initial === "string" ? initial : initial?.[0];
        expect(title).toBeDefined();
        const winner = model.findIndex((row) => row.title === title);
        expect(winner).toBeGreaterThanOrEqual(0);
        for (
          const phase of [
            "unrelated payload",
            "selected payload",
            "selected key",
            "membership insert",
            "membership reorder",
            "membership remove",
            "lookup retarget",
          ] as const
        ) {
          counts = emptyCounts();
          const edit = runtime.edit();
          if (phase === "unrelated payload") {
            cells[1].withTx(edit).key("title").set("Unrelated");
            model[1] = { ...model[1], title: "Unrelated" };
          } else if (phase === "selected payload") {
            cells[winner].withTx(edit).key("title").set("Selected");
            model[winner] = { ...model[winner], title: "Selected" };
          } else if (phase === "selected key") {
            cells[winner].withTx(edit).key("label").set("moved");
            model[winner] = { ...model[winner], label: "moved" };
          } else if (phase === "membership insert") {
            const inserted = { label: "key-0", title: "Inserted" };
            const cell = runtime.getCell<Row>(
              identity.did(),
              "inserted",
              undefined,
              edit,
            );
            cell.set(inserted);
            model.push(inserted);
            cells.push(cell.withTx());
            members.push(size);
            rows.withTx(edit).set(members.map((i) => cells[i]));
          } else if (phase === "membership reorder") {
            members = [...members].reverse();
            rows.withTx(edit).set(members.map((i) => cells[i]));
          } else if (phase === "membership remove") {
            members = members.filter((i) => i !== size);
            rows.withTx(edit).set(members.map((i) => cells[i]));
          } else {
            selectedKey = "key-1";
            selected.withTx(edit).set(selectedKey);
          }
          expect((await edit.commit().settled).error).toBeUndefined();
          await runtime.idle();
          record(phase);
          if (phase === "unrelated payload") expect(counts.runs).toBe(0);
        }
        console.log(
          JSON.stringify({ operator, distribution, size, measurements }),
        );
      }
    }
  }
  console.log("COLLECTION_INDEX_COST_COMPLETE");
}
await main().catch((error) => {
  console.error(error);
  Deno.exitCode = 1;
});

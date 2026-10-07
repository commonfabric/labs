import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import {
  isUnavailable,
  UNAVAILABLE_PENDING,
  UNAVAILABLE_SYNCING,
  unavailableError,
} from "@commonfabric/data-model/availability";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import { resolveLocalProgram } from "../src/harness/local-program.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const rowSchema = {
  type: "array",
  items: {
    type: "object",
    asCell: ["readonly"],
    properties: {
      topic: { asCell: ["comparable"] },
      mentionedBy: { type: "array", items: { asCell: ["comparable"] } },
    },
    required: ["topic", "mentionedBy"],
  },
} as const;

describe("Topics availability", () => {
  for (const nested of [false, true]) {
    it(`preserves stored backlinks while ${nested ? "mention data" : "a source"} is unavailable`, async () => {
      const signer = await Identity.fromPassphrase("topics availability");
      const space = signer.did();
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
      });
      let stopRows = () => {};
      try {
        const program = await resolveLocalProgram(
          (resolver) => runtime.harness.resolve(resolver),
          {
            root: fromFileUrl(new URL("../../patterns/", import.meta.url)),
            main: fromFileUrl(
              new URL("../../patterns/topics/main.tsx", import.meta.url),
            ),
          },
        );
        const main = "/topics-availability-wrapper.tsx";
        const compiled = await runtime.patternManager.compileOrGetPattern({
          ...program,
          main,
          files: [...program.files, {
            name: main,
            contents: `
import { type Default, pattern, type ReadonlyCell } from "commonfabric";
import { crossrefTable, type TopicCrossrefRow } from ${
              JSON.stringify(`.${program.main}`)
            };
import type { TopicMentionSource } from ${
              JSON.stringify(
                `.${program.main.replace(/main\.tsx$/, "topic.tsx")}`,
              )
            };
export default pattern<{
  sources: (ReadonlyCell<TopicMentionSource> | undefined)[];
  values: Default<TopicMentionSource, { mentions: [] }>[];
}, { rows: TopicCrossrefRow[] }>(
  ({ sources, values }) => ({ rows: crossrefTable({ sources, values }) })
);
`,
          }],
        }, space);
        await runtime.patternManager.flushCompileCacheWrites();
        const setup = runtime.edit();
        const source = runtime.getCell<FabricValue>(
          space,
          "mention source",
          undefined,
          setup,
        );
        const target = runtime.getCell<FabricValue>(
          space,
          "mention target",
          undefined,
          setup,
        );
        const sources = runtime.getCell<FabricValue>(
          space,
          "mention sources",
          undefined,
          setup,
        );
        target.set({ mentions: [] });
        source.set({ mentions: [target.getAsLink()] });
        sources.set([
          source.getAsLink(),
          undefined,
          source.getAsLink(),
          target.getAsLink(),
        ]);
        const result = runtime.getCell<{ rows: unknown }>(
          space,
          "mention pivot",
          compiled.resultSchema,
          setup,
        );
        runtime.run(setup, compiled, { sources, values: sources }, result);
        runtime.prepareTxForCommit(setup);
        expect((await setup.commit().settled).error).toBeUndefined();
        const rows = result.withTx().key("rows");
        stopRows = rows.sink(() => {});
        await waitForCellValue(
          runtime,
          rows,
          (value) => Array.isArray(value) && value.length === 2,
        );
        await runtime.idle();
        const handles = rows.asSchema(rowSchema).get();
        expect(handles.length).toBe(2);
        const targetRow = handles[1];
        const retained = () => {
          const row = targetRow.withTx().get();
          expect(row.topic.equals(target.withTx())).toBe(true);
          expect(row.mentionedBy.length).toBe(1);
          expect(row.mentionedBy[0].equals(source.withTx())).toBe(true);
        };
        retained();

        const control = runtime.edit();
        source.withTx(control).set({ mentions: [] });
        runtime.prepareTxForCommit(control);
        expect((await control.commit().settled).error).toBeUndefined();
        await rows.pull({ awaitDurability: true });
        await runtime.idle();
        expect(targetRow.withTx().get().mentionedBy.length).toBe(0);
        const restore = runtime.edit();
        source.withTx(restore).set({ mentions: [target.getAsLink()] });
        runtime.prepareTxForCommit(restore);
        expect((await restore.commit().settled).error).toBeUndefined();
        await rows.pull({ awaitDurability: true });
        await runtime.idle();
        retained();

        for (
          const marker of [
            UNAVAILABLE_PENDING,
            UNAVAILABLE_SYNCING,
            unavailableError("mentions refused", "provider"),
          ]
        ) {
          const tx = runtime.edit();
          source.withTx(tx).set(nested ? { mentions: marker } : marker);
          runtime.prepareTxForCommit(tx);
          expect((await tx.commit().settled).error).toBeUndefined();
          await rows.pull({ awaitDurability: true });
          await runtime.idle();
          const stored = source.withTx().getRaw();
          const current = nested
            ? (stored as { mentions: unknown }).mentions
            : stored;
          retained();
          expect(isUnavailable(current)).toBe(true);
          if (!isUnavailable(current)) {
            throw new Error("Expected native source state");
          }
          expect(current.reason).toBe(marker.reason);
          if (current.reason === "error") {
            expect(current.errorKind).toBe(marker.errorKind);
            expect(current.errorMessage).toBe(marker.errorMessage);
          }
          const unavailableRows = rows.get();
          expect(isUnavailable(unavailableRows)).toBe(true);
          if (!isUnavailable(unavailableRows)) {
            throw new Error("Expected native pivot state");
          }
          expect(unavailableRows.reason).toBe(marker.reason);
          expect(unavailableRows.errorKind).toBe(marker.errorKind);
          expect(unavailableRows.errorMessage).toBe(marker.errorMessage);
        }

        const empty = runtime.edit();
        source.withTx(empty).set({ mentions: [] });
        runtime.prepareTxForCommit(empty);
        expect((await empty.commit().settled).error).toBeUndefined();
        await rows.pull({ awaitDurability: true });
        await runtime.idle();
        expect(Array.isArray(rows.get())).toBe(true);
        expect(targetRow.withTx().get().mentionedBy.length).toBe(0);

        const recovery = runtime.edit();
        source.withTx(recovery).set({ mentions: [target.getAsLink()] });
        runtime.prepareTxForCommit(recovery);
        expect((await recovery.commit().settled).error).toBeUndefined();
        await rows.pull({ awaitDurability: true });
        await runtime.idle();
        expect((rows.get() as unknown[]).length).toBe(2);
        retained();
      } finally {
        stopRows();
        await runtime.dispose();
        await storageManager.close();
      }
    });
  }
});

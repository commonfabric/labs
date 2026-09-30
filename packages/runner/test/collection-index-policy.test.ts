import { Identity } from "@commonfabric/identity";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { cfcLabelViewForResolvedCellWithStatus } from "../src/cfc/label-view.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

describe("collection index confidentiality", () => {
  for (const operator of ["groupBy", "keyBy"] as const) {
    for (const initialCategory of ["A", "B"]) {
      it(`carries a confidential ${operator} selector into lookup A when its source starts at ${initialCategory}`, async () => {
        const signer = await Identity.fromPassphrase("index-confidentiality");
        const storage = StorageManager.emulate({ as: signer });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: storage,
          cfcEnforcementMode: "enforce-strict",
          cfcFlowLabels: "persist",
        });
        let cancel: (() => void) | undefined;
        try {
          const compiled = await runtime.patternManager.compilePattern({
            main: "/main.tsx",
            files: [{
              name: "/main.tsx",
              contents: `
            import {pattern, Writable} from "commonfabric";
            export default pattern<{rows: Writable<{title: string; category: string}[]>}>(({rows}) => {
              const index = rows.${operator}(row => row.category);
              return {keys: index.keys(), titles: ${
                operator === "groupBy"
                  ? 'index.lookup("A").map(row => row.title)'
                  : '[index.lookup("A")?.title]'
              }, present: ${
                operator === "groupBy"
                  ? 'index.lookup("A").length > 0'
                  : 'index.lookup("A") !== undefined'
              }};
            });
          `,
            }],
          });
          const seed = runtime.edit();
          const rows = runtime.getCell<{ title: string; category: string }[]>(
            signer.did(),
            "rows",
            undefined,
            seed,
          );
          writeSeedEnvelopeDoc(seed, signer.did());
          seedStoredEnvelope(seed, rows.getAsNormalizedFullLink(), {
            value: [{ title: "First", category: initialCategory }],
            cfc: {
              version: 1,
              schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
              labelMap: {
                version: 1,
                entries: [{
                  path: ["0", "category"],
                  label: { confidentiality: ["private-category"] },
                }],
              },
            },
          });
          expect((await seed.commit()).error).toBeUndefined();
          const tx = runtime.edit();
          const output = runtime.run(
            tx,
            compiled,
            { rows: rows.withTx() },
            runtime.getCell<
              { titles: string[]; present: boolean; keys: string[] }
            >(
              signer.did(),
              "result",
              compiled.resultSchema,
              tx,
            ),
          );
          runtime.prepareTxForCommit(tx);
          expect((await tx.commit()).error).toBeUndefined();
          cancel = output.sink(() => {});
          await runtime.idle();
          expect(await output.key("titles").pull()).toEqual(
            initialCategory === "A"
              ? ["First"]
              : operator === "groupBy"
              ? []
              : [undefined],
          );
          expect(output.key("present").get()).toBe(initialCategory === "A");
          expect(await output.key("keys").pull()).toEqual([initialCategory]);
          const keysLabel = cfcLabelViewForResolvedCellWithStatus(
            output.key("keys"),
          );
          expect(
            (keysLabel.view?.entries ?? []).flatMap((entry) =>
              entry.label.confidentiality ?? []
            ),
          )
            .toContain("private-category");
          const { view } = cfcLabelViewForResolvedCellWithStatus(
            output.key("present"),
          );
          expect(
            (view?.entries ?? []).flatMap((entry) =>
              entry.label.confidentiality ?? []
            ),
          )
            .toContain("private-category");
          const edit = runtime.edit();
          rows.withTx(edit).key(0).key("category").set("B");
          runtime.prepareTxForCommit(edit);
          expect((await edit.commit()).error).toBeUndefined();
          await runtime.idle();
          expect(await output.key("titles").pull()).toEqual(
            operator === "groupBy" ? [] : [undefined],
          );
          expect(output.key("present").get()).toBe(false);
          const missing = cfcLabelViewForResolvedCellWithStatus(
            output.key("present"),
          );
          expect(
            (missing.view?.entries ?? []).flatMap((entry) =>
              entry.label.confidentiality ?? []
            ),
          )
            .toContain("private-category");
        } finally {
          cancel?.();
          await runtime.dispose({ closeStorage: false });
          await storage.close();
        }
      });
    }
  }
});

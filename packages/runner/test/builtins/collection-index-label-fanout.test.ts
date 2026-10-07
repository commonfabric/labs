import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { collectionKeyBucket } from "../../src/builtins/collection-index-key.ts";
import type { MaintainedCollectionIndex } from "../../src/builtins/collection-index-membership.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";

/**
 * Every member of a collection index writes into one shared index document,
 * and each write stamps that document's CFC label map. A member that resolves
 * the index and state documents as ordinary dependencies then wakes on every
 * other member's stamp, so one added source element re-runs every member the
 * index already has. The sources must carry labels for the stamps to exist,
 * which is why an unlabeled fixture never shows this.
 */
describe("collection-index-label-fanout", () => {
  for (const method of ["groupBy", "keyBy"] as const) {
    it(`a ${method} member does not re-run when another member's write stamps the index`, async () => {
      const signer = await Identity.fromPassphrase(
        `index-label-fanout-${method}`,
      );
      const space = signer.did();
      const storage = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager: storage,
        cfcFlowLabels: "persist",
      });
      let cancel: (() => void) | undefined;
      try {
        const compiled = await runtime.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: `
              import { pattern, Writable } from "commonfabric";
              export default pattern<{rows: Writable<{label: string}[]>}>(({rows}) => {
                const index = rows.${method}(row => row.label);
                return {index, selected: index.lookup("a")};
              });`,
          }],
        });
        const rows = runtime.getCell<{ label: string }[]>(space, "rows");
        const rowLinks: unknown[] = [];
        /** Appends a labeled row; the label is what makes member writes stamp the index. */
        const addRow = async (cause: string, label: string) => {
          const seed = runtime.edit();
          const row = runtime.getCell<{ label: string }>(
            space,
            cause,
            undefined,
            seed,
          );
          const id = row.getAsNormalizedFullLink().id;
          writeSeedEnvelopeDoc(seed, space);
          seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
            value: { label },
            cfc: {
              version: 1,
              schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
              labelMap: {
                version: 1,
                entries: [{
                  path: [],
                  label: { confidentiality: ["row-secret"] },
                }],
              },
            },
          });
          rowLinks.push({ "/": { "link@1": { id, path: [] } } });
          seedStoredEnvelope(seed, {
            space,
            scope: "space",
            id: rows.getAsNormalizedFullLink().id,
            path: [],
          }, {
            value: rowLinks as never,
            cfc: {
              version: 1,
              schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
              labelMap: { version: 1, entries: [] },
            },
          });
          expect((await seed.commit().settled).error).toBeUndefined();
          await runtime.idle();
        };
        await addRow("row-0", "a");
        await addRow("row-1", "b");
        await addRow("row-2", "c");
        const tx = runtime.edit();
        const result = runtime.run(
          tx,
          compiled,
          { rows },
          runtime.getCell<
            { index: MaintainedCollectionIndex; selected: unknown }
          >(space, "result", compiled.resultSchema, tx),
        );
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        cancel = result.key("selected").sink(() => {});
        await runtime.idle();
        /** Run count per member action, keyed by the action's node id. */
        const memberRuns = () =>
          new Map(
            runtime.scheduler.getGraphSnapshot().nodes
              .filter((node) =>
                node.id.startsWith("raw:collectionIndexMember:")
              )
              .map((node) => [node.id, node.stats?.runCount ?? 0] as const),
          );
        const index = result.key("index").resolveAsCell();
        const indexId = index.getAsNormalizedFullLink().id;
        type Stamp = { path: string[]; label: { confidentiality?: unknown[] } };
        /** The label-map entries the member writes have left on the index document. */
        const stamps = (): Stamp[] => {
          const replica = (storage.open(space) as unknown as {
            replica: {
              getDocument(
                id: string,
              ): { cfc?: { labelMap?: { entries: Stamp[] } } } | undefined;
            };
          }).replica;
          return replica.getDocument(indexId)?.cfc?.labelMap?.entries ?? [];
        };
        /** Every stamp on `label`'s bucket carries the source row's secret. */
        const expectBucketKeepsSecret = (label: string) => {
          const bucket = collectionKeyBucket({ kind: "string", value: label });
          const onBucket = stamps().filter((stamp) =>
            stamp.path[0] === "buckets" && stamp.path[1] === bucket
          );
          expect(onBucket.length).toBeGreaterThan(0);
          for (const stamp of onBucket) {
            expect(stamp.label.confidentiality).toContain("row-secret");
          }
        };
        const before = memberRuns();
        expect(before.size).toBe(3);
        // The fixture is only a reproduction when the writes stamp the index.
        expect(stamps().length).toBeGreaterThan(0);
        await addRow("row-3", "d");
        await addRow("row-4", "e");
        // The machinery-read scope changes scheduling only: the stamps the
        // members leave still carry the source rows' labels, on the buckets
        // present before the additions and on the ones they created.
        for (const label of ["a", "b", "c", "d", "e"]) {
          expectBucketKeepsSecret(label);
        }
        const after = memberRuns();
        expect(after.size).toBe(5);
        // The three original members did not run again; the two new members
        // each ran, and the stamps their writes left on the index woke no one.
        for (const [id, runs] of before) {
          expect([id, after.get(id)]).toEqual([id, runs]);
        }
        for (const [id, runs] of after) {
          if (!before.has(id)) expect([id, runs]).toEqual([id, 1]);
        }
        expect(result.key("selected").get()).toEqual(
          method === "groupBy" ? [{ label: "a" }] : { label: "a" },
        );
      } finally {
        cancel?.();
        await storage.synced();
        await runtime.dispose({ closeStorage: false });
        await storage.close();
      }
    });
  }
});

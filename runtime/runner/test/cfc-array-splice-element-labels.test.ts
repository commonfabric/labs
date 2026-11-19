import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-splice-element-labels",
);
const space = signer.did();

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
};

describe("CFC: per-element label entries when an array of plain values is spliced", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const entriesOf = (id: string): StoredEntry[] => {
    const replica = storageManager!.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: StoredEntry[] } };
      } | undefined;
    };
    return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  };

  const confidentialityAt = (id: string, path: string[]): string[] =>
    entriesOf(id)
      .filter((entry) => JSON.stringify(entry.path) === JSON.stringify(path))
      .flatMap((entry) => entry.label.confidentiality ?? []);

  // The array diff (`normalizeAndDiff` in `src/data-updating.ts`) writes
  // only the positions whose value changed, and the persist step of
  // `prepareBoundaryCommit` in `src/cfc/prepare.ts` replaces the derived
  // entries at and below a written path alone. After the first of three
  // plain values is removed, the value at position 1 is the one that was at
  // position 2 and is equal to the one that was at position 1: the diff does
  // not write position 1, which keeps the entry of the value that was
  // there, and the entry of the value that moved there is dropped with the
  // truncated position 2. Per-element entries are not moved with their
  // elements.
  it.ignore("labels each element that moved with the entries it had", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "persist",
    });
    const seed = runtime.edit();
    const id = runtime.getCell(space, "splice-list", undefined, seed)
      .getAsNormalizedFullLink().id;
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
      value: ["x", "y", "y"],
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [
            {
              path: ["1"],
              label: { confidentiality: ["alice-secret"] },
              origin: "derived",
              observes: "value",
            },
            {
              path: ["2"],
              label: { confidentiality: ["bob-secret"] },
              origin: "derived",
              observes: "value",
            },
          ],
        },
      },
    });
    expect((await seed.commit().settled).ok).toBeDefined();
    expect(confidentialityAt(id, ["2"])).toEqual(["bob-secret"]);

    // The writer reads every element, so its join holds both clauses.
    const remove = runtime.edit();
    const list = runtime.getCell(space, "splice-list", undefined, remove);
    list.get();
    list.set(["y", "y"]);
    expect((await remove.commit().settled).ok).toBeDefined();

    // The element now at position 1 is the one that carried `bob-secret`.
    expect(confidentialityAt(id, ["1"])).toContainEqual("bob-secret");
  });
});

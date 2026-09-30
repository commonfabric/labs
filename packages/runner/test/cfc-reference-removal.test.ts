import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import {
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";

import { normalizeClause } from "../src/cfc/clause.ts";
import { getCfcReferenceProvenance } from "../src/cfc/reference-provenance.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-reference-removal");
const space = signer.did();
const selection = normalizeClause({
  anyOf: ["selection", cfcAtom.space(space)],
});
const content = normalizeClause({ anyOf: ["content", cfcAtom.space(space)] });

describe("cfc-reference-removal", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    resetModernCellRepConfig();
    await storage.synced();
    await runtime.dispose();
    await storage.close();
  });

  async function seed(
    cause: string,
    value: FabricValue,
    entries: LabelMapEntry[] = [],
  ) {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, cause, undefined, tx);
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, { ...cell.getAsNormalizedFullLink(), path: [] }, {
      value,
      cfc: {
        version: 3,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries },
      },
    });
    expect((await tx.commit()).ok).toBeDefined();
    return cell.withTx(undefined);
  }

  for (
    const [modern, nested] of [[false, false], [false, true], [true, false], [
      true,
      true,
    ]]
  ) {
    it(`retains a surviving reference's selection without copying target content labels (modern=${modern}, nested=${nested})`, async () => {
      setModernCellRepConfig(modern);
      const target = await seed("target", "private content", [{
        path: [],
        observes: "value",
        label: { confidentiality: [content] },
      }]);
      const item = nested ? { item: target.getAsLink() } : target.getAsLink();
      const slotPath = nested ? ["1", "item"] : ["1"];
      const list = (await seed("list", ["remove", item], [{
        path: slotPath,
        origin: "link",
        observes: "followRef",
        referenceAcquisition: "complete",
        label: { confidentiality: [selection] },
      }])).asSchema({ type: "array", items: {} });
      const remove = runtime.edit();
      list.withTx(remove).removeByValue("remove");
      expect((await remove.commit()).ok).toBeDefined();

      const read = runtime.edit();
      const survivor = list.withTx(read).key(
        ...(nested ? ["0", "item"] : ["0"]),
      )
        .resolveAsCell();
      const acquired = getCfcReferenceProvenance(survivor);
      expect(acquired?.confidentiality).toContainEqual(selection);
      expect(acquired?.confidentiality).not.toContainEqual(content);
      expect(survivor.get()).toBe("private content");
      expect(list.withTx(read).key("length").get()).toBe(1);
      read.abort();
    });
  }

  it("refuses to invent acquisition history for an unproven surviving slot", async () => {
    const target = await seed("unproven-target", "value");
    const list = (await seed("unproven-list", ["remove", target.getAsLink()]))
      .asSchema({ type: "array", items: {} });
    const remove = runtime.edit();
    expect(() => list.withTx(remove).removeByValue("remove")).toThrow(
      "Reference acquisition lacks complete legacy provenance",
    );
    remove.abort();
  });
});

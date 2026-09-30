import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { FabricValue } from "@commonfabric/data-model";

import { when } from "../../src/builtins/when.ts";
import { unless } from "../../src/builtins/unless.ts";
import type { Cell } from "../../src/cell.ts";
import { deriveFlowJoin } from "../../src/cfc/prepare.ts";
import type { LabelMapEntry } from "../../src/cfc/types.ts";
import {
  carryCfcReferenceProvenance,
  getCfcReferenceProvenance,
} from "../../src/cfc/reference-provenance.ts";
import { parseLink } from "../../src/link-utils.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("conditional-reference");
const space = signer.did();
const selection = "private-branch-selection";

describe("conditional-reference", () => {
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
    await storage.synced();
    await runtime.dispose();
    await storage.close();
  });

  const seedValue = async (
    cause: string,
    value: FabricValue,
    entries: LabelMapEntry[] = [],
  ) => {
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
  };

  for (const [name, builtin] of [["when", when], ["unless", unless]] as const) {
    it(`retains ${name} immutable branch history across transaction aborts`, async () => {
      const seed = runtime.edit();
      const target = runtime.getCell(space, "target", undefined, seed);
      const selected = runtime.getCell(space, "selected", undefined, seed);
      writeSeedEnvelopeDoc(seed, space);
      seedStoredEnvelope(seed, {
        ...target.getAsNormalizedFullLink(),
        path: [],
      }, {
        value: "visible",
        cfc: {
          version: 3,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: { version: 1, entries: [] },
        },
      });
      seedStoredEnvelope(seed, {
        ...selected.getAsNormalizedFullLink(),
        path: [],
      }, {
        value: target.getAsLink(),
        cfc: {
          version: 3,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              origin: "link",
              observes: "followRef",
              referenceAcquisition: "complete",
              label: { confidentiality: [selection] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();
      const acquisition = runtime.edit();
      const held = selected.withTx(acquisition).resolveAsCell();
      const branch = runtime.getImmutableCell(space, { candidate: held });
      const inputs = runtime.getImmutableCell(space, {
        condition: name === "when",
        value: branch,
        fallback: branch,
      });
      acquisition.abort();

      const tx = runtime.edit();
      const parent = runtime.getCell(space, "owner", undefined, tx);
      let output: Cell<any> | undefined;
      const action = builtin(
        inputs as Cell<any>,
        (_tx, result) => {
          output = result;
        },
        () => {},
        {
          inputs,
          parents: parent.entityId,
          outputSpot: parent.getAsNormalizedFullLink(),
        },
        parent,
        runtime,
      );
      action(tx);
      const candidateSlot = output!.withTx(tx).key("candidate");
      const raw = candidateSlot.getRawUntyped();
      const parsed = parseLink(raw, candidateSlot);
      if (parsed === undefined) {
        throw new Error("Expected a candidate reference");
      }
      const reference = carryCfcReferenceProvenance(
        raw,
        parsed,
      );
      tx.abort();

      const read = runtime.edit();
      const candidate = runtime.getCellFromLink(reference, undefined, read);
      expect(getCfcReferenceProvenance(candidate)?.confidentiality)
        .toContain(selection);
      expect(candidate.get()).toBe("visible");
      expect(deriveFlowJoin(read).confidentiality).toContain(selection);
      read.abort();
    });

    it(`keeps ${name} references to inline array items live`, async () => {
      const seed = runtime.edit();
      const source = runtime.getCell<any[]>(space, "source", undefined, seed);
      source.set([{ text: "before" }]);
      expect((await seed.commit()).ok).toBeDefined();
      const inputs = runtime.getImmutableCell(space, {
        condition: name === "when",
        value: source.withTx(undefined).key("0"),
        fallback: source.withTx(undefined).key("0"),
      });
      const tx = runtime.edit();
      const parent = runtime.getCell(space, "owner", undefined, tx);
      let output: Cell<any> | undefined;
      const action = builtin(
        inputs as Cell<any>,
        (_tx, result) => {
          output = result;
        },
        () => {},
        {
          inputs,
          parents: parent.entityId,
          outputSpot: parent.getAsNormalizedFullLink(),
        },
        parent,
        runtime,
      );
      action(tx);
      expect((await tx.commit()).ok).toBeDefined();
      const update = runtime.edit();
      source.withTx(update).key("0", "text").set("after");
      expect((await update.commit()).ok).toBeDefined();
      const read = runtime.edit();
      expect(output!.withTx(read).key("text").get()).toBe("after");
      read.abort();
    });

    it(`retains ${name} condition confidentiality on a held public result`, async () => {
      const target = await seedValue("condition-target", name === "when");
      const selected = await seedValue(
        "condition-selected",
        target.getAsLink(),
        [
          {
            path: [],
            origin: "link",
            observes: "followRef",
            referenceAcquisition: "complete",
            label: { confidentiality: [selection] },
          },
        ],
      );
      const value = await seedValue("public-value", "visible");
      const acquisition = runtime.edit();
      const inputs = runtime.getImmutableCell(space, {
        condition: selected.withTx(acquisition).resolveAsCell(),
        value,
        fallback: value,
      });
      acquisition.abort();

      const tx = runtime.edit();
      const parent = runtime.getCell(space, "owner", undefined, tx);
      let output: Cell<any> | undefined;
      const action = builtin(
        inputs as Cell<any>,
        (_tx, result) => {
          output = result;
        },
        () => {},
        {
          inputs,
          parents: parent.entityId,
          outputSpot: parent.getAsNormalizedFullLink(),
        },
        parent,
        runtime,
      );
      action(tx);
      const held = output!.withTx(tx).resolveAsCell().withTx(undefined);
      tx.abort();

      const read = runtime.edit();
      expect(held.withTx(read).get()).toBe("visible");
      expect(getCfcReferenceProvenance(held)?.confidentiality)
        .toContain(selection);
      expect(deriveFlowJoin(read).confidentiality).toContain(selection);
      read.abort();
    });
  }
});

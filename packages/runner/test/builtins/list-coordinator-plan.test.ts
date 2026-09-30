import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import { listSlotResolutions } from "../../src/builtins/list-coordinator-plan.ts";
import { deriveFlowJoin } from "../../src/cfc/prepare.ts";
import { getCfcReferenceProvenance } from "../../src/cfc/reference-provenance.ts";
import type { LabelMapEntry } from "../../src/cfc/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("list-coordinator-plan");
const space = signer.did();
const selection = "private-list-selection";

describe("list-coordinator-plan", () => {
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
    await runtime.dispose({ closeStorage: false });
    await storage.close();
  });

  const seed = async (
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

  it("retains nested immutable slot references after aborting the plan transaction", async () => {
    const target = await seed("target", "visible");
    const selected = await seed("selected", target.getAsLink(), [{
      path: [],
      origin: "link",
      observes: "followRef",
      referenceAcquisition: "complete",
      label: { confidentiality: [selection] },
    }]);
    const acquisition = runtime.edit();
    const held = selected.withTx(acquisition).resolveAsCell();
    acquisition.abort();

    const planning = runtime.edit();
    const inner = runtime.getImmutableCell(
      space,
      { candidate: held },
      undefined,
      planning,
    );
    const list = runtime.getImmutableCell(space, [inner], undefined, planning);
    const inputs = runtime.getImmutableCell(
      space,
      { list },
      undefined,
      planning,
    );
    const { slots } = listSlotResolutions(runtime, planning, inputs);
    expect(slots[0].id).toBe(inner.getAsNormalizedFullLink().id);
    planning.abort();

    const read = runtime.edit();
    const item = runtime.getCellFromLink(slots[0], undefined, read);
    expect((item.get() as { candidate: string }).candidate).toBe("visible");
    expect(deriveFlowJoin(read).confidentiality).toContain(selection);
    read.abort();
  });

  it("retains persisted slot selection after aborting the plan transaction", async () => {
    const target = await seed("target", "visible");
    const list = await seed("list", [target.getAsLink()], [{
      path: ["0"],
      origin: "link",
      observes: "followRef",
      referenceAcquisition: "complete",
      label: { confidentiality: [selection] },
    }]);
    const planning = runtime.edit();
    const inputs = runtime.getImmutableCell(
      space,
      { list },
      undefined,
      planning,
    );
    const { slots } = listSlotResolutions(runtime, planning, inputs);
    planning.abort();

    const read = runtime.edit();
    const item = runtime.getCellFromLink(slots[0], undefined, read);
    expect(getCfcReferenceProvenance(item)?.confidentiality).toContain(
      selection,
    );
    expect(item.get()).toBe("visible");
    expect(deriveFlowJoin(read).confidentiality).toContain(selection);
    read.abort();
  });

  it("keeps inline slot identities rooted in the original list", async () => {
    const list = await seed("list", [{ value: "first" }, { value: "second" }]);
    const planning = runtime.edit();
    const inputs = runtime.getImmutableCell(
      space,
      { list },
      undefined,
      planning,
    );
    const { slots } = listSlotResolutions(runtime, planning, inputs);
    expect(slots.map(({ id, path }) => ({ id, path }))).toEqual([
      { id: list.getAsNormalizedFullLink().id, path: ["0"] },
      { id: list.getAsNormalizedFullLink().id, path: ["1"] },
    ]);
    planning.abort();
  });
});

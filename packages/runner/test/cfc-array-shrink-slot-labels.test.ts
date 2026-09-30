import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("runner-cfc-shrink-slot-labels");
const space = signer.did();

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
  observes?: string;
};

describe("CFC: array shrink clears truncated slots' link labels", () => {
  // An array-diff shrink truncates slots by writing `length` alone; without an
  // explicit delete write per truncated slot, the removed slots' per-slot link
  // entries survive in the labelMap. Any later read/diff of such a slot (e.g. a
  // list growing back) consumes the stale entry as a followRef observation
  // (SC-8) and re-imports the departed member's taint into the reader's flow
  // join. The array diff emits an explicit delete per truncated slot, ahead of
  // the length write, and the flow-clear drops the stale entries like any
  // other covered write.

  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const seedLabeledDoc = async (
    rt: Runtime,
    cause: string,
    value: FabricValue,
    atom: string,
  ): Promise<string> => {
    const seed = rt.edit();
    const cell = rt.getCell(space, cause, undefined, seed);
    const id = cell.getAsNormalizedFullLink().id;
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, {
      space,
      scope: "space",
      id,
      path: [],
    }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: [], label: { confidentiality: [atom] } }],
        },
      },
    });
    expect((await seed.commit()).ok).toBeDefined();
    return id;
  };

  const entriesOf = (id: string): StoredEntry[] => {
    const replica = storageManager!.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: StoredEntry[] } };
      } | undefined;
    };
    return replica!.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  };

  const linkConfidentialityAt = (id: string, slot: string): string[] =>
    entriesOf(id)
      .filter((e) =>
        e.origin === "link" && e.path.length === 1 &&
        e.path[0] === slot
      )
      .flatMap((e) => e.label.confidentiality ?? []);

  const lengthValueConfidentiality = (id: string): string[] =>
    entriesOf(id)
      .filter((e) =>
        e.origin === "derived" && e.observes === "value" &&
        e.path.length === 1 && e.path[0] === "length"
      )
      .flatMap((e) => e.label.confidentiality ?? []);

  it("drops truncated link entries and retains survivor selection history", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // At this rung the writer-fit check flags a tainted write to a store
      // that declares no ceiling and lets it land. This list declares none,
      // and the closing `length` assertion reads back the label that write
      // persisted.
      cfcEnforcementMode: "observe",
      // Persisting flow labels is what puts the per-slot link entries and the
      // derived `length` entry in the document. Every assertion here reads
      // one of them.
      cfcFlowLabels: "persist",
    });

    await seedLabeledDoc(runtime, "shrink-el-0", { n: 1 }, "alice-secret");
    await seedLabeledDoc(runtime, "shrink-el-1", { n: 2 }, "bob-secret");
    await seedLabeledDoc(runtime, "shrink-el-2", { n: 3 }, "carol-secret");

    const listSchema = {
      type: "array",
      items: { asCell: ["cell"] },
    } as const;

    const setup = runtime.edit();
    const el0 = runtime.getCell(space, "shrink-el-0", undefined, setup);
    const el1 = runtime.getCell(space, "shrink-el-1", undefined, setup);
    const listCell = runtime.getCell(space, "shrink-list", listSchema, setup);
    listCell.set([el0, el1]);
    expect((await setup.commit()).ok).toBeDefined();

    const listId = listCell.getAsNormalizedFullLink().id;
    // Seed historical selection labels independently of target contents.
    // Truncation must clear these reference restrictions even when new
    // reference writes no longer copy the targets' labels.
    const selections = runtime.edit();
    writeSeedEnvelopeDoc(selections, space);
    seedStoredEnvelope(selections, {
      space,
      scope: "space",
      id: listId,
      path: [],
    }, {
      value: selections.readValueOrThrow(listCell.getAsNormalizedFullLink()),
      cfc: {
        version: 3,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [
            {
              path: ["0"],
              origin: "link",
              observes: "followRef",
              referenceAcquisition: "complete",
              label: { confidentiality: ["alice-secret"] },
            },
            {
              path: ["1"],
              origin: "link",
              observes: "followRef",
              referenceAcquisition: "complete",
              label: { confidentiality: ["bob-secret"] },
            },
          ],
        },
      },
    });
    expect((await selections.commit()).ok).toBeDefined();
    // Both slots carry their independently recorded selection labels.
    expect(linkConfidentialityAt(listId, "0")).toEqual(["alice-secret"]);
    expect(linkConfidentialityAt(listId, "1")).toEqual(["bob-secret"]);

    // Shrink: bob's slot is truncated by the array diff (a `length` write —
    // slot 1 itself is not overwritten by any surviving element).
    const shrinkTx = runtime.edit();
    const lc = runtime.getCell(space, "shrink-list", listSchema, shrinkTx);
    lc.set([lc.get()[0]]);
    expect((await shrinkTx.commit()).ok).toBeDefined();

    // Reselecting the surviving identity records the shrink transaction's
    // container observations even when the serialized reference is unchanged.
    expect(linkConfidentialityAt(listId, "0").sort()).toEqual([
      "alice-secret",
      "bob-secret",
    ]);
    // The truncated slot's stale entry is the echo carrier — it must go.
    expect(linkConfidentialityAt(listId, "1")).toEqual([]);

    // Growth reuses the slot. Its selection includes the current container
    // observations, whose history is independent of the cleared link entry.
    const growTx = runtime.edit();
    const el2 = runtime.getCell(space, "shrink-el-2", undefined, growTx);
    el2.get(); // a content read: carol joins the growing tx's flow join
    const lc2 = runtime.getCell(space, "shrink-list", listSchema, growTx);
    lc2.set([lc2.get()[0], el2]);
    expect((await growTx.commit()).ok).toBeDefined();

    expect(linkConfidentialityAt(listId, "1").sort()).toEqual([
      "alice-secret",
      "bob-secret",
      "carol-secret",
    ]);

    // The grow-side twin of the shrink bug: element writes auto-extend the
    // array, so a trailing length change no-ops and is elided from the
    // journal — the ["length"] derived entries would then never be cleared
    // or re-stamped, fossilizing the join that first minted them (which
    // here was the SHRINK tx's join, containing bob). With the length
    // change emitted before the element writes, the grow tx re-stamps
    // ["length"] from its own join: carol present, and not the pure
    // fossil that lacks her.
    const lengthConf = lengthValueConfidentiality(listId);
    expect(lengthConf).toContainEqual("carol-secret");
  });
});

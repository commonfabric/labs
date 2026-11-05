import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import type { FabricPlainObject } from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model";
import { internSchema } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IFCLabel } from "../src/cfc/mod.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import { resolveLink } from "../src/link-resolution.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("runner-cfc-existence-channel");
const space = signer.did();

type StoredEntry = {
  path: string[];
  label: IFCLabel;
  origin?: string;
  observes?: string;
};

describe("CFC existence channel (SC-4, freeze-at-creation)", () => {
  // Epic C stage C3 + follow-up — the existence channel (C0 §5, SC-4) and
  // the slot-pointer channel (C0 §4 row 3, SC-8).
  //
  // SC-4, settled with the spec (freeze-at-creation, §8.12.8 as amended on
  // specs branch cfc/existence-freeze-at-creation): the existence (shape)
  // entry is minted at the path's CREATION carrying the creating attempt's
  // join, is never cleared and never grown by overwrites of a still-existing
  // path (a writer conditional on existence journals that observation
  // itself), and legacy pre-class entries are absorbed once at migration.
  // C3's interim grow-on-overwrite is superseded by this discipline.

  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const makeRuntime = () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // At this rung the gates record what they measure and refuse nothing.
      // Every document here is assembled by hand through `writeOrThrow`,
      // declaring neither a write policy nor a ceiling, and `writeTainted`
      // then writes a labeled join onto it. Each assertion below reads back
      // the label map those commits persisted.
      cfcEnforcementMode: "observe",
      // Persisting flow labels is what puts the shape and value entries in
      // the stored label map. `entriesOf` and `shapeEntriesAt` read those
      // entries back in every test here.
      cfcFlowLabels: "persist",
    });
    return runtime;
  };

  const seedDoc = async (
    rt: Runtime,
    cause: string,
    value: FabricValue,
    entries: LabelMapEntry[],
  ): Promise<string> => {
    const seed = rt.edit();
    const cell = rt.getCell(space, cause, undefined, seed);
    const id = cell.getAsNormalizedFullLink().id;
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries },
      },
    });
    expect((await seed.commit().settled).ok).toBeDefined();
    return id;
  };

  const entriesOf = (id: string): StoredEntry[] => {
    const replica = storageManager!.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: StoredEntry[] } };
      } | undefined;
    };
    return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  };

  const readAddress = (id: string, path: string[]) => ({
    space,
    scope: "space" as const,
    id: id as `${string}:${string}`,
    type: "application/json" as const,
    path: ["value", ...path],
  });

  const uri = (id: string) => id as `${string}:${string}`;

  // Root-writes `value` into a fresh doc while consuming `sourceId`,
  // returning the new doc's id. Root writeOrThrow: leaf-diffing set() would
  // not cover the stamped path on the later overwrite.
  const writeTainted = async (
    rt: Runtime,
    sourceId: string | undefined,
    outCause: string,
    value: FabricPlainObject,
    writePath: string[] = [],
  ): Promise<string> => {
    const tx = rt.edit();
    if (sourceId !== undefined) {
      tx.readOrThrow(readAddress(sourceId, []));
    }
    const out = rt.getCell(space, outCause, undefined, tx);
    const outId = out.getAsNormalizedFullLink().id;
    tx.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value", ...writePath] },
      value,
    );
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();
    return outId;
  };

  const shapeEntriesAt = (id: string, path: string[]): StoredEntry[] =>
    entriesOf(id).filter((e) =>
      e.observes === "shape" && e.path.join("/") === path.join("/")
    );

  it("clean overwrite keeps the existence label (today it vanishes)", async () => {
    // The SC-4 red case: a clean overwrite (nothing labeled read) previously
    // erased the whole derived pair — the existence bit went public. The
    // existence entry must survive, still carrying the old writer's J.

    const rt = makeRuntime();
    const sourceId = await seedDoc(rt, "ec-source", { n: 1 }, [
      { path: [], label: { confidentiality: ["secret"] } },
    ]);
    const outId = await writeTainted(rt, sourceId, "ec-clean-out", {
      copied: true,
    });
    expect(shapeEntriesAt(outId, [])[0]?.label.confidentiality).toEqual([
      "secret",
    ]);

    // Clean overwrite: reads nothing labeled, root-overwrites the doc.
    const tx = rt.edit();
    tx.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value"] },
      { copied: false },
    );
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();

    const shape = shapeEntriesAt(outId, []);
    expect(shape.length).toBe(1);
    expect(shape[0].label.confidentiality).toContainEqual("secret");
    // The value channel legitimately lowered: no secret-carrying value
    // entry survives the clean recomputation (§8.12.8 replace).
    const valueEntries = entriesOf(outId).filter((e) => e.observes === "value");
    for (const entry of valueEntries) {
      expect(entry.label.confidentiality ?? []).not.toContainEqual("secret");
    }
  });

  it("labeled overwrite: value replaces, existence stays frozen at creation", async () => {
    // A labeled overwrite of a still-existing path: value replaces
    // (§8.12.8), existence stays FROZEN at the creation join — the second
    // writer adds no existence information.

    const rt = makeRuntime();
    const secretId = await seedDoc(rt, "ec-secret", { n: 1 }, [
      { path: [], label: { confidentiality: ["secret"] } },
    ]);
    const publicId = await seedDoc(rt, "ec-public", { n: 2 }, [
      { path: [], label: { confidentiality: ["public-ish"] } },
    ]);
    const outId = await writeTainted(rt, secretId, "ec-grow-out", {
      copied: true,
    });

    const tx = rt.edit();
    tx.readOrThrow(readAddress(publicId, []));
    tx.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value"] },
      { copied: false },
    );
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();

    const valueEntry = entriesOf(outId).find((e) => e.observes === "value");
    expect(valueEntry?.label.confidentiality).toEqual(["public-ish"]);
    const shape = shapeEntriesAt(outId, []);
    expect(shape.length).toBe(1);
    expect(shape[0].label.confidentiality).toEqual(["secret"]);
  });

  it("ancestor overwrite leaves descendant existence frozen in place", async () => {
    // An ancestor overwrite clears derived VALUE descendants (§8.12.8) —
    // but a descendant's frozen existence entry survives at its own path
    // (never cleared), and the root mints no entry of its own from a clean
    // overwrite.

    const rt = makeRuntime();
    const sourceId = await seedDoc(rt, "ec-child-source", { n: 1 }, [
      { path: [], label: { confidentiality: ["secret"] } },
    ]);
    // Create the doc first (clean tx, no stamps): a nested write on a
    // MISSING doc records as a root creation and would stamp [] instead.
    const outId = await writeTainted(rt, undefined, "ec-fold-out", {
      child: {},
    });
    expect(entriesOf(outId)).toEqual([]);
    // Derived pair lands at ["child"].
    const tainted = rt.edit();
    tainted.readOrThrow(readAddress(sourceId, []));
    tainted.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value", "child"] },
      { deep: true },
    );
    tainted.prepareCfc();
    expect((await tainted.commit().settled).ok).toBeDefined();
    expect(shapeEntriesAt(outId, ["child"]).length).toBe(1);

    // Clean ROOT overwrite: descendant pair cleared, existence folds to [].
    const tx = rt.edit();
    tx.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value"] },
      { flat: true },
    );
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();

    const childShape = shapeEntriesAt(outId, ["child"]);
    expect(childShape.length).toBe(1);
    expect(childShape[0].label.confidentiality).toEqual(["secret"]);
    // No value-class entry survives the clean recomputation anywhere.
    for (const entry of entriesOf(outId)) {
      if (entry.observes === "value") {
        expect(entry.label.confidentiality ?? []).not.toContainEqual(
          "secret",
        );
      }
    }
  });

  it("re-creation after deletion re-mints existence at the re-creating join", async () => {
    // §8.12.8 (freeze-at-creation, normative since the 2026-07-10 spec
    // landing): deleting a path and re-creating it is a FRESH creation event —
    // the existence entry re-mints at the re-creating attempt's join, and the
    // new entry REPLACES the frozen one. Carrying the stale creation join
    // would UNDERSTATE the re-created path's existence channel, the direction
    // the spec forbids (the deletion arm above merely over-taints).

    const rt = makeRuntime();
    const secretOne = await seedDoc(rt, "ec-remint-one", { n: 1 }, [
      { path: [], label: { confidentiality: ["secret-one"] } },
    ]);
    const secretTwo = await seedDoc(rt, "ec-remint-two", { n: 2 }, [
      { path: [], label: { confidentiality: ["secret-two"] } },
    ]);
    // Create the doc first (clean tx, no stamps), then CREATE the child
    // under secret-one's influence: frozen existence at ["child"] = J1.
    const outId = await writeTainted(rt, undefined, "ec-remint-out", {
      other: 1,
    });
    const create = rt.edit();
    create.readOrThrow(readAddress(secretOne, []));
    create.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value", "child"] },
      { deep: true },
    );
    create.prepareCfc();
    expect((await create.commit().settled).ok).toBeDefined();
    expect(shapeEntriesAt(outId, ["child"])[0]?.label.confidentiality)
      .toEqual(["secret-one"]);

    // DELETE the child: clean ancestor overwrite without it. The frozen
    // entry survives the deletion itself (the documented over-taint arm).
    const del = rt.edit();
    del.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value"] },
      { other: 2 },
    );
    del.prepareCfc();
    expect((await del.commit().settled).ok).toBeDefined();
    expect(shapeEntriesAt(outId, ["child"])[0]?.label.confidentiality)
      .toEqual(["secret-one"]);

    // RE-CREATE the child under secret-two's influence: a fresh creation
    // event — the existence entry must now carry J2 alone, not J1, and
    // not the join of the two.
    const recreate = rt.edit();
    recreate.readOrThrow(readAddress(secretTwo, []));
    recreate.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value", "child"] },
      { back: true },
    );
    recreate.prepareCfc();
    expect((await recreate.commit().settled).ok).toBeDefined();

    const shape = shapeEntriesAt(outId, ["child"]);
    expect(shape.length).toBe(1);
    expect(shape[0].label.confidentiality).toEqual(["secret-two"]);
  });

  it("re-creation via a deeper write re-mints at the materialization point", async () => {
    // The same fresh-creation event reached through a DEEPER write: writing
    // below the deleted child records at its materialization point (the
    // highest missing node — the child itself), so the stale frozen entry
    // there re-mints at the re-creating join, at creation granularity.

    const rt = makeRuntime();
    const secretOne = await seedDoc(rt, "ec-remint-deep-one", { n: 1 }, [
      { path: [], label: { confidentiality: ["secret-one"] } },
    ]);
    const secretTwo = await seedDoc(rt, "ec-remint-deep-two", { n: 2 }, [
      { path: [], label: { confidentiality: ["secret-two"] } },
    ]);
    const outId = await writeTainted(rt, undefined, "ec-remint-deep-out", {
      other: 1,
    });
    const create = rt.edit();
    create.readOrThrow(readAddress(secretOne, []));
    create.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value", "child"] },
      { deep: true },
    );
    create.prepareCfc();
    expect((await create.commit().settled).ok).toBeDefined();

    const del = rt.edit();
    del.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value"] },
      { other: 2 },
    );
    del.prepareCfc();
    expect((await del.commit().settled).ok).toBeDefined();
    expect(shapeEntriesAt(outId, ["child"]).length).toBe(1);

    const recreate = rt.edit();
    recreate.readOrThrow(readAddress(secretTwo, []));
    recreate.writeOrThrow(
      {
        space,
        scope: "space",
        id: uri(outId),
        path: ["value", "child", "deep"],
      },
      true,
    );
    recreate.prepareCfc();
    expect((await recreate.commit().settled).ok).toBeDefined();

    const shape = shapeEntriesAt(outId, ["child"]);
    expect(shape.length).toBe(1);
    expect(shape[0].label.confidentiality).toEqual(["secret-two"]);
  });

  it("overwriting a slot that held undefined keeps the frozen entry", async () => {
    // Presence is distinct from value (storage patch-layer contract: a slot
    // holding `undefined` is present): overwriting a slot that HELD
    // `undefined` is an ordinary still-existing overwrite, not a
    // re-creation — the frozen entry must carry, not be replaced at the
    // overwriting join (review on this PR: replacing here could LOWER the
    // existence label, an under-taint).

    const rt = makeRuntime();
    const secretOne = await seedDoc(rt, "ec-undef-one", { n: 1 }, [
      { path: [], label: { confidentiality: ["secret-one"] } },
    ]);
    const secretTwo = await seedDoc(rt, "ec-undef-two", { n: 2 }, [
      { path: [], label: { confidentiality: ["secret-two"] } },
    ]);
    const outId = await writeTainted(rt, undefined, "ec-undef-out", {
      other: 1,
    });
    const create = rt.edit();
    create.readOrThrow(readAddress(secretOne, []));
    create.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value", "child"] },
      { deep: true },
    );
    create.prepareCfc();
    expect((await create.commit().settled).ok).toBeDefined();
    expect(shapeEntriesAt(outId, ["child"])[0]?.label.confidentiality)
      .toEqual(["secret-one"]);

    // Overwrite the child to an EXPLICIT undefined (clean tx): the slot
    // stays present per the storage presence model, so the frozen entry
    // carries through this overwrite too.
    const toUndef = rt.edit();
    toUndef.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value", "child"] },
      undefined,
    );
    toUndef.prepareCfc();
    expect((await toUndef.commit().settled).ok).toBeDefined();
    expect(shapeEntriesAt(outId, ["child"])[0]?.label.confidentiality)
      .toEqual(["secret-one"]);

    // Ordinary covering overwrite of the present (undefined-valued) slot
    // under a different join: NOT a re-creation — the frozen entry keeps
    // the creation join.
    const overwrite = rt.edit();
    overwrite.readOrThrow(readAddress(secretTwo, []));
    overwrite.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value"] },
      { other: 2, child: 5 },
    );
    overwrite.prepareCfc();
    expect((await overwrite.commit().settled).ok).toBeDefined();

    const shape = shapeEntriesAt(outId, ["child"]);
    expect(shape.length).toBe(1);
    expect(shape[0].label.confidentiality).toEqual(["secret-one"]);
  });

  it("exact-path overwrite of a slot that held undefined keeps the frozen entry", async () => {
    // The same presence contract at an EXACTLY-recorded path: the write
    // detail's `previousPresent` flag (not `previousValue` definedness)
    // decides absent-vs-present when the overwrite lands at the entry's own
    // path, where there is no covering snapshot to walk (review on this PR,
    // round 2 — without the flag the frozen root/slot label is replaced at
    // the overwrite join and prior confidentiality is lost).

    const rt = makeRuntime();
    const secretOne = await seedDoc(rt, "ec-undef-exact-one", { n: 1 }, [
      { path: [], label: { confidentiality: ["secret-one"] } },
    ]);
    const secretTwo = await seedDoc(rt, "ec-undef-exact-two", { n: 2 }, [
      { path: [], label: { confidentiality: ["secret-two"] } },
    ]);
    const outId = await writeTainted(rt, undefined, "ec-undef-exact-out", {
      other: 1,
    });
    const create = rt.edit();
    create.readOrThrow(readAddress(secretOne, []));
    create.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value", "child"] },
      { deep: true },
    );
    create.prepareCfc();
    expect((await create.commit().settled).ok).toBeDefined();

    const toUndef = rt.edit();
    toUndef.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value", "child"] },
      undefined,
    );
    toUndef.prepareCfc();
    expect((await toUndef.commit().settled).ok).toBeDefined();
    expect(shapeEntriesAt(outId, ["child"])[0]?.label.confidentiality)
      .toEqual(["secret-one"]);

    // Overwrite the present (undefined-valued) slot AT ITS OWN PATH under
    // a different join: still an ordinary overwrite — the frozen entry
    // keeps the creation join.
    const overwrite = rt.edit();
    overwrite.readOrThrow(readAddress(secretTwo, []));
    overwrite.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value", "child"] },
      5,
    );
    overwrite.prepareCfc();
    expect((await overwrite.commit().settled).ok).toBeDefined();

    const shape = shapeEntriesAt(outId, ["child"]);
    expect(shape.length).toBe(1);
    expect(shape[0].label.confidentiality).toEqual(["secret-one"]);
  });

  it("clean re-creation replaces the frozen entry with the empty creating join", async () => {
    // A CLEAN re-creation (nothing labeled read) is a fresh creation event
    // under an empty join: the stale frozen entry must not survive it, and
    // with nothing to record the confidentiality-only encoding mints no
    // replacement — pre-deletion observations stay protected by the reads
    // journaled while the path existed (§8.12.8).

    const rt = makeRuntime();
    const secretOne = await seedDoc(rt, "ec-remint-clean-one", { n: 1 }, [
      { path: [], label: { confidentiality: ["secret-one"] } },
    ]);
    const outId = await writeTainted(rt, undefined, "ec-remint-clean-out", {
      other: 1,
    });
    const create = rt.edit();
    create.readOrThrow(readAddress(secretOne, []));
    create.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value", "child"] },
      { deep: true },
    );
    create.prepareCfc();
    expect((await create.commit().settled).ok).toBeDefined();

    const del = rt.edit();
    del.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value"] },
      { other: 2 },
    );
    del.prepareCfc();
    expect((await del.commit().settled).ok).toBeDefined();
    expect(shapeEntriesAt(outId, ["child"]).length).toBe(1);

    const recreate = rt.edit();
    recreate.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value", "child"] },
      { back: true },
    );
    recreate.prepareCfc();
    expect((await recreate.commit().settled).ok).toBeDefined();

    expect(shapeEntriesAt(outId, ["child"])).toEqual([]);
  });

  it("legacy covering derived entries freeze into the migrated existence entry", async () => {
    // Pre-C2 covering derived entries carried the existence channel too; a
    // clean overwrite must fold their confidentiality into the new existence
    // entry, not erase it (the same SC-4 leak on legacy data).

    const rt = makeRuntime();
    // Seed via a real flow write on a pre-C2-shaped doc: seed the covering
    // entry raw, with a loadable schema (the persist region skips docs
    // whose schemaHash does not resolve).
    const sourceId = await seedDoc(rt, "ec-legacy-source", { n: 1 }, [
      { path: [], label: { confidentiality: ["old-secret"] } },
    ]);
    const outId = await writeTainted(rt, sourceId, "ec-legacy-out", {
      copied: true,
    });
    // Rewrite the stored metadata into the pre-C2 single-covering shape.
    const replica = storageManager!.open(space).replica as unknown as {
      getDocument(id: string): { cfc?: { labelMap?: { entries: unknown[] } } };
    };
    const stored = replica.getDocument(outId).cfc! as Record<
      string,
      unknown
    >;
    const legacy = rt.edit();
    legacy.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["cfc"] },
      {
        ...stored,
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            label: { confidentiality: ["old-secret"] },
            origin: "derived",
          }],
        },
      },
    );
    expect((await legacy.commit().settled).ok).toBeDefined();

    const tx = rt.edit();
    tx.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value"] },
      { copied: false },
    );
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();

    const shape = shapeEntriesAt(outId, []);
    expect(shape.length).toBe(1);
    expect(shape[0].label.confidentiality).toContainEqual("old-secret");
  });

  it("cleared legacy structure stamps freeze into the container existence entry", async () => {
    // Structure stamps are the container-shape half of the same channel: an
    // overwrite that replaces a labeled pure-link container with plain
    // content must keep the membership history on the existence entry.

    const rt = makeRuntime();
    const el0 = await seedDoc(rt, "ec-el-0", { n: 1 }, [
      { path: [], label: { confidentiality: ["alice"] } },
    ]);
    const tx1 = rt.edit();
    tx1.readOrThrow(readAddress(el0, []));
    const el0Cell = rt.getCell(space, "ec-el-0", undefined, tx1);
    const list = rt.getCell(space, "ec-list", {
      type: "array",
      items: { asCell: ["cell"] },
    }, tx1);
    list.set([el0Cell]);
    tx1.prepareCfc();
    expect((await tx1.commit().settled).ok).toBeDefined();
    const listId = list.getAsNormalizedFullLink().id;
    expect(
      entriesOf(listId).some((e) => e.origin === "structure"),
    ).toBe(true);

    const tx2 = rt.edit();
    tx2.writeOrThrow(
      { space, scope: "space", id: uri(listId), path: ["value"] },
      { replaced: true },
    );
    tx2.prepareCfc();
    expect((await tx2.commit().settled).ok).toBeDefined();

    const shape = shapeEntriesAt(listId, []);
    expect(shape.length).toBe(1);
    expect(shape[0].label.confidentiality).toContainEqual("alice");
  });

  it("link overwrite of a labeled slot keeps existence as a bare shape entry", async () => {
    // A link write replacing a labeled slot is skipped by the stamp loops
    // (the link machinery owns that path), so the cleared existence lands as
    // a bare shape entry at the written path — the leftover branch.

    const rt = makeRuntime();
    const sourceId = await seedDoc(rt, "ec-link-source", { n: 1 }, [
      { path: [], label: { confidentiality: ["secret"] } },
    ]);
    // Doc with a derived pair at ["slot"]: create clean, then taint the slot.
    const outId = await writeTainted(rt, undefined, "ec-link-out", {
      slot: 0,
    });
    const taint = rt.edit();
    taint.readOrThrow(readAddress(sourceId, []));
    taint.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value", "slot"] },
      { copied: true },
    );
    taint.prepareCfc();
    expect((await taint.commit().settled).ok).toBeDefined();
    expect(shapeEntriesAt(outId, ["slot"]).length).toBe(1);

    // Replace the slot with a LINK (a clean tx): the link machinery owns
    // the slot's label now, but the existence history must survive.
    await seedDoc(rt, "ec-link-target", { n: 2 }, []);
    const linkTx = rt.edit();
    const outCell = rt.getCell(space, "ec-link-out", undefined, linkTx);
    const otherCell = rt.getCell(space, "ec-link-target", undefined, linkTx);
    outCell.key("slot").set(otherCell);
    linkTx.prepareCfc();
    expect((await linkTx.commit().settled).ok).toBeDefined();

    const shape = shapeEntriesAt(outId, ["slot"]);
    expect(shape.length).toBe(1);
    expect(shape[0].label.confidentiality).toContainEqual("secret");
  });

  it("declared re-mint at the same path still folds existence", async () => {
    // A declared entry re-minting at the same path (a schema policy input
    // covering the write) drops the old derived pair through a different
    // carry-forward skip than the flow-clear — its existence must fold into
    // the pool all the same (review finding on this PR).

    const rt = makeRuntime();
    const sourceId = await seedDoc(rt, "ec-declared-source", { n: 1 }, [
      { path: [], label: { confidentiality: ["old-secret"] } },
    ]);
    const outId = await writeTainted(rt, undefined, "ec-declared-out", {
      secret: "seed",
    });
    const taint = rt.edit();
    taint.readOrThrow(readAddress(sourceId, []));
    taint.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value", "secret"] },
      "tainted",
    );
    taint.prepareCfc();
    expect((await taint.commit().settled).ok).toBeDefined();
    expect(shapeEntriesAt(outId, ["secret"]).length).toBe(1);

    // Clean overwrite that ALSO records a schema policy input covering the
    // path: the declared entry re-mints at ["secret"], which drops the old
    // derived pair via the persisted-entry skip, not the flow-clear.
    const declared = internSchema(
      {
        type: "string",
        ifc: { confidentiality: ["base"] },
      } as JSONSchema,
      true,
    );
    const clean = rt.edit();
    clean.writeValueOrThrow(
      { space, scope: "space", id: uri(outId), path: ["secret"] },
      "fresh",
    );
    clean.recordCfcWritePolicyInput({
      kind: "schema",
      target: {
        space,
        scope: "space",
        id: uri(outId),
        path: ["secret"],
      },
      schemaHash: declared.taggedHashString,
      schema: declared.schema,
    });
    clean.prepareCfc();
    expect((await clean.commit().settled).ok).toBeDefined();

    const stored = entriesOf(outId);
    // The declared entry re-minted…
    expect(
      stored.some((e) =>
        e.path.join("/") === "secret" &&
        (e.label.confidentiality ?? []).includes("base")
      ),
    ).toBe(true);
    // …and the existence history survived at a covering path (the fold
    // anchors at the written path, which may be a coarser ancestor —
    // a sound over-approximation).
    const shapeConf = stored
      .filter((e) => e.observes === "shape")
      .flatMap((e) => e.label.confidentiality ?? []);
    expect(shapeConf).toContainEqual("old-secret");
  });

  it("declared re-mint without a covering write anchors existence at the entry's path", async () => {
    // A declared re-mint can cover a path the transaction never wrote (the
    // schema policy input names it while the write lands elsewhere): with no
    // covering written path, the fold anchors at the cleared entry's OWN
    // path instead of dropping the history.

    const rt = makeRuntime();
    const sourceId = await seedDoc(rt, "ec-anchor-source", { n: 1 }, [
      { path: [], label: { confidentiality: ["old-secret"] } },
    ]);
    const outId = await writeTainted(rt, undefined, "ec-anchor-out", {
      secret: "seed",
      other: 1,
    });
    const taint = rt.edit();
    taint.readOrThrow(readAddress(sourceId, []));
    taint.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value", "secret"] },
      "tainted",
    );
    taint.prepareCfc();
    expect((await taint.commit().settled).ok).toBeDefined();
    expect(shapeEntriesAt(outId, ["secret"]).length).toBe(1);

    // The clean tx writes a DIFFERENT doc but records a schema input naming
    // this doc's SECRET path: the declared entry re-mints at ["secret"]
    // with no write to this doc at all — no written path can anchor the
    // fold.
    const declared = internSchema(
      { type: "string", ifc: { confidentiality: ["base"] } } as JSONSchema,
      true,
    );
    const elsewhereId = await writeTainted(rt, undefined, "ec-anchor-else", {
      unrelated: 1,
    });
    const clean = rt.edit();
    clean.writeValueOrThrow(
      { space, scope: "space", id: uri(elsewhereId), path: [] },
      { unrelated: 2 },
    );
    clean.recordCfcWritePolicyInput({
      kind: "schema",
      target: {
        space,
        scope: "space",
        id: uri(outId),
        path: ["secret"],
      },
      schemaHash: declared.taggedHashString,
      schema: declared.schema,
    });
    clean.prepareCfc();
    expect((await clean.commit().settled).ok).toBeDefined();

    const shape = shapeEntriesAt(outId, ["secret"]);
    expect(shape.length).toBe(1);
    expect(shape[0].label.confidentiality).toContainEqual("old-secret");
  });

  it("folds byte-permuted clause forms without doubling (SC-11)", async () => {
    // SC-11, clause-aware: a stored existence clause in a byte-permuted form
    // (a peer wrote {anyOf:["B","A"]}) meeting this tx's normalized
    // derivation ({anyOf:["A","B"]}) must collapse to ONE clause — deepEqual
    // dedup alone doubles the clause list and rewrites the envelope once.

    const rt = makeRuntime();
    const orClause = { anyOf: ["reader-a", "reader-b"] };
    const sourceId = await seedDoc(rt, "ec-clause-source", { n: 1 }, [
      { path: [], label: { confidentiality: [orClause] } },
    ]);
    const outId = await writeTainted(rt, sourceId, "ec-clause-out", {
      copied: true,
    });

    // Flip the stored existence clause to the reversed byte form, as a
    // peer's view merge could have persisted it.
    const replica = storageManager!.open(space).replica as unknown as {
      getDocument(id: string): { cfc?: Record<string, unknown> };
    };
    const stored = replica.getDocument(outId).cfc! as {
      labelMap: { entries: StoredEntry[] };
    };
    const flipped = {
      ...stored,
      labelMap: {
        version: 1,
        entries: stored.labelMap.entries.map((e) =>
          e.observes === "shape"
            ? {
              ...e,
              label: { confidentiality: [{ anyOf: ["reader-b", "reader-a"] }] },
            }
            : e
        ),
      },
    };
    const flip = rt.edit();
    flip.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["cfc"] },
      flipped as never,
    );
    expect((await flip.commit().settled).ok).toBeDefined();

    // Re-derive: reads the source again (normalized clause) and overwrites
    // the root — the fold meets the reversed stored form.
    const tx = rt.edit();
    tx.readOrThrow(readAddress(sourceId, []));
    tx.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value"] },
      { copied: false },
    );
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();

    const shape = shapeEntriesAt(outId, []);
    expect(shape.length).toBe(1);
    expect(shape[0].label.confidentiality?.length).toBe(1);

    // And the re-derivation is now canonically idempotent: repeating the
    // same overwrite leaves the stored metadata byte-identical.
    const before = JSON.stringify(entriesOf(outId));
    const again = rt.edit();
    again.readOrThrow(readAddress(sourceId, []));
    again.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value"] },
      { copied: 2 },
    );
    again.prepareCfc();
    expect((await again.commit().settled).ok).toBeDefined();
    expect(JSON.stringify(entriesOf(outId))).toEqual(before);
  });

  it("membership replaces per criteria while frozen existence keeps the creation join (A3)", async () => {
    // The A3 cross-scenario shape from the #4525 probe: membership changes
    // across labeled re-stamps of a pure-link container. The MEMBERSHIP
    // (enumerate) stamp is replaced from the current criteria each time —
    // bob's atom does not survive his element leaving (§8.12.8 normative,
    // no accumulate-forever) — while the frozen existence (shape) entry
    // keeps the CREATION join only, untouched by later re-stamps.

    const rt = makeRuntime();
    const alice = await seedDoc(rt, "ec-a3-alice", { n: 1 }, [
      { path: [], label: { confidentiality: ["alice"] } },
    ]);
    const bob = await seedDoc(rt, "ec-a3-bob", { n: 2 }, [
      { path: [], label: { confidentiality: ["bob"] } },
    ]);

    const stampList = async (readIds: string[], members: string[]) => {
      const tx = rt.edit();
      for (const id of readIds) tx.readOrThrow(readAddress(id, []));
      const cells = members.map((cause) =>
        rt.getCell(space, cause, undefined, tx)
      );
      const list = rt.getCell(space, "ec-a3-list", {
        type: "array",
        items: { asCell: ["cell"] },
      }, tx);
      list.set(cells);
      tx.prepareCfc();
      expect((await tx.commit().settled).ok).toBeDefined();
      return list.getAsNormalizedFullLink().id;
    };

    // A1: created under alice's influence, members [alice].
    const listId = await stampList([alice], ["ec-a3-alice"]);
    // A2: re-stamped under bob's influence, members [alice, bob].
    await stampList([bob], ["ec-a3-alice", "ec-a3-bob"]);
    // A3: re-stamped under alice's influence again, members [alice].
    await stampList([alice], ["ec-a3-alice"]);

    const structure = entriesOf(listId).filter((e) => e.origin === "structure");
    const enumerateConf = structure
      .filter((e) => e.observes === "enumerate")
      .flatMap((e) => e.label.confidentiality ?? []);
    // The FROZEN existence entry is the concrete container-path shape entry;
    // the `*`-child shape-class membership TEMPLATE (template-population
    // §3.1, generic route) shares the observes value but follows the
    // replace-from-criteria discipline instead — split the pin by path.
    const frozenShapeConf = structure
      .filter((e) => e.observes === "shape" && e.path.length === 0)
      .flatMap((e) => e.label.confidentiality ?? []);
    const templateConf = structure
      .filter((e) => e.path.length === 1 && e.path[0] === "*")
      .flatMap((e) => e.label.confidentiality ?? []);
    // Current membership: alice's criteria only — bob's atom left with his
    // element (no unshrinkable accumulation).
    expect(enumerateConf).toEqual(["alice"]);
    // Frozen existence: the creation join only — untouched by A2/A3.
    expect(frozenShapeConf).toEqual(["alice"]);
    // The templates re-mint per criteria like the enumerate stamp: bob's
    // atom does not accumulate across A2 → A3.
    expect([...new Set(templateConf)]).toEqual(["alice"]);
  });

  it("legacy entry at a link-replaced slot freezes via the leftover anchor", async () => {
    // Legacy migration through the OTHER carry-forward skips: a pre-class
    // covering entry at a slot replaced by a LINK write pools through the
    // link-path skip and lands as a frozen shape entry at its own path (the
    // leftover anchor — link-covered paths get no stamps).

    const rt = makeRuntime();
    const sourceId = await seedDoc(rt, "ec-legacy-link-source", { n: 1 }, [
      { path: [], label: { confidentiality: ["old-secret"] } },
    ]);
    const outId = await writeTainted(rt, undefined, "ec-legacy-link-out", {
      slot: 0,
    });
    const taint = rt.edit();
    taint.readOrThrow(readAddress(sourceId, []));
    taint.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value", "slot"] },
      { copied: true },
    );
    taint.prepareCfc();
    expect((await taint.commit().settled).ok).toBeDefined();
    // Rewrite stored metadata: ONE legacy covering derived entry at the slot.
    const replica = storageManager!.open(space).replica as unknown as {
      getDocument(id: string): { cfc?: Record<string, unknown> };
    };
    const stored = replica.getDocument(outId).cfc! as Record<string, unknown>;
    const legacy = rt.edit();
    legacy.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["cfc"] },
      {
        ...stored,
        labelMap: {
          version: 1,
          entries: [{
            path: ["slot"],
            label: { confidentiality: ["old-secret"] },
            origin: "derived",
          }],
        },
      },
    );
    expect((await legacy.commit().settled).ok).toBeDefined();

    // Replace the slot with a LINK in a clean tx: the legacy entry pools
    // through the link-path skip; no stamp path covers a link write, so
    // the leftover anchors the frozen shape entry at the slot itself.
    await seedDoc(rt, "ec-legacy-link-target", { n: 2 }, []);
    const linkTx = rt.edit();
    const outCell = rt.getCell(space, "ec-legacy-link-out", undefined, linkTx);
    const otherCell = rt.getCell(
      space,
      "ec-legacy-link-target",
      undefined,
      linkTx,
    );
    outCell.key("slot").set(otherCell);
    linkTx.prepareCfc();
    expect((await linkTx.commit().settled).ok).toBeDefined();

    const shape = shapeEntriesAt(outId, ["slot"]);
    expect(shape.length).toBe(1);
    expect(shape[0].label.confidentiality).toContainEqual("old-secret");
  });

  it("structure stamps collapse under a derived ancestor stamp", async () => {
    // A mixed write — plain content at the root and a pure-link container in
    // the same transaction — collapses the container's membership stamp
    // against the covering derived ancestor (exact-path structure stamps
    // only collapse against derived ancestors-or-equal).

    const rt = makeRuntime();
    const sourceId = await seedDoc(rt, "ec-mixed-source", { n: 1 }, [
      { path: [], label: { confidentiality: ["secret"] } },
    ]);
    await seedDoc(rt, "ec-mixed-el", { n: 2 }, []);

    const tx = rt.edit();
    tx.readOrThrow(readAddress(sourceId, []));
    const out = rt.getCell(space, "ec-mixed-out", undefined, tx);
    const outId = out.getAsNormalizedFullLink().id;
    tx.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value"] },
      { text: "x" },
    );
    const el = rt.getCell(space, "ec-mixed-el", undefined, tx);
    out.key("list").withTx(tx).set([el]);
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();

    const entries = entriesOf(outId);
    expect(
      entries.some((e) => e.origin === "derived" && e.path.join("/") === ""),
    ).toBe(true);
    expect(
      entries.filter((e) =>
        e.origin === "structure" && e.observes === "enumerate"
      ),
    ).toEqual([]);
  });

  it("the frozen existence entry re-derives idempotently", async () => {
    // Idempotence stays per-class (SC-11): repeating the same clean overwrite
    // must not churn the metadata — the grown existence entry re-derives
    // identically.

    const rt = makeRuntime();
    const sourceId = await seedDoc(rt, "ec-idem-source", { n: 1 }, [
      { path: [], label: { confidentiality: ["secret"] } },
    ]);
    const outId = await writeTainted(rt, sourceId, "ec-idem-out", {
      copied: true,
    });

    const overwrite = async (value: FabricPlainObject) => {
      const tx = rt.edit();
      tx.writeOrThrow(
        { space, scope: "space", id: uri(outId), path: ["value"] },
        value,
      );
      tx.prepareCfc();
      expect((await tx.commit().settled).ok).toBeDefined();
    };
    await overwrite({ copied: false });
    const firstEntries = entriesOf(outId);
    // The frozen existence entry is there to re-derive.
    expect(firstEntries.map((e) => e.observes)).toEqual(["shape"]);
    const first = JSON.stringify(firstEntries);
    await overwrite({ copied: 3 });
    expect(JSON.stringify(entriesOf(outId))).toEqual(first);
  });
});

describe("CFC slot-pointer channel (C3, SC-8 end-to-end)", () => {
  // SC-8, the pointer-identity channel (C0 §4 row 3). The consumption
  // mechanism landed with C1 (probes classified followRef, standalone probes
  // consume link-origin labels); this pins the channel end-to-end at the
  // resolution seam: observing WHICH reference sits at a slot — without
  // following it — taints the observer's flow join with the pointer's label.

  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  it("resolving a slot link without following it taints with the pointer label", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // At this rung the gates record what they measure and refuse nothing.
      // `sp-holder` is assembled by hand through `writeOrThrow`, and `sp-out`
      // is created by a write carrying the pointer label with no ceiling
      // declared for it. The closing assertion reads back the entry that
      // second commit persisted.
      cfcEnforcementMode: "observe",
      // Persisting flow labels is what puts the derived entry carrying
      // "pointer-label" into `sp-out`.
      cfcFlowLabels: "persist",
    });
    const seed = runtime.edit();
    const holder = runtime.getCell(space, "sp-holder", undefined, seed);
    const holderId = holder.getAsNormalizedFullLink().id;
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(
      seed,
      { space, scope: "space", id: holderId, path: [] },
      {
        value: {
          slot: { "/": { "link@1": { id: "of:sp-target", path: [] } } },
        },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["slot"],
              label: { confidentiality: ["pointer-label"] },
              origin: "link",
            }],
          },
        },
      },
    );
    expect((await seed.commit().settled).ok).toBeDefined();

    // Observe WHICH link sits at the slot without following it: lastNode
    // "top" stops at the slot after probing it — the row-3 observation.
    const tx = runtime.edit();
    const slotLink: NormalizedFullLink = {
      space,
      id: holderId as `${string}:${string}`,
      path: ["slot"],
      scope: "space",
    } as NormalizedFullLink;
    resolveLink(runtime, tx, slotLink, "top");
    const out = runtime.getCell(space, "sp-out", undefined, tx);
    const outId = out.getAsNormalizedFullLink().id;
    tx.writeOrThrow(
      {
        space,
        scope: "space",
        id: outId as `${string}:${string}`,
        path: ["value"],
      },
      { observed: true },
    );
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();

    const replica = storageManager.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: StoredEntry[] } };
      } | undefined;
    };
    const derived = (replica.getDocument(outId)?.cfc?.labelMap?.entries ?? [])
      .filter((e) => e.origin === "derived");
    expect(
      derived.flatMap((e) => e.label.confidentiality ?? []),
    ).toContainEqual("pointer-label");
  });
});

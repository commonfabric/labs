/**
 * What a read that obtains a reference consumes. CFC
 * `04-label-representation.md` §4.6.3 puts a standalone reference-identity
 * read — observing which reference sits at a slot, without dereferencing it —
 * on the pointer's own label alone, and never on the content-class labels at
 * that path. §8.11.4 classes a schema `ifc` annotation as a content clause, so
 * the confidentiality a reference position declares is one of the labels such
 * a read leaves alone.
 *
 * Two places in the runtime obtain a reference without dereferencing it:
 * `readMaybeLink` in `link-resolution.ts`, which mints a cell handle at an
 * `asCell` position, and the write-redirect chain walk in
 * `pattern-binding.ts`, which asks whether a redirect target holds a further
 * redirect.
 *
 * The last block states the limit of that. A confidentiality declared at a
 * reference position is stored on the referring document, so a transaction
 * that follows the reference and reads the value picks it up from there; on a
 * target document whose own label map is empty, that entry is the only place
 * it is written down. The hop read inside `resolveLinkTracingDereferences` is
 * a step of that dereference rather than a standalone observation, and is what
 * consumes the entry.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import { readMaybeLink, resolveLink } from "../src/link-resolution.ts";
import {
  createSigilLinkFromParsedLink,
  type NormalizedFullLink,
} from "../src/link-utils.ts";
import { findAllWriteRedirectCells } from "../src/pattern-binding.ts";
import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { machineryRead } from "../src/storage/reactivity-log.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("runner-cfc-reference-identity");
const space = signer.did();

describe("cfc-reference-identity-reads", () => {
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
      // Every assertion below reads the flow stamp out of the replica, so it
      // has to be persisted rather than measured.
      cfcFlowLabels: "persist",
    });
    return runtime;
  };

  // A seeded confidentiality clause naming a synthetic audience beside the
  // space these documents live in, so a transaction carrying the join can
  // still write an output document that declares no policy of its own.
  const audience = (tag: string) => ({ anyOf: [tag, cfcAtom.space(space)] });

  // The synthetic audience each clause of a join names, in the join's order.
  const tagsOf = (join: readonly unknown[] | undefined): string[] | undefined =>
    join?.map((clause) =>
      ((clause as { anyOf: unknown[] }).anyOf.find((alternative) =>
        typeof alternative === "string"
      )) as string
    );

  const contentEntry = (path: string[], tag: string): LabelMapEntry => ({
    path,
    label: { confidentiality: [audience(tag)] },
  });

  const pointerEntry = (path: string[], tag: string): LabelMapEntry => ({
    path,
    label: { confidentiality: [audience(tag)] },
    origin: "link",
  });

  // One seeding transaction: `write` installs a document with its stored label
  // map and returns its link, so a later seeded value can hold a link to an
  // earlier one.
  const seeding = (rt: Runtime) => {
    const tx = rt.edit();
    writeSeedEnvelopeDoc(tx, space);
    const write = (
      cause: string,
      value: FabricValue,
      entries: LabelMapEntry[] = [],
    ): NormalizedFullLink => {
      const link = rt.getCell(space, cause, undefined, tx)
        .getAsNormalizedFullLink();
      seedStoredEnvelope(tx, { space, scope: "space", id: link.id, path: [] }, {
        value,
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: { version: 1, entries },
        },
      });
      return link;
    };
    const commit = async () => {
      expect((await tx.commit()).ok).toBeDefined();
    };
    return { write, commit };
  };

  type StoredEntry = {
    path?: string[];
    origin?: string;
    label: { confidentiality?: unknown[] };
  };

  type StoredDocument = {
    value?: unknown;
    cfc?: { labelMap?: { entries: StoredEntry[] } };
  } | undefined;

  const storedEntries = (id: string): StoredEntry[] =>
    ((storageManager!.open(space).replica as unknown as {
      getDocument(id: string): StoredDocument;
    }).getDocument(id))?.cfc?.labelMap?.entries ?? [];

  const derivedConfidentiality = (id: string): unknown[] | undefined =>
    storedEntries(id).find((entry) => entry.origin === "derived")
      ?.label.confidentiality;

  /** The audiences a link-origin entry names at one path of a document. */
  const pointerTagsAt = (
    id: string,
    path: string[],
  ): string[] | undefined =>
    tagsOf(
      storedEntries(id).find((entry) =>
        entry.origin === "link" &&
        (entry.path ?? []).join("/") === path.join("/")
      )?.label.confidentiality,
    );

  /**
   * Every audience the document's container-shape stamps name, deduplicated.
   * A transaction stamps its whole join on the container it wrote, so this is
   * where a clause lands that is not tied to one slot.
   */
  const containerTags = (id: string): string[] => [
    ...new Set(
      storedEntries(id)
        .filter((entry) => entry.origin === "structure")
        .flatMap((entry) => tagsOf(entry.label.confidentiality) ?? []),
    ),
  ];

  // Runs `observe` in a transaction that also writes an output document, then
  // commits and returns the audiences the output's flow stamp names.
  const flowJoinOf = async (
    rt: Runtime,
    outCause: string,
    observe: (tx: IExtendedStorageTransaction) => void,
  ): Promise<string[] | undefined> => {
    const tx = rt.edit();
    observe(tx);
    const out = rt.getCell(space, outCause, undefined, tx);
    out.set({ copied: true });
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();
    return tagsOf(derivedConfidentiality(out.getAsNormalizedFullLink().id));
  };

  it("preserves foreign handle reference confidentiality through direct and eager reads", async () => {
    const rt = makeRuntime();
    const foreign =
      (await Identity.fromPassphrase("reference-identity foreign")).did();
    const target = rt.getCell(
      foreign,
      "unread-target",
      undefined,
      undefined,
      "user",
    )
      .key("nested").getAsNormalizedFullLink();
    const { schema: _targetSchema, ...targetAddress } = target;
    const schema = {
      type: "object",
      properties: {
        ref: { type: "unknown", asCell: ["cell"] },
        refs: {
          type: "array",
          items: { type: "unknown", asCell: ["readonly"] },
        },
      },
    } as const;
    const seed = seeding(rt);
    const holder = seed.write("foreign-reference-holder", {
      ref: createSigilLinkFromParsedLink(target),
      refs: [createSigilLinkFromParsedLink(target)],
    }, [
      pointerEntry(["ref"], "reference-secret"),
      pointerEntry(["refs", "0"], "array-reference-secret"),
    ]);
    await seed.commit();
    const targetSeed = rt.edit();
    writeSeedEnvelopeDoc(targetSeed, foreign);
    seedStoredEnvelope(targetSeed, {
      space: foreign,
      scope: "user",
      id: target.id,
      path: [],
    }, {
      value: { nested: "private target" },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [contentEntry(["nested"], "target-secret")],
        },
      },
    });
    expect((await targetSeed.commit()).ok).toBeDefined();
    const directJoin = await flowJoinOf(rt, "foreign-direct-out", (tx) => {
      const cell = rt.getCellFromLink<
        { ref: Cell<unknown>; refs: Cell<unknown>[] }
      >({
        ...holder,
        schema,
      }).withTx(tx);
      expect(cell.key("ref").get().getAsNormalizedFullLink()).toMatchObject(
        targetAddress,
      );
      expect(tx.getNarrowestReadScope()).toBe("space");
    });
    expect(directJoin).toContain("reference-secret");
    expect(directJoin).not.toContain("target-secret");
    const eagerJoin = await flowJoinOf(rt, "foreign-eager-out", (tx) => {
      const cell = rt.getCellFromLink<
        { ref: Cell<unknown>; refs: Cell<unknown>[] }
      >({
        ...holder,
        schema,
      }).withTx(tx);
      const value = cell.get({ traverseCells: true });
      expect(value.ref.getAsNormalizedFullLink()).toMatchObject(targetAddress);
      expect(value.refs[0].getAsNormalizedFullLink()).toMatchObject(
        targetAddress,
      );
      expect(tx.getNarrowestReadScope()).toBe("space");
    });
    expect(eagerJoin).toContain("reference-secret");
    expect(eagerJoin).toContain("array-reference-secret");
    expect(eagerJoin).not.toContain("target-secret");
    const targetJoin = await flowJoinOf(rt, "foreign-target-out", (tx) => {
      const cell = rt.getCellFromLink<{ ref: Cell<unknown> }>({
        ...holder,
        schema,
      }).withTx(tx);
      const handle = cell.key("ref").get();
      expect(tx.getNarrowestReadScope()).toBe("space");
      expect(handle.asSchema<string>({ type: "string" }).get()).toBe(
        "private target",
      );
      expect(tx.getNarrowestReadScope()).toBe("user");
    });
    expect(targetJoin).toContain("reference-secret");
    expect(targetJoin).toContain("target-secret");
    const localTarget = rt.getCell(
      space,
      "same-space-user-target",
      undefined,
      undefined,
      "user",
    );
    const localSeed = seeding(rt);
    const localHolder = localSeed.write("same-space-reference-holder", {
      ref: createSigilLinkFromParsedLink(localTarget.getAsNormalizedFullLink()),
    });
    await localSeed.commit();
    await flowJoinOf(rt, "same-space-reference-out", (tx) => {
      const cell = rt.getCellFromLink<{ ref: Cell<unknown> }>({
        ...localHolder,
        schema,
      }).withTx(tx);
      expect(cell.key("ref").get().getAsNormalizedFullLink()).toMatchObject({
        id: localTarget.getAsNormalizedFullLink().id,
        space,
        scope: "user",
      });
      expect(tx.getNarrowestReadScope()).toBe("space");
    });
    await flowJoinOf(rt, "same-space-eager-reference-out", (tx) => {
      const cell = rt.getCellFromLink<{ ref: Cell<unknown> }>({
        ...localHolder,
        schema,
      }).withTx(tx);
      expect(cell.get({ traverseCells: true }).ref.getAsNormalizedFullLink())
        .toMatchObject({
          id: localTarget.getAsNormalizedFullLink().id,
          space,
          scope: "user",
        });
      expect(tx.getNarrowestReadScope()).toBe("space");
    });
  });

  describe("readMaybeLink()", () => {
    // The one-step hop `schema.ts` takes to mint a cell handle at an `asCell`
    // position: it obtains the reference stored there and follows nothing.

    const seedHolder = async (rt: Runtime, entries: LabelMapEntry[]) => {
      const seed = seeding(rt);
      const holder = seed.write(
        "rir-holder",
        {
          ref: createSigilLinkFromParsedLink(
            seed.write("rir-target", "s3cr3t"),
          ),
        },
        entries,
      );
      await seed.commit();
      return holder;
    };

    it("leaves a content label at the reference position out of the flow join", async () => {
      const rt = makeRuntime();
      const holder = await seedHolder(rt, [
        contentEntry(["ref"], "declared-at-reference"),
      ]);
      const join = await flowJoinOf(rt, "rir-handle-out", (tx) => {
        expect(readMaybeLink(tx, { ...holder, path: ["ref"] }))
          .toBeDefined();
      });
      expect(join).toBeUndefined();
    });

    it("joins the pointer's own label at the reference position into the flow join", async () => {
      const rt = makeRuntime();
      const holder = await seedHolder(rt, [
        pointerEntry(["ref"], "pointer-label"),
      ]);
      const join = await flowJoinOf(rt, "rir-pointer-out", (tx) => {
        expect(readMaybeLink(tx, { ...holder, path: ["ref"] }))
          .toBeDefined();
      });
      expect(join).toEqual(["pointer-label"]);
    });

    it("leaves the pointer's own label out when the runtime's own wiring obtains the reference", async () => {
      const rt = makeRuntime();
      const holder = await seedHolder(rt, [
        pointerEntry(["ref"], "pointer-label"),
      ]);
      const join = await flowJoinOf(rt, "rir-machinery-out", (tx) => {
        tx.runWithAmbientReadMeta(machineryRead, () => {
          expect(readMaybeLink(tx, { ...holder, path: ["ref"] }))
            .toBeDefined();
        });
      });
      expect(join).toBeUndefined();
    });

    it("joins a content label a wiring read materializes at the same position", async () => {
      const rt = makeRuntime();
      const holder = await seedHolder(rt, [
        contentEntry(["ref"], "declared-at-reference"),
      ]);
      const join = await flowJoinOf(rt, "rir-machinery-content-out", (tx) => {
        tx.runWithAmbientReadMeta(machineryRead, () => {
          expect(tx.readValueOrThrow({ ...holder, path: ["ref"] }))
            .toBeDefined();
        });
      });
      expect(join).toEqual(["declared-at-reference"]);
    });
  });

  describe("findAllWriteRedirectCells()", () => {
    // The write-redirect chain walk asks whether the target of a redirect
    // holds a further redirect, which is a question about which reference
    // sits there.

    const seedChain = async (rt: Runtime, entries: LabelMapEntry[]) => {
      const seed = seeding(rt);
      const last = seed.write("rir-chain-last", 7);
      const middle = seed.write(
        "rir-chain-middle",
        createSigilLinkFromParsedLink({ ...last, overwrite: "redirect" }),
        entries,
      );
      await seed.commit();
      return { middle, last };
    };

    it("leaves a content label at a redirect target out of the flow join", async () => {
      const rt = makeRuntime();
      const { middle } = await seedChain(rt, [
        contentEntry([], "chain-content"),
      ]);
      const join = await flowJoinOf(rt, "rir-chain-out", (tx) => {
        const base = rt.getCell(space, "rir-chain-base", undefined, tx);
        findAllWriteRedirectCells(
          createSigilLinkFromParsedLink({ ...middle, overwrite: "redirect" }),
          base,
        );
      });
      expect(join).toBeUndefined();
    });

    it("joins the pointer's own label at a redirect target into the flow join", async () => {
      const rt = makeRuntime();
      const { middle } = await seedChain(rt, [
        pointerEntry([], "chain-pointer"),
      ]);
      const join = await flowJoinOf(rt, "rir-chain-pointer-out", (tx) => {
        const base = rt.getCell(space, "rir-chain-base", undefined, tx);
        findAllWriteRedirectCells(
          createSigilLinkFromParsedLink({ ...middle, overwrite: "redirect" }),
          base,
        );
      });
      expect(join).toEqual(["chain-pointer"]);
    });

    it("returns every link on the redirect chain", async () => {
      const rt = makeRuntime();
      const { middle, last } = await seedChain(rt, []);
      const tx = rt.edit();
      const base = rt.getCell(space, "rir-chain-base", undefined, tx);
      const found = findAllWriteRedirectCells(
        createSigilLinkFromParsedLink({ ...middle, overwrite: "redirect" }),
        base,
      );
      expect(found.map((link) => link.id)).toEqual([middle.id, last.id]);
      await tx.commit();
    });
  });

  describe("carrying the reference onward", () => {
    // Why a wiring probe can consume nothing without losing the label. What
    // the runtime does with a reference it obtains is write that same
    // reference into another slot, and the link write mints the source
    // document's own label there (`derivePersistedLinkLabel`). So the
    // protection arrives at the slot that now holds the reference, whatever
    // the probe consumed. This is the substitute route the skip rests on, and
    // nothing else pins it.

    const seedOnward = async (rt: Runtime) => {
      const seed = seeding(rt);
      const target = seed.write("rir-onward-target", "s3cr3t", [
        contentEntry([], "on-target"),
      ]);
      const holder = seed.write(
        "rir-onward-holder",
        { ref: createSigilLinkFromParsedLink(target) },
        [pointerEntry(["ref"], "pointer-label")],
      );
      await seed.commit();
      return holder;
    };

    /**
     * Obtains the reference at the holder's slot the way the runtime's wiring
     * does, writes it into a fresh document, and answers with what that
     * document stores: the pointer label at the slot the reference landed in,
     * and the audiences the container-shape stamps over the whole document
     * name.
     */
    const carryOnward = async (
      rt: Runtime,
      outCause: string,
      obtain: (tx: IExtendedStorageTransaction) => NormalizedFullLink,
    ): Promise<{ slot: string[] | undefined; container: string[] }> => {
      const tx = rt.edit();
      const reference = obtain(tx);
      const out = rt.getCell(space, outCause, undefined, tx);
      out.set({ slot: createSigilLinkFromParsedLink(reference) });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();
      const id = out.getAsNormalizedFullLink().id;
      return {
        slot: pointerTagsAt(id, ["slot"]),
        container: containerTags(id),
      };
    };

    it("mints the source's label at the slot the reference lands in", async () => {
      const rt = makeRuntime();
      const holder = await seedOnward(rt);
      const carried = await carryOnward(
        rt,
        "rir-onward-out",
        (tx) =>
          tx.runWithAmbientReadMeta(
            machineryRead,
            () => readMaybeLink(tx, { ...holder, path: ["ref"] })!,
          ),
      );
      expect(carried.slot).toEqual(["on-target"]);
      expect(carried.container).toEqual([]);
    });

    it("mints the same label there when the probe consumed one", async () => {
      // The slot's label does not come from the probe. An unmarked probe at
      // the same position consumes the holder's pointer label, and what that
      // adds is a stamp over the container the reference landed in — the
      // second, coarser copy. The slot carries what it carried above either
      // way, so the skip removes the copy and not the protection.
      const rt = makeRuntime();
      const holder = await seedOnward(rt);
      const carried = await carryOnward(
        rt,
        "rir-onward-standalone-out",
        (tx) => readMaybeLink(tx, { ...holder, path: ["ref"] })!,
      );
      expect(carried.slot).toEqual(["on-target"]);
      expect(carried.container).toEqual(["pointer-label"]);
    });
  });

  describe("reading the value through a reference", () => {
    // What the classification above must not cost: the confidentiality a
    // reference position declares still reaches a transaction that
    // dereferences the reference and reads the value, on a target document
    // whose own label map is empty.

    it("joins a content label declared at the reference position into the flow join", async () => {
      const rt = makeRuntime();
      const seed = seeding(rt);
      const target = seed.write("rir-read-target", "s3cr3t");
      const holder = seed.write(
        "rir-read-holder",
        { ref: createSigilLinkFromParsedLink(target) },
        [contentEntry(["ref"], "declared-at-reference")],
      );
      await seed.commit();

      const join = await flowJoinOf(rt, "rir-read-out", (tx) => {
        const resolved = resolveLink(rt, tx, { ...holder, path: ["ref"] });
        expect(tx.readValueOrThrow(resolved)).toEqual("s3cr3t");
      });
      expect(join).toEqual(["declared-at-reference"]);
    });

    it("joins the target document's own content label into the flow join", async () => {
      const rt = makeRuntime();
      const seed = seeding(rt);
      const target = seed.write("rir-target-labeled", "s3cr3t", [
        contentEntry([], "declared-on-target"),
      ]);
      const holder = seed.write(
        "rir-holder-bare",
        { ref: createSigilLinkFromParsedLink(target) },
      );
      await seed.commit();

      const join = await flowJoinOf(rt, "rir-target-out", (tx) => {
        const resolved = resolveLink(rt, tx, { ...holder, path: ["ref"] });
        expect(tx.readValueOrThrow(resolved)).toEqual("s3cr3t");
      });
      expect(join).toEqual(["declared-on-target"]);
    });
  });
});

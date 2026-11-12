/**
 * Which runtime-minted `*` templates a standalone link probe consumes: those
 * at the one slot it asked about, never those beneath it.
 *
 * A builtin mints its result store and writes it in one transaction, and
 * when that transaction read something labeled, the store's creation mints
 * `*`-child templates carrying the label (docs/specs/cfc-template-population.md
 * §3.1). The `followRef` template there labels which reference sits at each
 * CHILD of the store. `Cell.set`'s probe of the store's own root, read at the
 * sigil's path, matched that template through the sigil key as though "/"
 * were a child, so every later transaction that merely wrote the store again
 * carried the creation's label onto every other document it wrote. A
 * `sqliteQuery` whose parameter was labeled on its first issue refused each
 * row it settled.
 *
 * Probes AT a slot keep consuming what the templates exist for: which
 * reference a membership decision put at a slot, or that it put none there.
 * A reader of a container's references keeps its label, and a schema's
 * declared pointer policy stays consumed as before.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";

import { recordRuntimeOwnedStore } from "../src/builtins/runtime-owned-store.ts";
import type { Cell } from "../src/cell.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import type { CfcRefusalDetail } from "../src/cfc/refusal-detail.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { setResultCell } from "../src/result-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { linkResolutionProbe } from "../src/storage/reactivity-log.ts";
import { seedStoredEnvelope } from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("runner-cfc-probe-slot");
const space = signer.did();

/** The connector spelling: the owner, and a `Resource` naming the class. */
const PICKED_CLAUSE = [
  space,
  { type: CFC_ATOM_TYPE.Resource, class: "message", subject: space },
];

const LIST_SCHEMA = {
  type: "array",
  items: { asCell: ["cell"] },
} as const;

type StoredEntry = {
  path: string[];
  label: { confidentiality?: unknown[] };
  origin?: string;
  observes?: string;
};

const sorted = (atom: unknown): string =>
  JSON.stringify(
    atom,
    typeof atom === "object" && atom !== null
      ? Object.keys(atom).sort()
      : undefined,
  );

const carriesPicked = (atoms: readonly unknown[] | undefined): boolean =>
  PICKED_CLAUSE.every((atom) =>
    (atoms ?? []).some((held) => sorted(held) === sorted(atom))
  );

describe("link-resolution probes and `*` templates", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  const makeRuntime = (strict: boolean) => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels: "persist",
      // The rung where a writer-fit misfit refuses rather than flags, with
      // the dials every preset deployment pins. The list cases write a list
      // no schema declares a policy for, so they observe instead: what they
      // measure is the join, not a refusal.
      ...(strict
        ? {
          cfcEnforcementMode: "enforce-strict",
          cfcWriteFloor: "enforce",
          cfcPolicyEvaluation: "enforce",
          cfcLabelMetadataProtection: "enforce",
          cfcDeclaredMonotonicity: "enforce",
        } as const
        : { cfcEnforcementMode: "observe" } as const),
    });
  };

  afterEach(async () => {
    await runtime.dispose({ closeStorage: false });
    await storageManager.close();
  });

  const entriesOf = (cell: Cell<unknown>): StoredEntry[] => {
    const tx = runtime.edit();
    try {
      return (readStoredCfcMetadata(tx, cell.getAsNormalizedFullLink())
        ?.labelMap.entries ?? []) as StoredEntry[];
    } finally {
      tx.abort("label read");
    }
  };

  const hasPointerTemplate = (cell: Cell<unknown>): boolean =>
    entriesOf(cell).some((entry) =>
      entry.origin === "structure" && entry.observes === "followRef" &&
      entry.path.at(-1) === "*" && carriesPicked(entry.label.confidentiality)
    );

  /** The join of what `observe` reads, off a transaction then abandoned. */
  const joinOf = (
    observe: (tx: IExtendedStorageTransaction) => void,
  ): unknown[] => {
    const tx = runtime.edit();
    try {
      observe(tx);
      return deriveFlowJoin(tx).confidentiality;
    } finally {
      tx.abort("observation only");
    }
  };

  /** A string cell whose value carries the picked label. */
  const labeledCell = async (cause: string) => {
    const tx = runtime.edit();
    const picked = runtime.getCell<string>(space, cause, {
      type: "string",
      ifc: { confidentiality: PICKED_CLAUSE },
      // deno-lint-ignore no-explicit-any -- `ifc` is not on the schema type
    } as any, tx);
    picked.set("c-alpha");
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    return picked;
  };

  const plainCell = async (cause: string, value: Record<string, unknown>) => {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, cause, undefined, tx);
    cell.set(value);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    return cell;
  };

  describe("a store created under a labeled transaction", () => {
    beforeEach(() => makeRuntime(true));

    /**
     * The shape a builtin's result store takes: named as the runtime's, its
     * result link set, then written whole — in a transaction that read a
     * labeled cell.
     */
    const storeCreatedUnderLabel = async (
      cause: string,
    ): Promise<Cell<unknown>> => {
      const picked = await labeledCell(`${cause}-picked`);
      const owner = await plainCell(`${cause}-owner`, { piece: true });

      const create = runtime.edit();
      picked.withTx(create).get();
      const store = runtime.getCell(space, `${cause}-store`, undefined, create);
      recordRuntimeOwnedStore(create, owner, store);
      setResultCell(store.withTx(create), owner);
      store.withTx(create).set({ pending: true, requestHash: "h1" });
      runtime.prepareTxForCommit(create);
      expect((await create.commit().settled).error).toBeUndefined();

      // What makes these cases the ones they are: the creation minted a
      // pointer template at the store's children, carrying the label.
      expect(hasPointerTemplate(store)).toBe(true);
      return store;
    };

    it("does not carry the label onto what a later write puts beside it", async () => {
      const store = await storeCreatedUnderLabel("beside");

      // Reads nothing labeled: sets the store again, and writes a document
      // that declares nothing.
      const later = runtime.edit();
      store.withTx(later).set({ pending: false, requestHash: "h1" });
      const other = runtime.getCell(space, "beside-other", undefined, later);
      other.withTx(later).set({ written: true });
      runtime.prepareTxForCommit(later);
      expect((await later.commit().settled).error).toBeUndefined();
    });

    it("still taints a probe of one of its members", async () => {
      const store = await storeCreatedUnderLabel("member");
      const link = store.getAsNormalizedFullLink();

      const join = joinOf((tx) => {
        tx.read({
          space,
          scope: link.scope,
          id: link.id,
          type: "application/json",
          path: ["value", "requestHash"],
        }, { meta: linkResolutionProbe });
      });
      expect(carriesPicked(join)).toBe(true);
    });
  });

  describe("a list whose membership was decided under a label", () => {
    beforeEach(() => makeRuntime(false));

    /**
     * A list declared as a coordinator's result (the filter/flatMap hook), set
     * to its members by a transaction that read the labeled criteria.
     * Returns a function that runs another reconcile.
     */
    const declaredList = async (cause: string) => {
      const criteria = await labeledCell(`${cause}-criteria`);
      const first = await plainCell(`${cause}-first`, { n: 1 });
      const second = await plainCell(`${cause}-second`, { n: 2 });
      const reconcile = async (members: Cell<unknown>[]) => {
        const tx = runtime.edit();
        criteria.withTx(tx).get();
        const list = runtime.getCell(space, `${cause}-list`, LIST_SCHEMA, tx);
        list.set(members.map((member) => member.withTx(tx)));
        tx.recordCfcStructureContainer({
          space,
          id: list.getAsNormalizedFullLink().id,
          scope: "space",
          path: [],
        });
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        return list;
      };
      const list = await reconcile([first, second]);
      expect(hasPointerTemplate(list)).toBe(true);
      return { list, first, second, reconcile };
    };

    it("taints a probe of the reference at a slot", async () => {
      const { list } = await declaredList("slot");
      const link = list.getAsNormalizedFullLink();

      const join = joinOf((tx) => {
        tx.read({
          space,
          scope: link.scope,
          id: link.id,
          type: "application/json",
          path: ["value", "0"],
        }, { meta: linkResolutionProbe });
      });
      expect(carriesPicked(join)).toBe(true);
    });

    it("taints resolving a slot without following it", async () => {
      const { list } = await declaredList("top");

      const join = joinOf((tx) => {
        resolveLink(
          runtime,
          tx,
          { ...list.getAsNormalizedFullLink(), path: ["0"] },
          "top",
        );
      });
      expect(carriesPicked(join)).toBe(true);
    });

    it("taints comparing a slot's reference after the list shrinks", async () => {
      // "Did the filter keep the second element?" — answered by resolving
      // the slot it would sit in and comparing links, with no content read.
      // The shrinking reconcile writes no reference at all.
      const { list, first, second, reconcile } = await declaredList("shrunk");
      await reconcile([first]);

      const join = joinOf((tx) => {
        list.withTx(tx).key(1).equals(second);
      });
      expect(carriesPicked(join)).toBe(true);
    });

    it("taints taking the whole list's references", async () => {
      // Which element sits at each slot, read as handles: the probe of the
      // list itself no longer supplies the membership, so this pins that
      // what the read does at each slot still does.
      const { list } = await declaredList("handles");

      const join = joinOf((tx) => {
        (list.withTx(tx).get() as unknown as Cell<unknown>[]).map((cell) =>
          cell.getAsNormalizedFullLink().id
        );
      });
      expect(carriesPicked(join)).toBe(true);
    });

    it("carries the label into a slot's content, dereferenced alone or after resolving the list", async () => {
      // A dereference retains the restrictions of the reference it follows
      // (§4.6.3, §8.2.4), so the reader carries the membership label whether
      // or not it resolved the list first.
      const { list } = await declaredList("deref");
      const { schema: _schema, ...link } = list.getAsNormalizedFullLink();
      const element = (tx: IExtendedStorageTransaction) =>
        runtime.getCellFromLink(link, undefined, tx);

      const alone = joinOf((tx) => {
        element(tx).key(0).key("n").get();
      });
      const resolvedFirst = joinOf((tx) => {
        element(tx).resolveAsCell().key(0).key("n").get();
      });
      expect(carriesPicked(alone)).toBe(true);
      expect(carriesPicked(resolvedFirst)).toBe(true);
    });

    it("carries secret criteria into a fixed index of unlabeled elements", async () => {
      // §18.7, "private query selects public targets": the elements carry no
      // label of their own, so the criteria reach the reader through the
      // reference alone.
      const { list, first } = await declaredList("public-targets");
      expect(entriesOf(first)).toEqual([]);
      const { schema: _schema, ...link } = list.getAsNormalizedFullLink();

      const join = joinOf((tx) => {
        runtime.getCellFromLink(link, undefined, tx).key(0).key("n").get();
      });
      expect(carriesPicked(join)).toBe(true);
    });

    it("carries nothing of the list into a read of the element itself", async () => {
      const { first } = await declaredList("direct");

      const join = joinOf((tx) => {
        first.withTx(tx).key("n").get();
      });
      expect(join).toEqual([]);
    });

    it("adds no integrity to what a dereference carries", async () => {
      const { list } = await declaredList("integrity");
      const { schema: _schema, ...link } = list.getAsNormalizedFullLink();

      const tx = runtime.edit();
      try {
        runtime.getCellFromLink(link, undefined, tx).key(0).key("n").get();
        expect(deriveFlowJoin(tx).integrity).toEqual([]);
      } finally {
        tx.abort("observation only");
      }
    });
  });

  describe("a list whose schema declares a pointer policy", () => {
    beforeEach(() => makeRuntime(false));

    // A declared `observes: "followRef"` entry has no `value` or `shape` twin,
    // so a reader who takes the references without opening them consumes it
    // through the list's own probe or not at all.
    it("taints taking its references, raw or as handles", async () => {
      const first = await plainCell("declared-first", { n: 1 });
      const second = await plainCell("declared-second", { n: 2 });
      const write = runtime.edit();
      const list = runtime.getCell(space, "declared-list", {
        type: "array",
        items: {
          asCell: ["cell"],
          ifc: { confidentiality: PICKED_CLAUSE, observes: "followRef" },
        },
        // deno-lint-ignore no-explicit-any -- `ifc` is not on the schema type
      } as any, write);
      list.set([first.withTx(write), second.withTx(write)]);
      runtime.prepareTxForCommit(write);
      expect((await write.commit().settled).error).toBeUndefined();

      expect(carriesPicked(joinOf((tx) => {
        list.withTx(tx).getRaw();
      }))).toBe(true);
      expect(carriesPicked(joinOf((tx) => {
        (list.withTx(tx).get() as unknown as Cell<unknown>[]).map((cell) =>
          cell.getAsNormalizedFullLink().id
        );
      }))).toBe(true);
    });
  });

  describe("a reference whose envelope holds a link entry beneath it", () => {
    // A link entry beneath a slot that holds a reference labels a position
    // of the reference's target: the document holding the reference has no
    // position there. A link write persists none, but a stored envelope can
    // hold them, as copies of the target's labels (CFC §18.7 legacy data).

    beforeEach(() => makeRuntime(true));

    const BENEATH_CLAUSE = cfcAtom.personalSpace(space);
    const SLOT_CLAUSE = cfcAtom.user(space);

    /** The schema of a holder whose `piece` is read as a handle. */
    const HOLDER_SCHEMA = {
      type: "object",
      properties: {
        piece: {
          type: "object",
          properties: { name: { type: "string" } },
          asCell: ["cell"],
        },
      },
    } as const;

    /**
     * Stores, without preparing a commit, a document labeling its `offers`
     * with the beneath clause, and a holder whose `piece` is a link to it,
     * labeled by `entries`.
     */
    const seededHolder = async (
      cause: string,
      entries: readonly Record<string, FabricValue>[],
    ) => {
      const schema = { type: "object" } as const;
      const schemaHash = internSchemaAsTaggedHashString(schema);
      const at = (id: `of:${string}`) =>
        ({ space, id, path: [], scope: "space" }) as const;
      const target = at(`of:${cause}-target`);
      const holder = at(`of:${cause}-holder`);
      const envelope = <Value, Entries>(value: Value, entries: Entries) => ({
        value,
        cfc: { version: 1, schemaHash, labelMap: { version: 1, entries } },
      });
      const seed = runtime.edit() as ExtendedStorageTransaction;
      // The envelopes are written with the runtime's own authority, and the
      // commit goes to the storage transaction, so nothing prepares it.
      seedStoredEnvelope(
        seed,
        target,
        envelope({ offers: [{ kind: "loom" }] }, [{
          path: ["offers"],
          origin: "declared",
          label: { confidentiality: [BENEATH_CLAUSE] },
        }]),
      );
      seedStoredEnvelope(
        seed,
        holder,
        envelope(
          {
            piece: { "/": { "link@1": { id: target.id, space, path: [] } } },
          },
          entries,
        ),
      );
      expect(
        seed.tx.write({ ...target, id: `cid:${schemaHash}` }, {
          value: schema,
        }).error,
      ).toBeUndefined();
      expect((await seed.tx.commit().settled).error).toBeUndefined();
      const cell = runtime.getCellFromLink<{ piece: Cell<unknown> }>(
        holder,
        HOLDER_SCHEMA,
      );
      await cell.sync();
      return cell;
    };

    /**
     * A holder as `seededHolder` stores it, with a link entry at the slot
     * holding `slotLabel` and one beneath it holding the beneath clause.
     */
    const storedHolder = async (cause: string, slotLabel: FabricValue) => {
      const cell = await seededHolder(cause, [
        { path: ["piece"], origin: "link", label: slotLabel },
        {
          path: ["piece", "offers"],
          origin: "link",
          label: { confidentiality: [BENEATH_CLAUSE] },
        },
      ]);
      expect(entriesOf(cell).map((entry) => entry.path)).toEqual([
        ["piece"],
        ["piece", "offers"],
      ]);
      return cell;
    };

    /** The pointer label a link write gives a slot: integrity alone. */
    const linkReferenceLabel = (cause: string) => ({
      integrity: [{
        type: CFC_ATOM_TYPE.LinkReference,
        source: { space, id: `of:${cause}-target`, path: [] },
        target: { space, id: `of:${cause}-holder`, path: ["piece"] },
      }],
    });

    it("carries the slot's own label, and not the entry beneath it, into taking the reference", async () => {
      const holder = await storedHolder("own", {
        confidentiality: [SLOT_CLAUSE],
      });

      const join = joinOf((tx) => {
        holder.withTx(tx).get().piece.getAsNormalizedFullLink();
      });
      expect(join).toEqual([SLOT_CLAUSE]);
    });

    it("commits a write into another space after taking the reference", async () => {
      const holder = await storedHolder(
        "elsewhere",
        linkReferenceLabel("elsewhere"),
      );
      const other = (await Identity.fromPassphrase("runner-cfc-probe-other"))
        .did();

      const tx = runtime.edit();
      holder.withTx(tx).get();
      runtime.getCell(other, "elsewhere-record", undefined, tx).set({
        added: true,
      });
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
    });

    it("names only a stamped slot, and not the entry beneath a reference, as the input of a refused write elsewhere", async () => {
      // Both holders carry the same clause, the pointer beneath its slot
      // and the stamped holder at its slot. Taking the pointer's reference
      // consumes nothing, so the refusal is the stamp's alone, and naming
      // the pointer would send whoever reads it after the wrong document.

      const pointer = await storedHolder(
        "named-pointer",
        linkReferenceLabel("named-pointer"),
      );
      const stamped = await seededHolder("named-stamped", [{
        path: ["piece"],
        origin: "structure",
        observes: "followRef",
        label: { confidentiality: [BENEATH_CLAUSE] },
      }]);
      const other = (await Identity.fromPassphrase("runner-cfc-probe-other"))
        .did();

      const tx = runtime.edit();
      pointer.withTx(tx).get().piece.getAsNormalizedFullLink();
      stamped.withTx(tx).get().piece.getAsNormalizedFullLink();
      runtime.getCell(other, "named-record", undefined, tx).set({
        added: true,
      });
      runtime.prepareTxForCommit(tx);
      const { error } = await tx.commit().settled;

      const refusals =
        (error as { refusals?: readonly CfcRefusalDetail[] } | undefined)
          ?.refusals ?? [];
      expect(refusals.map((detail) => detail.gate)).toEqual(["writer-fit"]);
      expect(
        refusals[0].offendingAtoms.map((atom) => JSON.parse(atom)),
      ).toEqual([BENEATH_CLAUSE]);
      expect(
        refusals[0].inputs.map((input) => [input.read.id, input.labelPath]),
      ).toEqual([[stamped.getAsNormalizedFullLink().id, ["piece"]]]);
      expect(refusals[0].attribution).toBe("complete");
    });

    it("carries a child's link entry into a probe of the container holding it", async () => {
      // The container holds no reference, so what sits beneath it is its
      // own: the link entry at its `piece` slot labels the reference there.

      const holder = await storedHolder("container", {
        confidentiality: [SLOT_CLAUSE],
      });
      const link = holder.getAsNormalizedFullLink();

      const join = joinOf((tx) => {
        tx.read({
          space,
          scope: link.scope,
          id: link.id,
          type: "application/json",
          path: ["value"],
        }, { meta: linkResolutionProbe });
      });
      expect(join).toEqual(expect.arrayContaining([SLOT_CLAUSE]));
    });

    it("carries the target's own label into reading through the reference", async () => {
      const holder = await storedHolder("through", {
        confidentiality: [SLOT_CLAUSE],
      });

      const join = joinOf((tx) => {
        holder.withTx(tx).get().piece.key("offers").get();
      });
      expect(join).toEqual(
        expect.arrayContaining([SLOT_CLAUSE, BENEATH_CLAUSE]),
      );
    });
  });
});

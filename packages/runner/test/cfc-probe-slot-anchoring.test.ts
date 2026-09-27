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

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import { recordRuntimeOwnedStore } from "../src/builtins/runtime-owned-store.ts";
import type { Cell } from "../src/cell.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { setResultCell } from "../src/result-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { linkResolutionProbe } from "../src/storage/reactivity-log.ts";

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
    expect((await tx.commit()).error).toBeUndefined();
    return picked;
  };

  const plainCell = async (cause: string, value: Record<string, unknown>) => {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, cause, undefined, tx);
    cell.set(value);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
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
      expect((await create.commit()).error).toBeUndefined();

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
      expect((await later.commit()).error).toBeUndefined();
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
        expect((await tx.commit()).error).toBeUndefined();
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
      expect((await write.commit()).error).toBeUndefined();

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
});

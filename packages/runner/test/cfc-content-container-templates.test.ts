/**
 * Which containers a transaction's creation of a store mints `*`-child
 * templates on, when that transaction read something labeled.
 *
 * A builtin mints its result store and writes it in one transaction:
 * `setResultCell` makes the document exist, so `Cell.set` writes `{}` and
 * then the members. The `{}` is pure link structure, vacuously, and minted
 * the membership templates of docs/specs/cfc-template-population.md §3.1 on
 * a store that ends the transaction holding values. Every later transaction
 * that resolved its way into the store — `Cell.set` probing the root, a
 * stale-writeback guard probing a field — consumed the `followRef` template
 * and carried the creation's label onto every other document it wrote. A
 * `sqliteQuery` whose parameter was labeled on its first issue refused each
 * row it settled.
 *
 * A container filled with values, and no reference, mints no `followRef`
 * template — there is no reference at any of its slots to label — and keeps
 * the templates through which a read of a member, present or absent,
 * consumes the label. One holding a reference mints all three, and still
 * taints whoever observes which reference sits at one of its slots.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import { recordRuntimeOwnedStore } from "../src/builtins/runtime-owned-store.ts";
import type { Cell } from "../src/cell.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import { setResultCell } from "../src/result-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { linkResolutionProbe } from "../src/storage/reactivity-log.ts";

const signer = await Identity.fromPassphrase("runner-cfc-content-containers");
const space = signer.did();

/** The connector spelling: the owner, and a `Resource` naming the class. */
const PICKED_CLAUSE = [
  space,
  { type: CFC_ATOM_TYPE.Resource, class: "message", subject: space },
];

type StoredEntry = {
  path: string[];
  label: { confidentiality?: unknown[] };
  origin?: string;
  observes?: string;
};

describe("a store created under a labeled transaction", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      // The rung where a writer-fit misfit refuses rather than flags, with
      // the dials every preset deployment pins.
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
      cfcWriteFloor: "enforce",
      cfcPolicyEvaluation: "enforce",
      cfcLabelMetadataProtection: "enforce",
      cfcDeclaredMonotonicity: "enforce",
    });
  });

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

  const templatesOf = (cell: Cell<unknown>): StoredEntry[] =>
    entriesOf(cell).filter((entry) =>
      entry.origin === "structure" && entry.path.at(-1) === "*"
    );

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

  /** The join of what `observe` reads, taken off a transaction that is then
   * abandoned. */
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

  /**
   * The shape a builtin's result store takes: named as the runtime's, its
   * result link set, then written whole with `value` — in a transaction that
   * read a labeled cell. Returns the store and a cell it may reference.
   */
  const storeCreatedUnderLabel = async (
    cause: string,
    value: (element: Cell<unknown>) => Record<string, unknown>,
  ): Promise<{ store: Cell<unknown>; element: Cell<unknown> }> => {
    const seed = runtime.edit();
    const picked = runtime.getCell<string>(space, `${cause}-picked`, {
      type: "string",
      ifc: { confidentiality: PICKED_CLAUSE },
      // deno-lint-ignore no-explicit-any -- `ifc` is not on the schema type
    } as any, seed);
    picked.set("c-alpha");
    const owner = runtime.getCell(space, `${cause}-owner`, undefined, seed);
    owner.set({ piece: true });
    const element = runtime.getCell(space, `${cause}-element`, undefined, seed);
    element.set({ n: 1 });
    runtime.prepareTxForCommit(seed);
    expect((await seed.commit()).error).toBeUndefined();

    const create = runtime.edit();
    picked.withTx(create).get();
    const store = runtime.getCell(space, `${cause}-store`, undefined, create);
    recordRuntimeOwnedStore(create, owner, store);
    setResultCell(store.withTx(create), owner);
    store.withTx(create).set(value(element));
    runtime.prepareTxForCommit(create);
    expect((await create.commit()).error).toBeUndefined();
    return { store, element };
  };

  const fieldAddress = (store: Cell<unknown>, path: string[]) => {
    const link = store.getAsNormalizedFullLink();
    return {
      space,
      scope: link.scope,
      id: link.id,
      type: "application/json" as const,
      path: ["value", ...path],
    };
  };

  describe("and filled with values", () => {
    const values = () => ({ pending: true, requestHash: "h1" });

    it("mints no pointer template", async () => {
      const { store } = await storeCreatedUnderLabel("values-mint", values);

      const classes = templatesOf(store).map((entry) => entry.observes);
      expect(classes).not.toContain("followRef");
      // What makes the next case mean something: the other two are here.
      expect(classes).toContain("shape");
      expect(classes).toContain("value");
    });

    it("still taints a read of a member, present or absent", async () => {
      const { store } = await storeCreatedUnderLabel("values-read", values);

      expect(carriesPicked(joinOf((tx) => {
        tx.readOrThrow(fieldAddress(store, ["requestHash"]));
      }))).toBe(true);
      // Which members exist was decided under the label too.
      expect(carriesPicked(joinOf((tx) => {
        tx.readOrThrow(fieldAddress(store, ["error"]), { nonRecursive: true });
      }))).toBe(true);
    });

    it("does not carry the label onto what a later write puts beside it", async () => {
      const { store } = await storeCreatedUnderLabel("values-beside", values);

      // Reads nothing labeled: sets the store again, and writes a document
      // that declares nothing.
      const later = runtime.edit();
      store.withTx(later).set({ pending: false, requestHash: "h1" });
      const other = runtime.getCell(space, "values-other", undefined, later);
      other.withTx(later).set({ written: true });
      runtime.prepareTxForCommit(later);
      expect((await later.commit()).error).toBeUndefined();
    });
  });

  describe("and filled with values and a reference", () => {
    it("mints the pointer template", async () => {
      const { store } = await storeCreatedUnderLabel(
        "mixed-mint",
        (element) => ({ first: element, pending: true }),
      );

      expect(
        templatesOf(store).some((entry) =>
          entry.observes === "followRef" &&
          carriesPicked(entry.label.confidentiality)
        ),
      ).toBe(true);
    });
  });

  describe("and filled with references", () => {
    // The pointer-identity channel the templates close (SC-8): which
    // reference sits at a slot — or that none does — was decided under the
    // creating transaction's label.
    const references = (element: Cell<unknown>) => ({ first: element });

    it("mints the child templates", async () => {
      const { store } = await storeCreatedUnderLabel("refs-mint", references);

      expect(
        templatesOf(store).some((entry) =>
          entry.observes === "followRef" &&
          carriesPicked(entry.label.confidentiality)
        ),
      ).toBe(true);
    });

    it("taints a probe of the reference at a slot", async () => {
      const { store } = await storeCreatedUnderLabel("refs-probe", references);

      const join = joinOf((tx) => {
        tx.read(fieldAddress(store, ["first"]), { meta: linkResolutionProbe });
      });
      expect(carriesPicked(join)).toBe(true);
    });

    it("taints comparing an absent slot's reference", async () => {
      // No content read follows: `equals` resolves the slot and compares
      // links, so the resolver's own probes are the only observation.
      const { store, element } = await storeCreatedUnderLabel(
        "refs-equals",
        references,
      );

      const join = joinOf((tx) => {
        store.withTx(tx).key("second").equals(element);
      });
      expect(carriesPicked(join)).toBe(true);
    });
  });
});

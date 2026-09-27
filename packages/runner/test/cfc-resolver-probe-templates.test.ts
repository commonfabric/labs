/**
 * What a transaction that writes a store the runtime owns carries from the
 * store's own `*`-child templates when it merely resolves its way to the
 * store.
 *
 * A builtin mints its result store and writes it in one transaction, and
 * when that transaction read something labeled, the store's creation stamps
 * membership templates carrying the label (docs/specs/cfc-template-population.md
 * §3.1). A later transaction that writes the store again resolves the store's
 * links first, and the resolver's probes found no link there — so no
 * dereference trace covered them and they joined the templates' label as if
 * they were standalone pointer observations. That transaction then carried
 * the creation's label onto every other document it wrote, and a document
 * that declares nothing refused it: a `sqliteQuery` whose parameter was
 * labeled on its first issue refused every row it settled.
 *
 * The resolver's probes are resolution machinery, which is how the read
 * ceiling already treats them (`dereferenceResolutionProbe`); the read they
 * make on behalf of the caller consumes the templates' `value` and `shape`
 * twins where it has not been excluded itself. A probe the resolver did not
 * issue still observes which reference sits at a slot, and still consumes
 * the template.
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
import { linkResolutionProbe } from "../src/storage/reactivity-log.ts";

const signer = await Identity.fromPassphrase("runner-cfc-resolver-probes");
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

  const carriesPicked = (atoms: readonly unknown[] | undefined): boolean =>
    PICKED_CLAUSE.every((atom) =>
      (atoms ?? []).some((held) =>
        JSON.stringify(held, Object.keys(held as object).sort()) ===
          JSON.stringify(atom, Object.keys(atom as object).sort())
      )
    );

  /**
   * The shape a builtin's result store takes: named as the runtime's, its
   * result link set, then written whole — all in a transaction that read a
   * labeled cell. Returns the store.
   */
  const storeCreatedUnderLabel = async (
    cause: string,
  ): Promise<Cell<unknown>> => {
    const seed = runtime.edit();
    const picked = runtime.getCell<string>(space, `${cause}-picked`, {
      type: "string",
      ifc: { confidentiality: PICKED_CLAUSE },
      // deno-lint-ignore no-explicit-any -- `ifc` is not on the schema type
    } as any, seed);
    picked.set("c-alpha");
    const owner = runtime.getCell(space, `${cause}-owner`, undefined, seed);
    owner.set({ piece: true });
    runtime.prepareTxForCommit(seed);
    expect((await seed.commit()).error).toBeUndefined();

    const create = runtime.edit();
    picked.withTx(create).get();
    const store = runtime.getCell(space, `${cause}-store`, undefined, create);
    recordRuntimeOwnedStore(create, owner, store);
    setResultCell(store.withTx(create), owner);
    store.withTx(create).set({ pending: true, requestHash: "h1" });
    runtime.prepareTxForCommit(create);
    expect((await create.commit()).error).toBeUndefined();

    // What makes this the case it is: the creation minted a `followRef`
    // template at the store's children, carrying the picked label. Were no
    // template minted, the cases below would pass for a different reason.
    expect(
      entriesOf(store).some((entry) =>
        entry.path.length === 1 && entry.path[0] === "*" &&
        entry.origin === "structure" && entry.observes === "followRef" &&
        carriesPicked(entry.label.confidentiality)
      ),
    ).toBe(true);
    return store;
  };

  it("does not carry that label onto what a later write puts beside it", async () => {
    const store = await storeCreatedUnderLabel("beside");

    // Reads nothing labeled: sets the store again, and writes a document
    // that declares nothing.
    const later = runtime.edit();
    store.withTx(later).set({ pending: false, requestHash: "h1" });
    const other = runtime.getCell(space, "beside-other", undefined, later);
    other.withTx(later).set({ written: true });
    runtime.prepareTxForCommit(later);
    const committed = await later.commit();
    expect(committed.error).toBeUndefined();
  });

  it("still taints a probe that observes a slot's reference on its own", async () => {
    // The pointer-identity channel the template closes (SC-8): a link probe
    // no content read follows observes which reference sits at the slot,
    // and that was decided under the creation's label. Only the resolver's
    // own probes are machinery.
    const store = await storeCreatedUnderLabel("standalone");
    const link = store.getAsNormalizedFullLink();

    const tx = runtime.edit();
    try {
      tx.read({
        space,
        scope: link.scope,
        id: link.id,
        type: "application/json",
        path: ["value", "requestHash"],
      }, { meta: linkResolutionProbe });
      expect(carriesPicked(deriveFlowJoin(tx).confidentiality)).toBe(true);
    } finally {
      tx.abort("probe only");
    }
  });
});

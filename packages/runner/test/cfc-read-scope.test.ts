import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("runner-cfc-read-scope");

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
};

type StoredDocument = {
  value?: unknown;
  cfc?: { labelMap?: { entries: StoredEntry[] } };
} | undefined;

const storedDocument = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  id: string,
): StoredDocument =>
  (storageManager.open(signer.did()).replica as unknown as {
    getDocument(id: string): StoredDocument;
  }).getDocument(id);

const replicaEntries = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  id: string,
): StoredEntry[] =>
  storedDocument(storageManager, id)?.cfc?.labelMap?.entries ?? [];

const newRuntime = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
) =>
  new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcFlowLabels: "persist",
  });

// Seed one record whose `description` leaf carries a confidentiality label
// while its `amount` sibling carries none.
const seedRecord = async (runtime: Runtime, name: string) => {
  const seed = runtime.edit();
  const sourceCell = runtime.getCell(
    signer.did(),
    name,
    {
      type: "object",
      properties: {
        description: { type: "string" },
        amount: { type: "number" },
      },
    },
    seed,
  );
  const sourceId = sourceCell.getAsNormalizedFullLink().id;
  writeSeedEnvelopeDoc(seed, signer.did());
  seedStoredEnvelope(seed, {
    space: signer.did(),
    scope: "space",
    id: sourceId,
    path: [],
  }, {
    value: { description: "private note", amount: 12 },
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [{
          path: ["description"],
          label: { confidentiality: ["secret"] },
        }],
      },
    },
  });
  expect((await seed.commit()).ok).toBeDefined();
};

describe("CFC flow-join read scope", () => {
  // The flow join quantifies over what a transaction actually read. A labelled
  // leaf taints a read of itself or of any ancestor, and must not taint a read
  // of a sibling leaf — otherwise a computation that deliberately avoids a
  // confidential field could not prove so by its read set, and strict mode
  // would refuse the untainted aggregate along with the leak.

  it("does not taint a sibling-leaf read with a labelled descendant elsewhere", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedRecord(runtime, "read-scope-sibling-source");

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      const source = runtime.getCell(
        signer.did(),
        "read-scope-sibling-source",
        undefined,
        tx,
      );
      const amount = source.key("amount").getRaw() as number;
      expect(amount).toBe(12);

      const derived = runtime.getCell(
        signer.did(),
        "read-scope-sibling-derived",
        undefined,
        tx,
      );
      derived.set({ doubled: amount * 2 });
      const derivedId = derived.getAsNormalizedFullLink().id;
      const sourceId = source.getAsNormalizedFullLink().id;
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      // The sibling that was not read carries the atom the derived document
      // must not pick up, and the stored value pins the derived document the
      // entries below are read from.
      expect(
        replicaEntries(storageManager, sourceId)
          .flatMap((e) => e.label.confidentiality ?? []),
      ).toContainEqual("secret");
      expect(storedDocument(storageManager, derivedId)?.value).toEqual({
        doubled: 24,
      });
      const flowEntry = replicaEntries(storageManager, derivedId)
        .find((e) => e.origin === "derived");
      expect(flowEntry?.label.confidentiality ?? []).not.toContainEqual(
        "secret",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("taints a root read whose descendant carries the label", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedRecord(runtime, "read-scope-root-source");

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      const source = runtime.getCell(
        signer.did(),
        "read-scope-root-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { amount: number };

      const derived = runtime.getCell(
        signer.did(),
        "read-scope-root-derived",
        undefined,
        tx,
      );
      derived.set({ doubled: raw.amount * 2 });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message ?? "").toContain(
        "writer-fit confidentiality misfit",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

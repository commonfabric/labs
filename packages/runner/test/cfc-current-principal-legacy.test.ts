import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { cfcAtom } from "@commonfabric/api/cfc";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";

import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { internalVerifierRead } from "../src/storage/reactivity-log.ts";

const owner = await Identity.fromPassphrase("old-symbolic-owner");
const visitor = await Identity.fromPassphrase("old-symbolic-visitor");
const placeholder = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: { __ctCurrentPrincipal: true },
} as const;

/** Restores committed envelope bytes without running creation preparation. */
const setup = async (legacy: "both" | "schema" | "label") => {
  const storage = StorageManager.emulate({ as: owner });
  const runtime = new Runtime({
    apiUrl: new URL("http://toolshed.test"),
    storageManager: storage,
    cfcEnforcementMode: "enforce-strict",
    cfcFlowLabels: "persist",
    cfcReadMaxConfidentiality: [cfcAtom.user(visitor.did())],
    trustSnapshotProvider: () => ({
      id: visitor.did(),
      actingPrincipal: visitor.did(),
    }),
  });
  const schema = {
    type: "array",
    items: { type: "string" },
    ifc: {
      confidentiality: [
        legacy === "label" ? cfcAtom.user(owner.did()) : placeholder,
      ],
    },
  } as const;
  const schemaHash = internSchemaAsTaggedHashString(schema);
  if (legacy === "both") {
    expect(schemaHash).toBe("fid1:HfqVjDaw4b30p0avE3UWkUQgIeX6M56ClpbDa-OQbPw");
  }
  const link = {
    space: owner.did(),
    id: "of:fid1:ASMfHvprfOUJE-N7ESxSpw542UA28XUqaEQhUgOLXa4",
    path: [],
    scope: "space",
  } as const;
  const envelope = {
    cfc: {
      labelMap: {
        entries: [{
          label: {
            confidentiality: [
              legacy === "schema" ? cfcAtom.user(owner.did()) : placeholder,
            ],
          },
          origin: "declared",
          path: [],
        }],
        version: 1,
      },
      schemaHash,
      version: 1,
    },
    value: ["Owner secret"],
  };
  const seed = runtime.edit() as ExtendedStorageTransaction;
  expect(seed.tx.write(link, envelope).error).toBeUndefined();
  expect(
    seed.tx.write({ ...link, id: `cid:${schemaHash}` }, { value: schema })
      .error,
  )
    .toBeUndefined();
  expect((await seed.tx.commit()).error).toBeUndefined();
  await storage.synced();
  const source = runtime.getCellFromLink<string[]>(link);
  await source.sync();
  return {
    runtime,
    source,
    schema,
    envelope,
    readEnvelope() {
      const tx = runtime.edit();
      try {
        return tx.readOrThrow(link, { meta: internalVerifierRead });
      } finally {
        tx.abort();
      }
    },
    async dispose() {
      await storage.synced();
      await runtime.dispose();
      await storage.close();
    },
  };
};

describe("cfc-current-principal-legacy", () => {
  for (const legacy of ["both", "schema", "label"] as const) {
    it(`refuses to bind a stored ${legacy} placeholder to a later writer`, async () => {
      const fixture = await setup(legacy);
      try {
        expect(() => fixture.source.get()).toThrow(/read ceiling/);
        const tx = fixture.runtime.edit();
        fixture.source.asSchema(fixture.schema).withTx(tx).push(
          "Visitor submission",
        );
        const result = await tx.commit();
        expect(result.error?.message).toContain(
          "Stored CurrentPrincipal confidentiality",
        );
        expect(fixture.readEnvelope()).toEqual(fixture.envelope);
        expect(() => fixture.source.get()).toThrow(/read ceiling/);
      } finally {
        await fixture.dispose();
      }
    });
  }

  it("refuses to derive a held reference from an unresolved stored creator", async () => {
    const fixture = await setup("both");
    try {
      const tx = fixture.runtime.edit();
      const copy = fixture.runtime.getCell(owner.did(), "legacy reference", {
        type: "object",
        properties: { books: { asCell: ["readonly"] } },
      }, tx);
      copy.set({ books: fixture.source.asSchema(fixture.schema) });
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "Stored CurrentPrincipal confidentiality",
      );
      expect(fixture.readEnvelope()).toEqual(fixture.envelope);
    } finally {
      await fixture.dispose();
    }
  });
});

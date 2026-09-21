import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";

import { stageOwnerPolicyAdoption } from "../src/cfc/owner-adoption.ts";
import { loadStoredCfcEnvelope } from "../src/cfc/prepare.ts";
import { seedStoredEnvelope } from "./cfc-seed-envelope.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { registerSchemaDocument } from "../src/schema-registry.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const owner = await Identity.fromPassphrase("owner-adoption-owner");
const other = await Identity.fromPassphrase("owner-adoption-other");
const schema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      ifc: {
        ownerPrincipal: { __ctCurrentPrincipal: true },
        addIntegrity: [{
          kind: "represents-principal",
          subject: { __ctCurrentPrincipal: true },
        }],
        writeAuthorizedBy: {
          __ctWriterIdentityOf: { file: "/profile.tsx", path: ["setName"] },
        },
      },
    },
  },
} as const satisfies JSONSchema;

describe("explicit owner policy adoption", () => {
  let runtime: Runtime;
  let manager: StorageManager;
  beforeEach(async () => {
    manager = StorageManager.emulate({ as: owner });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: manager,
    });
    const tx = runtime.edit();
    tx.setCfcImplementationIdentity({
      kind: "verified",
      moduleIdentity: "profile-module",
      sourceFile: "/profile.tsx",
      bindingPath: ["setName"],
    });
    runtime.getCell(owner.did(), "profile", schema, tx).set({
      name: "Saved name",
    });
    runtime.getCell(owner.did(), "legacy", undefined, tx).set("Saved name");
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
  });
  afterEach(async () => {
    await runtime.dispose();
  });

  it("keeps the existing value and persists the source field's protection", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(owner.did(), "profile", undefined, tx).key(
      "name",
    ).getAsNormalizedFullLink();
    const target = runtime.getCell(owner.did(), "legacy", undefined, tx)
      .getAsNormalizedFullLink();
    expect(loadStoredCfcEnvelope(tx, target).status).toBe("none");
    stageOwnerPolicyAdoption(tx, source, target, "Saved name");
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    const attack = runtime.edit();
    expect(loadStoredCfcEnvelope(attack, target).status).toBe("loaded");
    runtime.getCellFromLink(target, undefined, attack).set("Other name");
    runtime.prepareTxForCommit(attack);
    expect((await attack.commit()).error?.message).toContain(
      "writeAuthorizedBy",
    );
    expect(runtime.getCell(owner.did(), "legacy").get()).toBe("Saved name");
  });

  it("refuses a principal change after staging", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(owner.did(), "profile", undefined, tx).key(
      "name",
    ).getAsNormalizedFullLink();
    const target = runtime.getCell(owner.did(), "legacy", undefined, tx)
      .getAsNormalizedFullLink();
    stageOwnerPolicyAdoption(tx, source, target, "Saved name");
    tx.setCfcTrustSnapshot({
      id: "changed-principal",
      actingPrincipal: other.did(),
    });
    runtime.prepareTxForCommit(tx);
    const result = await tx.commit();
    expect(result.error?.message).toContain("writeAuthorizedBy");
    const read = runtime.edit();
    expect(loadStoredCfcEnvelope(read, target).status).toBe("none");
    expect(read.readValueOrThrow(target)).toBe("Saved name");
    read.abort();
  });

  it("refuses protection installed after staging", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(owner.did(), "profile", undefined, tx).key(
      "name",
    ).getAsNormalizedFullLink();
    const target = runtime.getCell(owner.did(), "legacy", undefined, tx)
      .getAsNormalizedFullLink();
    stageOwnerPolicyAdoption(tx, source, target, "Saved name");
    const storedSchema = { type: "string" } as const;
    const schemaHash = internSchemaAsTaggedHashString(storedSchema);
    registerSchemaDocument(schemaHash, storedSchema);
    seedStoredEnvelope(tx, { ...target, path: ["cfc"] }, {
      version: 1,
      schemaHash,
      labelMap: { version: 1, entries: [] },
    });
    expect(loadStoredCfcEnvelope(tx, target).status).toBe("loaded");
    runtime.prepareTxForCommit(tx);
    const result = await tx.commit();
    expect(result.error?.message).toContain("writeAuthorizedBy");
    const read = runtime.edit();
    expect(loadStoredCfcEnvelope(read, target).status).toBe("none");
    expect(read.readValueOrThrow(target)).toBe("Saved name");
    read.abort();
  });

  it("rejects an adoption claim submitted through the public transaction API", async () => {
    const tx = runtime.edit();
    const cell = runtime.getCell(
      owner.did(),
      "legacy",
      schema.properties!.name,
      tx,
    );
    tx.recordCfcWritePolicyInput({
      kind: "owner-adoption",
      owner: owner.did(),
      target: cell.getAsNormalizedFullLink(),
      value: "Saved name",
    });
    cell.set("Saved name");
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error?.message).toContain("writeAuthorizedBy");
  });

  it("requires the source field's owner", () => {
    const tx = runtime.edit();
    tx.setCfcTrustSnapshot({ id: "other", actingPrincipal: other.did() });
    const source = runtime.getCell(owner.did(), "profile", undefined, tx).key(
      "name",
    ).getAsNormalizedFullLink();
    const target = runtime.getCell(owner.did(), "legacy", undefined, tx)
      .getAsNormalizedFullLink();
    expect(() => stageOwnerPolicyAdoption(tx, source, target, "Saved name"))
      .toThrow("requires the field's owner");
    tx.abort();
  });

  it("rejects a later value overwrite in the adoption transaction", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(owner.did(), "profile", undefined, tx).key(
      "name",
    ).getAsNormalizedFullLink();
    const cell = runtime.getCell(owner.did(), "legacy", undefined, tx);
    stageOwnerPolicyAdoption(
      tx,
      source,
      cell.getAsNormalizedFullLink(),
      "Saved name",
    );
    cell.set("Other name");
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error?.message).toContain("writeAuthorizedBy");
  });
  it("rejects additional authorship claims instead of endorsing the old bytes", async () => {
    const seed = runtime.edit();
    seed.setCfcImplementationIdentity({
      kind: "verified",
      moduleIdentity: "profile-module",
      sourceFile: "/profile.tsx",
      bindingPath: ["setName"],
    });
    const withAuthorship = {
      ...schema,
      properties: {
        name: {
          ...schema.properties.name,
          ifc: {
            ...schema.properties.name.ifc,
            addIntegrity: [...schema.properties.name.ifc.addIntegrity, {
              kind: "authored-by",
              subject: owner.did(),
            }],
          },
        },
      },
    };
    const source = runtime.getCell(
      owner.did(),
      "extra-authorship",
      withAuthorship,
      seed,
    );
    source.set({ name: "Saved name" });
    runtime.prepareTxForCommit(seed);
    expect((await seed.commit()).error).toBeUndefined();
    const tx = runtime.edit();
    const target = runtime.getCell(owner.did(), "legacy", undefined, tx)
      .getAsNormalizedFullLink();
    expect(() =>
      stageOwnerPolicyAdoption(
        tx,
        source.key("name").getAsNormalizedFullLink(),
        target,
        "Saved name",
      )
    ).toThrow("supported stored owner policy");
    expect(loadStoredCfcEnvelope(tx, target).status).toBe("none");
    tx.abort();
  });

  it("refuses an inherited writer requirement instead of dropping it", async () => {
    const seed = runtime.edit();
    seed.setCfcImplementationIdentity({
      kind: "verified",
      moduleIdentity: "profile-module",
      sourceFile: "/profile.tsx",
      bindingPath: ["setName"],
    });
    const source = runtime.getCell(owner.did(), "ancestor-policy", {
      ...schema,
      ifc: { writeAuthorizedBy: schema.properties.name.ifc.writeAuthorizedBy },
    }, seed);
    source.set({ name: "Saved name" });
    runtime.prepareTxForCommit(seed);
    expect((await seed.commit()).error).toBeUndefined();
    const tx = runtime.edit();
    const target = runtime.getCell(owner.did(), "legacy", undefined, tx)
      .getAsNormalizedFullLink();
    expect(() =>
      stageOwnerPolicyAdoption(
        tx,
        source.key("name").getAsNormalizedFullLink(),
        target,
        "Saved name",
      )
    ).toThrow("ancestor protection");
    tx.abort();
  });

  it("conflicts when another transaction changes the inspected value", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(owner.did(), "profile", undefined, tx).key(
      "name",
    ).getAsNormalizedFullLink();
    const target = runtime.getCell(owner.did(), "legacy", undefined, tx)
      .getAsNormalizedFullLink();
    stageOwnerPolicyAdoption(tx, source, target, "Saved name");
    const concurrent = runtime.edit();
    concurrent.writeValueOrThrow(target, "Concurrent name");
    runtime.prepareTxForCommit(concurrent);
    expect((await concurrent.commit()).error).toBeUndefined();
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeDefined();
    const read = runtime.edit();
    expect(loadStoredCfcEnvelope(read, target).status).toBe("none");
    expect(read.readValueOrThrow(target)).toBe("Concurrent name");
    read.abort();
  });

  it("refuses existing and unreadable target protection without replacing it", () => {
    for (
      const metadata of [{ version: 99 }, {
        version: 1,
        schemaHash: "missing-schema",
        labelMap: { version: 1, entries: [] },
      }]
    ) {
      const tx = runtime.edit();
      const source = runtime.getCell(owner.did(), "profile", undefined, tx).key(
        "name",
      ).getAsNormalizedFullLink();
      const target = runtime.getCell(owner.did(), "legacy", undefined, tx)
        .getAsNormalizedFullLink();
      seedStoredEnvelope(tx, { ...target, path: ["cfc"] }, metadata);
      expect(() => stageOwnerPolicyAdoption(tx, source, target, "Saved name"))
        .toThrow();
      expect(tx.readOrThrow({ ...target, path: ["cfc"] })).toEqual(metadata);
      tx.abort();
    }
  });
});

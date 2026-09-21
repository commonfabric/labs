import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { recordNewProtectedDefaults } from "../src/cfc/default-initialization.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { runtimeWritePolicyAuthorization } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("protected-initialization-owner");
const other = await Identity.fromPassphrase("protected-initialization-other");
const writer = {
  __ctWriterIdentityOf: { file: "/trusted.tsx", path: ["save"] },
};
const field: JSONSchema = {
  type: "array",
  items: { type: "string" },
  default: [],
  ifc: {
    ownerPrincipal: signer.did(),
    addIntegrity: [{ kind: "represents-principal", subject: signer.did() }],
    writeAuthorizedBy: writer,
  },
};
const schema: JSONSchema = {
  type: "object",
  properties: { guarded: field, note: { type: "string" } },
};
const previousSchema: JSONSchema = {
  type: "object",
  properties: { note: { type: "string" } },
};

describe("protected initialization", () => {
  let runtime: Runtime;
  let manager: StorageManager;
  beforeEach(() => {
    manager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: manager,
      trustSnapshotProvider: () => ({
        id: "owner",
        actingPrincipal: signer.did(),
      }),
    });
  });
  afterEach(async () => {
    await runtime.dispose();
  });

  async function seed(value: FabricValue) {
    const tx = runtime.edit();
    const cell = runtime.getCell(signer.did(), "argument", undefined, tx);
    cell.set(value);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
  }

  it("persists a new default's policy and refuses a later plain-schema write", async () => {
    await seed({ note: "saved" });
    const tx = runtime.edit();
    const cell = runtime.getCell(signer.did(), "argument", schema, tx);
    const link = cell.getAsNormalizedFullLink();
    recordNewProtectedDefaults(tx, link, previousSchema, schema, {
      guarded: [],
    }, { guarded: [], note: "saved" });
    cell.set({ guarded: [], note: "saved" });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();

    const attack = runtime.edit();
    expect(readStoredCfcMetadata(attack, link)).toBeDefined();
    runtime.getCell(signer.did(), "argument", undefined, attack).key("guarded")
      .set(["other"]);
    runtime.prepareTxForCommit(attack);
    expect((await attack.commit()).error?.message).toContain(
      "writeAuthorizedBy",
    );
    expect(runtime.getCell(signer.did(), "argument").get()).toEqual({
      guarded: [],
      note: "saved",
    });
  });

  it("refuses default initialization when the argument document is unreadable", async () => {
    const tx = runtime.edit();
    const cell = runtime.getCell(signer.did(), "argument", schema, tx);
    recordNewProtectedDefaults(
      tx,
      cell.getAsNormalizedFullLink(),
      previousSchema,
      schema,
      { guarded: [] },
      { guarded: [] },
    );
    cell.set({ guarded: [] });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error?.message).toContain("writeAuthorizedBy");
  });

  it("rejects the public seed-provenance marker as initialization authority", async () => {
    const tx = runtime.edit();
    const cell = runtime.getCell(signer.did(), "argument", schema, tx);
    const target = { ...cell.getAsNormalizedFullLink(), path: [] };
    tx.recordCfcWritePolicyInput({
      kind: "structural-provenance",
      claim: "runtime.setup.seed-materialization",
      target,
      sources: [target],
    });
    cell.set({ guarded: [] });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error?.message).toContain("writeAuthorizedBy");
  });

  for (const initial of ["saved", null, undefined, []]) {
    it(`refuses to adopt an existing ${String(initial)} value as a seed`, async () => {
      await seed({ guarded: initial });
      const tx = runtime.edit();
      const cell = runtime.getCell(signer.did(), "argument", schema, tx);
      const link = cell.getAsNormalizedFullLink();
      tx.recordCfcWritePolicyInput({
        kind: "initialization",
        mode: "default",
        target: { ...link, path: ["guarded"] },
        value: [],
      }, runtimeWritePolicyAuthorization);
      cell.set({ guarded: [] });
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error?.message).toContain("writeAuthorizedBy");
    });
  }

  it("rejects a publicly recorded initialization claim", async () => {
    await seed({ note: "saved" });
    const tx = runtime.edit();
    const cell = runtime.getCell(signer.did(), "argument", schema, tx);
    tx.recordCfcWritePolicyInput({
      kind: "initialization",
      mode: "default",
      target: { ...cell.getAsNormalizedFullLink(), path: ["guarded"] },
      value: [],
    });
    cell.set({ guarded: [] });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error?.message).toContain("writeAuthorizedBy");
  });

  it("rejects an overwrite after a permitted initialization in the same transaction", async () => {
    await seed({ note: "saved" });
    const tx = runtime.edit();
    const cell = runtime.getCell(signer.did(), "argument", schema, tx);
    recordNewProtectedDefaults(
      tx,
      cell.getAsNormalizedFullLink(),
      previousSchema,
      schema,
      { guarded: [] },
      { guarded: [] },
    );
    cell.set({ guarded: [] });
    cell.key("guarded").set(["changed"]);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error?.message).toContain("writeAuthorizedBy");
  });

  it("rejects deleting and recreating an existing field in one transaction", async () => {
    await seed({ guarded: ["saved"] });
    const tx = runtime.edit();
    const plain = runtime.getCell(signer.did(), "argument", undefined, tx);
    plain.set({});
    const cell = plain.asSchema(schema);
    recordNewProtectedDefaults(
      tx,
      cell.getAsNormalizedFullLink(),
      previousSchema,
      schema,
      { guarded: [] },
      { guarded: [] },
    );
    cell.set({ guarded: [] });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error?.message).toContain("writeAuthorizedBy");
  });

  it("rejects replacing an ancestor before recreating a protected child", async () => {
    await seed({ guarded: ["saved"] });
    const tx = runtime.edit();
    const cell = runtime.getCell(signer.did(), "argument", schema, tx);
    const link = cell.getAsNormalizedFullLink();
    tx.writeValueOrThrow(link, {});
    recordNewProtectedDefaults(tx, link, previousSchema, schema, {
      guarded: [],
    }, { guarded: [] });
    cell.key("guarded").set([]);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error?.message).toContain("writeAuthorizedBy");
  });

  it("rejects an ancestor overwrite after initializing a protected child", async () => {
    await seed({ note: "saved" });
    const tx = runtime.edit();
    const cell = runtime.getCell(signer.did(), "argument", schema, tx);
    const link = cell.getAsNormalizedFullLink();
    recordNewProtectedDefaults(tx, link, previousSchema, schema, {
      guarded: [],
    }, { guarded: [] });
    cell.key("guarded").set([]);
    tx.writeValueOrThrow(link, { guarded: ["changed"] });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error?.message).toContain("writeAuthorizedBy");
  });

  it("retains the owner gate during initialization", async () => {
    await seed({ note: "saved" });
    const tx = runtime.edit();
    tx.setCfcTrustSnapshot({ id: "other", actingPrincipal: other.did() });
    const cell = runtime.getCell(signer.did(), "argument", schema, tx);
    recordNewProtectedDefaults(
      tx,
      cell.getAsNormalizedFullLink(),
      previousSchema,
      schema,
      { guarded: [] },
      { guarded: [] },
    );
    cell.set({ guarded: [] });
    tx.prepareCfc();
    expect((await tx.commit()).error?.message).toContain(
      "ownerPrincipal mismatch",
    );
  });

  it("does not issue initialization authority for a literal wildcard-named field", async () => {
    await seed({ note: "saved" });
    const tx = runtime.edit();
    const wildcardSchema = {
      ...schema,
      properties: { "*": field },
    };
    const cell = runtime.getCell(signer.did(), "argument", wildcardSchema, tx);
    recordNewProtectedDefaults(
      tx,
      cell.getAsNormalizedFullLink(),
      previousSchema,
      wildcardSchema,
      { "*": [] },
      { "*": [] },
    );
    expect(
      tx.getCfcState().writePolicyInputs.some((input) =>
        input.kind === "initialization"
      ),
    ).toBe(false);
    tx.abort();
  });

  for (
    const [label, oldSchema, next] of [
      ["an already declared field", schema, { guarded: [] }],
      ["an unknown previous declaration", undefined, { guarded: [] }],
      ["a value that differs from its default", previousSchema, {
        guarded: ["supplied"],
      }],
    ] as const
  ) {
    it(`refuses initialization of ${label}`, async () => {
      await seed({ note: "saved" });
      const tx = runtime.edit();
      const cell = runtime.getCell(signer.did(), "argument", schema, tx);
      recordNewProtectedDefaults(
        tx,
        cell.getAsNormalizedFullLink(),
        oldSchema,
        schema,
        { guarded: [] },
        next,
      );
      cell.set(next);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error?.message).toContain("writeAuthorizedBy");
    });
  }
});

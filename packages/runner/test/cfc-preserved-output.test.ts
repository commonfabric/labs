import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { diffAndUpdate } from "../src/data-updating.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const owner = await Identity.fromPassphrase("preserved-output-owner");
const schema = {
  type: "string",
  ifc: {
    ownerPrincipal: owner.did(),
    addIntegrity: [{ kind: "represents-principal", subject: owner.did() }],
    writeAuthorizedBy: {
      __ctWriterIdentityOf: { file: "/profile.tsx", path: ["setName"] },
    },
  },
} as const;

describe("protected runtime output preservation", () => {
  let runtime: Runtime;
  let output: NormalizedFullLink;

  beforeEach(async () => {
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: StorageManager.emulate({ as: owner }),
      trustSnapshotProvider: () => ({
        id: "owner",
        actingPrincipal: owner.did(),
      }),
    });
    const setup = runtime.edit();
    const backing = runtime.getCell(owner.did(), "backing", {
      ...schema,
      default: "saved name",
    }, setup);
    const result = runtime.getCell(owner.did(), "output", schema, setup);
    result.set(backing);
    output = result.getAsNormalizedFullLink();
    runtime.prepareTxForCommit(setup);
    expect((await setup.commit()).error).toBeUndefined();
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  function sendOutput(
    tx: IExtendedStorageTransaction,
    generated = true,
    outputSchema: JSONSchema = schema,
  ) {
    const backing = runtime.getCell(owner.did(), "backing", {
      ...schema,
      default: "unused default",
    }, tx);
    tx.recordCfcWritePolicyInput({
      kind: "schema",
      target: output,
      schema: outputSchema,
      schemaRole: "output",
    });
    diffAndUpdate(
      runtime,
      tx,
      output,
      backing,
      undefined,
      generated ? { schemaRole: "output" } : undefined,
    );
  }

  async function expectRefusal(tx: IExtendedStorageTransaction) {
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error?.message).toContain("writeAuthorizedBy");
    expect(runtime.getCell(owner.did(), "backing").get()).toBe("saved name");
  }

  it("preserves the existing reference and full envelope", async () => {
    const tx = runtime.edit();
    const value = tx.readValueOrThrow(output);
    const metadata = readStoredCfcMetadata(tx, output);
    expect(metadata).toBeDefined();
    sendOutput(tx);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    const inspect = runtime.edit();
    expect(inspect.readValueOrThrow(output)).toEqual(value);
    expect(readStoredCfcMetadata(inspect, output)).toEqual(metadata);
    inspect.abort();
  });

  it("refuses a preservation claim submitted through the public API", async () => {
    const tx = runtime.edit();
    tx.recordCfcWritePolicyInput({
      kind: "preserved-output",
      target: output,
      value: tx.readValueOrThrow(output)!,
    });
    sendOutput(tx, false);
    await expectRefusal(tx);
  });

  for (const when of ["before", "after"]) {
    it(`refuses an ordinary same-reference attempt ${when} runtime reuse`, async () => {
      const tx = runtime.edit();
      if (when === "before") sendOutput(tx, false);
      sendOutput(tx);
      if (when === "after") sendOutput(tx, false);
      await expectRefusal(tx);
    });

    it(`refuses an added policy ${when} the preservation claim`, async () => {
      const tx = runtime.edit();
      const previous = readStoredCfcMetadata(tx, output);
      const privateSchema = {
        ...schema,
        ifc: { ...schema.ifc, confidentiality: ["new-private"] },
      };
      const changePolicy = () =>
        tx.recordCfcWritePolicyInput({
          kind: "schema",
          target: output,
          schemaRole: "output",
          schema: privateSchema,
        });
      if (when === "before") changePolicy();
      sendOutput(tx, true, when === "before" ? privateSchema : schema);
      if (when === "after") changePolicy();
      await expectRefusal(tx);
      const inspect = runtime.edit();
      expect(readStoredCfcMetadata(inspect, output)).toEqual(previous);
      inspect.abort();
    });
  }

  it("refuses a write and restore in the same transaction", async () => {
    const tx = runtime.edit();
    const previous = tx.readValueOrThrow(output)!;
    tx.writeValueOrThrow(output, "replacement");
    tx.writeValueOrThrow(output, previous);
    sendOutput(tx);
    await expectRefusal(tx);
  });
});

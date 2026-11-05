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
    expect((await setup.commit().settled).error).toBeUndefined();
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
    expect((await tx.commit().settled).error?.message).toContain(
      "writeAuthorizedBy",
    );
    expect(runtime.getCell(owner.did(), "backing").get()).toBe("saved name");
  }

  it("preserves the existing reference and full envelope", async () => {
    const tx = runtime.edit();
    const value = tx.readValueOrThrow(output);
    const metadata = readStoredCfcMetadata(tx, output);
    expect(metadata).toBeDefined();
    sendOutput(tx);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
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

  // An envelope stored in version 1 is rewritten in version 2 on its next
  // persist once content-addressed labels are selected (SC-11's one
  // exception). Both spell the same labels, so a preserved output still
  // changes nothing: it must pass, and the document migrates on its next
  // authorized write. Refusing instead would refuse every re-run of the
  // initializer, since a refused commit never migrates the envelope.
  it("preserves an output whose envelope only differs in version", async () => {
    const tx = runtime.edit();
    const stored = readStoredCfcMetadata(tx, output);
    expect(stored?.version).toBe(1);
    tx.setCfcContentAddressedLabels(true);
    sendOutput(tx);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    const inspect = runtime.edit();
    expect(readStoredCfcMetadata(inspect, output)).toEqual(stored);
    inspect.abort();
  });

  describe("under a UI contract at the output's root", () => {
    // The trusted event a UI contract asks of a write to its field is
    // deferred, as `writeAuthorizedBy` is, for a preserved output, and
    // discharged only by the whole envelope staying as it was.

    const uiSchema = {
      type: "string",
      ifc: { uiContract: { helper: "UiAction", action: "TrustedSave" } },
    } as const satisfies JSONSchema;
    let uiOutput: NormalizedFullLink;

    beforeEach(async () => {
      const setup = runtime.edit();
      const backing = runtime.getCell(owner.did(), "ui backing", {
        ...uiSchema,
        default: "saved title",
      }, setup);
      const result = runtime.getCell(owner.did(), "ui output", uiSchema, setup);
      result.set(backing);
      uiOutput = result.getAsNormalizedFullLink();
      runtime.prepareTxForCommit(setup);
      expect((await setup.commit().settled).error).toBeUndefined();
    });

    function sendUiOutput(tx: IExtendedStorageTransaction, generated = true) {
      const backing = runtime.getCell(owner.did(), "ui backing", {
        ...uiSchema,
        default: "unused default",
      }, tx);
      tx.recordCfcWritePolicyInput({
        kind: "schema",
        target: uiOutput,
        schema: uiSchema,
        schemaRole: "output",
      });
      diffAndUpdate(
        runtime,
        tx,
        uiOutput,
        backing,
        undefined,
        generated ? { schemaRole: "output" } : undefined,
      );
    }

    it("preserves the existing reference and full envelope", async () => {
      const tx = runtime.edit();
      const value = tx.readValueOrThrow(uiOutput);
      const metadata = readStoredCfcMetadata(tx, uiOutput);
      expect(metadata).toBeDefined();
      sendUiOutput(tx);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      const inspect = runtime.edit();
      expect(inspect.readValueOrThrow(uiOutput)).toEqual(value);
      expect(readStoredCfcMetadata(inspect, uiOutput)).toEqual(metadata);
      inspect.abort();
    });

    it("refuses an ordinary same-reference attempt beside runtime reuse, for want of the trusted event", async () => {
      const tx = runtime.edit();
      sendUiOutput(tx, false);
      sendUiOutput(tx);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error?.message).toContain(
        "missing trusted-event policy input",
      );
    });
  });
});

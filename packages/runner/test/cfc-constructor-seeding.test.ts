import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";
/** Pins the trusted constructor exception without relaxing later writes. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { recordRelevantSchemaWritePolicyInput } from "../src/cell.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import { withCfcReferenceConfidentiality } from "../src/cfc/reference-provenance.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_SEED_MATERIALIZATION,
  runtimeWritePolicyAuthorization,
} from "../src/cfc/types.ts";
import { diffAndUpdate } from "../src/data-updating.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-constructor-seeding");
const space = signer.did();
const protection = { writeAuthorizedBy: ["constructor-edit-handler"] };
const protectedString = { type: "string", ifc: protection } as const;

describe("cfc-constructor-seeding", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      cfcFlowLabels: "persist",
      cfcWriteFloor: "enforce",
      cfcEnforcementMode: "enforce-strict",
    });
  });

  afterEach(async () => {
    await storage.synced();
    await runtime.dispose();
    await storage.close();
  });

  const writeOutput = (
    tx: ReturnType<Runtime["edit"]>,
    receiverName: string,
    targetName: string,
    receiverSchema: JSONSchema = protectedString,
    constructorSchema: JSONSchema = { ...protectedString, default: "initial" },
  ) => {
    const receiver = runtime.getCell(space, receiverName, receiverSchema, tx);
    const target = runtime.getCell(space, targetName, constructorSchema, tx);
    const link = receiver.getAsNormalizedFullLink();
    recordRelevantSchemaWritePolicyInput(tx, link, receiverSchema, "output");
    diffAndUpdate(runtime, tx, link, target, undefined, {
      schemaRole: "output",
    });
    return { receiver, target };
  };

  it("persists constructor content and receiver reference policies and refuses later edits to either", async () => {
    const tx = runtime.edit();
    const { receiver, target } = writeOutput(tx, "receiver", "constructor");
    expect((await tx.commit()).error).toBeUndefined();
    const read = runtime.edit();
    for (const cell of [target, receiver]) {
      const address = cell.getAsNormalizedFullLink();
      const metadata = readStoredCfcMetadata(read, address);
      expect(metadata).toBeDefined();
      const schema = read.readOrThrow({
        ...address,
        id: `cid:${metadata!.schemaHash}`,
        path: ["value"],
      });
      expect(schema).toMatchObject({ ifc: protection });
    }
    expect(runtime.getCell(space, "constructor", undefined, read).get()).toBe(
      "initial",
    );
    read.abort();

    const edit = runtime.edit();
    runtime.getCell(space, "constructor", undefined, edit).set("unauthorized");
    expect((await edit.commit()).error?.message).toContain("writeAuthorizedBy");

    const swap = runtime.edit();
    writeOutput(swap, "receiver", "replacement");
    expect((await swap.commit()).error?.message).toContain("writeAuthorizedBy");
  });

  it("refuses a new policy on an existing value even with a trusted seed marker and absent metadata", async () => {
    const seed = runtime.edit();
    const cell = runtime.getCell(space, "existing", undefined, seed);
    seed.writeOrThrow({ ...cell.getAsNormalizedFullLink(), path: [] }, {
      value: "existing",
    });
    expect((await seed.commit()).error).toBeUndefined();

    const tx = runtime.edit();
    const existing = runtime.getCell(space, "existing", protectedString, tx);
    const address = { ...existing.getAsNormalizedFullLink(), path: [] };
    tx.recordCfcWritePolicyInput({
      kind: "structural-provenance",
      claim: CFC_STRUCTURAL_PROVENANCE_SEED_MATERIALIZATION,
      target: address,
      sources: [address],
    }, runtimeWritePolicyAuthorization);
    existing.setMetaRaw("schema", protectedString, rawMetaWriteAuthorization);
    writeOutput(tx, "existing", "new-constructor");
    expect((await tx.commit()).error?.message).toContain("writeAuthorizedBy");
  });

  it("reissues an unchanged constructor output without authorizing ordinary no-op writes", async () => {
    const initial = runtime.edit();
    writeOutput(initial, "stable-output", "stable-constructor");
    expect((await initial.commit()).error).toBeUndefined();

    const repeat = runtime.edit();
    writeOutput(repeat, "stable-output", "stable-constructor");
    expect((await repeat.commit()).error).toBeUndefined();

    const ordinary = runtime.edit();
    const output = runtime.getCell(
      space,
      "stable-output",
      protectedString,
      ordinary,
    );
    const target = runtime.getCell(space, "stable-constructor", {
      ...protectedString,
      default: "initial",
    }, ordinary);
    output.set(target);
    expect((await ordinary.commit()).error?.message).toContain(
      "writeAuthorizedBy",
    );
  });

  for (const order of ["before", "after"] as const) {
    it(`refuses an ordinary no-op ${order} an output reissue in the same transaction`, async () => {
      const initial = runtime.edit();
      writeOutput(initial, "stable-output", "stable-constructor");
      expect((await initial.commit()).error).toBeUndefined();

      const tx = runtime.edit();
      const ordinaryWrite = () => {
        runtime.getCell(space, "stable-output", protectedString, tx).set(
          runtime.getCell(space, "stable-constructor", {
            ...protectedString,
            default: "initial",
          }, tx),
        );
      };
      if (order === "before") ordinaryWrite();
      writeOutput(tx, "stable-output", "stable-constructor");
      if (order === "after") ordinaryWrite();
      expect((await tx.commit()).error?.message).toContain("writeAuthorizedBy");
    });
  }

  for (const change of ["reference", "contents"] as const) {
    it(`refuses changed ${change} after an output reissue in the same transaction`, async () => {
      const initial = runtime.edit();
      writeOutput(initial, "stable-output", "stable-constructor");
      expect((await initial.commit()).error).toBeUndefined();

      const tx = runtime.edit();
      const { target } = writeOutput(tx, "stable-output", "stable-constructor");
      if (change === "reference") {
        writeOutput(tx, "stable-output", "replacement");
      } else {
        target.set("unauthorized");
      }
      expect((await tx.commit()).error?.message).toContain("writeAuthorizedBy");
    });
  }

  it("refuses a public marker claiming an ordinary write is an output reissue", async () => {
    const initial = runtime.edit();
    writeOutput(initial, "stable-output", "stable-constructor");
    expect((await initial.commit()).error).toBeUndefined();

    const tx = runtime.edit();
    const output = runtime.getCell(space, "stable-output", protectedString, tx);
    const readStart = tx.currentActivityIndex?.()!;
    output.set(runtime.getCell(space, "stable-constructor", undefined, tx));
    tx.recordCfcWritePolicyInput({
      kind: "output-reissue",
      target: output.getAsNormalizedFullLink(),
      readStart,
      readEnd: tx.currentActivityIndex?.()!,
    });
    expect((await tx.commit()).error?.message).toContain("writeAuthorizedBy");
  });

  it("refuses an ordinary raw no-op after an output reissue", async () => {
    const initial = runtime.edit();
    writeOutput(initial, "stable-output", "stable-constructor");
    expect((await initial.commit()).error).toBeUndefined();

    const tx = runtime.edit();
    const { receiver } = writeOutput(tx, "stable-output", "stable-constructor");
    const address = receiver.getAsNormalizedFullLink();
    tx.writeValueOrThrow(address, tx.readValueOrThrow(address));
    expect((await tx.commit()).error?.message).toContain("writeAuthorizedBy");
  });

  it("checks the linked content floor when an unchanged output is reissued", async () => {
    const initial = runtime.edit();
    writeOutput(initial, "stable-output", "stable-constructor");
    expect((await initial.commit()).error).toBeUndefined();

    const tx = runtime.edit();
    writeOutput(tx, "stable-output", "stable-constructor", {
      type: "string",
      ifc: { ...protection, requiredIntegrity: ["approved-content"] },
    });
    expect((await tx.commit()).error?.message).toMatch(
      /requiredIntegrity|write.floor|linked content evidence/,
    );
  });

  it("rejects an output reissue if the stored reference changes before commit", async () => {
    const initial = runtime.edit();
    writeOutput(initial, "stable-output", "stable-constructor");
    expect((await initial.commit()).error).toBeUndefined();

    const repeat = runtime.edit();
    writeOutput(repeat, "stable-output", "stable-constructor");
    runtime.getCell(space, "dependent-result", undefined, repeat).set("ready");
    runtime.prepareTxForCommit(repeat);

    const update = runtime.edit();
    setCfcImplementationIdentity(update, {
      kind: "builtin",
      builtinId: "constructor-edit-handler",
    });
    writeOutput(update, "stable-output", "replacement");
    expect((await update.commit()).error).toBeUndefined();
    await storage.synced();

    expect((await repeat.commit()).error).toBeDefined();
  });

  it("checks reference confidentiality when an unchanged output is reissued", async () => {
    const initial = runtime.edit();
    const { target } = writeOutput(
      initial,
      "stable-output",
      "stable-constructor",
    );
    expect((await initial.commit()).error).toBeUndefined();

    const tx = runtime.edit();
    const output = runtime.getCell(space, "stable-output", protectedString, tx);
    const selected = runtime.getCellFromLink(
      target.getAsNormalizedFullLink(),
      undefined,
      tx,
      withCfcReferenceConfidentiality(undefined, ["private-selection"]),
    );
    const link = output.getAsNormalizedFullLink();
    recordRelevantSchemaWritePolicyInput(tx, link, protectedString, "output");
    diffAndUpdate(runtime, tx, link, selected, undefined, {
      schemaRole: "output",
    });
    expect((await tx.commit()).error?.message).toContain(
      "writer-fit confidentiality misfit",
    );
  });

  it("refuses an untrusted public seed marker on a new protected document", async () => {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, "forged", protectedString, tx);
    const address = { ...cell.getAsNormalizedFullLink(), path: [] };
    tx.recordCfcWritePolicyInput({
      kind: "structural-provenance",
      claim: CFC_STRUCTURAL_PROVENANCE_SEED_MATERIALIZATION,
      target: address,
      sources: [address],
    });
    cell.set("forged");
    expect((await tx.commit()).error?.message).toContain("writeAuthorizedBy");
  });

  it("refuses an ordinary protected reference write when only its constructor target is initialized", async () => {
    const tx = runtime.edit();
    const receiver = runtime.getCell(space, "ordinary", protectedString, tx);
    const target = runtime.getCell(space, "ordinary-constructor", {
      ...protectedString,
      default: "initial",
    }, tx);
    receiver.set(target);
    expect((await tx.commit()).error?.message).toContain("writeAuthorizedBy");
  });

  it("does not let trusted initialization bypass confidentiality writer-fit", async () => {
    const seed = runtime.edit();
    const source = runtime.getCell(space, "secret", undefined, seed);
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(
      seed,
      { ...source.getAsNormalizedFullLink(), path: [] },
      {
        value: "secret",
        cfc: {
          version: 3,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              observes: "value",
              origin: "derived",
              label: { confidentiality: ["secret-context"] },
            }],
          },
        },
      },
    );
    expect((await seed.commit()).error).toBeUndefined();
    const tx = runtime.edit();
    const value = runtime.getCell(space, "secret", undefined, tx).getRaw();
    expect(value).toBe("secret");
    expect(deriveFlowJoin(tx).confidentiality).toEqual(["secret-context"]);
    writeOutput(tx, "public-receiver", "public-constructor", protectedString, {
      ...protectedString,
      default: String(value),
    });
    expect((await tx.commit()).error?.message).toContain(
      "writer-fit confidentiality misfit",
    );
  });

  it("does not let trusted initialization satisfy an unsupported linked content floor", async () => {
    const tx = runtime.edit();
    writeOutput(tx, "floor-receiver", "unendorsed-constructor", {
      type: "string",
      ifc: { ...protection, requiredIntegrity: ["approved-content"] },
    });
    const result = await tx.commit();
    expect(result.error).toBeDefined();
    expect(result.error?.message).toMatch(
      /requiredIntegrity|write.floor|linked content evidence/,
    );
  });
});

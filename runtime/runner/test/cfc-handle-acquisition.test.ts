import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { getCarriedCfcLabelView } from "../src/cell.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { labelsReached } from "./support/reached-labels.ts";

const signer = await Identity.fromPassphrase("cfc-handle-acquisition");
const space = signer.did();

const targetSchema = {
  type: "object",
  properties: { field: { type: "string" } },
  required: ["field"],
} as const satisfies JSONSchema;

const confidentialTargetSchema = {
  ...targetSchema,
  ifc: { confidentiality: ["from-target"] },
} as const satisfies JSONSchema;

const holderSchema = (slotConfidential: boolean): JSONSchema => ({
  type: "object",
  properties: {
    body: {
      type: "object",
      ...(slotConfidential ? { ifc: { confidentiality: ["from-slot"] } } : {}),
    },
  },
});

const sinkSchema: JSONSchema = {
  type: "object",
  properties: { ref: { type: "object" } },
};

describe("cfc-handle-acquisition", () => {
  // A handle is a reference. What it carries is how it was obtained: the
  // restrictions of the slot it was resolved through (CFC §8.2.3), and
  // nothing of the document it names, whose labels are read from that
  // document when the handle is followed. A link written from the handle
  // persists what the handle carries and no copy of its target's labels.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  const commit = async (write: (tx: never) => void) => {
    const tx = runtime.edit();
    write(tx as never);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  const confidentialityOf = (handle: unknown): string[] =>
    (getCarriedCfcLabelView(handle)?.entries ?? []).flatMap((entry) =>
      (entry.label.confidentiality ?? []) as string[]
    );

  const storedEntriesOf = (name: string) => {
    const tx = runtime.edit();
    try {
      const metadata = readStoredCfcMetadata(
        tx,
        runtime.getCell(space, name).getAsNormalizedFullLink(),
      );
      return (metadata?.labelMap.entries ?? []).map((entry) => ({
        path: entry.path,
        origin: entry.origin,
        confidentiality: entry.label.confidentiality ?? [],
      }));
    } finally {
      tx.abort();
    }
  };

  it("carries nothing on a handle resolved through a public slot to a confidential document", async () => {
    const target = runtime.getCell(
      space,
      "public-slot-target",
      confidentialTargetSchema,
    );
    const holder = runtime.getCell(
      space,
      "public-slot-holder",
      holderSchema(false),
    );
    // The document's label is its own, declared by the schema it was written
    // under; the reference to it is written under a schema declaring
    // nothing, so the slot stores no restriction of the reference's own.
    await commit((tx) => {
      target.withTx(tx).set({ field: "classified" });
      holder.withTx(tx).set({ body: target.withTx(tx).asSchema(targetSchema) });
    });
    expect(storedEntriesOf("public-slot-holder")).toEqual([]);

    const handle = holder.key("body").resolveAsCell();
    expect(getCarriedCfcLabelView(handle)).toBeUndefined();
    expect(getCarriedCfcLabelView(handle.key("field"))).toBeUndefined();

    const sink = runtime.getCell(space, "public-slot-sink", sinkSchema);
    await commit((tx) => {
      sink.withTx(tx).set({ ref: handle.withTx(tx) });
    });
    expect(storedEntriesOf("public-slot-sink")).toEqual([]);
    expect(
      labelsReached(runtime, sink.getAsNormalizedFullLink(), ["ref", "field"])
        .confidentiality,
    ).toContain("from-target");
  });

  it("carries the slot's restriction on a handle resolved through a confidential slot", async () => {
    const target = runtime.getCell(
      space,
      "confidential-slot-target",
      targetSchema,
    );
    const holder = runtime.getCell(
      space,
      "confidential-slot-holder",
      holderSchema(true),
    );
    await commit((tx) => {
      target.withTx(tx).set({ field: "plain" });
      holder.withTx(tx).set({ body: target.withTx(tx) });
    });

    const handle = holder.key("body").resolveAsCell();
    expect(confidentialityOf(handle)).toEqual(["from-slot"]);
    // A child of the handle was reached through the same slot.
    expect(confidentialityOf(handle.key("field"))).toEqual(["from-slot"]);

    const sink = runtime.getCell(space, "confidential-slot-sink", sinkSchema);
    await commit((tx) => {
      sink.withTx(tx).set({ ref: handle.withTx(tx) });
    });
    expect(storedEntriesOf("confidential-slot-sink")).toEqual([{
      path: ["ref"],
      origin: "link",
      confidentiality: ["from-slot"],
    }]);
  });
});

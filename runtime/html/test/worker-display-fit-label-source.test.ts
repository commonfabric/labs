/**
 * Which kind of label a display fit names as having refused a read, which a
 * denial reports and a host's refused read returns.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { readProjected, Runtime } from "@commonfabric/runner";
import { CFC_LABEL_READ_FAILED_ATOM } from "@commonfabric/runner/cfc";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { readRefusal } from "../src/worker/display-fit.ts";
import type { RenderPolicy } from "../src/worker/types.ts";

const signer = await Identity.fromPassphrase("display fit label source");
const space = signer.did();

/** The public-only ceiling. */
const PUBLIC_ONLY: RenderPolicy = {
  declassifyConfidentiality: [],
  maxConfidentiality: [],
};

/** A runtime over emulated storage, disposed with the returned value. */
function runtimeOf() {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  return {
    runtime,
    async [Symbol.asyncDispose]() {
      await runtime.dispose();
      await storageManager.close();
    },
  };
}

describe("worker-display-fit-label-source", () => {
  it("names the labels unreadable for a read that reports no consumed labels", async () => {
    await using shelf = runtimeOf();
    const cell = shelf.runtime.getCell(space, "reported-nothing");

    expect(readRefusal(cell, [undefined], PUBLIC_ONLY, {})).toEqual(
      expect.objectContaining({ labelSource: "unreadable" }),
    );
  });

  it("names the schema for a read that consumed no label, refused by its schema", async () => {
    await using shelf = runtimeOf();
    const cell = shelf.runtime.getCell(space, "schema-labeled").asSchema({
      type: "string",
      ifc: { confidentiality: [cfcAtom.user(space)] },
    });
    const read = readProjected(cell, (value) => value);

    expect(readRefusal(cell, [read.consumed], PUBLIC_ONLY, {})).toEqual({
      labelSource: "schema",
      confidentiality: [cfcAtom.user(space)],
      integrity: [],
    });
  });

  it("names the labels unreadable for a read whose schema cannot be walked for its labels", async () => {
    // A reference to a definition the schema does not hold names nothing,
    // so no label can be read out of the schema, and nothing it declares
    // refused the read.

    await using shelf = runtimeOf();
    const cell = shelf.runtime.getCell(space, "unwalkable-schema").asSchema({
      type: "object",
      properties: { view: { $ref: "#/$defs/Undefined" } },
    });
    const read = readProjected(cell, (value) => value);

    expect(readRefusal(cell, [read.consumed], PUBLIC_ONLY, {})).toEqual(
      expect.objectContaining({ labelSource: "unreadable" }),
    );
  });

  it("names the schema for a read whose schema declares the read-failure marker, as a runtime secret's does", async () => {
    await using shelf = runtimeOf();
    const cell = shelf.runtime.getCell(space, "secret-schema").asSchema({
      type: "string",
      ifc: { confidentiality: [CFC_LABEL_READ_FAILED_ATOM] },
    });
    const read = readProjected(cell, (value) => value);

    expect(readRefusal(cell, [read.consumed], PUBLIC_ONLY, {})).toEqual(
      expect.objectContaining({ labelSource: "schema" }),
    );
  });
});

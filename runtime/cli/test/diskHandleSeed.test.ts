import { expect } from "@std/expect";
import { deriveDiskHandleId, diskHandleSeed } from "../lib/sqlite-source.ts";
import { describe, it } from "@commonfabric/test-support/test";

const ID = deriveDiskHandleId("did:key:z6MkSpaceA", "/abs/reference-data.db");

describe("diskHandleSeed()", () => {
  it("throws for a contract whose copy is not an object, rather than seeding `{}`", () => {
    // A stored value can serialize as a scalar, as a Fabric instance does.
    const flattened = { toJSON: () => "flattened" };

    expect(() => diskHandleSeed(ID, { id: "", tables: flattened })).toThrow(
      `the contract on handle ${ID} did not copy as an object`,
    );
  });

  it("carries a contract that copies as an object", () => {
    const declared = { records: { ifc: { classification: ["secret"] } } };

    expect(diskHandleSeed(ID, { id: "", tables: declared })?.tables)
      .toEqual(declared);
  });
});

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { resolveCfcSchemaRefsOrThrow } from "../../src/cfc/schema-refs.ts";

describe("resolveCfcSchemaRefsOrThrow()", () => {
  it("returns the definition a reference names in its document", () => {
    expect(resolveCfcSchemaRefsOrThrow(
      { $ref: "#/$defs/A" },
      { $defs: { A: { type: "string" } } },
    )).toEqual({ type: "string" });
  });

  it("throws for a document that is a boolean schema", () => {
    expect(() => resolveCfcSchemaRefsOrThrow({ $ref: "#/$defs/A" }, true))
      .toThrow("Found $ref without fullSchema object");
  });
});

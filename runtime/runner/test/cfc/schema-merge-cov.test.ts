import { expect } from "@std/expect";
import type { JSONSchema, JSONSchemaObj } from "../../src/builder/types.ts";
import { mergeCfcSchemaEnvelopes } from "../../src/cfc/schema-merge.ts";
import { describe, it } from "@commonfabric/test-support/test";

const writer = (moduleIdentity: string) => ({
  __ctWriterIdentityOf: {
    file: "/loom/admission.tsx",
    path: ["admit"],
    moduleIdentity,
  },
});

/** The `Adder` definition `union()` builds, claimed by `moduleIdentity`. */
const adder = (moduleIdentity: string): JSONSchemaObj => ({
  type: "string",
  ifc: { writeAuthorizedBy: writer(moduleIdentity) },
});

/**
 * A union whose object branch carries a writer claim and holds `dependents`
 * as what `a` requires beside it.
 */
const union = (
  moduleIdentity: string,
  dependents: readonly string[] | string,
): JSONSchema => ({
  anyOf: [{
    type: "object",
    properties: {
      a: { type: "string" },
      b: { type: "string" },
      c: { type: "string" },
      addedBy: { $ref: "#/$defs/Adder" },
    },
    // A string here is malformed, which a stored schema can be.
    dependentRequired: { a: dependents } as Record<string, readonly string[]>,
  }, { type: "undefined" }],
  $defs: {
    Adder: adder(moduleIdentity),
  },
});

describe("mergeCfcSchemaEnvelopes()", () => {
  it("pairs policy-bearing union branches whose `dependentRequired` lists name the same properties in another order", () => {
    const merged = mergeCfcSchemaEnvelopes(
      union("stored", ["b", "c"]),
      union("next", ["c", "b"]),
    ) as JSONSchemaObj;

    const [branch] = merged.anyOf as JSONSchemaObj[];
    expect(
      (branch.dependentRequired as Record<string, string[]>).a.toSorted(),
    ).toEqual(["b", "c"]);
  });

  it("keeps the stored writer claim over the one a later schema names (§8.15.3, §8.15.6)", () => {
    const merged = mergeCfcSchemaEnvelopes(
      union("stored", ["b", "c"]),
      union("next", ["c", "b"]),
    ) as JSONSchemaObj;

    expect(merged.$defs).toEqual({ Adder: adder("stored") });
  });

  it("refuses policy-bearing union branches whose `dependentRequired` lists name different properties", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes(union("stored", ["b", "c"]), union("next", ["b"]))
    ).toThrow(/union branches/);
  });

  it("pairs union branches by a `dependentRequired` entry that is not a list only when it is the same", () => {
    const merged = mergeCfcSchemaEnvelopes(
      union("stored", "b"),
      union("next", "b"),
    ) as JSONSchemaObj;
    const [branch] = merged.anyOf as JSONSchemaObj[];
    expect(branch.dependentRequired).toEqual({ a: "b" });
    expect(merged.$defs).toEqual({ Adder: adder("stored") });
    expect(() =>
      mergeCfcSchemaEnvelopes(union("stored", "b"), union("next", "c"))
    ).toThrow(/union branches/);
  });
});

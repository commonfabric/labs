import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import {
  classifyAtomField,
  classifyLabelField,
  LABEL_FIELD_CLASSIFICATION,
} from "../src/cfc/label-field-classification.ts";

describe("CFC label-field classification (inv-12 / SC-25)", () => {
  // The design §2 initial-assignment table
  // (docs/specs/cfc-label-metadata-confidentiality.md, SC-25) as data. Stage 0:
  // table + lookup only; the Stage 1 persist transform consumes it.

  it("classifies each design-table row", () => {
    expect(
      classifyLabelField({ type: CFC_ATOM_TYPE.Caveat }, ["source"]),
    ).toBe("commitment");
    expect(
      classifyLabelField({ type: CFC_ATOM_TYPE.User }, ["subject"]),
    ).toBe("commitment");
    expect(
      classifyLabelField({ type: CFC_ATOM_TYPE.PersonalSpace }, ["owner"]),
    ).toBe("commitment");
    // The recorded initial-assignment exception: §4.9.3's ACL point query
    // must dereference Space.id, so it stays public.
    expect(
      classifyLabelField({ type: CFC_ATOM_TYPE.Space }, ["id"]),
    ).toBe("public");
    expect(
      classifyLabelField({ type: CFC_ATOM_TYPE.LinkReference }, ["source"]),
    ).toBe("commitment");
    expect(
      classifyLabelField({ type: CFC_ATOM_TYPE.LinkReference }, ["target"]),
    ).toBe("commitment");
    expect(
      classifyLabelField({ type: CFC_ATOM_TYPE.TransformedBy }, [
        "identity",
        "sourceFile",
      ]),
    ).toBe("commitment");
    expect(
      classifyLabelField({ type: CFC_ATOM_TYPE.TransformedBy }, [
        "identity",
        "bindingPath",
      ]),
    ).toBe("commitment");
    // Trust statements bind the content-addressed moduleIdentity instead —
    // it stays public.
    expect(
      classifyLabelField({ type: CFC_ATOM_TYPE.TransformedBy }, [
        "identity",
        "moduleIdentity",
      ]),
    ).toBe("public");
    expect(
      classifyLabelField({ kind: "authored-by" }, ["subject"]),
    ).toBe("public");
    expect(
      classifyLabelField({ kind: "represents-principal" }, ["subject"]),
    ).toBe("public");
    expect(
      classifyLabelField({ type: CFC_ATOM_TYPE.HasRole }, ["principal"]),
    ).toBe("commitment");
    expect(
      classifyLabelField({ type: CFC_ATOM_TYPE.HasRole }, ["space"]),
    ).toBe("commitment");
    expect(
      classifyLabelField({ type: CFC_ATOM_TYPE.UserSurfaceInput }, ["user"]),
    ).toBe("commitment");
    expect(
      classifyLabelField({ type: CFC_ATOM_TYPE.ExternalIngest }, ["audience"]),
    ).toBe("commitment");
  });

  it("returns undefined for unclassified fields and families", () => {
    // Non-identifying fields are not in the table (Stage 1 decides the
    // default posture for unlisted fields, not this module).
    expect(
      classifyLabelField({ type: CFC_ATOM_TYPE.Caveat }, ["kind"]),
    ).toBeUndefined();
    expect(
      classifyLabelField({ type: CFC_ATOM_TYPE.Expires }, ["timestamp"]),
    ).toBeUndefined();
    expect(
      classifyLabelField({ type: "https://example.com/unknown" }, ["source"]),
    ).toBeUndefined();
    expect(
      classifyLabelField({ kind: "unknown-claim" }, ["subject"]),
    ).toBeUndefined();
    // A field path is exact, not a prefix.
    expect(
      classifyLabelField({ type: CFC_ATOM_TYPE.TransformedBy }, ["identity"]),
    ).toBeUndefined();
  });

  it("classifies from an atom value, with type winning over kind", () => {
    // Caveat atoms carry BOTH `type` and `kind`; the type-URI family wins.
    const caveat = cfcAtom.caveat("derived-from", "did:key:alice");
    expect(classifyAtomField(caveat, ["source"])).toBe("commitment");
    expect(classifyAtomField(caveat, ["kind"])).toBeUndefined();

    expect(
      classifyAtomField(
        { kind: "authored-by", subject: "did:key:alice" },
        ["subject"],
      ),
    ).toBe("public");

    // String atoms and other non-records have no classified fields.
    expect(classifyAtomField("cf-compiled-by:cf-compiler", ["source"]))
      .toBeUndefined();
    expect(classifyAtomField(null, ["source"])).toBeUndefined();
    // A record with neither a string `type` nor a string `kind` selects no
    // family at all.
    expect(classifyAtomField({ foo: 1 }, ["source"])).toBeUndefined();
    expect(classifyAtomField({ type: 42, kind: 42 }, ["source"]))
      .toBeUndefined();
  });

  it("exposes the table as frozen data", () => {
    expect(Object.isFrozen(LABEL_FIELD_CLASSIFICATION)).toBe(true);
    for (const row of LABEL_FIELD_CLASSIFICATION) {
      expect(Object.isFrozen(row)).toBe(true);
      expect(Object.isFrozen(row.family)).toBe(true);
      expect(Object.isFrozen(row.field)).toBe(true);
      expect(["public", "commitment", "reference"]).toContain(row.class);
    }
    // Every row is reachable through the lookup it feeds.
    for (const row of LABEL_FIELD_CLASSIFICATION) {
      expect(classifyLabelField(row.family, row.field)).toBe(row.class);
    }
  });
});

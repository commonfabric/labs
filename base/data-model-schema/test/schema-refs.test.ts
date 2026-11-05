import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import { internSchema } from "../src/schema-intern.ts";
import {
  classifySchemaMeta,
  classifySchemaMetaValue,
  collectExternalSchemaRefHashes,
  collectSchemaMetaRefHashes,
  containsExternalSchemaRef,
  formatExternalSchemaRef,
  isExternalSchemaRef,
  MalformedSchemaMetaError,
  parseExternalSchemaRef,
  schemaMetaRefHashes,
} from "../src/schema-refs.ts";

const hash = "fid1:abc";
const other = "fid1:def";

describe("schema-refs", () => {
  describe("formatExternalSchemaRef()", () => {
    it("returns the bare `cid:` form for a hash alone", () => {
      expect(formatExternalSchemaRef(hash)).toBe(`cid:${hash}`);
    });

    it("appends a `#/$defs/<name>` fragment for a definition name", () => {
      expect(formatExternalSchemaRef(hash, "Leaf")).toBe(
        `cid:${hash}#/$defs/Leaf`,
      );
    });

    it("escapes a definition name the pointer grammar reserves characters of", () => {
      expect(formatExternalSchemaRef(hash, "a/b")).toBe(
        `cid:${hash}#/$defs/a~1b`,
      );
    });
  });

  describe("parseExternalSchemaRef()", () => {
    it("returns the hash for a bare reference", () => {
      expect(parseExternalSchemaRef(`cid:${hash}`)).toEqual({
        taggedHash: hash,
      });
    });

    it("returns the hash and definition name for a fragment reference", () => {
      expect(parseExternalSchemaRef(`cid:${hash}#/$defs/Leaf`)).toEqual({
        taggedHash: hash,
        defName: "Leaf",
      });
    });

    it("returns what `formatExternalSchemaRef()` was given", () => {
      expect(parseExternalSchemaRef(formatExternalSchemaRef(hash, "a/b")))
        .toEqual({ taggedHash: hash, defName: "a/b" });
    });

    it("returns `undefined` for a reference without the `cid:` prefix", () => {
      expect(parseExternalSchemaRef("#/$defs/Leaf")).toBeUndefined();
      expect(parseExternalSchemaRef(`of:${hash}`)).toBeUndefined();
    });

    it("returns `undefined` for a reference with an empty hash", () => {
      expect(parseExternalSchemaRef("cid:")).toBeUndefined();
      expect(parseExternalSchemaRef("cid:#/$defs/Leaf")).toBeUndefined();
    });

    it("returns `undefined` for a fragment that is not `#/$defs/<name>`", () => {
      expect(parseExternalSchemaRef(`cid:${hash}#/properties/x`))
        .toBeUndefined();
      expect(parseExternalSchemaRef(`cid:${hash}#/$defs/`)).toBeUndefined();
      expect(parseExternalSchemaRef(`cid:${hash}#/$defs/a/b`)).toBeUndefined();
    });
  });

  describe("isExternalSchemaRef()", () => {
    it("returns `true` exactly when the reference parses", () => {
      expect(isExternalSchemaRef(`cid:${hash}`)).toBe(true);
      expect(isExternalSchemaRef(`cid:${hash}#/$defs/Leaf`)).toBe(true);
      expect(isExternalSchemaRef("cid:")).toBe(false);
      expect(isExternalSchemaRef("#/$defs/Leaf")).toBe(false);
    });
  });

  describe("containsExternalSchemaRef()", () => {
    it("returns `false` for a schema with no `cid:` reference, and for no schema", () => {
      expect(containsExternalSchemaRef(undefined)).toBe(false);
      expect(containsExternalSchemaRef(true)).toBe(false);
      expect(containsExternalSchemaRef({ $ref: "#/$defs/Leaf" })).toBe(false);
    });

    it("returns `true` for a reference at the root, in a subschema, or in a `$defs` body", () => {
      expect(containsExternalSchemaRef({ $ref: `cid:${hash}` })).toBe(true);
      expect(containsExternalSchemaRef({
        type: "object",
        properties: { x: { $ref: `cid:${hash}` } },
      })).toBe(true);
      expect(containsExternalSchemaRef({
        $defs: { Leaf: { $ref: `cid:${hash}` } },
      })).toBe(true);
    });

    it("returns the same answer for an interned schema on a second ask", () => {
      const schema = internSchema({ $ref: `cid:${hash}` } as JSONSchema);
      expect(containsExternalSchemaRef(schema)).toBe(true);
      expect(containsExternalSchemaRef(schema)).toBe(true);
    });
  });

  describe("collectExternalSchemaRefHashes()", () => {
    it("returns every referenced hash, from subschemas and `$defs` bodies alike", () => {
      const hashes = collectExternalSchemaRefHashes({
        type: "object",
        properties: { x: { $ref: `cid:${hash}` } },
        $defs: { Leaf: { items: { $ref: `cid:${other}#/$defs/Leaf` } } },
      });
      expect([...hashes].toSorted()).toEqual([hash, other].toSorted());
    });

    it("returns an empty set for a schema with no references", () => {
      expect(collectExternalSchemaRefHashes({ type: "string" }).size).toBe(0);
      expect(collectExternalSchemaRefHashes(undefined).size).toBe(0);
    });

    it("returns the same set for an interned schema on a second ask", () => {
      const schema = internSchema({ $ref: `cid:${hash}` } as JSONSchema);
      expect(collectExternalSchemaRefHashes(schema))
        .toBe(collectExternalSchemaRefHashes(schema));
    });
  });

  describe("classifySchemaMetaValue()", () => {
    it("returns `absent` for `undefined` alone", () => {
      expect(classifySchemaMetaValue(undefined)).toEqual({ kind: "absent" });
    });

    it("returns `inline` for a boolean schema and for an object carrying no `cid:` reference", () => {
      expect(classifySchemaMetaValue(true)).toEqual({
        kind: "inline",
        schema: true,
      });
      const schema = { type: "object", properties: { x: { type: "string" } } };
      expect(classifySchemaMetaValue(schema)).toEqual({
        kind: "inline",
        schema,
      });
    });

    it("returns `reference` for a single-member `cid:` root, fragment form included", () => {
      expect(classifySchemaMetaValue({ $ref: `cid:${hash}` })).toEqual({
        kind: "reference",
        ref: `cid:${hash}`,
        taggedHash: hash,
      });
      expect(classifySchemaMetaValue({ $ref: `cid:${hash}#/$defs/Leaf` }))
        .toEqual({
          kind: "reference",
          ref: `cid:${hash}#/$defs/Leaf`,
          taggedHash: hash,
          defName: "Leaf",
        });
    });

    it("returns `malformed` for a value that is not a schema, `null` included", () => {
      for (const value of [null, "schema", 1, [{ type: "string" }]]) {
        const form = classifySchemaMetaValue(value);
        expect(form.kind).toBe("malformed");
        expect(form).toMatchObject({
          reason: "the member holds a value that is not a schema",
        });
      }
    });

    it("returns `malformed` for a `cid:` root that does not parse", () => {
      const form = classifySchemaMetaValue({ $ref: "cid:" });
      expect(form.kind).toBe("malformed");
      expect((form as { reason: string }).reason).toContain(
        "not a well-formed `cid:` reference",
      );
    });

    it("returns `malformed` for a `cid:` root with sibling keywords", () => {
      const form = classifySchemaMetaValue({
        $ref: `cid:${hash}`,
        title: "sibling",
      });
      expect(form.kind).toBe("malformed");
      expect((form as { reason: string }).reason).toContain("sibling keywords");
    });

    it("returns `malformed` for a `cid:` reference nested inside an inline schema, parseable or not", () => {
      for (const ref of [`cid:${hash}`, "cid:"]) {
        const form = classifySchemaMetaValue({
          type: "object",
          properties: { x: { $ref: ref } },
        });
        expect(form.kind).toBe("malformed");
        expect((form as { reason: string }).reason).toContain(
          "inside an inline schema",
        );
      }
    });
  });

  describe("classifySchemaMeta()", () => {
    it("classifies the document's reserved `schema` member", () => {
      expect(classifySchemaMeta({ value: 1 })).toEqual({ kind: "absent" });
      expect(classifySchemaMeta({ value: 1, schema: { $ref: `cid:${hash}` } }))
        .toMatchObject({ kind: "reference", taggedHash: hash });
    });

    it("returns `absent` for a value that is not a document", () => {
      expect(classifySchemaMeta("text")).toEqual({ kind: "absent" });
      expect(classifySchemaMeta(undefined)).toEqual({ kind: "absent" });
    });
  });

  describe("schemaMetaRefHashes()", () => {
    it("returns the referenced hash for the reference form and nothing for the others", () => {
      expect([...schemaMetaRefHashes({
        kind: "reference",
        ref: `cid:${hash}`,
        taggedHash: hash,
      })]).toEqual([hash]);
      expect(schemaMetaRefHashes({ kind: "absent" }).size).toBe(0);
      expect(schemaMetaRefHashes({ kind: "inline", schema: true }).size).toBe(
        0,
      );
    });

    it("throws `MalformedSchemaMetaError` carrying the reason for the malformed form", () => {
      expect(() =>
        schemaMetaRefHashes({ kind: "malformed", reason: "because" })
      ).toThrow(MalformedSchemaMetaError);
      expect(() =>
        schemaMetaRefHashes({ kind: "malformed", reason: "because" })
      ).toThrow("Malformed schema metadata: because");
    });
  });

  describe("collectSchemaMetaRefHashes()", () => {
    it("classifies the document and returns its member's hashes", () => {
      expect([...collectSchemaMetaRefHashes({
        value: 1,
        schema: { $ref: `cid:${hash}` },
      })]).toEqual([hash]);
      expect(collectSchemaMetaRefHashes({ value: 1 }).size).toBe(0);
    });

    it("throws for a document whose member is malformed", () => {
      expect(() => collectSchemaMetaRefHashes({ value: 1, schema: null }))
        .toThrow(MalformedSchemaMetaError);
    });
  });
});

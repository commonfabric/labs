/**
 * How a link's stored schema reaches annotated inspector output. The tool's
 * contract is that its output is what the store holds, so the distinctions
 * pinned here are between an absent schema, a stored `true`, and a schema too
 * large to write out — three states a reader has to be able to tell apart,
 * because a JSON Schema of `true` constrains nothing while a large one freezes
 * a shape.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";
import { FabricLink } from "@commonfabric/data-model/fabric-instances";

import { annotate, decodedLinkOf, summarizeLink } from "../decode.ts";

/** A link in the legacy at-rest sigil form, carrying `schema` when given one. */
function sigilLink(schema?: FabricValue): FabricValue {
  return {
    "/": {
      "link@1": {
        id: "of:fid1:target",
        path: [],
        ...(schema === undefined ? {} : { schema }),
      },
    },
  };
}

/**
 * A schema with enough in it to exceed the inline budget, shaped like the ones
 * a pattern's argument cell really carries.
 */
function largeSchema(description: string): Record<string, FabricValue> {
  return {
    type: "object",
    description,
    properties: Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `field${index}`,
        { type: "string", default: "" },
      ]),
    ),
    required: Array.from({ length: 12 }, (_, index) => `field${index}`),
  };
}

/** The `$link` body of an annotated single link. */
function annotatedLink(value: FabricValue): Record<string, FabricValue> {
  const annotated = annotate(value) as { $link: Record<string, FabricValue> };
  return annotated.$link;
}

describe("link-schema", () => {
  describe("decodedLinkOf()", () => {
    it("returns the stored schema itself rather than a flag", () => {
      const schema = { type: "string" };
      expect(decodedLinkOf(sigilLink(schema))?.schema).toEqual(schema);
    });

    it("returns `undefined` for a link storing no schema", () => {
      expect(decodedLinkOf(sigilLink())?.schema).toBe(undefined);
    });

    it("returns the stored schema of a modern `FabricLink`", () => {
      const schema = { type: "string" };
      const link = new FabricLink({ id: "of:x", path: [], schema });
      expect(decodedLinkOf(link)?.schema).toEqual(schema);
    });
  });

  describe("annotate()", () => {
    it("omits `schema` for a link storing no schema", () => {
      expect(Object.hasOwn(annotatedLink(sigilLink()), "schema")).toBe(false);
    });

    it("returns `true` for a link storing the schema `true`", () => {
      expect(annotatedLink(sigilLink(true)).schema).toBe(true);
    });

    it("returns `false` for a link storing the schema `false`", () => {
      expect(annotatedLink(sigilLink(false)).schema).toBe(false);
    });

    it("returns the empty schema for a link storing `{}`", () => {
      expect(annotatedLink(sigilLink({})).schema).toEqual({});
    });

    it("returns a small schema as itself", () => {
      const schema = { type: "object", properties: { a: { type: "string" } } };
      expect(annotatedLink(sigilLink(schema)).schema).toEqual(schema);
    });

    it("describes a large schema under `$schemaSummary`, naming its top-level keys", () => {
      const schema = largeSchema("a description long enough to matter");
      const link = annotatedLink(sigilLink(schema));
      const summary = link.$schemaSummary as {
        keys: string[];
        bytes: number;
        digest: string;
      };
      expect(summary.keys).toEqual([
        "type",
        "description",
        "properties",
        "required",
      ]);
      expect(summary.bytes).toBe(
        new TextEncoder().encode(JSON.stringify(schema)).length,
      );
      expect(typeof summary.digest).toBe("string");
    });

    it("omits `schema` for a link whose schema it summarizes", () => {
      const link = annotatedLink(sigilLink(largeSchema("wide")));
      // The two never both appear, so a `schema` key always means the value
      // beside it is what the link stores.
      expect(Object.hasOwn(link, "schema")).toBe(false);
      expect(Object.hasOwn(link, "$schemaSummary")).toBe(true);
    });

    it("describes a summary-shaped stored schema under `schema`, not `$schemaSummary`", () => {
      // The summary of a large schema, stored verbatim as some other link's
      // schema. Placing a summary in the `schema` slot would render these two
      // identically; the sibling slot is what keeps them apart.
      const summarized = annotatedLink(sigilLink(largeSchema("wide")));
      const forged = annotatedLink(
        sigilLink({ $schemaSummary: summarized.$schemaSummary }),
      );
      expect(forged.schema).toEqual({
        $schemaSummary: summarized.$schemaSummary,
      });
      expect(Object.hasOwn(forged, "$schemaSummary")).toBe(false);
      expect(Object.hasOwn(summarized, "schema")).toBe(false);
    });

    it("describes a schema sized as stored rather than as rendered", () => {
      // A sigil renders longer than it is stored, so a summary measuring the
      // rendering reports a size the store does not hold.
      const schema = {
        const: { "/": "of:target" },
        description: "x".repeat(300),
      };
      const summary = annotatedLink(sigilLink(schema)).$schemaSummary as {
        bytes: number;
      };
      expect(summary.bytes).toBe(
        new TextEncoder().encode(JSON.stringify(schema)).length,
      );
    });

    it("describes a schema `JSON.stringify()` refuses", () => {
      // A `bigint` in a schema is not serializable, so the size that decides
      // the summary comes from the annotated form instead of the stored one.
      const schema = { const: 1n, description: "x".repeat(300) };
      const summary = annotatedLink(sigilLink(schema)).$schemaSummary as {
        keys: string[];
        bytes: number;
      };
      expect(summary.keys).toEqual(["const", "description"]);
      expect(summary.bytes).toBeGreaterThan(300);
    });

    it("describes a schema nested past the call stack, without a digest", () => {
      // Hashing descends recursively, so a schema this deep has no digest to
      // report. Reporting none beats failing the whole rendering.
      let deep: FabricValue = { type: "string" };
      for (let level = 0; level < 20_000; level++) {
        deep = { properties: { a: deep } };
      }
      const summary = annotatedLink(sigilLink(deep)).$schemaSummary as {
        keys: string[];
        bytes: number;
        digest?: string;
      };
      expect(summary.keys).toEqual(["properties"]);
      expect(summary.bytes).toBeGreaterThan(20_000);
      expect(summary.digest).toBe(undefined);
    });

    it("describes a large non-object schema without naming keys", () => {
      // Stored data decides the shape, and a value that is not an object has
      // no top-level keys to report.
      const summary = annotatedLink(sigilLink("x".repeat(300)))
        .$schemaSummary as { keys?: string[]; bytes: number };
      expect(Object.hasOwn(summary, "keys")).toBe(false);
      expect(summary.bytes).toBe(302);
    });

    it("returns a large schema in full at infinite `maxDepth`", () => {
      const schema = largeSchema("a description long enough to matter");
      const annotated = annotate(
        sigilLink(schema),
        Number.POSITIVE_INFINITY,
      ) as { $link: { schema: unknown } };
      expect(annotated.$link.schema).toEqual(schema);
    });

    it("returns different digests for two schemas of the same shape", () => {
      const digestOf = (description: string) =>
        (annotatedLink(sigilLink(largeSchema(description)))
          .$schemaSummary as { digest: string }).digest;
      // A stale schema and its replacement agree on every top-level key, so
      // the digest is what a diff of two revisions has to separate them by.
      expect(digestOf("one description")).not.toBe(digestOf("another one"));
    });

    it("returns the stored schema of a modern `FabricLink`", () => {
      const schema = { type: "string" };
      const link = new FabricLink({ id: "of:x", path: [], schema });
      expect(annotatedLink(link).schema).toEqual(schema);
    });

    it("returns a schema's own `$ref` untouched", () => {
      const schema = { $ref: "#/$defs/TopicLinkKind" };
      expect(annotatedLink(sigilLink(schema)).schema).toEqual(schema);
    });

    it("returns a sigil-shaped literal inside a schema in annotated form", () => {
      // A schema is walked like any other value, which is what keeps the
      // rendering JSON-safe where the stored form is not.
      const schema = { const: { "/": "of:target" } };
      expect(annotatedLink(sigilLink(schema)).schema).toEqual({
        const: { $ref: "of:target" },
      });
    });

    it("returns a schema holding a `bigint`, which the stored form cannot be serialized from", () => {
      const rendered = annotatedLink(sigilLink({ const: 1n })).schema;
      expect(rendered).toEqual({ const: { $bigint: "1" } });
      expect(() => JSON.stringify(rendered)).not.toThrow();
    });
  });

  describe("summarizeLink()", () => {
    it("marks a link that stores a schema", () => {
      expect(summarizeLink({ id: "of:x", schema: { type: "string" } }))
        .toContain("+schema");
    });

    it("marks a link that stores the schema `false`", () => {
      expect(summarizeLink({ id: "of:x", schema: false })).toContain("+schema");
    });

    it("does not mark a link that stores no schema", () => {
      expect(summarizeLink({ id: "of:x" })).not.toContain("+schema");
    });
  });
});

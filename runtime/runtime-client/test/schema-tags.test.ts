import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchema } from "@commonfabric/api";

import { tagsFromSchema } from "@/schema-tags.ts";

describe("tagsFromSchema", () => {
  it("reads hashtags from the root description", () => {
    const schema: JSONSchema = {
      type: "object",
      description: "#Note",
    };
    expect(tagsFromSchema(schema)).toEqual(["note"]);
  });

  it("aggregates hashtags across nested schemas", () => {
    const schema: JSONSchema = {
      type: "object",
      description: "#Note",
      properties: {
        annotations: {
          type: "array",
          description: "#annotation #NOTE",
          items: { type: "string" },
        },
      },
    };
    expect(tagsFromSchema(schema)).toEqual(["note", "annotation"]);
  });

  it("does not read tags from data positions like default", () => {
    const schema: JSONSchema = {
      type: "object",
      description: "#Note",
      properties: {
        config: {
          type: "object",
          default: { description: "#default", tags: ["ignored"] },
          examples: [{ description: "#example" }],
        },
      },
    };
    expect(tagsFromSchema(schema)).toEqual(["note"]);
  });

  it("uses descriptions when serialized schemas also carry tags metadata", () => {
    const schema = {
      type: "object" as const,
      description: "A #NOTE",
      tags: ["stale"],
      properties: {
        content: { type: "string" as const, description: "See #backlink." },
      },
    };
    expect(tagsFromSchema(schema)).toEqual(["note", "backlink"]);
    expect(tagsFromSchema({ ...schema, description: "", properties: {} }))
      .toEqual([]);
  });

  it("uses shared hashtag normalization and token boundaries", () => {
    expect(tagsFromSchema({
      description: "#CAFÉ #東京 #with_under #two-words #café",
      properties: { child: { description: "#東京 #child" } },
    })).toEqual(["café", "東京", "with_under", "two", "child"]);
  });

  it("returns empty for descriptions without hashtags", () => {
    expect(tagsFromSchema({ description: "Plain prose" })).toEqual([]);
  });

  it("returns empty for boolean and missing schemas", () => {
    expect(tagsFromSchema(true)).toEqual([]);
    expect(tagsFromSchema(false)).toEqual([]);
    expect(tagsFromSchema(null)).toEqual([]);
    expect(tagsFromSchema(undefined)).toEqual([]);
  });

  it("collects tags from anyOf/allOf/oneOf branches", () => {
    const schema: JSONSchema = {
      type: "object",
      anyOf: [{ type: "object", description: "#from_anyof" }],
      allOf: [{ type: "object", description: "#from_allof" }],
      oneOf: [{ type: "object", description: "#from_oneof" }],
    };
    expect(tagsFromSchema(schema)).toEqual([
      "from_anyof",
      "from_allof",
      "from_oneof",
    ]);
  });

  it("skips boolean schemas sitting in a schema-collection keyword", () => {
    const schema: JSONSchema = {
      type: "object",
      // A boolean schema as an anyOf branch is a non-object node; the walk
      // must skip it without error and still collect the sibling's tags.
      anyOf: [true, { type: "object", description: "#real" }],
    };
    expect(tagsFromSchema(schema)).toEqual(["real"]);
  });

  it("skips non-string descriptions from external schemas", () => {
    const schema = {
      description: 42,
      properties: { child: { description: "#good" } },
    } as unknown as JSONSchema;
    expect(tagsFromSchema(schema)).toEqual(["good"]);
  });

  it("walks schema-valued keywords and ordinary properties named tags", () => {
    expect(tagsFromSchema({
      properties: { tags: { description: "#property" } },
      items: { description: "#item" },
      additionalProperties: { description: "#additional" },
      not: { description: "#negation" },
      contentSchema: { description: "#content" },
      $defs: { named: { description: "#definition" } },
      definitions: { named: { description: "#legacy" } },
    })).toEqual([
      "property",
      "additional",
      "item",
      "negation",
      "content",
      "definition",
      "legacy",
    ]);
  });

  it("terminates on cyclic schemas", () => {
    const schema: {
      description: string;
      properties?: Record<string, JSONSchema>;
    } = {
      description: "#cycle",
    };
    schema.properties = { self: schema };
    expect(tagsFromSchema(schema)).toEqual(["cycle"]);
  });

  it("visits a shared schema node only once", () => {
    const shared: JSONSchema = { type: "object", description: "#shared" };
    const schema: JSONSchema = {
      type: "object",
      anyOf: [shared],
      allOf: [shared],
    };
    // The visited set prevents the shared node from being walked twice; the
    // tag is collected once regardless.
    expect(tagsFromSchema(schema)).toEqual(["shared"]);
  });
});

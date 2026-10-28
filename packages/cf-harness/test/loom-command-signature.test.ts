import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  LOOM_COMMAND_SIGNATURE_MAX_LENGTH,
  parametersOf,
  renderCommandSignature,
  typeOfSchema,
  withoutSchemaExtensions,
} from "../src/loom-command-signature.ts";

/** A schema with one parameter of each shape a signature distinguishes. */
const DOSSIER_SCHEMA = {
  type: "object",
  required: ["entity_id"],
  properties: {
    limit: { type: "integer", default: 50 },
    entity_id: { type: "string" },
    mode: { enum: ["brief", "full"] },
    tags: { type: "array", items: { type: "string" } },
    filter: {
      type: "object",
      properties: { since: { type: "string" } },
    },
    extra: { type: "object" },
  },
} as const;

describe("loom-command-signature", () => {
  describe("renderCommandSignature()", () => {
    it("returns the name, parameters, output names, effect, and target on one line", () => {
      expect(
        renderCommandSignature({
          name: "people-discovery.dossier",
          inputSchema: DOSSIER_SCHEMA,
          outputs: ["messages", "records"],
          effect: "read",
          target: "global",
        }),
      ).toBe(
        "people-discovery.dossier(entity_id: string, limit?: integer = 50, mode?: brief|full, tags?: string[], filter?: {...}, extra?: object) -> {messages, records}  [read, global]",
      );
    });

    it("leaves out the arrow without output names and the effect where none is declared", () => {
      expect(
        renderCommandSignature({
          name: "loom.inspect",
          inputSchema: { type: "object", additionalProperties: false },
          target: "loom",
        }),
      ).toBe("loom.inspect()  [loom]");
    });

    it("returns a required input the host fills from context as optional, and other required inputs as required", () => {
      expect(
        renderCommandSignature({
          name: "pane.rename",
          inputSchema: {
            type: "object",
            required: ["pane", "title"],
            properties: { pane: { type: "string" }, title: { type: "string" } },
          },
          hostFilled: ["pane"],
          target: "global",
        }),
      ).toBe("pane.rename(title: string, pane?: string)  [global]");
    });

    it("returns `(...)` for a schema that leaves its arguments open", () => {
      for (const inputSchema of [true, { type: "object" }] as const) {
        expect(
          renderCommandSignature({
            name: "a.b",
            inputSchema,
            target: "global",
          }),
        ).toBe("a.b(...)  [global]");
      }
    });

    it("keeps the parameters that fit the line bound and marks the rest `…`", () => {
      const properties = Object.fromEntries(
        Array.from(
          { length: 60 },
          (_, index) => [`parameter_${index}`, { type: "string" }],
        ),
      );
      const signature = renderCommandSignature({
        name: "a.b",
        inputSchema: { type: "object", properties },
        outputs: ["done"],
        target: "global",
      });
      expect(signature.length).toBeLessThanOrEqual(
        LOOM_COMMAND_SIGNATURE_MAX_LENGTH,
      );
      expect(signature).toMatch(/^a\.b\(parameter_0\?: string, .*, …\)/);
      expect(signature.endsWith(") -> {done}  [global]")).toBe(true);
    });
  });

  describe("parametersOf()", () => {
    it("returns required parameters first, then optional ones, each in schema order", () => {
      expect(
        parametersOf({
          type: "object",
          required: ["b", "d"],
          properties: {
            a: { type: "string" },
            b: { type: "string" },
            c: { type: "string" },
            d: { type: "string" },
          },
        }),
      ).toEqual(["b: string", "d: string", "a?: string", "c?: string"]);
    });

    it("returns a required parameter the properties do not describe as `any`", () => {
      expect(parametersOf({ type: "object", required: ["id"] })).toEqual([
        "id: any",
      ]);
    });
  });

  describe("typeOfSchema()", () => {
    it("returns unions, nullable types, references, and arrays of unions", () => {
      expect(typeOfSchema({ type: ["string", "null"] })).toBe("string|null");
      expect(typeOfSchema({ anyOf: [{ type: "string" }, { type: "integer" }] }))
        .toBe("string|integer");
      expect(typeOfSchema({ $ref: "#/$defs/Person" })).toBe("Person");
      expect(
        typeOfSchema({ type: "array", items: { enum: ["a", 1] } }),
      ).toBe("(a|1)[]");
      expect(typeOfSchema({ const: "fixed" })).toBe("fixed");
    });

    it("returns an enum member that would break the line or blur the `|` quoted and escaped, and a plain one bare", () => {
      expect(typeOfSchema({ enum: ["plain", "a|b", "two\nlines", ""] }))
        .toBe('plain|"a|b"|"two\\nlines"|""');
    });

    it("returns `never` for an empty `enum`, `anyOf`, or `oneOf`", () => {
      expect(typeOfSchema({ enum: [] })).toBe("never");
      expect(typeOfSchema({ anyOf: [] })).toBe("never");
      expect(typeOfSchema({ oneOf: [] })).toBe("never");
    });

    it("returns `any` for an open position and `never` for a closed one", () => {
      expect(typeOfSchema(undefined)).toBe("any");
      expect(typeOfSchema(true)).toBe("any");
      expect(typeOfSchema({})).toBe("any");
      expect(typeOfSchema(false)).toBe("never");
    });
  });

  describe("withoutSchemaExtensions()", () => {
    it("removes `x-*` keywords at every subschema position", () => {
      expect(
        withoutSchemaExtensions({
          type: "object",
          "x-ui": { order: 1 },
          properties: {
            name: { type: "string", "x-widget": "text" },
            tags: {
              type: "array",
              items: { type: "string", "x-hint": "tag" },
            },
          },
          anyOf: [{ required: ["name"], "x-note": "n" }],
          $defs: { Person: { type: "object", "x-kind": "person" } },
        }),
      ).toEqual({
        type: "object",
        properties: {
          name: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        anyOf: [{ required: ["name"] }],
        $defs: { Person: { type: "object" } },
      });
    });

    it("removes `x-*` keywords from tuple `items`, `additionalItems`, and draft-07 `dependencies`", () => {
      expect(
        withoutSchemaExtensions({
          type: "object",
          properties: {
            pair: {
              type: "array",
              items: [{ type: "string", "x-a": 1 }, {
                type: "number",
                "x-b": 2,
              }],
              additionalItems: { type: "boolean", "x-c": 3 },
            },
          },
          dependencies: {
            pair: { required: ["other"], "x-d": 4 },
            other: ["pair"],
          },
        }),
      ).toEqual({
        type: "object",
        properties: {
          pair: {
            type: "array",
            items: [{ type: "string" }, { type: "number" }],
            additionalItems: { type: "boolean" },
          },
        },
        dependencies: { pair: { required: ["other"] }, other: ["pair"] },
      });
    });

    it("keeps a parameter named `x-…` and `x-…` keys inside values", () => {
      const schema = {
        type: "object",
        properties: { "x-trace": { type: "string" } },
        default: { "x-trace": "t" },
        enum: [{ "x-kept": 1 }],
      };
      expect(withoutSchemaExtensions(schema)).toEqual(schema);
    });
  });
});

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  findCommandArgsProblem,
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

  describe("findCommandArgsProblem()", () => {
    it("returns `undefined` for args the schema admits, extra properties included", () => {
      expect(
        findCommandArgsProblem(DOSSIER_SCHEMA, { entity_id: "e", other: 1 }),
      ).toBeUndefined();
    });

    it("returns the path, the expected type, and the given value for a mistyped field", () => {
      expect(
        findCommandArgsProblem(DOSSIER_SCHEMA, {
          entity_id: "e",
          limit: "ten",
        }),
      ).toEqual({
        path: "args.limit",
        expected: "integer",
        given: '"ten"',
        problem: "value is not integer",
      });
    });

    it("returns a missing required field as `absent`", () => {
      expect(findCommandArgsProblem(DOSSIER_SCHEMA, {})).toEqual({
        path: "args.entity_id",
        expected: "string",
        given: "absent",
        problem: "missing required input entity_id",
      });
    });

    it("returns the position of an array element, and a value outside an enum", () => {
      expect(
        findCommandArgsProblem(DOSSIER_SCHEMA, {
          entity_id: "e",
          tags: ["ok", 7],
        }),
      ).toMatchObject({ path: "args.tags[1]", expected: "string", given: "7" });
      expect(
        findCommandArgsProblem(DOSSIER_SCHEMA, {
          entity_id: "e",
          mode: "loud",
        }),
      ).toMatchObject({
        path: "args.mode",
        expected: "brief|full",
        given: '"loud"',
      });
    });

    it("returns a property a closed schema does not declare", () => {
      expect(
        findCommandArgsProblem(
          { type: "object", additionalProperties: false, properties: {} },
          { stray: true },
        ),
      ).toEqual({
        path: "args.stray",
        expected: "no such parameter",
        given: "true",
        problem: "unknown input stray",
      });
    });

    it("reads an input passed as `null` as left out", () => {
      expect(
        findCommandArgsProblem(DOSSIER_SCHEMA, { entity_id: "e", limit: null }),
      ).toBeUndefined();
      expect(findCommandArgsProblem(DOSSIER_SCHEMA, { entity_id: null }))
        .toMatchObject({ path: "args.entity_id", given: "absent" });
    });

    describe("compatibility with the host's command layer", () => {
      // Each case is one the host's `validate_inputs` (Loom,
      // `src/lib/loom_commands.py`) runs or refuses; the check here refuses
      // nothing the host would run.

      /** A required input with a default, which the host never finds missing. */
      const DEFAULTED = {
        type: "object",
        required: ["limit"],
        properties: { limit: { type: "integer", default: 50 } },
      };

      it("returns `undefined` for a required input with a default left out or passed as `null`", () => {
        expect(findCommandArgsProblem(DEFAULTED, {})).toBeUndefined();
        expect(findCommandArgsProblem(DEFAULTED, { limit: null }))
          .toBeUndefined();
      });

      it("returns `undefined` past the keywords the host does not check", () => {
        const schema = {
          type: "object",
          properties: {
            about: { type: "string", maxLength: 400, pattern: "^a" },
            count: { type: "integer", minimum: 10 },
            at: { type: "string", format: "date-time" },
            nested: {
              type: "object",
              required: ["x"],
              properties: { x: { type: "string" } },
            },
          },
        };
        expect(
          findCommandArgsProblem(schema, {
            about: "b".repeat(401),
            count: 1,
            at: "not a date",
            nested: { y: 1 },
          }),
        ).toBeUndefined();
      });

      it("returns a value of the wrong type, and still a value outside an enum", () => {
        expect(findCommandArgsProblem(DEFAULTED, { limit: "ten" }))
          .toMatchObject({ path: "args.limit", expected: "integer" });
        expect(findCommandArgsProblem(DEFAULTED, { limit: true }))
          .toMatchObject({ path: "args.limit", given: "true" });
        expect(
          findCommandArgsProblem(
            { type: "object", properties: { n: { type: "number" } } },
            { n: true },
          ),
        ).toBeUndefined();
        expect(
          findCommandArgsProblem(
            { type: "object", properties: { label: {} } },
            { label: 7 },
          ),
        ).toMatchObject({ path: "args.label", problem: "value is not string" });
      });

      it("returns an unknown input only where the schema closes its properties", () => {
        expect(
          findCommandArgsProblem(
            { type: "object", additionalProperties: false },
            { bogus: 1 },
          ),
        ).toMatchObject({ path: "args.bogus", problem: "unknown input bogus" });
        expect(findCommandArgsProblem({ type: "object" }, { bogus: 1 }))
          .toBeUndefined();
      });
    });

    it("accepts a value any `oneOf` branch accepts, and refuses one no branch does", () => {
      const schema = {
        type: "object",
        properties: {
          amount: { oneOf: [{ type: "number" }, { type: "integer" }] },
        },
      };
      expect(findCommandArgsProblem(schema, { amount: 5 })).toBeUndefined();
      expect(findCommandArgsProblem(schema, { amount: "five" }))
        .toMatchObject({ path: "args.amount", given: '"five"' });
    });

    it("lets a call leave out a required input the host fills, and no other", () => {
      const schema = {
        type: "object",
        required: ["pane", "title"],
        properties: { pane: { type: "string" }, title: { type: "string" } },
      };
      expect(findCommandArgsProblem(schema, { title: "t" }, ["pane"]))
        .toBeUndefined();
      expect(findCommandArgsProblem(schema, { pane: "p" }, ["pane"]))
        .toMatchObject({ path: "args.title", given: "absent" });
      expect(findCommandArgsProblem(schema, { title: "t" }))
        .toMatchObject({ path: "args.pane", given: "absent" });
    });

    it("returns `undefined` for an open schema", () => {
      expect(findCommandArgsProblem(true, { anything: 1 })).toBeUndefined();
    });
  });
});

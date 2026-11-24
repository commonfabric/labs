import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import { argumentOf } from "../../../../base/pattern-compiler/exec/store.ts";
import {
  argumentWithDefaults,
  declaredBy,
  DeclaredPolicies,
} from "../../src/compiled/declared-policy.ts";

const claim = {
  __ctWriterIdentityOf: {
    file: "/room.tsx",
    path: ["submit"],
    moduleIdentity: "sha256:room",
  },
};

/** An argument schema with one protected field and one plain one. */
const argumentSchema = () => ({
  type: "object",
  properties: {
    entries: {
      type: "array",
      default: [],
      ifc: {
        writeAuthorizedBy: claim,
        confidentiality: ["sealed"],
      },
      items: { type: "object", required: ["seat"] },
    },
    title: { type: "string", default: "untitled" },
    owner: { type: "string" },
  },
  required: ["owner"],
});

/** An artifact whose plan names `argument` as its argument schema. */
const artifactOf = (argument: unknown): Artifact =>
  ({
    plan: { argumentSchema: "argument", resultSchema: "result" },
    schemas: [
      { id: "argument", schema: argument },
      { id: "result", schema: { type: "object" } },
    ],
  }) as unknown as Artifact;

describe("declared-policy", () => {
  describe("declaredBy()", () => {
    it("returns `undefined` for a schema that declares no write policy", () => {
      expect(
        declaredBy({ type: "object", properties: { a: { type: "string" } } }),
      )
        .toBeUndefined();
    });

    it("keeps the shape of the schema whole and of each `ifc` record its write policies alone", () => {
      const declared = declaredBy(argumentSchema());

      expect(declared?.schema).toEqual({
        type: "object",
        properties: {
          entries: {
            type: "array",
            default: [],
            ifc: { writeAuthorizedBy: claim },
            items: { type: "object", required: ["seat"] },
          },
          title: { type: "string", default: "untitled" },
          owner: { type: "string" },
        },
        required: ["owner"],
      });
      expect(declared?.claimed).toEqual([["entries"]]);
    });

    it("gives one frozen schema for one schema, and leaves the schema it was given as it was", () => {
      const schema = argumentSchema();

      const first = declaredBy(schema);

      expect(declaredBy(schema)?.schema).toBe(first?.schema);
      expect(Object.isFrozen(first?.schema)).toBe(true);
      expect(Object.isFrozen(schema.properties.entries.ifc.writeAuthorizedBy))
        .toBe(false);
    });
  });

  describe("argumentWithDefaults()", () => {
    it("fills each field the argument leaves out with the default its type declares, and names the fields", () => {
      const { argument, filled } = argumentWithDefaults(
        artifactOf(argumentSchema()),
        { owner: "alice" },
      );

      expect(argument).toEqual({
        owner: "alice",
        entries: [],
        title: "untitled",
      });
      expect(filled).toEqual(["entries", "title"]);
    });

    it("leaves a field the argument holds as it is", () => {
      const held = { entries: [{ seat: 1 }], title: "given" };

      const { argument, filled } = argumentWithDefaults(
        artifactOf(argumentSchema()),
        held,
      );

      expect(argument).toBe(held);
      expect(filled).toEqual([]);
    });

    it("fills nothing for a pattern whose argument type declares no write policy", () => {
      const held = {};

      const { argument, filled } = argumentWithDefaults(
        artifactOf({
          type: "object",
          properties: { title: { type: "string", default: "untitled" } },
        }),
        held,
      );

      expect(argument).toBe(held);
      expect(filled).toEqual([]);
    });
  });

  describe("DeclaredPolicies", () => {
    it("holds the policy of the argument type for the argument document of an instance", () => {
      const policies = new DeclaredPolicies();

      policies.declare("instance", artifactOf(argumentSchema()), true);

      expect(policies.of(argumentOf("instance"))?.of).toBe("argument");
      expect(policies.of(argumentOf("instance"))?.policy.claimed).toEqual([[
        "entries",
      ]]);
      // The result type of the artifact declares no write policy.
      expect(policies.of("instance")).toBeUndefined();
    });
  });
});

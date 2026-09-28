import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { MutableJSONSchemaObj } from "@commonfabric/api";
import {
  combineIfcLabels,
  declaredIfcLabels,
  holdsIfcLabels,
  joinMemberIfcLabels,
  stateReferencedIfcLabels,
  withIfcLabels,
} from "../src/ifc-labels.ts";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "./utils.ts";

const ALIASES = `
  type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
  type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;
  type Integrity<T, X extends readonly unknown[]> = Cfc<T, { integrity: X }>;
`;

const generate = async (code: string) => {
  const { type, checker } = await getTypeFromCode(
    ALIASES + code,
    "SchemaRoot",
  );
  return asObjectSchema(new SchemaGenerator().generateSchema(type, checker));
};

describe("ifc-labels", () => {
  describe("combineIfcLabels()", () => {
    it("returns the confidentiality of both, the inner's first", () => {
      expect(
        combineIfcLabels({ confidentiality: ["a"] }, {
          confidentiality: ["b"],
        }),
      ).toEqual({ confidentiality: ["a", "b"] });
    });

    it("returns a confidentiality atom both declare once, compared by value", () => {
      expect(
        combineIfcLabels(
          { confidentiality: [{ anyOf: ["x", "y"] }, "a"] },
          { confidentiality: ["a", { anyOf: ["x", "y"] }] },
        ),
      ).toEqual({ confidentiality: [{ anyOf: ["x", "y"] }, "a"] });
    });

    it("returns each key only one of them declares", () => {
      expect(
        combineIfcLabels({ confidentiality: ["a"] }, { integrity: ["i"] }),
      ).toEqual({ confidentiality: ["a"], integrity: ["i"] });
    });

    it("returns another key both declare alike once", () => {
      expect(
        combineIfcLabels({ integrity: [{ kind: "k" }] }, {
          integrity: [{ kind: "k" }],
        }),
      ).toEqual({ integrity: [{ kind: "k" }] });
    });

    it("returns the declared value of a key the other declares as `undefined`", () => {
      expect(
        combineIfcLabels({ confidentiality: undefined, integrity: ["i"] }, {
          confidentiality: ["b"],
          integrity: undefined,
        }),
      ).toEqual({ confidentiality: ["b"], integrity: ["i"] });
    });

    it("throws for another key the two declare differently", () => {
      expect(() => combineIfcLabels({ integrity: ["a"] }, { integrity: ["b"] }))
        .toThrow(
          'One value declares `ifc.integrity` twice, as `["a"]` and as `["b"]`.',
        );
    });
  });

  describe("holdsIfcLabels()", () => {
    it("returns `true` for labels whose every confidentiality atom it holds", () => {
      expect(
        holdsIfcLabels(
          { confidentiality: ["a", { anyOf: ["x"] }] },
          { confidentiality: [{ anyOf: ["x"] }] },
        ),
      ).toBe(true);
    });

    it("returns `false` for a confidentiality atom it does not hold", () => {
      expect(
        holdsIfcLabels({ confidentiality: ["a"] }, { confidentiality: ["b"] }),
      ).toBe(false);
    });

    it("returns `true` for another key it holds alike, and a key declared as `undefined`", () => {
      expect(
        holdsIfcLabels(
          { integrity: [{ kind: "k" }] },
          { integrity: [{ kind: "k" }], addIntegrity: undefined },
        ),
      ).toBe(true);
    });

    it("returns `false` for another key it holds differently or not at all", () => {
      expect(holdsIfcLabels({ integrity: ["i"] }, { integrity: ["j"] })).toBe(
        false,
      );
      expect(holdsIfcLabels({}, { integrity: ["i"] })).toBe(false);
    });
  });

  describe("withIfcLabels()", () => {
    it("returns the schema with the labels combined into its own", () => {
      expect(
        withIfcLabels({ type: "string", ifc: { confidentiality: ["a"] } }, {
          confidentiality: ["b"],
        }),
      ).toEqual({ type: "string", ifc: { confidentiality: ["a", "b"] } });
    });

    it("returns a schema of the labels alone for `true`, and one refusing everything for `false`", () => {
      const ifc = { confidentiality: ["a"] };

      expect(withIfcLabels(true, ifc)).toEqual({ ifc });
      expect(withIfcLabels(false, ifc)).toEqual({ not: true, ifc });
    });
  });

  describe("joinMemberIfcLabels()", () => {
    it("returns the union's labels with every member's confidentiality", () => {
      expect(
        joinMemberIfcLabels({ confidentiality: ["outer"] }, [
          { confidentiality: ["x"] },
          { confidentiality: ["y", "outer"] },
        ]),
      ).toEqual({ confidentiality: ["outer", "x", "y"] });
    });

    it("returns another label only where every member declares it alike", () => {
      expect(
        joinMemberIfcLabels({}, [
          { integrity: ["i"], addIntegrity: ["a"] },
          { integrity: ["i"], addIntegrity: ["b"] },
        ]),
      ).toEqual({ integrity: ["i"] });
    });

    it("returns the union's own label over the members' others", () => {
      expect(
        joinMemberIfcLabels({ integrity: ["outer"] }, [
          { integrity: ["i"] },
          { integrity: ["i"] },
        ]),
      ).toEqual({ integrity: ["outer"] });
    });

    it("returns `undefined` where nothing declares a label", () => {
      expect(joinMemberIfcLabels({}, [{}, { integrity: undefined }]))
        .toBeUndefined();
    });
  });

  describe("declaredIfcLabels()", () => {
    it("returns the labels along a reference chain, the farthest first", () => {
      expect(
        declaredIfcLabels(
          { $ref: "#/$defs/A", ifc: { confidentiality: ["near"] } },
          {
            A: { $ref: "#/$defs/B", ifc: { confidentiality: ["middle"] } },
            B: { type: "string", ifc: { confidentiality: ["far"] } },
          },
        ),
      ).toEqual({ confidentiality: ["far", "middle", "near"] });
    });

    it("returns `undefined` for a schema that declares no label", () => {
      expect(declaredIfcLabels({ type: "string" }, {})).toBeUndefined();
      expect(declaredIfcLabels(true, {})).toBeUndefined();
    });
  });

  describe("stateReferencedIfcLabels()", () => {
    it("writes a definition's labels beside a labeled reference to it", () => {
      const schema: MutableJSONSchemaObj = {
        properties: {
          t: { $ref: "#/$defs/Secret", ifc: { integrity: ["i"] } },
        },
        $defs: {
          Secret: { type: "string", ifc: { confidentiality: ["a"] } },
        },
      };
      stateReferencedIfcLabels(schema);
      expect(schema.properties?.t).toEqual({
        $ref: "#/$defs/Secret",
        ifc: { confidentiality: ["a"], integrity: ["i"] },
      });
      expect(schema.$defs?.Secret).toEqual({
        type: "string",
        ifc: { confidentiality: ["a"] },
      });
    });

    it("leaves a reference that declares no label of its own as it is", () => {
      const schema: MutableJSONSchemaObj = {
        properties: { t: { $ref: "#/$defs/Secret" } },
        $defs: {
          Secret: { type: "string", ifc: { confidentiality: ["a"] } },
        },
      };
      stateReferencedIfcLabels(schema);
      expect(schema.properties?.t).toEqual({ $ref: "#/$defs/Secret" });
    });

    it("writes the labels of every definition along a chain, the farthest first", () => {
      const schema: MutableJSONSchemaObj = {
        properties: {
          t: { $ref: "#/$defs/Signed", ifc: { confidentiality: ["c"] } },
        },
        $defs: {
          Signed: { $ref: "#/$defs/Secret", ifc: { confidentiality: ["b"] } },
          Secret: { type: "string", ifc: { confidentiality: ["a"] } },
        },
      };
      stateReferencedIfcLabels(schema);
      expect(schema.properties?.t).toEqual({
        $ref: "#/$defs/Signed",
        ifc: { confidentiality: ["a", "b", "c"] },
      });
      expect(schema.$defs?.Signed).toEqual({
        $ref: "#/$defs/Secret",
        ifc: { confidentiality: ["a", "b"] },
      });
    });

    it("ends a chain at a definition it already reached", () => {
      const schema: MutableJSONSchemaObj = {
        properties: {
          t: { $ref: "#/$defs/A", ifc: { confidentiality: ["c"] } },
        },
        $defs: {
          A: { $ref: "#/$defs/B", ifc: { confidentiality: ["a"] } },
          B: { $ref: "#/$defs/A", ifc: { confidentiality: ["b"] } },
        },
      };
      stateReferencedIfcLabels(schema);
      expect(schema.properties?.t).toEqual({
        $ref: "#/$defs/A",
        ifc: { confidentiality: ["b", "a", "c"] },
      });
    });

    it("writes a definition's labels beside a reference under a keyword the generator does not emit", () => {
      const schema: MutableJSONSchemaObj = {
        patternProperties: {
          "^t": { $ref: "#/$defs/Secret", ifc: { confidentiality: ["b"] } },
        },
        $defs: {
          Secret: { type: "string", ifc: { confidentiality: ["a"] } },
        },
      };
      stateReferencedIfcLabels(schema);
      expect(schema.patternProperties?.["^t"]).toEqual({
        $ref: "#/$defs/Secret",
        ifc: { confidentiality: ["a", "b"] },
      });
    });

    it("leaves a `default` shaped like a labeled reference as it is", () => {
      const value = { $ref: "#/$defs/Secret", ifc: { integrity: ["i"] } };
      const schema: MutableJSONSchemaObj = {
        properties: { t: { type: "object", default: value } },
        $defs: {
          Secret: { type: "string", ifc: { confidentiality: ["a"] } },
        },
      };
      stateReferencedIfcLabels(schema);
      expect(schema.properties?.t).toEqual({
        type: "object",
        default: { $ref: "#/$defs/Secret", ifc: { integrity: ["i"] } },
      });
    });

    it("throws for a label a reference declares differently from its definition", () => {
      const schema: MutableJSONSchemaObj = {
        properties: {
          t: { $ref: "#/$defs/Signed", ifc: { integrity: ["b"] } },
        },
        $defs: { Signed: { type: "string", ifc: { integrity: ["a"] } } },
      };
      expect(() => stateReferencedIfcLabels(schema)).toThrow(
        'One value declares `ifc.integrity` twice, as `["a"]` and as `["b"]`.',
      );
    });
  });

  describe("generated schemas", () => {
    it("joins the confidentiality of a label nested inside another", async () => {
      const schema = await generate(`
        interface SchemaRoot {
          t: Confidential<Confidential<{ v: string }, readonly ["a"]>, readonly ["b"]>;
        }
      `);
      expect((schema.properties?.t as MutableJSONSchemaObj).ifc).toEqual({
        confidentiality: ["a", "b"],
      });
    });

    it("joins labels nested around a named type into the label beside its reference", async () => {
      const schema = await generate(`
        interface Inner { v: string }
        interface SchemaRoot {
          t: Confidential<Confidential<Inner, readonly ["a"]>, readonly ["b"]>;
        }
      `);
      expect(schema.properties?.t).toEqual({
        $ref: "#/$defs/Inner",
        ifc: { confidentiality: ["a", "b"] },
      });
      expect(schema.$defs?.Inner).not.toHaveProperty("ifc");
    });

    it("writes a labeled definition's confidentiality beside a reference that adds its own", async () => {
      const schema = await generate(`
        type Secret = Confidential<{ v: string }, readonly ["a"]>;
        interface SchemaRoot {
          t: Confidential<Secret, readonly ["b"]>;
          s: Secret;
        }
      `);
      expect(schema.properties?.t).toEqual({
        $ref: "#/$defs/Secret",
        ifc: { confidentiality: ["a", "b"] },
      });
      expect(schema.properties?.s).toEqual({ $ref: "#/$defs/Secret" });
      expect((schema.$defs?.Secret as MutableJSONSchemaObj).ifc).toEqual({
        confidentiality: ["a"],
      });
    });

    it("writes a labeled definition's other labels beside a reference labeled with another key", async () => {
      const schema = await generate(`
        type Secret = Confidential<{ v: string }, readonly ["a"]>;
        interface SchemaRoot {
          t: Integrity<Secret, readonly ["i"]>;
          s: Secret;
        }
      `);
      expect(schema.properties?.t).toEqual({
        $ref: "#/$defs/Secret",
        ifc: { confidentiality: ["a"], integrity: ["i"] },
      });
    });

    it("joins labels on a reference into a type that contains itself", async () => {
      const schema = await generate(`
        type Node = Confidential<{
          label: string;
          kids: Confidential<Node, readonly ["b"]>[];
        }, readonly ["a"]>;
        interface SchemaRoot { root: Node }
      `);
      const node = schema.$defs?.Node as MutableJSONSchemaObj;
      expect(node.ifc).toEqual({ confidentiality: ["a"] });
      expect(
        (node.properties?.kids as MutableJSONSchemaObj).items,
      ).toEqual({
        $ref: "#/$defs/Node",
        ifc: { confidentiality: ["a", "b"] },
      });
    });

    it("refuses another label two nested wrappers declare differently", async () => {
      await expect(generate(`
        interface SchemaRoot {
          t: Integrity<Integrity<string, readonly ["a"]>, readonly ["b"]>;
        }
      `)).rejects.toThrow(
        'One value declares `ifc.integrity` twice, as `["a"]` and as `["b"]`.',
      );
    });

    it("refuses another label a reference declares differently from its definition", async () => {
      await expect(generate(`
        type Signed = Integrity<{ v: string }, readonly ["a"]>;
        interface SchemaRoot {
          t: Integrity<Signed, readonly ["b"]>;
          s: Signed;
        }
      `)).rejects.toThrow(
        'One value declares `ifc.integrity` twice, as `["a"]` and as `["b"]`.',
      );
    });
  });
});

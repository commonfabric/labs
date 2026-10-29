import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type {
  MutableJSONSchema,
  MutableJSONSchemaObj,
} from "@commonfabric/api";
import {
  assertAnyValuesKeptLabels,
  combineIfcLabels,
  declaredIfcLabels,
  holdsIfcLabels,
  joinMemberIfcLabels,
  labeledValueMember,
  reducedLabeledUnion,
  stateReferencedIfcLabels,
  withIfcLabels,
} from "../src/ifc-labels.ts";
import type { GenerationContext } from "../src/interface.ts";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "./utils.ts";

const ALIASES = `
  type Cfc<T, Meta> = T & { readonly __ct_cfc__?: { readonly meta?: Meta; readonly of?: T } };
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

/**
 * A context holding `definitions`, with origins recorded, and the values that reached
 * beside a definition not written yet collected.
 */
const contextWith = (
  definitions: Record<string, MutableJSONSchemaObj> = {},
): GenerationContext =>
  ({
    definitions,
    schemaOrigins: new WeakMap(),
    anyValuesBesideUnwritten: [],
  }) as unknown as GenerationContext;

describe("ifc-labels", () => {
  describe("reducedLabeledUnion()", () => {
    const labeled: MutableJSONSchemaObj = {
      type: "object",
      properties: { x: { type: "string" } },
      ifc: { confidentiality: ["a"], integrity: ["i"] },
    };

    it("returns the `any` arm labeled with the confidentiality the other arms state, and records the arms", () => {
      const context = contextWith();
      const arms: MutableJSONSchema[] = [true, labeled];
      const reduced = reducedLabeledUnion(arms, context);
      expect(reduced).toEqual({ ifc: { confidentiality: ["a"] } });
      const origin = context.schemaOrigins!.get(
        reduced as MutableJSONSchemaObj,
      );
      expect(origin?.kind).toBe("reduction");
      expect(origin && "parts" in origin ? origin.parts() : []).toEqual(arms);
    });

    it("records no arm accepting no value, which is no member of the union", () => {
      const context = contextWith();
      const reduced = reducedLabeledUnion([true, false, labeled], context);
      expect(reduced).toEqual({ ifc: { confidentiality: ["a"] } });
      const origin = context.schemaOrigins!.get(
        reduced as MutableJSONSchemaObj,
      );
      expect(origin && "parts" in origin ? origin.parts() : []).toEqual([
        true,
        labeled,
      ]);
    });

    it("returns the `unknown` arm labeled likewise, and the `any` arm beside both", () => {
      expect(
        reducedLabeledUnion([{ type: "unknown" }, labeled], contextWith()),
      ).toEqual({ type: "unknown", ifc: { confidentiality: ["a"] } });
      expect(
        reducedLabeledUnion(
          [{ type: "unknown" }, true, labeled],
          contextWith(),
        ),
      ).toEqual({ ifc: { confidentiality: ["a"] } });
    });

    it("returns the confidentiality an arm states anywhere in its value, through its references", () => {
      const context = contextWith({
        Inner: {
          type: "object",
          properties: {
            y: { type: "string", ifc: { confidentiality: ["b"] } },
          },
        },
      });
      expect(
        reducedLabeledUnion(
          [true, {
            type: "object",
            properties: { inner: { $ref: "#/$defs/Inner" } },
          }],
          context,
        ),
      ).toEqual({ ifc: { confidentiality: ["b"] } });
    });

    it("returns the arm accepting anything unlabeled where the other arms state evidence alone", () => {
      expect(
        reducedLabeledUnion([{ type: "unknown" }, {
          type: "object",
          ifc: { integrity: ["i"] },
        }], contextWith()),
      ).toEqual({ type: "unknown" });
    });

    it("returns `undefined` for a union with no arm accepting anything, one with no label, and a labeled `unknown` arm", () => {
      expect(reducedLabeledUnion([labeled, { type: "string" }], contextWith()))
        .toBeUndefined();
      expect(
        reducedLabeledUnion(
          [{ type: "unknown" }, { type: "string" }],
          contextWith(),
        ),
      ).toBeUndefined();
      expect(
        reducedLabeledUnion([
          { type: "unknown", ifc: { confidentiality: ["c"] } },
          { type: "string" },
        ], contextWith()),
      ).toBeUndefined();
    });

    it("labels the value with every restriction an arm states anywhere in its value, the arm accepting anything included", () => {
      // The value may hold an arm's data anywhere, so an arm's restriction
      // goes on the whole value, as it does beside `any` in an intersection.

      expect(
        reducedLabeledUnion(
          [{ ifc: { exactCopyOf: ["p"] } }, labeled],
          contextWith(),
        ),
      ).toEqual({ ifc: { exactCopyOf: ["p"], confidentiality: ["a"] } });
      expect(
        reducedLabeledUnion([true, {
          type: "object",
          properties: { x: { type: "string", ifc: { exactCopyOf: ["p"] } } },
        }], contextWith()),
      ).toEqual({ ifc: { exactCopyOf: ["p"] } });
    });

    it("labels the value with evidence every arm states of its whole value, and none an arm states of a part", () => {
      expect(
        reducedLabeledUnion([{ ifc: { integrity: ["i"] } }, {
          type: "object",
          ifc: { integrity: ["i"] },
        }], contextWith()),
      ).toEqual({ ifc: { integrity: ["i"] } });
      expect(
        reducedLabeledUnion([true, {
          type: "object",
          properties: { x: { type: "string", ifc: { integrity: ["i"] } } },
        }], contextWith()),
      ).toBe(true);
    });

    it("throws for arms that state a restriction other than confidentiality differently", () => {
      // The whole value can hold only one.

      expect(() =>
        reducedLabeledUnion([
          true,
          { type: "object", ifc: { exactCopyOf: ["p"] } },
          { type: "array", ifc: { exactCopyOf: ["q"] } },
        ], contextWith())
      ).toThrow("One value declares `ifc.exactCopyOf` twice");
    });

    it("records a union an arm of which reaches a definition not written yet, with the labels it kept", () => {
      // `Node` is still being generated, so it is not among the definitions.

      const context = contextWith();
      const arms: MutableJSONSchema[] = [
        true,
        { $ref: "#/$defs/Node" },
        labeled,
      ];
      expect(reducedLabeledUnion(arms, context)).toEqual({
        ifc: { confidentiality: ["a"] },
      });
      expect(context.anyValuesBesideUnwritten).toEqual([{
        from: "union",
        definitions: context.definitions,
        unwritten: ["Node"],
        kept: { confidentiality: ["a"] },
        arms,
      }]);
    });

    it("records a union with no label an arm of which is `true`, and none an arm of which is `unknown`, beside a definition not written yet", () => {
      // An arm that is `true` makes the union `true`, while `unknown` beside
      // the reference keeps both arms.

      const made = contextWith();
      expect(reducedLabeledUnion([true, { $ref: "#/$defs/Node" }], made))
        .toBeUndefined();
      expect(made.anyValuesBesideUnwritten.map(({ kept }) => kept)).toEqual([
        undefined,
      ]);
      const kept = contextWith();
      expect(
        reducedLabeledUnion(
          [{ type: "unknown" }, { $ref: "#/$defs/Node" }],
          kept,
        ),
      ).toBeUndefined();
      expect(kept.anyValuesBesideUnwritten).toEqual([]);
    });

    it("returns `undefined` for a union with an arm that declares a scope, whether that arm accepts anything or not", () => {
      // The union keeps its arms, among which the scope's placement is
      // refused.
      expect(reducedLabeledUnion([{ scope: "user" }, labeled], contextWith()))
        .toBeUndefined();
      expect(
        reducedLabeledUnion(
          [true, { ...labeled, scope: "user" }],
          contextWith(),
        ),
      ).toBeUndefined();
    });
  });

  describe("assertAnyValuesKeptLabels()", () => {
    /**
     * The values a union of `arms` reduced beside the definition `Node`,
     * written afterwards as `node`, collected, and the schema `Node` is the
     * root of, which holds it.
     */
    const unionBesideNode = (
      arms: readonly MutableJSONSchema[],
      node: MutableJSONSchemaObj,
    ) => {
      const context = contextWith();
      reducedLabeledUnion(arms, context);
      context.definitions.Node = node;
      return {
        values: context.anyValuesBesideUnwritten,
        schema: { $ref: "#/$defs/Node", $defs: { Node: node } },
      };
    };
    const secret: MutableJSONSchemaObj = {
      type: "object",
      properties: {
        secret: { type: "string", ifc: { confidentiality: ["s"] } },
      },
    };
    const reference: MutableJSONSchema = { $ref: "#/$defs/Node" };
    const labeled: MutableJSONSchemaObj = {
      type: "object",
      properties: { x: { type: "string" } },
      ifc: { confidentiality: ["a"] },
    };

    it("throws for a union that kept fewer restrictions than its arms state once the definition is written", () => {
      const { values, schema } = unionBesideNode(
        [true, reference, labeled],
        secret,
      );
      expect(() => assertAnyValuesKeptLabels(values, schema)).toThrow(
        "it reaches `Node` inside the definition of `Node`",
      );
    });

    it("throws for a union with no label of its own that an arm made `true`", () => {
      const { values, schema } = unionBesideNode([true, reference], secret);
      expect(() => assertAnyValuesKeptLabels(values, schema)).toThrow(
        "it reaches `Node` inside the definition of `Node`",
      );
    });

    it("returns where the union kept every restriction its arms state", () => {
      const { values, schema } = unionBesideNode(
        [true, reference, labeled],
        {
          type: "object",
          properties: {
            secret: { type: "string", ifc: { confidentiality: ["a"] } },
          },
        },
      );
      expect(() => assertAnyValuesKeptLabels(values, schema)).not.toThrow();
    });

    it("returns where the definition states evidence alone", () => {
      // Evidence a union does not keep is evidence the value lacks.

      const { values, schema } = unionBesideNode([true, reference], {
        type: "object",
        properties: { signed: { type: "string", ifc: { integrity: ["i"] } } },
      });
      expect(() => assertAnyValuesKeptLabels(values, schema)).not.toThrow();
    });

    it("returns where the schema generated does not hold the definition", () => {
      // A definition the schema drops took the union inside it with it.

      const { values } = unionBesideNode([true, reference, labeled], secret);
      expect(() => assertAnyValuesKeptLabels(values, { type: "object" })).not
        .toThrow();
    });
  });

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

  describe("labeledValueMember()", () => {
    const value: MutableJSONSchemaObj = {
      type: "string",
      ifc: { confidentiality: ["a"] },
    };

    it("returns the value member of a nullable union whose member alone declares labels", () => {
      expect(
        labeledValueMember({ anyOf: [{ type: "undefined" }, value] }, {}),
      ).toBe(value);
      expect(
        labeledValueMember(
          { anyOf: [value, { type: ["null", "undefined"] }] },
          {},
        ),
      ).toBe(value);
    });

    it("returns the value member whose labels its reference reaches", () => {
      const reference: MutableJSONSchemaObj = { $ref: "#/$defs/A" };
      expect(
        labeledValueMember({ anyOf: [{ type: "null" }, reference] }, {
          A: value,
        }),
      ).toBe(reference);
    });

    it("returns the value member beside a reference to a nullish definition", () => {
      expect(
        labeledValueMember({ anyOf: [{ $ref: "#/$defs/Nothing" }, value] }, {
          Nothing: { type: "null" },
        }),
      ).toBe(value);
      expect(
        labeledValueMember({ anyOf: [{ $ref: "#/$defs/Gone" }, value] }, {
          Gone: { $ref: "#/$defs/Nothing" },
          Nothing: { type: ["null", "undefined"] },
        }),
      ).toBe(value);
    });

    it("counts a reference it cannot resolve to a nullish definition as a value member", () => {
      const unresolved: Record<string, MutableJSONSchemaObj>[] = [
        {},
        { Nothing: { type: "null", description: "none" } },
      ];
      for (const definitions of unresolved) {
        expect(
          labeledValueMember({
            anyOf: [{ $ref: "#/$defs/Nothing" }, value, { type: "null" }],
          }, definitions),
        ).toBeUndefined();
      }
    });

    it("returns `undefined` for a union that declares labels, holds no nullish member, or whose member declares none", () => {
      expect(labeledValueMember({
        anyOf: [{ type: "undefined" }, value],
        ifc: { confidentiality: ["b"] },
      }, {})).toBeUndefined();
      expect(labeledValueMember({ anyOf: [value, value] }, {}))
        .toBeUndefined();
      expect(
        labeledValueMember({
          anyOf: [{ type: "undefined" }, { type: "string" }],
        }, {}),
      ).toBeUndefined();
      expect(labeledValueMember(value, {})).toBeUndefined();
      // `true` accepts any value, so it is a value member beside `value`.
      expect(
        labeledValueMember({ anyOf: [true, { type: "null" }, value] }, {}),
      ).toBeUndefined();
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

    it("refuses a union with a member accepting any value that reaches, inside its own definition, a definition stating a restriction it did not keep", async () => {
      await expect(generate(`
        interface SchemaRoot {
          secret: Confidential<string, readonly ["s"]>;
          child?: SchemaRoot | any | Confidential<{ x: string }, readonly ["c"]>;
        }
      `)).rejects.toThrow(
        "it reaches `SchemaRoot` inside the definition of `SchemaRoot`",
      );
    });

    it("refuses such a union with no label of its own, which its member accepting anything makes `true`", async () => {
      await expect(generate(`
        interface SchemaRoot {
          secret: Confidential<string, readonly ["s"]>;
          child?: SchemaRoot | any;
        }
      `)).rejects.toThrow(
        "it reaches `SchemaRoot` inside the definition of `SchemaRoot`",
      );
    });

    it("returns such a union beside a definition that states no restriction as `true`", async () => {
      const schema = await generate(`
        interface SchemaRoot {
          name: string;
          child?: SchemaRoot | any;
        }
      `);
      expect(
        (schema.$defs?.SchemaRoot as MutableJSONSchemaObj).properties?.child,
      ).toBe(true);
    });

    it("keeps every label of a recursion a generic alias reads again one level down", async () => {
      // The definition read one level down reaches itself, and is dropped, read
      // in full by the level above.

      const schema = await generate(`
        type Rec<T> = {
          child: Rec<T> | T | Confidential<{ x: string }, readonly ["c"]>;
          secret: Confidential<string, readonly ["s"]>;
        };
        interface SchemaRoot { r: Rec<any> }
      `);
      const r = schema.properties?.r as MutableJSONSchemaObj;
      expect(r.properties?.child).toEqual({
        ifc: { confidentiality: ["c", "s"] },
      });
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

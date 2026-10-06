import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import { SchemaGenerator } from "../../src/schema-generator.ts";
import type { GenerationContext } from "../../src/interface.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

// The local Default marker supplies the branded union read by the formatter.
const PRELUDE = `
  declare const DEFAULT_MARKER: unique symbol;
  type DefaultMarker<T> = { readonly [DEFAULT_MARKER]: T };
  type Default<T, V extends T = T> = (T & DefaultMarker<V>) | T;
  interface Box<T> { value: T; }
`;

/** The schema generated for the type alias `Root` declared in `code`. */
async function schemaOfRoot(code: string) {
  const { type, checker, typeNode } = await getTypeFromCode(
    PRELUDE + code,
    "Root",
  );
  return asObjectSchema(
    new SchemaGenerator().generateSchema(type, checker, typeNode),
  );
}

/** The schema of property `c` of the type alias `Root` declared in `code`. */
async function schemaOfC(code: string): Promise<unknown> {
  return (await schemaOfRoot(code)).properties?.c;
}

/** `type` with every `T` in it replaced by `argument`. */
function inPlace(type: string, argument: string): string {
  return type.replace(/\bT\b/g, argument);
}

const boxOfNumber = {
  type: "object",
  properties: { value: { type: "number" } },
  required: ["value"],
};

describe("type-arguments", () => {
  for (
    const [argument, expected] of [["string", "number"], ["number", "boolean"]]
  ) {
    it(`preserves the instantiated ${expected} schema of a registered generic member`, async () => {
      const { type, checker, typeNode } = await getTypeFromCode(
        `
        type Deferred<T> = T extends string ? number : boolean;
        interface Box<T> { value: Deferred<T>; }
        type Root = Box<${argument}>;
      `,
        "Root",
      );
      if (!typeNode || !ts.isTypeReferenceNode(typeNode)) {
        throw new Error("Root must be a type reference");
      }
      const argumentNode = typeNode.typeArguments?.[0];
      if (!argumentNode) throw new Error("Root must supply its type argument");
      const declaration = type.getSymbol()?.declarations?.find(
        ts.isInterfaceDeclaration,
      );
      const member = declaration?.members.find(ts.isPropertySignature);
      if (!declaration?.typeParameters?.[0] || !member?.type) {
        throw new Error("Box must declare its generic value member");
      }
      const actual = checker.getTypeOfSymbol(type.getProperty("value")!);
      const registered = ts.factory.createTypeReferenceNode(
        ts.factory.createQualifiedName(
          ts.factory.createIdentifier("__cfHelpers"),
          "PrintedValue",
        ),
      );
      const context: GenerationContext = {
        typeChecker: checker,
        cyclicTypes: new Set(),
        cyclicNames: new Set(),
        definitions: {},
        emittedRefs: new Set(),
        definitionStack: new Set(),
        inProgressNames: new Set(),
        typeRegistry: new WeakMap([
          [registered, checker.getTypeFromTypeNode(member.type)],
        ]),
        boundTypeParameters: {
          declaredNode: typeNode,
          arguments: new Map([[declaration.typeParameters[0], {
            type: checker.getTypeFromTypeNode(argumentNode),
          }]]),
        },
        instantiatedAs: actual,
      };
      expect(
        new SchemaGenerator().formatChildType(
          checker.getAnyType(),
          context,
          registered,
          actual,
        ),
      ).toEqual({ type: expected });
    });
  }

  it("emits one schema for equal arms of a generic marker union", async () => {
    expect(
      await schemaOfC(`
      declare const FRAMEWORK_MARKER: unique symbol;
      type FrameworkProvidedMarker = { readonly [FRAMEWORK_MARKER]: true };
      type FrameworkProvided<T> = (T & FrameworkProvidedMarker) | T;
      interface Input<T> { c: FrameworkProvided<T> }
      type Root = Input<string>;
    `),
    ).toEqual({ type: "string" });
  });

  describe("a property declared in a generic interface", () => {
    // Each property is read for an instantiation of its interface, and its
    // schema is the one the property gets with the argument written in place.

    for (
      const [declared, argument, schema] of [
        [
          `T | string | Default<string, "">`,
          "number",
          { type: ["number", "string"], default: "" },
        ],
        ["T | Default<0>", "number", { type: "number", default: 0 }],
        [
          "Writable<T | Default<0>>",
          "number",
          { type: "number", default: 0, asCell: ["cell"] },
        ],
        ["PerUser<T>", "string", { type: "string", scope: "user" }],
        [
          `PerUser<T | Default<"">>`,
          "string",
          { type: "string", default: "", scope: "user" },
        ],
        [
          "T[] | Default<[]>",
          "number",
          { type: "array", items: { type: "number" }, default: [] },
        ],
        [
          "Writable<T[] | Default<[]>>",
          "Box<number>",
          { type: "array", items: boxOfNumber, default: [], asCell: ["cell"] },
        ],
        [
          "Box<T> | Default<{ value: 0 }>",
          "number",
          { ...boxOfNumber, default: { value: 0 } },
        ],
        [
          "{ value: T } | Default<{ value: 0 }>",
          "number",
          { ...boxOfNumber, default: { value: 0 } },
        ],
        [
          "Box<T> | Default<{ value: T }>",
          "0",
          {
            type: "object",
            properties: { value: { enum: [0], type: "number" } },
            required: ["value"],
            default: { value: 0 },
          },
        ],
      ] as const
    ) {
      it(`returns the schema of \`${declared}\` with \`T\` as \`${argument}\` written in place`, async () => {
        const instantiated = await schemaOfC(
          `interface Input<T> { c: ${declared}; } type Root = Input<${argument}>;`,
        );
        const written = await schemaOfC(
          `interface Input { c: ${
            inPlace(declared, argument)
          }; } type Root = Input;`,
        );
        expect({ instantiated, written }).toEqual({
          instantiated: schema,
          written: schema,
        });
      });
    }

    it("uses a bound union argument to validate a full object default", async () => {
      const schema = await schemaOfC(`
        interface Input<T> { c: Box<T | string> | Default<{ value: 0 }> }
        type Root = Input<number>;
      `);
      expect(schema).toEqual({
        type: "object",
        properties: {
          value: { anyOf: [{ type: "number" }, { type: "string" }] },
        },
        required: ["value"],
        default: { value: 0 },
      });
    });

    it("validates a full default against a bound anonymous index signature", async () => {
      const schema = await schemaOfC(`
        interface Input<T> { c: { [name: string]: T } | Default<{ first: 0 }> }
        type Root = Input<number>;
      `) as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toEqual({ type: "number" });
      expect(schema.default).toEqual({ first: 0 });
    });

    it("validates a full default when the checker absorbs the bound literal into a wider union arm", async () => {
      expect(
        await schemaOfC(`
        interface Input<T> { c: Box<T | number> | Default<{ value: 0 }> }
        type Root = Input<0>;
      `),
      ).toEqual({
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "number", enum: [0] }, { type: "number" }],
          },
        },
        required: ["value"],
        default: { value: 0 },
      });
    });

    it("matches a member naming a generic declaration to its own instantiation among others of that declaration", async () => {
      // Matched to `Box<string>`, `Box<T>` would not cover the default, and the
      // object default would throw.

      const declared = "Box<T> | Box<string> | Default<{ value: 0 }>";
      const instantiated = await schemaOfC(
        `interface Input<T> { c: ${declared}; } type Root = Input<number>;`,
      );
      const written = await schemaOfC(
        `interface Input { c: ${
          inPlace(declared, "number")
        }; } type Root = Input;`,
      );
      expect({ instantiated, written }).toEqual({
        instantiated: written,
        written: {
          anyOf: [
            boxOfNumber,
            {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          ],
          default: { value: 0 },
        },
      });
    });

    it("reads a default value from a bound parameter", async () => {
      expect(
        await schemaOfC(
          `interface Input<T, D extends T> { c: T | Default<T, D>; } type Root = Input<string, "configured">;`,
        ),
      ).toEqual({ type: "string", default: "configured" });
      expect(
        await schemaOfC(
          `interface Input<D> { c: Box<number> | Default<D>; } type Root = Input<{ value: 0 }>;`,
        ),
      ).toEqual({ ...boxOfNumber, default: { value: 0 } });
    });

    it("reads literal defaults from type-only argument bindings", async () => {
      for (
        const [argument, value, expected] of [
          ["string", '"configured"', { type: "string", default: "configured" }],
          ["number", "3", { type: "number", default: 3 }],
          ["boolean", "true", { type: "boolean", default: true }],
        ]
      ) {
        const { type, checker } = await getTypeFromCode(
          PRELUDE + `
          interface Input<T, D extends T> { c: T | Default<T, D> }
          type Root = Input<${argument}, ${value}>;
        `,
          "Root",
        );
        const root = asObjectSchema(
          new SchemaGenerator().generateSchema(type, checker),
        );
        expect(root.properties?.c).toEqual(expected);
      }
    });

    it("rejects multiple defaults in a bound generic union", async () => {
      await expect(schemaOfC(`
        interface Input<T> { c: T | Default<0> | Default<1> }
        type Root = Input<number>;
      `)).rejects.toThrow(
        "Union types may contain at most one Default<> member",
      );
    });

    it("throws for an object default the argument does not cover, as the property written in place does", async () => {
      const message = "Default object union member is not assignable";
      await expect(schemaOfC(`
        interface Input<T> { c: { value: T } | Default<{ value: 0 }> }
        type Root = Input<string>;
      `)).rejects.toThrow(message);
      await expect(
        schemaOfC(
          "interface Input<T> { c: T | Default<{}>; } type Root = Input<Box<number>>;",
        ),
      ).rejects.toThrow(message);
      await expect(
        schemaOfC(
          "interface Input { c: Box<number> | Default<{}>; } type Root = Input;",
        ),
      ).rejects.toThrow(message);
    });
  });

  describe("the declaration a property is read from", () => {
    const schema = { type: ["number", "string"], default: "" };
    const declared = `T | string | Default<string, "">`;

    it("reads a property of a generic type alias for its instantiation", async () => {
      const root = await schemaOfRoot(
        `type Input<T> = { c: ${declared} }; type Root = { i: Input<number> };`,
      );
      expect(root.properties?.i).toEqual({
        type: "object",
        properties: { c: schema },
        required: ["c"],
      });
    });

    it("reads a property inherited from a generic base for the instantiation of the interface that extends it", async () => {
      const c = await schemaOfC(
        `interface Base<U> { c: ${
          declared.replace("T", "U")
        }; } interface Input<T> extends Base<T> {} type Root = Input<number>;`,
      );
      expect(c).toEqual(schema);
    });

    it("reads a property inherited from a generic base by a non-generic interface", async () => {
      const root = await schemaOfRoot(
        `interface Base<U> { c: ${
          declared.replace("T", "U")
        }; } interface Concrete extends Base<number> {} type Root = { r: Concrete };`,
      );
      expect(root.$defs?.Concrete).toEqual({
        type: "object",
        properties: { c: schema },
        required: ["c"],
      });
    });

    it("reads a property of an instantiation nested in a non-generic object", async () => {
      const root = await schemaOfRoot(
        `interface Input<T> { c: ${declared}; } type Root = { i: Input<number> };`,
      );
      expect(root.properties?.i).toEqual({
        type: "object",
        properties: { c: schema },
        required: ["c"],
      });
    });

    for (
      const declaration of [
        "interface Derived<T> extends Base<T> {}",
        "class Derived<T> extends Base<T> {}",
      ]
    ) {
      it(`reads an inherited default from a type-only ${declaration.startsWith("class") ? "class" : "interface"} instantiation`, async () => {
        const { type, checker } = await getTypeFromCode(
          PRELUDE +
            `class Base<U> { c!: ${
              inPlace(declared, "U")
            }; } ${declaration} type Root = Derived<number>;`,
          "Root",
        );
        const root = asObjectSchema(
          new SchemaGenerator().generateSchema(type, checker),
        );
        expect(root.properties?.c).toEqual(schema);
      });
    }

    it("reads a property of a mapped type over an instantiation under its bindings", async () => {
      const c = await schemaOfC(
        `interface Input<T> { c: ${declared}; } type Root = Readonly<Input<number>>;`,
      );
      expect(c).toEqual(schema);
    });

    it("reads each instantiation of one declaration with its own argument", async () => {
      // `next` instantiates the declaration that holds it, so its `c` is read
      // with `T` as `boolean` within the reading of a `c` with `T` as
      // `number`. `next` refers to itself as well, so it is emitted as a
      // reference to a definition.

      const root = await schemaOfRoot(
        `interface Input<T> { c: ${declared}; next?: Input<boolean>; }
         type Root = Input<number>;`,
      );
      const { $ref } = root.properties?.next as { $ref: string };
      const next = asObjectSchema(
        root.$defs?.[$ref.replace("#/$defs/", "")] ?? {},
      );
      expect({ c: root.properties?.c, nextC: next.properties?.c }).toEqual({
        c: schema,
        nextC: { type: ["boolean", "string"], default: "" },
      });
    });

    it("reads bound keys through library views in an intersection alias", async () => {
      const root = await schemaOfRoot(`
        interface Fields { text?: string; count?: number; }
        type State<K extends keyof Fields = never> = Required<Pick<Fields, K>> & { ready: boolean };
        type Root = State<"text">;
      `);
      expect(root.properties).toEqual({
        text: { type: "string" },
        ready: { type: "boolean" },
      });
      expect(root.required).toEqual(["text", "ready"]);
    });

    it("reads a bound never key as an empty projection", async () => {
      const root = await schemaOfRoot(`
        interface Fields { text?: string; count?: number; }
        type State<K extends keyof Fields = never> = Required<Pick<Fields, K>> & { ready: boolean };
        type Root = State;
      `);
      expect(root.properties).toEqual({ ready: { type: "boolean" } });
      expect(root.required).toEqual(["ready"]);
    });

    it("reads a labelled literal's operator members from their concrete instantiation", async () => {
      const root = await schemaOfRoot(`
        type Cfc<T, M> = T & { readonly __ct_cfc__?: M };
        type Confidential<T, L> = Cfc<T, { confidentiality: L }>;
        type Input<T> = Confidential<{
          indexed: T["name" & keyof T];
          mapped: { [K in keyof T]: T[K] };
          conditional: T extends { name: infer U } ? U : never;
        }, readonly ["a"]>;
        type Root = Input<{ name: number }>;
      `);
      expect(root).toEqual({
        type: "object",
        properties: {
          indexed: { type: "number" },
          mapped: {
            type: "object",
            properties: { name: { type: "number" } },
            required: ["name"],
          },
          conditional: { type: "number" },
        },
        required: ["indexed", "mapped", "conditional"],
        ifc: { confidentiality: ["a"] },
      });
    });

    it("reads operator members through a structural library view's bound operand", async () => {
      const root = await schemaOfRoot(`
        type Input<T> = Readonly<{
          indexed: T["name" & keyof T];
          mapped: { [K in keyof T]: T[K] };
        }>;
        type Root = Input<{ name: number }>;
      `);
      expect(root.properties).toEqual({
        indexed: { type: "number" },
        mapped: {
          type: "object",
          properties: { name: { type: "number" } },
          required: ["name"],
        },
      });
      expect(root.required).toEqual(["indexed", "mapped"]);
    });

    it("reads an unbound parameter from its own constraint", async () => {
      const root = await schemaOfRoot(`
        type Root<T extends { tag: string }> = T;
      `);
      expect(root).toEqual({
        type: "object",
        properties: { tag: { type: "string" } },
        required: ["tag"],
      });
    });

    it("reports a deferred conditional reading when another argument is bound", async () => {
      const { type, checker, typeNode } = await getTypeFromCode(
        `
        type Conditional<T, U> = U extends string ? { text: T } : { value: T };
        type Root<U> = Conditional<number, U>;
      `,
        "Root",
      );
      const diagnostics: string[] = [];
      const root = new SchemaGenerator().generateSchema(
        type,
        checker,
        typeNode,
        { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.type) },
      );
      expect(root).toEqual({});
      expect(diagnostics).toEqual(["schema-type:unread"]);
    });

    it("reads a shared base once across a type-only inheritance diamond", async () => {
      const { type, checker } = await getTypeFromCode(
        PRELUDE + `
        interface Shared { tag: string }
        interface Base<T> extends Shared { c: T | Default<0> }
        interface Left<T> extends Base<T> {}
        interface Right<T> extends Base<T> {}
        interface Both<T> extends Left<T>, Right<T> {}
        type Root = Both<number>;
      `,
        "Root",
      );
      const root = asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker),
      );
      expect(root.properties).toEqual({
        tag: { type: "string" },
        c: { type: "number", default: 0 },
      });
      expect(root.required?.toSorted()).toEqual(["c", "tag"]);
    });

    it("reads an omitted key and a picked partial key under their alias bindings", async () => {
      const root = await schemaOfRoot(`
        type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
        type Root = PartialBy<{ text: string; count: number }, "count">;
      `);
      expect(root.properties).toEqual({
        text: { type: "string" },
        count: { type: "number" },
      });
      expect(root.required).toEqual(["text"]);
    });

    it("reads a concrete template literal beside a bound parameter", async () => {
      const root = await schemaOfRoot(`
        type DID = \`did:\${string}\`;
        interface Input<T> { value: T; ids: DID[]; }
        type Root = Input<number>;
      `);
      expect(root.properties).toEqual({
        value: { type: "number" },
        ids: { type: "array", items: { type: "string" } },
      });
    });

    it("keeps undefined beside an optional generic cell reference", async () => {
      const root = await schemaOfRoot(`
        interface Imported<ProfileRef = unknown> { authorProfile?: ProfileRef; }
        type Root = Imported<Writable<{ name: string }>>;
      `);
      expect(root.properties?.authorProfile).toEqual({
        anyOf: [
          {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            asCell: ["cell"],
          },
          { type: "undefined" },
        ],
      });
      expect(root.required).toBeUndefined();
    });

    it("keeps recursive array element types distinct under an enclosing array's bindings", async () => {
      for (const spelling of ["(Outer | Other)[]", "Array<Outer | Other>"]) {
        const { type, checker, typeNode } = await getTypeFromCode(
          `
          interface Link { name: string; children: Link[] }
          interface Entry { title: string; children?: Link[]; parent?: Collection }
          interface Collection { entries: Entry[] }
          interface Outer { children: Link[]; parent: Collection | null }
          interface Other { other: number }
          type Root = ${spelling};
        `,
          "Root",
        );
        for (const node of [typeNode, undefined]) {
          const root = asObjectSchema(
            new SchemaGenerator().generateSchema(type, checker, node),
          );
          const collection = asObjectSchema(root.$defs?.Collection!);
          const entries = asObjectSchema(collection.properties?.entries!);
          const array = typeof entries.$ref === "string"
            ? asObjectSchema(root.$defs?.[entries.$ref.slice(8)]!)
            : entries;
          expect(array.items).toEqual({ $ref: "#/$defs/Entry" });
          expect(root.$defs?.Entry).toMatchObject({
            properties: { title: { type: "string" } },
          });
        }
      }
    });
  });
});

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { detectTrustedFactoryType } from "../../src/formatters/factory-formatter.ts";
import { registerCommonFabricDeclarationSources } from "../../src/typescript/common-fabric-symbols.ts";
import { asObjectSchema, getTypeFromCode, getTypeFromFiles } from "../utils.ts";

const FACTORY_DECLARATIONS = `
  export declare const FABRIC_FACTORY_TYPE: unique symbol;
  export declare const EXTRA_BRAND: unique symbol;

  export type FactoryInput<T> = T;
  export type FabricFactory<Args extends unknown[], Result> = {
    readonly [FABRIC_FACTORY_TYPE]: { readonly args: Args; readonly result: Result };
  };
  export type PatternFactory<T, R> =
    & ((inputs: FactoryInput<T>) => Reactive<R>)
    & FabricFactory<[FactoryInput<T>], Reactive<R>>
    & { argumentSchema: object; resultSchema: object };
  export type ModuleFactory<T, R> =
    & ((inputs: FactoryInput<T>) => Reactive<R>)
    & FabricFactory<[FactoryInput<T>], Reactive<R>>
    & { type: "ref" | "javascript" };
  export type HandlerFactory<T, E> =
    & ((context: FactoryInput<T>) => Stream<E>)
    & FabricFactory<[FactoryInput<T>], Stream<E>>
    & { type: "ref" | "javascript"; with(inputs: FactoryInput<T>): Stream<E> };

  export type PatternAlias<T, R> = PatternFactory<T, R>;
  export type BrandedModule<T, R> = ModuleFactory<T, R> & {
    readonly [EXTRA_BRAND]: true;
  };
`;

const FACTORY_IMPORTS = `
  import type {
    BrandedModule,
    HandlerFactory,
    ModuleFactory,
    PatternAlias,
    PatternFactory,
  } from "./$builtins/commonfabric.d.ts";
`;

const getTrustedFactoryType = async (code: string, typeName: string) => {
  const result = await getTypeFromFiles(
    {
      "/$builtins/commonfabric.d.ts": FACTORY_DECLARATIONS,
      "/test.ts": `${FACTORY_IMPORTS}\n${code}`,
    },
    "/test.ts",
    typeName,
  );
  const builtin = result.program.getSourceFile(
    "/$builtins/commonfabric.d.ts",
  );
  if (!builtin) throw new Error("Expected compiler-owned Common Fabric types");
  registerCommonFabricDeclarationSources(result.checker, [builtin]);
  return result;
};

const FACTORY_SCHEMA_FIELDS = new Set([
  "argumentSchema",
  "resultSchema",
  "contextSchema",
  "eventSchema",
]);

function collectFactorySchemaDocuments(value: unknown): unknown[] {
  const documents: unknown[] = [];
  const visit = (current: unknown) => {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      if (FACTORY_SCHEMA_FIELDS.has(key)) documents.push(child);
      visit(child);
    }
  };
  visit(value);
  return documents;
}

function hasOnlyResolvableLocalRefs(document: unknown): boolean {
  if (!document || typeof document !== "object") return true;
  const root = document as Record<string, unknown>;
  const active = new Set<object>();
  const resolve = (ref: string): unknown => {
    if (ref === "#") return root;
    if (!ref.startsWith("#/")) return undefined;
    let current: unknown = root;
    for (const encoded of ref.slice(2).split("/")) {
      const key = decodeURIComponent(encoded).replaceAll("~1", "/").replaceAll(
        "~0",
        "~",
      );
      if (!current || typeof current !== "object" || !(key in current)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  };
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return true;
    if (active.has(value)) return true;
    active.add(value);
    try {
      if (Array.isArray(value)) return value.every(visit);
      for (const [key, child] of Object.entries(value)) {
        if (FACTORY_SCHEMA_FIELDS.has(key)) continue;
        if (key === "$ref") {
          if (typeof child !== "string") return false;
          const target = resolve(child);
          if (target === undefined || !visit(target)) return false;
        } else if (!visit(child)) {
          return false;
        }
      }
      return true;
    } finally {
      active.delete(value);
    }
  };
  return visit(root);
}

describe("Schema: factory types", () => {
  it("does not grant factory semantics to a user type merely named PatternFactory", async () => {
    const code = `
      type PatternFactory<T, R> = (input: T) => R;
      interface SchemaRoot {
        operation: PatternFactory<{ value: number }, string>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
    expect(detectTrustedFactoryType(type, checker)).toBeUndefined();

    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );
    expect(schema.properties).not.toHaveProperty("operation");
  });

  it("does not trust branded declarations imported from an authored commonfabric.d.ts", async () => {
    const { type, checker } = await getTypeFromFiles(
      {
        "/attacker/commonfabric.d.ts": FACTORY_DECLARATIONS,
        "/test.ts": `
          import type { PatternFactory } from "./attacker/commonfabric.d.ts";
          interface SchemaRoot {
            operation: PatternFactory<{ value: number }, string>;
          }
        `,
      },
      "/test.ts",
      "SchemaRoot",
    );
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );
    expect(schema.properties).not.toHaveProperty("operation");
  });

  it("does not trust authored ambient Common Fabric module declarations", async () => {
    const { type, checker } = await getTypeFromFiles(
      {
        "/attacker.d.ts": `declare module "commonfabric" {
          ${FACTORY_DECLARATIONS}
        }`,
        "/test.ts": `
          import type { PatternFactory } from "commonfabric";
          interface SchemaRoot {
            operation: PatternFactory<{ value: number }, string>;
          }
        `,
      },
      "/test.ts",
      "SchemaRoot",
    );
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );
    expect(schema.properties).not.toHaveProperty("operation");
  });

  it("emits the public schemas for all three factory kinds", async () => {
    const code = `
      interface SchemaRoot {
        pattern: PatternFactory<{ query: string }, { count: number }>;
        module: ModuleFactory<{ value: number }, { label: string }>;
        handler: HandlerFactory<{ prefix: string }, { value: number }>;
      }
    `;
    const { type, checker } = await getTrustedFactoryType(code, "SchemaRoot");
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    expect(schema.properties?.pattern).toEqual({
      asFactory: {
        kind: "pattern",
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        resultSchema: {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
        },
      },
    });
    expect(schema.properties?.module).toEqual({
      asFactory: {
        kind: "module",
        argumentSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        resultSchema: {
          type: "object",
          properties: { label: { type: "string" } },
          required: ["label"],
        },
      },
    });
    expect(schema.properties?.handler).toEqual({
      asFactory: {
        kind: "handler",
        contextSchema: {
          type: "object",
          properties: { prefix: { type: "string" } },
          required: ["prefix"],
        },
        eventSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
      },
    });
    expect(schema.properties?.handler).not.toHaveProperty("asCell");
  });

  it("preserves aliases, extra branded intersections, containers, and unions", async () => {
    const code = `
      interface SchemaRoot {
        alias: PatternAlias<{ text: string }, { length: number }>;
        branded: BrandedModule<{ id: string }, boolean>;
        operations: Array<PatternFactory<{ id: string }, string>>;
        byName: Record<string, HandlerFactory<{ room: string }, { body: string }>>;
        selected:
          | PatternFactory<{ query: string }, string>
          | ModuleFactory<{ value: number }, number>;
      }
    `;
    const { type, checker } = await getTrustedFactoryType(code, "SchemaRoot");
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    expect((schema.properties?.alias as any).asFactory.kind).toBe("pattern");
    expect((schema.properties?.alias as any).asFactory.argumentSchema)
      .toEqual({
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      });
    expect((schema.properties?.branded as any).asFactory.kind).toBe("module");
    expect((schema.properties?.operations as any).items.asFactory.kind).toBe(
      "pattern",
    );
    expect((schema.properties?.byName as any).additionalProperties.asFactory)
      .toEqual({
        kind: "handler",
        contextSchema: {
          type: "object",
          properties: { room: { type: "string" } },
          required: ["room"],
        },
        eventSchema: {
          type: "object",
          properties: { body: { type: "string" } },
          required: ["body"],
        },
      });
    expect((schema.properties?.selected as any).anyOf).toHaveLength(2);
    expect((schema.properties?.selected as any).anyOf.map(
      (entry: any) => entry.asFactory.kind,
    )).toEqual(["pattern", "module"]);
  });

  it("emits self-contained documents for recursive nested factory contracts", async () => {
    const code = `
      interface RecursiveValue {
        value: string;
        next?: RecursiveValue;
      }

      interface ClosureParams {
        operation: ModuleFactory<RecursiveValue, RecursiveValue>;
      }

      interface PublicResult {
        operation: HandlerFactory<RecursiveValue, RecursiveValue>;
      }

      interface SchemaRoot {
        factory: PatternFactory<ClosureParams, PublicResult>;
      }
    `;
    const { type, checker } = await getTrustedFactoryType(code, "SchemaRoot");
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    const documents = collectFactorySchemaDocuments(schema);
    expect(documents.length).toBe(6);
    for (const document of documents) {
      expect(hasOnlyResolvableLocalRefs(document)).toBe(true);
    }
  });

  it("rejects recursively nested factory contracts without expanding forever", async () => {
    const code = `
      interface RecursiveResult {
        self: ModuleFactory<{ value: string }, RecursiveResult>;
      }

      interface SchemaRoot {
        factory: ModuleFactory<{ value: string }, RecursiveResult>;
      }
    `;
    const { type, checker } = await getTrustedFactoryType(code, "SchemaRoot");

    expect(() => new SchemaGenerator().generateSchema(type, checker))
      .toThrow(
        /test\.ts:\d+:\d+: Recursive nested factory contract.*cannot be emitted as a finite self-contained schema document/,
      );
  });

  it("uses a compiler-owned factory contract for a deliberately bare callable property", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `
        type SchemaRoot = {
          operation: (inputs: { stale: string }) => { stale: boolean };
        };
      `,
      "SchemaRoot",
    );
    if (!typeNode || !ts.isTypeLiteralNode(typeNode)) {
      throw new Error("Expected a type-literal root");
    }
    const operation = typeNode.members.find((member) =>
      ts.isPropertySignature(member) &&
      ts.isIdentifier(member.name) &&
      member.name.text === "operation"
    );
    if (!operation || !ts.isPropertySignature(operation) || !operation.type) {
      throw new Error("Expected an operation property");
    }
    const objectType = (name: string, value: ts.KeywordTypeSyntaxKind) =>
      ts.factory.createTypeLiteralNode([
        ts.factory.createPropertySignature(
          undefined,
          name,
          undefined,
          ts.factory.createKeywordTypeNode(value),
        ),
      ]);
    const schemaHints = new WeakMap<ts.Node, {
      factoryContracts?: readonly {
        kind: "module";
        inputTypeNode: ts.TypeNode;
        outputTypeNode: ts.TypeNode;
      }[];
    }>();
    schemaHints.set(operation.type, {
      factoryContracts: [{
        kind: "module",
        inputTypeNode: objectType("value", ts.SyntaxKind.StringKeyword),
        outputTypeNode: objectType("size", ts.SyntaxKind.NumberKeyword),
      }],
    });

    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(
        type,
        checker,
        typeNode,
        undefined,
        schemaHints,
      ),
    );
    expect(schema.properties?.operation).toEqual({
      asFactory: {
        kind: "module",
        argumentSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        resultSchema: {
          type: "object",
          properties: { size: { type: "number" } },
          required: ["size"],
        },
      },
    });
  });

  it("uses compiler-owned exact contracts for factories inside readonly tuples", async () => {
    const code = `
      type SchemaRoot = readonly [PatternFactory<{ stale: string }, any>];
    `;
    const { type, checker, typeNode } = await getTrustedFactoryType(
      code,
      "SchemaRoot",
    );
    expect(typeNode).toBeTruthy();
    const tuple = typeNode && ts.isTypeOperatorNode(typeNode)
      ? typeNode.type
      : typeNode;
    if (!tuple || !ts.isTupleTypeNode(tuple)) {
      throw new Error("Expected readonly tuple type node");
    }
    const factoryNode = tuple.elements[0]!;
    const inputTypeNode = ts.factory.createTypeLiteralNode([
      ts.factory.createPropertySignature(
        undefined,
        "current",
        undefined,
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
      ),
    ]);
    const outputTypeNode = ts.factory.createTypeLiteralNode([
      ts.factory.createPropertySignature(
        undefined,
        "result",
        undefined,
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword),
      ),
    ]);
    const schemaHints = new WeakMap<ts.Node, {
      factoryContracts?: readonly {
        kind: "pattern";
        inputTypeNode: ts.TypeNode;
        outputTypeNode: ts.TypeNode;
      }[];
    }>();
    schemaHints.set(factoryNode, {
      factoryContracts: [{ kind: "pattern", inputTypeNode, outputTypeNode }],
    });

    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(
        type,
        checker,
        typeNode,
        undefined,
        schemaHints,
      ),
    );
    expect((schema.items as any).asFactory).toEqual({
      kind: "pattern",
      argumentSchema: {
        type: "object",
        properties: { current: { type: "number" } },
        required: ["current"],
      },
      resultSchema: {
        type: "object",
        properties: { result: { type: "boolean" } },
        required: ["result"],
      },
    });
  });

  it("emits every compiler-owned contract sharing one semantic factory type", async () => {
    const code = `
      type SchemaRoot = PatternFactory<{ stale: string }, any>;
    `;
    const { type, checker, typeNode } = await getTrustedFactoryType(
      code,
      "SchemaRoot",
    );
    expect(typeNode).toBeTruthy();
    const objectType = (name: string, value: ts.KeywordTypeSyntaxKind) =>
      ts.factory.createTypeLiteralNode([
        ts.factory.createPropertySignature(
          undefined,
          name,
          undefined,
          ts.factory.createKeywordTypeNode(value),
        ),
      ]);
    const inputTypeNode = objectType("value", ts.SyntaxKind.StringKeyword);
    const schemaHints = new WeakMap<ts.Node, unknown>();
    schemaHints.set(typeNode!, {
      factoryContracts: [
        {
          kind: "pattern",
          inputTypeNode,
          outputTypeNode: objectType("text", ts.SyntaxKind.StringKeyword),
        },
        {
          kind: "pattern",
          inputTypeNode,
          outputTypeNode: objectType("size", ts.SyntaxKind.NumberKeyword),
        },
      ],
    });

    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(
        type,
        checker,
        typeNode,
        undefined,
        schemaHints as never,
      ),
    );
    expect(schema.anyOf).toEqual([
      {
        asFactory: {
          kind: "pattern",
          argumentSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
          resultSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      },
      {
        asFactory: {
          kind: "pattern",
          argumentSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
          resultSchema: {
            type: "object",
            properties: { size: { type: "number" } },
            required: ["size"],
          },
        },
      },
    ]);
  });

  it("preserves exact compiler-owned schema values beyond TypeScript types", async () => {
    const code = `
      type SchemaRoot = PatternFactory<{ stale: string }, any>;
    `;
    const { type, checker, typeNode } = await getTrustedFactoryType(
      code,
      "SchemaRoot",
    );
    expect(typeNode).toBeTruthy();
    const unknownNode = ts.factory.createKeywordTypeNode(
      ts.SyntaxKind.UnknownKeyword,
    );
    const schemaHints = new WeakMap<ts.Node, unknown>();
    schemaHints.set(typeNode!, {
      factoryContracts: [{
        kind: "pattern",
        inputTypeNode: unknownNode,
        inputSchema: {
          type: "string",
          description: "authored metadata",
          minLength: 3,
        },
        outputTypeNode: unknownNode,
        outputSchema: false,
      }],
    });

    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(
        type,
        checker,
        typeNode,
        undefined,
        schemaHints as never,
      ),
    );
    expect(schema.asFactory).toEqual({
      kind: "pattern",
      argumentSchema: {
        type: "string",
        description: "authored metadata",
        minLength: 3,
      },
      resultSchema: false,
    });
  });
});

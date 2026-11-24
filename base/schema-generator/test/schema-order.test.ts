import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import { SchemaGenerator } from "../src/schema-generator.ts";
import { createTestProgram } from "./utils.ts";

/**
 * The schema `generate` emits for `code` from a fresh program, once with the
 * checker resolving types as generation asks for them and once after it has
 * checked the whole file first. The checker orders a union's members by the
 * order it created their types in, which the second run changes: a file's
 * first statements mention the members in the opposite order to the one the
 * source states them in. Both readings of one source must emit one schema.
 */
async function bothReadings(
  code: string,
  generate: (
    generator: SchemaGenerator,
    checker: ts.TypeChecker,
    sourceFile: ts.SourceFile,
  ) => unknown,
): Promise<{ lazy: unknown; checkedFirst: unknown }> {
  const read = async (checkFirst: boolean) => {
    const { program, checker, sourceFile } = await createTestProgram(code);
    if (checkFirst) program.getSemanticDiagnostics(sourceFile);
    return generate(new SchemaGenerator(), checker, sourceFile);
  };
  return { lazy: await read(false), checkedFirst: await read(true) };
}

/** The schema of the interface `name` declared in `sourceFile`. */
function interfaceSchema(name: string) {
  return (
    generator: SchemaGenerator,
    checker: ts.TypeChecker,
    sourceFile: ts.SourceFile,
  ) => {
    const declaration = sourceFile.statements.find((
      statement,
    ): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name
    )!;
    const symbol = checker.getSymbolAtLocation(declaration.name)!;
    return generator.generateSchema(
      checker.getDeclaredTypeOfSymbol(symbol),
      checker,
    );
  };
}

/**
 * The schema of the variable statement `index` declares, read from a node
 * built from the checker's type alone, as the generator reads a node a
 * transform built for an inferred type it could not resolve: through `any`.
 */
function synthesizedNodeSchema(index: number) {
  return (
    generator: SchemaGenerator,
    checker: ts.TypeChecker,
    sourceFile: ts.SourceFile,
  ) => {
    const statement = sourceFile.statements[index] as ts.VariableStatement;
    const type = checker.getTypeAtLocation(
      statement.declarationList.declarations[0]!,
    );
    const node = checker.typeToTypeNode(
      type,
      undefined,
      ts.NodeBuilderFlags.NoTruncation,
    )!;
    return generator.generateSchema(checker.getAnyType(), checker, node);
  };
}

/** The schema of the class `name` declared in `sourceFile`. */
function classSchema(name: string) {
  return (
    generator: SchemaGenerator,
    checker: ts.TypeChecker,
    sourceFile: ts.SourceFile,
  ) => {
    const declaration = sourceFile.statements.find((
      statement,
    ): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === name
    )!;
    const symbol = checker.getSymbolAtLocation(declaration.name!)!;
    return generator.generateSchema(
      checker.getDeclaredTypeOfSymbol(symbol),
      checker,
    );
  };
}

describe("schema-order", () => {
  describe("a union the source writes", () => {
    it("emits a literal union's values in the order they are written", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          'export const early = "group";',
          'export type Kind = "direct" | "group";',
          "export interface Wrap { kind: Kind; }",
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
      expect(lazy).toMatchObject({
        $defs: { Kind: { enum: ["direct", "group"] } },
      });
    });

    it("emits a union's alternatives in the order they are written", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          "export const early: Banana | undefined = undefined;",
          "export interface Apple { a: string; }",
          "export interface Banana { b: number; }",
          "export interface Wrap { fruit: Apple | Banana; }",
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
      expect(lazy).toMatchObject({
        properties: {
          fruit: {
            anyOf: [{ $ref: "#/$defs/Apple" }, { $ref: "#/$defs/Banana" }],
          },
        },
      });
    });

    it("emits a written alias's members where the alias is written", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          'export const early: "c" | "b" = "c";',
          'export type Tail = "b" | "c";',
          'export interface Wrap { letter: "a" | Tail | "d"; }',
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
      expect(lazy).toMatchObject({
        properties: { letter: { enum: ["a", "b", "c", "d"] } },
      });
    });

    it("emits a union of cell wrappers in the order they are written", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          'import type { Cell } from "commonfabric";',
          "export const early: Banana | undefined = undefined;",
          "export interface Apple { a: string; }",
          "export interface Banana { b: number; }",
          "export interface Wrap { fruit: Cell<Apple> | Banana; }",
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
      expect(lazy).toMatchObject({
        properties: {
          fruit: {
            anyOf: [
              { $ref: "#/$defs/Apple", asCell: ["cell"] },
              { $ref: "#/$defs/Banana" },
            ],
          },
        },
      });
    });
  });

  describe("a union its alias writes, read at a built node", () => {
    it("emits the members in the order the alias declares them", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          'export const early = "group";',
          'export type Kind = "direct" | "group";',
          'export const kind: Kind = "direct";',
        ].join("\n"),
        (generator, checker, sourceFile) => {
          const statement = sourceFile.statements[2] as ts.VariableStatement;
          const type = checker.getTypeAtLocation(
            statement.declarationList.declarations[0]!,
          );
          // A transform that prints the declared type of `kind` builds a
          // reference to `Kind`, whose symbol the checker cannot read.
          const node = checker.typeToTypeNode(type, undefined, undefined)!;
          return generator.generateSchema(type, checker, node);
        },
      );

      expect(checkedFirst).toEqual(lazy);
      expect(lazy).toEqual({ enum: ["direct", "group"] });
    });
  });

  describe("a union read through an indexed access", () => {
    it("emits the members in the order the property declares them", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          'export const early: "stale" | "complete" = "stale";',
          'export interface Row { status: "complete" | "partial" | "stale" | "deleted"; }',
          'export interface Wrap { status: Row["status"]; }',
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
      expect(lazy).toMatchObject({
        properties: {
          status: { enum: ["complete", "partial", "stale", "deleted"] },
        },
      });
    });
  });

  describe("a union of cell wrappers alone", () => {
    it("emits wrappers read through an indexed access in the order the property declares", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          'import type { Cell } from "commonfabric";',
          "export const early: Cell<Banana> | undefined = undefined;",
          "export interface Apple { a: string; }",
          "export interface Banana { b: number; }",
          "export interface Row { fruit: Cell<Apple> | Cell<Banana>; }",
          'export interface Wrap { fruit: Row["fruit"]; }',
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
      expect(lazy).toMatchObject({
        properties: {
          fruit: {
            anyOf: [
              { $ref: "#/$defs/Apple", asCell: ["cell"] },
              { $ref: "#/$defs/Banana", asCell: ["cell"] },
            ],
          },
        },
      });
    });

    it("emits a parenthesized union of wrappers in the order it is written", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          'import type { Cell } from "commonfabric";',
          "export const early: Cell<Banana> | undefined = undefined;",
          "export interface Apple { a: string; }",
          "export interface Banana { b: number; }",
          "export interface Wrap { fruit: (Cell<Apple> | Cell<Banana>); }",
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
      expect(lazy).toMatchObject({
        properties: {
          fruit: {
            anyOf: [
              { $ref: "#/$defs/Apple", asCell: ["cell"] },
              { $ref: "#/$defs/Banana", asCell: ["cell"] },
            ],
          },
        },
      });
    });

    it("emits the wrappers in the order they are written", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          'import type { Cell } from "commonfabric";',
          "export const early: Cell<Banana> | undefined = undefined;",
          "export interface Apple { a: string; }",
          "export interface Banana { b: number; }",
          "export interface Wrap { fruit: Cell<Apple> | Cell<Banana>; }",
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
      expect(lazy).toMatchObject({
        properties: {
          fruit: {
            anyOf: [
              { $ref: "#/$defs/Apple", asCell: ["cell"] },
              { $ref: "#/$defs/Banana", asCell: ["cell"] },
            ],
          },
        },
      });
    });
  });

  describe("a union the source does not order", () => {
    it("emits a TS enum's members and another declared type in one order", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          "export const early = {} as M | E.Z | E.A;",
          'export enum E { Z = "z", A = "a" }',
          "export interface M { m: string; }",
          "export interface Wrap { items: [E.Z, E.A, M]; }",
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
    });

    it("emits a checker-built literal union's values in value order", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          'export const early: "zeta" | "beta" = "zeta";',
          "export interface Full { zeta: string; alpha: string; beta: string; }",
          "export interface Wrap { key: keyof Full; }",
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
      expect(lazy).toMatchObject({
        properties: { key: { enum: ["alpha", "beta", "zeta"] } },
      });
    });

    it("emits a synthesized union node's members in value order", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          'export const early = "group";',
          'export const kind = Math.random() > 0.5 ? "direct" as const : "group" as const;',
        ].join("\n"),
        (generator, checker, sourceFile) => {
          const statement = sourceFile.statements[1] as ts.VariableStatement;
          const type = checker.getTypeAtLocation(
            statement.declarationList.declarations[0]!,
          );
          // A node built from the checker's type, as ts-transformers builds
          // one for an inferred type, lists the members in the checker's
          // order rather than any the source states.
          const node = checker.typeToTypeNode(
            type,
            undefined,
            ts.NodeBuilderFlags.NoTruncation,
          )!;
          return generator.generateSchema(type, checker, node);
        },
      );

      expect(checkedFirst).toEqual(lazy);
      expect(lazy).toEqual({ enum: ["direct", "group"] });
    });
    it("emits a copy of a written union node read without its type in the order it is written", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          'export const early = "a";',
          'export type Kind = "b" | "a";',
        ].join("\n"),
        (generator, checker, sourceFile) => {
          const written = (sourceFile.statements[1] as ts.TypeAliasDeclaration)
            .type as ts.UnionTypeNode;
          // A transform that copies a written node keeps the node it copied
          // as the copy's original, and the copy has no place in the file.
          const copy = ts.setOriginalNode(
            ts.factory.createUnionTypeNode([...written.types]),
            written,
          );
          return generator.generateSchema(checker.getAnyType(), checker, copy);
        },
      );

      expect(checkedFirst).toEqual(lazy);
      expect(JSON.stringify(lazy)).toMatch(/"b".*"a"/);
    });

    it("emits a synthesized union node read without its type in value order", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          'export const early = "group";',
          'export const kind = Math.random() > 0.5 ? "direct" as const : "group" as const;',
        ].join("\n"),
        synthesizedNodeSchema(1),
      );

      expect(checkedFirst).toEqual(lazy);
      expect(JSON.stringify(lazy)).toMatch(/direct.*group/);
    });

    it("emits a synthesized union node's object members in one order without their type", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          "export const early: typeof right | undefined = undefined;",
          "declare const left: { a: string };",
          "declare const right: { b: number };",
          "export const pick = Math.random() > 0.5 ? left : right;",
        ].join("\n"),
        synthesizedNodeSchema(3),
      );

      expect(checkedFirst).toEqual(lazy);
      expect(lazy).toEqual({
        anyOf: [
          {
            type: "object",
            properties: { a: { type: "string" } },
            required: ["a"],
          },
          {
            type: "object",
            properties: { b: { type: "number" } },
            required: ["b"],
          },
        ],
      });
    });
    it("emits an inferred union of two instantiations of one generic in one order", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          "export interface Box<T> { v: T; }",
          "export const early: Box<number> | undefined = undefined;",
          "declare const a: Box<string>;",
          "declare const b: Box<number>;",
          "export const pick = Math.random() > 0.5 ? a : b;",
          "export interface Wrap { p: typeof pick; }",
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
    });

    it("emits an inferred union of two deeply nested instantiations in one order", async () => {
      const deep = (inner: string) =>
        `Box<Box<Box<Box<Box<Box<Box<Box<Box<Box<${inner}>>>>>>>>>>`;
      const { lazy, checkedFirst } = await bothReadings(
        [
          "export interface Box<T> { v: T; }",
          `export const early: ${deep("number")} | undefined = undefined;`,
          `declare const a: ${deep("string")};`,
          `declare const b: ${deep("number")};`,
          "export const pick = Math.random() > 0.5 ? a : b;",
          "export interface Wrap { p: typeof pick; }",
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
    });

    it("emits an inferred union of two instantiations of a generic function's return type in one order", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          "function make<T>(v: T) { return { v }; }",
          "export const early = make(1);",
          "declare const a: ReturnType<typeof make<string>>;",
          "declare const b: ReturnType<typeof make<number>>;",
          "export const pick = Math.random() > 0.5 ? a : b;",
          "export interface Wrap { p: typeof pick; }",
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
      expect(lazy).toMatchObject({
        properties: {
          p: {
            anyOf: [
              { properties: { v: { type: "number" } } },
              { properties: { v: { type: "string" } } },
            ],
          },
        },
      });
    });

    it("emits an inferred union of two intersections in one order", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          "export interface A { a: string; }",
          "export interface B { b: string; }",
          "export interface C { c: string; }",
          "export const early: (A & C) | undefined = undefined;",
          "declare const left: A & B;",
          "declare const right: A & C;",
          "export const pick = Math.random() > 0.5 ? left : right;",
          "export interface Wrap { p: typeof pick; }",
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
    });
  });

  describe("a tuple's items", () => {
    it("emits two instantiations of one generic in the order the tuple lists them", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          "export const early: Box<number> | undefined = undefined;",
          "export interface Box<T> { v: T; }",
          "export interface Wrap { t: [Box<string>, Box<number>]; }",
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
      expect(lazy).toMatchObject({
        properties: {
          t: {
            items: {
              anyOf: [
                { properties: { v: { type: "string" } } },
                { properties: { v: { type: "number" } } },
              ],
            },
          },
        },
      });
    });

    it("emits an intrinsic element where the tuple lists it", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          "export const early: string | undefined = undefined;",
          "export interface Box<T> { v: T; }",
          "export interface Wrap { t: [Box<string>, string]; }",
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
      expect(lazy).toMatchObject({
        properties: {
          t: {
            items: {
              anyOf: [
                { properties: { v: { type: "string" } } },
                { type: "string" },
              ],
            },
          },
        },
      });
    });

    it("emits two tuples in the order the tuple lists them", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          "export const early: [number] | undefined = undefined;",
          "export interface Wrap { t: [[string], [number]]; }",
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
      expect(lazy).toMatchObject({
        properties: {
          t: {
            items: {
              anyOf: [
                { items: { type: "string" } },
                { items: { type: "number" } },
              ],
            },
          },
        },
      });
    });
  });

  describe("a recursion that instantiates its declaration without end", () => {
    it("cuts a recursive tuple alias at one depth whatever else the program instantiates", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          "export type Tup<T> = [T, Tup<T[]>?];",
          "export interface Wrap<T> { n: Tup<T>; deep: Tup<T[][][][][]>; }",
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
    });

    it("cuts a recursion whose arguments repeat a type at one depth whatever else the program instantiates", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          "export interface Dup<T> { next: Dup<[T, T]>; }",
          "export interface Wrap<T> { n: Dup<T>; }",
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
    });

    it("cuts a two-branch recursive tuple alias at one depth whatever else the program instantiates", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          "export type Tup<T> = [T, Tup<T[]>?, Tup<[T]>?];",
          "export interface Wrap<T> { n: Tup<T>; d1: Tup<T[][][]>; d2: Tup<[[[T]]]>; }",
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
    });
  });

  describe("a mapped type's properties", () => {
    it("emits an omission's properties in their declaration order", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          'export const early: "zeta" | "beta" = "zeta";',
          "export interface Full { alpha: string; beta: string; zeta: string; drop: string; }",
          'export interface Wrap { view: Omit<Full, "drop">; }',
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
      const view = (lazy as { properties: { view: Record<string, unknown> } })
        .properties.view;
      expect(Object.keys(view.properties as object)).toEqual([
        "alpha",
        "beta",
        "zeta",
      ]);
      expect(view.required).toEqual(["alpha", "beta", "zeta"]);
    });

    it("emits a mapped type's numeric keys in the order they are written", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          "export const early: 1 = 1;",
          "export interface Wrap { byKey: { [K in 2 | 1 | -1]: string }; }",
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
      // A JavaScript object lists integer-like keys in ascending order
      // whatever order they are added in, so the order shows in `required`.
      const byKey = (lazy as { properties: { byKey: { required: string[] } } })
        .properties.byKey;
      expect(byKey.required).toEqual(["2", "1", "-1"]);
    });

    it("emits an omission of an interface with two bases in their heritage order", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          'export const early: "d" | "b" | "c" = "d";',
          "export interface Left { a: string; c: string; }",
          "export interface Right { b: string; d: string; }",
          "export interface Full extends Left, Right { drop: string; }",
          'export interface Wrap extends Omit<Full, "drop"> { own: number; }',
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
      expect((lazy as { required: string[] }).required).toEqual([
        "own",
        "a",
        "c",
        "b",
        "d",
      ]);
    });

    it("emits an inherited mapped type over keys of its own by those keys, not by its type argument", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          'export type Keyed<T> = { [P in "a" | "b"]: T };',
          "export interface Wrap extends Keyed<{ b: string; a: string }> {",
          "  own: number;",
          "}",
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
      expect((lazy as { required: string[] }).required).toEqual([
        "own",
        "a",
        "b",
      ]);
    });

    it("emits the properties an interface inherits from an omission in their declaration order", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          'export const early: "zeta" | "beta" = "zeta";',
          "export interface Full { alpha: string; beta: string; zeta: string; drop: string; }",
          'export interface Wrap extends Omit<Full, "drop"> { own: number; }',
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
      const schema = lazy as { properties: object; required: string[] };
      expect(Object.keys(schema.properties)).toEqual([
        "own",
        "alpha",
        "beta",
        "zeta",
      ]);
      expect(schema.required).toEqual(["own", "alpha", "beta", "zeta"]);
    });
  });

  describe("an interface whose mapped base maps over the interface itself", () => {
    it("emits the interface when the base maps keys of its own", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          'type WithChild<T> = { [K in "child"]: T };',
          "export interface Wrap extends WithChild<Wrap> {",
          "  value: string;",
          "}",
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
      expect(lazy).toEqual({
        $ref: "#/$defs/Wrap",
        $defs: {
          Wrap: {
            type: "object",
            properties: {
              value: { type: "string" },
              child: { $ref: "#/$defs/Wrap" },
            },
            required: ["value", "child"],
          },
        },
      });
    });

    it("emits the interface when the base maps no keys", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          "type Empty<T> = { [K in never]: T };",
          "export interface Wrap extends Empty<Wrap> {",
          "  value: string;",
          "}",
        ].join("\n"),
        interfaceSchema("Wrap"),
      );

      expect(checkedFirst).toEqual(lazy);
      expect(lazy).toMatchObject({
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      });
    });
  });

  describe("a class's properties", () => {
    it("emits a constructor's parameter properties before its base's", async () => {
      const { lazy, checkedFirst } = await bothReadings(
        [
          'export class Base { base = ""; }',
          "export class Derived extends Base {",
          "  constructor(public own: number) { super(); }",
          "}",
        ].join("\n"),
        classSchema("Derived"),
      );

      expect(checkedFirst).toEqual(lazy);
      expect((lazy as { required: string[] }).required).toEqual([
        "own",
        "base",
      ]);
    });
  });
});

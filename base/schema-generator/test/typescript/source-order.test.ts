import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import {
  compareTypesBySource,
  propertiesInSourceOrder,
  unionNodeMembersInOrder,
} from "../../src/typescript/source-order.ts";
import { createTestProgram } from "../utils.ts";

/**
 * The type each member of the interface `W` declares, by the member's name,
 * `members` being `W`'s body and `code` what `W` reads.
 */
async function memberTypes(
  code: string,
  members: string,
): Promise<{ checker: ts.TypeChecker; types: Map<string, ts.Type> }> {
  const { checker, sourceFile } = await createTestProgram(
    `${code}\ninterface W { ${members} }`,
  );
  const w = sourceFile.statements.find((
    statement,
  ): statement is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(statement) && statement.name.text === "W"
  )!;
  const types = new Map<string, ts.Type>();
  for (const member of w.members.filter(ts.isPropertySignature)) {
    types.set(member.name.getText(), checker.getTypeFromTypeNode(member.type!));
  }
  return { checker, types };
}

/**
 * The sign of `compareTypesBySource()` for the member types `left` and
 * `right` of `types`, each way round.
 */
function signs(
  types: Map<string, ts.Type>,
  left: string,
  right: string,
): [number, number] {
  return [
    Math.sign(compareTypesBySource(types.get(left)!, types.get(right)!)),
    Math.sign(compareTypesBySource(types.get(right)!, types.get(left)!)),
  ];
}

/** The member of the union `type` that is an object type. */
function objectMember(type: ts.Type): ts.Type {
  return type.isUnion()
    ? type.types.find((member) => (member.flags & ts.TypeFlags.Object) !== 0)!
    : type;
}

describe("source-order", () => {
  describe("unionNodeMembersInOrder()", () => {
    const f = ts.factory;
    const bigint = (text: string) =>
      f.createLiteralTypeNode(f.createBigIntLiteral(text));
    const negated = (text: string) =>
      f.createLiteralTypeNode(
        f.createPrefixUnaryExpression(
          ts.SyntaxKind.MinusToken,
          f.createBigIntLiteral(text),
        ),
      );
    const texts = (nodes: readonly ts.TypeNode[]) =>
      nodes.map((node) => {
        const literal = (node as ts.LiteralTypeNode).literal;
        return ts.isPrefixUnaryExpression(literal)
          ? `-${(literal.operand as ts.BigIntLiteral).text}`
          : (literal as ts.BigIntLiteral).text;
      });

    it("lists a built union's bigint members by value", () => {
      const union = f.createUnionTypeNode([
        bigint("10n"),
        bigint("2n"),
        negated("3n"),
      ]);

      expect(texts(unionNodeMembersInOrder(union))).toEqual([
        "-3n",
        "2n",
        "10n",
      ]);
    });

    it("lists members that differ by their type operator alone in one order whatever order they came in", () => {
      const object = () =>
        f.createTypeLiteralNode([
          f.createPropertySignature(
            undefined,
            "a",
            undefined,
            f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
          ),
        ]);
      const keyOf = f.createTypeOperatorNode(
        ts.SyntaxKind.KeyOfKeyword,
        object(),
      );
      const readOnly = f.createTypeOperatorNode(
        ts.SyntaxKind.ReadonlyKeyword,
        object(),
      );
      const operators = (members: ts.TypeNode[]) =>
        unionNodeMembersInOrder(f.createUnionTypeNode(members)).map((node) =>
          (node as ts.TypeOperatorNode).operator
        );

      expect(operators([keyOf, readOnly])).toEqual(
        operators([readOnly, keyOf]),
      );
    });

    const printed = (nodes: readonly ts.TypeNode[]) => {
      const printer = ts.createPrinter();
      const file = ts.createSourceFile("x.ts", "", ts.ScriptTarget.ES2023);
      return nodes.map((node) =>
        printer.printNode(ts.EmitHint.Unspecified, node, file)
      );
    };
    const literal = (expression: ts.LiteralTypeNode["literal"]) =>
      f.createLiteralTypeNode(expression);

    it("keeps a built union's boolean members in place and lists the rest by kind and value", () => {
      const union = f.createUnionTypeNode([
        literal(f.createStringLiteral("b")),
        literal(f.createTrue()),
        literal(f.createNumericLiteral("10")),
        literal(f.createFalse()),
        literal(
          f.createPrefixUnaryExpression(
            ts.SyntaxKind.MinusToken,
            f.createNumericLiteral("5"),
          ),
        ),
        literal(f.createNumericLiteral("2")),
        literal(f.createNoSubstitutionTemplateLiteral("ab")),
        literal(f.createStringLiteral("a")),
      ]);

      expect(printed(unionNodeMembersInOrder(union))).toEqual([
        "-5",
        "true",
        "2",
        "false",
        "10",
        '"a"',
        "`ab`",
        '"b"',
      ]);
    });

    it("lists a built union's object members by the numbers they hold", () => {
      const holding = (value: string) =>
        f.createTypeLiteralNode([
          f.createPropertySignature(
            undefined,
            "a",
            undefined,
            literal(f.createNumericLiteral(value)),
          ),
        ]);

      expect(
        printed(
          unionNodeMembersInOrder(
            f.createUnionTypeNode([holding("2"), holding("1")]),
          ),
        ).map((text) => text.replace(/\s+/g, " ")),
      ).toEqual(["{ a: 1; }", "{ a: 2; }"]);
    });

    it("lists import types that differ by `typeof` alone in one order whatever order they came in", () => {
      const importType = (isTypeOf: boolean) =>
        f.createImportTypeNode(
          literal(f.createStringLiteral("m")),
          undefined,
          undefined,
          undefined,
          isTypeOf,
        );
      const order = (members: ts.TypeNode[]) =>
        unionNodeMembersInOrder(f.createUnionTypeNode(members)).map((node) =>
          (node as ts.ImportTypeNode).isTypeOf
        );

      expect(order([importType(true), importType(false)])).toEqual(
        order([importType(false), importType(true)]),
      );
    });
  });

  describe("propertiesInSourceOrder()", () => {
    /**
     * The names of the properties of the type `node`, the type of the alias
     * `Probe` in `code`, denotes, in the order `propertiesInSourceOrder()`
     * gives them, reading the type at `node` where `withNode` is set.
     */
    async function orderedNames(code: string, withNode = true) {
      const { checker, sourceFile } = await createTestProgram(code);
      const alias = sourceFile.statements.find((
        statement,
      ): statement is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(statement) && statement.name.text === "Probe"
      )!;
      const type = checker.getTypeFromTypeNode(alias.type);
      return propertiesInSourceOrder(
        type,
        checker.getPropertiesOfType(type),
        withNode ? alias.type : undefined,
        checker,
      ).map((property) => property.getName());
    }

    it("lists a mapped type's properties in the order its keys are written, a template literal key among them", async () => {
      // `early` makes the checker create "a" first, so that its own order of
      // the keys is not the written one.
      const names = await orderedNames(
        'declare const early: "a";\ntype Probe = { [P in `b` | "a"]: number };',
      );

      expect(names).toEqual(["b", "a"]);
    });

    it("gives a mapped type's key that names no property no place among its properties", async () => {
      // `false` is no key a property can have, and the checker reports it;
      // the properties the other keys make are still in the order they are
      // written.
      const names = await orderedNames(
        'declare const early: "false";\ntype Probe = { [P in false | "b" | "false"]: number };',
      );

      expect(names).toEqual(["b", "false"]);
    });

    it("lists a mapped property with a declaration before one without", async () => {
      // `Pick` maps the intersection's properties, and links each to the
      // declaration of the one it maps: `y` to its declaration, `x` to none,
      // since a mapped type over keys of its own declares none.
      const names = await orderedNames(
        'type Probe = Pick<{ [P in "x"]: 1 } & { y: 2 }, "x" | "y">;',
        false,
      );

      expect(names).toEqual(["y", "x"]);
    });
  });

  describe("compareTypesBySource()", () => {
    it("orders bigint literals by value", async () => {
      const { types } = await memberTypes("", "nine: 9n; ten: 10n; low: -3n;");

      expect(signs(types, "nine", "ten")).toEqual([-1, 1]);
      expect(signs(types, "low", "nine")).toEqual([-1, 1]);
    });

    it("orders template literal types by their text and then the types between it", async () => {
      // Neither is declared or a literal, so each is read by what it writes.
      const { types } = await memberTypes(
        "interface Pair<A, B> { a: A; b: B }",
        [
          "px: Pair<`${number}px`, `${number}px`>;",
          "em: Pair<`${string}em`, `${string}em`>;",
          "numberEm: `${number}em`;",
          "stringEm: `${string}em`;",
        ].join(" "),
      );

      expect(signs(types, "em", "px")).toEqual([-1, 1]);
      expect(signs(types, "numberEm", "stringEm")).toEqual([-1, 1]);
    });

    it("orders string mappings by the type each maps", async () => {
      const { types } = await memberTypes(
        "",
        "text: Uppercase<string>; digits: Uppercase<`${number}`>;",
      );

      expect(signs(types, "text", "digits")).toEqual([-1, 1]);
    });

    it("orders two instantiations of a generic function's inferred result by what instantiated them", async () => {
      // `pipe` infers a generic function for its result, and `outer` returns
      // one that also holds its own `Q`: each call instantiates that result
      // again.
      const { checker, types } = await memberTypes(
        [
          "declare function pipe<A extends unknown[], B, C>(",
          "  ab: (...args: A) => B,",
          "  bc: (b: B) => C,",
          "): (...args: A) => C;",
          "declare function list<T>(a: T): T[];",
          "function outer<Q>(q: Q) {",
          "  return pipe(list, <U>(x: U) => ({ x, q }));",
          "}",
          'const s = outer("s");',
          "const n = outer(1);",
        ].join("\n"),
        "s: typeof s; n: typeof n;",
      );

      expect(checker.typeToString(types.get("s")!)).toBe(
        "<T>(a: T) => { x: T[]; q: string; }",
      );
      expect(signs(types, "n", "s")).toEqual([-1, 1]);
    });

    it("orders two arrays a recursive alias defers by what instantiated them", async () => {
      const { types } = await memberTypes(
        [
          "type R<T> = T | Array<R<T>>;",
          "type R2<A, B> = A | Array<R2<A, B>>;",
        ].join("\n"),
        "s: R<string>; n: R<number>; sn: R2<string, number>; sb: R2<string, boolean>;",
      );
      const arrays = new Map(
        [...types].map(([name, type]) => [name, objectMember(type)]),
      );

      expect(signs(arrays, "n", "s")).toEqual([-1, 1]);
      expect(signs(arrays, "sb", "sn")).toEqual([-1, 1]);
    });

    it("orders the array a recursive alias declares before an instantiation of it", async () => {
      const { checker, sourceFile } = await createTestProgram(
        "type R<T> = T | Array<R<T>>;\ninterface W { s: R<string> }",
      );
      const alias = sourceFile.statements[0] as ts.TypeAliasDeclaration;
      const w = sourceFile.statements[1] as ts.InterfaceDeclaration;
      const declared = objectMember(checker.getTypeFromTypeNode(alias.type));
      const instantiated = objectMember(
        checker.getTypeFromTypeNode(
          (w.members[0] as ts.PropertySignature).type!,
        ),
      );

      expect(Math.sign(compareTypesBySource(declared, instantiated))).toBe(-1);
      expect(Math.sign(compareTypesBySource(instantiated, declared))).toBe(1);
    });

    it("orders objects no source declares by their properties' names, then their types", async () => {
      // `unbox` infers its `T` by reversing the mapped type it takes, which
      // builds an object no source declares.
      const { types } = await memberTypes(
        [
          "interface Box<T> { v: T }",
          "declare function unbox<T>(b: { [K in keyof T]: Box<T[K]> }): T;",
          "declare const bs: Box<string>;",
          "declare const bn: Box<number>;",
          "const ab = unbox({ a: bs, b: bs });",
          "const ac = unbox({ a: bs, c: bs });",
          "const abNumber = unbox({ a: bs, b: bn });",
          "const abAgain = unbox({ a: bs, b: bs });",
        ].join("\n"),
        "ab: typeof ab; ac: typeof ac; abNumber: typeof abNumber; abAgain: typeof abAgain;",
      );

      expect(signs(types, "ab", "ac")).toEqual([-1, 1]);
      expect(signs(types, "abNumber", "ab")).toEqual([-1, 1]);
      expect(signs(types, "ab", "abAgain")).toEqual([0, 0]);
    });

    it("orders references whose arguments are unions by the unions' members", async () => {
      const { types } = await memberTypes(
        "",
        "ab: Promise<{ a: 1 } | { b: 2 }>; ac: Promise<{ a: 1 } | { c: 2 }>;",
      );

      expect(signs(types, "ab", "ac")).toEqual([-1, 1]);
    });

    it("orders instantiations of two aliases by the aliases' names, then where they are declared", async () => {
      const { types } = await memberTypes(
        [
          "type B<T> = { v: T } | null;",
          "type A<T> = { v: T } | null;",
          "namespace N { export type A<T> = { v: T } | null; }",
        ].join("\n"),
        "b: Promise<B<1>>; a: Promise<A<1>>; na: Promise<N.A<1>>;",
      );

      expect(signs(types, "a", "b")).toEqual([-1, 1]);
      expect(signs(types, "a", "na")).toEqual([-1, 1]);
    });

    it("orders tuples by their arity, then by their elements' kinds, before their elements", async () => {
      // Each pair is ordered the other way round by its elements' types,
      // which put `number` before `string`; an optional element's type holds
      // `undefined`, as `required`'s second element does.
      const { types } = await memberTypes(
        "",
        "one: Promise<[string]>; pair: Promise<[number, string]>; required: Promise<[string, string | undefined]>; optional: Promise<[string, number?]>;",
      );

      expect(signs(types, "one", "pair")).toEqual([-1, 1]);
      expect(signs(types, "required", "optional")).toEqual([-1, 1]);
    });
  });
});

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import {
  denotesSameType,
  readAuthoredTypeNode,
  readAuthoredTypeNodeOnce,
  readUnionMemberNodes,
  sameBesidesUndefined,
  unwrapTypeParentheses,
} from "../../src/typescript/type-node.ts";
import { createTestProgram, createTestProgramFromFiles } from "../utils.ts";

/** The type node the alias `name` in `sourceFile` names. */
function aliasedNode(sourceFile: ts.SourceFile, name: string): ts.TypeNode {
  const declaration = sourceFile.statements.find((
    statement,
  ): statement is ts.TypeAliasDeclaration =>
    ts.isTypeAliasDeclaration(statement) && statement.name.text === name
  );
  if (!declaration) throw new Error(`No type alias \`${name}\``);
  return declaration.type;
}

/** The types of the aliases `names` in `source`. */
async function aliasedTypes(
  source: string,
  ...names: string[]
): Promise<ts.Type[]> {
  const { sourceFile, checker } = await createTestProgram(source);
  return names.map((name) =>
    checker.getTypeFromTypeNode(aliasedNode(sourceFile, name))
  );
}

/** The node inside `node`'s parentheses, which it must have. */
function parenthesized(node: ts.TypeNode): ts.TypeNode {
  if (!ts.isParenthesizedTypeNode(node)) {
    throw new Error("Expected a parenthesized type node");
  }
  return node.type;
}

describe("type-node", () => {
  describe("unwrapTypeParentheses()", () => {
    it("returns the node nested parentheses hold", async () => {
      const { sourceFile } = await createTestProgram("type P = ((string));");
      const probe = aliasedNode(sourceFile, "P");

      expect(unwrapTypeParentheses(probe)).toBe(
        parenthesized(parenthesized(probe)),
      );
    });

    it("returns a node without parentheses unchanged", async () => {
      const { sourceFile } = await createTestProgram("type P = string;");
      const probe = aliasedNode(sourceFile, "P");

      expect(unwrapTypeParentheses(probe)).toBe(probe);
    });

    it("returns a reference to a type alias rather than the node it names", async () => {
      const { sourceFile } = await createTestProgram(
        "type T = string; type P = (T);",
      );
      const probe = aliasedNode(sourceFile, "P");

      expect(unwrapTypeParentheses(probe)).toBe(parenthesized(probe));
    });
  });

  describe("readAuthoredTypeNodeOnce()", () => {
    it("returns the node one pair of parentheses holds", async () => {
      const { sourceFile, checker } = await createTestProgram(
        "type P = ((string));",
      );
      const probe = aliasedNode(sourceFile, "P");

      expect(readAuthoredTypeNodeOnce(probe, checker)).toBe(
        parenthesized(probe),
      );
    });

    it("returns the node a non-generic alias names", async () => {
      const { sourceFile, checker } = await createTestProgram(
        "type T = { a: string }; type P = T;",
      );

      expect(readAuthoredTypeNodeOnce(aliasedNode(sourceFile, "P"), checker))
        .toBe(aliasedNode(sourceFile, "T"));
    });

    it("returns the node an alias names through an import binding", async () => {
      const { program, checker, sourceFile } = await createTestProgramFromFiles(
        {
          "/types.ts": "export type T = number[];",
          "/main.ts": `import type { T } from "./types.ts";
            import type * as types from "./types.ts";
            type P = T;
            type Q = types.T;`,
        },
        "/main.ts",
      );
      const declared = aliasedNode(program.getSourceFile("/types.ts")!, "T");

      expect(readAuthoredTypeNodeOnce(aliasedNode(sourceFile, "P"), checker))
        .toBe(declared);
      expect(readAuthoredTypeNodeOnce(aliasedNode(sourceFile, "Q"), checker))
        .toBe(declared);
    });

    it("returns `undefined` for a reference to a generic alias", async () => {
      const { sourceFile, checker } = await createTestProgram(
        `type Box<V> = { v: V };
         type Defaulted<V = string> = { v: V };
         type P = Box<string>;
         type Q = Defaulted;`,
      );

      expect(readAuthoredTypeNodeOnce(aliasedNode(sourceFile, "P"), checker))
        .toBeUndefined();
      expect(readAuthoredTypeNodeOnce(aliasedNode(sourceFile, "Q"), checker))
        .toBeUndefined();
    });

    it("returns `undefined` for a reference to an interface", async () => {
      const { sourceFile, checker } = await createTestProgram(
        "interface I { a: string } type P = I;",
      );

      expect(readAuthoredTypeNodeOnce(aliasedNode(sourceFile, "P"), checker))
        .toBeUndefined();
    });

    it("returns `undefined` for a keyword, a union, and a synthesized reference", async () => {
      const { sourceFile, checker } = await createTestProgram(
        "type T = string; type P = string; type Q = T | number;",
      );
      const synthesized = ts.factory.createTypeReferenceNode("T");

      expect(readAuthoredTypeNodeOnce(aliasedNode(sourceFile, "P"), checker))
        .toBeUndefined();
      expect(readAuthoredTypeNodeOnce(aliasedNode(sourceFile, "Q"), checker))
        .toBeUndefined();
      expect(readAuthoredTypeNodeOnce(synthesized, checker)).toBeUndefined();
    });
  });

  describe("readAuthoredTypeNode()", () => {
    it("returns the node at the end of parentheses and aliases in any order", async () => {
      const { sourceFile, checker } = await createTestProgram(
        `type A = (B);
         type B = ((C));
         type C = { c: 1 };
         type P = (A);`,
      );

      expect(readAuthoredTypeNode(aliasedNode(sourceFile, "P"), checker))
        .toBe(aliasedNode(sourceFile, "C"));
    });

    it("returns a node that stands for no other unchanged", async () => {
      const { sourceFile, checker } = await createTestProgram(
        "type Box<V> = { v: V }; type P = Box<string>;",
      );
      const probe = aliasedNode(sourceFile, "P");

      expect(readAuthoredTypeNode(probe, checker)).toBe(probe);
    });

    it("returns the members of a union as written", async () => {
      const { sourceFile, checker } = await createTestProgram(
        "type T = string; type P = T | (number);",
      );
      const probe = aliasedNode(sourceFile, "P");

      expect(readAuthoredTypeNode(probe, checker)).toBe(probe);
    });

    it("returns the reference that closes a cycle of aliases", async () => {
      const { sourceFile, checker } = await createTestProgram(
        "type A = B; type B = A; type P = A;",
      );

      expect(readAuthoredTypeNode(aliasedNode(sourceFile, "P"), checker))
        .toBe(aliasedNode(sourceFile, "B"));
    });
  });

  describe("denotesSameType()", () => {
    it("returns `true` for unions of the same members written through two aliases", async () => {
      const [maybe, optional] = await aliasedTypes(
        "type A = { a: string }; type MaybeA = A | undefined; type OrA = undefined | A;",
        "MaybeA",
        "OrA",
      );

      expect(maybe).not.toBe(optional);
      expect(denotesSameType(maybe!, optional!)).toBe(true);
    });

    it("returns `false` for unions of different members", async () => {
      const [maybe, other] = await aliasedTypes(
        "type A = { a: string }; type MaybeA = A | undefined; type NullA = A | null;",
        "MaybeA",
        "NullA",
      );

      expect(denotesSameType(maybe!, other!)).toBe(false);
    });

    it("returns `false` for a union and one of its members", async () => {
      const [maybe, member] = await aliasedTypes(
        "type A = { a: string }; type MaybeA = A | undefined; type B = A;",
        "MaybeA",
        "B",
      );

      expect(denotesSameType(maybe!, member!)).toBe(false);
    });
  });

  describe("sameBesidesUndefined()", () => {
    it("returns `true` for unions that differ only by `undefined`", async () => {
      const [nullable, optional] = await aliasedTypes(
        "type A = { a: string }; type N = A | null; type O = A | null | undefined;",
        "N",
        "O",
      );

      expect(sameBesidesUndefined(nullable!, optional!)).toBe(true);
    });

    it("returns `false` for unions that differ by a member other than `undefined`", async () => {
      const [nullable, member] = await aliasedTypes(
        "type A = { a: string }; type N = A | null; type B = A | undefined;",
        "N",
        "B",
      );

      expect(sameBesidesUndefined(nullable!, member!)).toBe(false);
    });
  });

  describe("readUnionMemberNodes()", () => {
    /** The text of each member node `readUnionMemberNodes()` returns for `P`. */
    const memberTexts = async (source: string) => {
      const { sourceFile, checker } = await createTestProgram(source);
      return readUnionMemberNodes(aliasedNode(sourceFile, "P"), checker).map(
        (member) => member.getText(sourceFile),
      );
    };

    it("returns the members of a union written through an alias", async () => {
      expect(
        await memberTexts("type U = string | (number); type P = U;"),
      ).toEqual(["string", "(number)"]);
    });

    it("returns the members of each member that writes a union", async () => {
      expect(
        await memberTexts(
          "type U = string | number; type P = (U) | boolean;",
        ),
      ).toEqual(["string", "number", "boolean"]);
    });

    it("returns a node that writes no union as its only member", async () => {
      expect(await memberTexts("type P = string;")).toEqual(["string"]);
    });

    it("returns a union already read on the way to it as a single member", async () => {
      expect(
        await memberTexts(
          "type A = B | null; type B = A | undefined; type P = A;",
        ),
      ).toEqual(["A", "undefined", "null"]);
    });
  });
});

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import {
  readAuthoredTypeNode,
  readAuthoredTypeNodeOnce,
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
});

import { expect } from "@std/expect";
import ts from "typescript";

import { isFunctionDeclaration } from "../../src/ast/scope-analysis.ts";
import { describe, it } from "@commonfabric/test-support/test";

function declarationsOf(source: string) {
  const fileName = "/scope.ts";
  const options: ts.CompilerOptions = { noLib: true, strict: true };
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ESNext,
    true,
  );
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
  host.fileExists = (name) => name === fileName;
  const checker = ts.createProgram([fileName], options, host).getTypeChecker();
  const declarations = new Map<string, ts.VariableDeclaration>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declarations.set(node.name.text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const declaration = (name: string): ts.VariableDeclaration => {
    const found = declarations.get(name);
    if (!found) throw new Error(`No declaration named \`${name}\``);
    return found;
  };
  return { checker, declaration };
}

describe("scope-analysis", () => {
  describe("isFunctionDeclaration()", () => {
    it("returns `true` for a binding whose initializer is a call returning a function", () => {
      const { checker, declaration } = declarationsOf(
        `declare function makeAdder(by: number): (value: number) => number;
         const addOne = makeAdder(1);`,
      );

      expect(isFunctionDeclaration(declaration("addOne"), checker)).toBe(true);
    });

    it("returns `false` for a binding whose initializer is a call returning data", () => {
      const { checker, declaration } = declarationsOf(
        `declare function count(): number;
         const total = count();`,
      );

      expect(isFunctionDeclaration(declaration("total"), checker)).toBe(false);
    });

    it("returns `false` for a call returning a function when no checker is given", () => {
      const { declaration } = declarationsOf(
        `declare function makeAdder(by: number): (value: number) => number;
         const addOne = makeAdder(1);`,
      );

      expect(isFunctionDeclaration(declaration("addOne"))).toBe(false);
    });
  });
});

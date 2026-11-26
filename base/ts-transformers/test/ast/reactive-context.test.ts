import { expect } from "@std/expect";
import ts from "typescript";

import {
  classifyReactiveContext,
  isStandaloneFunctionDefinition,
  type ReactiveContextLookup,
} from "../../src/ast/reactive-context.ts";
import { describe, it } from "@commonfabric/test-support/test";

function createProgram(source: string): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const fileName = "/test.ts";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
    skipLibCheck: true,
  };

  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    compilerOptions.target!,
    true,
  );

  const host = ts.createCompilerHost(compilerOptions, true);
  host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
  host.getCurrentDirectory = () => "/";
  host.getDirectories = () => [];
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => name === fileName ? source : undefined;
  host.writeFile = () => {};
  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (name) => name;
  host.getNewLine = () => "\n";

  const program = ts.createProgram([fileName], compilerOptions, host);
  return { sourceFile, checker: program.getTypeChecker() };
}

/** The callback passed as the first argument of `declarationName`'s call. */
function findCallback(
  sourceFile: ts.SourceFile,
  declarationName: string,
): ts.ArrowFunction {
  let found: ts.ArrowFunction | undefined;

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === declarationName &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const callback = node.initializer.arguments[0];
      if (callback && ts.isArrowFunction(callback)) found = callback;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!found) {
    throw new Error(`Callback for ${declarationName} not found`);
  }

  return found;
}

/** A lookup that marks `callbacks` as synthetic compute callbacks. */
function syntheticComputeLookup(
  callbacks: readonly ts.Node[],
): ReactiveContextLookup {
  return {
    isArrayMethodCallback: () => false,
    isSourceFileDefaultLibrary: () => false,
    isSyntheticComputeCallback: (node) => callbacks.includes(node),
  };
}

describe("reactive-context", () => {
  describe("isStandaloneFunctionDefinition()", () => {
    it("returns `false` for a function with no parent", () => {
      // A transformer-built function has no parent until it is placed in a
      // tree, so nothing defines it as a standalone function.

      const arrow = ts.factory.createArrowFunction(
        undefined,
        undefined,
        [],
        undefined,
        undefined,
        ts.factory.createNumericLiteral(1),
      );

      expect(isStandaloneFunctionDefinition(arrow)).toBe(false);
    });

    it("returns `true` for a parenthesized variable initializer", () => {
      const { sourceFile } = createProgram(`
        const value = ((input: number) => input);
      `);
      let arrow: ts.ArrowFunction | undefined;
      const visit = (node: ts.Node): void => {
        if (ts.isArrowFunction(node)) arrow = node;
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);

      expect(arrow && isStandaloneFunctionDefinition(arrow)).toBe(true);
    });
  });

  describe("classifyReactiveContext()", () => {
    describe("inside a synthetic compute callback", () => {
      const source = `
        import { computed, lift, pattern, render } from "commonfabric";
        declare function plain(callback: () => number): number;

        const patternValue = pattern(() => 1);
        const renderValue = render(() => 1);
        const computedValue = computed(() => 1);
        const applied = lift((input: number) => input)(() => 1);
        const plainValue = plain(() => 1);
      `;

      function classifyBody(declarationName: string) {
        const { sourceFile, checker } = createProgram(source);
        const callback = findCallback(sourceFile, declarationName);
        return classifyReactiveContext(
          callback.body,
          checker,
          syntheticComputeLookup([callback]),
        );
      }

      it("returns the context of the builder that takes the callback", () => {
        expect(classifyBody("patternValue")).toEqual({
          kind: "pattern",
          owner: "pattern",
          inJsxExpression: false,
        });
        expect(classifyBody("renderValue")).toEqual({
          kind: "pattern",
          owner: "render",
          inJsxExpression: false,
        });
        expect(classifyBody("computedValue")).toEqual({
          kind: "compute",
          owner: "computed",
          inJsxExpression: false,
        });
      });

      it("returns a `lift-applied` compute context for the input of an applied `lift()` call", () => {
        expect(classifyBody("applied")).toEqual({
          kind: "compute",
          owner: "lift-applied",
          inJsxExpression: false,
        });
      });

      it("returns an unowned compute context for a callback no builder takes", () => {
        expect(classifyBody("plainValue")).toEqual({
          kind: "compute",
          owner: "unknown",
          inJsxExpression: false,
        });
      });
    });
  });
});

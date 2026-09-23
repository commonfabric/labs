import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import type { TransformationContext } from "../../src/core/mod.ts";
import { shouldTransformArrayMethod } from "../../src/closures/strategies/array-method-policy.ts";

function createProgram(source: string): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const fileName = "/test.ts";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    skipLibCheck: true,
  };
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    compilerOptions.target!,
    true,
  );
  const host = ts.createCompilerHost(compilerOptions, true);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  const baseReadFile = host.readFile.bind(host);
  const baseFileExists = host.fileExists.bind(host);

  host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
    name === fileName
      ? sourceFile
      : baseGetSourceFile(name, languageVersion, onError, shouldCreate);
  host.readFile = (name) => name === fileName ? source : baseReadFile(name);
  host.fileExists = (name) => name === fileName || baseFileExists(name);

  const program = ts.createProgram([fileName], compilerOptions, host);
  return { sourceFile, checker: program.getTypeChecker() };
}

/** Finds the `.map(...)` call over the local named `view`. */
function findViewMapCall(sourceFile: ts.SourceFile): ts.CallExpression {
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      !found &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "map" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "view"
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error("Expected a view.map(...) call in the source");
  return found;
}

/**
 * The slice of TransformationContext the pre-admission checks and the
 * site-lifted-local admission's guards consume. `reactiveKindFor` stands in
 * for the reactive-context classifier so a test can place the map call in
 * pattern context while placing the declaration's initializer wherever the
 * guard under test needs it.
 */
function testContext(
  checker: ts.TypeChecker,
  reactiveKindFor: (node: ts.Node) => "pattern" | "compute",
): TransformationContext {
  return {
    checker,
    state: {
      typeRegistry: new WeakMap<ts.Node, ts.Type>(),
      syntheticReactiveCollectionRegistry: new WeakSet<ts.Symbol>(),
    },
    getReactiveContext: (node: ts.Node) => ({ kind: reactiveKindFor(node) }),
  } as unknown as TransformationContext;
}

describe("array-method-policy", () => {
  it("declines a site-lifted admission when the initializer sits outside pattern context", () => {
    const { sourceFile, checker } = createProgram(`
      declare const rows: { get(): { keep: boolean }[] };
      const view = rows.get().filter((r) => r.keep);
      const mapped = view.map((v) => v);
    `);
    const mapCall = findViewMapCall(sourceFile);
    const context = testContext(
      checker,
      (node) => node === mapCall ? "pattern" : "compute",
    );

    expect(shouldTransformArrayMethod(mapCall, context)).toBe(false);
  });

  it("declines a site-lifted admission for a local declared inside a function declaration", () => {
    const { sourceFile, checker } = createProgram(`
      declare const rows: { get(): { keep: boolean }[] };
      function build() {
        const view = rows.get().filter((r) => r.keep);
        return view.map((v) => v);
      }
    `);
    const mapCall = findViewMapCall(sourceFile);
    const context = testContext(checker, () => "pattern");

    expect(shouldTransformArrayMethod(mapCall, context)).toBe(false);
  });

  it("declines a site-lifted admission when the enclosing callback belongs to a non-builder call", () => {
    const { sourceFile, checker } = createProgram(`
      declare const rows: { get(): { keep: boolean }[] };
      declare function helper(cb: () => unknown): unknown;
      helper(() => {
        const view = rows.get().filter((r) => r.keep);
        return view.map((v) => v);
      });
    `);
    const mapCall = findViewMapCall(sourceFile);
    const context = testContext(checker, () => "pattern");

    expect(shouldTransformArrayMethod(mapCall, context)).toBe(false);
  });

  // The inline lift-applied receiver: `computed(() => …)` lowers to
  // `__cfHelpers.lift(cb)(inputs)`, so a map chained straight onto the call —
  // no local in between — takes this branch. Its transform-or-not turns on
  // the surrounding context alone. `__cfHelpers` stays undeclared on
  // purpose: emitted code's helper identifier resolves to no symbol, which
  // is what routes recognition through the synthetic-helper path — declaring
  // it here would instead match the shadowed-local refusal.
  const INLINE_LIFT_APPLIED_MAP = `
    const mapped = __cfHelpers.lift(() => [])({}).map((v) => v);
  `;

  function findInlineLiftAppliedMapCall(
    sourceFile: ts.SourceFile,
  ): ts.CallExpression {
    let found: ts.CallExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (
        !found &&
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "map"
      ) {
        found = node;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (!found) throw new Error("Expected a .map(...) call in the source");
    return found;
  }

  it("transforms a map chained onto an inline lift-applied call in pattern context", () => {
    const { sourceFile, checker } = createProgram(INLINE_LIFT_APPLIED_MAP);
    const mapCall = findInlineLiftAppliedMapCall(sourceFile);
    const context = testContext(checker, () => "pattern");

    expect(shouldTransformArrayMethod(mapCall, context)).toBe(true);
  });

  it("leaves a map chained onto an inline lift-applied call alone in compute context", () => {
    const { sourceFile, checker } = createProgram(INLINE_LIFT_APPLIED_MAP);
    const mapCall = findInlineLiftAppliedMapCall(sourceFile);
    const context = testContext(checker, () => "compute");

    expect(shouldTransformArrayMethod(mapCall, context)).toBe(false);
  });
});

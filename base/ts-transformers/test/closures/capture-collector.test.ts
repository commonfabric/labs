import { expect } from "@std/expect";
import ts from "typescript";

import {
  CaptureCollector,
  type CaptureCollectorOptions,
} from "../../src/closures/capture-collector.ts";
import { createInMemoryProgram } from "../utils.ts";
import { describe, it } from "@commonfabric/test-support/test";

/**
 * Builds a program from `source` and returns its checker with the arrow
 * function bound to `const cb`.
 */
function setup(source: string): {
  checker: ts.TypeChecker;
  callback: ts.ArrowFunction;
} {
  const program = createInMemoryProgram({ "/test.ts": source }, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
  });
  const sourceFile = program.getSourceFile("/test.ts");
  let callback: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.name.text === "cb" && node.initializer &&
      ts.isArrowFunction(node.initializer)
    ) {
      callback = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  if (sourceFile) visit(sourceFile);
  if (!callback) throw new Error("Expected `const cb = () => ...`");
  return { checker: program.getTypeChecker(), callback };
}

/** The source text of every expression the collector captures from `cb`. */
function captures(
  source: string,
  options?: CaptureCollectorOptions,
): string[] {
  const { checker, callback } = setup(source);
  const { captures } = new CaptureCollector(checker, options).analyze(
    callback,
  );
  return [...captures].map((capture) => capture.getText()).sort();
}

describe("capture-collector", () => {
  describe("CaptureCollector", () => {
    describe("analyze()", () => {
      it("captures a property access on an outer local as a whole", () => {
        expect(captures(`
function outer(state: { value: number }) {
  const cb = () => state.value;
}`)).toEqual(["state.value"]);
      });

      it("captures nothing for a property access on `arguments`", () => {
        // `arguments` resolves to a symbol with no declarations.

        expect(captures(`
function outer(this: unknown, a: number) {
  const cb = () => arguments.length;
}`)).toEqual([]);
      });

      it("captures nothing for a property access on an imported binding", () => {
        expect(captures(`
import { config } from "./config";
function outer() {
  const cb = () => config.value;
}`)).toEqual([]);
      });

      it("captures nothing for a property access on a local function declaration", () => {
        expect(captures(`
function outer() {
  function helper() {}
  const cb = () => helper.length;
}`)).toEqual([]);
      });

      it("captures the root identifier when property-access captures are off", () => {
        expect(captures(
          `
function outer(state: { value: number }) {
  const cb = () => state.value;
}`,
          { captureNonModuleExternalPropertyAccesses: false },
        )).toEqual(["state"]);
      });

      it("captures an unresolved shorthand property name", () => {
        // `missing` names no binding, so the shorthand's value symbol does not
        // resolve and the collector reads the name as an outer reference.

        expect(captures(`
function outer() {
  const cb = () => ({ missing });
}`)).toEqual(["missing"]);
      });

      it("captures a module-scoped identifier only when the predicate accepts its type", () => {
        const source = `
const limit = 3;
const label = "x";
function outer() {
  const cb = () => [limit, label];
}`;

        expect(captures(source)).toEqual([]);
        expect(captures(source, {
          captureModuleScopedIdentifierWhen: (_identifier, type) =>
            (type.flags & ts.TypeFlags.NumberLike) !== 0,
        })).toEqual(["limit"]);
      });

      it("drops a nested callback's capture rooted at the outer callback's parameter", () => {
        expect(captures(`
function outer(state: { items: { name: string }[]; prefix: string }) {
  const cb = (item: { name: string }) =>
    state.items.map(() => item.name + state.prefix);
}`)).toEqual(["state.items", "state.prefix"]);
      });
    });
  });
});

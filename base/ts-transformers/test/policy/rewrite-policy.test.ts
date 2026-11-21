import { assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import ts from "typescript";

import {
  classifyReactiveReceiverKind,
  shouldLowerLogicalExpression,
  shouldRewriteCollectionMethod,
} from "../../src/policy/mod.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import { createInMemoryProgram } from "../utils.ts";

Deno.test("Rewrite policy: JSX logical lowering matrix", () => {
  assertEquals(
    shouldLowerLogicalExpression(
      "pattern",
      "jsx-expression",
      ts.SyntaxKind.AmpersandAmpersandToken,
    ),
    true,
  );
  assertEquals(
    shouldLowerLogicalExpression(
      "pattern",
      "call-argument",
      ts.SyntaxKind.BarBarToken,
    ),
    true,
  );
  assertEquals(
    shouldLowerLogicalExpression(
      "compute",
      "jsx-expression",
      ts.SyntaxKind.AmpersandAmpersandToken,
    ),
    false,
  );
  assertEquals(
    shouldLowerLogicalExpression(
      "compute",
      "object-property",
      ts.SyntaxKind.BarBarToken,
    ),
    false,
  );
  assertEquals(
    shouldLowerLogicalExpression(
      "neutral",
      "jsx-expression",
      ts.SyntaxKind.AmpersandAmpersandToken,
    ),
    false,
  );
});

Deno.test("Rewrite policy: collection rewrite matrix", () => {
  for (
    const method of ["map", "filter", "flatMap", "count", "minBy", "maxBy"]
  ) {
    for (const context of ["pattern", "compute", "neutral"] as const) {
      for (
        const receiver of [
          "plain",
          "opaque_autounwrapped",
          "celllike_requires_rewrite",
        ] as const
      ) {
        const expected = context === "pattern"
          ? receiver !== "plain"
          : context === "compute" && receiver === "celllike_requires_rewrite";
        assertEquals(
          shouldRewriteCollectionMethod(context, method, receiver),
          expected,
          `${context}/${method}/${receiver}`,
        );
      }
    }
  }
});

/**
 * The receiver kind of each variable `/test.ts` declares, compiled beside the
 * Common Fabric type definitions, keyed by the variable's name.
 */
function receiverKinds(source: string): Record<string, string> {
  const program = createInMemoryProgram({
    "/test.ts": source,
    "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
  }, { target: ts.ScriptTarget.ESNext, strict: true, noLib: true });
  const checker = program.getTypeChecker();
  const kinds: Record<string, string> = {};
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      kinds[node.name.text] = classifyReactiveReceiverKind(
        node.name,
        checker.getTypeAtLocation(node.name),
        checker,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(program.getSourceFile("/test.ts")!);
  return kinds;
}

describe("rewrite-policy", () => {
  describe("classifyReactiveReceiverKind()", () => {
    it("returns `opaque_autounwrapped` for a read-only cell and a rewrite for a writable one", () => {
      expect(receiverKinds(`
        import type { ReadonlyCell, Writable } from "commonfabric";
        declare const readonly: ReadonlyCell<number[]>;
        declare const writable: Writable<number[]>;
        declare const plain: number[];
      `)).toEqual({
        readonly: "opaque_autounwrapped",
        writable: "celllike_requires_rewrite",
        plain: "plain",
      });
    });
  });

  describe("shouldRewriteCollectionMethod()", () => {
    it("returns `false` for a method outside the collection methods", () => {
      expect(
        shouldRewriteCollectionMethod(
          "pattern",
          "reduce",
          "celllike_requires_rewrite",
        ),
      ).toBe(false);
      expect(
        shouldRewriteCollectionMethod(
          "pattern",
          "map",
          "celllike_requires_rewrite",
        ),
      ).toBe(true);
    });
  });
});

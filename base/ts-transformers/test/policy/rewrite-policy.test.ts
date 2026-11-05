import { assertEquals } from "@std/assert";

import ts from "typescript";

import {
  shouldLowerLogicalExpression,
  shouldRewriteCollectionMethod,
} from "../../src/policy/mod.ts";

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

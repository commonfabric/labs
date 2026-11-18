import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import ts from "typescript";

import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import { parseModule } from "../transformed-ast.ts";
import { validateSource } from "../utils.ts";

/**
 * The names each `mapWithPattern(...)` call in `output` hands its callback,
 * the properties of its captures object.
 */
function capturedNames(output: string): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "mapWithPattern"
    ) {
      const captures = node.arguments[1];
      if (captures && ts.isObjectLiteralExpression(captures)) {
        for (const property of captures.properties) {
          if (property.name && ts.isIdentifier(property.name)) {
            names.push(property.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parseModule(output));
  return names;
}

/** The names the variable declarations in `output` declare. */
function declaredNames(output: string): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      names.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parseModule(output));
  return names;
}

describe("array-method-utils", () => {
  describe("a computed key in a collection callback's element parameter", () => {
    // A computed key is read through an alias lifted from the element and the
    // key, which has no way to apply a destructuring default on or around it.

    /** The `pattern-context:computation` messages for `callback` over rows. */
    async function computationErrors(callback: string): Promise<string[]> {
      const { diagnostics } = await validateSource(
        `/// <cts-enable />
import { pattern } from "commonfabric";
const fallback: Record<string, number> = { x: 1 };
export default pattern<{
  rows: (Record<string, number> | undefined)[][];
  records: Record<string, number>[];
  k: string;
}>(({ rows, records, k }) => ({
  out: ${callback},
}));`,
        { types: COMMONFABRIC_TYPES },
      );
      return diagnostics
        .filter(({ type }) => type === "pattern-context:computation")
        .map(({ message }) => message);
    }

    it("reports a default on the array element a computed key is read from", async () => {
      expect(
        await computationErrors(
          "rows.map(([{ [k]: chosen } = fallback]) => chosen)",
        ),
      ).toEqual([expect.stringContaining("computed key")]);
    });

    it("reports a default on the binding a computed key names", async () => {
      expect(
        await computationErrors("records.map(({ [k]: chosen = 0 }) => chosen)"),
      ).toEqual([expect.stringContaining("computed key")]);
    });

    it("binds the names a pattern under a computed key destructures beside a key it lifts", async () => {
      // `[j]: y` is lifted into an alias, and `[k]: { x }` is left to the
      // destructure, which reads `x` by key as it does with no alias beside it.

      const { diagnostics, output } = await validateSource(
        `/// <cts-enable />
import { pattern } from "commonfabric";
const k = "a", j = "b";
export default pattern<{ rows: Record<string, { x: number }>[] }>(({ rows }) => ({
  out: rows.map(({ [k]: { x }, [j]: y }) => x + y.x),
}));`,
        { types: COMMONFABRIC_TYPES },
      );

      expect(diagnostics.filter(({ severity }) => severity === "error"))
        .toEqual([]);
      expect(declaredNames(output)).toContain("x");
    });

    it("reports a default on a pattern a computed key binds beside a key it lifts", async () => {
      const { diagnostics } = await validateSource(
        `/// <cts-enable />
import { pattern } from "commonfabric";
const k = "a", j = "b";
export default pattern<{ rows: Record<string, { x: number }>[] }>(({ rows }) => ({
  out: rows.map(({ [k]: { x } = { x: 2 }, [j]: y }) => x + y.x),
}));`,
        { types: COMMONFABRIC_TYPES },
      );

      expect(
        diagnostics
          .filter(({ severity }) => severity === "error")
          .map(({ message }) => message),
      ).toEqual([
        expect.stringContaining("Defaults on dynamic destructuring keys"),
      ]);
    });

    it("captures a pattern binding a computed key in the element parameter names", async () => {
      // `k` is the pattern's, so the hoisted callback is handed it, whether or
      // not a key beside it is lifted.

      for (
        const callback of [
          "rows.map(({ [k]: { x } }) => x)",
          "rows.map(({ [k]: { x }, [j]: y }) => y.x)",
        ]
      ) {
        const { diagnostics, output } = await validateSource(
          `/// <cts-enable />
import { pattern } from "commonfabric";
const j = "a";
export default pattern<{ rows: Record<"a" | "b", { x: number }>[]; k: "a" | "b" }>(
  ({ rows, k }) => ({ out: ${callback} }),
);`,
          { types: COMMONFABRIC_TYPES },
        );

        expect(diagnostics.filter(({ severity }) => severity === "error"))
          .toEqual([]);
        expect(capturedNames(output)).toContain("k");
      }
    });

    it("reports nothing for a computed key with no default", async () => {
      expect(
        await computationErrors("records.map(({ [k]: chosen }) => chosen)"),
      )
        .toEqual([]);
    });
  });
});

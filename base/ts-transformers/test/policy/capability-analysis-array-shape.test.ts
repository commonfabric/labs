import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import ts from "typescript";

import { analyzeFunctionCapabilities } from "../../src/policy/capability-analysis.ts";
import { collect, parseModule } from "../transformed-ast.ts";

describe("capability-analysis", () => {
  describe("array shape checks without a type checker", () => {
    for (
      const { receiver, fullShapePaths } of [
        { receiver: "Array", fullShapePaths: [] },
        { receiver: "other", fullShapePaths: [["rows"]] },
      ]
    ) {
      it(`records the value read by ${receiver}.isArray`, () => {
        const source = parseModule(`
          const inspect = (input) => {
            const rows = input.rows;
            ${receiver}.isArray(rows);
            rows[0].id;
          };
        `);
        const callbacks = collect(source, ts.isArrowFunction);
        expect(callbacks).toHaveLength(1);
        const summary = analyzeFunctionCapabilities(callbacks[0]);
        expect(summary.params).toHaveLength(1);
        const [input] = summary.params;
        expect(input.name).toBe("input");
        expect(input.fullShapePaths ?? []).toEqual(fullShapePaths);
        expect(input.readPaths).toContainEqual(["rows", "0", "id"]);
      });
    }
  });
});

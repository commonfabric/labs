import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import {
  calleeName,
  callsNamed,
  collect,
  emittedSchemas,
  parseModule,
} from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

describe("aggregate methods", () => {
  for (const inComputed of [false, true]) {
    it(`lowers captured callbacks in ${inComputed ? "computed" : "pattern"} context`, async () => {
      const wrap = (expression: string) =>
        inComputed ? `computed(() => ${expression})` : expression;
      const output = await transformSource(
        `
        import {pattern, computed, Cell} from "commonfabric";
        export default pattern<{items: Cell<{n: number}[]>; threshold: number}>(({items, threshold}) => ({
          count: ${wrap("items.count(item => item.n > threshold)")},
          minimum: ${wrap("items.minBy(item => item.n)")},
          maximum: ${wrap("items.maxBy(item => item.n)")},
        }));
      `,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      const module = parseModule(output);
      for (const method of ["count", "minBy", "maxBy"]) {
        expect(callsNamed(module, method)).toHaveLength(0);
        const lowered = callsNamed(module, `${method}WithPattern`);
        expect(lowered).toHaveLength(1);
        expect(lowered[0].arguments).toHaveLength(1);
      }
      expect(emittedSchemas(module)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            count: { type: "number" },
            minimum: expect.objectContaining({
              anyOf: expect.arrayContaining([{ type: "undefined" }]),
            }),
            maximum: expect.objectContaining({
              anyOf: expect.arrayContaining([{ type: "undefined" }]),
            }),
          }),
        }),
      ]));
    });
  }

  it("keeps authored WithPattern callbacks with their enclosing captures", async () => {
    for (const method of ["map", "count", "minBy", "maxBy"]) {
      const output = await transformSource(
        `
        import { pattern } from "commonfabric";
        declare const receiver: any;
        export default pattern<{n: number}>(({n}) => ({
          output: receiver.${method}WithPattern(pattern(() => n), {})
        }));
      `,
        { types: COMMONFABRIC_TYPES },
      );
      const calls = callsNamed(parseModule(output), `${method}WithPattern`);
      expect(calls).toHaveLength(1);
      const argument = calls[0].arguments[0];
      if (!ts.isCallExpression(argument)) {
        throw new Error("Expected an inline pattern call");
      }
      expect(calleeName(argument)).toBe("pattern");
      const callback = argument.arguments[0];
      if (!ts.isArrowFunction(callback) || !ts.isIdentifier(callback.body)) {
        throw new Error(
          "Expected the pattern callback to reference its capture",
        );
      }
      expect(callback.body.text).toBe("n");
      let enclosing: ts.Node | undefined = calls[0].parent;
      while (enclosing && !ts.isArrowFunction(enclosing)) {
        enclosing = enclosing.parent;
      }
      if (!enclosing || !ts.isArrowFunction(enclosing)) {
        throw new Error("Expected an enclosing callback");
      }
      const bindings = collect(
        enclosing.parameters[0].name,
        ts.isBindingElement,
      );
      expect(
        bindings.some((binding) =>
          ts.isIdentifier(binding.name) && binding.name.text === "n"
        ),
      ).toBe(true);
    }
  });

  it("retains direct calls for argument-free aggregates", async () => {
    const output = await transformSource(
      `
      import {pattern, Cell} from "commonfabric";
      export default pattern<{numbers: Cell<number[]>}>(({numbers}) => ({
        count: numbers.count(), sum: numbers.sum(), min: numbers.min(), max: numbers.max()
      }));
    `,
      { types: COMMONFABRIC_TYPES, typeCheck: true },
    );
    const module = parseModule(output);
    for (const method of ["count", "sum", "min", "max"]) {
      const calls = callsNamed(module, method);
      expect(calls).toHaveLength(1);
      expect(calls[0].arguments).toHaveLength(0);
    }
  });
});

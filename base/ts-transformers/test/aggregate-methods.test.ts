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
      const module = parseModule(output);
      const calls = callsNamed(module, `${method}WithPattern`);
      expect(calls).toHaveLength(1);
      const argument = calls[0].arguments[0];
      if (!ts.isCallExpression(argument)) {
        throw new Error("Expected a curried pattern factory");
      }
      expect(calleeName(argument)).toBe("curry");
      expect(argument.arguments).toHaveLength(1);
      expect(
        collect(argument.arguments[0], ts.isPropertyAssignment).some(
          (property) =>
            ts.isIdentifier(property.name) && property.name.text === "n",
        ),
      ).toBe(true);
      const wrapper = callsNamed(module, "withPatternParamsSchema");
      expect(wrapper).toHaveLength(1);
      const callback = wrapper[0].arguments[0];
      if (!ts.isArrowFunction(callback)) {
        throw new Error("Expected a pattern callback with private params");
      }
      const callbackBindings = collect(
        callback.parameters[1].name,
        ts.isBindingElement,
      );
      expect(
        callbackBindings.some((binding) =>
          ts.isIdentifier(binding.name) && binding.name.text === "n"
        ),
      ).toBe(true);
      let enclosing: ts.Node | undefined = calls[0].parent;
      while (enclosing && !ts.isArrowFunction(enclosing)) {
        enclosing = enclosing.parent;
      }
      if (!enclosing || !ts.isArrowFunction(enclosing)) {
        throw new Error("Expected an enclosing callback");
      }
      const bindings = collect(enclosing, ts.isVariableDeclaration);
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

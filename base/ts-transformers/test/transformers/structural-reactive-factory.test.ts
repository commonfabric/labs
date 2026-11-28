import { expect } from "@std/expect";
import ts from "typescript";

import {
  isPatternFactoryCalleeExpression,
  isStructuralReactiveFactoryExpression,
  returnsReactiveResult,
} from "../../src/transformers/structural-reactive-factory.ts";
import {
  analyzeExpression,
  CELL_VARIANTS_PRELUDE,
} from "../reactive/harness.ts";
import { describe, it } from "@commonfabric/test-support/test";

const PRELUDE = `${CELL_VARIANTS_PRELUDE}
declare function makeCell(): Cell<number>;
declare function makeNumber(): number;
interface PatternFactory {
  (input: unknown): unknown;
  argumentSchema: unknown;
  resultSchema: unknown;
}
interface BoundPatternFactory extends PatternFactory {
  with(extra: unknown): PatternFactory;
}
declare const factory: PatternFactory;
declare const boundFactory: BoundPatternFactory;
`;

function analyzeCall(source: string) {
  const { checker, expression } = analyzeExpression(source, {
    prelude: PRELUDE,
  });
  if (!ts.isCallExpression(expression)) {
    throw new Error(`expected a call expression: ${source}`);
  }
  return { checker, call: expression };
}

describe("structural-reactive-factory", () => {
  describe("returnsReactiveResult()", () => {
    it("returns true for a call whose result type is a cell", () => {
      const { checker, call } = analyzeCall("makeCell()");
      expect(returnsReactiveResult(call, checker)).toBe(true);
    });

    it("returns false for a call whose result type is a plain value", () => {
      const { checker, call } = analyzeCall("makeNumber()");
      expect(returnsReactiveResult(call, checker)).toBe(false);
    });
  });

  describe("isStructuralReactiveFactoryExpression()", () => {
    it("returns true for a call whose result type is a cell", () => {
      // `makeCell` is no builder or runtime export, so only the call's cell
      // result type marks it as a reactive factory.
      const { checker, call } = analyzeCall("makeCell()");
      expect(isStructuralReactiveFactoryExpression(call, checker)).toBe(true);
    });

    it("returns false for a call whose result type is a plain value", () => {
      const { checker, call } = analyzeCall("makeNumber()");
      expect(isStructuralReactiveFactoryExpression(call, checker)).toBe(
        false,
      );
    });
  });

  describe("isPatternFactoryCalleeExpression()", () => {
    it("returns true for a callable with argument and result schemas", () => {
      const { checker, call } = analyzeCall("factory({})");
      expect(isPatternFactoryCalleeExpression(call.expression, checker)).toBe(
        true,
      );
    });

    it("returns false for a callable that also has a `with` member", () => {
      const { checker, call } = analyzeCall("boundFactory({})");
      expect(isPatternFactoryCalleeExpression(call.expression, checker)).toBe(
        false,
      );
    });

    it("returns false for a callable without schemas", () => {
      const { checker, call } = analyzeCall("makeNumber()");
      expect(isPatternFactoryCalleeExpression(call.expression, checker)).toBe(
        false,
      );
    });
  });
});

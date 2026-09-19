import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricMap } from "@/fabric-instances/index.ts";
import { DO_RECURSE_VALUES, RecursiveValueVisitor } from "@/value-visit";

describe("RecursiveValueVisitor", () => {
  class Recursive extends RecursiveValueVisitor<never, never> {}

  describe("instance members", () => {
    describe("visitFabricContainer()", () => {
      it("returns `DO_RECURSE_VALUES`, without subtype dispatch", () => {
        expect(new Recursive().visitFabricContainer([])).toBe(
          DO_RECURSE_VALUES,
        );
      });
    });

    describe("visitFabricArray()", () => {
      it("returns `DO_RECURSE_VALUES`", () => {
        expect(new Recursive().visitFabricArray([1])).toBe(DO_RECURSE_VALUES);
      });
    });

    describe("visitFabricPlainObject()", () => {
      it("returns `DO_RECURSE_VALUES`", () => {
        expect(new Recursive().visitFabricPlainObject({ a: 1 })).toBe(
          DO_RECURSE_VALUES,
        );
      });
    });

    describe("visitFabricInstance()", () => {
      it("returns `DO_RECURSE_VALUES`", () => {
        const instance = new FabricMap(new Map());

        expect(new Recursive().visitFabricInstance(instance)).toBe(
          DO_RECURSE_VALUES,
        );
      });
    });

    describe("the `visited*()` methods", () => {
      it("return `undefined`", () => {
        const vis = new Recursive();

        expect(vis.visitedFabricArrayElement([1], 0, 1)).toBeUndefined();
        expect(vis.visitedFabricArrayGap([], 0, 1)).toBeUndefined();
        expect(vis.visitedFabricInstance(new FabricMap(new Map()), {}))
          .toBeUndefined();
        expect(vis.visitedFabricPlainObjectEntry({}, "k", 1)).toBeUndefined();
      });
    });
  });
});

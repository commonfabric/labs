import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricMap } from "@/fabric-instances/index.ts";
import {
  BaseValueVisitor,
  DO_VISIT_SUBTYPE,
  type LeafVisitorResult,
  type ValueVisitor,
} from "@/value-visit";
import { VisitInProgress } from "@/value-visit/VisitInProgress.ts";

import { mainResult, Recorder } from "./Recorder.ts";

describe("BaseValueVisitor", () => {
  class Base extends BaseValueVisitor<unknown, unknown> {}

  describe("instance members", () => {
    describe("isPlusType()", () => {
      it("returns `false`", () => {
        expect(new Base().isPlusType(new Date(0))).toBe(false);
      });
    });

    describe("visitCycle()", () => {
      it("throws an error naming the value", () => {
        expect(() => new Base().visitCycle([1], 0, 1)).toThrow(
          /Cannot visit cyclic value: `\[1\]`/,
        );
      });
    });

    describe("visitFabricContainer()", () => {
      it("returns `DO_VISIT_SUBTYPE`", () => {
        expect(new Base().visitFabricContainer([])).toBe(DO_VISIT_SUBTYPE);
      });
    });

    describe("visitValue()", () => {
      it("returns `DO_VISIT_SUBTYPE`", () => {
        expect(new Base().visitValue(1)).toBe(DO_VISIT_SUBTYPE);
      });
    });

    describe("the methods left for a subclass", () => {
      // The table is held to the interface: a method added there fails to
      // compile until it is either listed here or named among the exceptions,
      // so the claim that every other method throws stays closed.

      const instance = new FabricMap(new Map());
      const cases = {
        visitFabricArray: (vis) => vis.visitFabricArray([]),
        visitFabricInstance: (vis) => vis.visitFabricInstance(instance),
        visitFabricPlainObject: (vis) => vis.visitFabricPlainObject({}),
        visitPlusType: (vis) => vis.visitPlusType(new Date(0)),
        visitPrimitive: (vis) => vis.visitPrimitive(1, "number"),
        visitedFabricArrayElement: (vis) =>
          vis.visitedFabricArrayElement([1], 0, 1),
        visitedFabricArrayGap: (vis) => vis.visitedFabricArrayGap([], 0, 1),
        visitedFabricInstance: (vis) => vis.visitedFabricInstance(instance, {}),
        visitedFabricPlainObjectEntry: (vis) =>
          vis.visitedFabricPlainObjectEntry({}, "k", 1),
      } satisfies Record<
        Exclude<
          keyof ValueVisitor<unknown, unknown>,
          "isPlusType" | "visitCycle" | "visitFabricContainer" | "visitValue"
        >,
        (vis: Base) => unknown
      >;

      for (const [name, call] of Object.entries(cases)) {
        it(`throws from \`${name}()\`, naming that method`, () => {
          expect(() => call(new Base())).toThrow(
            new RegExp(`^Shouldn't happen: \`${name}\\(\\)\` called on `),
          );
        });
      }
    });

    describe("throwNoCycles()", () => {
      it("throws an error naming the value", () => {
        class NoCycles extends Recorder {
          override visitCycle(value: unknown): never {
            return this.throwNoCycles(value);
          }
        }

        const value: Record<string, unknown> = {};
        value.self = value;

        expect(() => new VisitInProgress(new NoCycles()).visit(value))
          .toThrow(/Cannot visit cyclic value: /);
      });
    });

    describe("throwShouldntCall()", () => {
      it("throws an error naming the method and the visitor", () => {
        class Refusing extends Recorder {
          override visitPrimitive(): never {
            return this.throwShouldntCall("visitPrimitive");
          }
        }

        expect(() => new VisitInProgress(new Refusing()).visit(1))
          .toThrow(
            /Shouldn't happen: `visitPrimitive\(\)` called on `.*Refusing/,
          );
      });
    });
  });

  describe("as a visitor", () => {
    class Leaf extends BaseValueVisitor<never, string> {
      override visitPrimitive(
        value: unknown,
      ): LeafVisitorResult<never, string> {
        return mainResult(String(value));
      }
    }

    it("dispatches a value to its subtype method by default", () => {
      expect(new VisitInProgress(new Leaf()).visit(5)).toEqual(mainResult("5"));
    });

    it("throws on reaching a subtype method the subclass did not override", () => {
      expect(() => new VisitInProgress(new Leaf()).visit([5])).toThrow(
        /Shouldn't happen: `visitFabricArray\(\)` called on /,
      );
    });
  });
});

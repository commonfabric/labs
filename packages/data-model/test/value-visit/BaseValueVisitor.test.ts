import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { BaseValueVisitor, type VisitResult } from "@/value-visit";
import { VisitInProgress } from "@/value-visit/VisitInProgress.ts";

import { Recorder } from "./Recorder.ts";

describe("BaseValueVisitor", () => {
  /** The least a concrete subclass has to supply. */
  class Base extends BaseValueVisitor<unknown, unknown> {
    override visitValue(
      _value: unknown,
    ): VisitResult<unknown, unknown> {
      return undefined;
    }

    override visitedFabricArrayElement(): undefined {
      return undefined;
    }

    override visitedFabricArrayGap(): undefined {
      return undefined;
    }

    override visitedFabricInstance(): undefined {
      return undefined;
    }

    override visitedFabricPlainObjectEntry(): undefined {
      return undefined;
    }
  }

  describe("instance members", () => {
    describe("isDomainAssignableToResultType()", () => {
      it("returns `true`", () => {
        expect(new Base().isDomainAssignableToResultType()).toBe(true);
      });
    });

    describe("isPlusType()", () => {
      it("returns `false`", () => {
        expect(new Base().isPlusType(new Date(0))).toBe(false);
      });
    });

    describe("isResultType()", () => {
      it("returns `true`", () => {
        expect(new Base().isResultType(undefined)).toBe(true);
      });
    });

    describe("visitCycle()", () => {
      it("throws an error naming the value", () => {
        expect(() => new Base().visitCycle([1], "Array", 0, 1)).toThrow(
          /Cannot visit cyclic value: `\[1\]`/,
        );
      });

      it("is what the engine reaches for a cyclic value", () => {
        class Recursing extends Base {
          override visitValue(
            value: unknown,
          ): VisitResult<unknown, unknown> {
            return Array.isArray(value)
              ? { type: "recurse", doKeys: false, doValues: true }
              : undefined;
          }
        }

        const value: unknown[] = [];
        value.push(value);

        expect(() => new VisitInProgress(new Recursing()).visit(value))
          .toThrow(/Cannot visit cyclic value: /);
      });
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
          override visitNumber(): never {
            return this.throwShouldntCall("visitNumber");
          }
        }

        expect(() => new VisitInProgress(new Refusing()).visit(1))
          .toThrow(
            /Shouldn't happen: `visitNumber\(\)` called on `.*Refusing/,
          );
      });
    });
  });
});

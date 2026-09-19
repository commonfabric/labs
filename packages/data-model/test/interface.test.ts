import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type {
  FabricConvertibleJsObject,
  FabricConvertibleJsValue,
  FabricValue,
  FabricValueLayer,
} from "@/index.ts";

// The assertions in this file are made when it is type-checked, which the
// package's `test` task does before it runs anything, not when it runs. Each
// carrier below is a function that is never called: an assignment in it that
// must type-check pins a direction the types admit, and a `@ts-expect-error`
// marks one they must refuse -- if the refusal regresses, the directive
// becomes unused and the type check fails on it.

/**
 * The recursive shape `FabricConvertibleJsValue` names, written out: the values
 * that convert to and from fabric form are `FabricValue`s, JS objects, and
 * read-only trees of either.
 */
type WrittenOutConvertible =
  | FabricValue
  | FabricConvertibleJsObject
  | readonly WrittenOutConvertible[]
  | { readonly [key: string]: WrittenOutConvertible };

declare const convertible: FabricConvertibleJsValue;
declare const writtenOut: WrittenOutConvertible;
declare const value: FabricValue;
declare const mutableArray: unknown[];
declare const mutableRecord: Record<string, unknown>;
declare const layerArray: Extract<FabricValueLayer, readonly unknown[]>;
declare const layerRecord: Exclude<
  Extract<FabricValueLayer, object>,
  readonly unknown[] | FabricValue
>;

/** Carrier for the `FabricConvertibleJsValue` checks. */
function fabricConvertibleValueTypeChecks() {
  // The alias admits the written-out recursion. The reverse is refused by the
  // one arm the written-out recursion lacks: a `FabricInstancePlus` at
  // `FabricConvertibleJsObject`, an instance whose contents may hold a
  // convertible JS object.
  const fromWrittenOut: FabricConvertibleJsValue = writtenOut;
  // @ts-expect-error a `FabricInstancePlus<FabricConvertibleJsObject>` is admitted only by the alias
  const toWrittenOut: WrittenOutConvertible = convertible;

  return { fromWrittenOut, toWrittenOut };
}

/** Carrier for the `FabricValueLayer` checks. */
function fabricValueLayerTypeChecks() {
  // A `FabricValue`, a mutable array root, and a mutable record root are each
  // admitted.
  const fromValue: FabricValueLayer = value;
  const fromArray: FabricValueLayer = mutableArray;
  const fromRecord: FabricValueLayer = mutableRecord;

  // Neither root admits a write through the type.
  // @ts-expect-error the array root is read-only
  layerArray.push(1);
  // @ts-expect-error the record root is read-only
  layerRecord["key"] = 1;

  return { fromValue, fromArray, fromRecord };
}

describe("interface", () => {
  // Each `it()` names the claim its carrier holds; the type checker is what
  // decides it, and at run time only the carrier is observable.

  describe("FabricConvertibleJsValue", () => {
    it("admits the written-out recursion over `FabricValue` and `FabricConvertibleJsObject`, and is wider by the plus-instance arm", () => {
      expect(typeof fabricConvertibleValueTypeChecks).toBe("function");
    });
  });

  describe("FabricValueLayer", () => {
    it("admits a `FabricValue` and a mutable array or record root, and refuses a write through either root", () => {
      expect(typeof fabricValueLayerTypeChecks).toBe("function");
    });
  });
});

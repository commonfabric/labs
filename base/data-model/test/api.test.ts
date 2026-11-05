import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type {
  FabricArray,
  FabricArrayPlus,
  FabricInstancePlus,
  FabricPlainObject,
  FabricPlainObjectPlus,
  FabricSpecialObject,
  FabricValue,
  FabricValuePlus,
} from "@";
import type { FabricInstance, FabricPrimitive } from "@/api.ts";

// The assertions in this file are made when it is type-checked, which the
// package's `test` task does before it runs anything, not when it runs. Each
// carrier below is a function that is never called: an assignment in it that
// must type-check pins a direction the types admit, and a `@ts-expect-error`
// marks one they must refuse -- if the refusal regresses, the directive
// becomes unused and the type check fails on it.

declare const value: FabricValue;
declare const valuePlusNever: FabricValuePlus<never>;
declare const valuePlusError: FabricValuePlus<Error>;
declare const specialObject: FabricSpecialObject;
declare const shaped: {
  deepClone(frozen: boolean): FabricInstance;
  shallowClone(frozen: boolean): FabricInstance;
};
declare const primitive: FabricPrimitive;
declare const instance: FabricInstance;
declare const instancePlusNever: FabricInstancePlus<never>;
declare const instancePlusError: FabricInstancePlus<Error>;
declare const array: FabricArray;
declare const arrayPlusNever: FabricArrayPlus<never>;
declare const arrayPlusError: FabricArrayPlus<Error>;
declare const plainObject: FabricPlainObject;
declare const plainObjectPlusNever: FabricPlainObjectPlus<never>;
declare const plainObjectPlusError: FabricPlainObjectPlus<Error>;

/** Carrier for the `FabricValuePlus` checks. */
function fabricValuePlusTypeChecks() {
  // `FabricValuePlus<never>` is `FabricValue`, in both directions.
  const widened: FabricValuePlus<never> = value;
  const narrowed: FabricValue = valuePlusNever;

  // A `FabricValue` is a `FabricValuePlus` at any `PlusType`.
  const plusError: FabricValuePlus<Error> = value;

  // The reverse holds only at `never`: a `PlusType` value is admitted at the
  // top and inside each container, and none of those is a `FabricValue`.
  // @ts-expect-error a `FabricValuePlus<Error>` may be an `Error`
  const notValue: FabricValue = valuePlusError;

  return { widened, narrowed, plusError, notValue };
}

/** Carrier for the `FabricSpecialObject` family checks. */
function fabricSpecialObjectTypeChecks() {
  // `FabricSpecialObject` is the union of the two classes: each is one, the
  // union is a `FabricValue`, and the union is neither class alone.
  const primitiveAsSpecial: FabricSpecialObject = primitive;
  const instanceAsSpecial: FabricSpecialObject = instance;
  const specialAsValue: FabricValue = specialObject;
  // @ts-expect-error the union is not a `FabricPrimitive`
  const specialAsPrimitive: FabricPrimitive = specialObject;
  // @ts-expect-error the union is not a `FabricInstance`
  const specialAsInstance: FabricInstance = specialObject;

  // The two classes are told apart, each by its own brand. Without one, a
  // `FabricPrimitive` is structurally empty and a `FabricInstance` is its two
  // clone methods, and every object, or every object with those methods,
  // would be one.
  // @ts-expect-error a `FabricInstance` is not a `FabricPrimitive`
  const instanceAsPrimitive: FabricPrimitive = instance;
  // @ts-expect-error a `FabricPrimitive` is not a `FabricInstance`
  const primitiveAsInstance: FabricInstance = primitive;
  // @ts-expect-error an object with the clone methods is not a `FabricInstance`
  const shapedAsInstance: FabricInstance = shaped;
  // @ts-expect-error nor is it a `FabricValue`
  const shapedAsValue: FabricValue = shaped;

  return {
    primitiveAsSpecial,
    instanceAsSpecial,
    specialAsValue,
    specialAsPrimitive,
    specialAsInstance,
    instanceAsPrimitive,
    primitiveAsInstance,
    shapedAsInstance,
    shapedAsValue,
  };
}

/** Carrier for the `FabricInstancePlus` checks. */
function fabricInstancePlusTypeChecks() {
  // `FabricInstancePlus<never>` is `FabricInstance`, in both directions.
  const widened: FabricInstancePlus<never> = instance;
  const narrowed: FabricInstance = instancePlusNever;

  // A `FabricInstance` is a `FabricInstancePlus` at any `PlusType`, and the
  // parameter is covariant.
  const plusError: FabricInstancePlus<Error> = instance;
  const plusWider: FabricInstancePlus<Error | Date> = instancePlusError;

  // The reverse of each holds only at `never`. The brand is what refuses
  // these: nothing else on the type mentions `PlusType`.
  // @ts-expect-error a `FabricInstancePlus<Error>` is not a `FabricInstance`
  const notInstance: FabricInstance = instancePlusError;
  // @ts-expect-error a `FabricInstancePlus<Error>` is not one at `Date`
  const notDate: FabricInstancePlus<Date> = instancePlusError;

  // Nor does it reach `FabricValue` by another arm: the primitive brand is
  // what closes the `FabricPrimitive` arm, and an interface has no implicit
  // index signature to reach `FabricPlainObject` with.
  // @ts-expect-error a `FabricInstancePlus<Error>` is not a `FabricPrimitive`
  const notPrimitive: FabricPrimitive = instancePlusError;
  // @ts-expect-error a `FabricInstancePlus<Error>` is not a `FabricValue`
  const notValue: FabricValue = instancePlusError;

  return {
    widened,
    narrowed,
    plusError,
    plusWider,
    notInstance,
    notDate,
    notPrimitive,
    notValue,
  };
}

/** Carrier for the `FabricArrayPlus` checks. */
function fabricArrayPlusTypeChecks() {
  // The same four properties as the instance, held by the element type.
  const widened: FabricArrayPlus<never> = array;
  const narrowed: FabricArray = arrayPlusNever;
  const plusError: FabricArrayPlus<Error> = array;
  const plusWider: FabricArrayPlus<Error | Date> = arrayPlusError;
  // @ts-expect-error a `FabricArrayPlus<Error>` may hold an `Error`
  const notArray: FabricArray = arrayPlusError;

  return { widened, narrowed, plusError, plusWider, notArray };
}

/** Carrier for the `FabricPlainObjectPlus` checks. */
function fabricPlainObjectPlusTypeChecks() {
  // The same four properties as the instance, held by the value type.
  const widened: FabricPlainObjectPlus<never> = plainObject;
  const narrowed: FabricPlainObject = plainObjectPlusNever;
  const plusError: FabricPlainObjectPlus<Error> = plainObject;
  const plusWider: FabricPlainObjectPlus<Error | Date> = plainObjectPlusError;
  // @ts-expect-error a `FabricPlainObjectPlus<Error>` may hold an `Error`
  const notPlainObject: FabricPlainObject = plainObjectPlusError;

  return { widened, narrowed, plusError, plusWider, notPlainObject };
}

describe("api", () => {
  // Each `it()` names the claim its carrier holds; the type checker is what
  // decides it, and at run time only the carrier is observable.

  describe("FabricSpecialObject", () => {
    it("is the union of the two classes, each told from the other and from a look-alike by its brand", () => {
      expect(typeof fabricSpecialObjectTypeChecks).toBe("function");
    });
  });

  describe("FabricValuePlus", () => {
    it("is `FabricValue` at `never`, and wider than it at any other `PlusType`", () => {
      expect(typeof fabricValuePlusTypeChecks).toBe("function");
    });
  });

  describe("FabricInstancePlus", () => {
    it("is `FabricInstance` at `never`, covariant, and neither a `FabricInstance` nor a `FabricValue` otherwise", () => {
      expect(typeof fabricInstancePlusTypeChecks).toBe("function");
    });
  });

  describe("FabricArrayPlus", () => {
    it("is `FabricArray` at `never`, covariant, and not a `FabricArray` otherwise", () => {
      expect(typeof fabricArrayPlusTypeChecks).toBe("function");
    });
  });

  describe("FabricPlainObjectPlus", () => {
    it("is `FabricPlainObject` at `never`, covariant, and not a `FabricPlainObject` otherwise", () => {
      expect(typeof fabricPlainObjectPlusTypeChecks).toBe("function");
    });
  });
});

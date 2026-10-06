import {
  UNAVAILABLE_PENDING,
  UNAVAILABLE_SYNCING,
  unavailableError,
  unavailableMismatch,
} from "@commonfabric/data-model/availability";
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  dataUnavailableFromTransformFailure,
  preferDataUnavailable,
  selectDataUnavailable,
} from "../src/data-unavailability.ts";

describe("data-unavailability selection helpers", () => {
  it("ranks all terminal error kinds above pending and syncing", () => {
    const mismatch = unavailableMismatch("Required field is absent");
    expect(mismatch.errorMessage).toBe("Required field is absent");
    expect(selectDataUnavailable([UNAVAILABLE_PENDING, mismatch])).toBe(
      mismatch,
    );
    expect(selectDataUnavailable([UNAVAILABLE_SYNCING, mismatch])).toBe(
      mismatch,
    );
    expect(selectDataUnavailable([mismatch, unavailableError("later")])).toBe(
      mismatch,
    );
  });

  it("ignores available candidates and preserves the current marker", () => {
    const current = UNAVAILABLE_PENDING;

    expect(preferDataUnavailable(undefined, "available")).toBeUndefined();
    expect(preferDataUnavailable(current, { pending: true })).toBe(current);
  });

  it("converts link traversal failures into concrete control values", () => {
    const syncing = dataUnavailableFromTransformFailure({
      unavailableReason: "syncing",
    });
    expect(syncing?.reason).toBe("syncing");

    const original = new Error("replica failed");
    const failed = dataUnavailableFromTransformFailure({
      unavailableReason: "error",
      unavailableError: original,
    });
    expect(failed?.reason).toBe("error");
    expect(failed?.errorMessage).toBe("replica failed");

    const failedWithoutCause = dataUnavailableFromTransformFailure({
      unavailableReason: "error",
    });
    expect(failedWithoutCause?.reason).toBe("error");
    expect(failedWithoutCause?.errorMessage).toBe(
      "Linked document synchronization failed",
    );

    expect(dataUnavailableFromTransformFailure({})).toBeUndefined();
  });

  it("walks materialized containers without mistaking lookalikes for markers", () => {
    const firstError = unavailableError(new Error("first"));
    const laterError = unavailableError(new Error("later"));
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray, UNAVAILABLE_SYNCING);
    const cyclicObject: Record<string, unknown> = {};
    cyclicObject.self = cyclicObject;
    cyclicObject.value = UNAVAILABLE_PENDING;

    const selected = selectDataUnavailable({
      lookalike: { reason: "error", error: new Error("ordinary data") },
      cyclicArray,
      cyclicObject,
      firstError,
      laterError,
    });

    expect(selected).toBe(firstError);
    expect(selectDataUnavailable(new Date())).toBeUndefined();
    expect(selectDataUnavailable("available")).toBeUndefined();
  });
});

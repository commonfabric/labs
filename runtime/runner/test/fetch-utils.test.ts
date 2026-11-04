import {
  UNAVAILABLE_PENDING,
  UNAVAILABLE_SYNCING,
  unavailableError,
  unavailableMismatch,
} from "@commonfabric/data-model/availability";
/**
 * What `computeInputHashFromValue()` deliberately ignores, which is most of
 * its contract: two inputs that differ only in ways carrying no request
 * content must hash the same.
 *
 * Three kinds of difference are erased -- the top-level `result` field, which
 * is a type hint rather than part of the request; a property that is present
 * but `undefined` against one simply omitted, at the top level and nested;
 * and an absent input against an empty object. The remaining case is the
 * counterweight, since erasing differences is only safe if a difference in
 * real content still changes the hash.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  computeInputHashFromValue,
  legacyFetchResultMarker,
  selectUnavailableFetchInput,
} from "../src/builtins/fetch-utils.ts";

describe("computeInputHashFromValue", () => {
  it("drops the top-level `result` type-hint field", () => {
    const a = computeInputHashFromValue({ url: "x", mode: "json" });
    const b = computeInputHashFromValue({
      url: "x",
      mode: "json",
      result: "ignored type hint",
    });
    expect(a).toBe(b);
  });

  it("treats omitted vs `undefined` top-level properties identically", () => {
    const a = computeInputHashFromValue({ url: "x", mode: "json" });
    const b = computeInputHashFromValue({
      url: "x",
      mode: "json",
      options: undefined,
    });
    expect(a).toBe(b);
  });

  it("treats omitted vs `undefined` nested properties identically", () => {
    const a = computeInputHashFromValue({
      url: "x",
      options: { method: "GET" },
    });
    const b = computeInputHashFromValue({
      url: "x",
      options: { method: "GET", body: undefined },
    });
    expect(a).toBe(b);
  });

  it("distinguishes inputs that differ in non-`undefined` content", () => {
    const a = computeInputHashFromValue({ url: "x", mode: "json" });
    const b = computeInputHashFromValue({ url: "y", mode: "json" });
    expect(a).not.toBe(b);
  });

  it("treats `undefined` inputs as the empty object", () => {
    const a = computeInputHashFromValue(undefined);
    const b = computeInputHashFromValue({});
    expect(a).toBe(b);
  });
});

describe("selectUnavailableFetchInput", () => {
  it("uses reason precedence then serialized argument order", () => {
    const firstError = unavailableError(new Error("first"));
    const secondError = unavailableError(new Error("second"));
    const pending = UNAVAILABLE_PENDING;
    const syncing = UNAVAILABLE_SYNCING;
    const schemaMismatch = unavailableMismatch();

    expect(selectUnavailableFetchInput({
      pending,
      secondError,
      firstError,
      syncing,
      schemaMismatch,
    })).toBe(secondError);
    expect(selectUnavailableFetchInput({
      schemaMismatch,
      syncing,
      pending,
    })).toBe(schemaMismatch);
    expect(selectUnavailableFetchInput({
      schemaMismatch,
      syncing,
    })).toBe(schemaMismatch);
    expect(selectUnavailableFetchInput({ schemaMismatch })).toBe(
      schemaMismatch,
    );
  });

  it("ignores structural lookalikes", () => {
    expect(selectUnavailableFetchInput({
      url: { reason: "pending", pending: true },
    })).toBeUndefined();
  });

  it("ignores only the top-level result type hint", () => {
    const marker = UNAVAILABLE_PENDING;
    expect(selectUnavailableFetchInput({
      url: "/data",
      result: marker,
    })).toBeUndefined();
    expect(selectUnavailableFetchInput({
      url: "/data",
      options: { result: marker },
    })).toBe(marker);
  });
});

describe("legacyFetchResultMarker", () => {
  it("repairs persisted pre-cutover terminal and pending states", () => {
    const error = legacyFetchResultMarker(
      undefined,
      true,
      { message: "legacy failure" },
    );
    expect(error?.reason).toBe("error");
    expect(error?.errorMessage).toBe("legacy failure");

    expect(legacyFetchResultMarker(undefined, true, undefined)).toBe(
      UNAVAILABLE_PENDING,
    );
    expect(legacyFetchResultMarker(undefined, false, undefined))
      .toBeUndefined();
  });

  it("preserves native errors when repairing persisted terminal state", () => {
    const native = new TypeError("legacy native failure");
    const repaired = legacyFetchResultMarker(undefined, false, native);

    expect(repaired?.reason).toBe("error");
    expect(repaired?.errorKind).toBe("general");
    expect(repaired?.errorMessage).toBe("legacy native failure");
  });

  it("never replaces a current usable value or marker", () => {
    expect(legacyFetchResultMarker("usable", true, new Error("old")))
      .toBeUndefined();
    expect(
      legacyFetchResultMarker(
        unavailableMismatch(),
        true,
        new Error("old"),
      ),
    ).toBeUndefined();
  });
});

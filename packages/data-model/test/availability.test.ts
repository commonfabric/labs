import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricUnavailable as DuplicateUnavailable } from "../src/fabric-primitives/FabricUnavailable.ts?availability-test";
import {
  FabricUnavailable,
  hasError,
  hasSchemaMismatch,
  isPending,
  isSyncing,
  isUnavailable,
  UNAVAILABLE_PENDING,
  UNAVAILABLE_SYNCING,
  unavailableError,
  unavailableMismatch,
} from "../src/availability.ts";

describe("availability", () => {
  it("recognizes canonical prefabs and narrowed error kinds", () => {
    expect(isPending(UNAVAILABLE_PENDING)).toBe(true);
    expect(isSyncing(UNAVAILABLE_SYNCING)).toBe(true);
    const failure = unavailableError(new Error("request failed"), "network");
    expect(hasError(failure)).toBe(true);
    expect(failure.errorKind).toBe("network");
    expect(failure.errorMessage).toBe("request failed");
    expect(hasSchemaMismatch(failure)).toBe(false);
    expect(hasSchemaMismatch(unavailableMismatch())).toBe(true);
    expect(hasError(unavailableMismatch())).toBe(true);
    expect(unavailableMismatch()).toBe(unavailableMismatch());
  });

  it("rejects structural lookalikes and does not inspect successful payloads", () => {
    expect(isUnavailable({ reason: "pending" })).toBe(false);
    expect(isUnavailable(undefined)).toBe(false);
    const payload = {
      get nested() {
        throw new Error("opaque payload");
      },
    };
    expect(isPending(payload)).toBe(false);
    expect(hasError(payload)).toBe(false);
  });

  it("recognizes independently evaluated concrete primitive modules", () => {
    expect(DuplicateUnavailable).not.toBe(FabricUnavailable);
    expect(isPending(new DuplicateUnavailable("pending"))).toBe(true);
    expect(isSyncing(new DuplicateUnavailable("syncing"))).toBe(true);
    expect(
      hasSchemaMismatch(
        new DuplicateUnavailable("error", "schemaMismatch"),
      ),
    ).toBe(true);
  });
});

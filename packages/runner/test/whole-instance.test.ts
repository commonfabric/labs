import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { deepFreeze } from "@commonfabric/data-model";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import {
  FabricError,
  FabricLink,
  FabricMap,
} from "@commonfabric/data-model/fabric-instances";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import { canCarryFabricInstanceWhole } from "../src/whole-instance.ts";

/** A deep-frozen `FabricError` with the given `cause` and extras. */
function frozenError(
  cause: unknown,
  extras: Record<string, unknown> = {},
): FabricError {
  return deepFreeze(
    new FabricError({
      type: "Error",
      message: "boom",
      stack: undefined,
      cause: cause as never,
      extras: extras as never,
    }),
  );
}

/** A link to a document, in the representation the active regime writes. */
const LINK = linkRefFrom({ id: "of:fid1:linked", path: [] });

describe("whole-instance", () => {
  it("returns `true` for a deep-frozen instance holding only data", () => {
    const sparse = [1, , 3];
    const error = frozenError(frozenError(undefined), {
      record: { a: [1, "two", null], sparse },
      bytes: new FabricBytes(new Uint8Array([1])),
    });

    expect(canCarryFabricInstanceWhole(error)).toBe(true);
  });

  it("returns `false` for an instance that is not deep-frozen", () => {
    expect(
      canCarryFabricInstanceWhole(FabricError.fromNativeError(new Error("x"))),
    ).toBe(false);
  });

  it("returns `false` for a `FabricLink`, which is itself a link", () => {
    const link = deepFreeze(new FabricLink({ id: "of:fid1:self", path: [] }));

    expect(canCarryFabricInstanceWhole(link)).toBe(false);
  });

  it("returns `false` for an instance holding a link at any depth", () => {
    // In the instance's own state, in a container inside it, and in the state
    // of an instance inside it, which is reached by that instance's codec.

    expect(canCarryFabricInstanceWhole(frozenError(LINK))).toBe(false);
    expect(
      canCarryFabricInstanceWhole(frozenError(undefined, { r: { l: [LINK] } })),
    ).toBe(false);
    expect(canCarryFabricInstanceWhole(frozenError(frozenError(LINK))))
      .toBe(false);
  });

  it("returns `false` for an instance holding a `FabricLink` in either regime", () => {
    // The legacy regime is active here, where a link is written as a record,
    // and a `FabricLink` still counts.
    const link = new FabricLink({ id: "of:fid1:modern", path: [] });

    expect(canCarryFabricInstanceWhole(frozenError(link))).toBe(false);
  });

  it("returns `false` for an instance holding something that is not fabric data", () => {
    // A `Date` is a class instance with no `FabricValue` form of its own, and
    // a frozen one passes the deep-frozen test vacuously.

    expect(canCarryFabricInstanceWhole(frozenError(new Date(0)))).toBe(false);
    expect(canCarryFabricInstanceWhole(frozenError(Symbol("unique"))))
      .toBe(false);
  });

  it("throws what a class throws whose protocol is not yet implemented", () => {
    const map = Object.freeze(new FabricMap(new Map()));

    expect(() => canCarryFabricInstanceWhole(map)).toThrow(
      "not yet implemented",
    );
  });
});

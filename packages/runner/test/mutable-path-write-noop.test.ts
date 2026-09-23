// Covers the no-op (unchanged-value) branches of applyMutablePathWrite,
// including Fabric-aware equality for FabricPrimitive elements: an equal
// FabricBytes must be recognized as a no-op, and a different one as a change.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { applyMutablePathWrite } from "../src/storage/transaction/mutable-path-write.ts";
import type { IMemoryAddress } from "../src/storage/interface.ts";

const addr = (path: string[]): IMemoryAddress => ({ id: "of:mpw-noop", path });

describe("applyMutablePathWrite no-op detection", () => {
  it("reports changed=false writing an array element with its current value", () => {
    const res = applyMutablePathWrite([5, 6, 7], addr(["1"]), 6);
    expect(res.ok?.changed).toBe(false);
  });

  it("is Fabric-aware for array elements: equal FabricBytes is a no-op", () => {
    const root = [new FabricBytes(new Uint8Array([1, 2, 3]))];

    const same = applyMutablePathWrite(
      root,
      addr(["0"]),
      new FabricBytes(new Uint8Array([1, 2, 3])),
    );
    expect(same.ok?.changed).toBe(false);

    const different = applyMutablePathWrite(
      root,
      addr(["0"]),
      new FabricBytes(new Uint8Array([9, 9, 9])),
    );
    expect(different.ok?.changed).toBe(true);
  });

  it("reports changed=false writing array length with its current length", () => {
    const res = applyMutablePathWrite([5, 6, 7], addr(["length"]), 3);
    expect(res.ok?.changed).toBe(false);
  });

  it("refuses a write whose parent path lands on a `FabricInstance`", () => {
    // An instance holds its state privately, so `extra` addresses nothing in
    // one. Writing through it would report success for a value that no reading
    // of the instance -- the codec's included -- ever sees again.
    const err = FabricError.fromNativeError(new Error("boom"));
    const res = applyMutablePathWrite(
      Object.freeze({ err }),
      addr(["err", "extra"]),
      42,
    );

    expect(res.ok).toBeUndefined();
    expect(res.error?.name).toBe("TypeMismatchError");
    expect(Object.getOwnPropertyNames(err)).toEqual([]);
  });
});

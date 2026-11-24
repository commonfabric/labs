import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { float64BytesOfForTestingOnly } from "@/for-testing-only.ts";

import { hex } from "./hex.ts";

describe("float64BytesOf()", () => {
  // The function returns one buffer for every number other than `NaN`, and
  // writes into it on each call. So a case reads a result, as hex, before it
  // makes another call.

  it("returns the big-endian IEEE 754 bytes of a number", () => {
    expect(hex(float64BytesOfForTestingOnly(1))).toBe("3ff0000000000000");
    expect(hex(float64BytesOfForTestingOnly(-2.5))).toBe("c004000000000000");
  });

  it("returns different bytes for `-0` and `+0`", () => {
    expect(hex(float64BytesOfForTestingOnly(-0))).toBe("8000000000000000");
    expect(hex(float64BytesOfForTestingOnly(0))).toBe("0000000000000000");
  });

  it("returns the canonical quiet-`NaN` bytes for `NaN`", () => {
    expect(hex(float64BytesOfForTestingOnly(NaN))).toBe("7ff8000000000000");
  });

  it("returns an array for `NaN` which is not the one it returns for other numbers", () => {
    // This is the case that shows a `NaN`'s bytes are not read from the
    // value. The engine decides which bits a `NaN` has by the time it gets
    // here, so a case about the bytes of some particular `NaN` passes or
    // fails by engine. Which array comes back does not vary that way.

    const forNumber = float64BytesOfForTestingOnly(1);
    const forNaN = float64BytesOfForTestingOnly(NaN);

    expect(forNaN).not.toBe(forNumber);
    expect(float64BytesOfForTestingOnly(2)).toBe(forNumber);
  });

  it("returns the canonical quiet-`NaN` bytes for a `NaN` that has a payload", () => {
    // Where the engine canonicalizes the `NaN` before the call, this case
    // repeats the one for a plain `NaN`. Where the payload reaches the
    // function, this case fails if the function reads the bytes from the
    // value.

    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, 0x7ff8000000000001n, false);

    expect(hex(float64BytesOfForTestingOnly(view.getFloat64(0, false))))
      .toBe("7ff8000000000000");
  });
});

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { duration } from "./duration.ts";

describe("duration()", () => {
  it("returns minutes and seconds past a minute", () => {
    expect(duration(121)).toBe("2m1s");
    expect(duration(230)).toBe("3m50s");
  });

  it("returns a tenth of a second under ten seconds", () => {
    expect(duration(1.74)).toBe("1.7s");
    expect(duration(0.04)).toBe("0s");
    expect(duration(9.96)).toBe("10s");
  });

  it("returns whole seconds from ten seconds to a minute", () => {
    expect(duration(41.3)).toBe("41s");
    expect(duration(59.6)).toBe("1m");
  });

  it("leaves out the units at either end that are zero", () => {
    expect(duration(600)).toBe("10m");
    expect(duration(3600)).toBe("1h");
    expect(duration(3660)).toBe("1h1m");
  });

  it("keeps a zero between two units that are not", () => {
    expect(duration(3601)).toBe("1h0m1s");
  });
});

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { readOnlyArguments } from "./only-arguments.ts";

describe("readOnlyArguments()", () => {
  it("returns the terms in either spelling, and the rest in order", () => {
    expect(
      readOnlyArguments(["--update", "--only", "a.tsx", "--only=b/", "x"]),
    ).toEqual({ only: ["a.tsx", "b/"], rest: ["--update", "x"] });
  });

  it("returns no terms for a line that names none", () => {
    expect(readOnlyArguments(["--pin"])).toEqual({ only: [], rest: ["--pin"] });
  });

  it("refuses a term that is missing or empty", () => {
    // A run whose term is missing is not a filtered run, so the parser reports
    // an error instead of returning no terms.
    for (const argv of [["--only"], ["--only="], ["--only", ""]]) {
      expect(readOnlyArguments(argv)).toEqual({
        error: "--only needs a value",
      });
    }
  });

  it("refuses the next flag read as a term", () => {
    expect(readOnlyArguments(["--only", "--pin"])).toHaveProperty("error");
    expect(readOnlyArguments(["--only", "-x"])).toHaveProperty("error");
  });
});

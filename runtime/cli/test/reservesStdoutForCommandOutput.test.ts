import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { reservesStdoutForCommandOutput } from "../lib/json-output.ts";

describe("reservesStdoutForCommandOutput()", () => {
  it("skips the value of a long target option to find the subcommand", () => {
    expect(reservesStdoutForCommandOutput(["cell", "--space", "get", "get"]))
      .toBe(true);
    expect(reservesStdoutForCommandOutput(["cell", "--space", "get", "set"]))
      .toBe(false);
  });

  it("reads past a lone `-` to the subcommand", () => {
    expect(reservesStdoutForCommandOutput(["piece", "-", "call"])).toBe(true);
  });

  it("finds no subcommand after `--`", () => {
    expect(reservesStdoutForCommandOutput(["piece", "--", "call"])).toBe(
      false,
    );
  });
});

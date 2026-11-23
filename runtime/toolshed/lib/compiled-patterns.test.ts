/**
 * What a toolshed gives its serving runtimes for compiled patterns: nothing
 * with the experimental option off, a loader with one compiler with it on,
 * and a refusal to start where the option is on and no binary is there.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  compiledPatternsForServing,
  PATTERN_COMPILER_BINARY,
} from "./compiled-patterns.ts";

/** An environment that holds `values` and nothing else. */
const env = (values: Record<string, string>) => (name: string) => values[name];

describe("compiledPatternsForServing()", () => {
  it("gives nothing with the option off, whatever the environment names", () => {
    expect(
      compiledPatternsForServing(
        {},
        env({ [PATTERN_COMPILER_BINARY]: "/no/such/binary" }),
      ),
    ).toBeUndefined();
    expect(
      compiledPatternsForServing(
        { compiledPatterns: false },
        env({ [PATTERN_COMPILER_BINARY]: Deno.execPath() }),
      ),
    ).toBeUndefined();
  });

  it("refuses to start with the option on and no binary named", () => {
    expect(() =>
      compiledPatternsForServing({ compiledPatterns: true }, env({}))
    ).toThrow(PATTERN_COMPILER_BINARY);
  });

  it("refuses to start with the option on and a binary that is not there", () => {
    expect(() =>
      compiledPatternsForServing(
        { compiledPatterns: true },
        env({ [PATTERN_COMPILER_BINARY]: "/no/such/binary" }),
      )
    ).toThrow("/no/such/binary");
  });

  it("gives what installs the loader with the option on and a binary that is there", () => {
    const install = compiledPatternsForServing(
      { compiledPatterns: true },
      // Any file stands for the binary: nothing is compiled here.
      env({ [PATTERN_COMPILER_BINARY]: Deno.execPath() }),
    );

    expect(typeof install).toBe("function");
  });
});

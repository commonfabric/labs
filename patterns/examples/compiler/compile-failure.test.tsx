/** Checks compiler failure text keeps source diagnostics and ordinary errors. */

import { assert, pattern, TESTS } from "commonfabric";
import { compileFailure } from "./compile-failure.ts";

export default pattern(() => ({
  [TESTS]: [
    {
      assertion: assert(() =>
        compileFailure("Compilation failed", [
          { line: 3, column: 4, message: "Missing expression" },
          { line: 8, column: 2, message: "Unknown name" },
        ]) === "3:4 Missing expression\n8:2 Unknown name"
      ),
    },
    {
      assertion: assert(() =>
        compileFailure("Access denied", []) === "Access denied"
      ),
    },
    {
      assertion: assert(() =>
        compileFailure(undefined, undefined) === undefined
      ),
    },
  ],
}));

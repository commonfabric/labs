/**
 * `dataFile` is exposed to pattern code through the `commonfabric` builder
 * surface (declared in `api/index.ts`, bound in `builder/factory.ts`). The
 * surface carries a placeholder, because which data files exist is a property
 * of the program being loaded rather than of the runtime, and where a path
 * resolves from is a property of the module reading it: a graph carrying data
 * files hands each module its own copy of the namespace, with a reader closed
 * over both.
 *
 * These tests pin the placeholder's behavior. Reaching it means a module is
 * running outside any graph carrying data files, and the failure has to say so
 * rather than returning something a pattern would go on to parse.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createBuilder } from "../src/builder/factory.ts";

describe("commonfabric dataFile builtin", () => {
  const { dataFile } = createBuilder().commonfabric;

  it("is exposed as a function on the pattern surface", () => {
    expect(typeof dataFile).toBe("function");
  });

  it("refuses a read when no data-file closure is bound", () => {
    expect(() => dataFile("/data/cities.json")).toThrow(
      'No attached data file "/data/cities.json"',
    );
  });

  it("says the closure is missing rather than blaming the path", () => {
    // The distinction matters: a caller whose path is right, on a load that
    // carried no data, is told the load is the problem.
    expect(() => dataFile("/data/cities.json")).toThrow(
      "loaded without a data-file closure",
    );
  });
});

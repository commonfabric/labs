/**
 * Contract tests for the data files `cf test` attaches.
 *
 * A pattern that reads a data file compiles and type-checks whether or not one
 * is attached — `dataFile` is declared either way — so a missing attachment
 * would otherwise only show when the pattern runs. These pin that the file
 * reaches the runtime that runs the pattern, in both shapes `cf test`
 * supports, whether the run names it or the source does.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join, resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/data-files");
const DATA_FILE = join(FIXTURES, "data", "cities.json");

function fixture(name: string): string {
  return join(FIXTURES, name);
}

describe("cf test data files", () => {
  it("runs a pattern that reads an attached data file", async () => {
    const result = await runTests(fixture("single.test.tsx"), {
      root: FIXTURES,
      dataFilePaths: [DATA_FILE],
    });
    expect(result.failed).toBe(0);
    expect(result.passed).toBeGreaterThan(0);
  });

  it("reaches each participant of a multi-user test", async () => {
    // Participants compile in their own workers. Attaching only where the
    // workers are spawned leaves each of them without the closure, so this
    // fails on the participants rather than on the spawning runtime.
    const result = await runTests(fixture("multi-user.test.tsx"), {
      root: FIXTURES,
      dataFilePaths: [DATA_FILE],
    });
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(2);
  });

  it("attaches what the pattern reads without being given the path", async () => {
    // The source names `/data/cities.json`, which is the same declaration an
    // import makes: the run does not repeat it.
    const result = await runTests(fixture("single.test.tsx"), {
      root: FIXTURES,
    });
    expect(result.failed).toBe(0);
    expect(result.passed).toBeGreaterThan(0);
  });

  it("refuses a name the pattern reads with no file behind it", async () => {
    const root = resolve(import.meta.dirname!, "fixtures/data-files-missing");
    const result = await runTests(join(root, "missing.test.tsx"), { root });
    expect(result.failed).toBeGreaterThan(0);
  });
});

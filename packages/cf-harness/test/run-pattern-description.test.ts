/** Model-facing `run_pattern` text: a contract, and rules kept beside it. */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { RUN_PATTERN_GUIDANCE } from "../src/tool-guidance.ts";
import { runPatternToolDescriptor } from "../src/tools/run-pattern.ts";

describe("run-pattern description", () => {
  it("states what the tool takes and returns and no rule for using it", () => {
    expect(runPatternToolDescriptor.description).toEqual(
      'Compile and run a Common Fabric pattern in the configured space, given source that imports its runtime APIs from "commonfabric" or a published patternId; returns a reference to its live result cell and, when released, the values resultSchema selects.',
    );
  });

  it("states that the post-run pointer check is authoritative", () => {
    expect(RUN_PATTERN_GUIDANCE).toContain("known smell");
    expect(RUN_PATTERN_GUIDANCE).toContain("checks the actual pattern pointer");
    expect(RUN_PATTERN_GUIDANCE).toContain("session-only identity");
    expect(RUN_PATTERN_GUIDANCE).not.toContain(
      "creates a piece no other runtime",
    );
  });

  it("tells the model to bound a query's rows", () => {
    expect(RUN_PATTERN_GUIDANCE).toContain("Bound every query with a LIMIT");
    expect(RUN_PATTERN_GUIDANCE).toContain(
      "each result row is written as its own document",
    );
  });

  it("exempts an aggregate from the LIMIT it asks of every other query", () => {
    expect(RUN_PATTERN_GUIDANCE).toContain(
      "An aggregate (count(*), sum(), GROUP BY)",
    );
    expect(RUN_PATTERN_GUIDANCE).toContain("needs no LIMIT");
  });
});

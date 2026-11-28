/**
 * What `run_pattern` answers when deploying from the pattern index fails: the
 * model sees the deploy's own message and the status it can act on, the
 * withheld text goes only to the artifact, and a failure that is not a deploy
 * failure is not turned into an answer at all.
 */

import { expect } from "@std/expect";
import { IndexedPatternError } from "@commonfabric/pattern-index/deploy";
import { describe, it } from "@commonfabric/test-support/test";
import { indexedDeployFailure } from "../src/tools/run-pattern.ts";

describe("indexedDeployFailure()", () => {
  it("answers a compile failure as a compile error carrying the withheld diagnostic", () => {
    const failure = indexedDeployFailure(
      new IndexedPatternError("compile", "did not compile", "diagnostic text"),
    );

    expect(failure).toEqual({
      status: "compile-error",
      message: "did not compile",
      rawCauseMessage: "diagnostic text",
    });
  });

  it("answers a lookup or compose failure as an error, with nothing withheld when nothing was", () => {
    for (const stage of ["lookup", "compose"] as const) {
      const failure = indexedDeployFailure(
        new IndexedPatternError(stage, `${stage} failed`),
      );

      expect(failure).toEqual({ status: "error", message: `${stage} failed` });
      expect("rawCauseMessage" in failure).toBe(false);
    }
  });

  it("rethrows a failure that is not a deploy failure, unchanged", () => {
    const unexpected = new TypeError("quoted source text");

    let thrown: unknown;
    try {
      indexedDeployFailure(unexpected);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(unexpected);
  });
});

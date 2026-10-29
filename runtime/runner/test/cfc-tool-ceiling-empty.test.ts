import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { llmDialogTestHelpers } from "../src/builtins/llm-dialog.ts";

const { toolAllowsObservedConfidentiality } = llmDialogTestHelpers;

describe("CFC tool ceiling empty", () => {
  // Regression guard for empty tool-ceiling semantics (review follow-up to
  // W0.7).
  //
  // W0.7 made an empty maxConfidentiality "public only" in
  // cfcObservationFitsCeiling, but the LLM tool-call gate kept special-casing
  // an empty ceiling as allow-all, so a tool declaring ifc.maxConfidentiality:
  // [] still received confidential observations. A declared (even empty)
  // ceiling must be enforced.

  const catalogWithToolCeiling = (
    maxConfidentiality: unknown,
  ): Parameters<typeof toolAllowsObservedConfidentiality>[0] =>
    ({
      llmTools: {
        mytool: {
          inputSchema: { type: "object", ifc: { maxConfidentiality } },
        },
      },
    }) as unknown as Parameters<typeof toolAllowsObservedConfidentiality>[0];

  it("denies confidential observations under an empty tool ceiling", () => {
    expect(
      toolAllowsObservedConfidentiality(
        catalogWithToolCeiling([]),
        "mytool",
        ["secret"],
      ),
    ).toBe(false);
  });

  it("allows public observations under an empty tool ceiling", () => {
    expect(
      toolAllowsObservedConfidentiality(
        catalogWithToolCeiling([]),
        "mytool",
        [],
      ),
    ).toBe(true);
  });

  it("allows when no ceiling is declared", () => {
    expect(
      toolAllowsObservedConfidentiality(
        catalogWithToolCeiling(undefined),
        "mytool",
        ["secret"],
      ),
    ).toBe(true);
  });

  it("enforces a populated tool ceiling", () => {
    expect(
      toolAllowsObservedConfidentiality(
        catalogWithToolCeiling(["a"]),
        "mytool",
        ["a"],
      ),
    ).toBe(true);
    expect(
      toolAllowsObservedConfidentiality(
        catalogWithToolCeiling(["a"]),
        "mytool",
        ["b"],
      ),
    ).toBe(false);
  });

  it("denies every call under a ceiling declared as anything but a list", () => {
    // A malformed declaration fails even when the call observed nothing
    // (§8.10.3), rather than read as no ceiling at all.

    expect(
      toolAllowsObservedConfidentiality(
        catalogWithToolCeiling({}),
        "mytool",
        ["secret"],
      ),
    ).toBe(false);
    expect(
      toolAllowsObservedConfidentiality(
        catalogWithToolCeiling({}),
        "mytool",
        [],
      ),
    ).toBe(false);
  });
});

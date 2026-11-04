import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type {
  HarnessResearchKit,
  HarnessResearchRunSummary,
} from "../../src/contracts/research.ts";
import { selectResearchContext } from "../../src/research/context.ts";
import { projectHarnessResearchKitForModel } from "../../src/research/model-projection.ts";
import { RESEARCH_KIT_SCHEMA } from "../../src/contracts/research-schema.ts";
import { validateStructuredResultValue } from "../../src/structured-result.ts";

const kit = (): HarnessResearchKit => ({
  status: "incomplete",
  task: "Compose a counter",
  summary: "Use did:key:zUntrusted in prose",
  recommendation: {
    kind: "compose",
    rationale: "Reuse the inspected component.",
  },
  inputs: [{
    name: "counter",
    token: "cfh:a:counter",
    purpose: "Existing count",
  }],
  patterns: [{
    patternId: "confirmed",
    description: "Counter did:key:zDescription",
    hashtags: [],
    importHint: 'import Counter from "cf:pattern:confirmed"',
    ownerDid: "did:key:zPublisher",
    signals: {
      uses: 2,
      score: 1,
      inherited: {
        priorPatternId: "p".repeat(43),
        asOf: "2026-09-17T00:00:00Z",
        events: { run_succeeded: 1 },
        score: 1,
      },
    },
    argumentType: "{ count: number }",
    resultType: "{ count: number }",
    argumentSchema: { type: "object", description: "unused secret shape" },
    resultSchema: {
      type: "object",
      properties: { "did:key:zSchema": { type: "string" } },
    },
  }],
  steps: [],
  rules: [],
  verification: [],
  missing: ["Wire the composition"],
  sources: [{
    sourceId: "pattern-source:exact",
    kind: "pattern-source",
    location: "cf:pattern:confirmed:/main.tsx",
    offset: 0,
    end: 2,
    totalChars: 2,
    digest: "sha256:exact",
    cfcLabel: { confidentiality: ["did:key:zLabel"] },
  }],
});
const summary = (
  id: string,
  kind: "author" | "focused-api",
): HarnessResearchRunSummary => ({
  type: "cf-harness.research-run",
  researchRunId: id,
  outputId: id,
  kit: { ...kit(), recommendation: { kind, rationale: id } },
  confirmedPatterns: [],
  describedHandles: [],
  completedAt: "2026-09-15T00:00:00Z",
});

describe("research model context", () => {
  it("scrubs derived text while retaining exact identities and raw artifact locations", () => {
    const original = kit();
    const before = structuredClone(original);
    const projection = projectHarnessResearchKitForModel(original);
    expect(projection.kit.summary).toBe("Use [fabric-id] in prose");
    expect(projection.kit.patterns[0].description).toBe("Counter [fabric-id]");
    expect(projection.kit.patterns[0].ownerDid).toBe("did:key:zPublisher");
    expect(projection.kit.patterns[0].signals).toEqual(
      original.patterns[0].signals,
    );
    expect(projection.kit.patterns[0].importHint).toBe(
      original.patterns[0].importHint,
    );
    expect(projection.kit.inputs).toEqual(original.inputs);
    expect(projection.kit.sources).toEqual(original.sources);
    expect(projection.kit.patterns[0]).not.toHaveProperty("argumentSchema");
    expect(projection.kit.patterns[0]).not.toHaveProperty("resultSchema");
    expect(projection.scrubbedPointers).toEqual([
      "/kit/summary",
      "/kit/patterns/0/description",
    ]);
    expect(projection.artifactOnlyPointers).toEqual([
      "/kit/patterns/0/argumentSchema",
      "/kit/patterns/0/resultSchema",
    ]);
    expect(original).toEqual(before);
  });

  it("scrubs added fields and unsafe member names by default", () => {
    const original = {
      ...kit(),
      extension: { "did:key:zKey": { note: "did:key:zValue" } },
    };
    const projection = projectHarnessResearchKitForModel(
      original,
      "/nested/kit",
    );
    expect((projection.kit as unknown as Record<string, unknown>).extension)
      .toEqual({ "[fabric-id]": { note: "[fabric-id]" } });
    expect(projection.scrubbedPointers).toContain("/nested/kit/extension");
    expect(projection.scrubbedPointers.join("\n")).not.toContain("did:key:");
  });

  it("keeps the latest recipe and two focused answers as whole chronological records", () => {
    const runs = [
      summary("old-recipe", "author"),
      summary("old-answer", "focused-api"),
      summary("current-recipe", "author"),
      summary("answer-a", "focused-api"),
      summary("answer-b", "focused-api"),
    ];
    const selected = selectResearchContext(runs);
    expect(selected.map((run) => run.researchRunId)).toEqual([
      "current-recipe",
      "answer-a",
      "answer-b",
    ]);
    expect(selected[0]).toBe(runs[2]);
    expect(selectResearchContext([])).toEqual([]);
    expect(selectResearchContext(runs.slice(0, 1))).toEqual([runs[0]]);
  });

  describe("the public kit schema", () => {
    it("accepts the projected kit and requires structured members and parser evidence", () => {
      const projected = projectHarnessResearchKitForModel(kit()).kit;
      expect(() =>
        validateStructuredResultValue({
          schema: RESEARCH_KIT_SCHEMA,
          value: projected,
        })
      ).not.toThrow();
      for (const field of ["inputs", "patterns", "rules", "sources"] as const) {
        expect(() =>
          validateStructuredResultValue({
            schema: RESEARCH_KIT_SCHEMA,
            value: { ...projected, [field]: [{}] },
          })
        ).toThrow();
      }
      const example = {
        kind: "pattern-source",
        content: "export default 1;",
        sourceIds: [],
      };
      expect(() =>
        validateStructuredResultValue({
          schema: RESEARCH_KIT_SCHEMA,
          value: { ...projected, example },
        })
      ).toThrow();
      expect(() =>
        validateStructuredResultValue({
          schema: RESEARCH_KIT_SCHEMA,
          value: {
            ...projected,
            example: {
              ...example,
              syntax: {
                status: "valid",
                scope: "syntax-only",
                diagnostics: [],
              },
            },
          },
        })
      ).not.toThrow();
    });
  });
});

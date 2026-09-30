import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { HarnessResearchSourceRead } from "../../src/contracts/research.ts";
import { researchKitGuidance } from "../../src/tools/research.ts";
import {
  admitResearchKit,
  type RawResearchResult,
  type ResearchAdmissionEvidence,
} from "../../src/research/admission.ts";

const metadata: HarnessResearchSourceRead = {
  sourceId: "pattern-metadata:exact",
  kind: "pattern-metadata",
  location: "cf:pattern:confirmed",
  offset: 0,
  end: 100,
  totalChars: 100,
  digest: "sha256:exact",
};
const source: HarnessResearchSourceRead = {
  sourceId: "pattern-source:exact",
  kind: "pattern-source",
  location: "cf:pattern:confirmed:/main.tsx",
  offset: 0,
  end: 100,
  totalChars: 100,
  digest: "sha256:source",
};
const evidence: ResearchAdmissionEvidence = {
  sourceReads: [metadata, source],
  confirmedPatterns: new Map([["confirmed", {
    patternId: "confirmed",
    description: "Inspected component",
    hashtags: [],
    importHint: 'import X from "cf:pattern:confirmed"',
    sourceIdentityVerified: true,
  }]]),
  describedHandles: new Map(),
};
const candidate = (content: string): RawResearchResult => ({
  status: "complete",
  summary: "Run the inspected component.",
  recommendation: { kind: "direct-run", rationale: "It implements the task." },
  selectedPatternIds: ["confirmed"],
  inputs: [],
  steps: [],
  rules: [],
  verification: [],
  sourceIds: [metadata.sourceId],
  missing: [],
  example: { kind: "run-pattern-input", content, sourceIds: [source.sourceId] },
});

describe("research admission", () => {
  for (const kind of ["author", "compose", "direct-run"]) {
    it(`reports a zero-example ${kind} implementation kit as incomplete to its caller`, async () => {
      const proposed = candidate('{"patternId":"confirmed"}');
      delete proposed.example;
      proposed.recommendation = {
        kind,
        rationale: "Use the inspected contract.",
      };
      const kit = await admitResearchKit(
        "Build the smallest useful piece",
        proposed,
        evidence,
      );
      expect(kit.status).toBe("incomplete");
      expect(kit.example).toBeUndefined();
      expect(kit.missing).toEqual([
        kind === "direct-run"
          ? "direct-run requires a complete run_pattern input example"
          : `${kind} requires a complete pattern-source example`,
      ]);
      expect(kit.sources).toEqual([metadata]);
      expect(kit.patterns.map((pattern) => pattern.patternId)).toEqual([
        "confirmed",
      ]);
      expect(researchKitGuidance(kit)).toContain(
        "This research is incomplete.",
      );
      expect(researchKitGuidance(kit)).not.toContain("passed host admission");
    });
  }

  describe("direct invocations", () => {
    for (
      const [name, content] of [
        ["placeholder text", "TODO: fill in the patternId here"],
        ["an unselected pattern", '{"patternId":"unconfirmed"}'],
        ["the wrong input field", '{"patternId":"confirmed","argument":{}}'],
        ["a malformed input shape", '{"patternId":"confirmed","inputs":[]}'],
        [
          "both source and identity",
          '{"patternId":"confirmed","sourceText":"export default 1"}',
        ],
      ]
    ) {
      it(`retains ${name} as an incomplete example`, async () => {
        const kit = await admitResearchKit(
          "Run a component",
          candidate(content),
          evidence,
        );
        expect(kit.status).toBe("incomplete");
        expect(kit.missing.join("\n")).toContain(
          "run-pattern-input example is invalid",
        );
        expect(kit.example?.content).toBe(content);
        expect(kit.sources).toEqual([metadata, source]);
      });
    }

    it("admits the shared run_pattern contract with one inspected identity", async () => {
      const content = JSON.stringify({
        patternId: "confirmed",
        inputs: { count: 2 },
      });
      const kit = await admitResearchKit(
        "Run a component",
        candidate(content),
        evidence,
      );
      expect(kit.status).toBe("complete");
      expect(kit.missing).toEqual([]);
      expect(kit.example?.content).toBe(content);
    });
  });

  describe("citation closure", () => {
    it("includes exact sources cited only by rules and examples", async () => {
      const proposed = candidate('{"patternId":"confirmed"}');
      proposed.sourceIds = [];
      proposed.rules = [{
        rule: "Use the inspected argument contract.",
        sourceIds: [metadata.sourceId],
      }];
      const kit = await admitResearchKit("Run a component", proposed, evidence);
      expect(kit.status).toBe("complete");
      expect(kit.sources).toEqual([source, metadata]);
    });

    it("does not admit a rule whose citation was never opened", async () => {
      const proposed = candidate('{"patternId":"confirmed"}');
      proposed.rules = [{
        rule: "Invented contract",
        sourceIds: ["documentation:unread"],
      }];
      const kit = await admitResearchKit("Run a component", proposed, evidence);
      expect(kit.status).toBe("incomplete");
      expect(kit.rules).toEqual([]);
      expect(kit.sources).toEqual([metadata, source]);
    });
  });
});

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { ensureCompilerStack } from "@commonfabric/runner";

import type {
  HarnessResearchKit,
  HarnessResearchSourceRead,
} from "../../src/contracts/research.ts";
import { researchKitGuidance } from "../../src/tools/research.ts";
import {
  admitResearchResult,
  MAX_RESEARCH_EXAMPLE_CHARS,
  type RawResearchResult,
  RESEARCH_RESULT_SCHEMA,
  type ResearchAdmissionEvidence,
  researchResultSchema,
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
/** The inspected pattern, before its source identity is verified. */
const unverifiedPattern = {
  patternId: "confirmed",
  description: "Inspected component",
  hashtags: [],
  importHint: 'import X from "cf:pattern:confirmed"',
};
const evidence: ResearchAdmissionEvidence = {
  sourceReads: [metadata, source],
  confirmedPatterns: new Map([["confirmed", {
    ...unverifiedPattern,
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

/** The kit `admitResearchResult` admits for an unscoped `raw`. */
const admitKit = async (
  task: string,
  raw: RawResearchResult,
  state: ResearchAdmissionEvidence = evidence,
): Promise<HarnessResearchKit> => {
  const result = await admitResearchResult(task, raw, state);
  if (result.purpose !== undefined) {
    throw new Error(`expected an unscoped kit, not a ${result.purpose} result`);
  }
  return result;
};

describe("research admission", () => {
  for (const kind of ["author", "compose", "direct-run"]) {
    it(`reports a zero-example ${kind} implementation kit as incomplete to its caller`, async () => {
      const proposed = candidate('{"patternId":"confirmed"}');
      delete proposed.example;
      proposed.recommendation = {
        kind,
        rationale: "Use the inspected contract.",
      };
      const kit = await admitKit("Build the smallest useful piece", proposed);
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
        const kit = await admitKit("Run a component", candidate(content));
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
      const kit = await admitKit("Run a component", candidate(content));
      expect(kit.status).toBe("complete");
      expect(kit.missing).toEqual([]);
      expect(kit.example?.content).toBe(content);
    });
  });

  describe("kit blockers", () => {
    it("asks an unscoped run for the full kit schema", () => {
      expect(researchResultSchema(undefined)).toBe(RESEARCH_RESULT_SCHEMA);
    });

    it("requires a cited rule for a focused-api kit", async () => {
      const proposed = candidate('{"patternId":"confirmed"}');
      proposed.recommendation = { kind: "focused-api", rationale: "Use it." };
      const kit = await admitKit("Explain an API", proposed);
      expect(kit.status).toBe("incomplete");
      expect(kit.missing).toEqual([
        "focused-api requires at least one cited rule",
      ]);

      proposed.rules = [{ rule: "Call it.", sourceIds: [metadata.sourceId] }];
      expect((await admitKit("Explain an API", proposed)).status).toBe(
        "complete",
      );
    });

    it("requires an inspected pattern for a direct run", async () => {
      const proposed = candidate('{"patternId":"confirmed"}');
      proposed.selectedPatternIds = [];
      const kit = await admitKit("Run a component", proposed);
      expect(kit.status).toBe("incomplete");
      expect(kit.patterns).toEqual([]);
      expect(kit.missing).toContain(
        "direct-run requires an inspected published pattern",
      );
    });

    it("requires a verified source identity for a direct run", async () => {
      const unverified: ResearchAdmissionEvidence = {
        ...evidence,
        confirmedPatterns: new Map([["confirmed", unverifiedPattern]]),
      };
      const kit = await admitKit(
        "Run a component",
        candidate('{"patternId":"confirmed"}'),
        unverified,
      );
      expect(kit.status).toBe("incomplete");
      expect(kit.missing).toEqual([
        "direct-run requires verified published source identities",
      ]);
    });

    it("requires at least one exact source read", async () => {
      const proposed = candidate("");
      delete proposed.example;
      proposed.sourceIds = [];
      proposed.recommendation = { kind: "focused-api", rationale: "Use it." };
      const kit = await admitKit("Explain an API", proposed);
      expect(kit.status).toBe("incomplete");
      expect(kit.sources).toEqual([]);
      expect(kit.missing).toContain(
        "no exact documentation or indexed-source read supports the kit",
      );
    });

    it("admits only input bindings with a described handle, a name, and a purpose", async () => {
      const described: ResearchAdmissionEvidence = {
        ...evidence,
        describedHandles: new Map([["h1", { token: "h1", description: {} }]]),
      };
      const proposed = candidate('{"patternId":"confirmed"}');
      proposed.inputs = [
        { name: "a", purpose: "p" },
        { token: "h2", name: "a", purpose: "p" },
        { token: "h1", purpose: "p" },
        { token: "h1", name: "a" },
        { token: "h1", name: "a", purpose: "p" },
      ];
      const kit = await admitKit("Run a component", proposed, described);
      expect(kit.inputs).toEqual([{ name: "a", token: "h1", purpose: "p" }]);
      expect(kit.status).toBe("incomplete");
      expect(kit.missing).toEqual([
        "an input binding has no nonempty handle token",
        "handle h2 was not described",
        "handle h1 has no nonempty input name",
        "handle h1 has no nonempty binding purpose",
      ]);
    });

    it("drops an example longer than the limit", async () => {
      const proposed = candidate("x".repeat(MAX_RESEARCH_EXAMPLE_CHARS + 1));
      const kit = await admitKit("Run a component", proposed);
      expect(kit.example).toBeUndefined();
      expect(kit.status).toBe("incomplete");
      expect(kit.missing).toContain(
        `complete example exceeds ${MAX_RESEARCH_EXAMPLE_CHARS} characters`,
      );
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
      const kit = await admitKit("Run a component", proposed);
      expect(kit.status).toBe("complete");
      expect(kit.sources).toEqual([source, metadata]);
    });

    it("does not admit a rule whose citation was never opened", async () => {
      const proposed = candidate('{"patternId":"confirmed"}');
      proposed.rules = [{
        rule: "Invented contract",
        sourceIds: ["documentation:unread"],
      }];
      const kit = await admitKit("Run a component", proposed);
      expect(kit.status).toBe("incomplete");
      expect(kit.rules).toEqual([]);
      expect(kit.sources).toEqual([metadata, source]);
    });
  });

  describe("pattern-source syntax", () => {
    //
    // An author kit's pattern-source example is parsed, and what the parser
    // reports decides what the kit is missing.
    //

    const authored = (content: string): RawResearchResult => ({
      ...candidate(""),
      recommendation: { kind: "author", rationale: "Write the piece." },
      example: {
        kind: "pattern-source",
        content,
        sourceIds: [source.sourceId],
      },
    });

    it("admits a well-formed example as `valid` with nothing missing", async () => {
      const kit = await admitResearchResult(
        "Write a component",
        authored("export const x = <div>hi</div>;\n"),
        evidence,
      );
      expect(kit.status).toBe("complete");
      expect(kit.missing).toEqual([]);
      expect(kit.example?.syntax).toEqual({
        status: "valid",
        scope: "syntax-only",
        diagnostics: [],
      });
    });

    it("returns a malformed example as `invalid`, missing one located blocker per diagnostic", async () => {
      const kit = await admitResearchResult(
        "Write a component",
        authored("const = 1;\n"),
        evidence,
      );
      expect(kit.status).toBe("incomplete");
      expect(kit.example?.syntax?.status).toBe("invalid");
      expect(kit.example?.syntax?.diagnostics[0]).toMatchObject({
        code: 1134,
        line: 1,
        column: 7,
      });
      expect(kit.missing).toEqual([
        "pattern-source example has a syntax error: TS1134 at 1:7: Variable declaration expected.",
        "pattern-source example has a syntax error: TS1134 at 1:9: Variable declaration expected.",
      ]);
    });

    it("returns a diagnostic reported against no file without a location", async () => {
      const kit = await admitResearchResult(
        "Write a component",
        authored("export const x = 1;\n"),
        evidence,
        undefined,
        {
          loadCompilerStack: async () => {
            const stack = await ensureCompilerStack();
            return {
              ...stack,
              ts: {
                ...stack.ts,
                transpileModule: () => ({
                  outputText: "",
                  diagnostics: [{
                    category: stack.ts.DiagnosticCategory.Error,
                    code: 5023,
                    messageText: "Unknown compiler option.",
                    file: undefined,
                    start: undefined,
                    length: undefined,
                  }],
                }),
              },
            };
          },
        },
      );
      expect(kit.example?.syntax?.diagnostics).toEqual([
        { code: 5023, message: "Unknown compiler option." },
      ]);
      expect(kit.missing).toEqual([
        "pattern-source example has a syntax error: TS5023: Unknown compiler option.",
      ]);
    });

    it("returns `unavailable`, missing the reason, when the compiler stack does not load", async () => {
      const kit = await admitResearchResult(
        "Write a component",
        authored("const = 1;\n"),
        evidence,
        undefined,
        {
          loadCompilerStack: () =>
            Promise.reject(new Error("compiler stack fetch failed")),
        },
      );
      expect(kit.status).toBe("incomplete");
      expect(kit.example?.syntax).toEqual({
        status: "unavailable",
        scope: "syntax-only",
        diagnostics: [],
        detail: "compiler stack fetch failed",
      });
      expect(kit.missing).toEqual([
        "pattern-source syntax check was unavailable: compiler stack fetch failed",
      ]);
    });
  });
});

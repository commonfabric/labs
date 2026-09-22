import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { HarnessResearchRunSummary } from "../../src/contracts/research.ts";
import { RUN_PATTERN_INPUT_SCHEMA } from "../../src/contracts/run-pattern.ts";
import { unexplainedResearchPatterns } from "../../src/research/reuse.ts";
import { REUSE_RESEARCH_RUNS } from "../fixtures/research-reuse.ts";

const mailboxId = REUSE_RESEARCH_RUNS[0].kit.patterns[0].patternId;
const source = (contents = "export default {};") => ({
  name: "/main.tsx",
  contents,
});

describe("reuse", () => {
  describe("unexplainedResearchPatterns()", () => {
    it("returns the omitted mailbox selection once for the incomplete rehearsal kits", async () => {
      expect(
        await unexplainedResearchPatterns(
          REUSE_RESEARCH_RUNS,
          source(),
          undefined,
        ),
      ).toEqual([mailboxId]);
    });

    it("returns no omission when the source imports the selected component", async () => {
      expect(
        await unexplainedResearchPatterns(
          REUSE_RESEARCH_RUNS,
          source(`import Mailbox from "cf:pattern:${mailboxId}";`),
          undefined,
        ),
      ).toEqual([]);
    });

    for (
      const contents of [
        `// import Mailbox from "cf:pattern:${mailboxId}";`,
        `const example = 'import Mailbox from "cf:pattern:${mailboxId}";';`,
        `const load = import("cf:pattern:${mailboxId}");`,
      ]
    ) {
      it(`returns the omission for unsupported import text ${JSON.stringify(contents)}`, async () => {
        expect(
          await unexplainedResearchPatterns(
            REUSE_RESEARCH_RUNS,
            source(contents),
            undefined,
          ),
        ).toEqual([mailboxId]);
      });
    }

    it("accepts a one-line reason addressed to the omitted selection", async () => {
      expect(" This atom reads Linear. ").toMatch(
        new RegExp(
          RUN_PATTERN_INPUT_SCHEMA.properties.reuseReasons.additionalProperties
            .pattern,
        ),
      );
      expect(
        await unexplainedResearchPatterns(
          REUSE_RESEARCH_RUNS,
          source(),
          {
            [mailboxId]:
              "This atom reads Linear; the mailbox is composed separately.",
          },
        ),
      ).toEqual([]);
    });

    for (
      const reason of [
        "",
        "  \t",
        "First line\nSecond line",
        "First\rSecond",
        "First\n",
        "First\r\n",
      ]
    ) {
      it(`returns the omission for a reason that is not one nonblank line ${JSON.stringify(reason)}`, async () => {
        expect(reason).not.toMatch(
          new RegExp(
            RUN_PATTERN_INPUT_SCHEMA.properties.reuseReasons
              .additionalProperties
              .pattern,
          ),
        );
        expect(
          await unexplainedResearchPatterns(
            REUSE_RESEARCH_RUNS,
            source(),
            { [mailboxId]: reason },
          ),
        ).toEqual([mailboxId]);
      });
    }

    it("returns the omission when the reason names another pattern", async () => {
      expect(
        await unexplainedResearchPatterns(
          REUSE_RESEARCH_RUNS,
          source(),
          { unrelated: "Its time window does not fit." },
        ),
      ).toEqual([mailboxId]);
    });

    it("keeps a retained selection when its handle bindings are historical", async () => {
      expect(
        await unexplainedResearchPatterns(
          REUSE_RESEARCH_RUNS.map((run) => ({ ...run, historical: true })),
          source(),
          undefined,
        ),
      ).toEqual([mailboxId]);
    });

    it("omits superseded selections and unverified leads from the requirement", async () => {
      const prior = REUSE_RESEARCH_RUNS[0];
      const current: HarnessResearchRunSummary = {
        ...prior,
        researchRunId: "current-orientation",
        kit: {
          ...prior.kit,
          patterns: [],
          leads: [{
            pattern: prior.kit.patterns[0],
            question: "Does this window fit?",
          }],
        },
      };
      expect(
        await unexplainedResearchPatterns(
          [prior, current],
          source(),
          undefined,
        ),
      ).toEqual([]);
    });

    it("requires a decision for each retained selection", async () => {
      const otherId = "B".repeat(43);
      const run = structuredClone(REUSE_RESEARCH_RUNS[0]);
      run.kit.patterns.push({ ...run.kit.patterns[0], patternId: otherId });
      expect(
        await unexplainedResearchPatterns(
          [run],
          source(`import Mailbox from "cf:pattern:${mailboxId}";`),
          undefined,
        ),
      ).toEqual([otherId]);
    });
  });
});

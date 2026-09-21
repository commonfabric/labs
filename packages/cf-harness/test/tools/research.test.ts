import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { createToolOutputId } from "../../src/contracts/tool-result.ts";
import {
  isResearchToolSuccessOutput,
  researchKitGuidance,
  researchTool,
} from "../../src/tools/research.ts";
import type { HarnessToolContext } from "../../src/tools/types.ts";
import type { HarnessResearchRequest } from "../../src/research/runner.ts";
import { REUSE_RESEARCH_RUNS } from "../fixtures/research-reuse.ts";
import {
  createHarnessHandleTable,
  mintAddressHandle,
} from "../../src/handle-table.ts";

describe("research", () => {
  describe("researchKitGuidance()", () => {
    it("tells the author how to account for the incomplete kit's selected mailbox", () => {
      const guidance = researchKitGuidance(REUSE_RESEARCH_RUNS[0].kit);
      expect(guidance).toContain(
        "import as cf:pattern:<id>, or supply reuseReasons[<id>] as one nonblank line",
      );
      expect(guidance).toContain("This also applies to an incomplete kit.");
    });
  });

  describe("isResearchToolSuccessOutput()", () => {
    it("returns false for values that are not result objects", () => {
      for (const output of [null, undefined, "ok", 1, []]) {
        expect(isResearchToolSuccessOutput(output)).toBe(false);
      }
    });
  });

  describe("researchTool", () => {
    it("forwards the established attachment record separately from the general handle inventory", async () => {
      const attached = await mintAddressHandle(
        createHarnessHandleTable("attached"),
        `/of:fid1:${"A".repeat(43)}`,
      );
      const registry = await mintAddressHandle(
        attached.table,
        `/of:fid1:${"B".repeat(43)}/pieceRegistry`,
      );
      const inputCells = [{
        name: "pattern_1",
        token: attached.token,
        ref: `/of:fid1:${"A".repeat(43)}`,
      }];
      let request: HarnessResearchRequest | undefined;
      const context: Partial<HarnessToolContext> = {
        nextOutputId: () => createToolOutputId("attached", "research", 1),
        inputCells,
        handleTable: registry.table,
        runResearch: (value) => {
          request = value;
          return Promise.reject(new Error("stop after capturing the request"));
        },
      };
      await researchTool.invoke(context as HarnessToolContext, {
        task: "Revise the attached piece",
      });
      expect(request?.inputCells).toEqual(inputCells);
      expect(request?.handleTokens).toEqual([attached.token, registry.token]);
    });

    it("refuses an unknown follow-up before invoking research and retains task influence", async () => {
      let invoked = false;
      const context: Partial<HarnessToolContext> = {
        nextOutputId: () => createToolOutputId("follow-up", "research", 1),
        researchTaskCfcLabel: { confidentiality: ["task-influence"] },
        researchRuns: [],
        runResearch: () => {
          invoked = true;
          return Promise.reject(new Error("unexpected research invocation"));
        },
      };
      const output = await researchTool.invoke(context as HarnessToolContext, {
        task: "Clarify the input contract",
        purpose: "answer",
        followUpTo: "unknown-result",
      });
      expect(invoked).toBe(false);
      expect(output).toMatchObject({
        status: "error",
        message:
          "followUpTo must name an admitted research result available to this run",
        cfc: { outputLabel: { confidentiality: ["task-influence"] } },
      });
      expect(output).not.toHaveProperty("researchRecord");
    });

    it("retains an artifact-only fallback for an unconvertible provider cause", async () => {
      const context: Partial<HarnessToolContext> = {
        nextOutputId: () => createToolOutputId("unconvertible", "research", 1),
        runResearch: () => Promise.reject(Object.create(null)),
      };
      const output = await researchTool.invoke(context as HarnessToolContext, {
        task: "Find a recipe",
      });
      expect(output).toMatchObject({
        status: "error",
        rawCauseMessage: "error could not be converted to text",
      });
      expect(output).not.toHaveProperty("researchRecord");
    });

    it("returns a source-free error when no research runner is installed", async () => {
      const outputId = createToolOutputId("no-runner", "research", 1);
      const context: Partial<HarnessToolContext> = {
        nextOutputId: () => outputId,
      };
      const output = await researchTool.invoke(context as HarnessToolContext, {
        task: "Find a recipe",
      });
      expect(output).toMatchObject({
        outputId,
        status: "error",
        message: "research requires the host research runner",
        cfc: { coverage: "complete", missingLabels: [] },
      });
      expect(output).not.toHaveProperty("researchRecord");
    });
  });
});

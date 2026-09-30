import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { FabricValue } from "@commonfabric/data-model";
import type { IFCLabel } from "@commonfabric/runner/cfc";

import { createToolOutputId } from "../../src/contracts/tool-result.ts";
import {
  isResearchToolSuccessOutput,
  researchTool,
} from "../../src/tools/research.ts";
import type { HarnessToolContext } from "../../src/tools/types.ts";
import type {
  HarnessResearchRecord,
  HarnessResearchRequest,
} from "../../src/research/runner.ts";
import type { HarnessHandleReferentDraft } from "../../src/contracts/handle-table.ts";
import {
  HARNESS_RESEARCH_HANDLE_TYPE,
  type HarnessResearchHandleValue,
  type HarnessResearchResult,
} from "../../src/contracts/research.ts";
import {
  createHarnessHandleTable,
  mintAddressHandle,
  mintReferentHandle,
} from "../../src/handle-table.ts";

const KIT: HarnessResearchResult = {
  purpose: "answer",
  status: "complete",
  task: "Which renderer takes a typed collection?",
  summary: "The typed renderer does.",
  inputs: [],
  patterns: [],
  rules: [],
  sources: [],
  missing: [],
};

const CFC = {
  version: 1 as const,
  sourceLabel: { confidentiality: ["https://cfc.test/atom/finding"] },
  outputLabel: { confidentiality: ["https://cfc.test/atom/finding"] },
  coverage: "complete" as const,
  missingLabels: [],
};

/** A reply whose record carries only what minting and retention read. */
const replyFor = (kit: HarnessResearchResult) => ({
  kit,
  record: {
    confirmedPatterns: [],
    describedHandles: [],
    cfc: CFC,
  } as unknown as HarnessResearchRecord,
});

const researchReferent: HarnessHandleReferentDraft = {
  kind: "research",
  source: "research",
  labelSource: "research",
  label: CFC.outputLabel,
  value: {
    type: HARNESS_RESEARCH_HANDLE_TYPE,
    researchRunId: "earlier:research:1",
    kit: KIT,
    confirmedPatterns: [],
    describedHandles: [],
    cfc: CFC,
  } satisfies HarnessResearchHandleValue as unknown as FabricValue,
};

describe("research", () => {
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

    it("mints a research handle for an admitted kit under the kit's label and names it in the result", async () => {
      let minted:
        | { value: HarnessResearchHandleValue; label: IFCLabel }
        | undefined;
      const context: Partial<HarnessToolContext> = {
        nextOutputId: () => createToolOutputId("minted", "research", 1),
        now: () => "2026-09-23T00:00:00.000Z",
        runResearch: () => Promise.resolve(replyFor(KIT)),
        mintResearchHandle: (value, label) => {
          minted = { value, label };
          return Promise.resolve("cfh:v:abcde");
        },
      };
      const output = await researchTool.invoke(context as HarnessToolContext, {
        task: KIT.task,
        purpose: "answer",
      });
      expect(output).toMatchObject({
        status: "ok",
        researchHandle: "cfh:v:abcde",
      });
      expect(minted?.label).toEqual(CFC.outputLabel);
      expect(minted?.value).toMatchObject({
        type: HARNESS_RESEARCH_HANDLE_TYPE,
        researchRunId: "minted:research:1",
        kit: KIT,
        cfc: CFC,
      });
    });

    it("surfaces a minting fault as its own error rather than as a research failure", async () => {
      let failures = 0;
      const context: Partial<HarnessToolContext> = {
        nextOutputId: () => createToolOutputId("minting", "research", 1),
        now: () => "2026-09-23T00:00:00.000Z",
        runResearch: () => Promise.resolve(replyFor(KIT)),
        recordResearchFailure: () => {
          failures += 1;
        },
        mintResearchHandle: () =>
          Promise.reject(new Error("handle table could not be written")),
      };
      await expect(
        researchTool.invoke(context as HarnessToolContext, {
          task: KIT.task,
          purpose: "answer",
        }),
      ).rejects.toThrow("handle table could not be written");
      expect(failures).toBe(0);
    });

    it("mints no handle when research returns no kit", async () => {
      let mints = 0;
      const context: Partial<HarnessToolContext> = {
        nextOutputId: () => createToolOutputId("failed", "research", 1),
        runResearch: () => Promise.reject(new Error("result was not JSON")),
        mintResearchHandle: () => {
          mints += 1;
          return Promise.resolve("cfh:v:abcde");
        },
      };
      const output = await researchTool.invoke(context as HarnessToolContext, {
        task: KIT.task,
      });
      expect(output).toMatchObject({ status: "error" });
      expect(mints).toBe(0);
    });

    it("hands a research handle named in followUpTo to the runner as the prior context", async () => {
      const minted = await mintReferentHandle(
        createHarnessHandleTable("follow-up"),
        researchReferent,
      );
      let request: HarnessResearchRequest | undefined;
      const context: Partial<HarnessToolContext> = {
        nextOutputId: () => createToolOutputId("follow-up", "research", 2),
        handleTable: minted.table,
        researchRuns: [],
        runResearch: (value) => {
          request = value;
          return Promise.reject(new Error("stop after capturing the request"));
        },
      };
      await researchTool.invoke(context as HarnessToolContext, {
        task: "Does it also take a map?",
        purpose: "answer",
        followUpTo: minted.token,
      });
      expect(request?.followUpTo).toBe(minted.token);
      expect(request?.priorResearch?.researchRunId).toBe("earlier:research:1");
    });

    it("refuses a followUpTo naming a referent that is not research", async () => {
      const minted = await mintReferentHandle(
        createHarnessHandleTable("follow-up"),
        {
          kind: "document",
          source: "loom_search",
          labelSource: "query",
          label: {},
          value: { title: "A row" },
        },
      );
      let invoked = false;
      const context: Partial<HarnessToolContext> = {
        nextOutputId: () => createToolOutputId("follow-up", "research", 3),
        handleTable: minted.table,
        researchRuns: [],
        runResearch: () => {
          invoked = true;
          return Promise.reject(new Error("unexpected research invocation"));
        },
      };
      const output = await researchTool.invoke(context as HarnessToolContext, {
        task: "Clarify the row",
        followUpTo: minted.token,
      });
      expect(invoked).toBe(false);
      expect(output).toMatchObject({
        status: "error",
        message: "followUpTo must name a research handle this run holds",
      });
    });

    it("names the granted tokens in the inventory it hands to research", async () => {
      const registry = await mintAddressHandle(
        createHarnessHandleTable("granted"),
        `/of:fid1:${"B".repeat(43)}/pieceRegistry`,
      );
      const mail = await mintAddressHandle(
        registry.table,
        `/of:fid1:${"C".repeat(43)}`,
      );
      const other = await mintAddressHandle(
        mail.table,
        `/of:fid1:${"D".repeat(43)}`,
      );
      let request: HarnessResearchRequest | undefined;
      const context: Partial<HarnessToolContext> = {
        nextOutputId: () => createToolOutputId("granted", "research", 1),
        handleTable: other.table,
        wellKnownGrants: [
          {
            name: "piece-registry",
            token: registry.token,
            ref: `/of:fid1:${"B".repeat(43)}/pieceRegistry`,
          },
          {
            name: "email",
            token: mail.token,
            ref: `/of:fid1:${"C".repeat(43)}`,
            source: {
              connection: "gmail-work",
              piece: "cf-gmail-messages--gmail-work",
            },
          },
        ],
        runResearch: (value) => {
          request = value;
          return Promise.reject(new Error("stop after capturing the request"));
        },
      };
      await researchTool.invoke(context as HarnessToolContext, {
        task: "Summarize this week's mail",
      });
      expect(request?.handleTokens).toEqual([
        registry.token,
        mail.token,
        other.token,
      ]);
      expect(request?.handleNames).toEqual({
        [registry.token]: "piece-registry",
        [mail.token]: "gmail-work (email)",
      });
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
        message: "followUpTo must name a research handle this run holds",
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

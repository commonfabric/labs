/**
 * The `research` tool: bounded Common Fabric documentation, skill, published
 * pattern, source, dependency, and handle-contract research performed by a
 * cheap private model loop on the trusted host.
 */

import type { JSONSchema } from "@commonfabric/api";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import {
  RESEARCH_CFC_SCHEMA,
  RESEARCH_KIT_SCHEMA,
} from "../contracts/research-schema.ts";

import {
  HARNESS_RESEARCH_HANDLE_TYPE,
  HARNESS_RESEARCH_RUN_TYPE,
  type HarnessResearchCfcProjection,
  type HarnessResearchHandleValue,
  type HarnessResearchPurpose,
  type HarnessResearchResult,
  type HarnessResearchRunSummary,
  isHarnessResearchHandleValue,
} from "../contracts/research.ts";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import { errorMessage } from "../error-message.ts";
import { resolveReferentToken } from "../handle-table.ts";
import {
  createHarnessResearchCfcProjection,
  HarnessResearchError,
  type HarnessResearchRecord,
  type HarnessResearchReply,
} from "../research/runner.ts";
import { wellKnownGrantLabel } from "../well-known-grants.ts";
import { describeHandleForResearch } from "./describe-handle.ts";
import type { HarnessToolDefinition } from "./types.ts";

/** Whole task or focused follow-up the private loop investigates. */
export interface ResearchToolInput {
  /** Common Fabric task, question, or implementation uncertainty. */
  task: string;

  /** Orient to the user goal or investigate a follow-up question. */
  purpose?: HarnessResearchPurpose;

  /** The research handle of earlier admitted research to build on. */
  followUpTo?: string;
}

/** Successful bounded research, including the artifact-only derivation. */
export interface ResearchToolSuccessOutput {
  /** Stable id for the persisted tool output. */
  outputId: string;

  /** Success means the loop returned a kit; the kit may still be incomplete. */
  status: "ok";

  /** Host-admitted implementation kit given to the caller. */
  kit: HarnessResearchResult;

  /**
   * The handle minted for these findings, absent in a run that keeps no
   * handle table. Name it in a delegation to hand the findings to the child,
   * or in `followUpTo` to build on them.
   */
  researchHandle?: string;

  /** How the caller must treat the kit's admission status. */
  guidance: string;

  /** Known source labels and explicit CFC metadata gaps for this result. */
  cfc: HarnessResearchCfcProjection;

  /**
   * Full private transcript and exact read contents. The prompt loop strips
   * this field before the outer model sees the tool result.
   */
  researchRecord: HarnessResearchRecord;
}

/** Recoverable failure the caller can react to in its next turn. */
export interface ResearchToolErrorOutput {
  /** Stable id for the persisted tool output. */
  outputId: string;

  /** Error discriminator. */
  status: "error";

  /** Stable, source-free explanation of what prevented a kit. */
  message: string;

  /** Known source labels and explicit CFC metadata gaps before failure. */
  cfc: HarnessResearchCfcProjection;

  /** Exact failure text retained only in the persisted tool artifact. */
  rawCauseMessage?: string;

  /** Partial private trace retained on failures that reached the loop. */
  researchRecord?: HarnessResearchRecord;
}

/** Every result shape of the `research` builtin. */
export type ResearchToolOutput =
  | ResearchToolSuccessOutput
  | ResearchToolErrorOutput;

/** Public model contract of the Common Fabric research capability. */
export const researchToolDescriptor: HarnessToolDescriptor = {
  toolId: "research",
  title: "Research Common Fabric",
  description:
    "Research Common Fabric documentation, skills, indexed pieces, and available data in service of the user goal. Use orient for an initial approach or answer (default) for a question. Both can inspect source and return useful code or invocations. Build on prior findings with followUpTo; ask for what remains unclear instead of commissioning another whole app. Prefer composition of existing pieces and a small reusable addition where needed. Indexed source and the private transcript remain in artifacts. The result names a research handle (a cfh:v: token) holding the findings: name it in a delegate_task goal so a child whose profile carries describe_handle (pattern-author) can read them instead of researching again, or in followUpTo; a child without that tool holds it as an opaque token. This tool does not search the web.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        minLength: 3,
        maxLength: 20_000,
        description:
          "The user task to orient to, or the question to investigate. Include the relevant constraints; let research find the simplest supported approach.",
      },
      purpose: {
        type: "string",
        enum: ["orient", "answer"],
        description:
          "Initial orientation or follow-up question. Both have the same reading tools; examples are optional.",
      },
      followUpTo: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description:
          "A research handle (cfh:v: token) whose findings this call starts from: its still-held bindings count as described, and its sources count as cited where they read back unchanged. Only unresolved facts need new research.",
      },
    },
    required: ["task"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    oneOf: [{
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: { type: "string", enum: ["ok"] },
        kit: RESEARCH_KIT_SCHEMA,
        researchHandle: { type: "string" },
        researchRecord: { type: "object" },
        guidance: { type: "string" },
        cfc: RESEARCH_CFC_SCHEMA,
      },
      required: [
        "outputId",
        "status",
        "kit",
        "guidance",
        "cfc",
        "researchRecord",
      ],
      additionalProperties: false,
    }, {
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: { type: "string", enum: ["error"] },
        message: { type: "string" },
        cfc: RESEARCH_CFC_SCHEMA,
        rawCauseMessage: { type: "string" },
        researchRecord: { type: "object" },
      },
      required: ["outputId", "status", "message", "cfc"],
      additionalProperties: false,
    }],
  } satisfies JSONSchema,
  tags: ["fabric", "docs", "skills", "patterns", "research"],
};

/** What a research handle holds for `summary`: its kit, records and label. */
const researchHandleValue = (
  summary: HarnessResearchRunSummary,
  cfc: HarnessResearchCfcProjection,
): HarnessResearchHandleValue => ({
  type: HARNESS_RESEARCH_HANDLE_TYPE,
  researchRunId: summary.researchRunId,
  kit: structuredClone(summary.kit),
  confirmedPatterns: structuredClone([...summary.confirmedPatterns]),
  describedHandles: structuredClone([...summary.describedHandles]),
  cfc: structuredClone(cfc),
});

/** Stable model-facing explanation for an internal research failure. */
const RESEARCH_FAILURE_MESSAGE =
  "research failed before returning an implementation kit";

/** Caller guidance derived from the host-admitted kit status and selections. */
export const researchKitGuidance = (kit: HarnessResearchResult): string =>
  (kit.status === "incomplete"
    ? "This research is incomplete. Do not present or implement unsupported parts as complete. "
    : "") +
  (kit.purpose === "orient"
    ? "Use this orientation to achieve the user goal with existing data and composable pieces. Patterns were inspected; leads remain unverified. Use supported contracts and examples directly, and ask follow-up questions only where needed. Honor missing items and syntax diagnostics; syntax checks do not establish types or runtime behavior. A candidate's input requirements do not establish requirements for the entire task."
    : kit.purpose === "answer"
    ? "Use the supported answer and optional example within the user goal. Honor missing items and syntax diagnostics; syntax checks do not establish types or runtime behavior. Ask another question only when it would resolve something still unclear."
    : kit.status === "complete"
    ? "This kit passed host admission. Preserve its cited contracts and still run the listed verification."
    : kit.example?.kind === "pattern-source" &&
        kit.example.syntax?.status === "invalid"
    ? "This kit retains its cited evidence and complete source, but the source has the exact TypeScript syntax errors listed under kit.example.syntax.diagnostics. Correct those errors locally without repeating research, then resolve any other item under kit.missing before presenting or implementing the kit as complete. Syntax acceptance alone will not establish its imports, types, compilation, or runtime behavior."
    : "Correct local recipe errors directly; use focused research for missing evidence and report any unresolved limitation.");

/** Narrows a raw tool result to a successful research response. */
export const isResearchToolSuccessOutput = (
  output: unknown,
): output is ResearchToolSuccessOutput => {
  if (!isObjectNotArray(output)) {
    return false;
  }
  const record = output as Record<string, unknown>;
  return record.status === "ok" && typeof record.outputId === "string" &&
    isObjectOrArray(record.kit) &&
    typeof record.guidance === "string" &&
    isObjectOrArray(record.cfc) &&
    isObjectOrArray(record.researchRecord);
};

/** Registered implementation of the `research` builtin. */
export const researchTool: HarnessToolDefinition<
  ResearchToolInput,
  ResearchToolOutput
> = {
  descriptor: researchToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("research");
    const initialCfc = createHarnessResearchCfcProjection([
      context.researchTaskCfcLabel,
    ]);
    const errorOutput = (message: string): ResearchToolErrorOutput => ({
      outputId,
      status: "error",
      message,
      cfc: initialCfc,
    });
    if (context.runResearch === undefined) {
      return errorOutput("research requires the host research runner");
    }
    // A follow-up names a research handle this run holds; a token this table
    // does not hold, or holds as something other than research, is refused.
    const priorReferent = input.followUpTo === undefined ||
        context.handleTable === undefined
      ? undefined
      : resolveReferentToken(context.handleTable, input.followUpTo);
    const priorResearch = priorReferent?.kind === "research" &&
        isHarnessResearchHandleValue(priorReferent.value)
      ? priorReferent.value
      : undefined;
    if (input.followUpTo !== undefined && priorResearch === undefined) {
      return errorOutput(
        "followUpTo must name a research handle this run holds",
      );
    }
    // Only the research itself is a research failure. Retaining the kit and
    // minting its handle come after, outside this catch, so a fault there
    // surfaces as the fault it is rather than as a kit that was never found.
    let reply: HarnessResearchReply;
    try {
      const corpus = context.getDocsCorpus === undefined
        ? undefined
        : await context.getDocsCorpus();
      const generalTokens = (context.handleTable?.entries ?? [])
        .filter((entry) => entry.capability === undefined)
        .map((entry) => entry.token);
      const handleNames = Object.fromEntries(
        (context.wellKnownGrants ?? [])
          .filter((grant) => generalTokens.includes(grant.token))
          .map((grant) => [grant.token, wellKnownGrantLabel(grant)]),
      );
      reply = await context.runResearch({
        task: input.task,
        ...(context.researchGoal === undefined
          ? {}
          : { goal: context.researchGoal }),
        purpose: input.purpose ?? "answer",
        ...(input.followUpTo === undefined
          ? {}
          : { followUpTo: input.followUpTo }),
        researchRunId: outputId,
        ...(corpus !== undefined ? { corpus } : {}),
        ...(context.getPatternIndexClient !== undefined
          ? { getPatternIndex: context.getPatternIndexClient }
          : {}),
        handleTokens: generalTokens,
        ...(Object.keys(handleNames).length > 0 ? { handleNames } : {}),
        inputCells: context.inputCells ?? [],
        describeHandle: async (token) =>
          await describeHandleForResearch(context, { token }),
        ...(context.researchTaskCfcLabel !== undefined
          ? { taskCfcLabel: context.researchTaskCfcLabel }
          : {}),
        ...(priorResearch !== undefined ? { priorResearch } : {}),
        attachedPatterns: (context.patternRefs ?? []).map((ref) => ref.record),
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
      });
    } catch (error) {
      await context.recordResearchFailure?.();
      return {
        ...errorOutput(RESEARCH_FAILURE_MESSAGE),
        rawCauseMessage: errorMessage(error),
        ...(error instanceof HarnessResearchError
          ? { cfc: error.record.cfc, researchRecord: error.record }
          : {}),
      };
    }
    const summary: HarnessResearchRunSummary = {
      type: HARNESS_RESEARCH_RUN_TYPE,
      researchRunId: outputId,
      outputId,
      kit: structuredClone(reply.kit),
      confirmedPatterns: reply.record.confirmedPatterns.map((record) =>
        structuredClone(record)
      ),
      describedHandles: reply.record.describedHandles.map((record) =>
        structuredClone(record)
      ),
      cfc: structuredClone(reply.record.cfc),
      completedAt: context.now(),
    };
    await context.recordResearchRun?.(summary);
    // Minted under the kit's own label, so a reader of the handle observes
    // exactly what a reader of this result observes. Readable by a child
    // whose profile carries describe_handle; another holds it opaque.
    const researchHandle = context.mintResearchHandle === undefined
      ? undefined
      : await context.mintResearchHandle(
        researchHandleValue(summary, reply.record.cfc),
        structuredClone(reply.record.cfc.outputLabel),
      );
    return {
      outputId,
      status: "ok",
      kit: reply.kit,
      ...(researchHandle !== undefined ? { researchHandle } : {}),
      guidance: researchKitGuidance(reply.kit),
      cfc: reply.record.cfc,
      researchRecord: reply.record,
    };
  },
};

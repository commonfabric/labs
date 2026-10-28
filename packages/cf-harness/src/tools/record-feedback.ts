import type { PatternIndexClient } from "@commonfabric/pattern-index/client";
import {
  feedbackEventType,
  type PatternFeedbackVerdict,
  recordPatternFeedback,
} from "@commonfabric/pattern-index/feedback";
import type { JSONSchema } from "@commonfabric/api";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface RecordFeedbackToolInput {
  patternId: string;
  verdict: PatternFeedbackVerdict;

  /** A sentence on what was good or wrong, kept by the index with the vote. */
  note?: string;
}

export interface RecordFeedbackToolSuccessOutput {
  outputId: string;
  status: "ok";
  patternId: string;
  verdict: PatternFeedbackVerdict;
}

export interface RecordFeedbackToolErrorOutput {
  outputId: string;
  status: "error";
  message: string;
}

export type RecordFeedbackToolOutput =
  | RecordFeedbackToolSuccessOutput
  | RecordFeedbackToolErrorOutput;

export const recordFeedbackToolDescriptor: HarnessToolDescriptor = {
  toolId: "record_feedback",
  title: "Record Feedback",
  description:
    "Tell the pattern index what a pattern's result was worth, when the person says it did or did not do what they wanted. The index ranks on these votes.",
  effectClass: "side-effect",
  inputSchema: {
    type: "object",
    properties: {
      patternId: {
        type: "string",
        description:
          "As search_patterns reported it or you passed it to run_pattern.",
      },
      verdict: {
        type: "string",
        enum: ["up", "down"],
        description:
          "up when the pattern did the job, down when it did not; judge the pattern, not the request.",
      },
      note: {
        type: "string",
        description: "One sentence on what was good or wrong.",
      },
    },
    required: ["patternId", "verdict"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    oneOf: [{
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: { type: "string", enum: ["ok"] },
        patternId: { type: "string" },
        verdict: { type: "string", enum: ["up", "down"] },
      },
      required: ["outputId", "status", "patternId", "verdict"],
      additionalProperties: false,
    }, {
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: { type: "string", enum: ["error"] },
        message: { type: "string" },
      },
      required: ["outputId", "status", "message"],
      additionalProperties: false,
    }],
  } satisfies JSONSchema,
  tags: ["fabric", "pattern", "feedback"],
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const recordFeedbackTool: HarnessToolDefinition<
  RecordFeedbackToolInput,
  RecordFeedbackToolOutput
> = {
  descriptor: recordFeedbackToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("record_feedback");
    const errorOutput = (message: string): RecordFeedbackToolErrorOutput => ({
      outputId,
      status: "error",
      message,
    });
    if (context.getPatternIndexClient === undefined) {
      return errorOutput(
        "record_feedback requires a pattern index; configure --pattern-index-url",
      );
    }
    const eventType = feedbackEventType(input.verdict);
    if (eventType === undefined) {
      return errorOutput('record_feedback verdict must be "up" or "down"');
    }
    if (typeof input.patternId !== "string" || input.patternId === "") {
      return errorOutput("record_feedback requires a patternId");
    }
    let client: PatternIndexClient;
    try {
      client = await context.getPatternIndexClient();
    } catch (error) {
      return errorOutput(`pattern index unavailable: ${errorMessage(error)}`);
    }
    try {
      const recorded = await recordPatternFeedback(client, {
        patternId: input.patternId,
        eventType,
        ...(input.note !== undefined ? { note: input.note } : {}),
      });
      if (!recorded.ok) {
        return errorOutput(recorded.message);
      }
    } catch (error) {
      return errorOutput(errorMessage(error));
    }
    return {
      outputId,
      status: "ok",
      patternId: input.patternId,
      verdict: input.verdict,
    };
  },
};

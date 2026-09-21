import type { JSONSchema } from "@commonfabric/api";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type {
  PatternIndexClient,
  PatternIndexEventType,
  PatternIndexRecordEventRequest,
} from "../pattern-index/client.ts";
import type { HarnessToolDefinition } from "./types.ts";

/** What the person the run is for made of a pattern's result. */
export type RecordFeedbackVerdict = "up" | "down";

export interface RecordFeedbackToolInput {
  patternId: string;
  verdict: RecordFeedbackVerdict;

  /** A sentence on what was good or wrong, kept by the index with the vote. */
  note?: string;
}

export interface RecordFeedbackToolSuccessOutput {
  outputId: string;
  status: "ok";
  patternId: string;
  verdict: RecordFeedbackVerdict;
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
    "Tell the pattern index what a pattern's result was worth. Call it when the person you are working for says a pattern did or did not do what they wanted — the index ranks on these votes, so a pattern that keeps disappointing stops being offered first.",
  effectClass: "side-effect",
  inputSchema: {
    type: "object",
    properties: {
      patternId: {
        type: "string",
        description:
          "Id of the pattern being judged, as search_patterns reported it or as you passed it to run_pattern.",
      },
      verdict: {
        type: "string",
        enum: ["up", "down"],
        description:
          "up when the pattern did the job, down when it did not. Judge the pattern, not the request that led to it.",
      },
      note: {
        type: "string",
        description:
          "One sentence on what was good or wrong, for whoever reads the index later. Optional.",
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

/** The index event each verdict is recorded as. */
const FEEDBACK_EVENT_TYPES: Record<
  RecordFeedbackVerdict,
  PatternIndexEventType
> = {
  up: "thumbs_up",
  down: "thumbs_down",
};

/**
 * The index event a verdict records as, or `undefined` for a value naming no
 * verdict. A verdict is the whole of what feedback records, so one the index
 * has no event for is refused rather than guessed at — and every surface that
 * takes a verdict asks this rather than listing the words again.
 */
export const feedbackEventType = (
  verdict: unknown,
): PatternIndexEventType | undefined =>
  // `hasOwn` first: a plain object literal inherits `constructor` and the
  // rest of `Object.prototype`, so an unchecked lookup answers a function for
  // words that are not verdicts.
  typeof verdict === "string" && Object.hasOwn(FEEDBACK_EVENT_TYPES, verdict)
    ? FEEDBACK_EVENT_TYPES[verdict as RecordFeedbackVerdict]
    : undefined;

/** What an index that answered made of the event it was sent. */
export type RecordPatternFeedbackResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * Records one verdict against the pattern index and says what became of it.
 *
 * Awaited, unlike the usage events a run reports on its own: recording is
 * what the caller called for, so whether it landed is the result — including
 * a 2xx answer that says the event was not taken, which is the `ok: false`
 * case here.
 *
 * @throws PatternIndexError when the index faulted the call, and whatever the
 * transport raised when it could not be reached at all. Those are failures of
 * the call rather than answers to it, and each caller phrases its own message
 * from the type, so they are not flattened to a string here.
 */
export const recordPatternFeedback = async (
  client: PatternIndexClient,
  request: Omit<PatternIndexRecordEventRequest, "did">,
): Promise<RecordPatternFeedbackResult> => {
  const answer = await client.recordEvent(request);
  return answer.ok === true ? { ok: true } : {
    ok: false,
    message:
      `the pattern index answered but did not record the ${request.eventType} event`,
  };
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

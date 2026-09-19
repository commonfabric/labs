/**
 * Hands the run's structured result to the host.
 *
 * A run configured with a structured-result schema ends on a JSON file the
 * harness validates. A model holding a sandbox write tool can write that file
 * itself; a run whose prompt is not a direct command holds none under the
 * enforcing modes. This tool is the host-side way to the same file: it takes
 * the value as its input, validates it against the configured schema, and the
 * host writes it where the file-based path would have left it, so everything
 * downstream reads one place.
 *
 * A handle token in the value stays the token the model wrote. The token is
 * what a result writer resolves; the prompt loop exempts this tool's input
 * from the swap that turns tokens into addresses.
 */

import { errorMessage } from "../error-message.ts";
import { validateStructuredResultValue } from "../structured-result.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface SubmitResultInput {
  /** The structured result, as the configured schema describes it. */
  result: unknown;
}

/**
 * The submission's outcome. `invalid_result` is a value the schema refused,
 * which the model corrects and submits again; `not_configured` is a call made
 * outside a run that configured a schema.
 */
export type SubmitResultOutput =
  | { outputId: string; status: "ok"; replaced: boolean }
  | {
    outputId: string;
    status: "error";
    code: "invalid_result" | "not_configured";
    message: string;
  };

export const submitResultTool: HarnessToolDefinition<
  SubmitResultInput,
  SubmitResultOutput
> = {
  descriptor: {
    toolId: "submit_result",
    title: "Submit Result",
    description:
      "Submit this run's structured result. Pass the whole result as `result`; it is validated against the schema this run was configured with. A refused submission returns `invalid_result` with the reason: correct the value and submit again. A later valid submission replaces an earlier one. Write a handle token where the result refers to something you hold a handle for; do not write out an address. Submit before your final answer.",
    // The call changes nothing outside the run's own record: it is how the
    // run returns, as `finish_task` is how it stops.
    effectClass: "read",
    inputSchema: {
      type: "object",
      properties: { result: {} },
      required: ["result"],
      additionalProperties: false,
    },
    tags: ["task", "result"],
  },
  async invoke(context, input) {
    const outputId = context.nextOutputId("submit_result");
    const target = context.structuredResult;
    if (target === undefined) {
      return {
        outputId,
        status: "error",
        code: "not_configured",
        message: "this run takes no structured result",
      };
    }
    try {
      validateStructuredResultValue({
        schema: target.schema,
        value: input.result,
      });
    } catch (error) {
      return {
        outputId,
        status: "error",
        code: "invalid_result",
        message: `the result does not satisfy the schema: ${
          errorMessage(error)
        }`,
      };
    }
    const { replaced } = await target.record(input.result);
    return { outputId, status: "ok", replaced };
  },
};

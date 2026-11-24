/** Publishes a milestone through the current run's host-owned return channel. */

import type { HarnessToolDefinition } from "./types.ts";

/** A short message intended for the person awaiting the result. */
export interface ReportProgressInput {
  /** User-facing milestone text. */
  message: string;
}

/** Whether the host accepted the milestone. */
export type ReportProgressOutput = {
  outputId: string;
  status: "ok" | "error";
};

/** The opt-in milestone return tool; its destination is fixed by the host. */
export const reportProgressTool: HarnessToolDefinition<
  ReportProgressInput,
  ReportProgressOutput
> = {
  descriptor: {
    toolId: "report_progress",
    title: "Report Progress",
    description:
      "Report a short user-facing progress message at meaningful milestones while working. Describe completed work or the next step. Reporting is optional for short tasks. This continues the run; submit the final answer separately.",
    // Like a structured result, this returns through a host-owned channel.
    effectClass: "read",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", minLength: 1, maxLength: 2000 },
      },
      required: ["message"],
      additionalProperties: false,
    },
    tags: ["task", "progress"],
  },
  async invoke(context, input) {
    const outputId = context.nextOutputId("report_progress");
    if (
      context.reportProgress === undefined ||
      typeof input.message !== "string" ||
      input.message.trim().length === 0 || [...input.message].length > 2000
    ) {
      return { outputId, status: "error" };
    }
    const published = await context.reportProgress(input.message);
    return { outputId, status: published === false ? "error" : "ok" };
  },
};

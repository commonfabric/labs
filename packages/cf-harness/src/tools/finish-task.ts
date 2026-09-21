/**
 * Ends a parent task with a question or an explanation of what prevents it
 * from proceeding. The prompt loop commits the disposition after this call's
 * ordinary policy, artifact, and transcript work completes.
 */

import type { HarnessTaskOutcome } from "../contracts/task-outcome.ts";
import type { HarnessToolDefinition } from "./types.ts";

/** The parent-authored sentence the user reads when work cannot proceed. */
export interface FinishTaskInput {
  /** Whether a user answer can unblock the task or the agent is stopping. */
  outcome: "question" | "gave-up";

  /** The question itself or the concrete reason the task cannot proceed. */
  message: string;
}

/** The admitted disposition, or a recoverable malformed-call diagnostic. */
export type FinishTaskOutput =
  | { outputId: string; status: "ok"; taskOutcome: HarnessTaskOutcome }
  | { outputId: string; status: "error"; message: string };

/** Parent-only terminal response through the ordinary tool policy boundary. */
export const finishTaskTool: HarnessToolDefinition<
  FinishTaskInput,
  FinishTaskOutput
> = {
  descriptor: {
    toolId: "finish_task",
    title: "Finish Task",
    description:
      "End this turn now with a question the user can answer, or a concrete reason you cannot proceed. Call this tool alone. Use question when one missing input or choice can unblock the goal; use gave-up when the available tools, permissions, or evidence cannot complete it. The user can reply in the same session. For a completed task, return your normal final answer. Ask only for the blocking input in the user's terms, naming the thing they recognize and what to do: for example, ask them to connect or attach their payroll mailbox. The user-facing message must not name handles, tokens, cells, or SQLite. Do not add unrelated choices or constraints. For an unspecified piece, ask the user to attach or name it without reading the registry. Before asking the user to connect or attach a named data source, inspect current grants, relevant describe_handle metadata or retained descriptions, and any applicable bounded discovery route over the granted scope: found requires released evidence, absent is limited to the granted scope you actually checked, and unavailable, refused, or unsettled reads remain unknown. An empty query result or outputConcerns is not proof that the source does not exist. Check that the available capabilities can perform the action before asking for details: when sending is unavailable, say so and offer a draft rather than asking for an address as though that enables sending. Never ask for a nonexistent permission to release results. Do not repeat authoring or delegation to rediscover the same missing input. Include only information already released to you, not data behind opaque handles.",
    effectClass: "read",
    inputSchema: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ["question", "gave-up"] },
        message: { type: "string", minLength: 1 },
      },
      required: ["outcome", "message"],
      additionalProperties: false,
    },
    tags: ["task", "conversation"],
  },
  // The shared tool contract is asynchronous, including host-only reports.
  // deno-lint-ignore require-await
  async invoke(context, input) {
    const outputId = context.nextOutputId("finish_task");
    if (
      (input.outcome !== "question" && input.outcome !== "gave-up") ||
      typeof input.message !== "string" || input.message.trim().length === 0
    ) {
      return {
        outputId,
        status: "error",
        message:
          "finish_task requires outcome question or gave-up and a nonempty message.",
      };
    }
    return {
      outputId,
      status: "ok",
      taskOutcome: input.outcome === "question"
        ? { outcome: "question", question: { text: input.message } }
        : { outcome: "gave-up", reason: input.message },
    };
  },
};

/**
 * Ends a parent task with an answer, a question, or an explanation of what
 * prevents it from proceeding. A completed ending may also name actions for
 * the person's client to perform. The prompt loop commits the disposition
 * after this call's ordinary policy, artifact, and transcript work completes.
 */

import {
  HARNESS_CLIENT_ACTION_LIMIT,
  HARNESS_CLIENT_COMMAND_MAX_LENGTH,
  readHarnessClientActions,
} from "../contracts/client-action.ts";
import type { HarnessTaskOutcome } from "../contracts/task-outcome.ts";
import type { HarnessToolDefinition } from "./types.ts";

/** The parent-authored ending the user reads. */
export interface FinishTaskInput {
  /**
   * Whether the task is done, a user answer can unblock it, or the agent is
   * stopping.
   */
  outcome: "completed" | "question" | "gave-up";

  /** The answer, the question itself, or why the task cannot proceed. */
  message: string;

  /** Client actions for a completed task; refused with any other outcome. */
  actions?: unknown[];
}

/** The admitted disposition, or a recoverable malformed-call diagnostic. */
export type FinishTaskOutput =
  | { outputId: string; status: "ok"; taskOutcome: HarnessTaskOutcome }
  | { outputId: string; status: "error"; message: string };

/** The shape diagnostic every malformed call receives. */
const MALFORMED_CALL =
  "finish_task requires outcome completed, question, or gave-up and a nonempty message.";

/** The diagnostic for actions the client could not perform. */
const MALFORMED_ACTIONS =
  `finish_task actions are allowed only with outcome completed, at most ${HARNESS_CLIENT_ACTION_LIMIT}, each one of: open_loom with a loomId like loom-0123456789abcdef; command with a line starting with "/" of at most ${HARNESS_CLIENT_COMMAND_MAX_LENGTH} characters; open_url with an http or https url.`;

/** Parent-only terminal response through the ordinary tool policy boundary. */
export const finishTaskTool: HarnessToolDefinition<
  FinishTaskInput,
  FinishTaskOutput
> = {
  descriptor: {
    toolId: "finish_task",
    title: "Finish Task",
    description:
      "End this turn now with an answer, a question the user can answer, or a concrete reason you cannot proceed. Call this tool alone. Use completed when the task is done: message is what the person reads, written for them. When the person asked for words (a fact, an explanation, a short answer), completed with the answer is the whole ending; do not build a pattern to hold it. When you built or changed something they should see, leave its piece as the host completion contract says, then finish with a short completed message. Add actions, only with completed, when the person's client should open or run something: open_loom with the loomId of a loom you composed, command with a slash-command line for their client, open_url with an http or https address. Hand a loom or page back through an action, never as a link or path in message. Use question when one missing input or choice can unblock the goal; use gave-up when the available tools, permissions, or evidence cannot complete it. The user can reply in the same session. Honor any required structured-result submission before ending the task. Ask only for the blocking input in the user's terms, naming the thing they recognize and what to do: for example, ask them to connect or attach their payroll mailbox. The user-facing message must not name handles, tokens, cells, or SQLite. Do not add unrelated choices or constraints. For an unspecified piece, ask the user to attach or name it without reading the registry. Before asking the user to connect or attach a named data source, inspect current grants, relevant describe_handle metadata or retained descriptions, and any applicable bounded discovery route over the granted scope: found requires released evidence, absent is limited to the granted scope you actually checked, and unavailable, refused, or unsettled reads remain unknown. An empty query result or outputConcerns is not proof that the source does not exist. Check that the available capabilities can perform the action before asking for details: when sending is unavailable, say so and offer a draft rather than asking for an address as though that enables sending. Never ask for a nonexistent permission to release results. Do not repeat authoring or delegation to rediscover the same missing input. Include only information already released to you, not data behind opaque handles.",
    effectClass: "read",
    inputSchema: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: ["completed", "question", "gave-up"],
        },
        message: { type: "string", minLength: 1 },
        actions: {
          type: "array",
          maxItems: HARNESS_CLIENT_ACTION_LIMIT,
          description:
            "Optional, completed only: what the person's client opens or runs, in order.",
          items: {
            anyOf: [
              {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["open_loom"] },
                  loomId: { type: "string", pattern: "^loom-[a-f0-9]{16}$" },
                },
                required: ["kind", "loomId"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["command"] },
                  line: {
                    type: "string",
                    pattern: "^/",
                    maxLength: HARNESS_CLIENT_COMMAND_MAX_LENGTH,
                  },
                },
                required: ["kind", "line"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["open_url"] },
                  url: { type: "string", pattern: "^https?://" },
                },
                required: ["kind", "url"],
                additionalProperties: false,
              },
            ],
          },
        },
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
      (input.outcome !== "completed" && input.outcome !== "question" &&
        input.outcome !== "gave-up") ||
      typeof input.message !== "string" || input.message.trim().length === 0
    ) {
      return { outputId, status: "error", message: MALFORMED_CALL };
    }
    if (input.actions !== undefined) {
      const actions = input.outcome === "completed"
        ? readHarnessClientActions(input.actions)
        : undefined;
      if (actions === undefined) {
        return { outputId, status: "error", message: MALFORMED_ACTIONS };
      }
      return {
        outputId,
        status: "ok",
        taskOutcome: {
          outcome: "completed",
          answer: input.message,
          ...(actions.length > 0 ? { actions } : {}),
        },
      };
    }
    return {
      outputId,
      status: "ok",
      taskOutcome: input.outcome === "completed"
        ? { outcome: "completed", answer: input.message }
        : input.outcome === "question"
        ? { outcome: "question", question: { text: input.message } }
        : { outcome: "gave-up", reason: input.message },
    };
  },
};

/**
 * Asks the person's client to open or run something while the turn is still
 * going, and waits for the person's answer to each. The host owns the
 * waiting (see `HarnessClientActionRequester`); this tool validates the
 * request, hands it over, and reports what the person did.
 *
 * This is the harness's first tool-side wait with its own deadline. Every
 * other tool is bounded by the run's abort signal alone. Here the gate is a
 * person's tap, which can be minutes away or never come, so the host's idle
 * timeout (reset on each settlement) is what keeps a forgotten request from
 * holding the turn open forever.
 */

import {
  HARNESS_CLIENT_ACTION_LIMIT,
  HARNESS_CLIENT_COMMAND_MAX_LENGTH,
  HARNESS_CLIENT_URL_MAX_LENGTH,
  type HarnessClientActionOutcome,
  readHarnessClientActions,
} from "../contracts/client-action.ts";
import type { HarnessToolDefinition } from "./types.ts";

/** The actions the model asks the client to perform, in working order. */
export interface WeaverActionInput {
  actions: unknown[];
}

/** What the person did with each action, or why the call was refused. */
export type WeaverActionOutput =
  | {
    outputId: string;
    status: "ok";
    outcomes: HarnessClientActionOutcome[];
  }
  | { outputId: string; status: "error"; message: string };

const MALFORMED_ACTIONS =
  `weaver_action requires 1 to ${HARNESS_CLIENT_ACTION_LIMIT} actions, each one of: open_loom with a loomId like loom-0123456789abcdef; command with a line starting with "/" of at most ${HARNESS_CLIENT_COMMAND_MAX_LENGTH} characters; open_url with an http or https url of at most ${HARNESS_CLIENT_URL_MAX_LENGTH} characters, every one on a single line.`;

const UNAVAILABLE =
  "weaver_action is unavailable: this session's client did not opt in.";

/** Parent-only, host-opt-in request for the person's client to act. */
export const weaverActionTool: HarnessToolDefinition<
  WeaverActionInput,
  WeaverActionOutput
> = {
  descriptor: {
    toolId: "weaver_action",
    title: "Weaver Action",
    description:
      "Ask the person's client to open or run something now, mid-task, and wait for their answer. Each action is shown to the person, who runs it or declines it; nothing happens until they choose. List the actions in the order the person should work through them. open_loom takes the loomId of a loom you composed, command takes a slash-command line for their client, open_url takes an http or https address. The result lists each action with outcome done, declined, or failed and a short result text; a declined action is the person's choice, so do not repeat it. Use this when the next step of the task depends on what the person did; to hand something over as the last step, put actions on finish_task instead.",
    effectClass: "side-effect",
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          minItems: 1,
          maxItems: HARNESS_CLIENT_ACTION_LIMIT,
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
                  url: {
                    type: "string",
                    pattern: "^https?://",
                    maxLength: HARNESS_CLIENT_URL_MAX_LENGTH,
                  },
                },
                required: ["kind", "url"],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      required: ["actions"],
      additionalProperties: false,
    },
    tags: ["conversation", "client"],
  },
  async invoke(context, input) {
    const outputId = context.nextOutputId("weaver_action");
    const actions = readHarnessClientActions(input.actions);
    // Invalid input emits nothing: validation precedes the host call.
    if (actions === undefined || actions.length === 0) {
      return { outputId, status: "error", message: MALFORMED_ACTIONS };
    }
    if (context.requestClientActions === undefined) {
      return { outputId, status: "error", message: UNAVAILABLE };
    }
    const outcomes = await context.requestClientActions(
      actions,
      context.signal,
    );
    return { outputId, status: "ok", outcomes };
  },
};

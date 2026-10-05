/**
 * Asks the person's Weaver to run a command, list its commands, or open
 * something while the turn is still going, and waits for each answer. The
 * session's client-action coordinator owns the waiting (see
 * `HarnessClientActionRequester`); this tool validates the request, hands it
 * over with the holder an executed command's result body is kept by, and
 * reports what became of each action.
 *
 * This is the harness's one tool-side wait with its own deadline. Every
 * other tool is bounded by the run's abort signal alone. Here the gate can be
 * a person's tap, which can be minutes away or never come, so the
 * coordinator's idle timeout (reset on each settlement) is what keeps a
 * forgotten request from holding the turn open forever.
 */

import type { IFCLabel } from "@commonfabric/runner/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import {
  HARNESS_CLIENT_ACTION_LIMIT,
  HARNESS_CLIENT_URL_MAX_LENGTH,
} from "../contracts/client-action.ts";
import {
  HARNESS_COMMAND_ARGS_MAX_BYTES,
  HARNESS_COMMAND_CATALOG_DETAIL_LIMIT,
  HARNESS_COMMAND_ID_MAX_LENGTH,
  HARNESS_COMMAND_ID_PATTERN,
  harnessCommandJsonBytes,
  isHarnessCommandJsonValue,
} from "../contracts/client-command.ts";
import {
  type HarnessMidTurnClientAction,
  type HarnessMidTurnClientActionOutcome,
  readHarnessMidTurnClientAction,
} from "../client-actions/coordinator.ts";
import type { HarnessCommandResultHolder } from "../client-actions/command-result.ts";
import type { HarnessToolContext, HarnessToolDefinition } from "./types.ts";

/** The actions the model asks the Weaver for, in working order. */
export interface WeaverActionInput {
  actions: unknown[];
}

/** What became of each action, or why the call was refused. */
export type WeaverActionOutput =
  | {
    outputId: string;
    status: "ok";
    outcomes: HarnessMidTurnClientActionOutcome[];
  }
  | { outputId: string; status: "error"; message: string };

const MALFORMED_ACTIONS =
  `weaver_action requires 1 to ${HARNESS_CLIENT_ACTION_LIMIT} actions, each one of: invoke_command with an invocation of a catalog command id, its args object, an optional target {loomId, expectedVersion?}, and the approval its catalog entry names; list_commands with a request whose optional detail names up to ${HARNESS_COMMAND_CATALOG_DETAIL_LIMIT} command ids; open_loom with a loomId like loom-0123456789abcdef; open_url with an http or https url of at most ${HARNESS_CLIENT_URL_MAX_LENGTH} characters on a single line.`;

const OVERSIZED_ARGS =
  `weaver_action refused the call before sending it: an invoke_command's args are larger than ${HARNESS_COMMAND_ARGS_MAX_BYTES} bytes of JSON. Pass a smaller value, or a handle the command reads, instead.`;

const UNAVAILABLE =
  "weaver_action is unavailable: this session's client did not opt in.";

/**
 * How a session uses the Weaver's commands, given to a run whose host opted
 * in to `weaver_action`. It names the common commands, so a simple task
 * invokes one without listing the catalog first.
 *
 * SHORTCUT: the named commands, their approvals and argument shapes are
 * copied from the Weaver's catalog and are not checked against it; a command
 * the Weaver renames comes back refused, and the model can still list. To
 * harden, have the host send the common entries with the session's protocol
 * declaration and render this list from them.
 */
export const WEAVER_COMMAND_GUIDANCE = [
  "Weaver commands: for information the person's application holds (their looms, what a loom contains, its panels and version) or an operation on it (opening, adding, moving, writing), call a Weaver command through weaver_action rather than authoring a pattern.",
  "When you know the command you need, call invoke_command directly as your first call; the common ones are below. Call list_commands only for a command you do not know, or to read one's argument schema in detail.",
  "- looms.list (global, read, approval automatic): list the person's looms, or find one by name; args { query?, limit?, include_archived? }.",
  "- loom.inspect (loom, read, approval automatic): read a loom's manifest (its panels, selection and version); args {}, with target.loomId.",
  "- loom.open (global, mutation, approval person): bring a loom forward on the person's screen; args { loom }.",
  "- loom.add (loom, mutation, approval person): add a reference to the loom and show it; args { ref?, title? }, with target.loomId.",
  "- loom.move (loom, mutation, approval person): move a panel within the loom's order; args { component, before? }, with target.loomId.",
  "- page.write (global, mutation, approval person): replace a page's whole source in the File Cabinet; args { path, content, reason?, version? }.",
  "- create.note (loom, mutation, approval person): make a note page and show it; args { text }, with target.loomId.",
  "Copy the approval the command names. A read on the Weaver's reviewed list answers at once; anything that changes something waits for the person to approve it, and a declined command is their choice, so do not repeat it. An executed command returns its outcome (ok, code, error, outputs, completed, mayHaveLanded) and a handle to its full answer, which stays out of your context: describe_handle says what the handle is and how it is labeled, not what it holds, so act on the outcome and its outputs. A version conflict is an answer, not a broken connection: read the current version and decide again rather than retrying the same write. Use patterns for computation, not for reading what a command already returned.",
].join("\n");

/** Whether an untrusted action is an invocation whose args are too large. */
const hasOversizedArgs = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.kind !== "invoke_command") return false;
  const invocation = record.invocation;
  if (typeof invocation !== "object" || invocation === null) return false;
  const args = (invocation as Record<string, unknown>).args;
  return isHarnessCommandJsonValue(args) &&
    harnessCommandJsonBytes(args) > HARNESS_COMMAND_ARGS_MAX_BYTES;
};

/**
 * The label a command's held result carries: the confidentiality of the tool
 * call's input, which is everything the run's model context has observed,
 * and no integrity.
 *
 * SHORTCUT: what a command's result holds is decided by the store that
 * answered it, not by who asked; this is the same placeholder loom retrieval
 * gives an unlabeled row (`labelForUnlabeledLoomRow`). To harden, carry the
 * label the service answers with on the outcome, and let the handle module's
 * read policy (the plan's checkpoint 2) decide what a model may do under it.
 */
const commandResultLabel = (inputLabel: IFCLabel | undefined): IFCLabel => ({
  confidentiality: [...(inputLabel?.confidentiality ?? [])],
  integrity: [],
});

/** The holder an executed command's body is kept by, when the run keeps one. */
const commandResultHolder = (
  context: HarnessToolContext,
): HarnessCommandResultHolder | undefined => {
  const mint = context.mintReferentHandle?.bind(context);
  if (mint === undefined) return undefined;
  return ({ value, provenance }) =>
    mint({
      source: "weaver_action",
      value: value as FabricValue,
      label: commandResultLabel(context.toolInputCfcLabel),
      labelSource: "command",
      provenance,
    });
};

const COMMAND_ID_SCHEMA = {
  type: "string",
  pattern: HARNESS_COMMAND_ID_PATTERN.source,
  maxLength: HARNESS_COMMAND_ID_MAX_LENGTH,
} as const;

/** Parent-only, host-opt-in request for the person's Weaver to act. */
export const weaverActionTool: HarnessToolDefinition<
  WeaverActionInput,
  WeaverActionOutput
> = {
  descriptor: {
    toolId: "weaver_action",
    title: "Weaver Action",
    description:
      "Ask the person's Weaver to run a command, list the commands it runs, or open something, now, mid-task, and wait for the answer. list_commands returns the Weaver's catalog: each command's id, summary, scope, where it executes, whether it reads or changes something, its approval, and its argument schema; name ids in detail for their full descriptions. invoke_command runs one command with args matching its schema, against target.loomId when it acts on a loom (pass expectedVersion to refuse a stale write), with the approval its catalog entry names. A read the Weaver has reviewed runs at once; anything else waits for the person, who runs or declines it. An executed command returns its outcome — ok, code, error, outputs, completed, mayHaveLanded, which executor answered and its HTTP status — and a handle to its full JSON answer, held for the session and never shown to you (describe_handle names what it is and its label); a version conflict comes back as an executed command with ok false. open_loom takes the loomId of a loom you composed and open_url an http or https address; each is shown to the person, whose outcome is done, declined, or failed with a short result text. A declined action is the person's choice, so do not repeat it. List actions in the order they should run. To hand something over as the last step, put actions on finish_task instead.",
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
                  kind: { type: "string", enum: ["invoke_command"] },
                  invocation: {
                    type: "object",
                    properties: {
                      command: COMMAND_ID_SCHEMA,
                      args: { type: "object" },
                      target: {
                        type: "object",
                        properties: {
                          loomId: {
                            type: "string",
                            pattern: "^loom-[a-f0-9]{16}$",
                          },
                          expectedVersion: { type: "integer", minimum: 0 },
                        },
                        required: ["loomId"],
                        additionalProperties: false,
                      },
                      approval: {
                        type: "string",
                        enum: ["automatic", "person"],
                      },
                    },
                    required: ["command", "args", "approval"],
                    additionalProperties: false,
                  },
                },
                required: ["kind", "invocation"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["list_commands"] },
                  request: {
                    type: "object",
                    properties: {
                      detail: {
                        type: "array",
                        maxItems: HARNESS_COMMAND_CATALOG_DETAIL_LIMIT,
                        items: COMMAND_ID_SCHEMA,
                      },
                    },
                    additionalProperties: false,
                  },
                },
                required: ["kind", "request"],
                additionalProperties: false,
              },
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
    // Invalid input emits nothing: validation precedes the host call, so an
    // oversized request is refused before anything is delivered.
    const raw = Array.isArray(input.actions) ? input.actions : undefined;
    if (raw !== undefined && raw.some(hasOversizedArgs)) {
      return { outputId, status: "error", message: OVERSIZED_ARGS };
    }
    const actions: HarnessMidTurnClientAction[] = [];
    for (const entry of raw ?? []) {
      const action = readHarnessMidTurnClientAction(entry);
      if (action === undefined) break;
      actions.push(action);
    }
    if (
      raw === undefined || raw.length === 0 ||
      raw.length > HARNESS_CLIENT_ACTION_LIMIT ||
      actions.length !== raw.length
    ) {
      return { outputId, status: "error", message: MALFORMED_ACTIONS };
    }
    if (context.requestClientActions === undefined) {
      return { outputId, status: "error", message: UNAVAILABLE };
    }
    const outcomes = await context.requestClientActions(
      actions,
      context.signal,
      commandResultHolder(context),
    );
    return { outputId, status: "ok", outcomes };
  },
};

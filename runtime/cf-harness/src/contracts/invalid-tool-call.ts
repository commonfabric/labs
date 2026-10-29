import { isObjectOrArray } from "@commonfabric/utils/types";
import type { BuiltinToolId } from "./tool-descriptor.ts";

/**
 * Why the loop refused to dispatch a tool call the model wrote.
 *
 * - `unknown-tool`: the call named something no tool in the run answers to.
 * - `unparsable-arguments`: the arguments string was not valid JSON.
 * - `arguments-not-an-object`: the arguments decoded to something other than a
 *   JSON object.
 * - `invalid-argument`: one named argument did not fit the tool's input shape.
 */
export type HarnessInvalidToolCallReason =
  | "unknown-tool"
  | "unparsable-arguments"
  | "arguments-not-an-object"
  | "invalid-argument";

/**
 * The result the model reads when the loop rejected its tool call before
 * dispatch. A malformed call is a typo, not a fault in the run, so the call
 * comes back as an ordinary tool result the next turn can correct — the same
 * shape a denied call comes back as.
 *
 * Every string here is written by the harness. `detail` names the field at
 * fault and the shape expected of it, and never repeats the value it rejected:
 * an argument can carry text an earlier tool read out of the workspace or off
 * the network, and quoting it back would launder that text into the next
 * turn's prompt as harness-authored instruction.
 */
export interface HarnessInvalidToolCall {
  type: "cf-harness.invalid-tool-call";
  reason: HarnessInvalidToolCallReason;

  /** Present when the call named a tool the run offers. */
  toolId?: BuiltinToolId;

  /** The argument at fault, when a single one carries the fault. */
  field?: string;

  /** What a well-formed call puts there. */
  expected: string;

  /** One sentence joining the two above, for a model that reads prose. */
  detail: string;
}

export interface CreateHarnessInvalidToolCallOptions {
  reason: HarnessInvalidToolCallReason;
  expected: string;
  toolId?: BuiltinToolId;
  field?: string;
}

const detailFor = (options: CreateHarnessInvalidToolCallOptions): string => {
  const subject = options.toolId === undefined
    ? "the tool call"
    : `the ${options.toolId} call`;
  switch (options.reason) {
    case "unknown-tool":
      return `${subject} named a tool this run does not offer; expected ${options.expected}`;
    case "unparsable-arguments":
      return `${subject} did not carry valid JSON arguments; expected ${options.expected}`;
    case "arguments-not-an-object":
      return `${subject} arguments did not decode to an object; expected ${options.expected}`;
    case "invalid-argument":
      return `${subject} argument "${
        options.field ?? "unknown"
      }" was not usable; expected ${options.expected}`;
  }
};

export const createHarnessInvalidToolCall = (
  options: CreateHarnessInvalidToolCallOptions,
): HarnessInvalidToolCall => ({
  type: "cf-harness.invalid-tool-call",
  reason: options.reason,
  ...(options.toolId !== undefined ? { toolId: options.toolId } : {}),
  ...(options.field !== undefined ? { field: options.field } : {}),
  expected: options.expected,
  detail: detailFor(options),
});

export const isHarnessInvalidToolCall = (
  value: unknown,
): value is HarnessInvalidToolCall =>
  isObjectOrArray(value) &&
  (value as { type?: unknown }).type === "cf-harness.invalid-tool-call";

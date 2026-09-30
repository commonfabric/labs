/**
 * User-facing disposition of a normally ended run. Execution failures remain
 * run failures; a question or a give-up leaves the conversation reusable.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";

/** The task's result, independent of whether the model loop ran successfully. */
export type HarnessTaskOutcome =
  | { outcome: "completed" }
  | { outcome: "question"; question: { text: string } }
  | { outcome: "gave-up"; reason: string };

/**
 * Reads a serialized outcome across console versions. Absent legacy fields
 * and unfamiliar nonempty outcome words mean completed; malformed known
 * outcomes remain invalid. Writers use the closed HarnessTaskOutcome union.
 */
export const readHarnessTaskOutcome = (
  value: unknown,
): HarnessTaskOutcome | undefined => {
  if (value === undefined) return { outcome: "completed" };
  if (!isObjectNotArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    !Object.hasOwn(record, "outcome") || typeof record.outcome !== "string" ||
    record.outcome.trim() === ""
  ) {
    return undefined;
  }
  switch (record.outcome) {
    case "completed":
      return record.question === undefined && record.reason === undefined
        ? { outcome: "completed" }
        : undefined;
    case "question": {
      const question = record.question;
      if (
        !Object.hasOwn(record, "question") || !isObjectNotArray(question) ||
        !Object.hasOwn(question, "text")
      ) {
        return undefined;
      }
      const text = (question as { text: unknown }).text;
      return typeof text === "string" && text.trim().length > 0 &&
          record.reason === undefined
        ? { outcome: "question", question: { text } }
        : undefined;
    }
    case "gave-up":
      return Object.hasOwn(record, "reason") &&
          typeof record.reason === "string" &&
          record.reason.trim().length > 0 && record.question === undefined
        ? { outcome: "gave-up", reason: record.reason }
        : undefined;
    default:
      return { outcome: "completed" };
  }
};

/** Shared input contract for direct and research-proposed pattern invocations. */

import type { JSONSchema } from "@commonfabric/api";

/** Arguments accepted by the host pattern execution tool. */
export interface RunPatternToolInput {
  sourceText?: string;

  /**
   * What the pattern is for, in one line. Published with the pattern when the
   * run contributes to the index; a run that gives none publishes nothing,
   * since a pattern nobody can read the purpose of is a pattern nobody finds.
   */
  description?: string;

  /** Tags the published pattern is found under. */
  hashtags?: readonly string[];

  /**
   * A pattern published to the index, run in place of inline source. The
   * program is fetched host-side and compiled down the same path; its source
   * never reaches the model, on the success path or on any error path.
   */
  patternId?: string;

  inputs?: Record<string, unknown>;
  resultSchema?: JSONSchema;
}

/** JSON shape accepted by the pattern execution tool. */
export const RUN_PATTERN_INPUT_SCHEMA = {
  type: "object",
  properties: {
    sourceText: {
      type: "string",
      description: "Pattern source (TypeScript/TSX), at most 256 KiB.",
    },
    patternId: {
      type: "string",
      description:
        "A published pattern's id, as search_patterns reports it. Give exactly one of sourceText and patternId.",
    },
    description: {
      type: "string",
      description:
        "One line on what the pattern does; source that runs successfully is queued for the pattern index only when this is filled in.",
    },
    hashtags: {
      type: "array",
      items: { type: "string" },
      description: "Words someone searching for this capability would type.",
    },
    inputs: {
      type: "object",
      additionalProperties: true,
      description:
        "Named arguments: a string that is wholly a handle token or LLM-friendly link passes as a live cell reference, anything else as plain JSON.",
    },
    resultSchema: {
      anyOf: [
        { type: "boolean" },
        { type: "object", additionalProperties: true },
      ],
      description:
        "JSON Schema of the result fields to read back as `value`; without it value is omitted.",
    },
  },
  // Exactly one of `sourceText` and `patternId` is required, which is a
  // condition on the pair rather than on either alone; the tool states it
  // in prose here and enforces it on invocation.
  additionalProperties: false,
} satisfies JSONSchema;

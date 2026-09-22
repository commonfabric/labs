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

  /** One-line reasons for selected research patterns this source does not import. */
  reuseReasons?: Readonly<Record<string, string>>;

  inputs?: Record<string, unknown>;
  resultSchema?: JSONSchema;
}

/** JSON shape accepted by the pattern execution tool. */
export const RUN_PATTERN_INPUT_SCHEMA = {
  type: "object",
  properties: {
    sourceText: {
      type: "string",
      description:
        "Pattern source (TypeScript/TSX). At most 256 KiB. Return a durable result object directly. A whole-result derived wrapper is a known smell, but not a deterministic failure: after the run the harness checks the actual pattern pointer and refuses any piece materialized under a session-only identity.",
    },
    patternId: {
      type: "string",
      description:
        "Id of a pattern published to the index, as search_patterns reports it. Exactly one of sourceText and patternId is given; the published program is fetched and compiled without passing through this conversation.",
    },
    reuseReasons: {
      type: "object",
      additionalProperties: {
        type: "string",
        minLength: 1,
        pattern: "^[^\\r\\n]*\\S[^\\r\\n]*(?![\\s\\S])",
      },
      description:
        "One-line reasons keyed by patternId for selected kit.patterns entries this source does not import. Explain why each omitted pattern does not fit this call, including when this is a separate atom or a reader of an existing result. Required for each omission from retained research, even when its kit is incomplete. Unverified leads do not require a reason. Reasons remain in the tool-call record.",
    },
    description: {
      type: "string",
      description:
        'One line saying what the pattern you are running does, e.g. "Totals an invoice\'s line items and applies a discount". When pattern-index publication is enabled, source you wrote and ran successfully with a non-empty description and a durable content-addressed pattern identity is queued for the index; the tool result does not confirm publication. Fill this in for later evaluation and discovery. No contribution is queued when no index is configured, publication is disabled, the description is empty, or the pattern has no durable identity.',
    },
    hashtags: {
      type: "array",
      items: { type: "string" },
      description:
        'Tags the recorded pattern will be found under if it earns discoverability, e.g. ["invoice", "arithmetic"]. Use the words someone searching for this capability would type.',
    },
    inputs: {
      type: "object",
      additionalProperties: true,
      description:
        'Input values for the pattern. A string value that is a whole-string LLM-friendly link (e.g. "/of:fid1:abc.../path") is passed as a live cell reference; everything else passes through as plain JSON.',
    },
    resultSchema: {
      anyOf: [
        { type: "boolean" },
        { type: "object", additionalProperties: true },
      ],
      description:
        'JSON Schema for the result value. Without it you get resultRef only and no value at all, so pass it whenever you need to read what the pattern computed. A value is returned only for the fields the schema models: an inert one (a number, a boolean, an enum or const string) comes back as itself; anything else is withheld as text and comes back as a reference token addressing that position, which describe_handle can inspect and a later run_pattern can wire by reference. Example: {"type":"object","properties":{"total":{"type":"number"}},"required":["total"]}. The framework\'s own result keys ($NAME, $UI and the other rendering variants) need not be declared. When the space\'s policy does not admit releasing the values to you, value is withheld, valueError says why and which input carried the refused label, and resultRef still names the result: pass it on by reference.',
    },
  },
  // Exactly one of `sourceText` and `patternId` is required, which is a
  // condition on the pair rather than on either alone; the tool states it
  // in prose here and enforces it on invocation.
  additionalProperties: false,
} satisfies JSONSchema;

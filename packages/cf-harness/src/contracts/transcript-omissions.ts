/**
 * Records the model-context reductions applied to durable tool results. The
 * record carries locations only; full values remain in their tool-output
 * artifacts and never enter this file.
 *
 * The runtime annotation lives on a transcript message's object identity and
 * is deliberately absent from its serialized shape. Code that replaces a
 * result-bearing message before persistence must carry the annotation across
 * by passing the original message as `inheritFrom` to the matching annotation
 * helper.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";
import type {
  HarnessToolTranscriptMessage,
  HarnessTranscriptMessage,
  HarnessUserTranscriptMessage,
} from "./transcript.ts";
import type { ToolResultRef } from "./tool-result.ts";

/** Stable artifact discriminator for a transcript omission record. */
export const HARNESS_TRANSCRIPT_OMISSIONS_TYPE =
  "cf-harness.transcript-omissions" as const;

/** Current transcript omission artifact version. */
export const HARNESS_TRANSCRIPT_OMISSIONS_VERSION = 1 as const;

/** The model-boundary omission rules which apply to tool results. */
export const HARNESS_TRANSCRIPT_OMISSION_RULES = [
  "artifact-only",
  "bare-fabric-identifier-scrub",
  "model-context-truncation",
  "observation-denied",
  "superseded-run-pattern-diagnostic-collapse",
] as const;

/** One model-boundary omission rule. */
export type HarnessTranscriptOmissionRule =
  typeof HARNESS_TRANSCRIPT_OMISSION_RULES[number];

/** One position in a full tool-output artifact affected by an omission rule. */
export interface HarnessTranscriptOmissionLocation {
  artifactPath: string;
  jsonPointer: string;
}

/** All positions in one tool result affected by one omission rule. */
export interface HarnessTranscriptOmissionRuleRecord {
  rule: HarnessTranscriptOmissionRule;
  locations: readonly HarnessTranscriptOmissionLocation[];
}

/** Omission rules recorded for one model-facing tool result. */
export interface HarnessToolResultOmissions {
  transcriptIndex: number;
  toolCallId: string;
  toolId: string;
  outputId: string;
  rules: readonly HarnessTranscriptOmissionRuleRecord[];
}

/** Durable join between model-facing transcript results and full artifacts. */
export interface HarnessTranscriptOmissions {
  type: typeof HARNESS_TRANSCRIPT_OMISSIONS_TYPE;
  version: typeof HARNESS_TRANSCRIPT_OMISSIONS_VERSION;
  results: readonly HarnessToolResultOmissions[];
}

const transcriptMessageOmissions = Symbol(
  "cf-harness.transcript-message-omissions",
);

type AnnotatedTranscriptMessage = HarnessTranscriptMessage & {
  [transcriptMessageOmissions]?: readonly HarnessTranscriptOmissionRuleRecord[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  isObjectNotArray(value);

/** Whether `value` is a supported omission rule. */
export const isHarnessTranscriptOmissionRule = (
  value: unknown,
): value is HarnessTranscriptOmissionRule =>
  typeof value === "string" &&
  (HARNESS_TRANSCRIPT_OMISSION_RULES as readonly string[]).includes(value);

/** Whether `value` has the shape of a transcript omission artifact. */
export const isHarnessTranscriptOmissions = (
  value: unknown,
): value is HarnessTranscriptOmissions => {
  if (
    !isRecord(value) || value.type !== HARNESS_TRANSCRIPT_OMISSIONS_TYPE ||
    value.version !== HARNESS_TRANSCRIPT_OMISSIONS_VERSION ||
    !Array.isArray(value.results)
  ) {
    return false;
  }
  return value.results.every((result) =>
    isRecord(result) && Number.isSafeInteger(result.transcriptIndex) &&
    (result.transcriptIndex as number) >= 0 &&
    typeof result.toolCallId === "string" &&
    typeof result.toolId === "string" && typeof result.outputId === "string" &&
    Array.isArray(result.rules) && result.rules.every((rule) =>
      isRecord(rule) && isHarnessTranscriptOmissionRule(rule.rule) &&
      Array.isArray(rule.locations) && rule.locations.every((location) =>
        isRecord(location) && typeof location.artifactPath === "string" &&
        typeof location.jsonPointer === "string"
      )
    )
  );
};

/**
 * Creates a rule record for `resultRef`, or `undefined` when no artifact or
 * affected position exists to join to.
 */
export const createHarnessTranscriptOmissionRuleRecord = (
  rule: HarnessTranscriptOmissionRule,
  resultRef: ToolResultRef,
  jsonPointers: readonly string[],
): HarnessTranscriptOmissionRuleRecord | undefined => {
  if (resultRef.artifactPath === undefined || jsonPointers.length === 0) {
    return undefined;
  }
  return {
    rule,
    locations: [...new Set(jsonPointers)].map((jsonPointer) => ({
      artifactPath: resultRef.artifactPath!,
      jsonPointer,
    })),
  };
};

/**
 * Attaches omission locations to an in-memory transcript message. The symbol is
 * non-enumerable and ignored by JSON serialization, so ordinary object reads,
 * provider requests, and `transcript.json` keep their established shape.
 * The annotation belongs to `message`'s object identity: a spread, clone, or
 * JSON round trip drops it. Code that replaces a result-bearing message before
 * persistence must pass the original message as `inheritFrom`.
 */
const annotateHarnessTranscriptResultOmissions = <
  Message extends HarnessTranscriptMessage,
>(
  message: Message,
  records: readonly HarnessTranscriptOmissionRuleRecord[],
  inheritFrom?: HarnessTranscriptMessage,
): Message => {
  const annotated = message as Message & AnnotatedTranscriptMessage;
  const byRule = new Map<
    HarnessTranscriptOmissionRule,
    HarnessTranscriptOmissionLocation[]
  >();
  for (
    const record of [
      ...(inheritFrom === undefined ? [] : omissionsOf(inheritFrom) ?? []),
      ...(annotated[transcriptMessageOmissions] ?? []),
      ...records,
    ]
  ) {
    const locations = byRule.get(record.rule) ?? [];
    for (const location of record.locations) {
      if (
        !locations.some((held) =>
          held.artifactPath === location.artifactPath &&
          held.jsonPointer === location.jsonPointer
        )
      ) {
        locations.push(location);
      }
    }
    byRule.set(record.rule, locations);
  }
  Object.defineProperty(annotated, transcriptMessageOmissions, {
    value: [...byRule].map(([rule, locations]) => ({ rule, locations })),
    writable: true,
    configurable: true,
  });
  return message;
};

/** Attaches omission locations to an ordinary model-facing tool result. */
export const annotateHarnessToolResultOmissions = (
  message: HarnessToolTranscriptMessage,
  records: readonly HarnessTranscriptOmissionRuleRecord[],
  inheritFrom?: HarnessToolTranscriptMessage,
): HarnessToolTranscriptMessage =>
  annotateHarnessTranscriptResultOmissions(message, records, inheritFrom);

/** Attaches tool-result omissions to a host-supplied user-context message. */
export const annotateHarnessUserResultOmissions = (
  message: HarnessUserTranscriptMessage,
  records: readonly HarnessTranscriptOmissionRuleRecord[],
  inheritFrom?: HarnessTranscriptMessage,
): HarnessUserTranscriptMessage =>
  annotateHarnessTranscriptResultOmissions(message, records, inheritFrom);

const omissionsOf = (
  message: HarnessTranscriptMessage,
): readonly HarnessTranscriptOmissionRuleRecord[] | undefined =>
  (message as AnnotatedTranscriptMessage)[transcriptMessageOmissions];

/** Returns the tool-output identity carried by an ordinary or host result. */
export const resultProvenanceOf = (
  message: HarnessTranscriptMessage,
): { toolCallId: string; toolId: string; outputId: string } | undefined => {
  if (message.role === "tool" && message.resultRef !== undefined) {
    return {
      toolCallId: message.toolCallId,
      toolId: message.toolName,
      outputId: String(message.resultRef.outputId),
    };
  }
  if (message.role !== "user") return undefined;
  const provenance: unknown = message.toolResultProvenance;
  if (
    !isRecord(provenance) ||
    provenance.type !== "cf-harness.tool-result-provenance" ||
    typeof provenance.toolCallId !== "string" ||
    typeof provenance.toolId !== "string" ||
    typeof provenance.outputId !== "string"
  ) {
    return undefined;
  }
  return {
    toolCallId: provenance.toolCallId,
    toolId: provenance.toolId,
    outputId: provenance.outputId,
  };
};

const mergeRuleRecords = (
  previous: readonly HarnessTranscriptOmissionRuleRecord[],
  current: readonly HarnessTranscriptOmissionRuleRecord[],
): HarnessTranscriptOmissionRuleRecord[] => {
  const byRule = new Map<
    HarnessTranscriptOmissionRule,
    HarnessTranscriptOmissionLocation[]
  >();
  for (const record of [...previous, ...current]) {
    const locations = byRule.get(record.rule) ?? [];
    for (const location of record.locations) {
      if (
        !locations.some((held) =>
          held.artifactPath === location.artifactPath &&
          held.jsonPointer === location.jsonPointer
        )
      ) {
        locations.push(location);
      }
    }
    byRule.set(record.rule, locations);
  }
  return HARNESS_TRANSCRIPT_OMISSION_RULES.flatMap((rule) => {
    const locations = byRule.get(rule);
    return locations === undefined ? [] : [{ rule, locations }];
  });
};

/**
 * Restores host-only annotations after validating unique, exact result joins.
 * Unrecorded legacy results retain unknown omission status.
 */
export const restoreHarnessTranscriptOmissions = (
  transcript: readonly HarnessTranscriptMessage[],
  omissions: HarnessTranscriptOmissions,
): void => {
  const indices = new Set<number>();
  const outputIds = new Set<string>();
  for (const result of omissions.results) {
    if (indices.has(result.transcriptIndex) || outputIds.has(result.outputId)) {
      throw new Error("Stored transcript omissions repeat a result");
    }
    indices.add(result.transcriptIndex);
    outputIds.add(result.outputId);
    const message = transcript[result.transcriptIndex];
    const identity = message === undefined
      ? undefined
      : resultProvenanceOf(message);
    if (
      identity === undefined || identity.outputId !== result.outputId ||
      identity.toolId !== result.toolId ||
      identity.toolCallId !== result.toolCallId
    ) {
      throw new Error("Stored transcript omissions do not match their result");
    }
  }
  for (const result of omissions.results) {
    annotateHarnessTranscriptResultOmissions(
      transcript[result.transcriptIndex],
      result.rules,
    );
  }
};

/**
 * Builds the durable omission join for `transcript`, retaining entries already
 * recorded for messages loaded from a prior process.
 *
 * A tool result annotated with an empty set is still recorded. That separates
 * a result known to have no omissions from a legacy result for which no record
 * exists.
 */
export const createHarnessTranscriptOmissions = (
  transcript: readonly HarnessTranscriptMessage[],
  previous?: HarnessTranscriptOmissions,
): HarnessTranscriptOmissions => {
  const previousByOutput = new Map(
    (previous?.results ?? []).map((result) => [result.outputId, result]),
  );
  const results: HarnessToolResultOmissions[] = [];
  for (const [transcriptIndex, message] of transcript.entries()) {
    const provenance = resultProvenanceOf(message);
    if (provenance === undefined) continue;
    const current = omissionsOf(message);
    const prior = previousByOutput.get(provenance.outputId);
    if (current === undefined && prior === undefined) {
      continue;
    }
    results.push({
      transcriptIndex,
      ...provenance,
      rules: mergeRuleRecords(prior?.rules ?? [], current ?? []),
    });
  }
  return {
    type: HARNESS_TRANSCRIPT_OMISSIONS_TYPE,
    version: HARNESS_TRANSCRIPT_OMISSIONS_VERSION,
    results,
  };
};

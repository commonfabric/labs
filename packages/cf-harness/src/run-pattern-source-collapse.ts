import { isObjectNotArray } from "@commonfabric/utils/types";

import type {
  HarnessToolCall,
  HarnessTranscriptMessage,
} from "./contracts/transcript.ts";

/** What a collapsed `sourceText` opens with, and is recognized by. */
const SUPERSEDED_SOURCE_MARKER_PREFIX =
  "[cf-harness: superseded run_pattern source collapsed";

/** Whether source text is a model-context marker for a saved source artifact. */
export const isCollapsedRunPatternSource = (source: string): boolean =>
  source.startsWith(SUPERSEDED_SOURCE_MARKER_PREFIX);

interface SupersededSource {
  toolCallId: string;
  attempt: number;
  arguments: Record<string, unknown>;
  source: string;
}

/**
 * The arguments of a `run_pattern` call and the source they carry, or
 * `undefined` where the call carries none to collapse: arguments that are not
 * a JSON object, a call naming a `patternId` instead, and one whose source is
 * already a marker. Called for a `run_pattern` call.
 */
const runPatternSourceCall = (
  toolCall: HarnessToolCall,
): { arguments: Record<string, unknown>; source: string } | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.function.arguments);
  } catch {
    return undefined;
  }
  if (!isObjectNotArray(parsed)) return undefined;
  const source = parsed.sourceText;
  if (
    typeof source !== "string" ||
    isCollapsedRunPatternSource(source)
  ) {
    return undefined;
  }
  return { arguments: parsed, source };
};

/**
 * The `outputId` each `run_pattern` call's result reported, by call id. A
 * call whose result never arrived, or reported none, is absent — and so is
 * left uncollapsed, since the marker would name an artifact that does not
 * exist.
 */
const resultOutputIds = (
  transcript: readonly HarnessTranscriptMessage[],
): Map<string, string> => {
  const outputIds = new Map<string, string>();
  for (const message of transcript) {
    if (message.role !== "tool" || message.toolName !== "run_pattern") continue;
    try {
      const output: unknown = JSON.parse(message.content);
      if (isObjectNotArray(output) && typeof output.outputId === "string") {
        outputIds.set(message.toolCallId, output.outputId);
      }
    } catch {
      // A result that is not JSON names no artifact to point at.
    }
  }
  return outputIds;
};

const marker = (
  superseded: SupersededSource,
  outputId: string,
): string =>
  `${SUPERSEDED_SOURCE_MARKER_PREFIX} for model context; attempt ${superseded.attempt}, ` +
  `${superseded.source.length} characters. The newest run_pattern call ` +
  `carries the source to edit; this attempt's source is preserved in tool ` +
  `output ${outputId}.]`;

/**
 * Replaces the `sourceText` of every `run_pattern` call in `transcript` but
 * the most recent one with a short marker, in place.
 *
 * A pattern-authoring loop edits against the source it wrote last. The
 * earlier drafts stay in model context as assistant tool-call arguments for
 * every remaining turn, at the full length of each, and no turn reads them
 * again. The marker keeps which attempt it was, how long its source ran, and
 * the tool output that holds the text.
 *
 * A call naming a `patternId` carries no source and is left alone, as is one
 * whose source is shorter than the marker would be. The marker names an
 * artifact, so a source is replaced only where the artifact holding it
 * exists: the call's result must report an `outputId`, and that id must be in
 * `preservedOutputIds`, which the caller fills as it writes each source. A run
 * that preserves nothing collapses nothing, and keeps every draft it holds.
 *
 * Collapsing is idempotent: a marker is recognized by its opening and a call
 * carrying one is left as it stands.
 */
export const collapseSupersededRunPatternSources = (
  transcript: HarnessTranscriptMessage[],
  preservedOutputIds: ReadonlySet<string>,
): void => {
  const outputIds = resultOutputIds(transcript);
  const sources: SupersededSource[] = [];
  // Numbered over every `run_pattern` call, so that an attempt keeps the
  // number it had once its own source is collapsed, and carries the number
  // its diagnostic carries.
  let attempts = 0;
  for (const message of transcript) {
    if (message.role !== "assistant") continue;
    for (const toolCall of message.toolCalls ?? []) {
      if (toolCall.function.name !== "run_pattern") continue;
      attempts += 1;
      const call = runPatternSourceCall(toolCall);
      if (call === undefined) continue;
      sources.push({
        toolCallId: toolCall.id,
        attempt: attempts,
        arguments: call.arguments,
        source: call.source,
      });
    }
  }
  const collapsed = new Map<string, string>();
  for (const superseded of sources.slice(0, -1)) {
    const outputId = outputIds.get(superseded.toolCallId);
    if (outputId === undefined || !preservedOutputIds.has(outputId)) continue;
    const text = marker(superseded, outputId);
    if (text.length >= superseded.source.length) continue;
    collapsed.set(
      superseded.toolCallId,
      JSON.stringify({ ...superseded.arguments, sourceText: text }),
    );
  }
  if (collapsed.size === 0) return;
  for (const [messageIndex, message] of transcript.entries()) {
    if (message.role !== "assistant" || message.toolCalls === undefined) {
      continue;
    }
    if (!message.toolCalls.some((toolCall) => collapsed.has(toolCall.id))) {
      continue;
    }
    transcript[messageIndex] = {
      ...message,
      toolCalls: message.toolCalls.map((toolCall) => {
        const args = collapsed.get(toolCall.id);
        return args === undefined ? toolCall : {
          ...toolCall,
          function: { ...toolCall.function, arguments: args },
        };
      }),
    };
  }
};

import { isObjectNotArray } from "@commonfabric/utils/types";

import type {
  HarnessToolTranscriptMessage,
  HarnessTranscriptMessage,
} from "./contracts/transcript.ts";
import {
  annotateHarnessToolResultOmissions,
  createHarnessTranscriptOmissionRuleRecord,
} from "./contracts/transcript-omissions.ts";

/** Statuses whose `message` carries a diagnostic the model writes against. */
const COLLAPSIBLE_STATUSES = new Set(["compile-error", "error"]);

/** Distinct error classes a summary names, the rest counted. */
const SUMMARY_ERROR_CLASS_LIMIT = 3;

/** Characters kept of an error class, and of a first-line gist. */
const SUMMARY_TEXT_MAX_CHARS = 100;

/** The lead line of one compiler error, ahead of its code frame. */
const COMPILER_ERROR_LINE = /^\[ERROR\] (.*)$/gm;

interface CollapsibleFailure {
  output: Record<string, unknown>;
  outputId: string;
  status: string;
  message: string;
}

const failureFromContent = (
  content: string,
): CollapsibleFailure | undefined => {
  let output: unknown;
  try {
    output = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isObjectNotArray(output) || output.messageCollapsed === true) {
    return undefined;
  }
  const { outputId, status, message } = output;
  if (
    typeof outputId !== "string" || typeof status !== "string" ||
    typeof message !== "string" || !COLLAPSIBLE_STATUSES.has(status)
  ) {
    return undefined;
  }
  return { output, outputId, status, message };
};

const bounded = (text: string): string =>
  text.length > SUMMARY_TEXT_MAX_CHARS
    ? `${text.slice(0, SUMMARY_TEXT_MAX_CHARS)}...`
    : text;

/**
 * How many errors the diagnostic reports and what they say, in order of first
 * appearance and with the number of times each recurs. A message reporting no
 * compiler error renders as the empty string.
 */
const errorClassSummary = (message: string): string => {
  // Keyed by the whole line: two errors that share a long prefix are two
  // classes, and bounding before the count merges them into a wrong one.
  const counts = new Map<string, number>();
  for (const [, text] of message.matchAll(COMPILER_ERROR_LINE)) {
    const error = text.trim();
    counts.set(error, (counts.get(error) ?? 0) + 1);
  }
  if (counts.size === 0) return "";
  const named = [...counts.entries()].slice(0, SUMMARY_ERROR_CLASS_LIMIT)
    .map(([error, count]) =>
      count > 1 ? `"${bounded(error)}" x${count}` : `"${bounded(error)}"`
    );
  const unnamed = counts.size - named.length;
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return `${total} ${total === 1 ? "error" : "errors"}: ${named.join("; ")}${
    unnamed > 0 ? `; and ${unnamed} more` : ""
  }`;
};

/** The message's first non-empty line, bounded in length. */
const gist = (message: string): string => {
  const line = message.split("\n").map((text) => text.trim())
    .find((text) => text.length > 0) ?? "";
  return `first line: "${bounded(line)}"`;
};

const summarize = (failure: CollapsibleFailure, attempt: number): string => {
  const classes = errorClassSummary(failure.message);
  return "[cf-harness: superseded run_pattern diagnostic collapsed for " +
    `model context; attempt ${attempt}, ${failure.status}, ${
      classes.length > 0 ? classes : gist(failure.message)
    }. Full diagnostic is preserved in tool output ${failure.outputId}.]`;
};

/**
 * The message with its diagnostic replaced by a summary, or `undefined` when
 * the summary would be no shorter than the diagnostic it replaces.
 */
const collapsedMessage = (
  message: HarnessToolTranscriptMessage,
  failure: CollapsibleFailure,
  attempt: number,
): HarnessToolTranscriptMessage | undefined => {
  const summary = summarize(failure, attempt);
  if (summary.length >= failure.message.length) return undefined;
  const collapsed: HarnessToolTranscriptMessage = {
    ...message,
    content: JSON.stringify({
      ...failure.output,
      message: summary,
      messageCollapsed: true,
      messageOriginalLength: failure.message.length,
    }),
  };
  const omission = message.resultRef === undefined
    ? undefined
    : createHarnessTranscriptOmissionRuleRecord(
      "superseded-run-pattern-diagnostic-collapse",
      message.resultRef,
      ["/message"],
    );
  return omission === undefined
    ? collapsed
    : annotateHarnessToolResultOmissions(collapsed, [omission], message);
};

/**
 * Replaces every failed `run_pattern` result in `transcript` but the most
 * recent one with a one-line summary of its diagnostic, in place.
 *
 * A diagnostic is the model's feedback loop for source it just wrote, and the
 * newest one is what it writes against. The ones before it stay in model
 * context for every remaining turn of the loop without being read again, so
 * each turn after a failure pays for all of them. A summary keeps what a
 * later turn can still use — which attempt failed, in which way, and on what
 * — and names the tool output artifact holding the full text.
 *
 * The transcript is the context the model is sent, so rewriting it is what
 * makes the saving real, and the artifact persisted from it then records what
 * the model was given. Only the free-text `message` of a `compile-error` or
 * `error` result is replaced, so a structured policy refusal beside it
 * reaches the model whole, and only where the summary is the shorter of the
 * two.
 *
 * Collapsing is idempotent: a summary carries `messageCollapsed`, and a
 * message carrying it is left as it stands.
 */
export const collapseSupersededRunPatternDiagnostics = (
  transcript: HarnessTranscriptMessage[],
): void => {
  const failures: {
    index: number;
    attempt: number;
    failure: CollapsibleFailure;
  }[] = [];
  let attempts = 0;
  for (const [index, message] of transcript.entries()) {
    if (message.role !== "tool" || message.toolName !== "run_pattern") {
      continue;
    }
    attempts += 1;
    const failure = failureFromContent(message.content);
    if (failure !== undefined) {
      failures.push({ index, attempt: attempts, failure });
    }
  }
  for (const { index, attempt, failure } of failures.slice(0, -1)) {
    const collapsed = collapsedMessage(
      transcript[index] as HarnessToolTranscriptMessage,
      failure,
      attempt,
    );
    if (collapsed !== undefined) transcript[index] = collapsed;
  }
};

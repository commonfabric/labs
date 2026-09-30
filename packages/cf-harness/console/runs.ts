/**
 * What a run's artifacts say, read back for the inspector. A turn's feed
 * carries elided summaries because a model context cannot hold the whole of a
 * tool result; the artifacts under `<artifact-root>/<run-id>/` hold it
 * untruncated, and this is the reading of them the page shows.
 *
 * Everything here is pure — a run state and a transcript in, a description
 * out — so what the inspector claims about a run is testable without a model,
 * a sandbox, or a disk.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";
import type { HarnessRunState, HarnessRunStatus } from "../src/run-state.ts";
import type {
  HarnessToolCall,
  HarnessTranscriptMessage,
} from "../src/contracts/transcript.ts";

/** How much of a title a listing entry carries before it is elided. */
export const CONSOLE_RUN_TITLE_LIMIT = 200;

const elide = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

/** One row of the run list. */
export interface ConsoleRunSummary {
  runId: string;
  status: HarnessRunStatus;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
  terminalReason?: string;
  model?: string;

  /** The last thing a person said in this run, which is what it was asked. */
  title?: string;

  toolCallCount: number;

  /** The run that delegated this one, for a `delegate_task` child. */
  parentRunId?: string;

  /** The tool call in the parent that started this run. */
  parentToolCallId?: string;

  /** How many delegations deep this run sits; absent for a parent run. */
  depth?: number;

  /** What the run failed at, and its detail, when it recorded a failure. */
  failure?: { kind: string; detail: string };

  /** Every piece address `assign_slug` handed back, in the order named. */
  pieceUrls: readonly string[];
}

/**
 * One `run_pattern` call: what was submitted, and what came back. A run that
 * builds a pattern spends most of its turns here, and the compile-error and
 * fix rounds between the first call and the one that works are the part a
 * feed of elided summaries loses.
 */
export interface ConsolePatternAttempt {
  toolCallId: string;

  /** Present when the call submitted source; absent when it named an index pattern. */
  source?: string;

  /** Present when the call ran an indexed pattern rather than fresh source. */
  patternId?: string;

  /** The `inputs` the call wired in, by name, as the model addressed them. */
  inputNames: readonly string[];

  status: string;

  /** The compiler's diagnostic, for a call the compiler refused. */
  message?: string;

  /** The piece the call created, when it created one. */
  pieceId?: string;
}

/** One `search_patterns` call and the patterns it matched. */
export interface ConsolePatternSearch {
  toolCallId: string;

  /** What was searched for: the call's free text, its tags, or both. */
  query?: string;

  hits: readonly {
    patternId?: string;

    /** The hit's own description, which is all the index titles it by. */
    description?: string;

    /** The index's ranking signal for the hit, when it keeps one. */
    score?: number;
  }[];
}

/** One `record_feedback` call, as the run reported it to the index. */
export interface ConsolePatternFeedback {
  toolCallId: string;
  patternId?: string;

  /** The verdict the call cast: `up` or `down`. */
  verdict?: string;

  note?: string;
}

/** One `assign_slug` call, and the address a person can open. */
export interface ConsolePiece {
  toolCallId: string;
  slug?: string;
  url?: string;
}

/**
 * The pattern-shaped work in a run. `run_pattern` is the central tool, so a
 * reading of a run that is not a reading of its pattern calls is missing what
 * the run was doing.
 */
export interface ConsoleRunLens {
  patternAttempts: readonly ConsolePatternAttempt[];
  searches: readonly ConsolePatternSearch[];
  feedback: readonly ConsolePatternFeedback[];
  pieces: readonly ConsolePiece[];
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  isObjectNotArray(value) ? value as Record<string, unknown> : {};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * What a `search_patterns` call asked for. The call carries free text, tags,
 * or both, and what a person wants to read back is the whole of the question
 * rather than whichever half the call led with.
 */
const searchQuery = (args: Record<string, unknown>): string | undefined => {
  const tags = Array.isArray(args.tags)
    ? args.tags.flatMap((tag) => asString(tag) ?? [])
    : [];
  const text = asString(args.text);
  const parts = [...(text === undefined ? [] : [text]), ...tags];
  return parts.length === 0 ? undefined : parts.join(" ");
};

/**
 * The tool calls an assistant made, by call id. A tool message names only the
 * call it answers, so the arguments a call was made with are recoverable only
 * from the assistant message that made it.
 */
const toolCallsById = (
  transcript: readonly HarnessTranscriptMessage[],
): Map<string, HarnessToolCall> => {
  const calls = new Map<string, HarnessToolCall>();
  for (const message of transcript) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const call of message.toolCalls ?? []) {
      calls.set(call.id, call);
    }
  }
  return calls;
};

/** The last thing a person said, which is what the run was asked to do. */
export const consoleRunTitle = (
  transcript: readonly HarnessTranscriptMessage[],
): string | undefined => {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const message = transcript[index];
    if (message.role === "user" && message.content.trim() !== "") {
      return elide(message.content.trim(), CONSOLE_RUN_TITLE_LIMIT);
    }
  }
  return undefined;
};

/**
 * The pattern-shaped reading of a transcript. A call whose arguments or result
 * did not parse is still reported — that a run called `run_pattern` and got
 * something back is the fact worth showing, and a result this cannot read is
 * exactly the case the raw artifact is there for.
 */
export const consoleRunLens = (
  transcript: readonly HarnessTranscriptMessage[],
): ConsoleRunLens => {
  const calls = toolCallsById(transcript);
  const patternAttempts: ConsolePatternAttempt[] = [];
  const searches: ConsolePatternSearch[] = [];
  const feedback: ConsolePatternFeedback[] = [];
  const pieces: ConsolePiece[] = [];

  for (const message of transcript) {
    if (message.role !== "tool") {
      continue;
    }
    const call = calls.get(message.toolCallId);
    const args = asRecord(
      call === undefined ? undefined : parseJson(call.function.arguments),
    );
    const result = asRecord(parseJson(message.content));
    switch (message.toolName) {
      case "run_pattern": {
        patternAttempts.push({
          toolCallId: message.toolCallId,
          ...(asString(args.sourceText) !== undefined
            ? { source: args.sourceText as string }
            : {}),
          ...(asString(args.patternId) !== undefined
            ? { patternId: args.patternId as string }
            : {}),
          inputNames: Object.keys(asRecord(args.inputs)),
          status: asString(result.status) ?? "unknown",
          ...(asString(result.message) !== undefined
            ? { message: result.message as string }
            : {}),
          ...(asString(result.pieceId) !== undefined
            ? { pieceId: result.pieceId as string }
            : {}),
        });
        break;
      }
      case "search_patterns": {
        const hits = Array.isArray(result.results)
          ? result.results
          : Array.isArray(result.hits)
          ? result.hits
          : [];
        const query = searchQuery(args);
        searches.push({
          toolCallId: message.toolCallId,
          ...(query !== undefined ? { query } : {}),
          hits: hits.map((hit) => {
            const record = asRecord(hit);
            const description = asString(record.description);
            const score = asNumber(asRecord(record.signals).score);
            return {
              ...(asString(record.patternId) !== undefined
                ? { patternId: record.patternId as string }
                : {}),
              ...(description !== undefined ? { description } : {}),
              ...(score !== undefined ? { score } : {}),
            };
          }),
        });
        break;
      }
      case "record_feedback": {
        feedback.push({
          toolCallId: message.toolCallId,
          ...(asString(args.patternId) !== undefined
            ? { patternId: args.patternId as string }
            : {}),
          ...(asString(args.verdict) !== undefined
            ? { verdict: args.verdict as string }
            : {}),
          ...(asString(args.note) !== undefined
            ? { note: args.note as string }
            : {}),
        });
        break;
      }
      case "assign_slug": {
        pieces.push({
          toolCallId: message.toolCallId,
          ...(asString(result.slug) !== undefined
            ? { slug: result.slug as string }
            : {}),
          ...(asString(result.url) !== undefined
            ? { url: result.url as string }
            : {}),
        });
        break;
      }
      default:
        break;
    }
  }
  return { patternAttempts, searches, feedback, pieces };
};

/** How a run reads in the list: what it was asked, and how it ended. */
export const summarizeConsoleRun = (
  runState: HarnessRunState,
  transcript: readonly HarnessTranscriptMessage[] = [],
): ConsoleRunSummary => {
  const title = consoleRunTitle(transcript);
  const pieceUrls = consoleRunLens(transcript).pieces
    .flatMap((piece) => piece.url === undefined ? [] : [piece.url]);
  return {
    runId: runState.runId,
    status: runState.status,
    createdAt: runState.createdAt,
    updatedAt: runState.updatedAt,
    ...(runState.endedAt !== undefined ? { endedAt: runState.endedAt } : {}),
    ...(runState.terminalReason !== undefined
      ? { terminalReason: runState.terminalReason }
      : {}),
    ...(runState.model !== undefined ? { model: runState.model } : {}),
    ...(title !== undefined ? { title } : {}),
    toolCallCount: runState.toolOutputs.length,
    ...(runState.lineage !== undefined
      ? {
        parentRunId: runState.lineage.parentRunId,
        parentToolCallId: runState.lineage.parentToolCallId,
        depth: runState.lineage.depth,
      }
      : {}),
    ...(runState.primaryFailure !== undefined
      ? {
        failure: {
          kind: runState.primaryFailure.kind,
          detail: runState.primaryFailure.detail,
        },
      }
      : {}),
    pieceUrls,
  };
};

/**
 * The run list, most recently touched first, so the run a page is most likely
 * looking for is the one at the top. Runs updated in the same millisecond are
 * ordered by run id, so two requests reading the same state list them alike.
 */
export const sortConsoleRuns = (
  runs: readonly ConsoleRunSummary[],
): readonly ConsoleRunSummary[] =>
  [...runs].sort((left, right) =>
    left.updatedAt === right.updatedAt
      ? left.runId.localeCompare(right.runId)
      : right.updatedAt.localeCompare(left.updatedAt)
  );

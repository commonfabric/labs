/**
 * Projects a completed console turn from its durable run report and the
 * transcript the model received. The report identifies this run's transcript
 * messages and supplies its final assistant text. Missing or malformed
 * artifacts produce no result rather than a partial object that could be
 * mistaken for a completed contract.
 */

import {
  isLoomAuthoredObservation,
  type LoomAuthoredObservation,
} from "../src/loom-authoring.ts";
import { join } from "@std/path";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import {
  type HarnessChatEventEnvelope,
  type HarnessChatStructuredEvent,
  harnessChatTurnElapsedMs,
  type HarnessChatTurnStatus,
} from "../src/contracts/interactive-chat.ts";
import {
  type HarnessTaskOutcome,
  readHarnessTaskOutcome,
} from "../src/contracts/task-outcome.ts";
import type {
  HarnessToolCall,
  HarnessToolTranscriptMessage,
  HarnessTranscriptMessage,
} from "../src/contracts/transcript.ts";
import type { HarnessModelUsage } from "../src/model/client.ts";
import { readHarnessModelUsage } from "../src/model/usage.ts";

/** A named piece a completed console turn made openable. */
export interface ConsoleTurnResultPiece {
  /** Slug returned by `assign_slug`. */
  slug: string;

  /** Openable URL returned beside the slug. */
  url: string;

  /** Verified composition membership for the same held token. No cell address. */
  loomComponents?: readonly { loomId: string; componentId: string }[];
}

/** The stable result an external console caller reads for a completed turn. */
export type ConsoleTurnResult = HarnessTaskOutcome & {
  /** Durable conversation to which a follow-up task belongs. */
  sessionId: string;

  /** Whether the session currently accepts another turn. */
  continuable: boolean;

  /** Verified compositions from this turn only, including explicit replays. */
  looms: readonly Pick<
    LoomAuthoredObservation,
    "receipt" | "replayed" | "current_version"
  >[];

  /** Originating Loom captured at submission, independent of later UI focus. */
  originLoomId?: string;

  /** Successful named-piece outputs, in transcript order. */
  pieces: readonly ConsoleTurnResultPiece[];

  /** The space this console is configured against. */
  spaceName: string;

  /** Human-readable answer, question, or reason the task cannot proceed. */
  finalText: string;

  /** Reported usage for this turn, including research and delegated calls. */
  usage?: HarnessModelUsage;

  /** Wall time from the durable turn's start to its terminal event. */
  elapsedMs?: number;
};

/** The console's completed SSE event with its external result attached. */
export type ConsoleTurnCompletedEvent =
  & Extract<
    HarnessChatStructuredEvent,
    { kind: "turn_completed" }
  >
  & { result: ConsoleTurnResult };

/** A console SSE event, whose completed-turn case always carries a result. */
export type ConsoleChatStructuredEvent =
  | Exclude<HarnessChatStructuredEvent, { kind: "turn_completed" }>
  | ConsoleTurnCompletedEvent;

/** The event envelope emitted by the console SSE route. */
export type ConsoleChatEventEnvelope =
  & Omit<
    HarnessChatEventEnvelope,
    "event"
  >
  & { event: ConsoleChatStructuredEvent };

/** Inputs which identify one turn's durable result. */
export interface ReadConsoleTurnResultOptions {
  /** Owning session from the chat service, never inferred from prose. */
  sessionId: string;

  /** Current availability reported by that session. */
  continuable: boolean;

  /** Originating Loom from the durable turn input. */
  originLoomId?: string;

  /** Root holding one artifact directory per turn. */
  artifactRoot: string;

  /** Turn identifier, which is also the run artifact directory name. */
  turnId: string;

  /** Space this console is configured against. */
  spaceName: string;

  /** Durable turn timestamps; absent when only legacy run artifacts are held. */
  timing?: Pick<HarnessChatTurnStatus, "startedAt" | "endedAt">;
}

/** Characters the artifact store admits in one run directory name. */
const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

/** Whether an artifact value has the minimum shape of a transcript message. */
const isTranscriptMessage = (
  value: unknown,
): value is HarnessTranscriptMessage => {
  if (
    !isObjectOrArray(value) || !("role" in value) ||
    !("content" in value) || typeof value.content !== "string"
  ) {
    return false;
  }
  if (
    value.role === "system" || value.role === "user" ||
    value.role === "assistant"
  ) {
    return true;
  }
  return value.role === "tool" && "toolCallId" in value &&
    typeof value.toolCallId === "string" && "toolName" in value &&
    typeof value.toolName === "string";
};

interface TurnRunArtifacts {
  transcript: readonly HarnessTranscriptMessage[];
  currentTranscriptIndexes: ReadonlySet<number>;
  finalText: string;
  taskOutcome: HarnessTaskOutcome;
  usage?: HarnessModelUsage;
}

/** The first two occurrences suffice to establish uniqueness at any prefix. */
interface IndexedCall {
  index: number;
  call: HarnessToolCall;
  secondIndex?: number;
}

const indexCalls = (
  artifacts: TurnRunArtifacts,
): ReadonlyMap<string, IndexedCall> => {
  const calls = new Map<string, IndexedCall>();
  artifacts.transcript.forEach((message, index) => {
    if (
      !artifacts.currentTranscriptIndexes.has(index) ||
      message.role !== "assistant" || !Array.isArray(message.toolCalls)
    ) return;
    for (const call of message.toolCalls) {
      if (typeof call?.id !== "string") continue;
      const prior = calls.get(call.id);
      if (prior === undefined) calls.set(call.id, { index, call });
      else if (prior.secondIndex === undefined) prior.secondIndex = index;
    }
  });
  return calls;
};

/**
 * Pairs only this turn's unique, preceding assistant call with its tool result.
 * Historical calls and malformed/duplicate pairs cannot prove membership.
 */
const callArguments = (
  calls: ReadonlyMap<string, IndexedCall>,
  resultIndex: number,
  result: HarnessToolTranscriptMessage,
): Record<string, unknown> | undefined => {
  const match = calls.get(result.toolCallId);
  if (
    match === undefined || match.index >= resultIndex ||
    (match.secondIndex !== undefined && match.secondIndex < resultIndex) ||
    match.call.function?.name !== result.toolName
  ) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(match.call.function.arguments);
    return isObjectNotArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Returns a generated message's index, `malformed` for an invalid generated
 * entry, or nothing for timeline entries outside this run.
 */
const currentTranscriptIndex = (
  value: unknown,
): number | "malformed" | undefined => {
  if (
    !isObjectOrArray(value) ||
    !("kind" in value) || value.kind !== "transcript_message"
  ) {
    return undefined;
  }
  if (!("modelTurn" in value)) {
    return undefined;
  }
  if (
    typeof value.modelTurn !== "number" ||
    !Number.isSafeInteger(value.modelTurn) || value.modelTurn < 1 ||
    !("transcriptIndex" in value) ||
    typeof value.transcriptIndex !== "number" ||
    !Number.isSafeInteger(value.transcriptIndex) || value.transcriptIndex < 0
  ) {
    return "malformed";
  }
  return value.transcriptIndex;
};

/** Reads the transcript and its run boundary without admitting a path. */
const readTurnRunArtifacts = async (
  artifactRoot: string,
  turnId: string,
): Promise<TurnRunArtifacts | undefined> => {
  if (
    !SAFE_RUN_ID.test(turnId) || turnId === "." || turnId === ".."
  ) {
    return undefined;
  }
  try {
    const runRoot = join(artifactRoot, turnId);
    const [transcriptValue, reportValue]: [unknown, unknown] = await Promise
      .all(
        [
          Deno.readTextFile(join(runRoot, "transcript.json")).then((text) =>
            JSON.parse(text)
          ),
          Deno.readTextFile(join(runRoot, "run-report.json")).then((text) =>
            JSON.parse(text)
          ),
        ],
      );
    if (
      !Array.isArray(transcriptValue) ||
      !transcriptValue.every(isTranscriptMessage) ||
      !isObjectOrArray(reportValue) ||
      !("timeline" in reportValue) || !Array.isArray(reportValue.timeline) ||
      !("finalAssistantText" in reportValue) ||
      typeof reportValue.finalAssistantText !== "string"
    ) {
      return undefined;
    }
    const taskOutcome = readHarnessTaskOutcome(
      Object.hasOwn(reportValue, "taskOutcome")
        ? (reportValue as Record<string, unknown>).taskOutcome
        : undefined,
    );
    if (taskOutcome === undefined) return undefined;
    const currentTranscriptIndexes = new Set<number>();
    for (const entry of reportValue.timeline) {
      const index = currentTranscriptIndex(entry);
      if (index === "malformed") {
        return undefined;
      }
      if (index !== undefined) {
        if (index >= transcriptValue.length) {
          return undefined;
        }
        currentTranscriptIndexes.add(index);
      }
    }
    return {
      transcript: transcriptValue,
      currentTranscriptIndexes,
      finalText: reportValue.finalAssistantText,
      taskOutcome,
      usage: readHarnessModelUsage(
        "totalUsage" in reportValue
          ? reportValue.totalUsage
          : "usage" in reportValue
          ? reportValue.usage
          : undefined,
      ),
    };
  } catch {
    return undefined;
  }
};

/** Copies the openable fields from one successful `assign_slug` output. */
const pieceFromAssignSlug = (
  message: HarnessTranscriptMessage,
): ConsoleTurnResultPiece | undefined => {
  if (message.role !== "tool" || message.toolName !== "assign_slug") {
    return undefined;
  }
  let output: unknown;
  try {
    output = JSON.parse(message.content);
  } catch {
    return undefined;
  }
  if (
    !isObjectOrArray(output) ||
    !("status" in output) || output.status !== "ok" ||
    !("slug" in output) || typeof output.slug !== "string" ||
    !("url" in output) || typeof output.url !== "string"
  ) {
    return undefined;
  }
  // These two fields are copied from the model-facing `assign_slug` output.
  // No new data crosses the console boundary and no URL is reconstructed.
  return { slug: output.slug, url: output.url };
};

/**
 * Reads one completed turn from its durable report and model-facing
 * transcript. The report supplies the run boundary and final text. Returns
 * `undefined` when the artifacts cannot establish a complete result.
 */
export const readConsoleTurnResult = async (
  options: ReadConsoleTurnResultOptions,
): Promise<ConsoleTurnResult | undefined> => {
  const artifacts = await readTurnRunArtifacts(
    options.artifactRoot,
    options.turnId,
  );
  if (artifacts === undefined) {
    return undefined;
  }
  const elapsedMs = harnessChatTurnElapsedMs(
    options.timing?.startedAt,
    options.timing?.endedAt,
  );
  const calls = indexCalls(artifacts);
  const membership = new Map<
    string,
    { loomId: string; componentId: string }[]
  >();
  const looms = artifacts.transcript.flatMap((message, index) => {
    if (
      !artifacts.currentTranscriptIndexes.has(index) ||
      message.role !== "tool" || message.toolName !== "loom_compose"
    ) return [];
    try {
      const output: unknown = JSON.parse(message.content);
      if (!isLoomAuthoredObservation(output)) return [];
      const args = callArguments(calls, index, message);
      const ids = output.receipt.component_ids as string[];
      // compose preserves request order in component_ids. This correlation
      // needs both the matching successful call and its exact receipt; it is
      // not inferred from a human slug or copied out of model prose.
      if (
        args?.request_id === output.receipt.request_id &&
        Array.isArray(args.components) && args.components.length === ids.length
      ) {
        args.components.forEach((component, position) => {
          const token = component?.pattern_token;
          if (typeof token !== "string" || token.length === 0) return;
          membership.set(token, [...membership.get(token) ?? [], {
            loomId: output.receipt.loom_id,
            componentId: ids[position],
          }]);
        });
      }
      return [{
        receipt: output.receipt,
        replayed: output.replayed,
        current_version: output.current_version,
      }];
    } catch {
      return [];
    }
  });
  return {
    ...artifacts.taskOutcome,
    sessionId: options.sessionId,
    continuable: options.continuable,
    ...(options.originLoomId !== undefined
      ? { originLoomId: options.originLoomId }
      : {}),
    looms,
    pieces: artifacts.transcript.flatMap((message, index) => {
      if (
        !artifacts.currentTranscriptIndexes.has(index) ||
        message.role !== "tool"
      ) {
        return [];
      }
      const piece = pieceFromAssignSlug(message);
      if (piece === undefined) return [];
      const args = callArguments(calls, index, message);
      const coverage = typeof args?.token === "string"
        ? membership.get(args.token)
        : undefined;
      return [{
        ...piece,
        ...(coverage === undefined ? {} : { loomComponents: coverage }),
      }];
    }),
    spaceName: options.spaceName,
    finalText: artifacts.finalText,
    ...(artifacts.usage === undefined ? {} : { usage: artifacts.usage }),
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
  };
};

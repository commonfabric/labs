import {
  createHarnessTranscriptOmissions,
  restoreHarnessTranscriptOmissions,
} from "./contracts/transcript-omissions.ts";
import { selectResearchContext } from "./research/context.ts";
import { loomAuthoringForTurn } from "./loom-authoring.ts";
import {
  isObjectNotArray,
  type ReadonlyRecord,
} from "@commonfabric/utils/types";
import { CfHarnessEngine } from "./engine.ts";
import {
  CfHarnessPromptLoop,
  type CreateHarnessPromptLoopOptions,
  type RunHarnessTranscriptOptions,
} from "./prompt-loop.ts";
import { establishHarnessSessionContext } from "./session-assembly.ts";
import { pieceTargetingContextMessages } from "./piece-targeting.ts";
import { REVISION_VERIFICATION_GUIDANCE } from "./revision-verification.ts";
import type { HarnessInputCellSpec } from "./contracts/input-cells.ts";
import type { HarnessAssignedPiece } from "./contracts/assigned-piece.ts";
import type { HarnessPatternRefSpec } from "./contracts/pattern-refs.ts";
import {
  createHarnessChatErrorResponse,
  createHarnessChatEventEnvelope,
  createHarnessChatOkResponse,
  createHarnessChatSessionStatus,
  type HarnessChatBrowserAccessLease,
  type HarnessChatError,
  type HarnessChatErrorResponse,
  type HarnessChatEventEnvelope,
  type HarnessChatListEventsParams,
  type HarnessChatListEventsResult,
  type HarnessChatListTurnsParams,
  type HarnessChatListTurnsResult,
  type HarnessChatPolicy,
  type HarnessChatRequestEnvelope,
  type HarnessChatResponse,
  type HarnessChatSessionStatus,
  type HarnessChatStartSessionParams,
  type HarnessChatStartTurnParams,
  type HarnessChatStatusResult,
  type HarnessChatStructuredEvent,
  type HarnessChatSubagentRef,
  type HarnessChatSubagentSummary,
  type HarnessChatTurnRecord,
  type HarnessChatTurnStatus,
  reduceHarnessChatSessionStatus,
  resolveHarnessChatPolicy,
} from "./contracts/interactive-chat.ts";
import {
  BROWSER_SUBAGENT_PROFILE,
  isHarnessSubagentProfile,
} from "./contracts/subagent.ts";
import {
  type HarnessCredentialOwnerRef,
  harnessCredentialOwnersEqual,
  type LoomLocalHostBinding,
} from "./contracts/run-manifest.ts";
import {
  type HarnessAssistantTranscriptMessage,
  type HarnessToolCall,
  type HarnessToolTranscriptMessage,
  type HarnessTranscriptMessage,
  type HarnessTranscriptSubagentContext,
  isResumableHarnessTranscript,
} from "./contracts/transcript.ts";
import type {
  HarnessChatResearchContext,
  HarnessChatSessionStore,
} from "./session-store.ts";
import { HarnessControlError } from "./control-errors.ts";

export type HarnessInteractivePromptLoop = Pick<
  CfHarnessPromptLoop,
  "runTranscript"
>;

export type HarnessInteractivePromptLoopFactory = (
  options: CreateHarnessPromptLoopOptions,
) => HarnessInteractivePromptLoop;

export type HarnessInteractiveChatEventListener = (
  event: HarnessChatEventEnvelope,
) => void | Promise<void>;

/**
 * Told that a listener could not take an event that is already durable.
 *
 * Delivery is not part of committing, so a host that wants to act on a failed
 * delivery — a transport whose peer has gone, say — reads it here rather than
 * from the outcome of whatever turn produced the event.
 */
export type HarnessInteractiveChatEventDeliveryErrorHandler = (
  event: HarnessChatEventEnvelope,
  error: unknown,
) => void;

export interface CreateHarnessInteractiveChatServiceOptions {
  basePromptLoopOptions?: CreateHarnessPromptLoopOptions;

  /**
   * Maps one service turn to a run artifact identifier when the transport
   * owns that mapping. The prompt loop must construct the run from its
   * options, so this cannot accompany an injected engine or run state.
   */
  runIdForTurn?: (sessionId: string, turnId: string) => string;

  /**
   * System prompt seeded as the first message of a session's transcript.
   *
   * A session without one runs with no system message at all, which is what
   * the console does by default: the parent's guidance is the tool
   * descriptors and nothing else. Seeding happens once per session, on the
   * first turn that finds no system message in the durable transcript, so a
   * following turn inherits it from history rather than prepending a second.
   */
  systemPrompt?: string;

  /**
   * The single authenticated owner bound to this service process. Required
   * for openai-codex; interactive requests cannot select or replace it.
   */
  credentialOwner?: HarnessCredentialOwnerRef;

  createPromptLoop?: HarnessInteractivePromptLoopFactory;
  now?: () => string;
  randomUUID?: () => string;
  onEvent?: HarnessInteractiveChatEventListener;
  onEventDeliveryError?: HarnessInteractiveChatEventDeliveryErrorHandler;
  sessionStore?: HarnessChatSessionStore;
  maxInMemoryEvents?: number;
}

interface HarnessInteractiveChatSessionRecord {
  status: HarnessChatSessionStatus;

  /**
   * The last durable resumable transcript: the model history a following turn
   * is built from. Normal turns advance it only when they complete; legacy
   * recovery may also atomically adopt a normalized transcript. Every snapshot
   * persisted alongside an event is one a provider accepts.
   */
  transcript: readonly HarnessTranscriptMessage[];

  /** Host-admitted findings retained with the durable transcript. */
  researchContext?: HarnessChatResearchContext;

  /** Host-confirmed named pieces available to a bare follow-up. */
  assignedPieces?: readonly HarnessAssignedPiece[];

  /**
   * Why a restored session cannot be resumed. Set when the recorded history
   * could not be repaired into valid model history; a turn started on such a
   * session is refused rather than sent to a provider.
   */
  recoveryError?: HarnessChatError;

  startingTurnId?: string;
  startingTurn?: HarnessChatTurnStatus;
  activeTurnToken?: object;
  activeTask?: Promise<void>;
  activeAbortController?: AbortController;
  canceledTurnIds: Set<string>;
  turns: Map<string, HarnessChatTurnRecord>;
}

interface HarnessInteractiveChatEmitOptions {
  turnRecord?: HarnessChatTurnRecord;
  createTurn?: boolean;

  /**
   * A transcript to persist with this event and adopt as the session's durable
   * checkpoint. It replaces `record.transcript` only once the durable write has
   * committed, so an event that fails to persist leaves the previous checkpoint
   * in place for the failure path to fall back on.
   */
  transcript?: readonly HarnessTranscriptMessage[];

  /** Research checkpoint committed atomically with a completed turn. */
  researchContext?: HarnessChatResearchContext;

  /** Naming checkpoint committed with the completed turn's transcript. */
  assignedPieces?: readonly HarnessAssignedPiece[];
}

const defaultPromptLoopFactory: HarnessInteractivePromptLoopFactory = (
  options,
) => new CfHarnessPromptLoop(options);

const defaultRandomUUID = (): string => crypto.randomUUID();

class DurableTurnExistsError extends Error {
  readonly sessionId: string;
  readonly turnId: string;

  constructor(sessionId: string, turnId: string) {
    super(`chat turn already exists for session ${sessionId}: ${turnId}`);
    this.name = "DurableTurnExistsError";
    this.sessionId = sessionId;
    this.turnId = turnId;
  }
}

/**
 * The one chat error that waiting alone clears: the turn in flight ends on its
 * own, and the identical request then succeeds. That is what `retryable`
 * claims, in the sense HTTP's `Retry-After` gives it — not that a caller could
 * do something about the failure, which is true of most of the errors here.
 */
const activeTurnError = (
  requestId: string,
  session: HarnessChatSessionStatus,
  activeTurnId = session.activeTurnId,
): HarnessChatErrorResponse =>
  createHarnessChatErrorResponse(requestId, {
    code: "turn_already_running",
    message: activeTurnId === undefined
      ? `session ${session.sessionId} already has an active turn task`
      : `session ${session.sessionId} already has active turn ${activeTurnId}`,
    retryable: true,
  });

const sessionExistsError = (
  requestId: string,
  sessionId: string,
): HarnessChatErrorResponse =>
  createHarnessChatErrorResponse(requestId, {
    code: "session_exists",
    message: `chat session already exists: ${sessionId}`,
  });

const turnExistsError = (
  requestId: string,
  sessionId: string,
  turnId: string,
): HarnessChatErrorResponse =>
  createHarnessChatErrorResponse(requestId, {
    code: "turn_exists",
    message: `chat turn already exists for session ${sessionId}: ${turnId}`,
  });

const sessionNotFoundError = (
  requestId: string,
  sessionId: string,
): HarnessChatErrorResponse =>
  createHarnessChatErrorResponse(requestId, {
    code: "session_not_found",
    message: `chat session not found: ${sessionId}`,
  });

const sessionClosedError = (
  requestId: string,
  sessionId: string,
): HarnessChatErrorResponse =>
  createHarnessChatErrorResponse(requestId, {
    code: "session_closed",
    message: `chat session is closed: ${sessionId}`,
  });

const providerMismatchError = (
  requestId: string,
  message: string,
): HarnessChatErrorResponse =>
  createHarnessChatErrorResponse(requestId, {
    code: "provider-mismatch",
    message,
  });

const isLoomLocalHostBinding = (
  value: unknown,
): value is LoomLocalHostBinding => {
  if (!isObjectNotArray(value) || value.source !== "loom") {
    return false;
  }
  if (
    value.modelProvider !== "openai-compatible-gateway" &&
    value.modelProvider !== "openai-codex"
  ) {
    return false;
  }
  if (
    value.modelAuthSource !== "api-key" &&
    value.modelAuthSource !== "none" &&
    value.modelAuthSource !== "cf-harness-local-store"
  ) {
    return false;
  }
  const owner = value.credentialOwner;
  return isObjectNotArray(owner) &&
    owner.type === "cf-harness.credential-owner-ref" && owner.version === 1 &&
    typeof owner.ownerKey === "string" && owner.ownerKey.length > 0 &&
    (owner.tenantKey === undefined || typeof owner.tenantKey === "string") &&
    typeof value.harnessHomeIdentity === "string" &&
    value.harnessHomeIdentity.length > 0;
};

const loomLocalHostBindingFromPromptLoopOptions = (
  options: CreateHarnessPromptLoopOptions,
): LoomLocalHostBinding | undefined => {
  const manifest = options.runManifest;
  if (!isLoomLocalHostBinding(manifest)) {
    return undefined;
  }
  const binding: LoomLocalHostBinding = {
    source: "loom",
    modelProvider: manifest.modelProvider,
    modelAuthSource: manifest.modelAuthSource,
    credentialOwner: structuredClone(manifest.credentialOwner),
    harnessHomeIdentity: manifest.harnessHomeIdentity,
  };
  if (
    options.modelProvider !== binding.modelProvider
  ) {
    throw new Error(
      "interactive service provider does not match its Loom-local run manifest",
    );
  }
  if (
    options.modelAuthSource !== undefined &&
    options.modelAuthSource !== binding.modelAuthSource
  ) {
    throw new Error(
      "interactive service auth source does not match its Loom-local run manifest",
    );
  }
  if (
    options.credentialOwner !== undefined &&
    !harnessCredentialOwnersEqual(
      options.credentialOwner,
      binding.credentialOwner,
    )
  ) {
    throw new Error(
      "interactive service credential owner does not match its Loom-local run manifest",
    );
  }
  if (
    options.harnessHomeIdentity !== undefined &&
    options.harnessHomeIdentity !== binding.harnessHomeIdentity
  ) {
    throw new Error(
      "interactive service harness home does not match its Loom-local run manifest",
    );
  }
  return binding;
};

const loomLocalHostBindingsEqual = (
  expected: LoomLocalHostBinding,
  actual: unknown,
): boolean =>
  isLoomLocalHostBinding(actual) &&
  expected.source === actual.source &&
  expected.modelProvider === actual.modelProvider &&
  expected.modelAuthSource === actual.modelAuthSource &&
  harnessCredentialOwnersEqual(
    expected.credentialOwner,
    actual.credentialOwner,
  ) && expected.harnessHomeIdentity === actual.harnessHomeIdentity;

/**
 * A lease reaches a turn on the request that starts it, or on the one that
 * started the session; no request adds one to a session already running. So
 * resending this turn unchanged fails the same way however long the caller
 * waits, and it carries no `retryable` — the next attempt has to carry the
 * lease, which makes it a different request.
 */
const browserAccessRequiredError = (
  requestId: string,
): HarnessChatErrorResponse =>
  createHarnessChatErrorResponse(requestId, {
    code: "browser_access_required",
    message: "Browser Access lease is required for browser profile turns.",
  });

const turnNotFoundError = (
  requestId: string,
  sessionId: string,
): HarnessChatErrorResponse =>
  createHarnessChatErrorResponse(requestId, {
    code: "turn_not_found",
    message: `active turn not found for session ${sessionId}`,
  });

const createTurnAbortError = (turnId: string, reason: string): DOMException =>
  new DOMException(
    `cf-harness chat turn ${turnId} canceled: ${reason}`,
    "AbortError",
  );

const interruptedTurnError = (
  turnId: string,
  priorStatus: HarnessChatTurnStatus["status"],
): HarnessChatError => ({
  code: "internal_error",
  message:
    `cf-harness chat turn ${turnId} was interrupted before it reached a terminal state`,
  details: {
    terminalReason: "process_interrupted",
    priorStatus,
  },
});

/** A transcript defect whose missing history cannot be inferred honestly. */
type HarnessTranscriptMalformation =
  | "duplicate_tool_call_id"
  | "tool_result_without_pending_call";

/** Identifies where durable transcript normalization found malformed history. */
class MalformedHarnessChatTranscriptError extends Error {
  /** Kind of malformed history encountered. */
  readonly malformation: HarnessTranscriptMalformation;

  /** Zero-based index of the message where validation failed. */
  readonly transcriptIndex: number;

  /** Constructs an instance naming the defect and its transcript position. */
  constructor(
    malformation: HarnessTranscriptMalformation,
    transcriptIndex: number,
  ) {
    super(
      `durable chat transcript is malformed at message ${transcriptIndex}: ${malformation}`,
    );
    this.name = "MalformedHarnessChatTranscriptError";
    this.malformation = malformation;
    this.transcriptIndex = transcriptIndex;
  }
}

/** Returns the chat error for malformed durable history. */
const malformedTranscriptChatError = (
  error: MalformedHarnessChatTranscriptError,
): HarnessChatError => ({
  code: "internal_error",
  message:
    "The durable chat transcript is malformed and cannot be safely repaired.",
  details: {
    reason: "malformed_transcript",
    malformation: error.malformation,
    transcriptIndex: error.transcriptIndex,
  },
});

/** Returns a local protocol response for malformed durable history. */
const malformedTranscriptError = (
  requestId: string,
  error: MalformedHarnessChatTranscriptError,
): HarnessChatErrorResponse =>
  createHarnessChatErrorResponse(
    requestId,
    malformedTranscriptChatError(error),
  );

/** Returns an explicit tool result whose execution outcome remains unknown. */
const unknownToolOutcome = (
  toolCall: HarnessToolCall,
): HarnessToolTranscriptMessage => ({
  role: "tool",
  toolCallId: toolCall.id,
  toolName: toolCall.function.name,
  content: JSON.stringify({
    type: "cf-harness.tool-outcome-unknown",
    outcome: "unknown",
    reason: "process_interrupted",
    message:
      "The run was interrupted after this tool call was recorded and before a result was recorded. Whether the tool ran or produced side effects is unknown. Inspect current state before deciding whether to retry.",
  }),
});

/** Provider-safe transcript and tool results synthesized to make it safe. */
interface NormalizedHarnessChatTranscript {
  /** Transcript with every repairable tool call paired to one result. */
  transcript: HarnessTranscriptMessage[];

  /** Tool call IDs paired to synthesized unknown-outcome results. */
  synthesizedToolCallIds: readonly string[];
}

/**
 * Makes persisted tool exchanges safe for the next provider request without
 * deleting model-visible history. Missing results become explicit
 * unknown-outcome results at the declaring batch boundary, retaining both the
 * original call (including any compaction continuation) and every later
 * message. Existing results pair by call id across the whole transcript, not
 * by adjacency; only results still missing after that scan are synthesized.
 *
 * A tool result without a pending call cannot be repaired honestly: inventing
 * a call would claim an invocation that may never have happened, while deleting
 * the result would erase the only remaining evidence. A reused call id is
 * similarly ambiguous across batches. Callers therefore fail closed for that
 * session before provider traffic rather than guessing.
 */
const normalizeIncompleteToolExchanges = (
  transcript: readonly HarnessTranscriptMessage[],
): NormalizedHarnessChatTranscript => {
  const normalized: HarnessTranscriptMessage[] = [];
  const synthesizedToolCallIds: string[] = [];
  const seenToolCallIds = new Set<string>();
  const pendingToolCalls = new Map<
    string,
    { toolCall: HarnessToolCall; transcriptIndex: number }
  >();

  for (const [index, message] of transcript.entries()) {
    if (message.role === "tool") {
      if (!pendingToolCalls.delete(message.toolCallId)) {
        throw new MalformedHarnessChatTranscriptError(
          "tool_result_without_pending_call",
          index,
        );
      }
      continue;
    }
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      continue;
    }
    const batchToolCallIds = new Set<string>();
    for (const toolCall of message.toolCalls) {
      if (
        seenToolCallIds.has(toolCall.id) ||
        batchToolCallIds.has(toolCall.id)
      ) {
        throw new MalformedHarnessChatTranscriptError(
          "duplicate_tool_call_id",
          index,
        );
      }
      batchToolCallIds.add(toolCall.id);
      seenToolCallIds.add(toolCall.id);
      pendingToolCalls.set(toolCall.id, { toolCall, transcriptIndex: index });
    }
  }

  const insertions = new Map<number, HarnessToolCall[]>();
  for (const { toolCall, transcriptIndex } of pendingToolCalls.values()) {
    // Keep a batch's real contiguous results in their recorded order, then
    // close only its missing calls before later conversation or compaction can
    // move the provider projection boundary past the declaring call.
    let insertionIndex = transcriptIndex;
    while (transcript[insertionIndex + 1]?.role === "tool") {
      insertionIndex += 1;
    }
    const calls = insertions.get(insertionIndex) ?? [];
    calls.push(toolCall);
    insertions.set(insertionIndex, calls);
  }
  for (const [index, message] of transcript.entries()) {
    normalized.push(message);
    for (const toolCall of insertions.get(index) ?? []) {
      normalized.push(unknownToolOutcome(toolCall));
      synthesizedToolCallIds.push(toolCall.id);
    }
  }
  return { transcript: normalized, synthesizedToolCallIds };
};

const unresumableSessionError = (sessionId: string): HarnessChatError => ({
  code: "incomplete_transcript",
  message:
    `chat session was marked not reusable by an earlier recovery: ${sessionId}`,
});

/** Reports a transcript normalization which could not be made durable. */
const normalizationPersistenceError = (
  sessionId: string,
): HarnessChatError => ({
  code: "incomplete_transcript",
  message: `chat session history could not be normalized: ${sessionId}`,
});

/** A prompt loop reported success with history a provider would reject. */
class HarnessIncompleteTranscriptError extends Error {
  constructor(turnId: string) {
    super(
      `cf-harness chat turn ${turnId} completed with history that does not pair its tool calls with tool results`,
    );
    this.name = "HarnessIncompleteTranscriptError";
  }
}

const chatTurnError = (error: unknown): HarnessChatError => {
  if (error instanceof HarnessIncompleteTranscriptError) {
    return { code: "incomplete_transcript", message: error.message };
  }
  if (
    error instanceof HarnessControlError &&
    (error.code === "provider-configuration-required" ||
      error.code === "provider-auth-required" ||
      error.code === "provider-mismatch" ||
      error.code === "provider-unavailable")
  ) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "internal_error",
    message: error instanceof Error ? error.message : String(error),
  };
};

const isTerminalTurnStatus = (
  status: HarnessChatTurnStatus["status"] | undefined,
): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

const clearActiveTurnStatus = (
  status: HarnessChatSessionStatus,
  updatedAt: string,
): HarnessChatSessionStatus => {
  const { activeTurn: _activeTurn, activeTurnId: _activeTurnId, ...rest } =
    status;
  if (status.status === "closed" || status.status === "failed") {
    return {
      ...rest,
      reusable: false,
      updatedAt,
    };
  }
  return {
    ...rest,
    status: "idle",
    reusable: true,
    updatedAt,
  };
};

const parseToolMessageContent = (
  content: string,
): ReadonlyRecord | undefined => {
  try {
    const parsed: unknown = JSON.parse(content);
    return isObjectNotArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const toolMessageStatus = (
  parsedContent: ReadonlyRecord | undefined,
): "completed" | "failed" | "denied" => {
  if (parsedContent?.type === "cf-harness.observation-denied") {
    return "denied";
  }
  if (parsedContent?.ok === false) {
    return "failed";
  }
  return "completed";
};

const fileChangeFromToolMessage = (
  message: HarnessToolTranscriptMessage,
  parsedContent: ReadonlyRecord | undefined,
):
  | Extract<HarnessChatStructuredEvent, { kind: "file_changed" }>
  | undefined => {
  if (
    parsedContent === undefined ||
    toolMessageStatus(parsedContent) !== "completed"
  ) {
    return undefined;
  }
  const path = parsedContent.path;
  if (typeof path !== "string" || path.length === 0) {
    return undefined;
  }
  switch (message.toolName) {
    case "write_file": {
      const mode = typeof parsedContent.mode === "string"
        ? parsedContent.mode
        : "replace";
      return {
        kind: "file_changed",
        change: {
          kind: "update",
          path,
          summary: `write_file ${mode}`,
        },
      };
    }
    case "edit_file": {
      const editsApplied = typeof parsedContent.editsApplied === "number"
        ? parsedContent.editsApplied
        : undefined;
      const replacements = typeof parsedContent.replacements === "number"
        ? parsedContent.replacements
        : undefined;
      return {
        kind: "file_changed",
        change: {
          kind: "update",
          path,
          summary: editsApplied !== undefined || replacements !== undefined
            ? `edit_file applied ${editsApplied ?? "?"} edit(s), ${
              replacements ?? "?"
            } replacement(s)`
            : "edit_file updated file",
        },
      };
    }
    default:
      return undefined;
  }
};

export class HarnessInteractiveChatService {
  readonly #basePromptLoopOptions: CreateHarnessPromptLoopOptions;
  readonly #runIdForTurn?: (sessionId: string, turnId: string) => string;
  readonly #loomLocalHostBinding?: LoomLocalHostBinding;
  readonly #loomLocalHostModel?: string;
  readonly #createPromptLoop: HarnessInteractivePromptLoopFactory;
  readonly #now: () => string;
  readonly #randomUUID: () => string;
  readonly #onEvent?: HarnessInteractiveChatEventListener;
  readonly #onEventDeliveryError?:
    HarnessInteractiveChatEventDeliveryErrorHandler;
  readonly #sessionStore?: HarnessChatSessionStore;
  readonly #maxInMemoryEvents?: number;
  readonly #systemPrompt?: string;
  readonly #sessions = new Map<string, HarnessInteractiveChatSessionRecord>();
  readonly #events: HarnessChatEventEnvelope[] = [];
  #emitQueue: Promise<void> = Promise.resolve();
  #sequence = 0;

  constructor(options: CreateHarnessInteractiveChatServiceOptions = {}) {
    this.#basePromptLoopOptions = options.basePromptLoopOptions ?? {};
    const injectedRunSource = this.#basePromptLoopOptions.engine !== undefined
      ? "engine"
      : this.#basePromptLoopOptions.runState !== undefined
      ? "run state"
      : undefined;
    if (
      options.runIdForTurn !== undefined &&
      injectedRunSource !== undefined
    ) {
      throw new Error(
        `turn run-id mapping cannot be combined with an injected ${injectedRunSource}`,
      );
    }
    this.#runIdForTurn = options.runIdForTurn;
    if (options.systemPrompt !== undefined) {
      this.#systemPrompt = options.systemPrompt;
    }
    this.#loomLocalHostBinding = loomLocalHostBindingFromPromptLoopOptions(
      this.#basePromptLoopOptions,
    );
    const manifestModel = this.#basePromptLoopOptions.runManifest?.model;
    if (
      this.#loomLocalHostBinding !== undefined &&
      this.#basePromptLoopOptions.model !== undefined &&
      manifestModel !== undefined &&
      this.#basePromptLoopOptions.model !== manifestModel
    ) {
      throw new Error(
        "interactive service model does not match its Loom-local run manifest",
      );
    }
    this.#loomLocalHostModel = this.#loomLocalHostBinding === undefined
      ? undefined
      : this.#basePromptLoopOptions.model ?? manifestModel;
    const codexConfigured =
      this.#basePromptLoopOptions.modelProvider === "openai-codex" ||
      this.#basePromptLoopOptions.modelClient?.providerId === "openai-codex";
    if (codexConfigured && options.credentialOwner === undefined) {
      throw new Error(
        "openai-codex interactive services require one explicit authenticated credential owner",
      );
    }
    if (
      codexConfigured &&
      this.#basePromptLoopOptions.credentialOwnerKey !==
        options.credentialOwner!.ownerKey
    ) {
      throw new Error(
        "interactive service credential owner does not match the owner-bound model client",
      );
    }
    if (
      codexConfigured &&
      this.#basePromptLoopOptions.modelClient?.credentialOwner === undefined
    ) {
      throw new Error(
        "openai-codex interactive services require a model client with an exact credential owner binding",
      );
    }
    if (
      codexConfigured &&
      !harnessCredentialOwnersEqual(
        this.#basePromptLoopOptions.modelClient!.credentialOwner!,
        options.credentialOwner!,
      )
    ) {
      throw new Error(
        "interactive service credential owner does not match the model client's full owner binding",
      );
    }
    this.#createPromptLoop = options.createPromptLoop ??
      defaultPromptLoopFactory;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#randomUUID = options.randomUUID ?? defaultRandomUUID;
    this.#onEvent = options.onEvent;
    this.#onEventDeliveryError = options.onEventDeliveryError;
    this.#sessionStore = options.sessionStore;
    if (
      options.maxInMemoryEvents !== undefined &&
      (!Number.isInteger(options.maxInMemoryEvents) ||
        options.maxInMemoryEvents < 0)
    ) {
      throw new Error("maxInMemoryEvents must be a non-negative integer");
    }
    this.#maxInMemoryEvents = options.maxInMemoryEvents;
  }

  /**
   * Loads every session, turn, and event the store holds and settles the
   * turns no process is running. A durable store reaches this service held
   * for its own process — a SQLite store another live process holds is
   * refused at open — so every non-terminal turn it carries was left by a
   * process that has exited.
   */
  async initializeFromStore(): Promise<void> {
    if (this.#sessionStore === undefined) {
      return;
    }
    this.#sessions.clear();
    const turnsBySession = new Map<string, HarnessChatTurnRecord[]>();
    for (const turn of await this.#sessionStore.listTurns()) {
      const turns = turnsBySession.get(turn.sessionId) ?? [];
      turns.push(turn);
      turnsBySession.set(turn.sessionId, turns);
    }
    for (const snapshot of await this.#sessionStore.listSessions()) {
      this.#sessions.set(snapshot.session.sessionId, {
        status: snapshot.session,
        transcript: [...snapshot.transcript],
        ...(snapshot.researchContext === undefined
          ? {}
          : { researchContext: snapshot.researchContext }),
        ...(snapshot.assignedPieces === undefined
          ? {}
          : { assignedPieces: snapshot.assignedPieces }),
        canceledTurnIds: new Set(),
        turns: new Map(
          (turnsBySession.get(snapshot.session.sessionId) ?? []).map((
            turn,
          ) => [turn.turn.turnId, turn]),
        ),
      });
    }
    this.#events.splice(
      0,
      this.#events.length,
      ...await this.#sessionStore.listEvents(),
    );
    this.#pruneInMemoryEvents();
    this.#sequence = Math.max(
      await this.#sessionStore.latestSequence(),
      ...this.#events.map((event) => event.sequence),
    );
    await this.#terminalizeInterruptedTurnsFromStore();
  }

  events(
    sessionId?: string,
    options: Omit<HarnessChatListEventsParams, "sessionId"> = {},
  ): readonly HarnessChatEventEnvelope[] {
    const afterSequence = options.afterSequence ?? 0;
    const filtered = this.#events.filter((event) =>
      (sessionId === undefined || event.sessionId === sessionId) &&
      event.sequence > afterSequence
    );
    return options.limit === undefined
      ? [...filtered]
      : filtered.slice(0, options.limit);
  }

  listEvents(
    params: HarnessChatListEventsParams = {},
  ): HarnessChatListEventsResult {
    return {
      events: this.events(params.sessionId, {
        afterSequence: params.afterSequence,
        limit: params.limit,
      }),
      latestSequence: this.#sequence,
    };
  }

  async listEventsForReplay(
    params: HarnessChatListEventsParams = {},
  ): Promise<HarnessChatListEventsResult> {
    if (this.#sessionStore === undefined) {
      return this.listEvents(params);
    }
    const [events, latestSequence] = await Promise.all([
      this.#sessionStore.listEvents(params),
      this.#sessionStore.latestSequence(),
    ]);
    return { events, latestSequence };
  }

  turns(
    sessionId?: string,
    options: Omit<HarnessChatListTurnsParams, "sessionId"> = {},
  ): readonly HarnessChatTurnRecord[] {
    const turns = [...this.#sessions.values()].flatMap((
      record,
    ) => [...record.turns.values()]).filter((turn) =>
      (sessionId === undefined || turn.sessionId === sessionId) &&
      (options.status === undefined || turn.turn.status === options.status)
    );
    return turns.map((turn) => ({
      ...turn,
      turn: { ...turn.turn },
    }));
  }

  listTurns(
    params: HarnessChatListTurnsParams = {},
  ): HarnessChatListTurnsResult {
    return {
      turns: this.turns(params.sessionId, { status: params.status }),
    };
  }

  async listTurnsForReplay(
    params: HarnessChatListTurnsParams = {},
  ): Promise<HarnessChatListTurnsResult> {
    if (this.#sessionStore === undefined) {
      return this.listTurns(params);
    }
    return {
      turns: await this.#sessionStore.listTurns(params),
    };
  }

  status(sessionId?: string): HarnessChatStatusResult {
    return {
      sessions: [...this.#sessions.values()]
        .map((record) => record.status)
        .filter((status) =>
          sessionId === undefined || status.sessionId === sessionId
        ),
    };
  }

  async waitForTurn(sessionId: string, turnId: string): Promise<void> {
    const record = this.#sessions.get(sessionId);
    if (record?.activeTask === undefined) {
      return;
    }
    await record.activeTask;
    const latest = this.#sessions.get(sessionId);
    if (
      latest?.status.activeTurnId === turnId &&
      latest.activeTask !== undefined
    ) {
      await latest.activeTask;
    }
  }

  async waitForIdle(): Promise<void> {
    while (true) {
      const tasks = [...this.#sessions.values()].flatMap((record) =>
        record.activeTask === undefined ? [] : [record.activeTask]
      );
      if (tasks.length === 0) {
        return;
      }
      await Promise.allSettled(tasks);
    }
  }

  async #terminalizeInterruptedTurnsFromStore(): Promise<void> {
    for (const record of [...this.#sessions.values()]) {
      let normalized: NormalizedHarnessChatTranscript | undefined;
      let malformation: MalformedHarnessChatTranscriptError | undefined;
      try {
        normalized = normalizeIncompleteToolExchanges(record.transcript);
      } catch (error) {
        if (error instanceof MalformedHarnessChatTranscriptError) {
          malformation = error;
        } else {
          throw error;
        }
      }
      const normalizedTranscript = normalized !== undefined &&
          normalized.synthesizedToolCallIds.length > 0
        ? normalized.transcript
        : undefined;
      const recoveryEmitOptions = (
        options: HarnessInteractiveChatEmitOptions = {},
      ): HarnessInteractiveChatEmitOptions =>
        normalizedTranscript === undefined
          ? options
          : { ...options, transcript: normalizedTranscript };

      const activeTurnId = record.status.activeTurnId;
      const activeTurn = activeTurnId === undefined
        ? undefined
        : record.turns.get(activeTurnId);
      if (activeTurnId !== undefined && activeTurn === undefined) {
        await this.#emit(record.status.sessionId, activeTurnId, {
          kind: "turn_failed",
          turnId: activeTurnId,
          error: interruptedTurnError(
            activeTurnId,
            record.status.activeTurn?.status ?? "running",
          ),
        }, recoveryEmitOptions());
      } else if (
        activeTurn !== undefined &&
        isTerminalTurnStatus(activeTurn.turn.status)
      ) {
        const updatedAt = this.#now();
        const session = clearActiveTurnStatus(record.status, updatedAt);
        const nextTurn = activeTurnId === undefined ? undefined : activeTurn;
        await this.#emit(
          record.status.sessionId,
          undefined,
          {
            kind: "status_changed",
            session,
          },
          recoveryEmitOptions(
            nextTurn === undefined ? {} : { turnRecord: nextTurn },
          ),
        );
      }

      for (const turn of [...record.turns.values()]) {
        if (isTerminalTurnStatus(turn.turn.status)) {
          continue;
        }
        if (turn.turn.status === "canceling") {
          const updatedAt = this.#now();
          const nextTurn = this.#updatedTurnRecord(record, turn.turn.turnId, {
            status: "canceled",
            updatedAt,
            endedAt: updatedAt,
            cancelReason: turn.turn.cancelReason ?? "process_interrupted",
          });
          if (record.status.activeTurnId === turn.turn.turnId) {
            const session = clearActiveTurnStatus(record.status, updatedAt);
            await this.#emit(
              record.status.sessionId,
              undefined,
              {
                kind: "status_changed",
                session,
              },
              recoveryEmitOptions(
                nextTurn === undefined ? {} : { turnRecord: nextTurn },
              ),
            );
          } else if (nextTurn !== undefined) {
            const session = {
              ...record.status,
              updatedAt,
            };
            await this.#emit(record.status.sessionId, undefined, {
              kind: "status_changed",
              session,
            }, recoveryEmitOptions({ turnRecord: nextTurn }));
          }
          continue;
        }
        await this.#emit(record.status.sessionId, turn.turn.turnId, {
          kind: "turn_failed",
          turnId: turn.turn.turnId,
          error: interruptedTurnError(turn.turn.turnId, turn.turn.status),
        }, recoveryEmitOptions());
      }

      if (malformation !== undefined) {
        // Terminalization can make a session reusable, so apply the malformed
        // transcript refusal only after every interrupted turn is settled.
        record.recoveryError = malformedTranscriptChatError(malformation);
        if (record.status.reusable) {
          const updatedAt = this.#now();
          await this.#emit(record.status.sessionId, undefined, {
            kind: "status_changed",
            session: { ...record.status, reusable: false, updatedAt },
          });
        }
        continue;
      }
      if (normalizedTranscript === undefined) {
        // A safe transcript does not explain a durable `reusable=false` marker.
        // Preserve that refusal rather than inferring that the session is safe.
        if (!record.status.reusable) {
          record.recoveryError = unresumableSessionError(
            record.status.sessionId,
          );
        }
        continue;
      }
      if (record.transcript === normalizedTranscript) {
        continue;
      }
      const updatedAt = this.#now();
      // No turn needed terminalization, so persist normalized history on its
      // own status event. Adoption still happens only after the write commits.
      try {
        await this.#emit(record.status.sessionId, undefined, {
          kind: "status_changed",
          session: { ...record.status, updatedAt },
        }, { transcript: normalizedTranscript });
      } catch (error) {
        // #emit adopts the transcript only after the store commit, before it
        // notifies the listener. A listener fault must still propagate, but it
        // cannot turn already-durable provider-safe history into a refusal.
        if (record.transcript !== normalizedTranscript) {
          record.recoveryError = normalizationPersistenceError(
            record.status.sessionId,
          );
        }
        throw error;
      }
    }
  }

  async handleRequest(
    request: HarnessChatRequestEnvelope,
  ): Promise<HarnessChatResponse> {
    const requestId = request.requestId;
    const method = String(request.method);
    switch (request.method) {
      case "start_session":
        return await this.startSession(request.requestId, request.params);
      case "start_turn":
        return await this.startTurn(request.requestId, request.params);
      case "cancel_turn":
        return await this.cancelTurn(
          request.requestId,
          request.params.sessionId,
          request.params.turnId,
          request.params.reason,
        );
      case "close_session":
        return await this.closeSession(
          request.requestId,
          request.params.sessionId,
          request.params.reason,
        );
      case "status":
        return createHarnessChatOkResponse(
          request.requestId,
          this.status(request.params.sessionId),
        );
      case "list_events":
        return createHarnessChatOkResponse(
          request.requestId,
          await this.listEventsForReplay(request.params),
        );
      case "list_turns":
        return createHarnessChatOkResponse(
          request.requestId,
          await this.listTurnsForReplay(request.params),
        );
      default:
        return createHarnessChatErrorResponse(requestId, {
          code: "invalid_request",
          message: `unsupported chat request method: ${method}`,
        });
    }
  }

  async startSession(
    requestId: string,
    params: HarnessChatStartSessionParams,
  ): Promise<HarnessChatResponse<HarnessChatSessionStatus>> {
    const sessionId = params.sessionId ?? this.#randomUUID();
    if (this.#sessions.has(sessionId)) {
      return sessionExistsError(requestId, sessionId);
    }
    if (await this.#sessionStore?.getSession(sessionId) !== undefined) {
      return sessionExistsError(requestId, sessionId);
    }
    if (this.#sessions.has(sessionId)) {
      return sessionExistsError(requestId, sessionId);
    }
    if (
      this.#loomLocalHostModel !== undefined && params.model !== undefined &&
      params.model !== this.#loomLocalHostModel
    ) {
      return providerMismatchError(
        requestId,
        "chat session model does not match the local Loom host binding",
      );
    }
    const model = this.#loomLocalHostModel ?? params.model;
    if (
      this.#loomLocalHostBinding !== undefined &&
      (model === undefined || model.trim() === "")
    ) {
      return providerMismatchError(
        requestId,
        "local Loom chat sessions require a durable model binding",
      );
    }
    const session = createHarnessChatSessionStatus({
      sessionId,
      createdAt: this.#now(),
      workspace: params.workspace,
      context: params.context,
      model,
      loomLocalHostBinding: this.#loomLocalHostBinding,
      artifactRoot: params.artifactRoot,
      capabilities: params.capabilities,
      policy: resolveHarnessChatPolicy(
        params.policy,
        params.context,
        this.#basePromptLoopOptions.loomAuthoring?.allowCommentThreads === true,
      ),
      browserAccess: params.browserAccess,
      metadata: params.metadata,
    });
    this.#sessions.set(session.sessionId, {
      status: session,
      transcript: [],
      canceledTurnIds: new Set(),
      turns: new Map(),
    });
    try {
      await this.#emit(session.sessionId, undefined, {
        kind: "session_started",
        session,
      });
    } catch (error) {
      this.#sessions.delete(session.sessionId);
      throw error;
    }
    return createHarnessChatOkResponse(requestId, session);
  }

  async startTurn(
    requestId: string,
    params: HarnessChatStartTurnParams,
  ): Promise<HarnessChatResponse<HarnessChatTurnStatus>> {
    if (
      params.input.loomId !== undefined &&
      (typeof params.input.loomId !== "string" ||
        !/^loom-[a-f0-9]{16}$/.test(params.input.loomId))
    ) {
      return createHarnessChatErrorResponse(requestId, {
        code: "invalid_request",
        message: "loomId must be a canonical Loom identifier",
      });
    }
    const record = this.#sessions.get(params.sessionId);
    if (record === undefined) {
      return sessionNotFoundError(requestId, params.sessionId);
    }
    if (this.#loomLocalHostBinding !== undefined) {
      if (
        !loomLocalHostBindingsEqual(
          this.#loomLocalHostBinding,
          record.status.loomLocalHostBinding,
        )
      ) {
        return providerMismatchError(
          requestId,
          "durable chat session does not match the local Loom host binding",
        );
      }
      if (
        record.status.model === undefined || record.status.model.trim() === ""
      ) {
        return providerMismatchError(
          requestId,
          "durable chat session is missing its model binding",
        );
      }
      if (
        this.#loomLocalHostModel !== undefined &&
        record.status.model !== this.#loomLocalHostModel
      ) {
        return providerMismatchError(
          requestId,
          "durable chat session model does not match the local Loom host binding",
        );
      }
    }
    if (record.status.status === "closed") {
      return sessionClosedError(requestId, params.sessionId);
    }
    if (record.recoveryError !== undefined) {
      return createHarnessChatErrorResponse(requestId, record.recoveryError);
    }
    let normalizedTranscript: NormalizedHarnessChatTranscript;
    try {
      normalizedTranscript = normalizeIncompleteToolExchanges(
        record.transcript,
      );
    } catch (error) {
      if (error instanceof MalformedHarnessChatTranscriptError) {
        return malformedTranscriptError(requestId, error);
      }
      throw error;
    }
    // Under the durable checkpoint invariant this holds by construction. It is
    // kept after legacy normalization so a regression surfaces here, named,
    // instead of as an opaque provider rejection several layers away.
    if (!isResumableHarnessTranscript(normalizedTranscript.transcript)) {
      return createHarnessChatErrorResponse(requestId, {
        code: "incomplete_transcript",
        message: `chat session history is not resumable: ${params.sessionId}`,
      });
    }
    if (record.activeTask !== undefined) {
      return activeTurnError(requestId, record.status);
    }
    if (record.status.activeTurnId !== undefined) {
      return activeTurnError(requestId, record.status);
    }
    if (record.startingTurnId !== undefined) {
      return activeTurnError(requestId, record.status, record.startingTurnId);
    }
    const context = params.context ?? record.status.context;
    const policy = resolveHarnessChatPolicy(
      params.policy ?? record.status.policy,
      context,
      this.#basePromptLoopOptions.loomAuthoring?.allowCommentThreads === true,
    );
    const browserAccess = params.browserAccess ?? record.status.browserAccess;
    if (
      policy.allowedSubagentProfiles.includes(BROWSER_SUBAGENT_PROFILE) &&
      browserAccess === undefined
    ) {
      return browserAccessRequiredError(requestId);
    }

    const turnId = params.turnId ?? this.#randomUUID();
    if (record.turns.has(turnId)) {
      return turnExistsError(requestId, params.sessionId, turnId);
    }

    const startedAt = this.#now();
    const turn: HarnessChatTurnStatus = {
      turnId,
      status: "running",
      startedAt,
      updatedAt: startedAt,
    };
    const turnRecord: HarnessChatTurnRecord = {
      sessionId: params.sessionId,
      turn,
      input: params.input,
      policy,
      ...(context !== undefined ? { context } : {}),
      ...(browserAccess !== undefined ? { browserAccess } : {}),
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
    };
    record.startingTurnId = turn.turnId;
    record.startingTurn = turn;
    try {
      if (
        await this.#sessionStore?.getTurn(params.sessionId, turnId) !==
          undefined
      ) {
        return turnExistsError(requestId, params.sessionId, turnId);
      }
      await this.#emit(params.sessionId, turn.turnId, {
        kind: "turn_started",
        turn,
      }, {
        turnRecord,
        createTurn: true,
        ...(normalizedTranscript.synthesizedToolCallIds.length > 0
          ? { transcript: normalizedTranscript.transcript }
          : {}),
      });
    } catch (error) {
      if (error instanceof DurableTurnExistsError) {
        return turnExistsError(requestId, params.sessionId, turnId);
      }
      throw error;
    } finally {
      if (record.startingTurnId === turn.turnId) {
        record.startingTurnId = undefined;
        record.startingTurn = undefined;
      }
    }

    const updatedRecord = this.#sessions.get(params.sessionId);
    if (updatedRecord === undefined) {
      return sessionNotFoundError(requestId, params.sessionId);
    }
    const abortController = new AbortController();
    const turnTask = this.#runTurn(
      updatedRecord,
      turn.turnId,
      params,
      abortController.signal,
      policy,
      browserAccess,
    );
    const activeTurnToken = {};
    const finalizeTask = () =>
      this.#finalizeTurnTask(params.sessionId, turn.turnId, activeTurnToken);
    const task = turnTask.then(finalizeTask, finalizeTask).catch(() => {});
    updatedRecord.activeTurnToken = activeTurnToken;
    updatedRecord.activeTask = task;
    updatedRecord.activeAbortController = abortController;
    return createHarnessChatOkResponse(requestId, turn);
  }

  async cancelTurn(
    requestId: string,
    sessionId: string,
    turnId?: string,
    reason = "canceled",
  ): Promise<HarnessChatResponse<HarnessChatSessionStatus>> {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      return sessionNotFoundError(requestId, sessionId);
    }
    if (record.status.activeTurnId === undefined) {
      return turnNotFoundError(requestId, sessionId);
    }
    if (turnId !== undefined && record.status.activeTurnId !== turnId) {
      return turnNotFoundError(requestId, sessionId);
    }
    const activeTurnId = record.status.activeTurnId;
    record.canceledTurnIds.add(activeTurnId);
    record.activeAbortController?.abort(
      createTurnAbortError(activeTurnId, reason),
    );
    await this.#emit(sessionId, activeTurnId, {
      kind: "turn_canceled",
      turnId: activeTurnId,
      reason,
    });
    return createHarnessChatOkResponse(
      requestId,
      this.#sessions.get(sessionId)!.status,
    );
  }

  async #finalizeTurnTask(
    sessionId: string,
    turnId: string,
    activeTurnToken: object,
  ): Promise<void> {
    const latest = this.#sessions.get(sessionId);
    if (latest?.activeTurnToken !== activeTurnToken) {
      return;
    }
    latest.activeTurnToken = undefined;
    latest.activeTask = undefined;
    latest.activeAbortController = undefined;
    latest.canceledTurnIds.delete(turnId);
    if (
      latest.status.status === "canceling" &&
      latest.status.activeTurnId === turnId
    ) {
      const updatedAt = this.#now();
      const nextTurn = this.#updatedTurnRecord(latest, turnId, {
        status: "canceled",
        updatedAt,
        endedAt: updatedAt,
        cancelReason: latest.status.activeTurn?.cancelReason,
      });
      const session = clearActiveTurnStatus(latest.status, updatedAt);
      await this.#emit(sessionId, undefined, {
        kind: "status_changed",
        session,
      }, nextTurn === undefined ? {} : { turnRecord: nextTurn });
    }
  }

  async closeSession(
    requestId: string,
    sessionId: string,
    reason = "closed",
  ): Promise<HarnessChatResponse<HarnessChatSessionStatus>> {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      return sessionNotFoundError(requestId, sessionId);
    }
    if (record.status.activeTurnId !== undefined) {
      const activeTurnId = record.status.activeTurnId;
      record.canceledTurnIds.add(activeTurnId);
      record.activeAbortController?.abort(
        createTurnAbortError(activeTurnId, reason),
      );
      await this.#emit(sessionId, activeTurnId, {
        kind: "turn_canceled",
        turnId: activeTurnId,
        reason,
      });
    }
    await this.#emit(sessionId, undefined, {
      kind: "session_closed",
      reason,
    });
    return createHarnessChatOkResponse(
      requestId,
      this.#sessions.get(sessionId)!.status,
    );
  }

  async #runTurn(
    record: HarnessInteractiveChatSessionRecord,
    turnId: string,
    params: HarnessChatStartTurnParams,
    signal: AbortSignal,
    policy: HarnessChatPolicy,
    browserAccess: HarnessChatBrowserAccessLease | undefined,
  ): Promise<void> {
    const session = record.status;
    const researchGoal = record.researchContext?.researchGoal ??
      params.input.text;
    const inputCells = params.inputCells?.length
      ? params.inputCells
      : record.assignedPieces?.length
      ? record.assignedPieces.map(({ slug, ref }) => ({ name: slug, ref }))
      : undefined;
    // Seeded only when the durable history carries no system message. A turn
    // persists the transcript it ran, so the second turn of a seeded session
    // finds the message already there and prepends nothing.
    const seededSystemPrompt: readonly HarnessTranscriptMessage[] =
      this.#systemPrompt !== undefined &&
        !record.transcript.some((message) => message.role === "system")
        ? [{ role: "system", content: this.#systemPrompt }]
        : [];
    let observedTranscriptLength = 0;
    let completedCheckpoint: {
      transcript: HarnessTranscriptMessage[];
      researchContext: HarnessChatResearchContext;
    } | undefined;
    // The `delegate_task` children this turn has announced, keyed by the
    // parent tool call that started each one. Membership is what closes the
    // bracket: a `subagent_completed` is emitted only for a child whose
    // `subagent_started` this turn already wrote.
    const startedSubagents = new Map<string, HarnessChatSubagentSummary>();

    try {
      const { loop, contextMessages } = await this.#startPromptLoop(
        {
          ...this.#buildPromptLoopOptions(
            session,
            turnId,
            policy,
            browserAccess,
            inputCells,
            params.patternRefs,
            params.input.loomId,
          ),
          taskText: params.input.text,
          researchGoal,
          ...(record.researchContext === undefined ? {} : {
            inheritedResearchRuns: record.researchContext.runs.map((run) => ({
              ...run,
              historical: true as const,
            })),
            inheritedCfcModelContext: record.researchContext.cfcModelContext,
          }),
        },
      );
      // The context messages announce what this turn's own run holds — its
      // preloaded skills, its granted references, its input cells, its
      // attached patterns — so they sit immediately before the request they
      // are held for, after the history the session already had.
      const transcript: HarnessTranscriptMessage[] = [
        ...seededSystemPrompt,
        ...record.transcript,
        ...(this.#basePromptLoopOptions.loomAuthoring === undefined ? [] : [{
          role: "user" as const,
          content: params.input.loomId === undefined
            ? "Host Loom context: this turn has no originating Loom. Use loom_authoring_context to recover historical receipts; history does not select a target or count as new work."
            : `Host Loom context: this turn originates in ${params.input.loomId}. Inspect that exact target before extending it. A request to create a separate Loom still creates one. Historical receipts are not new work.`,
        }]),
        ...contextMessages.map((content) =>
          ({ role: "user", content }) as const
        ),
        {
          role: "user",
          content: params.input.text,
          ...(params.input.imageAttachments !== undefined &&
              params.input.imageAttachments.length > 0
            ? { imageAttachments: params.input.imageAttachments }
            : {}),
        },
      ];
      // Prompt loops replay their initial transcript through
      // onTranscriptEvent. Those messages are durable history, not activity
      // from this turn: in particular, a recovered unknown-outcome result must
      // not be re-emitted as a newly completed tool call.
      observedTranscriptLength = transcript.length;
      const result = await loop.runTranscript({
        transcript,
        ...(record.researchContext?.runs.length
          ? {}
          : { openingResearchTask: params.input.text }),
        model: session.model,
        promptSlotBinding: policy.promptSlot,
        signal,
        onCheckpoint: (checkpoint) => {
          if (
            !this.#basePromptLoopOptions.finalizeOnTurnLimit ||
            record.canceledTurnIds.has(turnId) ||
            !isResumableHarnessTranscript(checkpoint.transcript)
          ) return;
          const transcript = structuredClone([...checkpoint.transcript]);
          restoreHarnessTranscriptOmissions(
            transcript,
            createHarnessTranscriptOmissions(checkpoint.transcript),
          );
          completedCheckpoint = {
            transcript,
            researchContext: structuredClone({
              researchGoal,
              runs: selectResearchContext(
                checkpoint.runState.researchRuns ?? [],
              ),
              ...(checkpoint.runState.cfcModelContext === undefined ? {} : {
                cfcModelContext: checkpoint.runState.cfcModelContext,
              }),
            }),
          };
        },
        onTranscriptEvent: async (event) => {
          if (record.canceledTurnIds.has(turnId)) {
            return;
          }
          if (event.subagent !== undefined) {
            // A child carries its own transcript, whose length says nothing
            // about the parent's, and a child loop runs once rather than
            // replaying seeded history. Its messages therefore bypass the
            // parent's replay gate entirely.
            await this.#emitSubagentTranscriptEvent(
              session.sessionId,
              turnId,
              startedSubagents,
              event.subagent,
              event,
            );
            return;
          }
          // The loop replays the transcript it was seeded with before it
          // appends anything. Emitting those messages again would duplicate
          // their tool and assistant events in an append-only log, so only a
          // strictly longer snapshot is worth reporting.
          if (event.transcript.length <= observedTranscriptLength) {
            return;
          }
          observedTranscriptLength = event.transcript.length;
          await this.#emitTranscriptEvent(
            session.sessionId,
            turnId,
            event,
            startedSubagents,
          );
        },
      });
      if (record.canceledTurnIds.has(turnId)) {
        return;
      }
      // A loop that reports success still has to hand back history a provider
      // accepts. Checking here keeps an unpaired transcript from being promoted
      // and advertised as reusable, rather than leaving it to be discovered on
      // the next turn.
      if (!isResumableHarnessTranscript(result.transcript)) {
        throw new HarnessIncompleteTranscriptError(turnId);
      }
      // The copy keeps the durable checkpoint independent of the array the loop
      // appended to. Passing it through the emit promotes it inside the same
      // transaction that records `turn_completed`, and only if that commits.
      await this.#emit(session.sessionId, turnId, {
        kind: "turn_completed",
        turnId,
        ...(result.taskOutcome ?? { outcome: "completed" as const }),
        finalText: result.finalAssistantText,
        ...((result.totalUsage ?? result.usage) !== undefined
          ? { usage: result.totalUsage ?? result.usage }
          : {}),
      }, {
        transcript: [...result.transcript],
        researchContext: {
          researchGoal,
          runs: selectResearchContext(result.runState.researchRuns ?? []),
          ...(result.runState.cfcModelContext === undefined
            ? {}
            : { cfcModelContext: result.runState.cfcModelContext }),
        },
        ...(result.runState.assignedPieces?.length
          ? { assignedPieces: result.runState.assignedPieces }
          : params.inputCells?.length
          ? { assignedPieces: [] }
          : {}),
      });
    } catch (error) {
      if (record.canceledTurnIds.has(turnId)) {
        return;
      }
      // A turn that already reached a terminal status committed its outcome
      // before this threw, which leaves delivering the event as the only thing
      // that can have failed. Recording the turn as failed on the strength of
      // that would overwrite an outcome the store already holds, so the turn is
      // left as it finished and the failure stays a delivery failure.
      if (isTerminalTurnStatus(record.turns.get(turnId)?.turn.status)) {
        return;
      }
      // Promote completed evidence atomically with the failure. Unpaired
      // activity remains solely in the audit trail and run artifacts.
      await this.#emit(session.sessionId, turnId, {
        kind: "turn_failed",
        turnId,
        error: chatTurnError(error),
      }, completedCheckpoint);
    }
  }

  /**
   * Starts a turn's loop on a run that already holds everything it was
   * configured with, and returns the context messages announcing it.
   *
   * A turn is its own run, so this happens per turn against the engine this
   * builds and hands to the loop: the skill registry has to be on the run
   * state before the first model turn for `read_skill_resource` to answer and
   * for a delegated subagent to inherit its profile's preloaded skills, and
   * the grants and input cells mint their tokens into that run's own handle
   * table — the tokens a turn is told about are the ones its own run holds.
   *
   * Tools reach the tree on the host here, so the skills scan records host
   * paths and no sandbox mount is involved.
   */
  async #startPromptLoop(
    options: CreateHarnessPromptLoopOptions,
  ): Promise<{
    loop: HarnessInteractivePromptLoop;
    contextMessages: readonly string[];
  }> {
    // The skills root reaches this either way: on the options directly, or on
    // an injected engine's own config (where `options.skillsRoot` is unset).
    // Read both so neither shape is missed.
    const skillsRoot = options.engine?.config.skillsRoot ?? options.skillsRoot;
    const fabricSession = options.engine?.config.fabricSession ??
      options.fabricSession;
    if (
      options.engine === undefined && skillsRoot === undefined &&
      fabricSession === undefined &&
      (options.inputCells?.length ?? 0) === 0 &&
      (options.patternRefs?.length ?? 0) === 0
    ) {
      // Nothing configured needs a run to be brought up before its first model
      // turn, and constructing an engine to discover that would build a
      // sandbox runtime for a turn that has no use for one.
      return {
        loop: this.#createPromptLoop(options),
        contextMessages: [
          ...pieceTargetingContextMessages([]),
          REVISION_VERIFICATION_GUIDANCE,
        ],
      };
    }
    const engine = options.engine ?? new CfHarnessEngine(options);
    const contextMessages = await establishHarnessSessionContext({
      engine,
      config: {
        ...(skillsRoot !== undefined ? { skillsRoot } : {}),
        skillNames: [],
      },
      onGrantsUnavailable: (error) =>
        console.error("fabric grants unavailable for this turn:", error),
    });
    return {
      loop: this.#createPromptLoop({ ...options, engine }),
      contextMessages,
    };
  }

  #buildPromptLoopOptions(
    session: HarnessChatSessionStatus,
    turnId: string,
    policy: HarnessChatPolicy,
    browserAccess?: HarnessChatBrowserAccessLease,
    inputCells?: readonly HarnessInputCellSpec[],
    patternRefs?: readonly HarnessPatternRefSpec[],
    loomId?: string,
  ): CreateHarnessPromptLoopOptions {
    const loomAuthoring = loomAuthoringForTurn(
      this.#basePromptLoopOptions.loomAuthoring,
      session.sessionId,
      loomId,
    );
    return {
      ...this.#basePromptLoopOptions,
      ...(loomAuthoring !== undefined ? { loomAuthoring } : {}),
      ...(inputCells !== undefined && inputCells.length > 0
        ? { inputCells }
        : {}),
      ...(patternRefs !== undefined && patternRefs.length > 0
        ? { patternRefs }
        : {}),
      ...(session.workspace?.hostPath !== undefined
        ? { workspaceHostPath: session.workspace.hostPath }
        : {}),
      ...(session.workspace?.cwd !== undefined
        ? { cwd: session.workspace.cwd }
        : {}),
      ...(session.model !== undefined ? { model: session.model } : {}),
      ...(this.#runIdForTurn !== undefined
        ? { runId: this.#runIdForTurn(session.sessionId, turnId) }
        : {}),
      ...(this.#loomLocalHostBinding !== undefined &&
          session.model !== undefined
        ? {
          runManifest: {
            ...this.#basePromptLoopOptions.runManifest!,
            model: session.model,
          },
        }
        : {}),
      ...(session.artifactRoot !== undefined
        ? { artifactRoot: session.artifactRoot }
        : {}),
      cacheAffinityKey: `interactive:${session.sessionId}`,
      allowedToolIds: policy.allowedToolIds,
      allowedSubagentProfiles: policy.allowedSubagentProfiles,
      ...(browserAccess !== undefined ? { browserAccess } : {}),
      ...(policy.cfcEnforcementMode !== undefined
        ? { cfcEnforcementModeOverride: policy.cfcEnforcementMode }
        : {}),
    };
  }

  async #emitTranscriptEvent(
    sessionId: string,
    turnId: string,
    event: Parameters<
      NonNullable<RunHarnessTranscriptOptions["onTranscriptEvent"]>
    >[0],
    startedSubagents: Map<string, HarnessChatSubagentSummary>,
  ): Promise<void> {
    switch (event.message.role) {
      case "assistant":
        await this.#emitAssistantMessage(sessionId, turnId, event.message);
        break;
      case "tool":
        // The parent's own result for a `delegate_task` call closes that
        // child's bracket, and does so before the parent tool line, so the
        // nested block ends where the entry containing it reports.
        await this.#emitSubagentCompletion(
          sessionId,
          turnId,
          startedSubagents,
          event.message,
        );
        await this.#emitToolMessage(sessionId, turnId, event.message);
        break;
      case "system":
      case "user":
        break;
    }
  }

  /**
   * Derives from a `delegate_task` child's message exactly what the parent
   * path derives from its own, tagged with the child it came from. Sharing the
   * derivation is what keeps the withholding shared: a child tool result is
   * summarized from the model-facing content the child's loop wrote, never
   * from raw tool output.
   */
  async #emitSubagentTranscriptEvent(
    sessionId: string,
    turnId: string,
    startedSubagents: Map<string, HarnessChatSubagentSummary>,
    context: HarnessTranscriptSubagentContext,
    event: Parameters<
      NonNullable<RunHarnessTranscriptOptions["onTranscriptEvent"]>
    >[0],
  ): Promise<void> {
    if (event.message.role === "system" || event.message.role === "user") {
      return;
    }
    const subagent = await this.#startSubagent(
      sessionId,
      turnId,
      startedSubagents,
      context,
    );
    if (event.message.role === "assistant") {
      await this.#emitAssistantMessage(
        sessionId,
        turnId,
        event.message,
        subagent,
      );
      return;
    }
    await this.#emitToolMessage(sessionId, turnId, event.message, subagent);
  }

  async #startSubagent(
    sessionId: string,
    turnId: string,
    startedSubagents: Map<string, HarnessChatSubagentSummary>,
    context: HarnessTranscriptSubagentContext,
  ): Promise<HarnessChatSubagentRef> {
    const existing = startedSubagents.get(context.parentToolCallId);
    if (existing !== undefined) {
      return existing;
    }
    const subagent: HarnessChatSubagentSummary = {
      parentToolCallId: context.parentToolCallId,
      childRunId: context.childRunId,
      profile: context.profile,
      goal: context.goal,
    };
    startedSubagents.set(context.parentToolCallId, subagent);
    await this.#emit(sessionId, turnId, {
      kind: "subagent_started",
      subagent,
    });
    return subagent;
  }

  async #emitSubagentCompletion(
    sessionId: string,
    turnId: string,
    startedSubagents: Map<string, HarnessChatSubagentSummary>,
    message: HarnessToolTranscriptMessage,
  ): Promise<void> {
    // A child that died before its first message never announced itself, so
    // its start is synthesized from the delegate output's own manifest —
    // otherwise the failure below has no subagent to hang on and the viewer
    // sees a delegation that simply never happened.
    const parsedForStart = parseToolMessageContent(message.content);
    const manifest = typeof parsedForStart?.subagent === "object" &&
        parsedForStart.subagent !== null
      ? (parsedForStart.subagent as {
        manifest?: { childRunId?: string; profile?: string };
      }).manifest
      : undefined;
    let subagent = startedSubagents.get(message.toolCallId);
    if (
      subagent === undefined && typeof manifest?.childRunId === "string" &&
      typeof manifest.profile === "string" &&
      isHarnessSubagentProfile(manifest.profile)
    ) {
      subagent = await this.#startSubagent(
        sessionId,
        turnId,
        startedSubagents,
        {
          parentToolCallId: message.toolCallId,
          childRunId: manifest.childRunId,
          profile: manifest.profile,
          // The manifest carries the goal's digest, not its text, so a
          // synthesized start has none to show; the failure event that
          // follows is the point.
          goal: "",
        },
      );
    }
    if (subagent === undefined) {
      return;
    }
    startedSubagents.delete(message.toolCallId);
    // A delegate_task output carries the child's verdict at
    // `subagent.status`, not at the generic `ok` the tool-message reading
    // knows — read the specific field first, or a failed child announces
    // itself completed.
    const parsed = parseToolMessageContent(message.content);
    const childStatus =
      typeof parsed?.subagent === "object" && parsed.subagent !== null &&
        (parsed.subagent as { status?: unknown }).status === "failed"
        ? "failed"
        : toolMessageStatus(parsed);
    await this.#emit(sessionId, turnId, {
      kind: "subagent_completed",
      subagent,
      status: childStatus === "completed" ? "completed" : "failed",
    });
  }

  async #emitAssistantMessage(
    sessionId: string,
    turnId: string,
    message: HarnessAssistantTranscriptMessage,
    subagent?: HarnessChatSubagentRef,
  ): Promise<void> {
    const tag = subagent === undefined ? {} : { subagent };
    for (const toolCall of message.toolCalls ?? []) {
      await this.#emit(sessionId, turnId, {
        kind: "tool_started",
        tool: {
          toolCallId: toolCall.id,
          toolId: toolCall.function.name,
        },
        ...tag,
      });
    }
    if (message.content.length === 0) {
      return;
    }
    await this.#emit(sessionId, turnId, {
      kind: "assistant_delta",
      text: message.content,
      ...tag,
    });
    await this.#emit(sessionId, turnId, {
      kind: "assistant_completed",
      text: message.content,
      ...tag,
    });
  }

  async #emitToolMessage(
    sessionId: string,
    turnId: string,
    message: HarnessToolTranscriptMessage,
    subagent?: HarnessChatSubagentRef,
  ): Promise<void> {
    const tag = subagent === undefined ? {} : { subagent };
    const parsedContent = parseToolMessageContent(message.content);
    const status = toolMessageStatus(parsedContent);
    await this.#emit(sessionId, turnId, {
      kind: "tool_completed",
      status,
      tool: {
        toolCallId: message.toolCallId,
        toolId: message.toolName,
      },
      resultSummary: message.content,
      ...tag,
    });
    const fileChange = fileChangeFromToolMessage(message, parsedContent);
    if (fileChange !== undefined) {
      await this.#emit(sessionId, turnId, { ...fileChange, ...tag });
    }
  }

  #updatedTurnRecord(
    record: HarnessInteractiveChatSessionRecord,
    turnId: string,
    update:
      & Pick<HarnessChatTurnStatus, "status" | "updatedAt">
      & Partial<
        Pick<HarnessChatTurnStatus, "endedAt" | "cancelReason" | "error">
      >,
  ): HarnessChatTurnRecord | undefined {
    const current = record.turns.get(turnId);
    if (current === undefined) {
      return undefined;
    }
    return {
      ...current,
      turn: {
        ...current.turn,
        ...update,
      },
    };
  }

  #turnRecordFromEvent(
    record: HarnessInteractiveChatSessionRecord,
    envelope: HarnessChatEventEnvelope,
  ): HarnessChatTurnRecord | undefined {
    switch (envelope.event.kind) {
      case "turn_started":
        return this.#updatedTurnRecord(record, envelope.event.turn.turnId, {
          status: envelope.event.turn.status,
          updatedAt: envelope.event.turn.updatedAt,
        });
      case "turn_canceled":
        return this.#updatedTurnRecord(record, envelope.event.turnId, {
          status: "canceling",
          updatedAt: envelope.emittedAt,
          cancelReason: envelope.event.reason,
        });
      case "turn_completed":
        return this.#updatedTurnRecord(record, envelope.event.turnId, {
          status: "completed",
          updatedAt: envelope.emittedAt,
          endedAt: envelope.emittedAt,
        });
      case "turn_failed":
        return this.#updatedTurnRecord(record, envelope.event.turnId, {
          status: "failed",
          updatedAt: envelope.emittedAt,
          endedAt: envelope.emittedAt,
          error: envelope.event.error,
        });
      case "session_closed": {
        const activeTurnId = record.status.activeTurnId;
        return activeTurnId === undefined
          ? undefined
          : this.#updatedTurnRecord(record, activeTurnId, {
            status: "canceled",
            updatedAt: envelope.emittedAt,
            endedAt: envelope.emittedAt,
            cancelReason: envelope.event.reason,
          });
      }
      default:
        return undefined;
    }
  }

  async #emit(
    sessionId: string,
    turnId: string | undefined,
    event: HarnessChatStructuredEvent,
    options: HarnessInteractiveChatEmitOptions = {},
  ): Promise<void> {
    const emitTask = this.#emitQueue.then(() =>
      this.#emitImmediately(sessionId, turnId, event, options)
    );
    this.#emitQueue = emitTask.catch(() => undefined);
    return await emitTask;
  }

  async #emitImmediately(
    sessionId: string,
    turnId: string | undefined,
    event: HarnessChatStructuredEvent,
    options: HarnessInteractiveChatEmitOptions,
  ): Promise<void> {
    const sequence = this.#sequence + 1;
    const envelope = createHarnessChatEventEnvelope({
      sessionId,
      ...(turnId !== undefined ? { turnId } : {}),
      sequence,
      emittedAt: this.#now(),
      event,
    });
    const record = this.#sessions.get(sessionId);
    const transcript = options.transcript ?? record?.transcript ?? [];
    const researchContext = options.researchContext ?? record?.researchContext;
    const researchSnapshot = researchContext === undefined
      ? {}
      : { researchContext };
    const assignedPieces = options.assignedPieces ?? record?.assignedPieces;
    const pieceSnapshot = assignedPieces === undefined
      ? {}
      : { assignedPieces };
    const nextStatus = record === undefined
      ? undefined
      : reduceHarnessChatSessionStatus(record.status, envelope);
    const nextTurn = options.turnRecord ??
      (record === undefined
        ? undefined
        : this.#turnRecordFromEvent(record, envelope));
    if (record !== undefined && nextStatus !== undefined) {
      if (nextTurn !== undefined) {
        const saved = await this.#sessionStore?.saveSessionTurnAndAppendEvent({
          session: {
            session: nextStatus,
            transcript,
            ...researchSnapshot,
            ...pieceSnapshot,
          },
          turn: nextTurn,
          event: envelope,
          ...(options.createTurn ? { createTurn: true } : {}),
        });
        if (saved === false) {
          throw new DurableTurnExistsError(sessionId, nextTurn.turn.turnId);
        }
      } else {
        await this.#sessionStore?.saveSessionAndAppendEvent({
          session: nextStatus,
          transcript,
          ...researchSnapshot,
          ...pieceSnapshot,
        }, envelope);
      }
    } else {
      await this.#sessionStore?.appendEvent(envelope);
    }
    this.#sequence = sequence;
    this.#events.push(envelope);
    this.#pruneInMemoryEvents();
    if (record !== undefined && options.transcript !== undefined) {
      record.transcript = options.transcript;
    }
    if (record !== undefined && options.researchContext !== undefined) {
      record.researchContext = options.researchContext;
    }
    if (record !== undefined && options.assignedPieces !== undefined) {
      record.assignedPieces = options.assignedPieces;
    }
    if (record !== undefined && nextStatus !== undefined) {
      record.status = nextStatus;
    }
    if (record !== undefined && nextTurn !== undefined) {
      record.turns.set(nextTurn.turn.turnId, nextTurn);
    }
    try {
      await this.#onEvent?.(envelope);
    } catch (error) {
      // The event is committed by this point, and the record already carries
      // the state it announced. Callers that asked for this emit still hear
      // about the failure, so it is reported and rethrown rather than caught
      // here — what must not happen is further up, where a turn's outcome is
      // decided.
      this.#reportEventDeliveryError(envelope, error);
      throw error;
    }
  }

  #reportEventDeliveryError(
    envelope: HarnessChatEventEnvelope,
    error: unknown,
  ): void {
    if (this.#onEventDeliveryError !== undefined) {
      this.#onEventDeliveryError(envelope, error);
      return;
    }
    // Without a handler the failure would be silent, which reads the same as a
    // delivery that worked.
    console.error(
      `cf-harness chat event ${envelope.sequence} (${envelope.event.kind}) was not delivered: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  #pruneInMemoryEvents(): void {
    if (
      this.#maxInMemoryEvents === undefined ||
      this.#events.length <= this.#maxInMemoryEvents
    ) {
      return;
    }
    this.#events.splice(0, this.#events.length - this.#maxInMemoryEvents);
  }
}

export const createHarnessInteractiveChatService = (
  options: CreateHarnessInteractiveChatServiceOptions = {},
): HarnessInteractiveChatService => new HarnessInteractiveChatService(options);

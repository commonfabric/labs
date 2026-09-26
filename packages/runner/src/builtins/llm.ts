import {
  BuiltInGenerateObjectParams,
  BuiltInGenerateTextParams,
  BuiltInLLMMessage,
  BuiltInLLMParams,
} from "@commonfabric/api";
import type { Schema } from "@commonfabric/api/schema";
import { toDeepFrozenSchema } from "@commonfabric/data-model-schema";
import { hashOf } from "@commonfabric/data-model";
import {
  DEFAULT_GENERATE_OBJECT_MODEL,
  DEFAULT_MODEL_NAME,
  extractTextFromLLMResponse,
  GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
  LLMClient,
  LLMGenerateObjectRequest,
  type LLMNativeModelToolId,
  LLMRequest,
  LLMResponse,
} from "@commonfabric/llm";
import {
  resolveScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import type { CellScope, JSONSchema } from "../builder/types.ts";
import { type Cell, isCell } from "../cell.ts";
import type { CfcConfClause } from "../cfc/clause.ts";
import { cfcLabelViewForCellFailClosed } from "../cfc/label-view.ts";
import { uniqueCfcAtoms } from "../cfc/observation.ts";
import { createFrozenRequestSnapshot } from "../cfc/request-snapshot.ts";
import {
  schemaWithInjectionSafeAnnotations,
  validateAgainstSchema,
} from "../cfc/schema-sanitization.ts";
import { enqueueSinkRequestPostCommitEffect } from "../cfc/sink-request.ts";
import {
  effectTargetKey,
  markEffectCompletion,
} from "../executor/effect-completion.ts";
import { requireWaveAcceptance, waveSettlementOf } from "../executor/wave.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
  snapshotQueryResult,
} from "../query-result-proxy.ts";
import type { Runtime } from "../runtime.ts";
import { type Action } from "../scheduler.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { llmToolExecutionHelpers } from "./llm-dialog.ts";
import {
  GenerateObjectParamsSchema,
  GenerateObjectResultSchema,
  GenerateTextParamsSchema,
  GenerateTextResultSchema,
  LLMParamsSchema,
  LLMResultSchema,
  LLMToolSchema,
} from "./llm-schemas.ts";
import { ownedCell } from "./runtime-owned-store.ts";
import {
  LLM_DERIVED_RESULT_STAMP_SCHEMA,
  withLlmDerivedStamp,
} from "../cfc/llm-derived-stamp.ts";
import { setCfcImplementationIdentity } from "../storage/extended-storage-transaction.ts";

const logger = getLogger("llm", {
  enabled: true,
  level: "warn",
});

const client = new LLMClient();

// TODO(ja): investigate if generateText should be replaced by
// a fetch builtin with streaming support

// Batch interval for partial streaming updates. Set to one second to coarsen the
// builtin-progress cadence (timing side-channel mitigation, channel 6, see
// docs/specs/sandboxing/TIMING_SIDE_CHANNELS.md): an unbatched partial cell
// streams at ~15 Hz, a sub-second cadence an untrusted pattern can watch to time
// token arrival, so the write rate is floored to <=1 Hz. The final result is
// written separately when streaming completes, so this only affects the
// intermediate cadence. Exported for testing.
export const PARTIAL_BATCH_MS = 1000;

// Epic D1b (docs/history/plans/cfc-future-work-implementation.md): the llm builtins
// stamp their model-output writebacks with an explicit `LlmDerived` provenance
// atom — the same mark D1 attaches to dialog messages. `llm`/`generateText`
// write `result`/`partial` through {@link LLM_DERIVED_RESULT_STAMP_SCHEMA};
// `generateObject` merges the stamp into EVERY node of the (possibly custom)
// resultSchema via `withLlmDerivedStamp`, so it also rides split child-document
// writes (`asCell` fields, ID-anchored array items) whose descent via
// `getSchemaAtPath` would otherwise drop `ifc.addIntegrity`. Both apply the
// stamp at the WRITE, not on the shared
// result schema, so the builtins' control-state writes (initial-run / error-path
// `pending`/`result=undefined` resets, and the transient streaming `partial`
// batches) stay CFC-inert — only the final model bytes are stamped and made
// CFC-relevant, mirroring D1's `pushModelMessages`. The write is attributed to
// the builtin because `LlmDerived` is a runtime-minted evidence family: the
// persist-time gate (`gateRuntimeMintedIntegrity`, audit S4) admits it only from
// a builtin author, which also stops pattern code forging it.

/**
 * Attribute a model-output writeback tx to the builtin so the `LlmDerived` stamp
 * persists rather than being gate-stripped. Gated on CFC enforcement so a
 * `disabled` deployment is a strict no-op (no identity, no stamp).
 */
function attributeModelOutputWrite(
  tx: IExtendedStorageTransaction,
  runtime: Runtime,
  builtinId: string,
): void {
  if (runtime.cfcEnforcementMode === "disabled") return;
  setCfcImplementationIdentity(tx, { kind: "builtin", builtinId });
}

/**
 * Write a model-output field (`result`/`partial`) through the `LlmDerived` stamp
 * schema, attributed to the builtin. A no-op stamp (plain write) when CFC is
 * disabled, so the disabled deployment stores no CFC metadata.
 */
function setStampedModelOutput(
  tx: IExtendedStorageTransaction,
  runtime: Runtime,
  resultCell: Cell<any>,
  field: "result" | "partial",
  value: unknown,
): void {
  const cell = runtime.cfcEnforcementMode === "disabled"
    ? resultCell.key(field)
    : resultCell.key(field).asSchema(LLM_DERIVED_RESULT_STAMP_SCHEMA);
  cell.withTx(tx).set(value);
}

/**
 * Write a generateObject model-output object through its (possibly custom)
 * resultSchema, with the `LlmDerived` stamp merged into every schema node (so it
 * lands on split child documents too). When CFC is disabled, writes through the
 * bare resultSchema so no metadata is minted — keeping the disabled deployment
 * CFC-inert.
 */
function setStampedObjectResult(
  tx: IExtendedStorageTransaction,
  runtime: Runtime,
  resultCell: Cell<any>,
  resultSchema: JSONSchema | undefined,
  object: unknown,
): void {
  const disabled = runtime.cfcEnforcementMode === "disabled";
  const target = disabled
    ? (resultSchema === undefined
      ? resultCell.key("result")
      : resultCell.key("result").asSchema(resultSchema))
    : resultCell.key("result").asSchema(withLlmDerivedStamp(resultSchema));
  target.withTx(tx).set(object);
}

function logGenerateObject(stage: string, details: Record<string, unknown>) {
  console.warn("[generateObject]", stage, details);
}

function summarizeGenerateObjectRequest(details: {
  hash: string;
  path: "direct" | "tools";
  model?: string;
  hasTools: boolean;
  toolNames?: string[];
  messageCount: number;
  contextKeys?: string[];
  queueName?: string;
}) {
  return {
    hash: details.hash.slice(0, 12),
    path: details.path,
    model: details.model,
    hasTools: details.hasTools,
    toolNames: details.toolNames ?? [],
    messageCount: details.messageCount,
    contextKeys: details.contextKeys ?? [],
    queueName: details.queueName,
  };
}

function collectCellConfidentiality(cell: Cell<any>): readonly unknown[] {
  const labelView = cfcLabelViewForCellFailClosed(cell.resolveAsCell());
  if (labelView === undefined) {
    return [];
  }

  return uniqueCfcAtoms(
    labelView.entries.flatMap((entry) => entry.label.confidentiality ?? []),
  );
}

function collectGenerateObjectPromptConfidentiality(
  inputs: Cell<any>,
): readonly unknown[] {
  return uniqueCfcAtoms([
    ...collectCellConfidentiality(inputs.key("prompt")),
    ...collectCellConfidentiality(inputs.key("messages")),
    ...collectCellConfidentiality(inputs.key("system")),
  ]);
}

/**
 * Creates an updatePartial callback that safely updates the partial cell
 * during streaming. Uses batched updates to reduce transaction overhead
 * while maintaining reactive updates.
 *
 * Updates are batched every PARTIAL_BATCH_MS to avoid creating many small
 * transactions during rapid streaming and to coarsen the progress cadence
 * (channel 6). Each batch waits for the scheduler to be idle, then commits the
 * latest partial text.
 *
 * Returns both the callback and a cleanup function that should be called
 * when streaming completes to clear any pending timers.
 */
function createUpdatePartialCallback(
  resultCell: Cell<any>,
  runtime: Runtime,
  getCurrentRun: () => number,
  thisRun: number,
): { callback: (text: string) => void; cleanup: () => void } {
  let pendingText: string | null = null;
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let completed = false;

  const batchMs = PARTIAL_BATCH_MS;

  const cleanup = () => {
    completed = true;
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = null;
    }
    pendingText = null;
  };

  const callback = (text: string) => {
    if (completed || thisRun !== getCurrentRun()) {
      cleanup();
      return;
    }

    // Store the latest text (overwrites any pending update)
    pendingText = text;

    // If no batch is scheduled, start one
    if (!batchTimer) {
      batchTimer = setTimeout(() => {
        batchTimer = null;
        const textToWrite = pendingText;
        pendingText = null;

        // Check run is still valid before committing
        if (textToWrite === null || completed || thisRun !== getCurrentRun()) {
          return;
        }

        // Wait for scheduler to be idle, then commit the batched update.
        //
        // Deliberately NOT marked as an effect completion (server-execution
        // v2 stage G): protocol.md §6 rules settled-result-only commits —
        // "partials never become commits" under the flag, and the interim
        // loss of token streaming is ACCEPTED (owner, 2026-08-02). In the
        // serving posture UNDER THE FLAG the partial is SKIPPED before a
        // transaction is minted — the same ruled outcome the
        // unstamped-seal refusal produced here before, without spending a
        // refused seal, so §3d's `unstampedSealRefusals` counter stays an
        // undeclared-commit-path signal instead of counting this accepted
        // baseline. The OFF arm commits it exactly as today — INCLUDING a
        // serving-posture runtime with the flag off (review thread
        // r3756175835: posture alone dropped OFF-arm partials, an
        // unrecorded OFF-arm delta).
        runtime.idle().then(() => {
          if (
            completed || thisRun !== getCurrentRun() ||
            (runtime.servingPosture &&
              runtime.experimental.serverExecution === true)
          ) {
            return;
          }
          return runtime.editWithRetry((tx) => {
            const partialCell = resultCell.key("partial").withTx(tx);
            partialCell.set(textToWrite);
          });
        }).catch((e) => {
          console.warn("[LLM] Error writing partial update:", e);
        });
      }, batchMs);
    }
  };

  return { callback, cleanup };
}

/**
 * Common tool execution loop shared between llm, generateText, and generateObject.
 * Handles the recursive tool calling pattern where the LLM can call tools,
 * receive results, and continue the conversation.
 */
async function executeWithToolsLoop(params: {
  initialMessages: readonly BuiltInLLMMessage[];
  llmParams: LLMRequest;
  toolCatalog?:
    | ReturnType<typeof llmToolExecutionHelpers.buildToolCatalog>
    | undefined;
  initialObservedConfidentiality?: readonly CfcConfClause[];
  observationMaxConfidentiality?: readonly CfcConfClause[];
  updatePartial: (text: string) => void;
  runtime: Runtime;
  space: any;
  getCurrentRun: () => number;
  thisRun: number;
  onComplete: (llmResult: LLMResponse) => Promise<void>;
}): Promise<void> {
  const {
    llmParams,
    toolCatalog,
    initialObservedConfidentiality = [],
    observationMaxConfidentiality,
    updatePartial,
    runtime,
    space,
    getCurrentRun,
    thisRun,
    onComplete,
  } = params;

  const executeRecursive = async (
    currentMessages: readonly BuiltInLLMMessage[],
    observedConfidentiality: readonly CfcConfClause[],
  ): Promise<void> => {
    if (thisRun !== getCurrentRun()) return;

    const requestParams: LLMRequest = {
      ...llmParams,
      messages: currentMessages,
    };
    if (toolCatalog && requestParams.tools === undefined) {
      requestParams.tools = toolCatalog.llmTools;
    }

    // Route the call to the executing space's host when the space is
    // host-mapped (one runtime spans hosts; an LLM call belongs to the
    // space whose pattern made it). An UNMAPPED space keeps the
    // module-level default endpoint — like the fetch builtins, hostForSpace's
    // apiUrl fallback is NOT used, because deployments may split the
    // pattern-facing api host from the runtime's memory host.
    const mappedLlmHost = runtime.mappedHostFor(space);
    const llmResult = await client.sendRequest(
      requestParams,
      updatePartial,
      undefined,
      mappedLlmHost
        ? { endpoint: new URL("/api/ai/llm", mappedLlmHost) }
        : undefined,
    );

    if (thisRun !== getCurrentRun()) return;

    const toolCallParts = llmToolExecutionHelpers.extractToolCallParts(
      llmResult.content,
    );
    const hasToolCalls = toolCallParts.length > 0;

    if (hasToolCalls && toolCatalog) {
      const assistantMessage = llmToolExecutionHelpers.buildAssistantMessage(
        llmResult.content,
        toolCallParts,
      );

      const toolResults = await llmToolExecutionHelpers.executeToolCalls(
        runtime,
        space,
        toolCatalog,
        toolCallParts,
        undefined,
        observedConfidentiality,
        observationMaxConfidentiality,
      );

      const toolResultMessages = llmToolExecutionHelpers
        .createToolResultMessages(toolResults);

      const updatedMessages = [
        ...currentMessages,
        assistantMessage,
        ...toolResultMessages,
      ];

      const nextObservedConfidentiality = uniqueCfcAtoms([
        ...observedConfidentiality,
        ...toolResults.flatMap((result) =>
          result.observedConfidentiality ?? []
        ),
      ]);

      await executeRecursive(updatedMessages, nextObservedConfidentiality);
    } else {
      // No more tool calls, finish
      await onComplete(llmResult);
    }
  };

  await executeRecursive(
    params.initialMessages,
    initialObservedConfidentiality,
  );
}

/**
 * Common error handler for LLM requests.
 * Resets state and allows retry on next invocation.
 */
async function handleLLMError<T, P>(
  error: unknown,
  runtime: Runtime,
  pendingCell: Cell<boolean>,
  resultCell: Cell<T>,
  errorCell: Cell<string | undefined>,
  partialCell: Cell<P>,
  requestHashCell: Cell<string | undefined>,
  requestHash: string,
  getCurrentRun: () => number,
  thisRun: number,
  resetPreviousHash: () => void,
  /** The served-effect id this error writeback completes
   * (`<sink>:<hash>` — the enqueue id). Marks the write as an
   * effect-completion transaction under the serving posture
   * (server-execution v2 stage G, serving-loop.md §4's error-shaped
   * results); inert everywhere else. */
  effectKey?: string,
  /** Restores a binding while this attempt owns its announcement. */
  announce?: (tx: IExtendedStorageTransaction) => void,
  requestGuard?: ServedLLMRequestGuard,
  /** Whether this refusal can replace the instance's request fields. */
  ownsRefusal?: () => boolean,
): Promise<void> {
  if (thisRun !== getCurrentRun() && announce === undefined) return;

  const message = error instanceof Error ? error.message : String(error);
  if (thisRun === getCurrentRun() && (!ownsRefusal || ownsRefusal())) {
    console.warn(`[LLM Error] ${message}`);
    logger.warn("llm", "Error in LLM request", { error });
  }

  await runtime.idle();

  let wrote = false;
  const { error: writeError } = await runtime.editWithRetry((tx) => {
    if (effectKey !== undefined) markEffectCompletion(tx, effectKey);
    if (requestGuard) {
      // Refusal rolls back the selected-request marker with its transaction.
      // Its announcement and generation guard still belong to this identity.
      if (announce) requestGuard.bind(tx);
      else if (!requestGuard.accept(tx, requestHash)) return;
    }
    announce?.(tx);
    if (ownsRefusal && !ownsRefusal()) return;
    // Read at write time rather than from a decision taken before the wait
    // above: a newer request can start while this one waits for the
    // scheduler, and from then on the answer is that request's to give. The
    // announcement has its own binding guard: another actor can still need a
    // link to a shared result that this request no longer owns.
    if (thisRun !== getCurrentRun()) return;
    wrote = true;
    pendingCell.withTx(tx).set(false);
    errorCell.withTx(tx).set(message);
    resultCell.withTx(tx).set(undefined as T);
    partialCell.withTx(tx).set(undefined as P);
    requestHashCell.withTx(tx).set(requestHash);
  });
  if (writeError) {
    // The error had nowhere to land, so a reader of this result cell sees
    // something other than this failure. Report it here, since nothing
    // downstream can.
    console.error(
      "[LLM] Writing the request's error to its result cell was rejected.",
      { requestHash, cause: message, rejection: writeError.message },
    );
  }

  if (!wrote) return;
  resetPreviousHash();
}

/**
 * Helper function to build context documentation from context cells.
 * Used by llm, generateText, and generateObject to provide consistent
 * context handling across all LLM builtins.
 *
 * @param inputs - The inputs cell containing the context parameter
 * @param runtime - The runtime instance
 * @param space - The memory space
 * @param tx - The current transaction
 * @returns Context documentation string to append to system prompt
 */
function buildContextDocumentation(
  inputs: Cell<any>,
  runtime: Runtime,
  space: any,
  tx: IExtendedStorageTransaction,
  sink: string,
): { docs: string; observedConfidentiality: readonly CfcConfClause[] } {
  const context = inputs.key("context").withTx(tx).get();
  if (!context) {
    return {
      docs: "",
      observedConfidentiality: [],
    };
  }

  // Create empty pinned cells array with proper schema
  const pinnedCellsSchema = {
    type: "array",
    items: {
      type: "object",
      properties: {
        path: { type: "string" },
        name: { type: "string" },
      },
      required: ["path", "name"],
    },
  } as const;

  return llmToolExecutionHelpers
    .buildAvailableCellsDocumentationWithObservation(
      runtime,
      space,
      context,
      // LLM builtins don't have pinned cells (only llmDialog does)
      runtime.getCell(
        space,
        { llm: { pinnedCells: [] } },
        pinnedCellsSchema,
        tx,
      ),
      // Bound the pattern-supplied ceiling by the deployment ceiling for this
      // sink so neither the context docs nor the tool loop observe past it
      // (#3993 review).
      llmToolExecutionHelpers.effectiveObservationCeiling(
        runtime,
        sink,
        inputs.key("observationMaxConfidentiality").withTx(tx).get() as
          | readonly CfcConfClause[]
          | undefined,
      ),
    );
}

/** Mutable lifecycle state for one resolved output instance. */
type LLMRunState<T> = {
  /** Local cancellation generation. */
  currentRun: number;

  /** Dispatched model and refusal work that still owns this instance. */
  activeWork: number;

  /** Latest unsettled transaction for each resolved output binding. */
  staging: Map<string, LLMStaging>;

  /** Latest accepted action and its request, ordered by action issuance. */
  accepted?: { sequence: number; requestId?: string };

  /** Most recently staged request. */
  previousCallHash?: string;

  /** Whether the local queue owns the latest request. */
  lastRequestQueued: boolean;

  /** Whether the result target has been initialized. */
  cellsInitialized?: boolean;

  /** Result target belonging to this instance. */
  resultCell?: Cell<T>;

  /** Scope used to construct the result target. */
  cellScope?: CellScope;
};

/** One binding's pending publication and optional request. */
type LLMStaging = {
  /** Symbolic result link published by this action. */
  target: string;

  /** Invocation order within this builtin closure. */
  sequence: number;

  /** Staged request identity, when this action makes a request. */
  requestId?: string;

  /** Removes this token and retires its result instance when idle. */
  release: () => void;
};

/** Ownership of one staging attempt and its actual dispatched work. */
type LLMRequestLifecycle = {
  /** Whether this attempt still owns its output binding's announcement. */
  ownsAnnouncement: () => boolean;

  /** Supersedes older bindings once this publication's transaction accepts. */
  recordPublication: (tx: IExtendedStorageTransaction) => void;

  /** Whether this attempt owns the refused request's fields. */
  owns: () => boolean;

  /** Records the request selected by a settled memo without staging work. */
  selectRequest: (id: string) => void;

  /** Records that rejection must settle the staged request. */
  stageRequest: (id: string) => void;

  /** Retains state for actual work, including refusal writeback. */
  start: () => void;

  /** Releases completed work and retires an idle instance. */
  finish: () => void;
};

/** Observes commit acceptance including a sealed contribution's wave verdict. */
function onLLMTransactionAcceptance(
  tx: IExtendedStorageTransaction,
  onVerdict: (accepted: boolean) => void,
): void {
  requireWaveAcceptance(tx);
  tx.addCommitCallback((committedTx, outcome) => {
    if (outcome.error) return onVerdict(false);
    const settlement = waveSettlementOf(committedTx) ?? waveSettlementOf(tx);
    if (settlement) settlement.then((verdict) => onVerdict(!verdict.error));
    else onVerdict(true);
  });
}

/** Retains pending ownership while retiring settled historical instances. */
function trackLLMRequestLifecycle<T>(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  states: Map<string, LLMRunState<T>>,
  key: string,
  state: LLMRunState<T>,
  result: Cell<{ pending?: boolean }>,
  identity: ScopeKeyIdentity,
  publicationBinding: NormalizedFullLink | undefined,
  sequence: number,
): LLMRequestLifecycle {
  const bindingKey = publicationBinding
    ? resolveScopeKey(publicationBinding.scope ?? "space", identity)
    : key;
  const retireIfIdle = () => {
    if (
      states.get(key) !== state || state.staging.size || state.activeWork !== 0
    ) return;
    const read = runtime.readTx();
    read.tx.scopeKeyIdentity = identity;
    if (result.withTx(read).key("pending").get() !== true) states.delete(key);
  };
  const finishStaging = () => {
    if (state.staging.get(bindingKey) === staging) {
      state.staging.delete(bindingKey);
    }
    retireIfIdle();
  };
  const staging: LLMStaging = {
    target: effectTargetKey("publication", result),
    sequence,
    release: finishStaging,
  };
  let selectedRequestId: string | undefined;
  state.staging.set(bindingKey, staging);
  const recordPublication = (publicationTx: IExtendedStorageTransaction) => {
    onLLMTransactionAcceptance(publicationTx, (accepted) => {
      if (!accepted || !publicationBinding) return;
      for (const other of states.values()) {
        const previous = other.staging.get(bindingKey);
        if (
          previous && previous.sequence < sequence &&
          previous.target !== staging.target
        ) previous.release();
      }
    });
  };
  onLLMTransactionAcceptance(tx, (accepted) => {
    // Rejected requests retain ownership until their refusal is announced or
    // a later staging attempt takes over. Accepted waves can still withdraw.
    if (!accepted && staging.requestId) return;
    if (accepted && sequence > (state.accepted?.sequence ?? 0)) {
      state.accepted = { sequence, requestId: selectedRequestId };
    }
    finishStaging();
  });
  const ownsAnnouncement = () =>
    states.get(key) === state && state.staging.get(bindingKey) === staging;
  return {
    ownsAnnouncement,
    recordPublication,
    owns: () =>
      ownsAnnouncement() &&
      state.accepted?.requestId !== staging.requestId,
    selectRequest: (id) => selectedRequestId = id,
    stageRequest: (id) => {
      staging.requestId = id;
      selectedRequestId = id;
    },
    start: () => state.activeWork++,
    finish: () => {
      state.activeWork--;
      finishStaging();
    },
  };
}

/** Identity-bound acceptance of one served LLM result target. */
type ServedLLMRequestGuard = {
  /** Binds a writeback to its issuing identity and live input basis. */
  bind: (tx: IExtendedStorageTransaction) => void;

  /** Reads whether the selected request still matches. */
  isCurrent: (hash: string) => boolean;

  /** Binds completion reads and validates unqueued request selection. */
  accept: (tx: IExtendedStorageTransaction, hash: string) => boolean;
};

/** Builds current-request checks bound to the output's issuing identity. */
function servedLLMRequestGuard(
  runtime: Runtime,
  inputs: Cell<any>,
  result: Cell<{ requestHash?: string }>,
  identity: ScopeKeyIdentity,
  queued: boolean,
): ServedLLMRequestGuard {
  const bind = (tx: IExtendedStorageTransaction) => {
    tx.tx.scopeKeyIdentity = identity;
    snapshotQueryResult(inputs.withTx(tx).get());
  };
  return {
    bind,
    isCurrent: (hash) => {
      const tx = runtime.readTx();
      tx.tx.scopeKeyIdentity = identity;
      return result.withTx(tx).key("requestHash").get() === hash;
    },
    accept: (tx, hash) => {
      tx.tx.scopeKeyIdentity = identity;
      if (!queued && result.withTx(tx).key("requestHash").get() !== hash) {
        return false;
      }
      // Current request inputs contribute the completion's live label basis.
      snapshotQueryResult(inputs.withTx(tx).get());
      return true;
    },
  };
}

/**
 * Start `start` once the transaction staging this request commits, and call
 * `onRefused` instead when the commit is rejected in a way that re-running
 * cannot resolve. A refused request never reaches the model, so the builtin
 * settles on the refusal rather than leaving `pending` true forever.
 *
 * The settled error is recorded against the request hash, so this request is
 * over and the builtin waits for a different one. A refusal that turns on
 * something other than the request — the ceiling its result store declares,
 * say — outlives the change that resolves it, because that change leaves the
 * hash where it was. Editing the pattern is what moves it.
 */
function enqueuePostCommitLLMWork(
  tx: IExtendedStorageTransaction,
  runtime: Runtime,
  parent: Cell<any>,
  sink: string,
  id: string,
  /** The PER-TARGET outbox/dedupe key (effectTargetKey of `id` and the
   * builtin's result cell) — distinct nodes with identical inputs must
   * not collide on `id` alone (stage-G round-2 headline). */
  idempotencyKey: string,
  kind: string,
  request: any,
  start: () => Promise<void>,
  onRefused: (error: Error) => Promise<void>,
  lifecycle?: LLMRequestLifecycle,
): void {
  enqueueSinkRequestPostCommitEffect(
    tx,
    sink,
    id,
    request,
    kind,
    (committedTx) => {
      lifecycle?.start();
      const work = (async () => {
        if (runtime.servingPosture && runtime.experimental.serverExecution) {
          const settlement = waveSettlementOf(committedTx) ??
            waveSettlementOf(tx);
          if (settlement && (await settlement).error) return;
        }
        await start();
      })().finally(() => lifecycle?.finish());
      runtime.trackAsyncWork(work, parent);
    },
    {
      idempotencyKey,
      onRejected: (error) => {
        lifecycle?.start();
        const work = (async () => await onRefused(error))()
          .finally(() => lifecycle?.finish());
        runtime.trackAsyncWork(work, parent);
      },
    },
  );
  lifecycle?.stageRequest(id);
}

/**
 * Record the hash of the request this transaction stages, which a later run
 * reads to recognize a request already in flight. If the transaction reports an
 * error, the hash goes back to what it was and `onRollback` runs, so a caller
 * can undo state it recorded for the same request.
 */
function markRequestHashPendingCommit(
  tx: IExtendedStorageTransaction,
  hash: string,
  getPreviousCallHash: () => string | undefined,
  setPreviousCallHash: (hash: string | undefined) => void,
  onRollback?: () => void,
): void {
  const previousCallHash = getPreviousCallHash();
  setPreviousCallHash(hash);
  tx.addCommitCallback((_committedTx, commitResult) => {
    if (commitResult.error && getPreviousCallHash() === hash) {
      setPreviousCallHash(previousCallHash);
      onRollback?.();
    }
  });
}

async function pullContextCells(
  context: Record<string, unknown> | undefined,
) {
  for (const value of Object.values(context ?? {})) {
    try {
      const resolved = isCellResultForDereferencing(value)
        ? getCellOrThrow(value).resolveAsCell()
        : isCell(value)
        ? value.resolveAsCell()
        : isObjectOrArray(value) && typeof value.resolveAsCell === "function"
        ? value.resolveAsCell()
        : undefined;
      await resolved?.pull?.();
    } catch {
      // Ignore unresolved context cells and let request construction continue.
    }
  }
}

/**
 * Generate data via an LLM.
 *
 * Returns the complete result as `result` and the incremental result as
 * `partial`. `pending` is true while a request is pending.
 *
 * @param messages - list of messages to send to the LLM. - alternating user and assistant messages.
 *  - if you end with an assistant message, the LLM will continue from there.
 *  - if both prompt and messages are empty, no LLM call will be made,
 *    result and partial will be undefined.
 * @param model - A doc to store the model to use.
 * @param system - A doc to store the system message.
 * @param stop - A doc to store (optional) stop sequence.
 * @param maxTokens - A doc to store the maximum number of tokens to generate.
 *
 * @returns { pending: boolean, result?: Array<{type: string, text: string}>, partial?: string } - As individual
 *   docs, representing `pending` state, final `result` and incrementally
 *   updating `partial` result.
 */
export function llm(
  inputsCell: Cell<BuiltInLLMParams>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: Runtime, // Runtime will be injected by the registration function
  _outputBinding?: NormalizedFullLink,
  _awaitSync?: boolean,
  publicationBinding?: NormalizedFullLink,
): Action {
  const inputs = inputsCell.asSchema(LLMParamsSchema);

  const states = new Map<string, LLMRunState<Schema<typeof LLMResultSchema>>>();

  let requestSequence = 0;

  return (tx: IExtendedStorageTransaction) => {
    tx.resetNarrowestReadScope();
    const {
      system,
      messages,
      stop,
      maxTokens,
      model,
      search,
      nativeModelToolIds,
    } = inputs.withTx(tx).get();
    const effectiveNativeModelToolIds = resolveNativeModelToolIds(
      search,
      nativeModelToolIds,
    );

    // Build context documentation from context cells and append to system prompt
    const contextDocs = buildContextDocumentation(
      inputs,
      runtime,
      parentCell.space,
      tx,
      "llm",
    );
    const outputScope = tx.getNarrowestReadScope();
    const served = runtime.servingPosture &&
      runtime.experimental.serverExecution;
    const identity = served
      ? tx.tx.scopeKeyIdentity ?? runtime.scopeKeyIdentity
      : undefined;
    const stateKey = identity
      ? resolveScopeKey(outputScope ?? "space", identity)
      : "local";
    let state = states.get(stateKey);
    if (!state) {
      state = {
        currentRun: 0,
        activeWork: 0,
        lastRequestQueued: false,
        staging: new Map(),
      };
      states.set(stateKey, state);
    }

    if (!state.cellsInitialized || state.cellScope !== outputScope) {
      if (state.cellsInitialized && state.cellScope !== outputScope) {
        state.previousCallHash = undefined;
      }
      state.resultCell = ownedCell(
        runtime,
        tx,
        parentCell,
        { llm: { result: cause } },
        LLMResultSchema,
        outputScope,
      );
      state.resultCell.sync();
      state.cellsInitialized = true;
      state.cellScope = outputScope;
    }
    const resultCell = state.resultCell!;
    const lifecycle = identity
      ? trackLLMRequestLifecycle(
        runtime,
        tx,
        states,
        stateKey,
        state,
        resultCell,
        identity,
        publicationBinding,
        ++requestSequence,
      )
      : undefined;
    const announceResult = (announceTx: IExtendedStorageTransaction) => {
      if (lifecycle && !lifecycle.ownsAnnouncement()) return;
      sendResult(announceTx, resultCell);
      lifecycle?.recordPublication(announceTx);
    };
    sendResult(tx, resultCell);
    lifecycle?.recordPublication(tx);
    const requestGuard = identity
      ? servedLLMRequestGuard(
        runtime,
        inputs,
        resultCell,
        identity,
        !!inputs.key("queue").withTx(tx).get(),
      )
      : undefined;

    const pendingWithLog = resultCell.key("pending").withTx(tx);
    const resultWithLog = resultCell.key("result").withTx(tx);
    const errorWithLog = resultCell.key("error").withTx(tx);
    const partialWithLog = resultCell.key("partial").withTx(tx);
    const requestHashWithLog = resultCell.key("requestHash").withTx(tx);

    const llmParams: LLMRequest = {
      system: ((system ?? "") + contextDocs.docs).trim() ||
        "You are a helpful assistant.",
      messages: (messages as unknown as readonly BuiltInLLMMessage[]) ?? [],
      stop: stop ?? "",
      maxTokens: maxTokens ?? 4096,
      stream: true,
      model: model ?? DEFAULT_MODEL_NAME,
      metadata: {
        // FIXME(ja): how do we get the context of space/piece id here
        // bf: I also do not know... this one is tricky
        context: "piece",
      },
      cache: true,
      ...(effectiveNativeModelToolIds
        ? { nativeModelToolIds: effectiveNativeModelToolIds }
        : {}),
      // tools will be added below if present
    };

    const toolsCell = inputs.key("tools").asSchema({
      type: "object",
      additionalProperties: LLMToolSchema,
    });
    const toolCatalog = toolsCell
      ? llmToolExecutionHelpers.buildToolCatalog(toolsCell)
      : undefined;
    const requestSnapshot = createFrozenRequestSnapshot(
      toolCatalog ? { ...llmParams, tools: toolCatalog.llmTools } : llmParams,
    );
    const hash = hashOf(requestSnapshot).toString();
    const queueName = inputs.key("queue").withTx(tx).get() as unknown as
      | string
      | undefined;

    // Return if the same request is being made again, either concurrently (same
    // as state.previousCallHash) or already settled (same as the contents of
    // the requestHash doc, with its result or error landed). A stored hash with
    // neither belongs to a request that was cleared away, and the same
    // messages are a new one.
    const currentRequestHash = requestHashWithLog.get();
    if (
      (!served && hash === state.previousCallHash) ||
      (hash === currentRequestHash &&
        (resultWithLog.get() !== undefined || errorWithLog.get() !== undefined))
    ) {
      // The §4 memo hit, gated on SETTLED state like the sibling
      // builtins (generateText/generateObject; round-2 thread 8): a
      // hit is a re-evaluation that resolved from a stored key WITH a
      // result or error-shaped result landed. The old gate counted a
      // settled same-runtime re-evaluation as in-flight dedupe (hash
      // === state.previousCallHash, which completion never clears) and a
      // bare unsettled claim (stored hash, no result yet) as a hit —
      // both miscounts for Phase 2's gate arithmetic.
      if (
        hash === currentRequestHash &&
        (resultWithLog.get() !== undefined ||
          errorWithLog.get() !== undefined)
      ) {
        lifecycle?.selectRequest(`llm:${hash}`);
        runtime.effectMemoObserver?.({ kind: "hit", id: `llm:${hash}` });
      }
      return;
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      // Abandon a request already in flight, where abandoning one is possible.
      // Advancing the run makes its response fail the guard on the way back, so
      // nothing of it reaches the cell, and dropping the remembered hash lets
      // the same messages go out again rather than match the in-flight check
      // and never be sent. A queued request is neither of those: the queue
      // owns its lifecycle and runs it to completion, so forgetting its hash
      // would enqueue a second copy of a call that is still going to arrive.
      // The mode is the one the request in flight was issued under.
      if (!state.lastRequestQueued) {
        state.currentRun++;
        state.previousCallHash = undefined;
      }
      resultWithLog.set(undefined);
      errorWithLog.set(undefined);
      partialWithLog.set(undefined);
      pendingWithLog.set(false);
      if (served && !state.lastRequestQueued) requestHashWithLog.set(undefined);
      return;
    }

    const previousRequestQueued = state.lastRequestQueued;
    state.lastRequestQueued = !!queueName;
    markRequestHashPendingCommit(
      tx,
      hash,
      () => state.previousCallHash,
      (next) => {
        state.previousCallHash = next;
      },
      () => state.lastRequestQueued = previousRequestQueued,
    );

    // The generation the plain path's cancellation token compares against. A
    // run advances it only once it issues a request; a re-evaluation that
    // finds this request in flight has returned above and leaves it alone.
    // The batched partial's own commit is one such re-evaluation — this node
    // read `partial` in resetting it — and is not a newer request.
    const thisRun = ++state.currentRun;

    resultWithLog.set(undefined);
    errorWithLog.set(undefined);
    partialWithLog.set(undefined);
    pendingWithLog.set(true);
    if (served) requestHashWithLog.set(hash);

    // When queued, disable run cancellation — the queue manages lifecycle.
    const getRunForCancellation = queueName
      ? () => thisRun
      : requestGuard
      ? () => requestGuard.isCurrent(hash) ? thisRun : -1
      : () => state.currentRun;

    const { callback: updatePartial, cleanup: cleanupPartial } =
      createUpdatePartialCallback(
        resultCell,
        runtime,
        getRunForCancellation,
        thisRun,
      );

    const effectKey = effectTargetKey(`llm:${hash}`, resultCell, identity);

    // The one way this request ends badly, whether the model call failed or the
    // request never went out at all.
    const settleWithError = (error: unknown) =>
      handleLLMError(
        error,
        runtime,
        resultCell.key("pending"),
        resultCell.key("result"),
        resultCell.key("error"),
        resultCell.key("partial"),
        resultCell.key("requestHash"),
        hash,
        getRunForCancellation,
        thisRun,
        () => {
          // Only clear if this is still the current request; a newer request
          // may have already set state.previousCallHash to its own hash.
          if (hash === state.previousCallHash) {
            state.previousCallHash = undefined;
          }
        },
        effectKey,
        undefined,
        requestGuard,
      );

    // This request's own result cell. A later run that finds a different output
    // scope builds a new one and leaves this variable pointing at that, so the
    // ending below has to write the cell this request announced.
    const requestResultCell = resultCell;

    // Re-publish the binding discarded with the abandoned request so its
    // refusal remains reachable even when the action will not run again.
    const settleAbandoned = (error: unknown) =>
      handleLLMError(
        error,
        runtime,
        requestResultCell.key("pending"),
        requestResultCell.key("result"),
        requestResultCell.key("error"),
        requestResultCell.key("partial"),
        requestResultCell.key("requestHash"),
        hash,
        () => !served || states.get(stateKey) === state ? state.currentRun : -1,
        thisRun,
        () => {
          if (hash === state.previousCallHash) {
            state.previousCallHash = undefined;
          }
        },
        effectKey,
        announceResult,
        requestGuard,
        lifecycle?.owns,
      );

    // The ending for a request refused before it started.
    const settleRefused = (error: Error) => {
      cleanupPartial();
      return settleAbandoned(error);
    };

    // Build tool catalog if tools are present, then start execution after the
    // transaction commits.
    enqueuePostCommitLLMWork(
      tx,
      runtime,
      parentCell,
      "llm",
      `llm:${hash}`,
      effectKey,
      "llm-start",
      requestSnapshot,
      () => {
        const resultPromise = (async () => {
          try {
            const doWork = () =>
              executeWithToolsLoop({
                initialMessages:
                  (messages as unknown as readonly BuiltInLLMMessage[]) ??
                    [],
                llmParams: requestSnapshot,
                toolCatalog,
                initialObservedConfidentiality:
                  contextDocs.observedConfidentiality,
                // Deployment-bounded so post-commit tool reads can't exceed the
                // llm sink ceiling (#3993 review).
                observationMaxConfidentiality: llmToolExecutionHelpers
                  .effectiveObservationCeiling(
                    runtime,
                    "llm",
                    inputs.key("observationMaxConfidentiality").get() as
                      | readonly CfcConfClause[]
                      | undefined,
                  ),
                updatePartial,
                runtime,
                space: parentCell.space,
                getCurrentRun: getRunForCancellation,
                thisRun,
                onComplete: async (llmResult) => {
                  // Skip if a newer request has already superseded this one.
                  if (
                    (!served || queueName) && hash !== state.previousCallHash
                  ) return;

                  await runtime.idle();
                  const groundingSources = extractGroundingSources(llmResult);

                  await runtime.editWithRetry((tx) => {
                    markEffectCompletion(tx, effectKey);
                    if (requestGuard && !requestGuard.accept(tx, hash)) return;
                    // D1b: attribute FIRST, then stamp the model-output fields —
                    // `result`/`partial` carry `LlmDerived`; the control-state
                    // fields (pending/error/requestHash/grounding) do not.
                    attributeModelOutputWrite(tx, runtime, "llm");
                    resultCell.key("pending").withTx(tx).set(false);
                    setStampedModelOutput(
                      tx,
                      runtime,
                      resultCell,
                      "result",
                      llmResult.content,
                    );
                    resultCell.key("error").withTx(tx).set(undefined);
                    setStampedModelOutput(
                      tx,
                      runtime,
                      resultCell,
                      "partial",
                      extractTextFromLLMResponse(llmResult),
                    );
                    resultCell.key("requestHash").withTx(tx).set(hash);
                    resultCell.key("groundingSources").withTx(tx).set(
                      groundingSources,
                    );
                  });
                },
              });

            if (queueName) {
              await runtime.getOrCreateQueue(queueName).enqueue(doWork);
            } else {
              await doWork();
            }
          } finally {
            cleanupPartial();
          }
        })();

        return resultPromise.catch(settleWithError);
      },
      settleRefused,
      lifecycle,
    );
  };
}

/**
 * Resolve the effective native-model-tool ids for a request from the friendly
 * `search` flag (shorthand for Google Search grounding) plus any explicit
 * `nativeModelToolIds`. Returns undefined when none are requested.
 */
function resolveNativeModelToolIds(
  search: unknown,
  nativeModelToolIds: unknown,
): readonly LLMNativeModelToolId[] | undefined {
  const ids: string[] = [];
  if (search === true) ids.push(GOOGLE_SEARCH_NATIVE_MODEL_TOOL);
  if (Array.isArray(nativeModelToolIds)) {
    for (const id of nativeModelToolIds) {
      if (typeof id === "string" && !ids.includes(id)) ids.push(id);
    }
  }
  return ids.length > 0 ? (ids as readonly LLMNativeModelToolId[]) : undefined;
}

/**
 * Flatten grounding/source URLs out of an LLM response's
 * `nativeModelToolResults[].sources` (e.g. from `google_search`) into the
 * compact `{ url, title, snippet }[]` shape surfaced on builtin result state.
 */
function extractGroundingSources(
  llmResult: LLMResponse,
): Array<{ url?: string; title?: string; snippet?: string }> | undefined {
  const results =
    (llmResult as { nativeModelToolResults?: readonly { sources?: unknown }[] })
      .nativeModelToolResults;
  if (!Array.isArray(results) || results.length === 0) return undefined;
  const out: Array<{ url?: string; title?: string; snippet?: string }> = [];
  const seen = new Set<string>();
  for (const r of results) {
    const sources = r?.sources;
    if (!Array.isArray(sources)) continue;
    for (const s of sources) {
      if (!s || typeof s !== "object") continue;
      const rec = s as Record<string, unknown>;
      const url = typeof rec.url === "string" ? rec.url : undefined;
      const title = typeof rec.title === "string" ? rec.title : undefined;
      const snippet = typeof rec.snippet === "string"
        ? rec.snippet
        : typeof rec.description === "string"
        ? rec.description
        : undefined;
      const key = url ?? title ?? JSON.stringify(rec);
      if (seen.has(key)) continue;
      seen.add(key);
      if (url || title || snippet) out.push({ url, title, snippet });
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Generate text via an LLM.
 *
 * A simplified alternative to `llm` that takes a single prompt string and
 * optional system message, returning plain text rather than a structured
 * content array.
 *
 * Returns the complete result as `result` (string) and the incremental result
 * as `partial` (string). `pending` is true while a request is pending.
 *
 * @param prompt - The user prompt/message to send to the LLM.
 * @param system - Optional system message.
 * @param model - Model to use (defaults to DEFAULT_MODEL_NAME).
 * @param maxTokens - Maximum number of tokens to generate (defaults to 4096).
 *
 * @returns { pending: boolean, result?: string, partial?: string, requestHash?: string } -
 *   As individual docs, representing `pending` state, final `result` and
 *   incrementally updating `partial` result.
 */
export function generateText(
  inputsCell: Cell<BuiltInGenerateTextParams>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: Runtime,
  _outputBinding?: NormalizedFullLink,
  _awaitSync?: boolean,
  publicationBinding?: NormalizedFullLink,
): Action {
  const inputs = inputsCell.asSchema(GenerateTextParamsSchema);

  const states = new Map<
    string,
    LLMRunState<Schema<typeof GenerateTextResultSchema>>
  >();

  let requestSequence = 0;

  return (tx: IExtendedStorageTransaction) => {
    tx.resetNarrowestReadScope();
    const {
      system,
      prompt,
      messages,
      model,
      maxTokens,
      search,
      nativeModelToolIds,
    } = inputs.withTx(tx).get();
    const effectiveNativeModelToolIds = resolveNativeModelToolIds(
      search,
      nativeModelToolIds,
    );

    // Build context documentation from context cells and append to system prompt
    const contextDocs = buildContextDocumentation(
      inputs,
      runtime,
      parentCell.space,
      tx,
      "generateText",
    );
    const outputScope = tx.getNarrowestReadScope();
    const served = runtime.servingPosture &&
      runtime.experimental.serverExecution;
    const identity = served
      ? tx.tx.scopeKeyIdentity ?? runtime.scopeKeyIdentity
      : undefined;
    const stateKey = identity
      ? resolveScopeKey(outputScope ?? "space", identity)
      : "local";
    let state = states.get(stateKey);
    if (!state) {
      state = {
        currentRun: 0,
        activeWork: 0,
        lastRequestQueued: false,
        staging: new Map(),
      };
      states.set(stateKey, state);
    }

    if (!state.cellsInitialized || state.cellScope !== outputScope) {
      if (state.cellsInitialized && state.cellScope !== outputScope) {
        state.previousCallHash = undefined;
      }
      state.resultCell = ownedCell(
        runtime,
        tx,
        parentCell,
        { generateText: { result: cause } },
        GenerateTextResultSchema,
        outputScope,
      );
      state.resultCell.sync();
      state.cellsInitialized = true;
      state.cellScope = outputScope;
    }
    const resultCell = state.resultCell!;
    const lifecycle = identity
      ? trackLLMRequestLifecycle(
        runtime,
        tx,
        states,
        stateKey,
        state,
        resultCell,
        identity,
        publicationBinding,
        ++requestSequence,
      )
      : undefined;
    const announceResult = (announceTx: IExtendedStorageTransaction) => {
      if (lifecycle && !lifecycle.ownsAnnouncement()) return;
      sendResult(announceTx, resultCell);
      lifecycle?.recordPublication(announceTx);
    };
    sendResult(tx, resultCell);
    lifecycle?.recordPublication(tx);
    const requestGuard = identity
      ? servedLLMRequestGuard(
        runtime,
        inputs,
        resultCell,
        identity,
        !!inputs.key("queue").withTx(tx).get(),
      )
      : undefined;
    const pendingWithLog = resultCell.key("pending").withTx(tx);
    const resultWithLog = resultCell.key("result").withTx(tx);
    const errorWithLog = resultCell.key("error").withTx(tx);
    const partialWithLog = resultCell.key("partial").withTx(tx);
    const requestHashWithLog = resultCell.key("requestHash").withTx(tx);

    // If neither prompt nor messages is provided, don't make a request
    const hasPrompt = Array.isArray(prompt) ? prompt.length > 0 : !!prompt;
    if (!hasPrompt && !messages) {
      // Abandon a request already in flight, where abandoning one is possible.
      // Advancing the run makes its response fail the guard on the way back, so
      // nothing of it reaches the cell, and dropping the remembered hash lets
      // the same prompt go out again rather than match the in-flight check and
      // never be sent. A queued request is neither of those: the queue owns its
      // lifecycle and runs it to completion, so forgetting its hash would
      // enqueue a second copy of a call that is still going to arrive. The
      // mode is the one the request in flight was issued under.
      if (!state.lastRequestQueued) {
        state.currentRun++;
        state.previousCallHash = undefined;
      }
      resultWithLog.set(undefined);
      errorWithLog.set(undefined);
      partialWithLog.set(undefined);
      pendingWithLog.set(false);
      if (served && !state.lastRequestQueued) requestHashWithLog.set(undefined);
      return;
    }

    // Convert prompt to messages if provided, otherwise use messages directly
    const requestMessages: readonly BuiltInLLMMessage[] =
      (messages as unknown as readonly BuiltInLLMMessage[]) ||
      [{ role: "user", content: prompt! }];

    const llmParams: LLMRequest = {
      system: ((system ?? "") + contextDocs.docs).trim() ||
        "You are a helpful assistant.",
      messages: requestMessages,
      stop: "",
      maxTokens: maxTokens ?? 4096,
      stream: true,
      model: model ?? DEFAULT_MODEL_NAME,
      metadata: {
        context: "piece",
      },
      cache: true,
      ...(effectiveNativeModelToolIds
        ? { nativeModelToolIds: effectiveNativeModelToolIds }
        : {}),
      // tools will be added below if present
    };

    const toolsCell = inputs.key("tools").asSchema({
      type: "object",
      additionalProperties: LLMToolSchema,
    });
    const toolCatalog = toolsCell
      ? llmToolExecutionHelpers.buildToolCatalog(toolsCell)
      : undefined;
    const requestSnapshot = createFrozenRequestSnapshot(
      toolCatalog ? { ...llmParams, tools: toolCatalog.llmTools } : llmParams,
    );
    const hash = hashOf(requestSnapshot).toString();
    const queueName = inputs.key("queue").withTx(tx).get() as unknown as
      | string
      | undefined;
    const currentRequestHash = requestHashWithLog.get();
    const currentResult = resultWithLog.get();
    const currentError = errorWithLog.get();

    // Return if the same request is being made again
    // Also return if there's an error for this request (don't retry automatically)
    if (
      (currentResult !== undefined || currentError !== undefined) &&
      hash === currentRequestHash
    ) {
      // The §4 memo hit (server-execution v2): stored key matches — the
      // stored result (or error-shaped result) is the value; no re-fire.
      lifecycle?.selectRequest(`generateText:${hash}`);
      runtime.effectMemoObserver?.({ kind: "hit", id: `generateText:${hash}` });
      return;
    }

    // Also skip if this is the same request in the current transaction
    if (!served && hash === state.previousCallHash) {
      return;
    }

    const previousRequestQueued = state.lastRequestQueued;
    state.lastRequestQueued = !!queueName;
    markRequestHashPendingCommit(
      tx,
      hash,
      () => state.previousCallHash,
      (next) => {
        state.previousCallHash = next;
      },
      () => {
        state.lastRequestQueued = previousRequestQueued;
      },
    );

    // Only increment state.currentRun if this is a NEW request (different hash)
    // This prevents abandoning in-flight requests when the same params are re-evaluated
    if (hash !== currentRequestHash) {
      state.currentRun++;
    }
    const thisRun = state.currentRun;

    resultWithLog.set(undefined);
    errorWithLog.set(undefined);
    partialWithLog.set(undefined);
    pendingWithLog.set(true);
    if (served) requestHashWithLog.set(hash);

    // When queued, disable run cancellation — the queue manages lifecycle.
    // Once enqueued, the job must run to completion to avoid abandoning
    // HTTP streams (which causes ERR_INCOMPLETE_CHUNK_ENCODING).
    const getRunForCancellation = queueName
      ? () => thisRun
      : requestGuard
      ? () => requestGuard.isCurrent(hash) ? thisRun : -1
      : () => state.currentRun;

    const { callback: updatePartial, cleanup: cleanupPartial } =
      createUpdatePartialCallback(
        resultCell,
        runtime,
        getRunForCancellation,
        thisRun,
      );

    const effectKey = effectTargetKey(
      `generateText:${hash}`,
      resultCell,
      identity,
    );

    // The one way this request ends badly, whether the model call failed or the
    // request never went out at all.
    const settleWithError = (error: unknown) =>
      handleLLMError(
        error,
        runtime,
        resultCell.key("pending"),
        resultCell.key("result"),
        resultCell.key("error"),
        resultCell.key("partial"),
        resultCell.key("requestHash"),
        hash,
        getRunForCancellation,
        thisRun,
        () => {
          // Only clear if this is still the current request; a newer request
          // may have already set state.previousCallHash to its own hash.
          if (hash === state.previousCallHash) {
            state.previousCallHash = undefined;
          }
        },
        effectKey,
        undefined,
        requestGuard,
      );

    // This request's own result cell. A later run that finds a different output
    // scope builds a new one and leaves this variable pointing at that, so the
    // ending below has to write the cell this request announced.
    const requestResultCell = resultCell;

    // Re-publish the binding discarded with the abandoned request so its
    // refusal remains reachable even when the action will not run again.
    const settleAbandoned = (error: unknown) =>
      handleLLMError(
        error,
        runtime,
        requestResultCell.key("pending"),
        requestResultCell.key("result"),
        requestResultCell.key("error"),
        requestResultCell.key("partial"),
        requestResultCell.key("requestHash"),
        hash,
        () => !served || states.get(stateKey) === state ? state.currentRun : -1,
        thisRun,
        () => {
          if (hash === state.previousCallHash) {
            state.previousCallHash = undefined;
          }
        },
        effectKey,
        announceResult,
        requestGuard,
        lifecycle?.owns,
      );

    // The ending for a request refused before it started.
    const settleRefused = (error: Error) => {
      cleanupPartial();
      return settleAbandoned(error);
    };

    enqueuePostCommitLLMWork(
      tx,
      runtime,
      parentCell,
      "generateText",
      `generateText:${hash}`,
      effectKey,
      "generateText-start",
      requestSnapshot,
      () => {
        const resultPromise = (async () => {
          try {
            const doWork = () =>
              executeWithToolsLoop({
                initialMessages: requestMessages,
                llmParams: requestSnapshot,
                toolCatalog,
                initialObservedConfidentiality:
                  contextDocs.observedConfidentiality,
                // Deployment-bounded so post-commit tool reads can't exceed the
                // generateText sink ceiling (#3993 review).
                observationMaxConfidentiality: llmToolExecutionHelpers
                  .effectiveObservationCeiling(
                    runtime,
                    "generateText",
                    inputs.key("observationMaxConfidentiality").get() as
                      | readonly CfcConfClause[]
                      | undefined,
                  ),
                updatePartial,
                runtime,
                space: parentCell.space,
                getCurrentRun: getRunForCancellation,
                thisRun,
                onComplete: async (llmResult) => {
                  await runtime.idle();

                  const textResult = extractTextFromLLMResponse(llmResult);
                  const groundingSources = extractGroundingSources(llmResult);

                  await runtime.editWithRetry((tx) => {
                    markEffectCompletion(tx, effectKey);
                    if (requestGuard && !requestGuard.accept(tx, hash)) return;
                    // D1b: attribute FIRST, then stamp the model-output fields.
                    attributeModelOutputWrite(tx, runtime, "generateText");
                    resultCell.key("pending").withTx(tx).set(false);
                    setStampedModelOutput(
                      tx,
                      runtime,
                      resultCell,
                      "result",
                      textResult,
                    );
                    resultCell.key("error").withTx(tx).set(undefined);
                    setStampedModelOutput(
                      tx,
                      runtime,
                      resultCell,
                      "partial",
                      textResult,
                    );
                    resultCell.key("requestHash").withTx(tx).set(hash);
                    resultCell.key("groundingSources").withTx(tx).set(
                      groundingSources,
                    );
                  });
                },
              });

            if (queueName) {
              await runtime.getOrCreateQueue(queueName).enqueue(doWork);
            } else {
              await doWork();
            }
          } finally {
            cleanupPartial();
          }
        })();

        return resultPromise.catch(settleWithError);
      },
      settleRefused,
      lifecycle,
    );
  };
}

/**
 * Generate structured data via an LLM using JSON mode.
 *
 * Returns the complete result as `result` and the incremental result as
 * `partial`. `pending` is true while a request is pending.
 *
 * @param prompt - The prompt to send to the LLM.
 * @param schema - JSON Schema to validate the response against.
 * @param system - Optional system message.
 * @param maxTokens - Maximum number of tokens to generate.
 * @param model - Model to use (defaults to DEFAULT_GENERATE_OBJECT_MODEL).
 * @param cache - Whether to cache the response (defaults to true).
 * @param metadata - Additional metadata to pass to the LLM.
 * @param tools - Optional tools to make available to the LLM.
 *
 * @returns { pending: boolean, result?: object, partial?: string } - As individual
 *   docs, representing `pending` state, final `result` and incrementally
 *   updating `partial` result.
 */
export function generateObject<T extends Record<string, unknown>>(
  inputsCell: Cell<BuiltInGenerateObjectParams>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: Runtime,
  _outputBinding?: NormalizedFullLink,
  _awaitSync?: boolean,
  publicationBinding?: NormalizedFullLink,
): Action {
  const inputs = inputsCell.asSchema(GenerateObjectParamsSchema);

  const states = new Map<
    string,
    LLMRunState<Schema<typeof GenerateObjectResultSchema>>
  >();

  let requestSequence = 0;

  return (tx: IExtendedStorageTransaction) => {
    tx.resetNarrowestReadScope();
    const {
      prompt,
      messages,
      maxTokens,
      model,
      schema,
      system,
      cache,
      tools,
      metadata,
      schemaSanitizePromptInjection,
      search,
      nativeModelToolIds,
    } = inputs.withTx(tx).get() ?? {};
    const effectiveNativeModelToolIds = resolveNativeModelToolIds(
      search,
      nativeModelToolIds,
    );
    const context = inputs.key("context").withTx(tx).get() as
      | Record<string, unknown>
      | undefined;
    // Bound the pattern-supplied ceiling by the deployment generateObject
    // ceiling once here; every downstream consumer (context docs, the tools
    // loop, and the direct path) inherits the effective bound, so post-commit
    // tool reads can't observe past the deployment ceiling (#3993 review).
    const observationMaxConfidentiality = llmToolExecutionHelpers
      .effectiveObservationCeiling(
        runtime,
        "generateObject",
        inputs.key("observationMaxConfidentiality").withTx(tx).get() as
          | readonly CfcConfClause[]
          | undefined,
      );
    const outputScope = tx.getNarrowestReadScope();
    const served = runtime.servingPosture &&
      runtime.experimental.serverExecution;
    const identity = served
      ? tx.tx.scopeKeyIdentity ?? runtime.scopeKeyIdentity
      : undefined;
    const stateKey = identity
      ? resolveScopeKey(outputScope ?? "space", identity)
      : "local";
    let state = states.get(stateKey);
    if (!state) {
      state = {
        currentRun: 0,
        activeWork: 0,
        lastRequestQueued: false,
        staging: new Map(),
      };
      states.set(stateKey, state);
    }

    if (!state.cellsInitialized || state.cellScope !== outputScope) {
      if (state.cellsInitialized && state.cellScope !== outputScope) {
        state.previousCallHash = undefined;
      }
      state.resultCell = ownedCell(
        runtime,
        tx,
        parentCell,
        { generateObject: { result: cause } },
        GenerateObjectResultSchema,
        outputScope,
      );
      state.resultCell.sync();
      state.cellsInitialized = true;
      state.cellScope = outputScope;
    }
    const resultCell = state.resultCell!;
    const lifecycle = identity
      ? trackLLMRequestLifecycle(
        runtime,
        tx,
        states,
        stateKey,
        state,
        resultCell,
        identity,
        publicationBinding,
        ++requestSequence,
      )
      : undefined;
    const announceResult = (announceTx: IExtendedStorageTransaction) => {
      if (lifecycle && !lifecycle.ownsAnnouncement()) return;
      sendResult(announceTx, resultCell);
      lifecycle?.recordPublication(announceTx);
    };
    sendResult(tx, resultCell);
    lifecycle?.recordPublication(tx);
    const requestGuard = identity
      ? servedLLMRequestGuard(
        runtime,
        inputs,
        resultCell,
        identity,
        !!inputs.key("queue").withTx(tx).get(),
      )
      : undefined;
    const pendingWithLog = resultCell.key("pending").withTx(tx);
    const resultWithLog = resultCell.key("result").withTx(tx);
    const messagesWithLog = resultCell.key("messages").withTx(tx);
    const errorWithLog = resultCell.key("error").withTx(tx);
    const partialWithLog = resultCell.key("partial").withTx(tx);
    const requestHashWithLog = resultCell.key("requestHash").withTx(tx);

    const hasPrompt = Array.isArray(prompt) ? prompt.length > 0 : !!prompt;
    if (
      (!hasPrompt && (!messages || messages.length === 0)) ||
      schema === undefined
    ) {
      // Abandon a request already in flight, where abandoning one is possible.
      // Advancing the run makes its response fail the guard on the way back, so
      // nothing of it reaches the cell, and dropping the remembered hash lets
      // the same prompt go out again rather than match the in-flight check and
      // never be sent. A queued request is neither of those: the queue owns its
      // lifecycle and runs it to completion, so forgetting its hash would
      // enqueue a second copy of a call that is still going to arrive. The
      // mode is the one the request in flight was issued under.
      if (!state.lastRequestQueued) {
        state.currentRun++;
        state.previousCallHash = undefined;
      }
      resultWithLog.set(undefined);
      messagesWithLog.set(undefined);
      errorWithLog.set(undefined);
      partialWithLog.set(undefined);
      pendingWithLog.set(false);
      if (served && !state.lastRequestQueued) requestHashWithLog.set(undefined);
      return;
    }

    // TODO(danfuzz): Latent — schemas don't admit `Fabric*` values on this
    // `.get()`-path today, but will in the not-too-distant future; at that point
    // this JSON round-trip silently loses any `FabricPrimitive`/`FabricInstance`
    // (class instances don't survive JSON). Mark ahead of that.
    const readyMetadata = metadata ? JSON.parse(JSON.stringify(metadata)) : {};

    // Convert prompt to messages if provided, otherwise use messages directly
    const requestMessages: readonly BuiltInLLMMessage[] =
      (messages as unknown as readonly BuiltInLLMMessage[]) ||
      [{ role: "user", content: prompt! }];

    // Build context documentation from context cells and append to system prompt
    const pinnedCellsSchema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          name: { type: "string" },
        },
        required: ["path", "name"],
      },
    } as const;
    const contextDocs = context
      ? llmToolExecutionHelpers.buildAvailableCellsDocumentationWithObservation(
        runtime,
        parentCell.space,
        context as Record<string, Cell<any>>,
        runtime.getCell(
          parentCell.space,
          { generateObject: { pinnedCells: [] } },
          pinnedCellsSchema,
          tx,
        ),
        observationMaxConfidentiality,
      )
      : {
        docs: "",
        observedConfidentiality: [],
      };
    // Determine whether to use the tool-calling path or the direct generateObject path
    const hasTools = isObjectNotArray(tools) && Object.keys(tools).length > 0;
    const validationSchema = schemaSanitizePromptInjection
      ? toDeepFrozenSchema(schema)
      : undefined;
    const resultSchemaForObserved = (
      observedConfidentiality: readonly CfcConfClause[],
    ) =>
      schemaSanitizePromptInjection
        ? schemaWithInjectionSafeAnnotations(
          validationSchema as any,
          observedConfidentiality,
        )
        : undefined;
    const validateResultForSchemaSanitization = (value: unknown): void => {
      if (validationSchema === undefined) {
        return;
      }
      const failure = validateAgainstSchema(validationSchema, value);
      if (failure !== undefined) {
        throw new Error(
          `generateObject result failed schema sanitization validation: ${failure}`,
        );
      }
    };

    if (hasTools) {
      // Use tool-calling path with presentResult builtin tool
      const llmParams: LLMRequest = {
        system: ((system ?? "") + contextDocs.docs).trim() ||
          "You are a helpful assistant.",
        messages: requestMessages,
        stop: "",
        maxTokens: maxTokens ?? 8192,
        stream: true,
        model: model ?? DEFAULT_GENERATE_OBJECT_MODEL,
        metadata: {
          ...readyMetadata,
          context: "piece",
        },
        cache: cache ?? true,
        ...(effectiveNativeModelToolIds
          ? { nativeModelToolIds: effectiveNativeModelToolIds }
          : {}),
      };

      const toolsCell = inputs.key("tools").asSchema({
        type: "object",
        additionalProperties: LLMToolSchema,
      });
      const baseCatalog = llmToolExecutionHelpers.buildToolCatalog(
        toolsCell,
      );

      // Add presentResult builtin tool.
      const toolCatalog = {
        ...baseCatalog,
        llmTools: {
          ...baseCatalog.llmTools,
          [llmToolExecutionHelpers.PRESENT_RESULT_TOOL_NAME]: {
            description:
              "Call this tool with the final structured result matching the required schema. This should be your last action.",
            inputSchema: llmToolExecutionHelpers.prepareSchemaForLLM(
              toDeepFrozenSchema(schema),
            ),
          },
        },
      };
      const llmParamsWithTools: LLMRequest = {
        ...llmParams,
        tools: toolCatalog.llmTools,
      };
      const requestSnapshot = createFrozenRequestSnapshot(
        JSON.parse(
          JSON.stringify({
            ...llmParamsWithTools,
            schema,
            schemaSanitizePromptInjection,
          }),
        ),
      );
      const hash = hashOf(requestSnapshot).toString();
      const effectKey = effectTargetKey(
        `generateObject:${hash}`,
        resultCell,
        identity,
      );
      const queueName = inputs.key("queue").withTx(tx).get() as unknown as
        | string
        | undefined;
      const currentRequestHash = requestHashWithLog.get();
      const currentResult = resultWithLog.get();
      const currentError = errorWithLog.get();
      const toolsRequestSummary = summarizeGenerateObjectRequest({
        hash,
        path: "tools",
        model: llmParamsWithTools.model,
        hasTools: true,
        toolNames: Object.keys(toolCatalog.llmTools),
        messageCount: requestMessages.length,
        contextKeys: context ? Object.keys(context) : [],
        queueName,
      });

      // Return if the same request is being made again
      // Also return if there's an error for this request (don't retry automatically)
      if (
        (currentResult !== undefined || currentError !== undefined) &&
        hash === currentRequestHash
      ) {
        // The §4 memo hit (server-execution v2): no re-fire.
        lifecycle?.selectRequest(`generateObject:${hash}`);
        runtime.effectMemoObserver?.({
          kind: "hit",
          id: `generateObject:${hash}`,
        });
        logGenerateObject("skip-cached", toolsRequestSummary);
        return;
      }

      if (!served && hash === state.previousCallHash) {
        logGenerateObject("skip-inflight", toolsRequestSummary);
        return;
      }

      const previousRequestQueued = state.lastRequestQueued;
      state.lastRequestQueued = !!queueName;
      markRequestHashPendingCommit(
        tx,
        hash,
        () => state.previousCallHash,
        (next) => {
          state.previousCallHash = next;
        },
        () => {
          state.lastRequestQueued = previousRequestQueued;
        },
      );

      if (hash !== currentRequestHash) {
        state.currentRun++;
      }
      const thisRun = state.currentRun;

      resultWithLog.set(undefined);
      messagesWithLog.set(undefined);
      errorWithLog.set(undefined);
      partialWithLog.set(undefined);
      // TODO(danfuzz): Latent — schemas don't admit `Fabric*` values on this
      // `.get()`-path today, but will in the not-too-distant future; at that
      // point this JSON round-trip silently loses any `FabricPrimitive`/
      // `FabricInstance` (class instances don't survive JSON). Mark ahead of
      // that.
      messagesWithLog.set(JSON.parse(JSON.stringify(requestMessages)) as any);
      pendingWithLog.set(true);
      if (served) requestHashWithLog.set(hash);

      // When queued, disable run cancellation — the queue manages lifecycle.
      const getRunForCancellation = queueName
        ? () => thisRun
        : requestGuard
        ? () => requestGuard.isCurrent(hash) ? thisRun : -1
        : () => state.currentRun;
      const isRunCancelled = () => thisRun !== getRunForCancellation();

      const { callback: updatePartial, cleanup: cleanupPartial } =
        createUpdatePartialCallback(
          resultCell,
          runtime,
          getRunForCancellation,
          thisRun,
        );

      // The one way this request ends badly, whether the tools loop failed or
      // the request never went out at all.
      const settleWithError = (error: unknown) => {
        logGenerateObject("error", {
          ...toolsRequestSummary,
          error: error instanceof Error ? error.message : String(error),
        });
        return handleLLMError(
          error,
          runtime,
          resultCell.key("pending"),
          resultCell.key("result"),
          resultCell.key("error"),
          resultCell.key("partial"),
          resultCell.key("requestHash"),
          hash,
          getRunForCancellation,
          thisRun,
          () => {
            state.previousCallHash = undefined;
          },
          effectKey,
          undefined,
          requestGuard,
        );
      };

      // This request's own result cell. A later run that finds a different
      // output scope builds a new one and leaves this variable pointing at
      // that, so the ending below has to write the cell this request
      // announced.
      const requestResultCell = resultCell;

      // Re-publish the binding discarded with the abandoned request so its
      // refusal remains reachable even when the action will not run again.
      const settleAbandoned = (error: unknown) =>
        handleLLMError(
          error,
          runtime,
          requestResultCell.key("pending"),
          requestResultCell.key("result"),
          requestResultCell.key("error"),
          requestResultCell.key("partial"),
          requestResultCell.key("requestHash"),
          hash,
          () =>
            !served || states.get(stateKey) === state ? state.currentRun : -1,
          thisRun,
          () => {
            state.previousCallHash = undefined;
          },
          effectKey,
          announceResult,
          requestGuard,
          lifecycle?.owns,
        );

      // The ending for a request refused before it started.
      const settleRefused = (error: Error) => {
        cleanupPartial();
        return settleAbandoned(error);
      };

      logGenerateObject("enqueue", toolsRequestSummary);

      enqueuePostCommitLLMWork(
        tx,
        runtime,
        parentCell,
        "generateObject",
        `generateObject:${hash}`,
        effectKey,
        "generateObject-start",
        requestSnapshot,
        () => {
          logGenerateObject("post-commit-start", toolsRequestSummary);
          const resultPromise = (async () => {
            try {
              await inputs.pull();
              const liveContext = inputs.key("context").get() as
                | Record<string, unknown>
                | undefined;
              await pullContextCells(liveContext);
              const liveContextDocs = liveContext
                ? llmToolExecutionHelpers
                  .buildAvailableCellsDocumentationWithObservation(
                    runtime,
                    parentCell.space,
                    liveContext as Record<string, Cell<any>>,
                    runtime.getCell(
                      parentCell.space,
                      { generateObject: { pinnedCells: [] } },
                      pinnedCellsSchema,
                    ),
                    observationMaxConfidentiality,
                  )
                : {
                  docs: "",
                  observedConfidentiality: [],
                };
              const liveSystem =
                ((system ?? "") + liveContextDocs.docs).trim() ||
                "You are a helpful assistant.";
              const livePromptObservedConfidentiality =
                collectGenerateObjectPromptConfidentiality(inputs);
              const liveInitialObservedConfidentiality = uniqueCfcAtoms([
                ...livePromptObservedConfidentiality,
                ...liveContextDocs.observedConfidentiality,
              ]);

              // Execute with tools - capture presentResult when called
              let finalResult: T | undefined;
              let finalMessages: readonly BuiltInLLMMessage[] = requestMessages;
              let finalObservedConfidentiality: readonly CfcConfClause[] =
                liveInitialObservedConfidentiality;

              // Custom execution loop for generateObject with presentResult extraction
              const executeRecursive = async (
                currentMessages: readonly BuiltInLLMMessage[],
                observedConfidentiality: readonly CfcConfClause[],
              ): Promise<void> => {
                if (isRunCancelled()) return;

                const requestParams: LLMRequest = {
                  ...llmParamsWithTools,
                  system: liveSystem,
                  messages: currentMessages,
                };

                const mappedLlmHost = runtime.mappedHostFor(
                  parentCell.space,
                );
                const llmResult = await client.sendRequest(
                  requestParams,
                  updatePartial,
                  undefined,
                  mappedLlmHost
                    ? { endpoint: new URL("/api/ai/llm", mappedLlmHost) }
                    : undefined,
                );

                if (isRunCancelled()) return;

                const toolCallParts = llmToolExecutionHelpers
                  .extractToolCallParts(llmResult.content);
                const hasToolCalls = toolCallParts.length > 0;

                if (hasToolCalls) {
                  const assistantMessage = llmToolExecutionHelpers
                    .buildAssistantMessage(
                      llmResult.content,
                      toolCallParts,
                    );

                  const toolResults = await llmToolExecutionHelpers
                    .executeToolCalls(
                      runtime,
                      parentCell.space,
                      toolCatalog,
                      toolCallParts,
                      undefined,
                      observedConfidentiality,
                      observationMaxConfidentiality,
                    );

                  // Check if presentResult was called. Cellify from the raw
                  // tool call input to get live Cell references (the tool result
                  // itself is serialized with @link for the conversation).
                  const presentResultPart = toolCallParts.find(
                    (p) =>
                      p.toolName ===
                        llmToolExecutionHelpers.PRESENT_RESULT_TOOL_NAME,
                  );
                  if (presentResultPart) {
                    finalResult = llmToolExecutionHelpers.traverseAndCellify(
                      runtime,
                      parentCell.space,
                      presentResultPart.input,
                    ) as T;
                  }

                  const toolResultMessages = llmToolExecutionHelpers
                    .createToolResultMessages(toolResults);

                  const updatedMessages = [
                    ...currentMessages,
                    assistantMessage,
                    ...toolResultMessages,
                  ];
                  finalMessages = updatedMessages;

                  const nextObservedConfidentiality = uniqueCfcAtoms([
                    ...observedConfidentiality,
                    ...toolResults.flatMap((result) =>
                      result.observedConfidentiality ?? []
                    ),
                  ]);
                  if (presentResultPart) {
                    finalObservedConfidentiality = nextObservedConfidentiality;
                  }

                  // Continue if presentResult wasn't called yet
                  if (!presentResultPart) {
                    await executeRecursive(
                      updatedMessages,
                      nextObservedConfidentiality,
                    );
                  }
                } else {
                  throw new Error(
                    "LLM did not call presentResult tool with structured data",
                  );
                }
              };

              const doWork = async () => {
                logGenerateObject("tools-loop-start", toolsRequestSummary);
                await executeRecursive(
                  requestMessages,
                  liveInitialObservedConfidentiality,
                );

                if (finalResult === undefined) {
                  throw new Error("presentResult was never called");
                }
                validateResultForSchemaSanitization(finalResult);

                return {
                  object: finalResult,
                  messages: finalMessages,
                  resultSchema: resultSchemaForObserved(
                    finalObservedConfidentiality,
                  ),
                };
              };

              const objectResponse = queueName
                ? await runtime.getOrCreateQueue(queueName).enqueue(doWork)
                : await doWork();

              logGenerateObject("tools-loop-complete", {
                ...toolsRequestSummary,
                objectKeys: Object.keys(objectResponse.object ?? {}),
              });

              await runtime.idle();

              if (isRunCancelled()) {
                logGenerateObject(
                  "write-skipped-cancelled",
                  toolsRequestSummary,
                );
                return;
              }

              await runtime.editWithRetry((tx) => {
                markEffectCompletion(tx, effectKey);
                if (requestGuard && !requestGuard.accept(tx, hash)) return;
                // The InjectionSafe annotations on resultSchema are minted by
                // the trusted sanitizer; attribute this write to the builtin so
                // the persist-time evidence gate trusts them (audit S4). The
                // same attribution keeps the D1b LlmDerived stamp merged into
                // the result schema root below.
                setCfcImplementationIdentity(tx, {
                  kind: "builtin",
                  builtinId: "generateObject",
                });
                resultCell.key("pending").withTx(tx).set(false);
                // D1b: write the model-produced object through the resultSchema
                // with `LlmDerived` merged into its root, so the stamp rides to
                // wherever the object lands (inline or a split child doc). This
                // covers both a custom user resultSchema and the default.
                setStampedObjectResult(
                  tx,
                  runtime,
                  resultCell,
                  objectResponse.resultSchema,
                  objectResponse.object,
                );
                // TODO(danfuzz): Latent — schemas don't admit `Fabric*` values
                // on this `.get()`-path today, but will in the not-too-distant
                // future; at that point this JSON round-trip silently loses any
                // `FabricPrimitive`/`FabricInstance` (class instances don't
                // survive JSON). Mark ahead of that.
                resultCell.key("messages").withTx(tx).set(
                  JSON.parse(JSON.stringify(objectResponse.messages)) as any,
                );
                resultCell.key("error").withTx(tx).set(undefined);
                resultCell.key("requestHash").withTx(tx).set(hash);
              });
              logGenerateObject("write-complete", toolsRequestSummary);
            } finally {
              cleanupPartial();
            }
          })();

          return resultPromise.catch(settleWithError);
        },
        settleRefused,
        lifecycle,
      );
    } else {
      // Use direct generateObject path (no tools)
      const generateObjectParams: LLMGenerateObjectRequest = {
        messages: requestMessages,
        maxTokens: maxTokens ?? 8192,
        schema: llmToolExecutionHelpers.prepareSchemaForLLM(
          toDeepFrozenSchema(schema),
        ),
        model: model ?? DEFAULT_GENERATE_OBJECT_MODEL,
        metadata: {
          ...readyMetadata,
          context: "piece",
        },
        cache: cache ?? true,
        ...(effectiveNativeModelToolIds
          ? { nativeModelToolIds: effectiveNativeModelToolIds }
          : {}),
      };

      // Always set system prompt with context documentation
      generateObjectParams.system =
        ((system ?? "") + contextDocs.docs).trim() ||
        "You are a helpful assistant.";

      const requestSnapshot = createFrozenRequestSnapshot({
        ...generateObjectParams,
        schemaSanitizePromptInjection,
      });
      const hash = hashOf(requestSnapshot).toString();
      const effectKey = effectTargetKey(
        `generateObject:${hash}`,
        resultCell,
        identity,
      );
      const queueName = inputs.key("queue").withTx(tx).get() as unknown as
        | string
        | undefined;
      const currentRequestHash = requestHashWithLog.get();
      const currentResult = resultWithLog.get();
      const currentError = errorWithLog.get();
      const directRequestSummary = summarizeGenerateObjectRequest({
        hash,
        path: "direct",
        model: generateObjectParams.model,
        hasTools: false,
        messageCount: requestMessages.length,
        contextKeys: context ? Object.keys(context) : [],
        queueName,
      });

      // Return if the same request is being made again
      // Also return if there's an error for this request (don't retry automatically)
      if (
        (currentResult !== undefined || currentError !== undefined) &&
        hash === currentRequestHash
      ) {
        // The §4 memo hit (server-execution v2): no re-fire.
        lifecycle?.selectRequest(`generateObject:${hash}`);
        runtime.effectMemoObserver?.({
          kind: "hit",
          id: `generateObject:${hash}`,
        });
        logGenerateObject("skip-cached", directRequestSummary);
        return;
      }

      // Also skip if this is the same request in the current transaction
      if (!served && hash === state.previousCallHash) {
        logGenerateObject("skip-inflight", directRequestSummary);
        return;
      }

      const previousRequestQueued = state.lastRequestQueued;
      state.lastRequestQueued = !!queueName;
      markRequestHashPendingCommit(
        tx,
        hash,
        () => state.previousCallHash,
        (next) => {
          state.previousCallHash = next;
        },
        () => {
          state.lastRequestQueued = previousRequestQueued;
        },
      );

      // Only increment state.currentRun if this is a NEW request (different hash)
      // This prevents abandoning in-flight requests when the same params are re-evaluated
      if (hash !== currentRequestHash) {
        state.currentRun++;
      }
      const thisRun = state.currentRun;

      resultWithLog.set(undefined);
      messagesWithLog.set(undefined);
      errorWithLog.set(undefined);
      partialWithLog.set(undefined);
      // TODO(danfuzz): Latent — schemas don't admit `Fabric*` values on this
      // `.get()`-path today, but will in the not-too-distant future; at that
      // point this JSON round-trip silently loses any `FabricPrimitive`/
      // `FabricInstance` (class instances don't survive JSON). Mark ahead of
      // that.
      messagesWithLog.set(JSON.parse(JSON.stringify(requestMessages)) as any);
      pendingWithLog.set(true);
      if (served) requestHashWithLog.set(hash);

      const getRunForCancellation = queueName
        ? () => thisRun
        : requestGuard
        ? () => requestGuard.isCurrent(hash) ? thisRun : -1
        : () => state.currentRun;
      const isRunCancelled = () => thisRun !== getRunForCancellation();

      // The one way this request ends badly, whether the model call failed or
      // the request never went out at all.
      const settleWithError = (error: unknown) => {
        logGenerateObject("error", {
          ...directRequestSummary,
          error: error instanceof Error ? error.message : String(error),
        });
        return handleLLMError(
          error,
          runtime,
          resultCell.key("pending"),
          resultCell.key("result"),
          resultCell.key("error"),
          resultCell.key("partial"),
          resultCell.key("requestHash"),
          hash,
          getRunForCancellation,
          thisRun,
          () => {
            state.previousCallHash = undefined;
          },
          effectKey,
          undefined,
          requestGuard,
        );
      };

      // This request's own result cell. A later run that finds a different
      // output scope builds a new one and leaves this variable pointing at
      // that, so the ending below has to write the cell this request
      // announced.
      const requestResultCell = resultCell;

      // Re-publish the binding discarded with the abandoned request so its
      // refusal remains reachable even when the action will not run again.
      const settleAbandoned = (error: unknown) =>
        handleLLMError(
          error,
          runtime,
          requestResultCell.key("pending"),
          requestResultCell.key("result"),
          requestResultCell.key("error"),
          requestResultCell.key("partial"),
          requestResultCell.key("requestHash"),
          hash,
          () =>
            !served || states.get(stateKey) === state ? state.currentRun : -1,
          thisRun,
          () => {
            state.previousCallHash = undefined;
          },
          effectKey,
          announceResult,
          requestGuard,
          lifecycle?.owns,
        );

      logGenerateObject("enqueue", directRequestSummary);

      enqueuePostCommitLLMWork(
        tx,
        runtime,
        parentCell,
        "generateObject",
        `generateObject:${hash}`,
        effectKey,
        "generateObject-start",
        requestSnapshot,
        () => {
          logGenerateObject("post-commit-start", directRequestSummary);
          const doWork = async () => {
            logGenerateObject("direct-work-start", directRequestSummary);
            await inputs.pull();
            const liveContext = inputs.key("context").get() as
              | Record<string, unknown>
              | undefined;
            await pullContextCells(liveContext);
            const liveContextDocs = liveContext
              ? llmToolExecutionHelpers
                .buildAvailableCellsDocumentationWithObservation(
                  runtime,
                  parentCell.space,
                  liveContext as Record<string, Cell<any>>,
                  runtime.getCell(
                    parentCell.space,
                    { generateObject: { pinnedCells: [] } },
                    pinnedCellsSchema,
                  ),
                  observationMaxConfidentiality,
                )
              : {
                docs: "",
                observedConfidentiality: [],
              };
            logGenerateObject("client-generateObject-start", {
              ...directRequestSummary,
              observedConfidentialityCount: uniqueCfcAtoms([
                ...collectGenerateObjectPromptConfidentiality(inputs),
                ...liveContextDocs.observedConfidentiality,
              ]).length,
            });
            const mappedLlmHost = runtime.mappedHostFor(
              parentCell.space,
            );
            const response = await client.generateObject(
              {
                ...generateObjectParams,
                system: ((system ?? "") + liveContextDocs.docs).trim() ||
                  "You are a helpful assistant.",
              },
              undefined,
              mappedLlmHost
                ? { endpoint: new URL("/api/ai/llm", mappedLlmHost) }
                : undefined,
            ) as {
              object: T;
            };
            logGenerateObject("client-generateObject-complete", {
              ...directRequestSummary,
              objectKeys: Object.keys(response.object ?? {}),
            });
            validateResultForSchemaSanitization(response.object);
            const livePromptObservedConfidentiality =
              collectGenerateObjectPromptConfidentiality(inputs);
            return {
              ...response,
              resultSchema: resultSchemaForObserved(
                uniqueCfcAtoms([
                  ...livePromptObservedConfidentiality,
                  ...liveContextDocs.observedConfidentiality,
                ]),
              ),
            };
          };

          const resultPromise = queueName
            ? runtime.getOrCreateQueue(queueName).enqueue(doWork)
            : doWork();

          return resultPromise
            .then(async (response) => {
              await runtime.idle();

              if (isRunCancelled()) {
                logGenerateObject(
                  "write-skipped-cancelled",
                  directRequestSummary,
                );
                return;
              }

              await runtime.editWithRetry((tx) => {
                markEffectCompletion(tx, effectKey);
                if (requestGuard && !requestGuard.accept(tx, hash)) return;
                // The InjectionSafe annotations on resultSchema are minted by
                // the trusted sanitizer; attribute this write to the builtin
                // so the persist-time evidence gate trusts them (audit S4).
                // The same attribution keeps the D1b LlmDerived stamp merged
                // into the result schema root below.
                setCfcImplementationIdentity(tx, {
                  kind: "builtin",
                  builtinId: "generateObject",
                });
                const assistantMessage: BuiltInLLMMessage = {
                  role: "assistant",
                  content: JSON.stringify(response.object, null, 2),
                };
                resultCell.key("pending").withTx(tx).set(false);
                // D1b: write the model-produced object through the
                // resultSchema with `LlmDerived` merged into its root (custom
                // or default).
                setStampedObjectResult(
                  tx,
                  runtime,
                  resultCell,
                  response.resultSchema,
                  response.object,
                );
                // TODO(danfuzz): Latent — schemas don't admit `Fabric*`
                // values on this `.get()`-path today, but will in the
                // not-too-distant future; at that point these JSON
                // round-trips silently lose any `FabricPrimitive`/
                // `FabricInstance` (class instances don't survive JSON). Mark
                // ahead of that.
                resultCell.key("messages").withTx(tx).set([
                  ...JSON.parse(JSON.stringify(requestMessages)),
                  JSON.parse(JSON.stringify(assistantMessage)),
                ] as any);
                resultCell.key("error").withTx(tx).set(undefined);
                resultCell.key("requestHash").withTx(tx).set(hash);
              });
              logGenerateObject("write-complete", directRequestSummary);
            })
            .catch(settleWithError);
        },
        settleAbandoned,
        lifecycle,
      );
    }
  };
}

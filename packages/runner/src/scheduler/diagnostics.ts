import type { MemorySpace } from "@commonfabric/memory/interface";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { getTopFrame } from "../builder/pattern.ts";
import { type Frame } from "../builder/types.ts";
import { collectReaderConsumedLabel } from "../cfc/prepare.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "../query-result-proxy.ts";
import type { ErrorHandler, ErrorWithContext } from "../runtime.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../storage/interface.ts";
import type {
  Action,
  ActionRunTraceAddress,
  EventHandler,
  EventPreflightTraceContext,
  TelemetryAnnotations,
  TriggerTraceEntry,
  TriggerTraceValueSummary,
} from "./types.ts";
import { type NormalizedFullLink } from "../link-utils.ts";
import {
  isErrorStackMapped,
  markErrorStackMapped,
} from "../sandbox/ses-runtime.ts";
import type { SchedulerActionInfo } from "../telemetry.ts";
import { MAX_TRIGGER_TRACE_HISTORY } from "./constants.ts";

export interface SchedulerActionIdentityState {
  readonly anonymousActionIds: WeakMap<Action | EventHandler, string>;
  anonymousActionCounter: number;
}

export function getSchedulerActionId(
  state: SchedulerActionIdentityState,
  action: Action | EventHandler,
): string {
  // Content-addressed identity is read from the STAMPS set at action creation
  // (`applyImplementationHash` + `schedulerInstanceKey`, runner.ts) — the
  // single identity channel; there is deliberately no re-derivation here (a
  // fallback that reached through `action.module` would silently diverge from
  // the stamps — it once did, dropping the per-instance key). `.src` is never
  // consulted (debug-only; its source-map path is broken/colliding).
  //
  // The content address is per-SYMBOL — it identifies the implementation, not
  // the action instance. The action id must stay per-INSTANCE (it keys
  // `actionStats` and the durable observation), so the source-independent
  // `schedulerInstanceKey` (a hash of the action's process/reads/writes) is
  // appended. Without it, N instances of one hoisted op (e.g. one `lift`
  // called twice / a `map`) would collide on a single id. The fingerprint
  // deliberately keeps NO instance key (it is the per-symbol code identity).
  const instanceKey = (action as { schedulerInstanceKey?: unknown })
    .schedulerInstanceKey;
  const implementationHash =
    (action as { implementationHash?: unknown }).implementationHash;
  if (typeof implementationHash === "string" && implementationHash.length > 0) {
    return typeof instanceKey === "string" && instanceKey.length > 0
      ? `${implementationHash}:${instanceKey}`
      : implementationHash;
  }
  if (action.name && action.name !== "anonymous") return action.name;

  const existingId = state.anonymousActionIds.get(action);
  if (existingId) return existingId;

  const generatedId = `anon-${++state.anonymousActionCounter}`;
  state.anonymousActionIds.set(action, generatedId);
  return generatedId;
}

/**
 * Just the readable name of an action, without the rest of its telemetry.
 *
 * `getSchedulerActionTelemetryInfo` formats every annotated read and write on
 * the way to producing these two names, which is the bulk of its work and none
 * of what a caller wanting a label uses. Both names are plain properties, so
 * this is two reads and no allocation.
 */
export function getSchedulerActionName(
  action: Action | EventHandler,
): string | undefined {
  const annotated = action as Partial<TelemetryAnnotations>;
  // `||`, so an empty name falls through rather than winning: a name a reader
  // cannot use is not a name.
  return getOptionalName(annotated.module) ||
    getOptionalName(annotated.pattern);
}

export function getSchedulerActionTelemetryInfo(
  action: Action | EventHandler,
): SchedulerActionInfo | undefined {
  const annotated = action as Partial<TelemetryAnnotations>;

  const patternName = getOptionalName(annotated.pattern);
  const moduleName = getOptionalName(annotated.module);
  const reads = Array.isArray(annotated.reads)
    ? annotated.reads.map(formatTelemetryLink)
    : undefined;
  const writes = Array.isArray(annotated.writes)
    ? annotated.writes.map(formatTelemetryLink)
    : undefined;

  if (!patternName && !moduleName && !reads?.length && !writes?.length) {
    return undefined;
  }

  return {
    patternName,
    moduleName,
    reads: reads?.length ? reads : undefined,
    writes: writes?.length ? writes : undefined,
  };
}

function formatTelemetryLink(link: NormalizedFullLink): string {
  const path = link.path.length ? `/${link.path.join("/")}` : "";
  return `${link.space}/${link.id}${path}`;
}

function getOptionalName(value: unknown): string | undefined {
  if (!isObjectOrArray(value)) return undefined;
  const debugName = value.debugName;
  if (typeof debugName === "string") return debugName;
  const name = value.name;
  return typeof name === "string" ? name : undefined;
}

export function recordTriggerTrace(
  state: { readonly triggerTrace: TriggerTraceEntry[] },
  entry: TriggerTraceEntry,
): void {
  state.triggerTrace.push(entry);
  if (state.triggerTrace.length > MAX_TRIGGER_TRACE_HISTORY) {
    state.triggerTrace.shift();
  }
}

export function createEventPreflightTraceContext(): EventPreflightTraceContext {
  return {
    visitCount: 0,
    dirtyInputCount: 0,
    resultTrueCount: 0,
    workSetAddCount: 0,
    reverseDependencyActionCount: 0,
    reverseDependencyEdgeCount: 0,
    logReadCount: 0,
    logShallowReadCount: 0,
    writerCandidateCount: 0,
    writerOverlapCount: 0,
    directWriterCount: 0,
    actionSummaries: new Map(),
    rootDirectWriterActions: new Set(),
  };
}

export function toActionRunTraceAddress(
  address: IMemorySpaceAddress,
): ActionRunTraceAddress {
  return {
    space: address.space,
    entityId: address.id,
    path: address.path.map((part) => String(part)),
  };
}

export function summarizeTriggerTraceValue(
  value: unknown,
): TriggerTraceValueSummary {
  if (value === undefined) return { kind: "undefined" };
  if (value === null) return { kind: "null", preview: null };
  if (typeof value === "boolean") return { kind: "boolean", preview: value };
  if (typeof value === "number") return { kind: "number", preview: value };
  if (typeof value === "string") {
    return {
      kind: "string",
      size: value.length,
      preview: value.length > 80 ? `${value.slice(0, 77)}...` : value,
    };
  }
  if (Array.isArray(value)) {
    return { kind: "array", size: value.length };
  }
  if (isObjectOrArray(value)) {
    return { kind: "object", size: Object.keys(value).length };
  }
  return { kind: "other", preview: Object.prototype.toString.call(value) };
}

export function getPieceMetadataFromFrame(frame?: Frame): {
  spellId?: string;
  patternId?: string;
  space?: string;
  pieceId?: string;
} {
  // TODO(seefeld): This is a rather hacky way to get the context, based on the
  // unsafe_binding pattern. Once we replace that mechanism, let's add nicer
  // abstractions for context here as well.
  frame ??= getTopFrame();

  const resultAsProxy = frame?.unsafe_binding?.materialize([]);

  if (!isCellResultForDereferencing(resultAsProxy)) {
    return {};
  }
  const result: ReturnType<typeof getPieceMetadataFromFrame> = {};
  const resultCell = getCellOrThrow(resultAsProxy);
  // Diagnostic context only: the content identity of the running pattern. The
  // `pattern` meta link and patternId are retired; `patternIdentity` is the
  // single pointer. Read it inline (no import from runner.ts, to avoid a module
  // cycle) and fall back to the in-hand pattern's entry ref when the cell has no
  // stored pointer (a keyless run()).
  const storedIdentity = resultCell.getMetaRaw("patternIdentity");
  result.patternId = (isObjectOrArray(storedIdentity) &&
      typeof storedIdentity.identity === "string"
    ? storedIdentity.identity
    : undefined) ??
    (frame?.unsafe_binding?.pattern
      ? frame.runtime?.patternManager.getArtifactEntryRef(
        frame.unsafe_binding.pattern,
      )?.identity
      : undefined);
  result.space = resultCell.space;
  // The FULL sourceURI, scheme included. All consumers are display (error
  // strings, console-log prefixes), and keeping the scheme means ids copied
  // from diagnostics paste back into tools like shell debug-utils without a
  // bare-id round trip that would have to guess the scheme.
  result.pieceId = resultCell.sourceURI;
  return result;
}

export function materializeHostVisibleStack(error: Error): void {
  if (typeof error.stack === "string" && error.stack.length > 0) {
    return;
  }
  const getStackString = (globalThis as {
    getStackString?: (error: Error) => string;
  }).getStackString;
  if (typeof getStackString !== "function") {
    return;
  }
  const frames = getStackString(error);
  if (!frames) {
    return;
  }
  error.stack = `${error}${frames.startsWith("\n") ? frames : `\n${frames}`}`;
}

export function handleSchedulerError(
  state: {
    readonly errorHandlers: ReadonlySet<ErrorHandler>;
    readonly parseStack: (stack: string) => string;

    /** A transaction that never commits, for reading labels apart. */
    readonly readTx: () => IExtendedStorageTransaction;
  },
  error: Error,
  action: unknown,
): void {
  const { pieceId, spellId, patternId, space } = getPieceMetadataFromFrame(
    (error as Error & { frame?: Frame }).frame,
  );

  // Transform stack trace to show original source locations — unless the
  // error already crossed a SES invoke seam that mapped it (`parseStack` is
  // not idempotent; re-parsing a mapped stack corrupts the mapped frames).
  if (!isErrorStackMapped(error)) {
    materializeHostVisibleStack(error);
    if (error.stack) {
      error.stack = state.parseStack(error.stack);
      markErrorStackMapped(error);
    }
  }

  const errorWithContext = error as ErrorWithContext;
  errorWithContext.action = action as ErrorWithContext["action"];
  const tx = (error as Error & { frame?: Frame }).frame?.tx;
  if (tx !== undefined) {
    // Read for a reader, with the broader instances' envelopes read apart
    // from the run's transaction.
    errorWithContext.consumed = () =>
      collectReaderConsumedLabel(tx, state.readTx());
  }
  if (pieceId) errorWithContext.pieceId = pieceId;
  if (spellId) errorWithContext.spellId = spellId;
  if (patternId) errorWithContext.patternId = patternId;
  if (space) errorWithContext.space = space as MemorySpace;

  for (const handler of state.errorHandlers) {
    try {
      handler(errorWithContext);
    } catch (handlerError) {
      console.error("Error in error handler:", handlerError);
    }
  }

  const prefix = state.errorHandlers.size === 0
    ? "Uncaught error in action:"
    : "Error in action:";

  console.error(
    prefix,
    String(error),
    ...(pieceId ? [`\n  pieceId: ${pieceId}`] : []),
    ...(space ? [`\n  space: ${space}`] : []),
    ...(patternId ? [`\n  patternId: ${patternId}`] : []),
    ...(error.stack ? [`\n${error.stack}`] : []),
  );
}

export function queueTask(fn: () => void): ReturnType<typeof setTimeout> {
  return setTimeout(fn, 0);
}

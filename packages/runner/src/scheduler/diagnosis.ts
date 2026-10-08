import {
  type FabricValue,
  isFabricPlainObject,
  valueEqual,
} from "@commonfabric/data-model";

import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../storage/interface.ts";
import {
  getTransactionReadDetails,
  getTransactionWriteDetails,
} from "../storage/transaction-inspection.ts";
import { ignoreReadForScheduling } from "../storage/reactivity-log.ts";
import { arraysOverlap } from "../reactive-dependencies.ts";
import { isRuntimeSecretId } from "../runtime-secret.ts";
import { normalizeCellScope } from "../scope.ts";
import type {
  CycleReport,
  NonIdempotentReport,
  RuntimeTelemetry,
  SchedulerActionInfo,
  SchedulerDiagnosisResult,
} from "../telemetry.ts";
import { txToReactivityLog } from "./reactivity.ts";
import { mapsEqual } from "./topology.ts";
import type { Action, ReactivityLog } from "./types.ts";

export type DiagnosisRecord = {
  readValues: Map<string, FabricValue>;
  writeValues: Map<string, FabricValue>;
  timestamp: number;
};

export type CausalEdge = {
  writer: string;
  cell: string;
  triggered: string;
  timestamp: number;
};

export interface SchedulerDiagnosisControlState {
  /** The channel the `scheduler.diagnosis.start` marker is emitted on. */
  readonly telemetry: RuntimeTelemetry;

  readonly getDiagnosisEnabled: () => boolean;
  readonly setDiagnosisEnabled: (enabled: boolean) => void;
  readonly getDiagnosisTimeout: () => ReturnType<typeof setTimeout> | null;
  readonly setDiagnosisTimeout: (
    timeout: ReturnType<typeof setTimeout> | null,
  ) => void;
  readonly getDiagnosisStartTime: () => number;
  readonly setDiagnosisStartTime: (time: number) => void;
  readonly getDiagnosisBusyTime: () => number;
  readonly setDiagnosisBusyTime: (time: number) => void;
  readonly getDiagnosisResolve: () =>
    | ((result: SchedulerDiagnosisResult) => void)
    | null;
  readonly setDiagnosisResolve: (
    resolve: ((result: SchedulerDiagnosisResult) => void) | null,
  ) => void;
  readonly diagnosisHistory: Map<string, DiagnosisRecord[]>;
  readonly diagnosisNonIdempotent: NonIdempotentReport[];
  readonly causalEdges: CausalEdge[];
  readonly idempotencyViolations: NonIdempotentReport[];
  readonly computations: ReadonlySet<Action>;
  readonly setIdempotencyCheckMode: (enabled: boolean) => void;
  readonly runAction: (action: Action) => Promise<unknown>;
}

export function makeAddressKey(addr: IMemorySpaceAddress): string {
  return `${addr.space}/${addr.id}/${addr.path.join("/")}`;
}

function unwrapTransactionDetailValue(
  value: FabricValue,
): FabricValue {
  return isFabricPlainObject(value) && "value" in value ? value.value : value;
}

export function captureTransactionWrites(
  tx: IExtendedStorageTransaction,
  writes: readonly IMemorySpaceAddress[],
  options: { errorValue?: FabricValue } = {},
): Map<string, FabricValue> {
  const writeValues = new Map<string, FabricValue>();
  const writeDetailsBySpace = new Map<string, Map<string, FabricValue>>();

  for (const write of writes) {
    const key = makeAddressKey(write);
    try {
      let details = writeDetailsBySpace.get(write.space);
      if (!details) {
        details = new Map<string, FabricValue>();
        for (const detail of getTransactionWriteDetails(tx, write.space)) {
          details.set(
            makeAddressKey(detail.address),
            unwrapTransactionDetailValue(detail.value),
          );
        }
        writeDetailsBySpace.set(write.space, details);
      }
      // Record only value-carrying writes — those the transaction journal has
      // novelty for. An address that is in the reactivity write log but produced
      // no novelty is a no-op write or a read-triggered materialization touch
      // (for example, resolving a redirect link into a replica the first time it
      // is read). Such a touch happens in a fresh recheck run but not in the
      // original run, which already materialized it; recording it would make the
      // idempotency comparison see a differing write where the computation's
      // output did not actually change.
      if (details.has(key)) {
        writeValues.set(key, details.get(key));
      }
    } catch (error) {
      if (!("errorValue" in options)) throw error;
      writeValues.set(key, options.errorValue);
    }
  }

  return writeValues;
}

export function captureCommittedReads(
  reads: readonly IMemorySpaceAddress[],
  createReadTx: () => IExtendedStorageTransaction,
): Map<string, FabricValue> {
  const readValues = new Map<string, FabricValue>();

  for (const read of reads) {
    // No code reads a runtime secret, and a diagnosis records what it reads.
    if (isRuntimeSecretId(read.id)) continue;
    const key = makeAddressKey(read);
    let readerTx: IExtendedStorageTransaction | undefined;
    try {
      readerTx = createReadTx();
      const result = readerTx.tx.read(
        {
          space: read.space,
          id: read.id,
          path: [...read.path],
        },
        { meta: ignoreReadForScheduling },
      );
      readValues.set(key, result.ok?.value);
    } catch {
      readValues.set(key, "[read-error]");
    } finally {
      readerTx?.abort();
    }
  }

  return readValues;
}

export function findDifferingWriteKeys(
  previousWrites: Map<string, FabricValue>,
  latestWrites: Map<string, FabricValue>,
  options: { keySet?: "union" | "latest" } = {},
): string[] {
  const keys = options.keySet === "latest"
    ? latestWrites.keys()
    : new Set([...latestWrites.keys(), ...previousWrites.keys()]).keys();
  const differingKeys: string[] = [];

  for (const key of keys) {
    if (!previousWrites.has(key) || !latestWrites.has(key)) {
      differingKeys.push(key);
      continue;
    }
    if (!valueEqual(previousWrites.get(key), latestWrites.get(key))) {
      differingKeys.push(key);
    }
  }

  return differingKeys;
}

export function findNonIdempotentPair(
  history: DiagnosisRecord[],
): {
  previous: DiagnosisRecord;
  latest: DiagnosisRecord;
  differingWriteKeys: string[];
} | undefined {
  if (history.length < 2) return undefined;

  const latest = history[history.length - 1];
  for (const previous of history.slice(0, -1)) {
    // Same reads with different writes is the diagnosis signal.
    if (!mapsEqual(latest.readValues, previous.readValues)) continue;

    const differingWriteKeys = findDifferingWriteKeys(
      previous.writeValues,
      latest.writeValues,
    );
    if (differingWriteKeys.length > 0) {
      return { previous, latest, differingWriteKeys };
    }
  }

  return undefined;
}

/**
 * Values a transaction observed for its reads (its read invariants), keyed
 * by address. Available after commit/abort since per-document snapshots are
 * pinned for the transaction's lifetime.
 */
function transactionReadInvariants(
  tx: IExtendedStorageTransaction,
  spaces: ReadonlySet<IMemorySpaceAddress["space"]>,
): Map<
  string,
  { address: IMemorySpaceAddress; value?: FabricValue }
> {
  const invariants = new Map<
    string,
    { address: IMemorySpaceAddress; value?: FabricValue }
  >();
  for (const space of spaces) {
    try {
      for (const detail of getTransactionReadDetails(tx, space)) {
        // makeAddressKey ignores scope; include it so same id+path reads
        // under different cell scopes don't collide.
        const key = `${normalizeCellScope(detail.address.scope)}|${
          makeAddressKey(detail.address)
        }`;
        invariants.set(key, {
          address: detail.address,
          value: detail.value,
        });
      }
    } catch { /* read details unavailable — treat as no invariants */ }
  }
  return invariants;
}

/**
 * Whether an input read by both runs changed value between them without the
 * action itself having written it. That means a concurrent writer (another
 * action's commit rollback, or a cross-runtime sync apply in multi-runtime
 * setups) landed between the first run and the recheck — the two runs
 * computed over different inputs, so differing writes say nothing about
 * idempotency. Self-caused moves (the action reads what it writes, the
 * accumulator anti-pattern) stay flagged.
 */
function readInvariantMovedExternally(
  tx: IExtendedStorageTransaction,
  tx2: IExtendedStorageTransaction,
  log: ReactivityLog,
  log2: ReactivityLog,
): boolean {
  const spaces = new Set<IMemorySpaceAddress["space"]>();
  for (const read of log.reads) spaces.add(read.space);
  for (const read of log.shallowReads) spaces.add(read.space);
  for (const read of log2.reads) spaces.add(read.space);
  for (const read of log2.shallowReads) spaces.add(read.space);
  const before = transactionReadInvariants(tx, spaces);
  if (before.size === 0) return false;
  const after = transactionReadInvariants(tx2, spaces);
  for (const [key, { address, value }] of after) {
    const previous = before.get(key);
    // Only reads both runs performed are comparable.
    if (!previous) continue;
    if (valueEqual(previous.value, value)) continue;
    // Cover writes of EITHER run: run1's commit moving its own read is the
    // accumulator pattern, and a write-then-read inside the recheck run is
    // nondeterminism, not external interference — both must stay flagged.
    // Scope participates in the match: different scopes are different
    // documents, so a write in another scope cannot have moved this read.
    const coveredByOwnWrites = [...log.writes, ...log2.writes].some((write) =>
      write.space === address.space && write.id === address.id &&
      normalizeCellScope(write.scope) === normalizeCellScope(address.scope) &&
      arraysOverlap(write.path, address.path)
    );
    if (!coveredByOwnWrites) return true;
  }
  return false;
}

export function runIdempotencyRecheck(
  state: {
    readonly idempotencyViolations: NonIdempotentReport[];
    readonly createTx: () => IExtendedStorageTransaction;
    readonly invoke: (fn: () => unknown) => unknown;
    readonly getActionId: (action: Action) => string;
    readonly getActionTelemetryInfo: (
      action: Action,
    ) => SchedulerActionInfo | undefined;
  },
  action: Action,
  tx: IExtendedStorageTransaction,
  log: ReactivityLog,
): void {
  const writes1 = captureTransactionWrites(tx, log.writes);

  const tx2 = state.createTx();
  let isAsync = false;
  try {
    const result = state.invoke(() => action(tx2));
    // Async actions (e.g. raw module actions like wish) can't be safely
    // rechecked: their continuations may fire side effects (runtime.runSynced,
    // sub-pattern instantiation) that persist beyond tx2.abort(). Skip the
    // comparison entirely and just swallow the dangling promise.
    if (result && typeof (result as Promise<unknown>).then === "function") {
      isAsync = true;
      (result as Promise<unknown>).then(undefined, () => {});
    }
  } catch { /* ignore errors */ }
  const log2 = txToReactivityLog(tx2);
  const writes2 = isAsync
    ? new Map()
    : captureTransactionWrites(tx2, log2.writes);

  // Skip comparison for async actions; writes are incomplete/unreliable.
  if (isAsync) {
    tx2.abort();
    return;
  }

  const differingKeys = findDifferingWriteKeys(writes1, writes2, {
    keySet: "latest",
  });

  if (differingKeys.length === 0) {
    tx2.abort();
    return;
  }

  // Differing writes only witness non-idempotency if both runs read the same
  // inputs (capture both runs' read invariants before aborting tx2).
  const inputsMoved = readInvariantMovedExternally(tx, tx2, log, log2);
  tx2.abort();
  if (inputsMoved) return;

  const actionId = state.getActionId(action);
  // Deduplicate: only record first violation per action.
  if (state.idempotencyViolations.some((v) => v.actionId === actionId)) {
    return;
  }

  state.idempotencyViolations.push({
    actionId,
    actionInfo: state.getActionTelemetryInfo(action),
    runs: [
      {
        timestamp: performance.now(),
        reads: {},
        writes: Object.fromEntries(writes1),
      },
      {
        timestamp: performance.now(),
        reads: {},
        writes: Object.fromEntries(writes2),
      },
    ],
    differingWriteKeys: differingKeys,
  });
}

export function captureDiagnosisRecord(state: {
  readonly diagnosisHistory: Map<string, DiagnosisRecord[]>;
  readonly diagnosisNonIdempotent: NonIdempotentReport[];
  readonly createReadTx: () => IExtendedStorageTransaction;
  readonly getActionTelemetryInfo: (
    action: Action,
  ) => SchedulerActionInfo | undefined;
}, args: {
  readonly actionId: string;
  readonly action: Action;
  readonly tx: IExtendedStorageTransaction;
  readonly log: ReactivityLog;
}): void {
  const record = {
    // Committed reads model what a later run with the same inputs would see.
    readValues: captureCommittedReads(args.log.reads, state.createReadTx),
    writeValues: captureTransactionWrites(args.tx, args.log.writes, {
      errorValue: "[write-error]",
    }),
    timestamp: performance.now(),
  };

  // Store in ring buffer (max 10 per action).
  let history = state.diagnosisHistory.get(args.actionId);
  if (!history) {
    history = [];
    state.diagnosisHistory.set(args.actionId, history);
  }
  history.push(record);
  if (history.length > 10) {
    history.shift();
  }

  const nonIdempotent = findNonIdempotentPair(history);
  if (!nonIdempotent) return;

  // Non-idempotent detected. Only report once per action.
  const existing = state.diagnosisNonIdempotent.find(
    (r) => r.actionId === args.actionId,
  );
  if (existing) return;

  state.diagnosisNonIdempotent.push({
    actionId: args.actionId,
    actionInfo: state.getActionTelemetryInfo(args.action),
    runs: [
      {
        timestamp: nonIdempotent.previous.timestamp,
        reads: Object.fromEntries(nonIdempotent.previous.readValues),
        writes: Object.fromEntries(nonIdempotent.previous.writeValues),
      },
      {
        timestamp: nonIdempotent.latest.timestamp,
        reads: Object.fromEntries(nonIdempotent.latest.readValues),
        writes: Object.fromEntries(nonIdempotent.latest.writeValues),
      },
    ],
    differingWriteKeys: nonIdempotent.differingWriteKeys,
  });
}

export function startSchedulerDiagnosis(
  state: SchedulerDiagnosisControlState,
  durationMs = 5000,
): void {
  if (state.getDiagnosisEnabled()) return;

  state.setDiagnosisEnabled(true);
  state.setDiagnosisStartTime(performance.now());
  state.setDiagnosisBusyTime(0);
  state.diagnosisHistory.clear();
  state.diagnosisNonIdempotent.length = 0;
  state.causalEdges.length = 0;

  state.setDiagnosisTimeout(
    setTimeout(() => {
      stopSchedulerDiagnosis(state);
    }, durationMs),
  );
  state.telemetry.submit({ type: "scheduler.diagnosis.start", durationMs });
}

export function stopSchedulerDiagnosis(
  state: SchedulerDiagnosisControlState,
): void {
  if (!state.getDiagnosisEnabled()) return;

  state.setDiagnosisEnabled(false);
  const diagnosisTimeout = state.getDiagnosisTimeout();
  if (diagnosisTimeout) {
    clearTimeout(diagnosisTimeout);
    state.setDiagnosisTimeout(null);
  }

  const duration = performance.now() - state.getDiagnosisStartTime();
  const cycles = detectCausalCycles(state.causalEdges);

  const result: SchedulerDiagnosisResult = {
    nonIdempotent: state.diagnosisNonIdempotent,
    cycles,
    duration,
    busyTime: state.getDiagnosisBusyTime(),
  };

  state.diagnosisHistory.clear();
  state.causalEdges.length = 0;

  const resolve = state.getDiagnosisResolve();
  if (resolve) {
    resolve(result);
    state.setDiagnosisResolve(null);
  }
}

export function runSchedulerDiagnosis(
  state: SchedulerDiagnosisControlState,
  durationMs = 5000,
): Promise<SchedulerDiagnosisResult> {
  if (state.getDiagnosisEnabled()) {
    stopSchedulerDiagnosis(state);
  }

  return new Promise<SchedulerDiagnosisResult>((resolve) => {
    state.setDiagnosisResolve(resolve);
    startSchedulerDiagnosis(state, durationMs);
  });
}

export async function runSchedulerIdempotencyCheck(
  state: SchedulerDiagnosisControlState,
): Promise<SchedulerDiagnosisResult> {
  state.idempotencyViolations.length = 0;
  state.setIdempotencyCheckMode(true);

  try {
    // Snapshot computations to avoid iterating a live Set.
    const computationsSnapshot = [...state.computations];
    for (const action of computationsSnapshot) {
      await state.runAction(action);
    }
  } finally {
    state.setIdempotencyCheckMode(false);
  }

  return {
    nonIdempotent: [...state.idempotencyViolations],
    cycles: [],
    duration: 0,
    busyTime: 0,
  };
}

export function detectCausalCycles(
  causalEdges: readonly Pick<CausalEdge, "writer" | "triggered" | "cell">[],
): CycleReport[] {
  // Build adjacency list: writer -> [{ triggered, cell }]
  const adj = new Map<string, { triggered: string; cell: string }[]>();
  for (const edge of causalEdges) {
    let neighbors = adj.get(edge.writer);
    if (!neighbors) {
      neighbors = [];
      adj.set(edge.writer, neighbors);
    }
    neighbors.push({ triggered: edge.triggered, cell: edge.cell });
  }

  const cycles: CycleReport[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: { actionId: string; writesCell: string }[] = [];

  const dfs = (node: string) => {
    if (inStack.has(node)) {
      // Found a cycle - extract it from the stack
      const cycleStart = stack.findIndex((s) => s.actionId === node);
      if (cycleStart !== -1) {
        const cycle = stack.slice(cycleStart);
        cycles.push({
          cycle: [...cycle],
          timestamp: performance.now(),
        });
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);

    const neighbors = adj.get(node) ?? [];
    for (const { triggered, cell } of neighbors) {
      stack.push({ actionId: node, writesCell: cell });
      dfs(triggered);
      stack.pop();
    }

    inStack.delete(node);
  };

  for (const node of adj.keys()) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  return cycles;
}

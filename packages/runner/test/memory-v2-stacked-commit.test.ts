/**
 * A session's stack of in-flight commits against a scripted memory server:
 * which commits survive a conflict below them, what a reader sees while the
 * stack is pending and after a revert, the reads a commit carries on the
 * wire, and the parking, shadowing, cascade, and read-repair choreography
 * around a verdict.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/api";
import { NullLiveEnvironment } from "@commonfabric/data-model/codec-common";
import {
  fabricFromJsonValue,
  jsonFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { FabricEpochNsec } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import type { MIME, URI } from "@commonfabric/memory/interface";
import {
  type CommitPrecondition,
  type EntityDocument,
  getMemoryProtocolFlags,
  type PatchOp,
  resetServerExecutionConfig,
  type SessionSync,
  setServerExecutionConfig,
  type SqliteOperation,
  toDocumentPath,
} from "@commonfabric/memory/v2";
import type {
  ClientCommit,
  ConfirmedRead,
  Operation,
  PendingRead,
} from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type { AppliedCommit } from "@commonfabric/memory/v2/engine";
import {
  getLogger,
  getLoggerCountsBreakdown,
} from "@commonfabric/utils/logger";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { applyPatch } from "../../memory/v2/patch.ts";
import {
  parentPath,
  parsePointer,
  pathsOverlap,
} from "../../memory/v2/path.ts";
import type {
  IStorageProvider,
  IStorageTransaction,
  StorageNotification,
} from "../src/storage/interface.ts";
import {
  setConflictAdmissionMode,
  type SpaceReplica,
} from "../src/storage/v2.ts";
import type { RuntimeTelemetryMarker } from "../src/telemetry.ts";
import {
  NotificationRecorder,
  ScriptedSessionTransport,
  type ScriptedTransportMessage,
  SingleSessionFactory,
  testSessionOpenAuthFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("memory-v2-stacked-commit");
const space = signer.did();
const DOCUMENT_MIME = "application/json" as const;
const testLiveEnvironment = new NullLiveEnvironment(
  "no cell reconstruction in stacked commit transport",
);
const DOCS = {
  A: "of:memory-v2-stacked-A" as URI,
  B: "of:memory-v2-stacked-B" as URI,
  C: "of:memory-v2-stacked-C" as URI,
  D: "of:memory-v2-stacked-D" as URI,
} as const;
type DocKey = keyof typeof DOCS;

type TestProvider = IStorageProvider & {
  get(uri: URI): EntityDocument | undefined;
  sink(
    uri: URI,
    callback: (value: EntityDocument | undefined) => void,
  ): () => void;
};

type RootValue = FabricValue;
type DocState = {
  seq: number;
  value: RootValue;
};
type AppliedRecord = {
  localSeq: number;
  commit: ClientCommit;
  applied: AppliedCommit;
  touched: TouchedWrite[];
};
type RejectionError = {
  name: string;
  message: string;

  /**
   * Mirrors the real server's retryable-conflict marker: the client attaches
   * `readyToRetry` (the read-repair gate) ONLY when a ConflictError carries a
   * numeric `retryAfterSeq`. Opt-in via the rejectConflict outcome — absent
   * everywhere else so existing rejections stay gate-less.
   */
  retryAfterSeq?: number;
};
type RejectedRecord = {
  localSeq: number;
  commit: ClientCommit;
  error: RejectionError;
};
type ScriptedOutcome =
  | {
    kind: "accept";
    remoteInterleave?: RemoteCommit;
    responseGate?: Promise<void>;
    onReceipt?: () => void;

    /**
     * Skip validateReads for this commit. Forces the "impossible" late
     * accept — a server verdict resolving a pending dependency the client
     * already dropped — so the cascade's late-verdict suppression can be
     * pinned (the real server can never produce it once resolution-only
     * pending reads are emitted).
     */
    skipReadValidation?: true;
  }
  | {
    kind: "rejectConflict";
    message?: string;

    /** See {@link RejectionError.retryAfterSeq}. */
    retryAfterSeq?: number;

    remoteInterleave?: RemoteCommit;
    responseGate?: Promise<void>;
    onReceipt?: () => void;
  }
  | {
    kind: "dropThenReplayAccept";
    remoteInterleave?: RemoteCommit;
    responseGate?: Promise<void>;
    onReceipt?: () => void;
  }
  | {
    kind: "dropThenReplayReject";
    message?: string;
    remoteInterleave?: RemoteCommit;
    responseGate?: Promise<void>;
    onReceipt?: () => void;
  };
type RemoteCommit = {
  label: string;
  operations: RootOp[];
};
type RootOp =
  | { op: "set"; id: URI; value: RootValue }
  | { op: "delete"; id: URI };
type TouchedWrite = {
  id: URI;
  paths: string[][];
};
type LocalPendingVersion = {
  localSeq: number;
  value: RootValue;
};
type LocalDocModel = {
  confirmedSeq: number;
  confirmed: RootValue;
  pending: LocalPendingVersion[];
};
type ResultRecord = {
  localSeq: number;
  status: "ok" | "error";
  message?: string;
};

// The staleness-bearing top of a pending read's dependency set: the highest
// listed layer (scalar reads are their own top).
const localSeqTop = (read: { localSeq: number | number[] }): number =>
  Array.isArray(read.localSeq) ? Math.max(...read.localSeq) : read.localSeq;

class ScriptedServerModel {
  connectionCount = 0;
  transactLocalSeqs: number[] = [];
  readonly confirmed = new Map<URI, DocState>();
  readonly applied = new Map<number, AppliedRecord>();
  readonly rejected = new Map<number, RejectedRecord>();
  readonly scripted = new Map<number, ScriptedOutcome>();
  readonly dropped = new Set<number>();
  serverSeq = 0;
  sessionId = "session:stacked";

  constructor() {
    for (const id of Object.values(DOCS)) {
      this.confirmed.set(id, { seq: 0, value: undefined });
    }
  }

  setOutcome(localSeq: number, outcome: ScriptedOutcome): void {
    this.scripted.set(localSeq, outcome);
  }

  seed(id: URI, value: RootValue): DocState {
    return this.#applyRootCommit({
      label: "seed",
      operations: [{ op: value === undefined ? "delete" : "set", id, value }],
    }).states.get(id)!;
  }

  injectRemote(remote: RemoteCommit): void {
    this.#applyRootCommit(remote);
  }

  transact(
    commit: ClientCommit,
  ): { type: "accept"; applied: AppliedCommit } | {
    type: "reject";
    error: RejectionError;
  } | { type: "drop" } {
    const priorApplied = this.applied.get(commit.localSeq);
    if (priorApplied) {
      return { type: "accept", applied: priorApplied.applied };
    }
    const priorRejected = this.rejected.get(commit.localSeq);
    if (priorRejected) {
      return { type: "reject", error: priorRejected.error };
    }

    const scripted = this.scripted.get(commit.localSeq) ?? { kind: "accept" };
    if (scripted.remoteInterleave) {
      this.#applyRootCommit(scripted.remoteInterleave);
    }

    // A scripted retryAfterSeq marks whichever ConflictError this commit
    // produces (the natural stale-read error below included) as retryable,
    // matching the real server attaching it to every conflict verdict.
    const retryAfterSeq = scripted.kind === "rejectConflict"
      ? scripted.retryAfterSeq
      : undefined;

    const readError =
      scripted.kind === "accept" && scripted.skipReadValidation === true
        ? null
        : this.#validateReads(commit);
    if (readError) {
      return this.#reject(
        commit,
        retryAfterSeq === undefined
          ? readError
          : { ...readError, retryAfterSeq },
      );
    }

    const shouldDrop = scripted.kind === "dropThenReplayAccept" ||
      scripted.kind === "dropThenReplayReject";
    const shouldReject = scripted.kind === "rejectConflict" ||
      scripted.kind === "dropThenReplayReject";

    if (shouldReject) {
      const rejected = this.#reject(commit, {
        name: "ConflictError",
        message: scripted.message ?? "synthetic conflict",
        ...(retryAfterSeq !== undefined ? { retryAfterSeq } : {}),
      });
      if (shouldDrop && !this.dropped.has(commit.localSeq)) {
        this.dropped.add(commit.localSeq);
        return { type: "drop" };
      }
      return rejected;
    }

    const applied = this.#accept(commit);
    if (shouldDrop && !this.dropped.has(commit.localSeq)) {
      this.dropped.add(commit.localSeq);
      return { type: "drop" };
    }
    return applied;
  }

  #validateReads(
    commit: ClientCommit,
  ): RejectionError | null {
    for (const read of commit.reads.pending) {
      // Mirrors resolvePendingReads in packages/memory/v2/engine.ts: every
      // element of an array localSeq must have resolved to an accepted
      // commit, and staleness is scanned once, based at the HIGHEST element
      // (the doc's top-of-stack below the reader). Scanning lower layers
      // would false-conflict with the session's own later stacked writes —
      // the exact hazard the max-basis rule exists to avoid. (This double
      // ignores a read's `basisSeq` and applies that max-dependency basis to
      // every reader; the true-basis path — `basisSeq` with own-session
      // exclusion — is exercised against the real engine in
      // packages/memory/test/v2-pending-read-basis-overadvance.test.ts.)
      const layers = Array.isArray(read.localSeq)
        ? read.localSeq
        : [read.localSeq];
      let basis: AppliedRecord | undefined;
      let unresolved: number | undefined;
      for (const layer of layers) {
        const dependency = this.applied.get(layer);
        if (!dependency) {
          unresolved = layer;
          break;
        }
        if (
          basis === undefined || dependency.applied.seq > basis.applied.seq
        ) {
          basis = dependency;
        }
      }
      if (unresolved !== undefined || basis === undefined) {
        return {
          name: "ConflictError",
          message: `pending dependency localSeq=${unresolved}`,
        };
      }
      for (const accepted of this.applied.values()) {
        if (accepted.applied.seq <= basis.applied.seq) {
          continue;
        }
        if (accepted.touched.some((write) => readOverlapsWrite(read, write))) {
          return {
            name: "ConflictError",
            message: `stale pending read localSeq=${localSeqTop(read)}`,
          };
        }
      }
    }

    for (const read of commit.reads.confirmed) {
      const current = this.confirmed.get(read.id as URI) ?? {
        seq: 0,
        value: undefined,
      };
      if (current.seq !== read.seq) {
        return {
          name: "ConflictError",
          message: `stale confirmed read seq=${read.seq} actual=${current.seq}`,
        };
      }
    }

    return null;
  }

  #reject(
    commit: ClientCommit,
    error: RejectionError,
  ) {
    this.rejected.set(commit.localSeq, {
      localSeq: commit.localSeq,
      commit,
      error,
    });
    return { type: "reject" as const, error };
  }

  #accept(commit: ClientCommit) {
    const touched = commit.operations.flatMap((operation) =>
      touchedWritesForOperation(operation)
    );
    const revisions = commit.operations
      .filter((operation) => operation.op !== "sqlite")
      .map((operation, index) => ({
        id: operation.id,
        branch: "",
        seq: this.serverSeq + 1,
        opIndex: index,
        commitSeq: this.serverSeq + 1,
        op: operation.op,
      }));
    const applied = {
      seq: ++this.serverSeq,
      branch: "",
      revisions,
    } as AppliedCommit;

    for (const operation of commit.operations) {
      if (operation.op === "sqlite") continue;
      const next = applyOperation(
        operation,
        this.confirmed.get(operation.id as URI)?.value,
      );
      this.confirmed.set(operation.id as URI, {
        seq: applied.seq,
        value: next,
      });
    }

    this.applied.set(commit.localSeq, {
      localSeq: commit.localSeq,
      commit,
      applied,
      touched,
    });

    return { type: "accept" as const, applied };
  }

  #applyRootCommit(
    remote: RemoteCommit,
  ): { states: Map<URI, DocState> } {
    const seq = ++this.serverSeq;
    const states = new Map<URI, DocState>();
    for (const operation of remote.operations) {
      const next = operation.op === "delete"
        ? undefined
        : operation.value === undefined
        ? undefined
        : clone(operation.value);
      const state = { seq, value: next };
      this.confirmed.set(operation.id, state);
      states.set(operation.id, state);
    }
    return { states };
  }
}

class ScriptedModelTransport extends ScriptedSessionTransport {
  constructor(readonly model: ScriptedServerModel) {
    super({ name: "stacked", sessionId: model.sessionId, space });
  }

  protected override openServerSeq(): number {
    return this.model.serverSeq;
  }

  protected override onHello(): void {
    this.model.connectionCount += 1;
  }

  /**
   * Decodes a commit payload, which carries full `FabricValue`s, with a context
   * that _fails_ on cell reconstruction rather than the default memory context.
   */
  protected override decode(payload: string): ScriptedTransportMessage {
    return fabricFromJsonValue(
      payload,
      testLiveEnvironment,
    ) as ScriptedTransportMessage;
  }

  protected override encode(message: unknown): string {
    return jsonFromFabricValue(message as FabricValue);
  }

  /**
   * Does nothing: the harness owns teardown, and closing the session must not
   * signal a disconnect (which would trigger client reconnect churn
   * mid-assertion).
   */
  protected override onClose(): void {}

  protected override handle(message: ScriptedTransportMessage): void {
    switch (message.type) {
      case "session.watch.set":
      case "session.watch.add":
        // Registers the watch but returns an empty sync: the harness NEVER
        // volunteers document state — catch-up only arrives when a test
        // explicitly delivers it via pushSync, so tests control the wire
        // order of verdicts vs updates.
        this.respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: this.model.serverSeq,
            sync: {
              type: "sync",
              fromSeq: this.model.serverSeq,
              toSeq: this.model.serverSeq,
              upserts: [],
              removes: [],
            },
          },
        });
        break;
      case "transact": {
        const commit = message.commit as ClientCommit;
        // Receipt-time bookkeeping: `transactLocalSeqs` records that a commit
        // reached the server even while its verdict is still gated. The
        // cascade tests (and the stress bookkeeping) use it to distinguish
        // "sent, verdict in flight" from "never sent".
        this.model.transactLocalSeqs.push(commit.localSeq);
        const scripted = this.model.scripted.get(commit.localSeq);
        scripted?.onReceipt?.();
        const responseGate = scripted?.responseGate;
        const verdictTask = new Promise<void>((resolveVerdict) => {
          setTimeout(() => {
            void (async () => {
              try {
                await responseGate;
                const response = this.model.transact(commit);
                if (response.type === "drop") {
                  this.disconnect(new Error("disconnect"));
                  return;
                }
                this.respond({
                  type: "response",
                  requestId: message.requestId!,
                  ...(response.type === "accept"
                    ? { ok: response.applied }
                    : { error: response.error }),
                });
              } finally {
                resolveVerdict();
              }
            })();
          }, 0);
        });
        this.#verdictTasks.add(verdictTask);
        void verdictTask.finally(() => this.#verdictTasks.delete(verdictTask));
        break;
      }
      default:
        throw new Error(`Unhandled scripted message: ${message.type}`);
    }
  }

  /**
   * Verdict callbacks queued by `handle()`'s transact case but not yet booked
   * into the model (their `responseGate` may still be held). `drainVerdicts()`
   * awaits them so tests can assert on final server-side bookkeeping without a
   * wall-clock sleep.
   */
  readonly #verdictTasks = new Set<Promise<void>>();

  /**
   * Resolve once every transact callback queued SO FAR (including any queued
   * while draining) has booked its verdict and sent its response. Only the
   * transport's side is drained: client-side settlement of those responses
   * is still subject to the caller awaiting the affected commit promises or
   * an observable event (e.g. a logger count).
   */
  async drainVerdicts(): Promise<void> {
    while (this.#verdictTasks.size > 0) {
      await Promise.all([...this.#verdictTasks]);
    }
  }

  /**
   * Deliver an unsolicited server-push sync frame (the real server's
   * timer-batched `session/effect` fan-out) to the client receiver. Opt-in:
   * the harness never pushes sync on its own, so a test controls exactly
   * when subscription catch-up arrives relative to commit verdicts.
   */
  pushSync(options: PushSyncOptions): void {
    this.emitSync({
      type: "sync",
      fromSeq: this.model.serverSeq,
      toSeq: this.model.serverSeq,
      ...(options.caughtUpLocalSeq !== undefined
        ? { caughtUpLocalSeq: options.caughtUpLocalSeq }
        : {}),
      upserts: (options.upserts ?? []).map((upsert) => ({
        branch: "",
        id: upsert.id,
        seq: upsert.seq,
        ...(upsert.deleted === true
          ? { deleted: true as const }
          : { doc: { value: upsert.value } }),
      })),
      removes: (options.removes ?? []).map((remove) => ({
        branch: "",
        id: remove.id,
      })),
    } as SessionSync);
  }
}

type PushSyncOptions = {
  upserts?: Array<{
    id: URI;
    seq: number;
    value?: RootValue;
    deleted?: true;
  }>;

  /** Wire REMOVES (the watch-scope eviction frame): carry NO seq — the
   * shape whose shadow records the sentinel floor 1. */
  removes?: Array<{ id: URI }>;

  /** The server's caught-up marker: resolves client + runner read-repair
   * waiters for every localSeq <= this value. */
  caughtUpLocalSeq?: number;
};

type Harness = ReturnType<typeof createHarness>;

// The scripted transports advertise no verdictCatchUpMarkers by default
// (see memory-v2-test-utils), so fixtures here script the legacy world:
// verdicts apply immediately. The parked-accept tests opt into the new
// contract with MarkerContractTransport and push their markers explicitly.
class MarkerContractTransport extends ScriptedModelTransport {
  protected override helloFlags() {
    return { ...getMemoryProtocolFlags(), verdictCatchUpMarkers: true };
  }
}

const createHarness = (
  options: {
    transport?: (model: ScriptedServerModel) => ScriptedModelTransport;
  } = {},
) => {
  const model = new ScriptedServerModel();
  const transport = options.transport?.(model) ??
    new ScriptedModelTransport(model);
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL(`memory://runner-v2-stacked-${crypto.randomUUID()}`),
  }, sessionFactory);
  const notifications = new NotificationRecorder();
  // Every push marker the replica emits, in order. A commit refused at a
  // pre-send checkpoint still opens and closes a span, so these are what
  // prove the refusal stays countable on the surface the storm was found on.
  const telemetryMarkers: RuntimeTelemetryMarker[] = [];
  storageManager.setTelemetry({
    submit: (marker: RuntimeTelemetryMarker) => {
      telemetryMarkers.push(marker);
    },
  });
  const provider = storageManager.open(space) as TestProvider;
  storageManager.subscribe(notifications);

  const replica = provider.replica as unknown as {
    commitNative(
      transaction: {
        operations: Array<
          | { op: "set"; id: URI; type: MIME; value: unknown }
          | {
            op: "patch";
            id: URI;
            type: MIME;
            patches: PatchOp[];
            value: unknown;
          }
          | { op: "delete"; id: URI; type: MIME }
        >;
        preconditions?: readonly CommitPrecondition[];
        sqliteOps?: readonly SqliteOperation[];
      },
      source?: unknown,
      options?: { resolveAt?: "coverage" | "verdict" },
    ): Promise<
      { ok: Record<PropertyKey, never>; error?: undefined } | {
        ok?: undefined;
        error: { name?: string; message?: string };
      }
    >;
    accessForTestingOnly: SpaceReplica["accessForTestingOnly"];
    get(address: {
      id: URI;
      type: MIME;
    }): {
      since?: number;
      is?: FabricValue;
    } | undefined;
    pull(
      entries: Array<[{ id: URI; type: MIME }, undefined]>,
    ): Promise<
      { ok: Record<PropertyKey, never>; error?: undefined } | {
        ok?: undefined;
        error: { name?: string; message?: string };
      }
    >;
  };

  let nextLocalSeq = 1;
  const dispatch = (
    operations: RootOp[],
    source?: unknown,
  ): { localSeq: number; promise: Promise<any> } => {
    const localSeq = nextLocalSeq++;
    // resolveAt verdict: this harness's whole subject is the verdict /
    // parked-application choreography, with catch-up markers delivered
    // only by explicit pushSync. A coverage-resolving promise would wait
    // for a marker the test has not sent yet — a deadlock the test runner
    // abandons silently ("Promise resolution is still pending").
    const promise = replica.commitNative(
      {
        operations: operations.map((operation) =>
          operation.op === "delete"
            ? { op: "delete", id: operation.id, type: DOCUMENT_MIME }
            : {
              op: "set",
              id: operation.id,
              type: DOCUMENT_MIME,
              value: { value: operation.value },
            }
        ),
      },
      source,
      { resolveAt: "verdict" },
    );
    return { localSeq, promise };
  };

  return {
    model,
    transport,
    sessionFactory,
    storageManager,
    provider,
    replica,
    notifications,
    telemetryMarkers,
    dispatch,
    pushSync: (options: PushSyncOptions) => transport.pushSync(options),
    close: async () => {
      await storageManager.close();
      await clock.tick(30);
    },
  };
};

const clone = <T>(value: T): T => structuredClone(value);

const valueFor = (
  label: string,
  extra: Record<string, FabricValue> = {},
): Record<string, FabricValue> => ({ label, ...extra });

const sourceFromReads = (
  reads: Array<{
    id: URI;
    path?: string[];
    seq?: number;
    nonRecursive?: boolean;
  }>,
) => {
  const activities = reads.map((read) => ({
    space,
    id: read.id,
    type: DOCUMENT_MIME,
    path: ["value", ...(read.path ?? [])],
    ...(read.nonRecursive === true ? { nonRecursive: true } : {}),
    meta: read.seq === undefined ? {} : { seq: read.seq },
  }));
  // A stand-in for the transaction whose reads the replica builds from,
  // declared as one here so the callers pass it as the class types it.
  return {
    getReadActivities() {
      return activities;
    },
  } as unknown as IStorageTransaction;
};

const visibleValue = (provider: TestProvider, id: URI) => {
  const value = provider.get(id)?.value;
  return value === undefined ? undefined : clone(value);
};

const changedIdsFor = (
  notifications: StorageNotification[],
  type: StorageNotification["type"],
) =>
  notifications
    .filter((notification) => notification.type === type)
    .map((notification) =>
      "changes" in notification
        ? [...notification.changes].map((change) => change.address.id as URI)
          .sort()
        : []
    );

const currentSeq = (
  harness: Harness,
  id: URI,
) => harness.replica.get({ id, type: DOCUMENT_MIME })?.since ?? 0;

const readOverlapsWrite = (
  read: ConfirmedRead | PendingRead,
  write: TouchedWrite,
) => {
  if (read.id !== write.id) {
    return false;
  }
  return write.paths.some((path) => pathsOverlap(read.path, path));
};

const touchedWritesForOperation = (operation: Operation): TouchedWrite[] => {
  if (operation.op === "sqlite") return []; // no entity writes
  if (operation.op === "release-op-field") return [];
  if (operation.op === "apply-op") {
    return [{
      id: operation.id as URI,
      paths: [["value", ...operation.path]],
    }];
  }
  if (operation.op !== "patch") {
    return [{ id: operation.id as URI, paths: [[]] }];
  }
  const paths = operation.patches.flatMap((patch) => {
    switch (patch.op) {
      case "replace":
      case "splice":
      case "append":
      case "add-unique":
      case "remove-by-value":
      case "increment":
        return [parsePointer(patch.path)];
      case "add":
      case "remove": {
        const path = parsePointer(patch.path);
        return [path, parentPath(path)];
      }
      case "move": {
        const from = parsePointer(patch.from);
        const to = parsePointer(patch.path);
        return [from, to, parentPath(from), parentPath(to)];
      }
    }
  });
  return [{ id: operation.id as URI, paths }];
};

const applyOperation = (
  operation: Operation,
  current: RootValue,
): RootValue => {
  if (operation.op === "sqlite") return current; // not an entity write
  if (operation.op === "delete") {
    return undefined;
  }
  if (operation.op === "set") {
    return clone(
      isEntityDocumentValue(operation.value)
        ? operation.value.value as RootValue
        : operation.value as RootValue,
    );
  }
  if (operation.op !== "patch") {
    throw new Error(
      `local stacked-commit model cannot apply ${operation.op}`,
    );
  }
  const next = applyPatch(
    { value: clone(current) ?? {} },
    operation.patches,
  ) as { value?: RootValue };
  return next.value;
};

const isEntityDocumentValue = (value: unknown): value is { value: RootValue } =>
  isObjectOrArray(value) && "value" in value;

const createLocalModel = (): Map<URI, LocalDocModel> =>
  new Map(
    Object.values(DOCS).map((id) => [id, {
      confirmedSeq: 0,
      confirmed: undefined,
      pending: [],
    }]),
  );

const applyPendingToModel = (
  model: Map<URI, LocalDocModel>,
  localSeq: number,
  operations: RootOp[],
) => {
  for (const operation of operations) {
    const record = model.get(operation.id)!;
    record.pending.push({
      localSeq,
      value: operation.op === "delete" ? undefined : clone(operation.value),
    });
  }
};

const confirmPendingInModel = (
  model: Map<URI, LocalDocModel>,
  localSeq: number,
  seq: number,
  operations: RootOp[],
) => {
  for (const id of new Set(operations.map((operation) => operation.id))) {
    const record = model.get(id)!;
    const pending = [...record.pending].findLast((entry) =>
      entry.localSeq === localSeq
    );
    if (!pending) {
      continue;
    }
    record.confirmedSeq = seq;
    record.confirmed = clone(pending.value);
    record.pending = record.pending.filter((entry) =>
      entry.localSeq !== localSeq
    );
  }
};

const dropPendingInModel = (
  model: Map<URI, LocalDocModel>,
  localSeq: number,
) => {
  for (const record of model.values()) {
    record.pending = record.pending.filter((entry) =>
      entry.localSeq !== localSeq
    );
  }
};

const notificationLog = (notifications: StorageNotification[]) =>
  notifications.map((notification) => ({
    type: notification.type,
    ids: "changes" in notification
      ? [...notification.changes].map((change) => change.address.id as URI)
        .sort()
      : [],
  }));

const topPendingSurface = (
  harness: Harness,
) => {
  const reads = harness.replica.accessForTestingOnly.buildReads(
    sourceFromReads(Object.values(DOCS).map((id) => ({ id }))),
    10_000,
  );
  return new Map(
    // Lower layers in an array localSeq are dependency records; the
    // staleness-bearing surface this helper reports is the top element.
    reads.pending.map((read) => [read.id as URI, localSeqTop(read)]),
  );
};

const expectVisible = (
  harness: Harness,
  expected: Partial<Record<DocKey, RootValue>>,
) => {
  for (
    const [key, value] of Object.entries(expected) as Array<[DocKey, RootValue]>
  ) {
    expect(visibleValue(harness.provider, DOCS[key])).toEqual(value);
  }
};

const hasPendingOverlay = (harness: Harness, id: URI): boolean =>
  (harness.replica as unknown as {
    hasPendingWrite(id: URI): boolean;
  }).hasPendingWrite(id);

/** Awaits `promise` and requires the bare `{ ok: {} }` acceptance. */
const expectResultOk = async (promise: Promise<any>) => {
  expect(await promise).toEqual({ ok: {} });
};

/**
 * Awaits `promise` and requires a `ConflictError` whose message carries
 * `contains`, when given.
 */
const expectConflict = async (
  promise: Promise<any>,
  contains?: string,
) => {
  const result = await promise;
  expect(result.error).toBeDefined();
  expect(result.error.name).toBe("ConflictError");
  if (contains) {
    expect(String(result.error.message)).toContain(contains);
  }
};

// Poll until `predicate` holds (e.g. "commit N reached the wire") so a test
// can gate server verdicts deterministically without racing the client's
// pre-send awaits (session handshake, batch flush).
const waitForCondition = async (
  predicate: () => boolean,
  label: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) {
      return;
    }
    await clock.tick(5);
  }
  throw new Error(`timed out waiting for ${label}`);
};

const beginSet = (
  harness: Harness,
  id: URI,
  value: RootValue,
  source?: unknown,
) => harness.dispatch([{ op: "set", id, value }], source);

const beginBatch = (
  harness: Harness,
  operations: RootOp[],
  source?: unknown,
) => harness.dispatch(operations, source);

const beginPatch = (
  harness: Harness,
  id: URI,
  patches: PatchOp[],
  value: RootValue,
  source?: unknown,
) =>
  harness.replica.commitNative(
    {
      operations: [{
        op: "patch",
        id,
        type: DOCUMENT_MIME,
        patches,
        value: { value },
      }],
    },
    source,
    { resolveAt: "verdict" },
  );

const seedAccepted = async (
  harness: Harness,
  id: URI,
  value: RootValue,
) => {
  const first = beginSet(harness, id, value);
  harness.model.setOutcome(first.localSeq, { kind: "accept" });
  await expectResultOk(first.promise);
};

const runStressSeed = async (seed: number) => {
  const harness = await createHarness();
  const localModel = createLocalModel();
  const results = new Map<number, ResultRecord>();
  const pending = new Map<number, {
    promise: Promise<any>;
    operations: RootOp[];
  }>();
  const random = mulberry32(seed);
  const docIds = Object.values(DOCS);

  try {
    for (let step = 0; step < 30; step += 1) {
      while (pending.size > 2) {
        const oldest = [...pending.keys()].sort((left, right) =>
          left - right
        )[0];
        const entry = pending.get(oldest)!;
        const result = await entry.promise;
        const outcome = harness.model.applied.get(oldest);
        if (result.ok) {
          expect(outcome, `seed=${seed} step=${step} missing applied ${oldest}`)
            .toBeDefined();
          confirmPendingInModel(
            localModel,
            oldest,
            outcome!.applied.seq,
            entry.operations,
          );
          results.set(oldest, { localSeq: oldest, status: "ok" });
        } else {
          dropPendingInModel(localModel, oldest);
          results.set(oldest, {
            localSeq: oldest,
            status: "error",
            message: result.error?.message,
          });
        }
        pending.delete(oldest);
      }

      const target = docIds[randomInt(random, docIds.length)];
      const pair = [
        target,
        docIds.find((id) => id !== target && random() > 0.5) ??
          docIds.find((id) => id !== target)!,
      ] as const;
      const mode = randomInt(random, 3);
      const randomRootOp = (id: URI, label: string): RootOp => {
        const op = random() < 0.2 ? "delete" : "set";
        return op === "delete"
          ? { op, id }
          : { op, id, value: valueFor(label) };
      };
      const operations = mode === 0
        ? [randomRootOp(target, `seed-${seed}-step-${step}-root`)]
        : pair.map((id, index) =>
          randomRootOp(id, `seed-${seed}-step-${step}-doc-${index}`)
        );

      const outstandingDocs = [...pending.values()]
        .flatMap((entry) => entry.operations.map((operation) => operation.id));
      const sameDocPending = outstandingDocs.includes(target);
      const otherDocPending = outstandingDocs.some((id) => id !== target);
      const dependencyMode = randomInt(random, 4);
      const source = dependencyMode === 1
        ? sourceFromReads([{
          id: target,
          seq: localModel.get(target)!.confirmedSeq,
        }])
        : dependencyMode === 2 && sameDocPending
        ? sourceFromReads([{ id: target }])
        : dependencyMode === 3 && otherDocPending
        ? sourceFromReads([{
          id: outstandingDocs.find((id) => id !== target)!,
        }])
        : undefined;

      const outcomeMode = randomInt(random, 3);
      const local = beginBatch(harness, operations, source);
      const remoteDoc = docIds.find((id) =>
        !operations.some((operation) =>
          operation.id === id
        )
      ) ?? DOCS.D;
      const remoteInterleave: RemoteCommit = {
        label: `remote-${seed}-${step}`,
        operations: [{
          op: "set",
          id: remoteDoc,
          value: valueFor(`remote-${seed}-${step}`),
        }],
      };
      harness.model.setOutcome(
        local.localSeq,
        outcomeMode === 0 ? { kind: "accept" } : outcomeMode === 1
          ? {
            kind: "rejectConflict",
            message: `synthetic conflict seed=${seed} step=${step}`,
          }
          : { kind: "accept", remoteInterleave },
      );

      applyPendingToModel(localModel, local.localSeq, operations);
      pending.set(local.localSeq, {
        promise: local.promise,
        operations,
      });
    }

    for (
      const localSeq of [...pending.keys()].sort((left, right) => left - right)
    ) {
      const entry = pending.get(localSeq)!;
      const result = await entry.promise;
      if (result.ok) {
        const outcome = harness.model.applied.get(localSeq);
        expect(outcome, `seed=${seed} missing applied ${localSeq}`)
          .toBeDefined();
        confirmPendingInModel(
          localModel,
          localSeq,
          outcome!.applied.seq,
          entry.operations,
        );
        results.set(localSeq, { localSeq, status: "ok" });
      } else {
        dropPendingInModel(localModel, localSeq);
        results.set(localSeq, {
          localSeq,
          status: "error",
          message: result.error?.message,
        });
      }
      pending.delete(localSeq);
    }

    // A cascade-settled commit's promise resolves before the transport's
    // queued transact callback books the (suppressed) late verdict. Drain
    // those callbacks so the server-side bookkeeping below is final — it also
    // makes the accepted-despite-client-error check meaningful.
    await harness.transport.drainVerdicts();

    expect(topPendingSurface(harness).size, `seed=${seed} final pending`).toBe(
      0,
    );
    for (const [localSeq, result] of results) {
      const applied = harness.model.applied.get(localSeq);
      const rejected = harness.model.rejected.get(localSeq);
      if (result.status === "ok") {
        expect(applied, `seed=${seed} result ${localSeq} expected applied`)
          .toBeDefined();
      } else if (rejected === undefined) {
        // The pending-dependency cascade settles a provably-doomed commit
        // client-side, so a client-errored commit may lack a server rejection
        // row in exactly two shapes: it carries the cascade's fabricated
        // conflict message, or it was rejected at a pre-send checkpoint and
        // never reached the server at all. Anything else — in particular a
        // client error for a sent commit — still demands a rejection row.
        const cascaded = result.message?.includes(
          "pending dependency dropped locally",
        ) === true;
        const sent = harness.model.transactLocalSeqs.includes(localSeq);
        expect(
          cascaded || !sent,
          `seed=${seed} result ${localSeq} expected rejection ` +
            `(message=${result.message})`,
        ).toBe(true);
        // Never acceptable: the server durably ACCEPTED a commit the client
        // settled as a conflict.
        expect(
          applied,
          `seed=${seed} result ${localSeq} settled as a client conflict but ` +
            `the server accepted it`,
        ).toBeUndefined();
      }
    }
    expect(
      notificationLog(harness.notifications.notifications).every((entry) =>
        entry.type === "commit" || entry.type === "revert"
      ),
      `seed=${seed} unexpected notification types`,
    ).toBe(true);
  } finally {
    await harness.close();
  }
};

const mulberry32 = (seed: number) => {
  let current = seed >>> 0;
  return () => {
    current |= 0;
    current = (current + 0x6d2b79f5) | 0;
    let t = Math.imul(current ^ (current >>> 15), 1 | current);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const randomInt = (random: () => number, maxExclusive: number) =>
  Math.floor(random() * maxExclusive);

const markerHarness = () =>
  createHarness({ transport: (model) => new MarkerContractTransport(model) });

describe("memory-v2-stacked-commit", () => {
  describe("outcomes across a stack", () => {
    it("confirms C1, C2, and C3 stacked on one doc, with no revert", async () => {
      const harness = await createHarness();
      try {
        const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
        harness.model.setOutcome(c1.localSeq, { kind: "accept" });
        const c2 = beginSet(harness, DOCS.A, valueFor("c2"));
        harness.model.setOutcome(c2.localSeq, { kind: "accept" });
        const c3 = beginSet(harness, DOCS.A, valueFor("c3"));
        harness.model.setOutcome(c3.localSeq, { kind: "accept" });

        expectVisible(harness, { A: valueFor("c3") });
        await expectResultOk(c1.promise);
        await expectResultOk(c2.promise);
        await expectResultOk(c3.promise);

        expectVisible(harness, { A: valueFor("c3") });
        expect(changedIdsFor(harness.notifications.notifications, "commit"))
          .toEqual([
            [DOCS.A],
            [DOCS.A],
            [DOCS.A],
          ]);
        expect(changedIdsFor(harness.notifications.notifications, "revert"))
          .toEqual([]);
      } finally {
        await harness.close();
      }
    });

    it("preserves earlier patch fields across later stale same-doc patches", async () => {
      const harness = await createHarness();
      try {
        const supportOnly = {
          internal: {
            selectedCategory: "support",
            visibleTemplates: [{ id: "support-shift-schedule" }],
            "__#4": "Support",
          },
        };
        const allVisible = [
          { id: "hero-email-kit" },
          { id: "support-shift-schedule" },
          { id: "product-tour-deck" },
          { id: "ops-kanban" },
          { id: "retro-guide" },
        ];

        await seedAccepted(harness, DOCS.A, supportOnly);

        harness.model.setOutcome(2, { kind: "accept" });
        harness.model.setOutcome(3, { kind: "accept" });
        harness.model.setOutcome(4, { kind: "accept" });

        const replica = harness.replica as unknown as {
          commitNative(
            transaction: {
              operations: Array<
                {
                  op: "patch";
                  id: URI;
                  type: MIME;
                  patches: PatchOp[];
                  value: { value: RootValue };
                }
              >;
            },
          ): Promise<any>;
        };

        const c2 = replica.commitNative({
          operations: [{
            op: "patch",
            id: DOCS.A,
            type: DOCUMENT_MIME,
            patches: [{
              op: "replace",
              path: "/value/internal/selectedCategory",
              value: "all",
            }],
            value: {
              value: {
                internal: {
                  selectedCategory: "all",
                  visibleTemplates: [{ id: "support-shift-schedule" }],
                  "__#4": "Support",
                },
              },
            },
          }],
        });
        const c3 = replica.commitNative({
          operations: [{
            op: "patch",
            id: DOCS.A,
            type: DOCUMENT_MIME,
            patches: [
              {
                op: "replace",
                path: "/value/internal/visibleTemplates/0",
                value: allVisible[0],
              },
              {
                op: "splice",
                path: "/value/internal/visibleTemplates",
                index: 1,
                remove: 0,
                add: allVisible.slice(1),
              },
            ],
            value: {
              value: {
                internal: {
                  selectedCategory: "all",
                  visibleTemplates: allVisible,
                  "__#4": "Support",
                },
              },
            },
          }],
        });
        const c4 = replica.commitNative({
          operations: [{
            op: "patch",
            id: DOCS.A,
            type: DOCUMENT_MIME,
            patches: [{
              op: "replace",
              path: "/value/internal/__#4",
              value: "All",
            }],
            value: {
              value: {
                internal: {
                  selectedCategory: "all",
                  visibleTemplates: [{ id: "support-shift-schedule" }],
                  "__#4": "All",
                },
              },
            },
          }],
        });

        await expectResultOk(c2);
        await expectResultOk(c3);
        await expectResultOk(c4);

        expectVisible(harness, {
          A: {
            internal: {
              selectedCategory: "all",
              visibleTemplates: allVisible,
              "__#4": "All",
            },
          },
        });
      } finally {
        await harness.close();
      }
    });

    it("keeps an independent C3 on the same doc when C2 conflicts", async () => {
      const harness = await createHarness();
      try {
        const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
        harness.model.setOutcome(c1.localSeq, { kind: "accept" });
        const c2 = beginSet(harness, DOCS.A, valueFor("c2"));
        harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
        const c3 = beginSet(harness, DOCS.A, valueFor("c3"));
        harness.model.setOutcome(c3.localSeq, { kind: "accept" });

        expectVisible(harness, { A: valueFor("c3") });
        await expectResultOk(c1.promise);
        await expectConflict(c2.promise);
        expectVisible(harness, { A: valueFor("c3") });
        await expectResultOk(c3.promise);
        expectVisible(harness, { A: valueFor("c3") });
      } finally {
        await harness.close();
      }
    });

    it("keeps an independent C3 on a different doc when C2 conflicts", async () => {
      const harness = await createHarness();
      try {
        const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
        harness.model.setOutcome(c1.localSeq, { kind: "accept" });
        const c2 = beginSet(harness, DOCS.A, valueFor("c2"));
        harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
        const c3 = beginSet(harness, DOCS.B, valueFor("c3"));
        harness.model.setOutcome(c3.localSeq, { kind: "accept" });

        await expectResultOk(c1.promise);
        await expectConflict(c2.promise);
        await expectResultOk(c3.promise);

        expectVisible(harness, { A: valueFor("c1"), B: valueFor("c3") });
      } finally {
        await harness.close();
      }
    });

    it("fails a C3 that depends on a conflicting C2 on the same doc", async () => {
      const harness = await createHarness();
      try {
        const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
        harness.model.setOutcome(c1.localSeq, { kind: "accept" });
        await expectResultOk(c1.promise);

        const c2 = beginSet(
          harness,
          DOCS.A,
          valueFor("c2"),
          sourceFromReads([{ id: DOCS.A, seq: currentSeq(harness, DOCS.A) }]),
        );
        harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
        const c3 = beginSet(
          harness,
          DOCS.A,
          valueFor("c3"),
          sourceFromReads([{ id: DOCS.A }]),
        );
        harness.model.setOutcome(c3.localSeq, { kind: "accept" });

        await expectConflict(c2.promise);
        await expectConflict(c3.promise, "pending dependency");
        expectVisible(harness, { A: valueFor("c1") });
      } finally {
        await harness.close();
      }
    });

    it("fails a C3 that depends on a conflicting C2 on a different doc", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, valueFor("base-a"));
        await seedAccepted(harness, DOCS.B, valueFor("base-b"));

        const c2 = beginSet(harness, DOCS.B, valueFor("c2"));
        harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
        const c3 = beginSet(
          harness,
          DOCS.A,
          valueFor("c3"),
          sourceFromReads([{ id: DOCS.B }]),
        );
        harness.model.setOutcome(c3.localSeq, { kind: "accept" });

        await expectConflict(c2.promise);
        await expectConflict(c3.promise, "pending dependency");
        expectVisible(harness, {
          A: valueFor("base-a"),
          B: valueFor("base-b"),
        });
      } finally {
        await harness.close();
      }
    });

    it("fails a C3 that depends on a C2 whose conflict is on unrelated data in the same atomic commit", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, valueFor("base-a"));
        await seedAccepted(harness, DOCS.B, valueFor("base-b"));

        const c2 = beginBatch(harness, [
          { op: "set", id: DOCS.A, value: valueFor("c2-a") },
          { op: "set", id: DOCS.B, value: valueFor("c2-b") },
        ]);
        harness.model.setOutcome(c2.localSeq, {
          kind: "rejectConflict",
          message: "synthetic conflict on unrelated B write",
        });
        const c3 = beginSet(
          harness,
          DOCS.C,
          valueFor("c3"),
          sourceFromReads([{ id: DOCS.A }]),
        );
        harness.model.setOutcome(c3.localSeq, { kind: "accept" });

        await expectConflict(c2.promise, "unrelated B write");
        await expectConflict(c3.promise, "pending dependency");
        expectVisible(harness, {
          A: valueFor("base-a"),
          B: valueFor("base-b"),
          C: undefined,
        });
      } finally {
        await harness.close();
      }
    });

    it("keeps a C3 that depends only on C1 when C2 conflicts", async () => {
      const harness = await createHarness();
      try {
        const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
        harness.model.setOutcome(c1.localSeq, { kind: "accept" });
        await expectResultOk(c1.promise);

        const c2 = beginSet(harness, DOCS.B, valueFor("c2"));
        harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
        const c3 = beginSet(
          harness,
          DOCS.C,
          valueFor("c3"),
          sourceFromReads([{ id: DOCS.A, seq: currentSeq(harness, DOCS.A) }]),
        );
        harness.model.setOutcome(c3.localSeq, { kind: "accept" });

        await expectConflict(c2.promise);
        await expectResultOk(c3.promise);
        expectVisible(harness, {
          A: valueFor("c1"),
          B: undefined,
          C: valueFor("c3"),
        });
      } finally {
        await harness.close();
      }
    });

    it("keeps a C4 that depends on a surviving C3 while C2 conflicts", async () => {
      const harness = await createHarness();
      try {
        const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
        harness.model.setOutcome(c1.localSeq, { kind: "accept" });
        await expectResultOk(c1.promise);

        const c2 = beginSet(harness, DOCS.B, valueFor("c2"));
        harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
        const c3 = beginSet(harness, DOCS.C, valueFor("c3"));
        harness.model.setOutcome(c3.localSeq, { kind: "accept" });
        const c4 = beginSet(
          harness,
          DOCS.D,
          valueFor("c4"),
          sourceFromReads([{ id: DOCS.C }]),
        );
        harness.model.setOutcome(c4.localSeq, { kind: "accept" });

        await expectConflict(c2.promise);
        await expectResultOk(c3.promise);
        await expectResultOk(c4.promise);
        expectVisible(harness, {
          A: valueFor("c1"),
          C: valueFor("c3"),
          D: valueFor("c4"),
        });
      } finally {
        await harness.close();
      }
    });

    it("fails a C4 that depends on a failed C2 as well as a surviving C3", async () => {
      const harness = await createHarness();
      try {
        const c2 = beginSet(harness, DOCS.B, valueFor("c2"));
        harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
        const c3 = beginSet(harness, DOCS.C, valueFor("c3"));
        harness.model.setOutcome(c3.localSeq, { kind: "accept" });
        const c4 = beginSet(
          harness,
          DOCS.D,
          valueFor("c4"),
          sourceFromReads([{ id: DOCS.B }, { id: DOCS.C }]),
        );
        harness.model.setOutcome(c4.localSeq, { kind: "accept" });

        await expectConflict(c2.promise);
        await expectResultOk(c3.promise);
        await expectConflict(c4.promise, "pending dependency");
        expectVisible(harness, { C: valueFor("c3"), D: undefined });
      } finally {
        await harness.close();
      }
    });

    it("rolls back A along with B when a C2 writing both conflicts on B", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, valueFor("base-a"));
        await seedAccepted(harness, DOCS.B, valueFor("base-b"));
        const c2 = beginBatch(harness, [
          { op: "set", id: DOCS.A, value: valueFor("c2-a") },
          { op: "set", id: DOCS.B, value: valueFor("c2-b") },
        ]);
        harness.model.setOutcome(c2.localSeq, {
          kind: "rejectConflict",
          message: "synthetic conflict on B",
        });
        await expectConflict(c2.promise, "conflict on B");
        expectVisible(harness, {
          A: valueFor("base-a"),
          B: valueFor("base-b"),
        });
      } finally {
        await harness.close();
      }
    });

    it("fails a C3 that depends on a delete whose C2 conflicts", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, valueFor("base"));
        const c2 = beginBatch(harness, [{ op: "delete", id: DOCS.A }]);
        harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
        const c3 = beginSet(
          harness,
          DOCS.B,
          valueFor("c3"),
          sourceFromReads([{ id: DOCS.A }]),
        );
        harness.model.setOutcome(c3.localSeq, { kind: "accept" });

        await expectConflict(c2.promise);
        await expectConflict(c3.promise, "pending dependency");
        expectVisible(harness, { A: valueFor("base"), B: undefined });
      } finally {
        await harness.close();
      }
    });

    it("keeps an independent C3 when a deleting C2 conflicts", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, valueFor("base"));
        const c2 = beginBatch(harness, [{ op: "delete", id: DOCS.A }]);
        harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
        const c3 = beginSet(harness, DOCS.B, valueFor("c3"));
        harness.model.setOutcome(c3.localSeq, { kind: "accept" });

        await expectConflict(c2.promise);
        await expectResultOk(c3.promise);
        expectVisible(harness, { A: valueFor("base"), B: valueFor("c3") });
      } finally {
        await harness.close();
      }
    });
  });

  describe("visible state and notifications after a revert", () => {
    it("shows the newest surviving pending value after a middle revert", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, valueFor("base"));
        const c2 = beginSet(harness, DOCS.A, valueFor("c2"));
        harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
        const c3 = beginSet(harness, DOCS.A, valueFor("c3"));
        harness.model.setOutcome(c3.localSeq, { kind: "accept" });

        expectVisible(harness, { A: valueFor("c3") });
        await expectConflict(c2.promise);
        expectVisible(harness, { A: valueFor("c3") });
        await expectResultOk(c3.promise);
        expectVisible(harness, { A: valueFor("c3") });
      } finally {
        await harness.close();
      }
    });

    it("shows the confirmed value when the failed commit held the top pending value", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, valueFor("base"));
        const c2 = beginSet(harness, DOCS.A, valueFor("c2"));
        harness.model.setOutcome(c2.localSeq, { kind: "accept" });
        const c3 = beginSet(harness, DOCS.A, valueFor("c3"));
        harness.model.setOutcome(c3.localSeq, { kind: "rejectConflict" });

        expectVisible(harness, { A: valueFor("c3") });
        await expectResultOk(c2.promise);
        await expectConflict(c3.promise);
        expectVisible(harness, { A: valueFor("c2") });
      } finally {
        await harness.close();
      }
    });

    it("names only the docs the failed commit touched in its revert notification", async () => {
      const harness = await createHarness();
      try {
        const c1 = beginBatch(harness, [
          { op: "set", id: DOCS.A, value: valueFor("c1-a") },
          { op: "set", id: DOCS.B, value: valueFor("c1-b") },
        ]);
        harness.model.setOutcome(c1.localSeq, { kind: "rejectConflict" });
        const c2 = beginSet(harness, DOCS.C, valueFor("c2"));
        harness.model.setOutcome(c2.localSeq, { kind: "accept" });

        await expectConflict(c1.promise);
        await expectResultOk(c2.promise);
        const reverts = changedIdsFor(
          harness.notifications.notifications,
          "revert",
        );
        expect(reverts).toEqual([[DOCS.A, DOCS.B]]);
      } finally {
        await harness.close();
      }
    });

    it("keeps later surviving pending state when an earlier unrelated commit fails", async () => {
      const harness = await createHarness();
      try {
        const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
        harness.model.setOutcome(c1.localSeq, { kind: "rejectConflict" });
        const c2 = beginSet(harness, DOCS.B, valueFor("c2"));
        harness.model.setOutcome(c2.localSeq, { kind: "accept" });

        await expectConflict(c1.promise);
        expectVisible(harness, { B: valueFor("c2") });
        await expectResultOk(c2.promise);
        expectVisible(harness, { B: valueFor("c2") });
      } finally {
        await harness.close();
      }
    });

    it("keeps same-doc sibling writes with no dependency across a middle failure", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, { left: 0, right: 0 });
        const c2 = beginSet(harness, DOCS.A, { left: 1, right: 0 });
        harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
        const c3 = beginSet(harness, DOCS.A, { left: 0, right: 2 });
        harness.model.setOutcome(c3.localSeq, { kind: "accept" });

        await expectConflict(c2.promise);
        await expectResultOk(c3.promise);
        expectVisible(harness, { A: { left: 0, right: 2 } });
      } finally {
        await harness.close();
      }
    });

    it("fails a later same-doc commit that depends on the failed middle commit even when it writes a different path", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, { left: 0, right: 0 });
        const c2 = beginSet(harness, DOCS.A, { left: 1, right: 0 });
        harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
        const c3 = beginSet(
          harness,
          DOCS.A,
          { left: 1, right: 2 },
          sourceFromReads([{ id: DOCS.A, path: ["left"] }]),
        );
        harness.model.setOutcome(c3.localSeq, { kind: "accept" });

        await expectConflict(c2.promise);
        await expectConflict(c3.promise, "pending dependency");
        expectVisible(harness, { A: { left: 0, right: 0 } });
      } finally {
        await harness.close();
      }
    });
  });

  describe("the wire: duplicates, drops, and replays", () => {
    it("returns the same result for a duplicate `localSeq`, sending it once", async () => {
      const model = new ScriptedServerModel();
      const transport = new ScriptedModelTransport(model);
      const client = await MemoryV2Client.connect({ transport });
      try {
        const session = await client.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        model.setOutcome(1, { kind: "accept" });
        const commit: ClientCommit = {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: DOCS.A,
            value: { value: valueFor("dup") as any } as any,
          }],
        };

        const first = session.transact(commit);
        const second = session.transact(commit);
        expect(await first).toEqual(await second);
        expect(model.transactLocalSeqs).toEqual([1]);
      } finally {
        await client.close();
      }
    });

    it("replays a dropped C1 receipt and flushes the later stacked commits in order", async () => {
      const harness = await createHarness();
      try {
        const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
        harness.model.setOutcome(c1.localSeq, { kind: "dropThenReplayAccept" });
        const c2 = beginSet(harness, DOCS.B, valueFor("c2"));
        harness.model.setOutcome(c2.localSeq, { kind: "accept" });

        await expectResultOk(c1.promise);
        await expectResultOk(c2.promise);
        expect(harness.transport.model.transactLocalSeqs).toEqual([1, 2, 1, 2]);
        expect(harness.transport.model.connectionCount).toBeGreaterThanOrEqual(
          2,
        );
        expectVisible(harness, { A: valueFor("c1"), B: valueFor("c2") });
      } finally {
        await harness.close();
      }
    });

    it("flushes an independent C2 when the replayed C1 conflicts", async () => {
      const harness = await createHarness();
      try {
        const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
        harness.model.setOutcome(c1.localSeq, {
          kind: "dropThenReplayReject",
          message: "replayed conflict",
        });
        const c2 = beginSet(harness, DOCS.B, valueFor("c2"));
        harness.model.setOutcome(c2.localSeq, { kind: "accept" });

        await expectConflict(c1.promise, "replayed conflict");
        await expectResultOk(c2.promise);
        expect(harness.transport.model.transactLocalSeqs).toEqual([1, 2, 1, 2]);
        expectVisible(harness, { A: undefined, B: valueFor("c2") });
      } finally {
        await harness.close();
      }
    });

    it("accepts a retry with a fresh read basis after a revert", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, valueFor("base"));
        const stale = beginSet(
          harness,
          DOCS.A,
          valueFor("stale"),
          sourceFromReads([{ id: DOCS.A, seq: currentSeq(harness, DOCS.A) }]),
        );
        harness.model.setOutcome(stale.localSeq, { kind: "rejectConflict" });
        await expectConflict(stale.promise);

        const retry = beginSet(
          harness,
          DOCS.A,
          valueFor("retry"),
          sourceFromReads([{ id: DOCS.A, seq: currentSeq(harness, DOCS.A) }]),
        );
        harness.model.setOutcome(retry.localSeq, { kind: "accept" });
        await expectResultOk(retry.promise);
        expectVisible(harness, { A: valueFor("retry") });
      } finally {
        await harness.close();
      }
    });
  });

  describe("the pending reads a commit carries", () => {
    it("compacts pending reads over a stack into one read carrying every layer's `localSeq`", async () => {
      const harness = await createHarness();
      try {
        const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
        harness.model.setOutcome(c1.localSeq, { kind: "dropThenReplayAccept" });
        const c2 = beginSet(harness, DOCS.A, valueFor("c2"));
        harness.model.setOutcome(c2.localSeq, { kind: "accept" });

        const reads = harness.replica.accessForTestingOnly.buildReads(
          sourceFromReads([
            { id: DOCS.A },
            { id: DOCS.A, path: ["nested"] },
          ]),
          3,
        );

        expect(reads.confirmed).toEqual([]);
        // One read per path, carrying the FULL dependency array (ascending; the
        // last element is the doc's top-of-stack, the staleness basis) so a
        // dropped lower layer still dooms the commit. Two source reads over
        // the same stack compact to a single entry.
        expect(reads.pending.map((read) => ({
          id: read.id,
          localSeq: read.localSeq,
          path: [...read.path],
        }))).toEqual([
          { id: DOCS.A, localSeq: [1, 2], path: ["value"] },
        ]);
        const siblingReads = harness.replica.accessForTestingOnly.buildReads(
          sourceFromReads(Array.from({ length: 100 }, (_, index) => ({
            id: DOCS.A,
            path: [`field-${index}`],
          }))),
          3,
        );
        expect(siblingReads.pending).toHaveLength(100);
        expect(new Set(siblingReads.pending.map((read) => read.localSeq)).size)
          .toBe(1);
        expect(siblingReads.pending[0].localSeq).toEqual([1, 2]);
        const earlierReads = harness.replica.accessForTestingOnly.buildReads(
          sourceFromReads([{ id: DOCS.A, path: ["field-0"] }]),
          2,
        );
        expect(earlierReads.pending[0].localSeq).toBe(1);
        expect(siblingReads.pending[0].localSeq).toEqual([1, 2]);
        await expectResultOk(c1.promise);
        await expectResultOk(c2.promise);
      } finally {
        await harness.close();
      }
    });

    it("accepts a commit reading through the session's own two-deep stack", async () => {
      const harness = await createHarness();
      try {
        const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
        harness.model.setOutcome(c1.localSeq, { kind: "accept" });
        const c2 = beginSet(harness, DOCS.A, valueFor("c2"));
        harness.model.setOutcome(c2.localSeq, { kind: "accept" });
        // c3's read view sits on the session's OWN stack [c1 set A, c2 set A].
        // The lower layer (c1) must impose resolution only: a staleness basis
        // at c1 would false-conflict with our own c2 (max-basis rule, spec
        // §3.5).
        const c3 = beginSet(
          harness,
          DOCS.A,
          valueFor("c3"),
          sourceFromReads([{ id: DOCS.A }]),
        );
        harness.model.setOutcome(c3.localSeq, { kind: "accept" });

        await expectResultOk(c1.promise);
        await expectResultOk(c2.promise);
        // ACCEPTED — the max-basis rule is what admits it.
        await expectResultOk(c3.promise);
        expectVisible(harness, { A: valueFor("c3") });

        // The wire commit really carried the two-layer dependency array (the
        // scenario that would have false-conflicted under a lower basis).
        const sent = harness.model.applied.get(c3.localSeq);
        expect(sent).toBeDefined();
        expect(sent!.commit.reads.pending.map((read) => read.localSeq)).toEqual(
          [
            [c1.localSeq, c2.localSeq],
          ],
        );
      } finally {
        await harness.close();
      }
    });

    it("carries the doc's confirmed basis on a pending read", async () => {
      const harness = await createHarness();
      try {
        // Confirm a baseline for A so the doc's confirmed basis is non-zero,
        // then stack an optimistic layer and read through it.
        const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
        harness.model.setOutcome(c1.localSeq, { kind: "accept" });
        await expectResultOk(c1.promise);

        const c2 = beginSet(harness, DOCS.A, valueFor("c2"));
        harness.model.setOutcome(c2.localSeq, { kind: "accept" });
        const c3 = beginSet(
          harness,
          DOCS.A,
          valueFor("c3"),
          sourceFromReads([{ id: DOCS.A }]),
        );
        harness.model.setOutcome(c3.localSeq, { kind: "accept" });
        await expectResultOk(c2.promise);
        await expectResultOk(c3.promise);

        // The wire read names its dependency layer AND the confirmed basis the
        // view sat on — the seq c1's acceptance advanced the doc to. The basis
        // travels even with layers present, so a server honoring `basisSeq`
        // anchors its staleness scan there rather than at the dependency's
        // resolution. This double ignores `basisSeq`, so what is pinned here
        // is the wire shape alone.
        const sent = harness.model.applied.get(c3.localSeq);
        expect(sent).toBeDefined();
        const confirmedBasis =
          harness.model.applied.get(c1.localSeq)!.applied.seq;
        expect(sent!.commit.reads.pending.map((read) => ({
          localSeq: read.localSeq,
          basisSeq: read.basisSeq,
        }))).toEqual([{ localSeq: c2.localSeq, basisSeq: confirmedBasis }]);
      } finally {
        await harness.close();
      }
    });

    it("keeps both reads through compaction when their bases diverge", async () => {
      const harness = await createHarness();
      try {
        const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
        harness.model.setOutcome(c1.localSeq, { kind: "accept" });
        await expectResultOk(c1.promise);
        const c2 = beginSet(harness, DOCS.A, valueFor("c2"));
        harness.model.setOutcome(c2.localSeq, { kind: "accept" });

        // Two read activities over the same stacked doc and path: one at the
        // doc's confirmed basis, one pinned lower via meta.seq. Compaction must
        // keep BOTH wire reads — merging them would let the surviving read's
        // higher basis claim the pinned read's interval (0, confirmedBasis],
        // hiding a foreign write there from the server's staleness scan.
        const confirmedBasis =
          harness.model.applied.get(c1.localSeq)!.applied.seq;
        const reads = harness.replica.accessForTestingOnly.buildReads(
          sourceFromReads([
            { id: DOCS.A },
            { id: DOCS.A, seq: 0 },
          ]),
          3,
        );
        expect(reads.confirmed).toEqual([]);
        expect(
          reads.pending
            // `basisSeq` is optional on the wire type; the client always emits
            // it, so absence would itself be a failure — surface it as -1.
            .map((read) => ({
              localSeq: read.localSeq,
              basisSeq: read.basisSeq ?? -1,
            }))
            .toSorted((left, right) => left.basisSeq - right.basisSeq),
        ).toEqual([
          { localSeq: c2.localSeq, basisSeq: 0 },
          { localSeq: c2.localSeq, basisSeq: confirmedBasis },
        ]);
        await expectResultOk(c2.promise);
      } finally {
        await harness.close();
      }
    });
  });

  describe("parked-accept promotion", () => {
    // Verdicts return inline (the fan-out stays batched server-side), and the
    // client parks each accept's state application until a frame's
    // `caughtUpLocalSeq` marker covers it: promotion, pending overlay to
    // confirmed mirror, then runs over a base that reflects the foreign
    // novelty the accept was applied on top of. These tests run on
    // `MarkerContractTransport`, which advertises `verdictCatchUpMarkers`,
    // and push markers explicitly.

    it("keeps an accepted commit pending until its marker, then promotes it and drops the local copy", async () => {
      const harness = await markerHarness();
      try {
        await seedAccepted(harness, DOCS.A, { items: ["a"] });
        // Establish the sync-consumption loop (frames dead-letter without a
        // pull/watch view to feed them into the replica).
        expect(
          await harness.replica.pull([[
            { id: DOCS.A, type: DOCUMENT_MIME },
            undefined,
          ]]),
        ).toEqual({ ok: {} });
        // Settle the parked seed: an empty frame carrying its marker.
        harness.pushSync({ caughtUpLocalSeq: 1 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "seed promotion at its marker",
        );

        harness.model.setOutcome(2, { kind: "accept" });
        const patch = beginPatch(
          harness,
          DOCS.A,
          [{ op: "add", path: "/value/items/-", value: "X" }],
          { items: ["a", "X"] },
        );
        await expectResultOk(patch);

        // The verdict resolved the push, but the STATE application is parked:
        // the overlay is still the pending local copy, and the confirmed
        // mirror does not hold the append yet.
        expect(hasPendingOverlay(harness, DOCS.A)).toBe(true);
        expectVisible(harness, { A: { items: ["a", "X"] } });

        // The marker arrives (own accepted write echo-suppressed, so the frame
        // is otherwise empty). The parked accept promotes: pending moves to
        // confirmed and the pending local copy is removed.
        harness.pushSync({ caughtUpLocalSeq: 2 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "parked promotion at the marker",
        );
        expectVisible(harness, { A: { items: ["a", "X"] } });
      } finally {
        await harness.close();
      }
    });

    it("applies a parked non-idempotent patch once when the covering frame already holds it", async () => {
      const harness = await markerHarness();
      try {
        await seedAccepted(harness, DOCS.A, { items: ["a"] });
        expect(
          await harness.replica.pull([[
            { id: DOCS.A, type: DOCUMENT_MIME },
            undefined,
          ]]),
        ).toEqual({ ok: {} });
        harness.pushSync({ caughtUpLocalSeq: 1 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "seed promotion at its marker",
        );

        // Non-idempotent pending patch (append), accepted and parked.
        harness.model.setOutcome(2, { kind: "accept" });
        const patch = beginPatch(
          harness,
          DOCS.A,
          [{ op: "add", path: "/value/items/-", value: "X" }],
          { items: ["a", "X"] },
        );
        await expectResultOk(patch);
        expect(hasPendingOverlay(harness, DOCS.A)).toBe(true);

        // Mixed provenance delivers the doc AUTHORITATIVELY: the frame's base
        // already CONTAINS the append. The parked application must remove the
        // overlay against that base instead of replaying it — ["a","X","X"]
        // would be a view no server state ever had.
        harness.pushSync({
          upserts: [{ id: DOCS.A, seq: 2, value: { items: ["a", "X"] } }],
          caughtUpLocalSeq: 2,
        });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "parked application at the covered marker",
        );
        expectVisible(harness, { A: { items: ["a", "X"] } });
      } finally {
        await harness.close();
      }
    });

    it("promotes a parked accept at its marker even when the frame covers other docs", async () => {
      const harness = await markerHarness();
      try {
        await seedAccepted(harness, DOCS.A, valueFor("base"));
        expect(
          await harness.replica.pull([
            [{ id: DOCS.A, type: DOCUMENT_MIME }, undefined],
            [{ id: DOCS.B, type: DOCUMENT_MIME }, undefined],
          ]),
        ).toEqual({ ok: {} });
        harness.pushSync({ caughtUpLocalSeq: 1 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "seed promotion at its marker",
        );

        harness.model.setOutcome(2, { kind: "accept" });
        const b = beginSet(harness, DOCS.B, valueFor("optimistic"));
        await expectResultOk(b.promise);
        expect(hasPendingOverlay(harness, DOCS.B)).toBe(true);

        // The frame carries foreign novelty on doc A plus the marker; doc B —
        // the session's own accepted write — is echo-suppressed. Parking is
        // MARKER-keyed, not coverage-keyed: B's parked accept promotes here,
        // extrapolating over its (current) confirmed base.
        harness.pushSync({
          upserts: [{ id: DOCS.A, seq: 3, value: valueFor("foreign") }],
          caughtUpLocalSeq: 2,
        });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.B),
          "parked promotion of the uncovered doc",
        );
        expectVisible(harness, {
          A: valueFor("foreign"),
          B: valueFor("optimistic"),
        });
      } finally {
        await harness.close();
      }
    });

    it("resolves `whenApplied()` at the parked accept's promotion, and immediately when nothing is parked", async () => {
      const harness = await markerHarness();
      try {
        await seedAccepted(harness, DOCS.A, { items: ["a"] });
        expect(
          await harness.replica.pull([[
            { id: DOCS.A, type: DOCUMENT_MIME },
            undefined,
          ]]),
        ).toEqual({ ok: {} });
        harness.pushSync({ caughtUpLocalSeq: 1 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "seed promotion at its marker",
        );
        const replica = harness.provider.replica as unknown as {
          whenApplied(localSeq: number): Promise<void>;
        };
        // An accept long applied (the seed): resolves immediately.
        let seedApplied = false;
        await replica.whenApplied(1).then(() => {
          seedApplied = true;
        });
        expect(seedApplied).toBe(true);

        // An accepted-and-PARKED commit: the barrier is held open.
        harness.model.setOutcome(2, { kind: "accept" });
        const patch = beginPatch(
          harness,
          DOCS.A,
          [{ op: "add", path: "/value/items/-", value: "X" }],
          { items: ["a", "X"] },
        );
        await expectResultOk(patch);
        expect(hasPendingOverlay(harness, DOCS.A)).toBe(true);
        let applied = false;
        const barrier = replica.whenApplied(2).then(() => {
          applied = true;
        });
        // Give resolution every chance short of the marker: the barrier
        // must still be held (this is what keeps a served effect's
        // in-flight entry deduping re-admits across the absorption window).
        await clock.tick(20);
        expect(applied).toBe(false);

        // The marker arrives: the parked accept promotes and the barrier
        // resolves.
        harness.pushSync({ caughtUpLocalSeq: 2 });
        await barrier;
        expect(applied).toBe(true);
        expect(hasPendingOverlay(harness, DOCS.A)).toBe(false);
      } finally {
        await harness.close();
      }
    });
  });

  describe("the settle input barrier", () => {
    // A foreign frame integrating under a parked own write is shadowed: the
    // materialized view (and therefore the change notification) reflects the
    // own overlay, not the foreign value, until the marker promotes the parked
    // accept. `unappliedForeignSeqFloor()` reports the shadowed seqs so the
    // serving loop's W advance can exclude them, and, with the server-execution
    // flag on, the shadow flip fires the moment the foreign value becomes
    // visible, whether that is the parked accept promoting or the shadowing
    // write being dropped.

    const shadowFloorOf = (harness: Harness): number | undefined =>
      (harness.provider.replica as unknown as {
        unappliedForeignSeqFloor(): number | undefined;
      }).unappliedForeignSeqFloor();

    /**
     * Installs the serving loop's wake hook the way the `SpaceServer` does at
     * activation (`ISpaceReplica.shadowFlipObserver`), returning a live fire
     * counter.
     */
    const installShadowFlipObserver = (harness: Harness): { fires: number } => {
      const counter = { fires: 0 };
      (harness.provider.replica as unknown as {
        shadowFlipObserver?: () => void;
      }).shadowFlipObserver = () => {
        counter.fires += 1;
      };
      return counter;
    };

    it("reports a foreign frame shadowed by a parked own write in `unappliedForeignSeqFloor()` and notifies at the shadow flip with the flag on", async () => {
      setServerExecutionConfig(true);
      const harness = await markerHarness();
      const wake = installShadowFlipObserver(harness);
      try {
        await seedAccepted(harness, DOCS.A, valueFor("base"));
        expect(
          await harness.replica.pull([[
            { id: DOCS.A, type: DOCUMENT_MIME },
            undefined,
          ]]),
        ).toEqual({ ok: {} });
        harness.pushSync({ caughtUpLocalSeq: 1 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "seed promotion at its marker",
        );
        expect(shadowFloorOf(harness)).toBeUndefined();

        // An accepted-and-PARKED own whole-doc write: the overlay fully
        // masks the doc.
        harness.model.setOutcome(2, { kind: "accept" });
        const own = beginSet(harness, DOCS.A, valueFor("own"));
        await expectResultOk(own.promise);
        expect(hasPendingOverlay(harness, DOCS.A)).toBe(true);
        expectVisible(harness, { A: valueFor("own") });

        // The OWN ECHO first (a mixed-provenance frame): an upsert
        // whose seq IS the parked accept's ack seq is the durable copy of
        // the own write, not foreign novelty — it must NOT set the floor
        // (shadowing it would clamp W on every wave of a quiet serving
        // loop).
        harness.pushSync({
          upserts: [{ id: DOCS.A, seq: 2, value: valueFor("own") }],
        });
        await clock.tick(10);
        expect(shadowFloorOf(harness)).toBeUndefined();

        // A SAME-SEQ re-upsert (a watch-refresh replay; the F1a sealed-echo
        // shape on a serving loop) carries no novelty either: confirmed
        // does not move forward, so no shadow may be recorded even with a
        // pending write standing.
        harness.pushSync({
          upserts: [{ id: DOCS.A, seq: 2, value: valueFor("own") }],
        });
        await clock.tick(10);
        expect(shadowFloorOf(harness)).toBeUndefined();

        // And a seq-0 absent-doc marker (the initial pull's "no confirmed
        // version") never shadows.
        harness.pushSync({
          upserts: [{ id: DOCS.B, seq: 0, value: valueFor("absent") }],
        });
        await clock.tick(10);
        expect(shadowFloorOf(harness)).toBeUndefined();

        // Foreign novelty arrives WITHOUT a covering marker: it integrates
        // into the confirmed mirror but stays invisible under the pending
        // SET — the differential is empty, so nothing notified and no
        // dirtiness registered. The floor reports its seq.
        const before = harness.notifications.notifications.length;
        harness.pushSync({
          upserts: [{ id: DOCS.A, seq: 3, value: valueFor("foreign") }],
        });
        await clock.tick(10);
        expect(shadowFloorOf(harness)).toBe(3);
        expectVisible(harness, { A: valueFor("own") });
        expect(
          harness.notifications.notifications.length,
          "the shadowed integration must not notify (nothing became visible)",
        ).toEqual(before);

        // No wake before the flip: the shadowed integration and the
        // non-novelty frames above must not poke the serving loop.
        expect(wake.fires).toBe(0);

        // The marker arrives: the parked accept promotes, confirmed had
        // advanced PAST the accept, so the own overlay is removed and the
        // FOREIGN value becomes visible — the shadow flip. Flag ON, the
        // replica fires the ordinary change notification for exactly this
        // doc, the floor lifts, and the serving loop's wake fires (the
        // clamp must lift promptly, not on the idle timeout).
        harness.pushSync({ caughtUpLocalSeq: 2 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "parked promotion at the marker",
        );
        expectVisible(harness, { A: valueFor("foreign") });
        expect(shadowFloorOf(harness)).toBeUndefined();
        const flips = harness.notifications.notifications.slice(before)
          .filter((notification) =>
            notification.type === "integrate" && "changes" in notification &&
            [...notification.changes].some((change) =>
              change.address.id === DOCS.A
            )
          );
        expect(
          flips.length,
          "the shadow flip must fire a change notification for the doc",
        ).toBeGreaterThanOrEqual(1);
        expect(
          wake.fires,
          "the shadow flip must fire the serving loop's wake observer",
        ).toBeGreaterThanOrEqual(1);
      } finally {
        await harness.close();
        resetServerExecutionConfig();
      }
    });

    it("keeps the shadow flip silent with the flag off, while the floor still reports and clears", async () => {
      // EXPLICIT OFF (review thread r3739139549): relying on the default
      // being false (and the preceding ON test's finally) would silently
      // flip this into an ON-arm test the day the rollout defaults the
      // flag on — while still claiming to validate OFF.
      setServerExecutionConfig(false);
      const harness = await markerHarness();
      const wake = installShadowFlipObserver(harness);
      try {
        await seedAccepted(harness, DOCS.A, valueFor("base"));
        expect(
          await harness.replica.pull([[
            { id: DOCS.A, type: DOCUMENT_MIME },
            undefined,
          ]]),
        ).toEqual({ ok: {} });
        harness.pushSync({ caughtUpLocalSeq: 1 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "seed promotion at its marker",
        );

        harness.model.setOutcome(2, { kind: "accept" });
        const own = beginSet(harness, DOCS.A, valueFor("own"));
        await expectResultOk(own.promise);
        harness.pushSync({
          upserts: [{ id: DOCS.A, seq: 3, value: valueFor("foreign") }],
        });
        await clock.tick(10);
        expect(shadowFloorOf(harness)).toBe(3);

        const before = harness.notifications.notifications.length;
        harness.pushSync({ caughtUpLocalSeq: 2 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "parked promotion at the marker",
        );
        // Same silent flip as before this change: the foreign value is
        // visible, the floor clears, and NO notification fired (the OFF arm
        // keeps today's behavior byte-for-byte; the serving loop is the
        // only consumer of the floor). The wake observer stays silent too —
        // it rides the flag-ON checkout.
        expectVisible(harness, { A: valueFor("foreign") });
        expect(shadowFloorOf(harness)).toBeUndefined();
        expect(harness.notifications.notifications.length).toEqual(before);
        expect(wake.fires).toBe(0);
      } finally {
        await harness.close();
        resetServerExecutionConfig();
      }
    });

    it("lifts the shadow mis-recorded for an own echo that outran its verdict once the verdict lands, before any marker", async () => {
      const harness = await markerHarness();
      try {
        await seedAccepted(harness, DOCS.A, valueFor("base"));
        expect(
          await harness.replica.pull([[
            { id: DOCS.A, type: DOCUMENT_MIME },
            undefined,
          ]]),
        ).toEqual({ ok: {} });
        harness.pushSync({ caughtUpLocalSeq: 1 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "seed promotion at its marker",
        );

        // Hold the VERDICT: the accept books only when the gate releases,
        // so the wire order below — frame first, verdict second — is
        // deterministic.
        const gate = Promise.withResolvers<void>();
        let received = false;
        harness.model.setOutcome(2, {
          kind: "accept",
          responseGate: gate.promise,
          onReceipt: () => {
            received = true;
          },
        });
        const own = beginSet(harness, DOCS.A, valueFor("own"));
        await waitForCondition(() => received, "the commit to reach the wire");

        // The OWN ECHO outruns the verdict (same socket, the race the
        // repair exists for): localSeq 2's ack seq does not exist yet, so
        // the own-echo exemption cannot recognize the upsert and it is
        // MIS-RECORDED as shadowed foreign novelty. This assertion is the
        // vacuity guard — the race genuinely happened.
        harness.pushSync({
          upserts: [{ id: DOCS.A, seq: 2, value: valueFor("own") }],
        });
        await waitForCondition(
          () => shadowFloorOf(harness) === 2,
          "the mis-recorded shadow (the race's setup)",
        );

        // The verdict lands: settleAccept records the ack AND repairs the
        // mis-record — a shadow whose seq IS this accept's seq on a doc
        // this accept wrote can only be the own echo (no foreign commit
        // shares the seq). Without the repair the floor stays 2 while the
        // accept parks below, and a quiet serving loop would clamp W
        // forever against its own echo (nothing else prunes the entry
        // while the doc keeps pending writes).
        gate.resolve();
        await expectResultOk(own.promise);
        expect(
          shadowFloorOf(harness),
          "the verdict-race repair must lift the own-echo shadow",
        ).toBeUndefined();
        // Still PARKED (no covering marker yet): the repair acted at
        // VERDICT time, inside the wedge window — not as a side effect of
        // promotion emptying the pending set.
        expect(hasPendingOverlay(harness, DOCS.A)).toBe(true);

        // Promote for a clean close; the floor stays lifted.
        harness.pushSync({ caughtUpLocalSeq: 2 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "parked promotion at the marker",
        );
        expectVisible(harness, { A: valueFor("own") });
        expect(shadowFloorOf(harness)).toBeUndefined();
      } finally {
        await harness.close();
      }
    });

    it("records the sentinel floor 1 for a remove shadowed by a parked own write, and clears it at promotion", async () => {
      const harness = await markerHarness();
      try {
        await seedAccepted(harness, DOCS.A, valueFor("base"));
        expect(
          await harness.replica.pull([[
            { id: DOCS.A, type: DOCUMENT_MIME },
            undefined,
          ]]),
        ).toEqual({ ok: {} });
        harness.pushSync({ caughtUpLocalSeq: 1 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "seed promotion at its marker",
        );

        // An accepted-and-PARKED own write stands over the doc.
        harness.model.setOutcome(2, { kind: "accept" });
        const own = beginSet(harness, DOCS.A, valueFor("own"));
        await expectResultOk(own.promise);
        expect(hasPendingOverlay(harness, DOCS.A)).toBe(true);

        // A wire REMOVE integrates under it. The wire carries NO seq for
        // removes, so the shadow records the sentinel 1 — the floor that
        // holds W entirely until the shadow clears (the field's documented
        // rare arm; serving-loop.md §7's clamp counts it like any other
        // floor).
        harness.pushSync({ removes: [{ id: DOCS.A }] });
        await waitForCondition(
          () => shadowFloorOf(harness) === 1,
          "the shadowed remove's sentinel floor",
        );
        expectVisible(harness, { A: valueFor("own") });

        // Promotion clears it: the parked accept applies over the removed
        // base (the own write IS the doc's content again) and the floor
        // prunes with the emptied pending set.
        harness.pushSync({ caughtUpLocalSeq: 2 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "parked promotion at the marker",
        );
        expect(shadowFloorOf(harness)).toBeUndefined();
        expectVisible(harness, { A: valueFor("own") });
      } finally {
        await harness.close();
      }
    });

    it("holds the shadow floor at the earliest hidden seq across a later foreign update, and keeps a remove sentinel under one", async () => {
      const harness = await markerHarness();
      try {
        await seedAccepted(harness, DOCS.A, valueFor("base"));
        expect(
          await harness.replica.pull([[
            { id: DOCS.A, type: DOCUMENT_MIME },
            undefined,
          ]]),
        ).toEqual({ ok: {} });
        harness.pushSync({ caughtUpLocalSeq: 1 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "seed promotion at its marker",
        );

        // An accepted-and-PARKED own write masks the doc.
        harness.model.setOutcome(2, { kind: "accept" });
        const own = beginSet(harness, DOCS.A, valueFor("own"));
        await expectResultOk(own.promise);

        // TWO foreign updates integrate under it: seq 3 then seq 5. Every
        // derivation of the next wave read the view from BEFORE seq 3, so
        // the floor must stay 3 — a per-doc max would record 5 and let W
        // advance to 4, a derivedThrough claim over an input nothing
        // derived over.
        harness.pushSync({
          upserts: [{ id: DOCS.A, seq: 3, value: valueFor("foreign-3") }],
        });
        harness.pushSync({
          upserts: [{ id: DOCS.A, seq: 5, value: valueFor("foreign-5") }],
        });
        await clock.tick(10);
        expect(
          shadowFloorOf(harness),
          "the floor must hold at the earliest hidden seq",
        ).toBe(3);

        // Promote; the floor clears whole.
        harness.pushSync({ caughtUpLocalSeq: 2 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "parked promotion at the marker",
        );
        expect(shadowFloorOf(harness)).toBeUndefined();

        // The sentinel half: a shadowed REMOVE (sentinel 1) followed by a
        // foreign upsert. A max would bury the sentinel under the upsert's
        // seq; the floor must stay 1 until the shadow clears.
        harness.model.setOutcome(3, { kind: "accept" });
        const own2 = beginSet(harness, DOCS.A, valueFor("own-2"));
        await expectResultOk(own2.promise);
        harness.pushSync({ removes: [{ id: DOCS.A }] });
        await waitForCondition(
          () => shadowFloorOf(harness) === 1,
          "the shadowed remove's sentinel floor",
        );
        harness.pushSync({
          upserts: [{ id: DOCS.A, seq: 8, value: valueFor("foreign-8") }],
        });
        await clock.tick(10);
        expect(
          shadowFloorOf(harness),
          "a later foreign upsert must not bury the remove sentinel",
        ).toBe(1);
        harness.pushSync({ caughtUpLocalSeq: 3 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "second parked promotion at the marker",
        );
        expect(shadowFloorOf(harness)).toBeUndefined();
      } finally {
        await harness.close();
      }
    });

    it("lifts exactly the own echo's seq at the verdict repair, keeping a genuine foreign shadow recorded beside it", async () => {
      const harness = await markerHarness();
      try {
        await seedAccepted(harness, DOCS.A, valueFor("base"));
        expect(
          await harness.replica.pull([[
            { id: DOCS.A, type: DOCUMENT_MIME },
            undefined,
          ]]),
        ).toEqual({ ok: {} });
        harness.pushSync({ caughtUpLocalSeq: 1 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "seed promotion at its marker",
        );

        // Hold the verdict so the echo deterministically outruns it (the
        // own-echo race test's setup), then land GENUINE foreign novelty
        // beside the mis-record before the verdict resolves.
        const gate = Promise.withResolvers<void>();
        let received = false;
        harness.model.setOutcome(2, {
          kind: "accept",
          responseGate: gate.promise,
          onReceipt: () => {
            received = true;
          },
        });
        const own = beginSet(harness, DOCS.A, valueFor("own"));
        await waitForCondition(() => received, "the commit to reach the wire");
        // The mis-recorded own echo (seq 2) …
        harness.pushSync({
          upserts: [{ id: DOCS.A, seq: 2, value: valueFor("own") }],
        });
        await waitForCondition(
          () => shadowFloorOf(harness) === 2,
          "the mis-recorded shadow (the race's setup)",
        );
        // … and genuine foreign novelty (seq 3) on the same doc, still
        // under the pending own write.
        harness.pushSync({
          upserts: [{ id: DOCS.A, seq: 3, value: valueFor("foreign") }],
        });
        await clock.tick(10);
        expect(shadowFloorOf(harness)).toBe(2);

        // The verdict lands: the repair removes EXACTLY seq 2. A scalar
        // record folded 2 and 3 into one number and the repair either
        // deleted both (losing the genuine shadow — W passes hidden
        // foreign input) or neither (clamping forever on the echo).
        gate.resolve();
        await expectResultOk(own.promise);
        expect(
          shadowFloorOf(harness),
          "the genuine foreign shadow must survive the own-echo repair",
        ).toBe(3);

        harness.pushSync({ caughtUpLocalSeq: 2 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "parked promotion at the marker",
        );
        expect(shadowFloorOf(harness)).toBeUndefined();
        expectVisible(harness, { A: valueFor("foreign") });
      } finally {
        await harness.close();
      }
    });

    it("fires the shadow-flip wake when a rejected own write that shadowed foreign novelty drops, with the flag on", async () => {
      setServerExecutionConfig(true);
      const harness = await markerHarness();
      const wake = installShadowFlipObserver(harness);
      try {
        await seedAccepted(harness, DOCS.A, valueFor("base"));
        expect(
          await harness.replica.pull([[
            { id: DOCS.A, type: DOCUMENT_MIME },
            undefined,
          ]]),
        ).toEqual({ ok: {} });
        harness.pushSync({ caughtUpLocalSeq: 1 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "seed promotion at its marker",
        );

        // A foreign winner lands server-side (seq 2); the doomed own write
        // reads the stale basis and is REJECTED.
        harness.model.injectRemote({
          label: "winner",
          operations: [{ op: "set", id: DOCS.A, value: valueFor("winner") }],
        });
        const winnerSeq = harness.model.confirmed.get(DOCS.A)!.seq;
        harness.model.setOutcome(2, {
          kind: "rejectConflict",
          retryAfterSeq: winnerSeq,
        });
        const doomed = beginSet(
          harness,
          DOCS.A,
          valueFor("mine"),
          sourceFromReads([{ id: DOCS.A }]),
        );
        await waitForCondition(
          () => harness.model.transactLocalSeqs.includes(2),
          "doomed commit to reach the wire",
        );

        // The winner's fan-out arrives UNDER the still-pending own write:
        // shadowed foreign novelty, floor = winnerSeq. (No ack exists for
        // the doomed write, so the own-echo exemption does not apply.)
        harness.pushSync({
          upserts: [{ id: DOCS.A, seq: winnerSeq, value: valueFor("winner") }],
          caughtUpLocalSeq: doomed.localSeq,
        });
        const result = await doomed.promise;
        expect(result.error).toMatchObject({ name: "ConflictError" });

        // The drop emptied the shadowed doc's pending set: the foreign
        // value is visible, the floor lifts — and the WAKE fired. A
        // rejection-driven lift wakes the serving loop just as confirmPending
        // does; otherwise the clamped loop would sleep until the input-wait
        // timeout.
        expectVisible(harness, { A: valueFor("winner") });
        expect(shadowFloorOf(harness)).toBeUndefined();
        expect(
          wake.fires,
          "the rejection-driven shadow lift must fire the serving loop's wake",
        ).toBeGreaterThanOrEqual(1);
      } finally {
        await harness.close();
        resetServerExecutionConfig();
      }
    });
  });

  describe("the verdict, and when a parked accept applies", () => {
    // A parked accept waits for its covering marker. These pin the verdict
    // round trip and the occasions that apply a parked accept without one.

    it("completes a rejection round trip: verdict, repair frame, and a regeneration against the repaired base", async () => {
      const harness = await markerHarness();
      try {
        await seedAccepted(harness, DOCS.A, valueFor("v1"));
        expect(
          await harness.replica.pull([[
            { id: DOCS.A, type: DOCUMENT_MIME },
            undefined,
          ]]),
        ).toEqual({ ok: {} });
        harness.pushSync({ caughtUpLocalSeq: 1 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "seed promotion at its marker",
        );

        // A foreign winner lands server-side; its fan-out is not delivered.
        harness.model.injectRemote({
          label: "winner",
          operations: [{ op: "set", id: DOCS.A, value: valueFor("v2winner") }],
        });
        const winnerSeq = harness.model.confirmed.get(DOCS.A)!.seq;
        expect(winnerSeq).toBe(2);

        // The doomed optimistic commit: reads A at the stale confirmed basis,
        // writes A. The rejection returns inline; the read-repair gate holds
        // the drop until the repair frame's marker.
        harness.model.setOutcome(2, {
          kind: "rejectConflict",
          retryAfterSeq: winnerSeq,
        });
        const doomed = beginSet(
          harness,
          DOCS.A,
          valueFor("v1mine"),
          sourceFromReads([{ id: DOCS.A }]),
        );
        await waitForCondition(
          () => harness.model.transactLocalSeqs.includes(2),
          "doomed commit to reach the wire",
        );
        expectVisible(harness, { A: valueFor("v1mine") });

        // Repair frame: the winner plus the marker covering the rejected
        // localSeq. The gate releases, the phantom drops against the repaired
        // base, and the push resolves with the rejection.
        harness.pushSync({
          upserts: [{
            id: DOCS.A,
            seq: winnerSeq,
            value: valueFor("v2winner"),
          }],
          caughtUpLocalSeq: doomed.localSeq,
        });
        const result = await doomed.promise;
        expect(result.error).toBeDefined();
        expectVisible(harness, { A: valueFor("v2winner") });
        const readyToRetry = (result.error as {
          readyToRetry?: () => Promise<void>;
        }).readyToRetry;
        expect(readyToRetry).toBeDefined();
        // Event-driven: the marker already satisfied the gate, so this resolves
        // without any further delivery (a hang fails the test's own timeout).
        await readyToRetry!();

        // The regeneration: rebuild against the repaired confirmed base. The
        // fresh commit gets a fresh localSeq and — because the mirror already
        // holds the winner — an honest new basis, so it is built on the right
        // premise on its first attempt.
        harness.model.setOutcome(3, { kind: "accept" });
        const regenerated = beginSet(
          harness,
          DOCS.A,
          valueFor("v3merged"),
          sourceFromReads([{ id: DOCS.A }]),
        );
        expect(regenerated.localSeq).toBe(3);
        await expectResultOk(regenerated.promise);
        expectVisible(harness, { A: valueFor("v3merged") });

        // The regenerated wire read declared the WINNER's basis, and its
        // dependency stack does not name the dropped layer: the view stopped
        // depending on it, so the array stopped naming it.
        const sent = harness.model.applied.get(3);
        expect(sent).toBeDefined();
        expect(sent!.commit.reads.confirmed.map((read) => ({
          id: read.id,
          seq: read.seq,
        }))).toEqual([{ id: DOCS.A, seq: winnerSeq }]);
        expect(sent!.commit.reads.pending).toEqual([]);
      } finally {
        await harness.close();
      }
    });

    it("keeps an undecided dependent above the marker across the parked application", async () => {
      const harness = await markerHarness();
      const gate3 = Promise.withResolvers<void>();
      try {
        await seedAccepted(harness, DOCS.A, { items: ["a"] });
        expect(
          await harness.replica.pull([[
            { id: DOCS.A, type: DOCUMENT_MIME },
            undefined,
          ]]),
        ).toEqual({ ok: {} });
        harness.pushSync({ caughtUpLocalSeq: 1 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "seed promotion at its marker",
        );

        // Two stacked appends: L2 ("X") accepted; L3 ("Y") verdict held.
        harness.model.setOutcome(2, { kind: "accept" });
        const l2 = beginPatch(
          harness,
          DOCS.A,
          [{ op: "add", path: "/value/items/-", value: "X" }],
          { items: ["a", "X"] },
        );
        harness.model.setOutcome(3, {
          kind: "accept",
          responseGate: gate3.promise,
        });
        const l3 = beginPatch(
          harness,
          DOCS.A,
          [{ op: "add", path: "/value/items/-", value: "Y" }],
          { items: ["a", "X", "Y"] },
        );
        await expectResultOk(l2);

        // The frame reflects L2's outcome only (marker 2); the `foreign` field
        // distinguishes the delivered base from the local one. L2's parked
        // application lands against it; the UNDECIDED L3 survives and replays
        // on top: without the parked removal the view would double-apply X
        // (["a","X","X","Y"]); without survivor replay it would lose Y.
        harness.pushSync({
          upserts: [{
            id: DOCS.A,
            seq: 2,
            value: { items: ["a", "X"], foreign: true },
          }],
          caughtUpLocalSeq: 2,
        });
        await waitForCondition(
          () => {
            const value = visibleValue(harness.provider, DOCS.A) as {
              foreign?: boolean;
            };
            return value?.foreign === true;
          },
          "frame to integrate",
        );
        expectVisible(harness, {
          A: { items: ["a", "X", "Y"], foreign: true },
        });

        // A stale redelivery of the same marker changes nothing: L2 is already
        // applied, L3 sits above the marker.
        harness.pushSync({
          upserts: [{
            id: DOCS.A,
            seq: 2,
            value: { items: ["a", "X"], foreign: true },
          }],
          caughtUpLocalSeq: 2,
        });
        expectVisible(harness, {
          A: { items: ["a", "X", "Y"], foreign: true },
        });

        // L3's verdict arrives and parks; its own marker promotes it on an
        // otherwise-empty frame.
        gate3.resolve();
        await expectResultOk(l3);
        expect(hasPendingOverlay(harness, DOCS.A)).toBe(true);
        harness.pushSync({ caughtUpLocalSeq: 3 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "L3 promotion at its marker",
        );
        expectVisible(harness, {
          A: { items: ["a", "X", "Y"], foreign: true },
        });
      } finally {
        gate3.resolve();
        await harness.close();
      }
    });

    it("applies parked accepts at session replacement", async () => {
      const harness = await markerHarness();
      try {
        await seedAccepted(harness, DOCS.A, valueFor("base"));
        expect(
          await harness.replica.pull([[
            { id: DOCS.A, type: DOCUMENT_MIME },
            undefined,
          ]]),
        ).toEqual({ ok: {} });
        harness.pushSync({ caughtUpLocalSeq: 1 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "seed promotion at its marker",
        );

        // A NON-idempotent parked accept: the risk under replacement is
        // precisely a still-standing append layer double-applying over the
        // authoritative reinstall base.
        await seedAccepted(harness, DOCS.B, { items: ["a"] });
        harness.pushSync({ caughtUpLocalSeq: 2 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.B),
          "B seed promotion at its marker",
        );
        harness.model.setOutcome(3, { kind: "accept" });
        const patch = beginPatch(
          harness,
          DOCS.B,
          [{ op: "add", path: "/value/items/-", value: "X" }],
          { items: ["a", "X"] },
        );
        await expectResultOk(patch);
        expect(hasPendingOverlay(harness, DOCS.B)).toBe(true);

        // A restore against the scripted server comes back NON-resumed: the
        // session is replaced and the marker epoch resets. The old session's
        // staged obligations are gone — no marker for the parked accept can
        // ever arrive — so replacement must apply it immediately, consuming
        // the pending overlay.
        await harness.sessionFactory.session!.restore();
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.B),
          "parked application at session replacement",
        );
        expectVisible(harness, { B: { items: ["a", "X"] } });

        // The authoritative reinstall sync then delivers the server's document
        // — which already CONTAINS the append. With the overlay consumed at
        // replacement, the append lands exactly once; a surviving overlay
        // would replay it over the delivered base (["a","X","X"]).
        expect(
          await harness.replica.pull([[
            { id: DOCS.B, type: DOCUMENT_MIME },
            undefined,
          ]]),
        ).toEqual({ ok: {} });
        harness.pushSync({
          upserts: [{ id: DOCS.B, seq: 3, value: { items: ["a", "X"] } }],
        });
        await waitForCondition(
          () => {
            const value = visibleValue(harness.provider, DOCS.B) as {
              items?: string[];
            };
            return Array.isArray(value?.items);
          },
          "reinstall frame to integrate",
        );
        expectVisible(harness, { B: { items: ["a", "X"] } });
      } finally {
        await harness.close();
      }
    });

    it("applies parked accepts immediately when the sync consumer is lost", async () => {
      const harness = await markerHarness();
      try {
        await seedAccepted(harness, DOCS.A, valueFor("base"));
        expect(
          await harness.replica.pull([[
            { id: DOCS.A, type: DOCUMENT_MIME },
            undefined,
          ]]),
        ).toEqual({ ok: {} });
        harness.pushSync({ caughtUpLocalSeq: 1 });
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.A),
          "seed promotion at its marker",
        );

        harness.model.setOutcome(2, { kind: "accept" });
        const b = beginSet(harness, DOCS.B, valueFor("optimistic"));
        await expectResultOk(b.promise);
        expect(hasPendingOverlay(harness, DOCS.B)).toBe(true);

        // The server revokes the session: the watch view closes and the marker
        // channel dies with it — no marker can ever arrive for the parked
        // accept. Teardown must apply it immediately (the legacy verdict-time
        // semantics), never strand it waiting on frames that cannot come.
        harness.transport.emitRevoked();
        await waitForCondition(
          () => !hasPendingOverlay(harness, DOCS.B),
          "parked application at consumer teardown",
        );
        expectVisible(harness, { B: valueFor("optimistic") });
      } finally {
        await harness.close();
      }
    });

    it("applies a verdict immediately against a server without `verdictCatchUpMarkers`", async () => {
      // The DEFAULT harness transport models exactly this old server, so the
      // legacy path is what every other fixture in this file exercises; this
      // test pins it explicitly: no parking, promotion at the verdict.

      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, valueFor("base"));
        expect(hasPendingOverlay(harness, DOCS.A)).toBe(false);
        expectVisible(harness, { A: valueFor("base") });
      } finally {
        await harness.close();
      }
    });
  });

  describe("an older server", () => {
    // A peer advertising fewer capabilities than the current one, and the holds
    // the client takes on its behalf.

    /**
     * An older server: advertises every current capability except the array
     * dependency sets.
     */
    class PreStackTransport extends ScriptedModelTransport {
      protected override helloFlags() {
        return { ...super.helloFlags(), pendingReadStacks: false };
      }
    }

    it("sends scalar top-of-stack reads to a server without `pendingReadStacks`", async () => {
      const harness = await createHarness({
        transport: (model) => new PreStackTransport(model),
      });
      try {
        const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
        harness.model.setOutcome(c1.localSeq, { kind: "accept" });
        const c2 = beginSet(harness, DOCS.A, valueFor("c2"));
        harness.model.setOutcome(c2.localSeq, { kind: "accept" });
        const c3 = beginSet(
          harness,
          DOCS.A,
          valueFor("c3"),
          sourceFromReads([{ id: DOCS.A }]),
        );
        harness.model.setOutcome(c3.localSeq, { kind: "accept" });

        await expectResultOk(c1.promise);
        await expectResultOk(c2.promise);
        await expectResultOk(c3.promise);

        // The wire commit was scalarized to the top-of-stack element — the
        // pre-stack shape an old server can resolve. The lower-layer dependency
        // (c1) is NOT on the wire (the 1c check is knowingly absent against
        // such servers); the client-side cascade still recorded it locally.
        const sent = harness.model.applied.get(c3.localSeq);
        expect(sent).toBeDefined();
        expect(sent!.commit.reads.pending.map((read) => read.localSeq)).toEqual(
          [
            c2.localSeq,
          ],
        );
      } finally {
        await harness.close();
      }
    });

    it("holds a commit whose omitted dependency is unsettled, and dooms it before it is ever sent when that dependency drops", async () => {
      const harness = await createHarness({
        transport: (model) => new PreStackTransport(model),
      });
      const g1 = Promise.withResolvers<void>();
      try {
        // The split-brain shape: lower layer rejects, blind top layer accepts,
        // and a server seeing the dependant would accept it (its scalar wire
        // read names only the accepted top). The hold must
        // keep the dependant off the wire until c1 settles, so the server never
        // gets the chance to accept what the client cascade-rejects.
        const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
        harness.model.setOutcome(c1.localSeq, {
          kind: "rejectConflict",
          message: "c1 loses",
          responseGate: g1.promise,
        });
        const c2 = beginSet(harness, DOCS.A, valueFor("c2"));
        harness.model.setOutcome(c2.localSeq, { kind: "accept" });
        const c3 = beginSet(
          harness,
          DOCS.D,
          valueFor("c3-d"),
          sourceFromReads([{ id: DOCS.A }]),
        );
        harness.model.setOutcome(c3.localSeq, {
          kind: "accept",
          skipReadValidation: true,
        });

        // The blind top layer settles while c1's verdict is still gated…
        await expectResultOk(c2.promise);
        // …and c3 must be HELD off the wire (its omitted dependency c1 is
        // unsettled). A send would surface within microtasks of the hold being
        // wrongly absent.
        for (let turn = 0; turn < 32; turn += 1) {
          await Promise.resolve();
        }
        expect(harness.model.transactLocalSeqs.includes(c3.localSeq)).toBe(
          false,
        );

        // c1 drops: the cascade dooms c3 at the pre-send checkpoint. Nothing
        // ever reaches the server, so a durable accept of a client-rejected
        // commit — the split-brain — is structurally impossible.
        g1.resolve();
        await expectConflict(c1.promise, "c1 loses");
        await expectConflict(
          c3.promise,
          `pending dependency dropped locally: localSeq=${c1.localSeq}`,
        );
        expect(harness.model.transactLocalSeqs.includes(c3.localSeq)).toBe(
          false,
        );
        expect(harness.model.applied.has(c3.localSeq)).toBe(false);
      } finally {
        g1.resolve();
        await harness.close();
      }
    });

    it("releases the hold once every omitted dependency is accepted", async () => {
      const harness = await createHarness({
        transport: (model) => new PreStackTransport(model),
      });
      const g1 = Promise.withResolvers<void>();
      try {
        const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
        harness.model.setOutcome(c1.localSeq, {
          kind: "accept",
          responseGate: g1.promise,
        });
        const c2 = beginSet(harness, DOCS.A, valueFor("c2"));
        harness.model.setOutcome(c2.localSeq, { kind: "accept" });
        const c3 = beginSet(
          harness,
          DOCS.D,
          valueFor("c3-d"),
          sourceFromReads([{ id: DOCS.A }]),
        );
        harness.model.setOutcome(c3.localSeq, {
          kind: "accept",
          skipReadValidation: true,
        });

        await expectResultOk(c2.promise);
        for (let turn = 0; turn < 32; turn += 1) {
          await Promise.resolve();
        }
        expect(harness.model.transactLocalSeqs.includes(c3.localSeq)).toBe(
          false,
        );

        // c1 accepts: every omitted dependency is durable, the scalar shape is
        // sound, and the held send proceeds.
        g1.resolve();
        await expectResultOk(c1.promise);
        await expectResultOk(c3.promise);
        const sent = harness.model.applied.get(c3.localSeq);
        expect(sent).toBeDefined();
        expect(sent!.commit.reads.pending.map((read) => read.localSeq)).toEqual(
          [
            c2.localSeq,
          ],
        );
      } finally {
        g1.resolve();
        await harness.close();
      }
    });
  });

  describe("cascading a local rejection", () => {
    // A doomed in-flight dependant is rejected locally rather than waiting for
    // a server verdict, whether its dependency was dropped or the replica
    // holding it was reset. These pin how far the cascade reaches, what each
    // victim reports, and what a late verdict may no longer change.

    it("rejects an in-flight dependant locally when its dependency drops, before its server verdict", async () => {
      const harness = await createHarness();
      const g1 = Promise.withResolvers<void>();
      const g2 = Promise.withResolvers<void>();
      try {
        const t1 = beginBatch(harness, [
          { op: "set", id: DOCS.A, value: valueFor("t1-a") },
          { op: "set", id: DOCS.B, value: valueFor("t1-b") },
        ]);
        harness.model.setOutcome(t1.localSeq, {
          kind: "rejectConflict",
          message: "synthetic conflict on T1",
          responseGate: g1.promise,
        });
        const t2 = beginSet(
          harness,
          DOCS.D,
          valueFor("t2-d"),
          sourceFromReads([{ id: DOCS.A }]),
        );
        harness.model.setOutcome(t2.localSeq, {
          kind: "accept",
          responseGate: g2.promise,
        });

        expectVisible(harness, {
          A: valueFor("t1-a"),
          B: valueFor("t1-b"),
          D: valueFor("t2-d"),
        });
        // Let both commits reach the wire; T2's verdict stays gated so only the
        // client-side cascade can settle it.
        await waitForCondition(
          () => harness.model.transactLocalSeqs.includes(t2.localSeq),
          "t2 to reach the wire",
        );

        g1.resolve();
        await expectConflict(t1.promise, "synthetic conflict on T1");
        // T2 settles from T1's drop alone — its own verdict is still gated.
        await expectConflict(
          t2.promise,
          `pending dependency dropped locally: localSeq=${t1.localSeq}`,
        );
        // Settled client-side: T2 WAS sent, but the server never judged it.
        expect(harness.model.transactLocalSeqs).toContain(t2.localSeq);
        expect(harness.model.rejected.has(t2.localSeq)).toBe(false);
        expect(harness.model.applied.has(t2.localSeq)).toBe(false);
        // T2's optimistic write is reverted along with T1's.
        expectVisible(harness, { A: undefined, B: undefined, D: undefined });

        // Late verdict: consumed off the books, state stays put. Releasing the
        // gate lets the model judge t2 — whose read of dropped t1 now fails
        // validation, so the late verdict is a REJECT and its swallow is the
        // "cascade-late-reject" count moving.
        const lateRejectBaseline = getLoggerCountsBreakdown()["storage.v2"]
          ?.["cascade-late-reject"]?.debug ?? 0;
        g2.resolve();
        await harness.transport.drainVerdicts();
        await waitForCondition(
          () =>
            (getLoggerCountsBreakdown()["storage.v2"]?.["cascade-late-reject"]
              ?.debug ?? 0) > lateRejectBaseline,
          "the late server verdict to be swallowed",
        );
        expectVisible(harness, { A: undefined, B: undefined, D: undefined });
        expect(harness.model.applied.has(t2.localSeq)).toBe(false);
      } finally {
        g1.resolve();
        g2.resolve();
        await harness.close();
      }
    });

    it("cascades a dependency drop transitively through chained pending reads", async () => {
      const harness = await createHarness();
      const g1 = Promise.withResolvers<void>();
      const g2 = Promise.withResolvers<void>();
      const g3 = Promise.withResolvers<void>();
      try {
        const t1 = beginBatch(harness, [
          { op: "set", id: DOCS.A, value: valueFor("t1-a") },
          { op: "set", id: DOCS.B, value: valueFor("t1-b") },
        ]);
        harness.model.setOutcome(t1.localSeq, {
          kind: "rejectConflict",
          responseGate: g1.promise,
        });
        const t2 = beginSet(
          harness,
          DOCS.D,
          valueFor("t2-d"),
          sourceFromReads([{ id: DOCS.A }]),
        );
        harness.model.setOutcome(t2.localSeq, {
          kind: "accept",
          responseGate: g2.promise,
        });
        // T3 reads D's pending state, which only exists via T2.
        const t3 = beginSet(
          harness,
          DOCS.C,
          valueFor("t3-c"),
          sourceFromReads([{ id: DOCS.D }]),
        );
        harness.model.setOutcome(t3.localSeq, {
          kind: "accept",
          responseGate: g3.promise,
        });

        await waitForCondition(
          () => harness.model.transactLocalSeqs.includes(t3.localSeq),
          "t3 to reach the wire",
        );

        // One gate release topples the whole chain: T1's drop dooms T2, T2's
        // drop dooms T3 — each victim's message names ITS dropped dependency.
        g1.resolve();
        await expectConflict(t1.promise);
        await expectConflict(
          t2.promise,
          `pending dependency dropped locally: localSeq=${t1.localSeq}`,
        );
        await expectConflict(
          t3.promise,
          `pending dependency dropped locally: localSeq=${t2.localSeq}`,
        );
        expectVisible(harness, {
          A: undefined,
          B: undefined,
          C: undefined,
          D: undefined,
        });
      } finally {
        g1.resolve();
        g2.resolve();
        g3.resolve();
        await harness.close();
      }
    });

    it("leaves a zero-read patch in flight when an earlier batch drops", async () => {
      const harness = await createHarness();
      const g1 = Promise.withResolvers<void>();
      const g3 = Promise.withResolvers<void>();
      try {
        await seedAccepted(harness, DOCS.A, { count: 0 });

        const t1 = beginBatch(harness, [
          { op: "set", id: DOCS.A, value: { count: 1 } },
          { op: "set", id: DOCS.B, value: valueFor("t1-b") },
        ]);
        harness.model.setOutcome(t1.localSeq, {
          kind: "rejectConflict",
          responseGate: g1.promise,
        });
        // beginPatch goes straight to the replica, bypassing the harness
        // dispatch counter: on the wire it is localSeq 3 (seed=1, t1=2).
        const patchLocalSeq = 3;
        harness.model.setOutcome(patchLocalSeq, {
          kind: "accept",
          responseGate: g3.promise,
        });
        let patchSettled = false;
        const patch = beginPatch(
          harness,
          DOCS.A,
          [{ op: "replace", path: "/value/count", value: 5 }],
          { count: 5 },
        ).finally(() => {
          patchSettled = true;
        });

        expectVisible(harness, { A: { count: 5 } });
        await waitForCondition(
          () => harness.model.transactLocalSeqs.includes(patchLocalSeq),
          "patch to reach the wire",
        );

        g1.resolve();
        await expectConflict(t1.promise);
        // The patch carried no pending reads, so it never entered the cascade
        // scan set: still in flight after T1's drop, its optimistic write
        // re-derived on top of confirmed state.
        expect(patchSettled).toBe(false);
        expectVisible(harness, { A: { count: 5 }, B: undefined });

        g3.resolve();
        await expectResultOk(patch);
        expect(harness.model.applied.has(patchLocalSeq)).toBe(true);
        expectVisible(harness, { A: { count: 5 } });
      } finally {
        g1.resolve();
        g3.resolve();
        await harness.close();
      }
    });

    it("emits one revert per cascaded victim, each with its own doc ids", async () => {
      const harness = await createHarness();
      const g1 = Promise.withResolvers<void>();
      const g2 = Promise.withResolvers<void>();
      const g3 = Promise.withResolvers<void>();
      try {
        const t1 = beginBatch(harness, [
          { op: "set", id: DOCS.A, value: valueFor("t1-a") },
          { op: "set", id: DOCS.B, value: valueFor("t1-b") },
        ]);
        harness.model.setOutcome(t1.localSeq, {
          kind: "rejectConflict",
          responseGate: g1.promise,
        });
        const t2 = beginSet(
          harness,
          DOCS.D,
          valueFor("t2-d"),
          sourceFromReads([{ id: DOCS.A }]),
        );
        harness.model.setOutcome(t2.localSeq, {
          kind: "accept",
          responseGate: g2.promise,
        });
        const t3 = beginSet(
          harness,
          DOCS.C,
          valueFor("t3-c"),
          sourceFromReads([{ id: DOCS.D }]),
        );
        harness.model.setOutcome(t3.localSeq, {
          kind: "accept",
          responseGate: g3.promise,
        });

        await waitForCondition(
          () => harness.model.transactLocalSeqs.includes(t3.localSeq),
          "t3 to reach the wire",
        );
        g1.resolve();
        await expectConflict(t1.promise);
        await expectConflict(t2.promise, "pending dependency dropped locally");
        await expectConflict(t3.promise, "pending dependency dropped locally");

        // One revert per victim, each scoped to the docs THAT commit touched —
        // the primary first, then each cascaded victim in dependency order.
        expect(changedIdsFor(harness.notifications.notifications, "revert"))
          .toEqual([
            [DOCS.A, DOCS.B],
            [DOCS.D],
            [DOCS.C],
          ]);
      } finally {
        g1.resolve();
        g2.resolve();
        g3.resolve();
        await harness.close();
      }
    });

    it("swallows a late server reject after a cascade without a second revert", async () => {
      const harness = await createHarness();
      const g1 = Promise.withResolvers<void>();
      const g2 = Promise.withResolvers<void>();
      // Debug level so the lazy log closures on the cascade/suppression paths
      // actually format their messages (they are counted either way).
      const storageLogger = getLogger("storage.v2");
      const previousLevel = storageLogger.level;
      storageLogger.level = "debug";
      try {
        const t1 = beginSet(harness, DOCS.A, valueFor("t1"));
        harness.model.setOutcome(t1.localSeq, {
          kind: "rejectConflict",
          responseGate: g1.promise,
        });
        const t2 = beginSet(
          harness,
          DOCS.D,
          valueFor("t2-d"),
          sourceFromReads([{ id: DOCS.A }]),
        );
        harness.model.setOutcome(t2.localSeq, {
          kind: "rejectConflict",
          message: "late server verdict for t2",
          responseGate: g2.promise,
        });

        await waitForCondition(
          () => harness.model.transactLocalSeqs.includes(t2.localSeq),
          "t2 to reach the wire",
        );
        g1.resolve();
        await expectConflict(t1.promise);
        // The cascade won: the client's result carries the fabricated message,
        // not the scripted server one.
        await expectConflict(
          t2.promise,
          `pending dependency dropped locally: localSeq=${t1.localSeq}`,
        );
        expect(changedIdsFor(harness.notifications.notifications, "revert"))
          .toEqual([[DOCS.A], [DOCS.D]]);

        // The late server reject lands, is swallowed, and changes nothing: no
        // second settle is possible and no second revert may be emitted. The
        // swallow itself is observable: "cascade-late-reject" is counted in
        // suppressLateVerdict's rejection handler, so once the count moves the
        // late verdict has demonstrably been consumed off the books.
        const lateRejectBaseline = getLoggerCountsBreakdown()["storage.v2"]
          ?.["cascade-late-reject"]?.debug ?? 0;
        g2.resolve();
        await harness.transport.drainVerdicts();
        await waitForCondition(
          () =>
            (getLoggerCountsBreakdown()["storage.v2"]?.["cascade-late-reject"]
              ?.debug ?? 0) > lateRejectBaseline,
          "the late server reject to be swallowed",
        );
        expect(harness.model.rejected.has(t2.localSeq)).toBe(true);
        expect(changedIdsFor(harness.notifications.notifications, "revert"))
          .toEqual([[DOCS.A], [DOCS.D]]);
        expectVisible(harness, { A: undefined, D: undefined });
      } finally {
        storageLogger.level = previousLevel;
        g1.resolve();
        g2.resolve();
        await harness.close();
      }
    });

    it("leaves the write unpromoted on a late accept after a cascade", async () => {
      const harness = await createHarness();
      const g1 = Promise.withResolvers<void>();
      const g2 = Promise.withResolvers<void>();
      // Warn stays visible at the default level; drop to debug anyway so every
      // lazy closure on this path formats (coverage of the message builders).
      const storageLogger = getLogger("storage.v2");
      const previousLevel = storageLogger.level;
      storageLogger.level = "debug";
      try {
        const t1 = beginSet(harness, DOCS.A, valueFor("t1"));
        harness.model.setOutcome(t1.localSeq, {
          kind: "rejectConflict",
          responseGate: g1.promise,
        });
        const t2 = beginSet(
          harness,
          DOCS.D,
          valueFor("t2-d"),
          sourceFromReads([{ id: DOCS.A }]),
        );
        // skipReadValidation forces the verdict the real server can never
        // produce (accepting a commit whose pending dependency has no commit
        // row) to pin the suppression path's failure mode.
        harness.model.setOutcome(t2.localSeq, {
          kind: "accept",
          skipReadValidation: true,
          responseGate: g2.promise,
        });

        await waitForCondition(
          () => harness.model.transactLocalSeqs.includes(t2.localSeq),
          "t2 to reach the wire",
        );
        g1.resolve();
        await expectConflict(t1.promise);
        await expectConflict(
          t2.promise,
          `pending dependency dropped locally: localSeq=${t1.localSeq}`,
        );
        expectVisible(harness, { A: undefined, D: undefined });
        expect(currentSeq(harness, DOCS.D)).toBe(0);
        const notificationsAtSettle = notificationLog(
          harness.notifications.notifications,
        );

        // The server durably accepts the doomed commit — the client warns
        // ("cascade-late-accept") and must NOT promote the already-dropped
        // write to confirmed: the promise settled as a conflict long ago. The
        // warn count moving is the event that the late verdict has been
        // consumed.
        const lateAcceptBaseline = getLoggerCountsBreakdown()["storage.v2"]
          ?.["cascade-late-accept"]?.warn ?? 0;
        g2.resolve();
        await harness.transport.drainVerdicts();
        await waitForCondition(
          () =>
            (getLoggerCountsBreakdown()["storage.v2"]?.["cascade-late-accept"]
              ?.warn ?? 0) > lateAcceptBaseline,
          "the late server accept to be suppressed",
        );
        expect(harness.model.applied.has(t2.localSeq)).toBe(true);
        expectVisible(harness, { A: undefined, D: undefined });
        expect(currentSeq(harness, DOCS.D)).toBe(0);
        expect(notificationLog(harness.notifications.notifications)).toEqual(
          notificationsAtSettle,
        );
      } finally {
        storageLogger.level = previousLevel;
        g1.resolve();
        g2.resolve();
        await harness.close();
      }
    });

    it("rejects in-flight dependents locally exactly once on replica reset", async () => {
      const harness = await createHarness();
      const g1 = Promise.withResolvers<void>();
      const g2 = Promise.withResolvers<void>();
      const storageLogger = getLogger("storage.v2");
      const previousLevel = storageLogger.level;
      storageLogger.level = "debug";
      try {
        const t1 = beginSet(harness, DOCS.A, valueFor("t1"));
        harness.model.setOutcome(t1.localSeq, {
          kind: "accept",
          responseGate: g1.promise,
        });
        const t2 = beginSet(
          harness,
          DOCS.D,
          valueFor("t2-d"),
          sourceFromReads([{ id: DOCS.A }]),
        );
        harness.model.setOutcome(t2.localSeq, {
          kind: "rejectConflict",
          message: "late server verdict for t2",
          responseGate: g2.promise,
        });
        await waitForCondition(
          () => harness.model.transactLocalSeqs.includes(t2.localSeq),
          "t2 to reach the wire",
        );

        // reset() sweeps the in-flight registry: t2 (pending read on t1's doc)
        // is locally rejected; t1 (no pending reads, never registered) is not.
        // A second sweep in the same tick must be a no-op — the entry already
        // carries its local rejection (the rejectInFlightCommitLocally guard).
        const resettable = harness.replica as unknown as { reset(): void };
        resettable.reset();
        resettable.reset();
        await expectConflict(t2.promise, "memory replica reset");

        // t1 was never locally rejected: its verdict resolves normally even
        // though the replica was wiped underneath it.
        g1.resolve();
        await expectResultOk(t1.promise);

        // t2's late server verdict is consumed off the books, exactly once.
        const lateRejectBaseline = getLoggerCountsBreakdown()["storage.v2"]
          ?.["cascade-late-reject"]?.debug ?? 0;
        g2.resolve();
        await harness.transport.drainVerdicts();
        await waitForCondition(
          () =>
            (getLoggerCountsBreakdown()["storage.v2"]?.["cascade-late-reject"]
              ?.debug ?? 0) > lateRejectBaseline,
          "the late server verdict to be swallowed after reset",
        );
        expect(harness.model.rejected.has(t2.localSeq)).toBe(true);
      } finally {
        storageLogger.level = previousLevel;
        g1.resolve();
        g2.resolve();
        await harness.close();
      }
    });
  });

  describe("read repair, and commits minted against it", () => {
    // A rejection whose repair has not yet landed, and what happens to a commit
    // that reads the base while the repair is in flight.

    it("rejects a floored commit at admission without sending it, in preempt mode", async () => {
      setConflictAdmissionMode("preempt");
      const harness = await createHarness();
      const storageLogger = getLogger("storage.v2");
      const previousLevel = storageLogger.level;
      storageLogger.level = "debug";
      try {
        const replica = harness.replica.accessForTestingOnly;
        replica.recordStaleFloor({
          localSeq: 50,
          reads: {
            confirmed: [{ id: DOCS.A, path: toDocumentPath([]), seq: 0 }],
            pending: [],
          },
          operations: [],
        }, 50);
        const t = beginSet(
          harness,
          DOCS.D,
          valueFor("t"),
          sourceFromReads([{ id: DOCS.A }]),
        );
        // The preempt rejection carries readyToRetry(threshold), so the repair
        // gate holds the revert until the catch-up seq is observed.
        replica.noteCaughtUpLocalSeq(50);
        await expectConflict(t.promise, "preempted");
        expect(harness.model.transactLocalSeqs.includes(t.localSeq)).toBe(
          false,
        );
      } finally {
        storageLogger.level = previousLevel;
        setConflictAdmissionMode(undefined);
        await harness.close();
      }
    });

    it("holds the revert of a conflict rejection delivered before the winning update until the read repair lands", async () => {
      const harness = await createHarness();
      try {
        // Both sides at seq 1: A = v1.
        await seedAccepted(harness, DOCS.A, valueFor("v1"));

        // Subscribe the runner to server pushes. The real runner always holds a
        // watch over the docs it reads; without an active watch a pushed sync
        // frame has no subscriber and the read-repair gate could never release.
        expect(
          await harness.replica.pull([[
            { id: DOCS.A, type: DOCUMENT_MIME },
            undefined,
          ]]),
        ).toEqual({ ok: {} });

        // Client 2's write wins server-side (server seq 2). The harness never
        // pushes sync on its own, so client 1 has not seen it yet.
        harness.model.injectRemote({
          label: "client-2-wins",
          operations: [{ op: "set", id: DOCS.A, value: valueFor("v2winner") }],
        });
        const winnerSeq = harness.model.confirmed.get(DOCS.A)!.seq;
        expect(winnerSeq).toBe(2);

        const conflictBaseline = getLoggerCountsBreakdown()["storage.v2"]
          ?.["commit-conflict"]?.debug ?? 0;

        // Client 1 commits against its stale confirmed read (seq 1). The
        // scripted retryAfterSeq makes the rejection retryable — exactly what
        // engages finalizeRejection's waitForConflictReadRepair gate. The
        // verdict is NOT gated: it is delivered immediately, BEFORE the
        // catch-up carrying the winning value (the real server's fan-out is
        // timer-batched, so rejection-first is the systematic wire order).
        const mine = beginSet(
          harness,
          DOCS.A,
          valueFor("v1mine"),
          sourceFromReads([{ id: DOCS.A, seq: 1 }]),
        );
        harness.model.setOutcome(mine.localSeq, {
          kind: "rejectConflict",
          retryAfterSeq: winnerSeq,
        });
        let settled = false;
        const commitResult = mine.promise.then((result) => {
          settled = true;
          return result;
        });

        // THE WINDOW: "commit-conflict" is counted synchronously in
        // pushCommit's catch, right before finalizeRejection — so once the
        // count moves, the rejection has demonstrably reached the runner while
        // the winning update is still in flight. Give the held state a real
        // chance to (wrongly) settle before asserting it did not.
        await waitForCondition(
          () =>
            (getLoggerCountsBreakdown()["storage.v2"]?.["commit-conflict"]
              ?.debug ?? 0) > conflictBaseline,
          "the conflict rejection to reach the runner",
        );
        // If the gate were broken, the wrongful settle would arrive within
        // microtasks of the catch (finalizeRejection past a non-waiting gate is
        // pure promise flow — the only timer on this path is the 30s repair
        // timeout). Drain the transport, then give the microtask queue ample
        // turns; no wall-clock wait can make the non-event more certain.
        await harness.transport.drainVerdicts();
        for (let turn = 0; turn < 32; turn += 1) {
          await Promise.resolve();
        }

        // Rejection processed-but-held: the commit promise must not settle, the
        // optimistic value stays visible, and no revert is emitted before the
        // read repair lands.
        expect(settled).toBe(false);
        expectVisible(harness, { A: valueFor("v1mine") });
        expect(changedIdsFor(harness.notifications.notifications, "revert"))
          .toEqual([]);

        // Release: the subscription catch-up carrying client 2's winning value
        // plus the caught-up marker covering the rejected commit's localSeq.
        harness.pushSync({
          upserts: [{
            id: DOCS.A,
            seq: winnerSeq,
            value: valueFor("v2winner"),
          }],
          caughtUpLocalSeq: mine.localSeq,
        });

        const result = await commitResult;
        expect(result.error).toBeDefined();
        expect(result.error.name).toBe("ConflictError");
        expect(String(result.error.message)).toContain("stale confirmed read");

        // §3.12 semantics: the repair was applied into confirmed BEFORE the
        // revert snapshot completed — visible state lands on the winner, not on
        // the reverted optimistic value and not on the stale v1.
        expectVisible(harness, { A: valueFor("v2winner") });
        expect(currentSeq(harness, DOCS.A)).toEqual(winnerSeq);

        // Exactly one revert, scoped to A, whose changes read v1mine ->
        // v2winner.
        const reverts = harness.notifications.notifications.filter(
          (notification) => notification.type === "revert",
        );
        expect(reverts.length).toBe(1);
        const changes = [
          ...(reverts[0] as unknown as {
            changes: Iterable<{
              address: { id: URI };
              before?: { value?: RootValue };
              after?: { value?: RootValue };
            }>;
          }).changes,
        ];
        expect(changes.map((change) => change.address.id)).toEqual([DOCS.A]);
        expect(changes[0].before?.value).toEqual(valueFor("v1mine"));
        expect(changes[0].after?.value).toEqual(valueFor("v2winner"));

        // The surfaced rejection's retry gate is already satisfied:
        // readyToRetry resolves immediately now that the catch-up has been
        // applied.
        const readyToRetry = (result.error as {
          readyToRetry?: () => Promise<void>;
        }).readyToRetry;
        expect(readyToRetry).toBeDefined();
        await readyToRetry!();
      } finally {
        await harness.close();
      }
    });

    it("holds a commit minted during the read repair rather than sending it against the rejected layer", async () => {
      const harness = await createHarness();
      // Debug level so the refusal's own lazy log closure runs: the count is
      // how the checkpoint is observed in production, alongside its push span.
      const storageLogger = getLogger("storage.v2");
      const previousLevel = storageLogger.level;
      storageLogger.level = "debug";
      const deadDependencyBaseline = getLoggerCountsBreakdown()["storage.v2"]
        ?.["commit-dead-dependency"]?.debug ?? 0;
      try {
        // Both sides at seq 1: A = v1, and the runner watches A so a pushed
        // repair frame has a subscriber.
        await seedAccepted(harness, DOCS.A, valueFor("v1"));
        expect(
          await harness.replica.pull([[
            { id: DOCS.A, type: DOCUMENT_MIME },
            undefined,
          ]]),
        ).toEqual({ ok: {} });

        // A foreign winner lands server-side; its fan-out is not delivered.
        harness.model.injectRemote({
          label: "winner",
          operations: [{ op: "set", id: DOCS.A, value: valueFor("v2winner") }],
        });
        const winnerSeq = harness.model.confirmed.get(DOCS.A)!.seq;

        // A document sink over A, so the rejection's revert has to reach sink
        // subscribers as well as the notification stream.
        const sinkValues: (RootValue | undefined)[] = [];
        const cancelSink = harness.provider.sink(DOCS.A, (document) => {
          sinkValues.push(document?.value as RootValue | undefined);
        });

        // The loser: reads A at the stale confirmed basis, writes A, and is
        // rejected with a retryable conflict. Its verdict arrives at once, but
        // finalizeRejection holds the drop until the repair frame's marker — so
        // its optimistic layer stands on A for the whole window below.
        const conflictBaseline = getLoggerCountsBreakdown()["storage.v2"]
          ?.["commit-conflict"]?.debug ?? 0;
        const loser = beginSet(
          harness,
          DOCS.A,
          valueFor("v1mine"),
          sourceFromReads([{ id: DOCS.A, seq: 1 }]),
        );
        harness.model.setOutcome(loser.localSeq, {
          kind: "rejectConflict",
          retryAfterSeq: winnerSeq,
        });
        // "commit-conflict" is counted synchronously in pushCommit's catch, so
        // once the count moves the verdict has reached the runner and the
        // repair wait is the only thing keeping the layer alive.
        await waitForCondition(
          () =>
            (getLoggerCountsBreakdown()["storage.v2"]?.["commit-conflict"]
              ?.debug ?? 0) > conflictBaseline,
          "the conflict rejection to reach the runner",
        );

        // Inside the window a fresh commit reads A. Its read view sits on the
        // loser's layer, so buildReads names that layer — a layer the server
        // can only answer with "pending dependency not resolved".
        const follower = beginSet(
          harness,
          DOCS.D,
          valueFor("follower"),
          sourceFromReads([{ id: DOCS.A }]),
        );
        let followerSettled = false;
        const followerResult = follower.promise.then((result) => {
          followerSettled = true;
          return result;
        });
        expect(
          harness.replica.accessForTestingOnly.buildReads(
            sourceFromReads([{ id: DOCS.A }]),
            follower.localSeq + 1,
          ).pending.map((read) => read.localSeq),
        ).toEqual([loser.localSeq]);

        // Drain every queued verdict and let reactive work reach a fixpoint: if
        // the send were going to happen it would have happened by here. Nothing
        // beyond the seed and the loser ever reached the wire.
        await harness.transport.drainVerdicts();
        await clock.settle();
        expect(harness.model.transactLocalSeqs).toEqual([1, loser.localSeq]);
        // …and the follower is held rather than spun: its rejection waits for
        // the loser's drop, so a retry cannot start against the same dead layer.
        expect(followerSettled).toBe(false);

        // Release: the catch-up carrying the winner plus the marker covering
        // the rejected commit. The loser drops, and the follower settles behind
        // it.
        harness.pushSync({
          upserts: [{
            id: DOCS.A,
            seq: winnerSeq,
            value: valueFor("v2winner"),
          }],
          caughtUpLocalSeq: loser.localSeq,
        });
        await expectConflict(loser.promise, "stale confirmed read");
        await expectConflict(
          followerResult,
          `pending dependency rejected: localSeq=${loser.localSeq}`,
        );

        // The follower never reached the server, and both optimistic layers are
        // gone: A holds the winner, D is back to nothing.
        expect(harness.model.transactLocalSeqs.includes(follower.localSeq))
          .toBe(false);
        expect(harness.model.applied.has(follower.localSeq)).toBe(false);
        expectVisible(harness, { A: valueFor("v2winner"), D: undefined });

        // The revert reached the sink, and left it on the repaired value rather
        // than on the optimistic one the loser wrote.
        cancelSink();
        expect(sinkValues.at(-1)).toEqual(valueFor("v2winner"));

        // The refusal is counted…
        expect(
          (getLoggerCountsBreakdown()["storage.v2"]?.["commit-dead-dependency"]
            ?.debug ?? 0) - deadDependencyBaseline,
        ).toBe(1);
        // …and traced. A commit that never dialed a session still opens and
        // closes a push span, carrying the join keys every other push span
        // carries, so the suppressed population stays countable where the
        // errored `memory.transact` spans were counted. The error marker also
        // says what was refused: the message names this a cascade behind the
        // loser rather than a conflict of its own, and the reads and writes are
        // the follower's.
        const followerOpId = `push:${space}:${follower.localSeq}`;
        expect(
          harness.telemetryMarkers.filter((marker) =>
            "id" in marker && marker.id === followerOpId
          ),
        ).toEqual([
          {
            type: "storage.push.start",
            id: followerOpId,
            operation: "transact",
            localSeq: follower.localSeq,
            spaceDid: space,
          },
          {
            type: "storage.push.error",
            id: followerOpId,
            error: "ConflictError",
            message: `pending dependency rejected: localSeq=${loser.localSeq}`,
            reads: [`${DOCS.A}/value`],
            writes: [DOCS.D],
          },
        ]);
      } finally {
        storageLogger.level = previousLevel;
        await harness.close();
      }
    });

    it("holds a commit sitting on two rejected layers until both repairs land", async () => {
      const harness = await createHarness();
      try {
        // A and B each seeded and watched, each then overtaken by a foreign
        // winner the runner has not seen.
        await seedAccepted(harness, DOCS.A, valueFor("a1"));
        await seedAccepted(harness, DOCS.B, valueFor("b1"));
        expect(
          await harness.replica.pull([
            [{ id: DOCS.A, type: DOCUMENT_MIME }, undefined],
            [{ id: DOCS.B, type: DOCUMENT_MIME }, undefined],
          ]),
        ).toEqual({ ok: {} });
        harness.model.injectRemote({
          label: "winner-a",
          operations: [{ op: "set", id: DOCS.A, value: valueFor("a2winner") }],
        });
        const winnerSeqA = harness.model.confirmed.get(DOCS.A)!.seq;
        harness.model.injectRemote({
          label: "winner-b",
          operations: [{ op: "set", id: DOCS.B, value: valueFor("b2winner") }],
        });
        const winnerSeqB = harness.model.confirmed.get(DOCS.B)!.seq;

        // Two unrelated losers, one per document. Their repairs are
        // independent, so the markers releasing them can arrive far apart.
        const conflictBaseline = getLoggerCountsBreakdown()["storage.v2"]
          ?.["commit-conflict"]?.debug ?? 0;
        const loserA = beginSet(
          harness,
          DOCS.A,
          valueFor("a1mine"),
          sourceFromReads([{ id: DOCS.A, seq: 1 }]),
        );
        harness.model.setOutcome(loserA.localSeq, {
          kind: "rejectConflict",
          retryAfterSeq: winnerSeqA,
        });
        const loserB = beginSet(
          harness,
          DOCS.B,
          valueFor("b1mine"),
          sourceFromReads([{ id: DOCS.B, seq: 2 }]),
        );
        harness.model.setOutcome(loserB.localSeq, {
          kind: "rejectConflict",
          retryAfterSeq: winnerSeqB,
        });
        await waitForCondition(
          () =>
            (getLoggerCountsBreakdown()["storage.v2"]?.["commit-conflict"]
              ?.debug ?? 0) >= conflictBaseline + 2,
          "both conflict rejections to reach the runner",
        );
        let loserASettled = false;
        void loserA.promise.then(() => {
          loserASettled = true;
        });

        // One commit reading both documents, so it sits on both dead layers.
        const rider = beginSet(
          harness,
          DOCS.C,
          valueFor("rider"),
          sourceFromReads([{ id: DOCS.A }, { id: DOCS.B }]),
        );
        let riderSettled = false;
        const riderResult = rider.promise.then((result) => {
          riderSettled = true;
          return result;
        });
        await harness.transport.drainVerdicts();
        await clock.settle();
        expect(harness.model.transactLocalSeqs).toEqual([
          1,
          2,
          loserA.localSeq,
          loserB.localSeq,
        ]);

        // A's repair lands. Its layer drops, but B's is still standing, so a
        // retry now would read straight back through it. The rider must hold.
        harness.pushSync({
          upserts: [{
            id: DOCS.A,
            seq: winnerSeqA,
            value: valueFor("a2winner"),
          }],
          caughtUpLocalSeq: loserA.localSeq,
        });
        await clock.settle();
        expect(loserASettled).toBe(true);
        expect(riderSettled).toBe(false);

        // B's repair lands too, and only now does the rider settle.
        harness.pushSync({
          upserts: [{
            id: DOCS.B,
            seq: winnerSeqB,
            value: valueFor("b2winner"),
          }],
          caughtUpLocalSeq: loserB.localSeq,
        });
        await expectConflict(loserB.promise, "stale confirmed read");
        await expectConflict(
          riderResult,
          `pending dependency rejected: localSeq=${loserA.localSeq},${loserB.localSeq}`,
        );
        expect(harness.model.transactLocalSeqs.includes(rider.localSeq)).toBe(
          false,
        );
        expectVisible(harness, {
          A: valueFor("a2winner"),
          B: valueFor("b2winner"),
          C: undefined,
        });
      } finally {
        await harness.close();
      }
    });
  });

  describe("materializing pending state, and invalidating it", () => {
    // The cache over a stack of pending writes: what it reuses as the stack is
    // confirmed, and what it must drop when a write below it goes away.

    it("reuses the latest materialized state across repeated pending reads", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, {
          left: 0,
          right: 0,
        });

        harness.model.setOutcome(2, { kind: "accept" });
        const left = beginPatch(
          harness,
          DOCS.A,
          [{
            op: "replace",
            path: "/value/left",
            value: 1,
          }],
          {
            left: 1,
            right: 0,
          },
        );

        harness.model.setOutcome(3, { kind: "accept" });
        const right = beginPatch(
          harness,
          DOCS.A,
          [{
            op: "replace",
            path: "/value/right",
            value: 2,
          }],
          {
            left: 1,
            right: 2,
          },
        );

        const firstDocument = harness.provider.get(DOCS.A);
        const secondDocument = harness.provider.get(DOCS.A);
        expect(firstDocument).toBeDefined();
        expect(secondDocument).toBe(firstDocument);

        const firstState = harness.replica.get({
          id: DOCS.A,
          type: DOCUMENT_MIME,
        });
        const secondState = harness.replica.get({
          id: DOCS.A,
          type: DOCUMENT_MIME,
        });
        expect(firstState).toBeDefined();
        expect(secondState).toBeDefined();
        const firstMaterialized = firstState!.is;
        const secondMaterialized = secondState!.is;
        expect(firstMaterialized).toBeDefined();
        expect(secondMaterialized).toBeDefined();
        expect(secondMaterialized).toBe(firstMaterialized);

        await expectResultOk(left);
        await expectResultOk(right);
      } finally {
        await harness.close();
      }
    });

    it("promotes the cached materialization when the head pending write is confirmed", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, {
          count: 0,
        });

        harness.model.setOutcome(2, { kind: "accept" });
        const commit = beginPatch(
          harness,
          DOCS.A,
          [{
            op: "replace",
            path: "/value/count",
            value: 1,
          }],
          {
            count: 1,
          },
        );

        const pendingDocument = harness.provider.get(DOCS.A);
        const pendingState = harness.replica.get({
          id: DOCS.A,
          type: DOCUMENT_MIME,
        });
        expect(pendingDocument).toBeDefined();
        expect(pendingState).toBeDefined();

        await expectResultOk(commit);

        const confirmedDocument = harness.provider.get(DOCS.A);
        const confirmedState = harness.replica.get({
          id: DOCS.A,
          type: DOCUMENT_MIME,
        });
        expect(confirmedDocument).toBeDefined();
        expect(confirmedState).toBeDefined();
        const pendingMaterialized = pendingState!.is;
        const confirmedMaterialized = confirmedState!.is;
        expect(pendingMaterialized).toBeDefined();
        expect(confirmedMaterialized).toBeDefined();
        expect(confirmedDocument).toBe(pendingDocument);
        expect(confirmedMaterialized).toBe(pendingMaterialized);
      } finally {
        await harness.close();
      }
    });

    it("keeps the earlier pending overlay when a later same-doc patch is confirmed", async () => {
      const harness = await createHarness();
      const leftResponseGate = Promise.withResolvers<void>();
      try {
        await seedAccepted(harness, DOCS.A, {
          left: 0,
          right: 0,
        });

        let leftSettled = false;
        harness.model.setOutcome(2, {
          kind: "accept",
          responseGate: leftResponseGate.promise,
        });
        const left = beginPatch(
          harness,
          DOCS.A,
          [{
            op: "replace",
            path: "/value/left",
            value: 1,
          }],
          {
            left: 1,
            right: 0,
          },
        ).finally(() => {
          leftSettled = true;
        });

        harness.model.setOutcome(3, { kind: "accept" });
        const right = beginPatch(
          harness,
          DOCS.A,
          [{
            op: "replace",
            path: "/value/right",
            value: 2,
          }],
          {
            left: 1,
            right: 2,
          },
        );

        expectVisible(harness, {
          A: {
            left: 1,
            right: 2,
          },
        });

        await expectResultOk(right);
        expect(leftSettled).toBe(false);
        expectVisible(harness, {
          A: {
            left: 1,
            right: 2,
          },
        });

        leftResponseGate.resolve();
        await expectResultOk(left);
        expectVisible(harness, {
          A: {
            left: 1,
            right: 2,
          },
        });
      } finally {
        leftResponseGate.resolve();
        await harness.close();
      }
    });

    it("reuses unchanged branches across sibling patches", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, {
          left: {
            stable: {
              deep: true,
            },
          },
          right: {
            count: 0,
          },
        });

        harness.model.setOutcome(2, { kind: "accept" });
        const first = beginPatch(
          harness,
          DOCS.A,
          [{
            op: "replace",
            path: "/value/left/stable/deep",
            value: false,
          }],
          {
            left: {
              stable: {
                deep: false,
              },
            },
            right: {
              count: 0,
            },
          },
        );

        const firstDocument = harness.provider.get(DOCS.A);
        expect(firstDocument).toBeDefined();
        const firstValue = firstDocument!.value as Record<string, unknown>;
        const firstLeft = firstValue.left;
        const firstRight = firstValue.right;

        harness.model.setOutcome(3, { kind: "accept" });
        const second = beginPatch(
          harness,
          DOCS.A,
          [{
            op: "replace",
            path: "/value/right/count",
            value: 1,
          }],
          {
            left: {
              stable: {
                deep: false,
              },
            },
            right: {
              count: 1,
            },
          },
        );

        const secondDocument = harness.provider.get(DOCS.A);
        expect(secondDocument).toBeDefined();
        const secondValue = secondDocument!.value as Record<string, unknown>;
        expect(secondDocument).not.toBe(firstDocument);
        expect(secondValue.left).toBe(firstLeft);
        expect(secondValue.right).not.toBe(firstRight);
        expect(firstDocument).toEqual({
          value: {
            left: {
              stable: {
                deep: false,
              },
            },
            right: {
              count: 0,
            },
          },
        });
        expect(secondDocument).toEqual({
          value: {
            left: {
              stable: {
                deep: false,
              },
            },
            right: {
              count: 1,
            },
          },
        });

        await expectResultOk(first);
        await expectResultOk(second);
      } finally {
        await harness.close();
      }
    });

    it("invalidates cached suffixes when an earlier pending write drops", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, {
          left: 0,
          right: 0,
        });

        harness.model.setOutcome(2, { kind: "rejectConflict" });
        const left = beginPatch(
          harness,
          DOCS.A,
          [{
            op: "replace",
            path: "/value/left",
            value: 1,
          }],
          {
            left: 1,
            right: 0,
          },
        );

        harness.model.setOutcome(3, { kind: "accept" });
        const right = beginPatch(
          harness,
          DOCS.A,
          [{
            op: "replace",
            path: "/value/right",
            value: 2,
          }],
          {
            left: 1,
            right: 2,
          },
        );

        const beforeDrop = harness.provider.get(DOCS.A);
        expect(beforeDrop).toBeDefined();
        expect(beforeDrop!.value).toEqual({
          left: 1,
          right: 2,
        });

        await expectConflict(left);

        const afterDrop = harness.provider.get(DOCS.A);
        expect(afterDrop).toBeDefined();
        expect(afterDrop).not.toBe(beforeDrop);
        expect(afterDrop!.value).toEqual({
          left: 0,
          right: 2,
        });

        await expectResultOk(right);
      } finally {
        await harness.close();
      }
    });
  });

  describe("pending visibility", () => {
    // What a pending overlay shows a reader before it is confirmed, and the
    // patches it declines to apply over a branch their ops cannot reach. Such
    // a patch descends through a base that cannot hold it, so the layer
    // renders SKIPPED and the base shows through: a combined value would
    // fabricate a state the server never produces, and could resurrect
    // dropped sibling data.

    it("preserves `FabricValue`s in the pending view", async () => {
      const harness = await createHarness();
      let commitPromise: Promise<any> | undefined;
      try {
        const timestamp = new FabricEpochNsec(1_234n);

        const c1 = beginSet(
          harness,
          DOCS.A,
          valueFor("pending", { timestamp }),
        );
        commitPromise = c1.promise;
        harness.model.setOutcome(c1.localSeq, { kind: "accept" });

        const pendingVisible = harness.provider.get(DOCS.A);
        expect(pendingVisible).toBeDefined();
        const pendingValue = pendingVisible!.value as Record<
          string,
          FabricValue
        >;
        expect(pendingValue.label).toBe("pending");
        expect(pendingValue.timestamp).toBe(timestamp);

        await expectResultOk(c1.promise);
      } finally {
        await commitPromise?.catch(() => {});
        await harness.close();
      }
    });

    it("shows an array add patch in the pending view", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, {
          items: ["a", "b", "c"],
        });

        harness.model.setOutcome(2, { kind: "accept" });
        const add = beginPatch(
          harness,
          DOCS.A,
          [{
            op: "add",
            path: "/value/items/1",
            value: "x",
          }],
          {
            items: ["a", "x", "b", "c"],
          },
        );

        expectVisible(harness, {
          A: {
            items: ["a", "x", "b", "c"],
          },
        });

        await expectResultOk(add);
        expectVisible(harness, {
          A: {
            items: ["a", "x", "b", "c"],
          },
        });
      } finally {
        await harness.close();
      }
    });

    it("shows an array remove patch in the pending view", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, {
          items: ["a", "b", "c"],
        });

        harness.model.setOutcome(2, { kind: "accept" });
        const remove = beginPatch(
          harness,
          DOCS.A,
          [{
            op: "remove",
            path: "/value/items/1",
          }],
          {
            items: ["a", "c"],
          },
        );

        expectVisible(harness, {
          A: {
            items: ["a", "c"],
          },
        });

        await expectResultOk(remove);
        expectVisible(harness, {
          A: {
            items: ["a", "c"],
          },
        });
      } finally {
        await harness.close();
      }
    });

    it("shows an array move patch in the pending view", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, {
          items: ["a", "b", "c"],
        });

        harness.model.setOutcome(2, { kind: "accept" });
        const move = beginPatch(
          harness,
          DOCS.A,
          [{
            op: "move",
            from: "/value/items/2",
            path: "/value/items/0",
          }],
          {
            items: ["c", "a", "b"],
          },
        );

        expectVisible(harness, {
          A: {
            items: ["c", "a", "b"],
          },
        });

        await expectResultOk(move);
        expectVisible(harness, {
          A: {
            items: ["c", "a", "b"],
          },
        });
      } finally {
        await harness.close();
      }
    });

    it("skips a patch over a `null` branch its ops cannot apply to", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, null);

        harness.model.setOutcome(2, {
          kind: "rejectConflict",
          message: "synthetic null-base conflict",
        });
        const patch = beginPatch(
          harness,
          DOCS.A,
          [{
            op: "replace",
            path: "/value/choice/name",
            value: "Sushi Place",
          }],
          {
            choice: {
              name: "Sushi Place",
            },
          },
        );

        expectVisible(harness, {
          A: null,
        });

        await expectConflict(patch, "synthetic null-base conflict");
        expectVisible(harness, {
          A: null,
        });
      } finally {
        await harness.close();
      }
    });

    it("skips a patch over a scalar branch its ops cannot apply to", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, {
          choice: 1,
        });

        harness.model.setOutcome(2, {
          kind: "rejectConflict",
          message: "synthetic scalar-base conflict",
        });
        const patch = beginPatch(
          harness,
          DOCS.A,
          [{
            op: "replace",
            path: "/value/choice/name",
            value: "Sushi Place",
          }],
          {
            choice: {
              name: "Sushi Place",
            },
          },
        );

        expectVisible(harness, {
          A: {
            choice: 1,
          },
        });

        await expectConflict(patch, "synthetic scalar-base conflict");
        expectVisible(harness, {
          A: {
            choice: 1,
          },
        });
      } finally {
        await harness.close();
      }
    });

    it("skips a patch over an array branch its ops cannot apply to", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, []);

        harness.model.setOutcome(2, {
          kind: "rejectConflict",
          message: "synthetic array-base conflict",
        });
        const patch = beginPatch(
          harness,
          DOCS.A,
          [{
            op: "replace",
            path: "/value/choice/name",
            value: "Sushi Place",
          }],
          {
            choice: {
              name: "Sushi Place",
            },
          },
        );

        expectVisible(harness, {
          A: [],
        });

        await expectConflict(patch, "synthetic array-base conflict");
        expectVisible(harness, {
          A: [],
        });
      } finally {
        await harness.close();
      }
    });
  });

  describe("miscellaneous cases", () => {
    it("reports a pending-dependency error, not a stale read, for a C3 whose C2 fails", async () => {
      const harness = await createHarness();
      try {
        const c1 = beginSet(harness, DOCS.A, valueFor("c1"));
        harness.model.setOutcome(c1.localSeq, { kind: "accept" });
        await expectResultOk(c1.promise);

        const c2 = beginSet(harness, DOCS.A, valueFor("c2"));
        harness.model.setOutcome(c2.localSeq, { kind: "rejectConflict" });
        const c3 = beginSet(
          harness,
          DOCS.B,
          valueFor("c3"),
          sourceFromReads([{ id: DOCS.A }]),
        );
        harness.model.setOutcome(c3.localSeq, { kind: "accept" });

        await expectConflict(c2.promise);
        await expectConflict(c3.promise, "pending dependency");
      } finally {
        await harness.close();
      }
    });

    it("confirms the last write for duplicate ids in one batch", async () => {
      const harness = await createHarness();
      try {
        const commit = beginBatch(harness, [
          { op: "set", id: DOCS.A, value: valueFor("first") },
          { op: "set", id: DOCS.A, value: valueFor("second") },
        ]);
        harness.model.setOutcome(commit.localSeq, { kind: "accept" });

        await expectResultOk(commit.promise);

        expect(visibleValue(harness.provider, DOCS.A)).toEqual(
          valueFor("second"),
        );
        expect(currentSeq(harness, DOCS.A)).toBe(1);
      } finally {
        await harness.close();
      }
    });

    for (
      const seed of [
        0x51001,
        0x51002,
        0x51003,
        0x51004,
        0x51005,
        0x51006,
        0x51007,
        0x51008,
        0x51009,
        0x5100a,
      ]
    ) {
      it(`settles every commit of a randomized stack for seed ${seed}`, async () => {
        await runStressSeed(seed);
      });
    }

    it("rejects a dependant stranded by a dropped optimistic sibling off the drop alone, without its own server verdict", async () => {
      // The shape of a foreground `editWithRetry` write that reads documents
      // the scheduler is concurrently writing: its commit declares pending
      // reads on still-unconfirmed optimistic writes. When one of those is
      // rejected, the dependant is doomed, since its pending read names a
      // `localSeq` that will never become a confirmed seq, and a client
      // without the cascade leaves it in flight awaiting its own verdict,
      // burning the bounded retry budget and surfacing the raw "pending
      // dependency not resolved" `ConflictError` to the caller.
      //
      // Distinct from the basic cascade case: T2's own verdict stays gated for
      // the whole test, so the only thing that can settle it is the
      // client-side cascade off T1's drop, which pins that the settle is
      // entirely local (the server never judges T2 at all). The absence of a
      // settle is checked with a settled flag and a microtask drain: the clock
      // preload freezes test-file timers, and the cascade path is pure promise
      // flow, so a missing cascade surfaces within microtasks as a failed
      // assertion instead of a hang.

      const harness = await createHarness();
      const g1 = Promise.withResolvers<void>();
      const g2 = Promise.withResolvers<void>();
      try {
        // T1 optimistically writes A and B. It is destined to be rejected, but
        // its verdict is gated on g1 so T2 is built and put on the wire while
        // T1 is still in flight.
        const t1 = beginBatch(harness, [
          { op: "set", id: DOCS.A, value: valueFor("t1-a") },
          { op: "set", id: DOCS.B, value: valueFor("t1-b") },
        ]);
        harness.model.setOutcome(t1.localSeq, {
          kind: "rejectConflict",
          message: "synthetic conflict on T1",
          responseGate: g1.promise,
        });

        // T2 writes D but READS A, so its commit declares a pending read on
        // T1's still-unconfirmed optimistic write. T2's verdict gate (g2) is
        // NEVER resolved until teardown.
        const t2 = beginSet(
          harness,
          DOCS.D,
          valueFor("t2-d"),
          sourceFromReads([{ id: DOCS.A }]),
        );
        harness.model.setOutcome(t2.localSeq, {
          kind: "accept",
          responseGate: g2.promise,
        });
        let settledFromDropAlone = false;
        void t2.promise.then(() => {
          settledFromDropAlone = true;
        });

        await waitForCondition(
          () => harness.model.transactLocalSeqs.includes(t2.localSeq),
          "t2 to reach the wire",
        );

        // Drop T1. T2 is now provably doomed: its pending read names T1's
        // dropped optimistic write, which can never become a confirmed seq.
        g1.resolve();
        await expectConflict(t1.promise, "synthetic conflict on T1");

        // The cascade fires synchronously inside T1's drop and T2's settle is
        // pure promise flow from there — give the microtask queue ample turns,
        // then require the settle. A cascade-less client leaves T2 pending
        // here.
        for (let turn = 0; turn < 32; turn += 1) {
          await Promise.resolve();
        }
        expect(
          settledFromDropAlone,
          "the doomed dependant was NOT rejected by a client-side " +
            "pending-dependency cascade; it stayed in flight awaiting its own " +
            "server verdict. On the real editWithRetry path this is exactly what " +
            "makes a foreground piece.result.set() burn its bounded retry budget " +
            'and surface "pending dependency not resolved".',
        ).toBe(true);

        const t2Result = await t2.promise;
        expect(t2Result.error).toBeDefined();
        expect(t2Result.error.name).toBe("ConflictError");
        expect(
          String(t2Result.error.message),
          `unexpected dependant rejection message: ${
            JSON.stringify(t2Result.error.message)
          }`,
        ).toContain(`dropped locally: localSeq=${t1.localSeq}`);
        // The server never judged T2: it was settled entirely client-side.
        expect(harness.model.rejected.has(t2.localSeq)).toBe(false);
        expect(harness.model.applied.has(t2.localSeq)).toBe(false);
      } finally {
        g1.resolve();
        g2.resolve();
        await harness.close();
      }
    });
  });

  describe("ops replay of a pending patch layer", () => {
    // A pending patch layer renders by replaying its ops over the current base,
    // never by copying values out of its optimistic snapshot, so a dropped
    // sibling's data is unrepresentable in the result. A layer whose ops cannot
    // apply to the base (the spine died with a dropped parent, or a winner
    // replaced it with an incompatible shape) renders skipped: transiently
    // honest, converging when a frame delivers server truth. Under the strict
    // admission mode such commits become terminal rejections at admission
    // instead.

    it("renders a surviving child whose ops cannot apply to the repaired base as skipped", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, null);

        harness.model.setOutcome(2, { kind: "rejectConflict" });
        const parent = beginPatch(
          harness,
          DOCS.A,
          [{
            op: "replace",
            path: "/value",
            value: { left: 1 },
          }],
          { left: 1 },
        );

        harness.model.setOutcome(3, { kind: "accept" });
        const child = beginPatch(
          harness,
          DOCS.A,
          [{
            op: "replace",
            path: "/value/right",
            value: 2,
          }],
          { left: 1, right: 2 },
        );

        const beforeDrop = harness.provider.get(DOCS.A);
        expect(beforeDrop).toBeDefined();
        expect(beforeDrop!.value).toEqual({ left: 1, right: 2 });

        await expectConflict(parent);

        // The child's replace targets a spine that existed only in the dropped
        // parent. Its ops cannot apply to the repaired base (null), so the
        // layer renders skipped — the parent's { left: 1 } must not resurrect,
        // and nothing may crash.
        const afterDrop = harness.provider.get(DOCS.A);
        expect(afterDrop).toBeDefined();
        expect(afterDrop!.value).toBeNull();

        await expectResultOk(child);
      } finally {
        await harness.close();
      }
    });

    it("skips a layer replayed over a primitive root instead of clobbering the primitive", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, new FabricEpochNsec(1n));

        harness.model.setOutcome(2, { kind: "rejectConflict" });
        const parent = beginPatch(
          harness,
          DOCS.A,
          [{
            op: "replace",
            path: "/value",
            value: { left: 1 },
          }],
          { left: 1 },
        );

        harness.model.setOutcome(3, { kind: "accept" });
        const child = beginPatch(
          harness,
          DOCS.A,
          [{
            op: "replace",
            path: "/value/right",
            value: 2,
          }],
          { left: 1, right: 2 },
        );

        await expectConflict(parent);

        // The repaired base holds a primitive at the root the child's ops
        // descend through: the layer skips; the primitive is not clobbered
        // into an object and the dropped parent's data does not resurrect.
        const afterDrop = harness.provider.get(DOCS.A);
        expect(afterDrop).toBeDefined();
        expect(afterDrop!.value).toEqual(new FabricEpochNsec(1n));

        await expectResultOk(child);
      } finally {
        await harness.close();
      }
    });

    it("renders the repaired base for a dependent layer whose spine died with its parent", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, null);

        harness.model.setOutcome(2, { kind: "rejectConflict" });
        const parent = beginPatch(
          harness,
          DOCS.A,
          [{
            op: "replace",
            path: "/value",
            value: { items: ["a"] },
          }],
          { items: ["a"] },
        );

        harness.model.setOutcome(3, { kind: "rejectConflict" });
        const child = beginPatch(
          harness,
          DOCS.A,
          [{
            op: "replace",
            path: "/value/items/0/name",
            value: "b",
          }],
          { items: [{ name: "b" }] },
        );

        // Even before any drop, the child's replace-under-an-element cannot
        // apply to its parent's base (items[0] is a scalar): the layer renders
        // skipped from the start, rather than a fabricated
        // { items: [{ name: "b" }] } view.
        const beforeDrop = harness.provider.get(DOCS.A);
        expect(beforeDrop).toBeDefined();
        expect(beforeDrop!.value).toEqual({ items: ["a"] });

        await expectConflict(parent);

        // The child's array spine died with the parent: its layer skips and
        // the repaired base shows through — no fabricated array, no
        // resurrected "a".
        const afterParentDrop = harness.provider.get(DOCS.A);
        expect(afterParentDrop).toBeDefined();
        expect(afterParentDrop!.value).toBeNull();

        await expectConflict(child);

        const afterChildDrop = harness.provider.get(DOCS.A);
        expect(afterChildDrop).toBeDefined();
        expect(afterChildDrop!.value).toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("leaves a dropped materialization's data out of a surviving independent patch's view", async () => {
      const harness = await createHarness();
      try {
        await seedAccepted(harness, DOCS.A, { items: null });
        // Establish the sync-consumption loop (frames dead-letter without a
        // pull/watch view to feed them into the replica).
        expect(
          await harness.replica.pull([[
            { id: DOCS.A, type: DOCUMENT_MIME },
            undefined,
          ]]),
        ).toEqual({ ok: {} });
        harness.pushSync({ caughtUpLocalSeq: 1 });

        // Another client materializes the container server-side and wins. The
        // harness delivers no subscription updates, so this client's confirmed
        // mirror stays at { items: null } — modeling the window (of any length)
        // between a commit verdict and the corresponding catch-up novelty.
        harness.model.injectRemote({
          label: "client-2 wins the container",
          operations: [{
            op: "set",
            id: DOCS.A,
            value: { items: { theirs: "w" } },
          }],
        });

        // C1: this client's own (losing) materialization of the same container,
        // batched with a B write; it conflicts, so the WHOLE transaction rolls
        // back — including its A materialization.
        const c1 = beginBatch(harness, [
          { op: "set", id: DOCS.A, value: { items: { seeded: "x" } } },
          { op: "set", id: DOCS.B, value: valueFor("c1-b") },
        ]);
        harness.model.setOutcome(c1.localSeq, {
          kind: "rejectConflict",
          message: "stale materialization lost the race",
        });

        // C2: a blind leaf write through the container C1 materialized — no
        // read dependencies (like a UI vote), so it is independent and survives
        // C1's drop. The server accepts it: the authoritative state HAS the
        // container (client 2's), so the server-side patch apply succeeds.
        harness.model.setOutcome(c1.localSeq + 1, { kind: "accept" });
        const c2 = beginPatch(
          harness,
          DOCS.A,
          [{ op: "add", path: "/value/items/mine", value: "hello" }],
          { items: { seeded: "x", mine: "hello" } },
        );

        await expectConflict(c1.promise, "lost the race");
        await expectResultOk(c2);

        // The survivor replays its OPS over the stale { items: null } mirror:
        // the add cannot descend through null, so the layer skips. The dropped
        // C1's "seeded" must not resurrect out of the survivor's snapshot, and
        // no fabricated container may appear — the stale mirror shows through
        // until server truth arrives.
        expectVisible(harness, { A: { items: null } });

        // Server truth arrives on a frame (the accept's own echo): the
        // winner's container with the survivor's write merged in.
        // The view converges to it — the survivor's write lands via delivery,
        // never via client-side fabrication, and "seeded" never existed.
        harness.pushSync({
          caughtUpLocalSeq: c1.localSeq + 1,
          upserts: [{
            id: DOCS.A,
            seq: 100,
            value: { items: { theirs: "w", mine: "hello" } },
          }],
        });
        await waitForCondition(
          () =>
            (harness.provider.get(DOCS.A)?.value as
              | { items?: { theirs?: string } }
              | null
              | undefined)?.items?.theirs === "w",
          "server truth delivered and integrated",
        );
        expectVisible(harness, {
          A: { items: { theirs: "w", mine: "hello" } },
        });
      } finally {
        await harness.close();
      }
    });
  });
});

import {
  collab,
  getSyncedVersion,
  receiveUpdates,
  sendableUpdates,
  type Update,
} from "@codemirror/collab";
import {
  type ChangeDesc,
  ChangeSet,
  type Compartment,
  type EditorState,
  type Extension,
  StateEffect,
  Transaction,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  type ApplyOpResolution,
  type CellHandle,
  CellReadRefusedError,
  CODEMIRROR_CHANGESET_CODEC,
  type JSONValue,
  type OpCursor,
  type OperationFieldSnapshot,
  type RuntimeClient,
} from "@commonfabric/runtime-client";
import { isObjectOrArray } from "@commonfabric/utils/types";

export type CodeMirrorOperationPayload = {
  updates: Array<{
    clientId: string;
    changes: JSONValue;
    dedupeId?: string;
  }>;
};

export type CodeMirrorSubmission = {
  baseVersion: number;
  payload: CodeMirrorOperationPayload;
};

/** Canonical identity of the resolved Memory field synchronized by CodeMirror. */
export type CodeMirrorCollaborationFieldIdentity = {
  space: string;
  branch: string;
  id: string;
  scopeKey: string;
  path: readonly string[];
};

/** Read-only document synchronization state exposed to ephemeral consumers. */
export type CodeMirrorSynchronizationSnapshot = {
  confirmedCursor: OpCursor;
  pendingChanges: readonly ChangeDesc[];
  field: CodeMirrorCollaborationFieldIdentity;
};

/** Preserves both values when a new epoch cannot absorb unconfirmed edits. */
export class CodeMirrorReconciliationError extends Error {
  override readonly name = "CodeMirrorReconciliationError";

  constructor(
    readonly localValue: string,
    readonly canonicalValue: string,
    readonly localCursor: OpCursor | null,
    readonly canonicalCursor: OpCursor | null,
  ) {
    super("CodeMirror operation state changed with local edits pending");
  }
}

/** Marks a deterministic editor rewrite that concurrent clients may dedupe. */
export const codeMirrorRewriteDedupeEffect = StateEffect.define<string>();

/** Creates CodeMirror's local OT state at one canonical Memory version. */
export function codeMirrorCollaboration(
  startVersion: number,
  clientId: string,
): Extension {
  return collab({
    startVersion,
    clientID: clientId,
    sharedEffects: (transaction) =>
      transaction.effects.filter((effect) =>
        effect.is(codeMirrorRewriteDedupeEffect)
      ),
  });
}

/** Serializes every local CodeMirror update not yet confirmed by Memory. */
export function codeMirrorSubmission(
  state: EditorState,
): CodeMirrorSubmission | undefined {
  const pending = sendableUpdates(state);
  if (pending.length === 0) return undefined;
  return {
    baseVersion: getSyncedVersion(state),
    payload: {
      updates: pending.map((update) => ({
        clientId: update.clientID,
        changes: update.changes.toJSON() as JSONValue,
        ...(() => {
          const dedupeId = update.effects?.find((effect) =>
            effect.is(codeMirrorRewriteDedupeEffect)
          )?.value;
          return typeof dedupeId === "string" ? { dedupeId } : {};
        })(),
      })),
    },
  };
}

const decodePayload = (payload: unknown): Update[] => {
  if (
    !isObjectOrArray(payload) ||
    !Array.isArray((payload as { updates?: unknown }).updates)
  ) {
    throw new Error("CodeMirror operation payload requires an updates array");
  }
  return (payload as { updates: unknown[] }).updates.map((value) => {
    if (
      !isObjectOrArray(value) ||
      typeof (value as { clientId?: unknown }).clientId !== "string"
    ) {
      throw new Error("CodeMirror operation update requires a clientId");
    }
    const dedupeId = (value as { dedupeId?: unknown }).dedupeId;
    if (dedupeId !== undefined && typeof dedupeId !== "string") {
      throw new Error("CodeMirror operation update requires a string dedupeId");
    }
    return {
      clientID: (value as { clientId: string }).clientId,
      changes: ChangeSet.fromJSON(
        (value as { changes: Parameters<typeof ChangeSet.fromJSON>[0] })
          .changes,
      ),
      ...(dedupeId === undefined
        ? {}
        : { effects: [codeMirrorRewriteDedupeEffect.of(dedupeId)] }),
    };
  });
};

const rewriteDedupeId = (update: Update): string | undefined => {
  const value = update.effects?.find((effect) =>
    effect.is(codeMirrorRewriteDedupeEffect)
  )?.value;
  return typeof value === "string" ? value : undefined;
};

/** Confirms a local rewrite when another client integrated the same intent. */
export function codeMirrorDedupeUpdates(
  state: EditorState,
  updates: readonly Update[],
  clientId: string,
): Update[] {
  const pending = sendableUpdates(state);
  let pendingIndex = 0;
  return updates.map((update) => {
    const local = pending[pendingIndex];
    if (local === undefined) return update;
    if (update.clientID === clientId) {
      pendingIndex++;
      return update;
    }
    const dedupeId = rewriteDedupeId(update);
    const matchingIndex = dedupeId === undefined
      ? -1
      : pending.findIndex((candidate, index) =>
        index >= pendingIndex && dedupeId === rewriteDedupeId(candidate)
      );
    if (matchingIndex > pendingIndex) {
      throw new Error(
        "CodeMirror semantic rewrite followed an unconfirmed local edit",
      );
    }
    if (
      dedupeId !== undefined && dedupeId === rewriteDedupeId(local)
    ) {
      pendingIndex++;
      return { ...update, clientID: clientId };
    }
    return update;
  });
}

/**
 * Decodes the contiguous suffix needed to move CodeMirror from `current` to
 * the snapshot cursor. Memory snapshots may repeat older operations, so that
 * prefix is deliberately ignored.
 */
export function codeMirrorIntegratedUpdates(
  snapshot: OperationFieldSnapshot,
  current: OpCursor,
): Update[] {
  if (!snapshot.active || snapshot.cursor === null) {
    throw new Error("CodeMirror received an inactive operation field");
  }
  if (snapshot.codec !== CODEMIRROR_CHANGESET_CODEC) {
    throw new Error(
      `CodeMirror received operation codec ${snapshot.codec}, expected ` +
        CODEMIRROR_CHANGESET_CODEC,
    );
  }
  if (snapshot.reset === true) {
    throw new Error("CodeMirror operation history requires a reset");
  }
  if (snapshot.cursor.epoch !== current.epoch) {
    throw new Error(
      `CodeMirror operation epoch changed from ${current.epoch} to ` +
        snapshot.cursor.epoch,
    );
  }
  if (snapshot.cursor.version < current.version) return [];

  const operations = snapshot.operations.filter((operation) =>
    operation.cursor.epoch === current.epoch &&
    operation.cursor.version > current.version
  );
  let expectedVersion = current.version + 1;
  const updates: Update[] = [];
  for (const operation of operations) {
    if (operation.cursor.version !== expectedVersion) {
      throw new Error(
        `CodeMirror operation history has a gap before version ` +
          operation.cursor.version,
      );
    }
    for (const update of decodePayload(operation.payload)) updates.push(update);
    expectedVersion++;
  }
  if (expectedVersion - 1 !== snapshot.cursor.version) {
    throw new Error(
      `CodeMirror operation history ends at ${expectedVersion - 1}, but ` +
        `the field cursor is ${snapshot.cursor.version}`,
    );
  }
  return updates;
}

type ControllerOptions = {
  runtime: RuntimeClient;
  cell: CellHandle<string>;
  view: EditorView;
  compartment: Compartment;
  clientId?: string;
  onError: (error: Error) => void;
};

/** Drives CodeMirror's OT state against the runtime's generic operation API. */
export class CodeMirrorCollaborationController {
  readonly #runtime: RuntimeClient;
  readonly #cell: CellHandle<string>;
  readonly #view: EditorView;
  readonly #compartment: Compartment;
  readonly #clientId: string;
  readonly #operationSessionId = crypto.randomUUID();
  readonly #onError: (error: Error) => void;
  readonly #synchronizationObservers = new Set<
    (snapshot: CodeMirrorSynchronizationSnapshot | null) => void
  >();
  #cursor: OpCursor | null = null;
  #field: CodeMirrorCollaborationFieldIdentity | null = null;
  #baselineHash = "";
  #unsubscribe: (() => void) | undefined;
  #flushPromise: Promise<void> | undefined;
  #ready = false;
  #sending = false;
  #closing = false;
  #releasing = false;
  #failed = false;
  #disposed = false;

  constructor(options: ControllerOptions) {
    this.#runtime = options.runtime;
    this.#cell = options.cell;
    this.#view = options.view;
    this.#compartment = options.compartment;
    this.#clientId = options.clientId ?? crypto.randomUUID();
    this.#onError = options.onError;
  }

  get active(): boolean {
    return this.#canProcess() && !this.#closing;
  }

  /** The Cell handle whose field this controller synchronizes. */
  get cell(): CellHandle<string> {
    return this.#cell;
  }

  get synchronizationSnapshot(): CodeMirrorSynchronizationSnapshot | null {
    if (!this.active || this.#cursor === null || this.#field === null) {
      return null;
    }
    return {
      confirmedCursor: { ...this.#cursor },
      pendingChanges: sendableUpdates(this.#view.state).map((update) =>
        update.changes
      ),
      field: { ...this.#field, path: [...this.#field.path] },
    };
  }

  /** Observes canonical cursor advancement without granting operation control. */
  observeSynchronization(
    observer: (snapshot: CodeMirrorSynchronizationSnapshot | null) => void,
  ): () => void {
    this.#synchronizationObservers.add(observer);
    this.#notifySynchronizationObserver(observer, this.synchronizationSnapshot);
    return () => this.#synchronizationObservers.delete(observer);
  }

  #canProcess(): boolean {
    return this.#ready && !this.#failed && !this.#disposed;
  }

  async start(): Promise<void> {
    try {
      await this.#start();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  async #start(): Promise<void> {
    const codecs = await this.#runtime.operationCodecs(
      this.#cell,
      this.#operationSessionId,
    );
    if (this.#disposed) {
      this.#closeOperationSession();
      return;
    }
    if (!codecs.includes(CODEMIRROR_CHANGESET_CODEC)) {
      throw new Error(
        `Memory server does not advertise ${CODEMIRROR_CHANGESET_CODEC}`,
      );
    }
    const snapshot = await this.#runtime.queryOperationField(
      this.#cell,
      undefined,
      this.#operationSessionId,
    );
    if (this.#disposed) {
      this.#closeOperationSession();
      return;
    }
    this.#install(snapshot);
    const unsubscribe = await this.#runtime.subscribeOperationField(
      this.#cell,
      (next) => this.#receive(next),
      {
        ...(snapshot.cursor === null ? {} : { after: snapshot.cursor }),
        ...(this.#operationSessionId === undefined
          ? {}
          : { operationSessionId: this.#operationSessionId }),
        // A field the worker stops showing ends the session, as a failure
        // does: no edit is sent over a field the host can no longer see.
        onRefused: (refusal) => this.#fail(new CellReadRefusedError(refusal)),
      },
    );
    if (this.#disposed) {
      unsubscribe();
      this.#closeOperationSession();
      return;
    }
    this.#unsubscribe = unsubscribe;
  }

  async localDocChanged(): Promise<void> {
    if (!this.active || this.#failed) return;
    this.#notifySynchronization();
    await this.#flush();
  }

  /** Confirms every pending edit before a semantic external rewrite. */
  async prepareExternalChange(): Promise<boolean> {
    if (!this.active || this.#failed) return false;
    await this.#flush();
    return this.active && sendableUpdates(this.#view.state).length === 0;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#ready = false;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#closeOperationSession();
    this.#notifySynchronization();
    this.#synchronizationObservers.clear();
  }

  #closeOperationSession(): void {
    void this.#runtime.closeOperationSession(this.#operationSessionId).catch(
      () => undefined,
    );
  }

  /** Flushes local updates before detaching without releasing durable state. */
  async stop(): Promise<void> {
    if (this.#disposed) return;
    if (!this.#ready) {
      // Setup can be superseded while its initial query is in flight. The
      // editor is read-only until installation finishes, so this controller
      // cannot own local updates yet and can be cancelled without consulting
      // CodeMirror's not-yet-installed collaboration state field.
      this.dispose();
      return;
    }
    this.#closing = true;
    try {
      await this.#flush();
      if (sendableUpdates(this.#view.state).length !== 0) {
        throw new Error(
          "CodeMirror collaboration cannot stop with local edits pending",
        );
      }
      this.dispose();
    } catch (error) {
      this.#closing = false;
      throw error;
    }
  }

  async release(): Promise<void> {
    if (!this.active) {
      throw new Error("CodeMirror collaboration is not active");
    }
    this.#closing = true;
    try {
      await this.#flush();
      if (sendableUpdates(this.#view.state).length !== 0) {
        throw new Error(
          "CodeMirror collaboration cannot be released with local edits pending",
        );
      }
      const cursor = this.#cursor;
      if (cursor !== null) {
        this.#releasing = true;
        await this.#runtime.releaseOperationField(
          this.#cell,
          CODEMIRROR_CHANGESET_CODEC,
          cursor,
          this.#operationSessionId,
        );
        this.#releasing = false;
      }
      this.dispose();
    } catch (error) {
      this.#releasing = false;
      this.#closing = false;
      throw error;
    }
  }

  /**
   * Replaces the document and CodeMirror's collaboration state with the
   * snapshot's canonical epoch.
   *
   * Installing discards CodeMirror's unconfirmed queue, which is the only
   * record of a local edit Memory has not confirmed. An installed controller
   * holding unconfirmed edits therefore refuses, failing with a
   * `CodeMirrorReconciliationError` that carries both values, so the host
   * reports the conflict instead of adopting the canonical value silently.
   */
  #install(snapshot: OperationFieldSnapshot): void {
    if (typeof snapshot.materialized !== "string") {
      throw new Error("CodeMirror collaboration requires a string field");
    }
    if (
      snapshot.active && snapshot.codec !== CODEMIRROR_CHANGESET_CODEC
    ) {
      throw new Error(
        `CodeMirror cannot open operation codec ${snapshot.codec}`,
      );
    }
    this.#assertFieldIdentity(snapshot);
    // Before the first installation the compartment holds no collaboration
    // field, and there is nothing to discard; `#ready` is what says a field
    // is installed and its queue can be read.
    if (this.#ready && sendableUpdates(this.#view.state).length !== 0) {
      throw new CodeMirrorReconciliationError(
        this.#view.state.doc.toString(),
        snapshot.materialized,
        this.#cursor,
        snapshot.active ? snapshot.cursor : null,
      );
    }
    const version = snapshot.cursor?.version ?? 0;
    this.#ready = false;
    // Invalidate observer state before any transaction can map ephemeral
    // coordinates through a replacement from another operation epoch.
    this.#notifySynchronization();
    // A document-changing transaction that installs the collab extension is
    // observed by CodeMirror as a local update before the new client ID facet
    // is available. Clear the old epoch and synchronize the document first,
    // then install a clean collaboration state at the canonical version.
    this.#view.dispatch({
      changes: {
        from: 0,
        to: this.#view.state.doc.length,
        insert: snapshot.materialized,
      },
      effects: this.#compartment.reconfigure([]),
      annotations: Transaction.remote.of(true),
    });
    this.#view.dispatch({
      effects: this.#compartment.reconfigure(
        codeMirrorCollaboration(version, this.#clientId),
      ),
      annotations: Transaction.remote.of(true),
    });
    this.#cursor = snapshot.cursor;
    this.#baselineHash = snapshot.baselineHash;
    this.#ready = true;
    this.#notifySynchronization();
  }

  #receive(snapshot: OperationFieldSnapshot): void {
    if (!this.#canProcess() || this.#failed) return;
    try {
      this.#assertFieldIdentity(snapshot);
      if (typeof snapshot.materialized !== "string") {
        throw new Error("CodeMirror collaboration requires a string field");
      }
      if (!snapshot.active || snapshot.cursor === null) {
        if (
          this.#cursor === null && this.#sending &&
          snapshot.baselineHash === this.#baselineHash
        ) {
          // The first apply activates the field asynchronously. A concurrent
          // sync can still carry the unchanged inactive baseline while that
          // submission is in flight; it says nothing newer about the local
          // edit and must not be mistaken for an epoch reset.
          return;
        }
        if (this.#cursor !== null) {
          if (this.#releasing) {
            this.#cursor = null;
            this.#baselineHash = snapshot.baselineHash;
            return;
          }
          this.#install(snapshot);
          return;
        }
        if (sendableUpdates(this.#view.state).length === 0) {
          if (this.#view.state.doc.toString() !== snapshot.materialized) {
            // Reinstall the collaboration state as well as the document. A
            // normal document transaction would otherwise be recorded as a
            // local version-zero update and replay the replacement when this
            // inactive field is first activated.
            this.#install(snapshot);
          } else {
            this.#baselineHash = snapshot.baselineHash;
          }
        } else if (this.#view.state.doc.toString() !== snapshot.materialized) {
          throw new CodeMirrorReconciliationError(
            this.#view.state.doc.toString(),
            snapshot.materialized,
            null,
            null,
          );
        }
        return;
      }

      if (snapshot.reset === true) {
        this.#install(snapshot);
        return;
      }

      const previousCursor = this.#cursor;
      const becameActive = previousCursor === null;
      if (becameActive) {
        this.#cursor = { epoch: snapshot.cursor.epoch, version: 0 };
      } else if (previousCursor.epoch !== snapshot.cursor.epoch) {
        this.#install(snapshot);
        return;
      }

      const activeCursor = this.#cursor;
      if (activeCursor === null) {
        throw new Error("Active CodeMirror snapshot has no operation cursor");
      }
      const current = {
        epoch: activeCursor.epoch,
        version: getSyncedVersion(this.#view.state),
      };
      if (snapshot.cursor.version < current.version) return;
      if (snapshot.cursor.version === current.version) {
        this.#baselineHash = snapshot.baselineHash;
        if (
          sendableUpdates(this.#view.state).length === 0 &&
          this.#view.state.doc.toString() !== snapshot.materialized
        ) {
          throw new Error(
            "CodeMirror snapshot disagrees at the current operation cursor",
          );
        }
        if (becameActive) this.#notifySynchronization();
        return;
      }
      const updates = codeMirrorIntegratedUpdates(snapshot, current);
      if (updates.length !== 0) {
        this.#view.dispatch(receiveUpdates(
          this.#view.state,
          codeMirrorDedupeUpdates(
            this.#view.state,
            updates,
            this.#clientId,
          ),
        ));
      }
      this.#cursor = {
        epoch: snapshot.cursor.epoch,
        version: getSyncedVersion(this.#view.state),
      };
      this.#baselineHash = snapshot.baselineHash;
      this.#notifySynchronization();
      if (
        sendableUpdates(this.#view.state).length === 0 &&
        this.#view.state.doc.toString() !== snapshot.materialized
      ) {
        throw new Error(
          "CodeMirror operations do not reproduce Memory's materialized value",
        );
      }
    } catch (error) {
      this.#fail(error);
    }
  }

  /**
   * Waits for any running drain, re-reads the queue, and owns the next drain
   * if unconfirmed updates remain.
   *
   * One drain runs at a time. A running drain may have serialized its
   * submission before the update this caller observed, so waiting and then
   * re-reading is what makes that update the responsibility of a submission
   * serialized after it was recorded: this call's, or that of a drain another
   * waiter started first. Waiting again whenever a drain is in flight is what
   * keeps several waiters woken by the same drain from each starting one and
   * submitting the same update under two submission ids.
   */
  async #flush(): Promise<void> {
    while (this.#flushPromise !== undefined) {
      try {
        await this.#flushPromise;
      } catch {
        // The drain's owner receives its rejection; a waiter only needs it
        // to have settled.
      }
    }
    if (
      !this.#canProcess() || sendableUpdates(this.#view.state).length === 0
    ) {
      return;
    }
    const drain = this.#drain();
    this.#flushPromise = drain;
    try {
      await drain;
    } finally {
      if (this.#flushPromise === drain) this.#flushPromise = undefined;
    }
  }

  /**
   * Submits unconfirmed local updates, one round trip at a time, until none
   * remain or this controller can no longer process.
   *
   * CodeMirror's unconfirmed queue is the only record of a local edit before
   * Memory confirms it, so every update recorded there is either confirmed by
   * a submission or reported through `onError`. An update recorded while a
   * submission is in flight stays queued, rebased over whatever that
   * submission integrates, and the next round trip carries it.
   */
  async #drain(): Promise<void> {
    while (
      this.#canProcess() && sendableUpdates(this.#view.state).length !== 0
    ) {
      // CodeMirror keeps an update's origin transaction across rebases, so
      // the oldest unconfirmed update still heading the queue after a round
      // trip means that round trip confirmed nothing, and repeating it would
      // repeat forever. This bounds each round trip to confirming at least
      // its oldest update; a later update left unconfirmed heads the next
      // round trip and is judged there.
      const oldest = sendableUpdates(this.#view.state)[0].origin;
      await this.#submit();
      if (
        this.#canProcess() &&
        sendableUpdates(this.#view.state)[0]?.origin === oldest
      ) {
        this.#fail(
          new Error("CodeMirror submission confirmed no local update"),
        );
      }
    }
  }

  /** Submits every unconfirmed update in one apply and integrates the result. */
  async #submit(): Promise<void> {
    this.#sending = true;
    try {
      const submission = codeMirrorSubmission(this.#view.state);
      if (submission === undefined) return;
      const base = this.#cursor === null
        ? null
        : { epoch: this.#cursor.epoch, version: submission.baseVersion };
      const resolution = await this.#runtime.applyOperation(this.#cell, {
        codec: CODEMIRROR_CHANGESET_CODEC,
        submissionId: crypto.randomUUID(),
        base,
        ...(base === null ? { baselineHash: this.#baselineHash } : {}),
        payload: submission.payload,
      }, this.#operationSessionId);
      // A superseding controller owns the compartment once this one is
      // disposed; a late resolution must not be dispatched into it.
      if (this.#disposed) return;
      this.#receiveResolution(resolution);
      const snapshot = await this.#runtime.queryOperationField(
        this.#cell,
        this.#cursor ?? undefined,
        this.#operationSessionId,
      );
      if (this.#disposed) return;
      this.#receive(snapshot);
    } catch (error) {
      this.#fail(error);
    } finally {
      this.#sending = false;
    }
  }

  /** Confirms a contiguous apply response before a later watch/query races it. */
  #receiveResolution(resolution: ApplyOpResolution): void {
    if (resolution.codec !== CODEMIRROR_CHANGESET_CODEC) {
      throw new Error(
        `CodeMirror received operation codec ${resolution.codec}, expected ` +
          CODEMIRROR_CHANGESET_CODEC,
      );
    }
    this.#assertFieldIdentity(resolution.address);
    const syncedVersion = getSyncedVersion(this.#view.state);
    const current = this.#cursor ?? {
      epoch: resolution.from.epoch,
      version: syncedVersion,
    };
    if (
      current.epoch === resolution.to.epoch &&
      syncedVersion === resolution.to.version
    ) {
      this.#cursor = resolution.to;
      this.#notifySynchronization();
      return;
    }
    if (
      current.epoch !== resolution.from.epoch ||
      syncedVersion !== resolution.from.version
    ) {
      // A subscription has not yet supplied the intervening canonical suffix.
      // The follow-up query below requests it from the last installed cursor.
      return;
    }
    const snapshot: OperationFieldSnapshot = {
      ...resolution.address,
      active: true,
      codec: resolution.codec,
      cursor: resolution.to,
      baselineHash: this.#baselineHash,
      materialized: this.#view.state.doc.toString(),
      operations: resolution.operations,
    };
    const updates = codeMirrorIntegratedUpdates(snapshot, current);
    if (updates.length !== 0) {
      this.#view.dispatch(receiveUpdates(
        this.#view.state,
        codeMirrorDedupeUpdates(
          this.#view.state,
          updates,
          this.#clientId,
        ),
      ));
    }
    this.#cursor = {
      epoch: resolution.to.epoch,
      version: getSyncedVersion(this.#view.state),
    };
    this.#notifySynchronization();
  }

  #fail(cause: unknown): void {
    if (this.#failed || this.#disposed) return;
    this.#failed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#notifySynchronization();
    const error = cause instanceof Error ? cause : new Error(String(cause));
    this.#onError(error);
  }

  #notifySynchronization(): void {
    const snapshot = this.synchronizationSnapshot;
    for (const observer of this.#synchronizationObservers) {
      this.#notifySynchronizationObserver(observer, snapshot);
    }
  }

  #assertFieldIdentity(
    address: Pick<
      OperationFieldSnapshot,
      "branch" | "id" | "scopeKey" | "path"
    >,
  ): void {
    const next: CodeMirrorCollaborationFieldIdentity = {
      space: String(this.#cell.space()),
      branch: address.branch,
      id: address.id,
      scopeKey: address.scopeKey,
      path: [...address.path],
    };
    const current = this.#field;
    if (current === null) {
      this.#field = next;
      return;
    }
    if (
      current.space !== next.space || current.branch !== next.branch ||
      current.id !== next.id || current.scopeKey !== next.scopeKey ||
      current.path.length !== next.path.length ||
      current.path.some((part, index) => part !== next.path[index])
    ) {
      throw new Error("CodeMirror operation field identity changed");
    }
  }

  #notifySynchronizationObserver(
    observer: (snapshot: CodeMirrorSynchronizationSnapshot | null) => void,
    snapshot: CodeMirrorSynchronizationSnapshot | null,
  ): void {
    try {
      observer(snapshot);
    } catch {
      // Ephemeral observers cannot become part of Memory's operation path.
    }
  }
}

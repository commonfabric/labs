/**
 * CellHandle - Represents a `Cell` in a runtime.
 */

import {
  FabricInstance,
  FabricPrimitive,
  type FabricValue,
  type FabricValuePlus,
  isFabricSpecialObject,
  valueEqual,
} from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { DID } from "@commonfabric/identity";
import { type CfcCellLinkRefPayload } from "@commonfabric/runner/cfc";
import {
  cfcLabelViewsEqual,
  rebaseCfcLabelView,
} from "@commonfabric/runner/cfc/label-view-core";
import {
  type Cancel,
  isSigilLink,
  type JSONSchema,
  linkRefFrom,
  linkRefPayload,
  linkRefPayloadToString,
  refuseFabricInstance,
  type SigilLink,
} from "@commonfabric/runner/shared";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import { InitializedRuntimeConnection } from "./client/connection.ts";
import {
  type CellRef,
  type CfcLabelView,
  JSONValue,
  RequestType,
  type SqliteParams,
} from "./protocol/mod.ts";
import { $conn, type RuntimeClient } from "./runtime-client.ts";
import { cellRefToIdentityKey } from "./shared/utils.ts";

// Logger for schema warnings - disabled by default.
// Enable via: globalThis.commonfabric.logger["cell-handle"].disabled = false
const logger = getLogger("cell-handle", { enabled: false });

interface CellOperationQueue {
  tail: Promise<void> | undefined;
  hasValue: boolean;
  value: unknown;
  // Changes when any equivalent handle receives an authoritative update.
  authoritativeGeneration: number;
}

const operationQueues = new WeakMap<
  RuntimeClient,
  Map<string, CellOperationQueue>
>();

export const $onCellUpdate = Symbol("$onCellUpdate");

/**
 * A cell's value as the _client_ holds it: what a cell holds, with a
 * `CellHandle` wherever a cell sits. That is the substitution `vnode-types.ts`
 * already makes for the render types -- `Cell` replaced by `CellHandle` --
 * applied to a cell's own value.
 *
 * What a cell holds is a `FabricValue`, so this is `FabricValuePlus` at
 * `CellHandle` rather than something restated: a `FabricBytes` in a cell is a
 * value the client holds like any other, and this stays true of whatever
 * `FabricValue` comes to admit, while a handle may sit at the top or inside
 * any container.
 *
 * The connection's encoding carries this whole domain. The conversion walk
 * that feeds it is narrower: `CellHandle.serialize()` refuses a
 * `FabricInstance`, being a container it cannot descend to find a handle
 * inside. So a value admitted here can still be refused on the way out, and
 * the refusal names which.
 */
export type ClientCellValue = FabricValuePlus<CellHandle<unknown>>;

/**
 * CellHandle provides a cell interface for cells living in a web worker.
 */
export class CellHandle<T = unknown> {
  #rt: RuntimeClient;
  #conn: InitializedRuntimeConnection;
  #ref: CellRef;
  #value: T | undefined;
  #cfcLabel: CfcLabelView | undefined;

  /**
   * Whether any subscriber asked for the CFC label. Sticky: once a label-aware
   * subscription exists on this handle, label changes also fire its callbacks.
   */
  #wantsCfcLabel = false;

  #callbacks = new Map<
    number,
    (value: Readonly<T>, cfcLabel: CfcLabelView | undefined) => void
  >();
  #nextCallbackId = 0;
  #schemaWarned = false;
  #updateGeneration = 0;

  /**
   * Monotonic invocation order for local value mutations on this handle. Async
   * read and strict-write responses use it to avoid replacing a later
   * optimistic value while their remote operations remain FIFO-serialized.
   */
  #writeGeneration = 0;

  constructor(worker: RuntimeClient, cellRef: CellRef, value?: T) {
    this.#rt = worker;
    this.#conn = worker[$conn]();
    this.#ref = cellRef;
    this.#value = value;
  }

  /**
   * Check if this cell has a schema defined. Warns if no schema is set.
   * Warning is disabled by default; enable via:
   * globalThis.commonfabric.logger["cell-handle"].disabled = false
   */
  #requireSchema(method: string): void {
    if (!this.#ref.schema && !this.#schemaWarned) {
      this.#schemaWarned = true;
      // Use callback for lazy evaluation - stack trace only generated if logging is enabled
      logger.warn(`no-schema-${method}`, () => {
        const stack = new Error().stack;
        return [
          `${method}() called without schema on cell ${this.#ref.id}:${
            this.#ref.path.join(".")
          }. ` +
          `Please bind a schema using asSchema() or pass a schema to the cell controller's bind() method.\n` +
          `Stack trace:\n${stack}`,
        ];
      });
    }
  }

  runtime(): RuntimeClient {
    return this.#rt;
  }

  ref(): CellRef {
    return this.#ref;
  }

  space(): DID {
    return this.#ref.space;
  }

  /**
   * The FULL schemed id — identical to `ref().id` and safe to use as
   * identity (keys, equality, round-trips). The hash preimage is kind-free,
   * so the URI scheme is the only thing distinguishing a computed doc from
   * a state sibling of the same cause; this accessor never strips it. For
   * the piece-root routing/display form (bare, `of:`-stripped), use
   * `PieceHandle.id()` — see docs/specs/computed-cell-identity.md.
   */
  id(): string {
    return this.#ref.id;
  }

  /**
   * Get the current cached value.
   */
  get(): Readonly<T> | undefined {
    this.#requireSchema("get");
    return this.#value !== undefined ? this.#value as Readonly<T> : undefined;
  }

  /**
   * Publishes an optimistic value and sends it to the runtime. The returned
   * promise covers request acknowledgment; transport failures are logged.
   */
  async set(value: T): Promise<void> {
    this.#requireSchema("set");
    // A plain set is a blind last-write-wins overwrite (CellSet).
    const serialized = this.#serializeWrite(value);
    const snapshot = applyValue(
      CellHandle.#serialize(value as ClientCellValue, "sigil"),
      value,
      this,
    ) as T;
    this.#writeGeneration++;
    this.#publishValue(snapshot);
    await this.#enqueueOperation(async (queue) => {
      const updateGeneration = this.#updateGeneration;
      const authoritativeGeneration = queue.authoritativeGeneration;
      await this.#sendWrite(serialized);
      if (
        updateGeneration === this.#updateGeneration &&
        authoritativeGeneration === queue.authoritativeGeneration
      ) {
        queue.value = snapshot;
        queue.hasValue = true;
      }
    });
  }

  /**
   * Writes a UI edit and rejects when the runtime refuses it. Dispatch follows
   * queued operations, then releases the queue while the commit is pending so
   * later input can reach the runtime. The caller owns the optimistic display;
   * subscriptions supply this handle's value, including any rollback.
   */
  async setForUI(value: T): Promise<void> {
    this.#requireSchema("setForUI");
    const serialized = this.#serializeWrite(value);
    this.#writeGeneration++;
    const { committed } = await this.#enqueueOperation((queue) => {
      const committed = this.#conn.request<RequestType.CellSet>({
        type: RequestType.CellSet,
        cell: this.ref(),
        value: serialized,
        awaitCommit: true,
      });
      // A snapshot cached by an earlier queued operation predates this edit.
      queue.hasValue = false;
      // The dispatch promise releases the queue first. Observe a refusal
      // even if it arrives before the caller starts awaiting the outcome.
      void committed.catch(() => {});
      return Promise.resolve({ committed });
    });
    await committed;
  }

  /**
   * Sets the value and holds subsequent operations until its commit completes.
   * Rejects refusal; publishes after commit unless a newer write or delivery
   * superseded it.
   */
  async setStrict(value: T): Promise<void> {
    this.#requireSchema("setStrict");
    const serialized = this.#serializeWrite(value);
    const snapshot = applyValue(
      CellHandle.#serialize(value as ClientCellValue, "sigil"),
      value,
      this,
    ) as T;
    const writeGeneration = this.#writeGeneration;
    await this.#enqueueOperation(async (queue) => {
      const updateGeneration = this.#updateGeneration;
      const authoritativeGeneration = queue.authoritativeGeneration;
      await this.#sendStrictWrite(
        snapshot,
        serialized,
        writeGeneration,
        queue,
        authoritativeGeneration,
      );
      // Publication follows handle-local and identity-wide generations, but
      // this shared queue follows committed operation order. A later queued
      // append must start from this replacement even when a still-later
      // mutation suppresses its direct publication on this handle.
      if (
        updateGeneration === this.#updateGeneration &&
        authoritativeGeneration === queue.authoritativeGeneration
      ) {
        queue.value = snapshot;
        queue.hasValue = true;
      }
    });
  }

  /**
   * Atomically stores `value` only if the cell has no backing value, then
   * returns the value selected by that transaction. A readable schema fallback
   * does not count as stored. Concurrent initializers converge on one winner
   * instead of replacing it with a blind write.
   */
  async initialize(value: T): Promise<Readonly<T>> {
    this.#requireSchema("initialize");
    if (value === undefined) {
      throw new TypeError("Cell initialize requires a defined value.");
    }
    const serialized = this.#serializeWrite(value);
    const writeGeneration = ++this.#writeGeneration;
    const updateGeneration = this.#updateGeneration;
    const { current, authoritative } = await this.#enqueueOperation(
      async (queue) => {
        const authoritativeGeneration = queue.authoritativeGeneration;
        const response = await this.#conn.request<RequestType.CellInitialize>({
          type: RequestType.CellInitialize,
          cell: this.ref(),
          value: serialized,
        });
        const current = CellHandle.deserialize<T>(this, response.value) as T;
        const authoritative = updateGeneration === this.#updateGeneration &&
          authoritativeGeneration === queue.authoritativeGeneration;
        if (authoritative) {
          queue.value = current;
          queue.hasValue = true;
        }
        return { current, authoritative };
      },
    );
    if (
      writeGeneration === this.#writeGeneration &&
      updateGeneration === this.#updateGeneration &&
      authoritative
    ) {
      this.#publishValue(current);
    }
    return current as Readonly<T>;
  }

  #enqueueOperation<R>(
    operation: (queue: CellOperationQueue) => Promise<R>,
  ): Promise<R> {
    let queues = operationQueues.get(this.#rt);
    if (!queues) {
      queues = new Map();
      operationQueues.set(this.#rt, queues);
    }
    const key = cellRefToIdentityKey(this.#ref);
    let queue = queues.get(key);
    if (!queue) {
      queue = {
        tail: undefined,
        hasValue: false,
        value: undefined,
        authoritativeGeneration: 0,
      };
      queues.set(key, queue);
    }
    const previous = queue.tail;
    const result = previous
      ? previous.then(() => operation(queue))
      : operation(queue);
    const tail = result.then(() => {}, () => {});
    queue.tail = tail;
    void tail.then(() => {
      if (queue.tail === tail) {
        queues.delete(key);
        if (queues.size === 0) operationQueues.delete(this.#rt);
      }
    });
    return result;
  }

  #serializeWrite(value: T): FabricValue {
    // Serialize before an optimistic local publication, because this can
    // refuse. A value the runtime will never see must not become this handle's
    // cached value or reach its subscribers.
    //
    // `T` is unconstrained, so this says what the write path requires rather
    // than what the class guarantees. Constraining `T` to `ClientCellValue` is
    // the honest fix and is not a small one: the schema-derived types
    // (`ObjectFromProperties<...>`) and the looser `Props` of `vnode-types.ts`
    // do not satisfy it, an interface having no implicit index signature where
    // an identical type alias does.
    //
    // TODO(danfuzz): constrain `T`, once those types are assignable.
    return CellHandle.serialize(value as ClientCellValue);
  }

  #sendWrite(
    serialized: FabricValue,
  ): Promise<void> {
    const cell = this.ref();
    const request = this.#conn.request<RequestType.CellSet>({
      type: RequestType.CellSet,
      cell,
      value: serialized,
    });
    return request.catch((error) => {
      if (!this.#conn.signal.aborted) {
        console.error("[CellHandle] Write failed:", error);
      }
    });
  }

  #sendStrictWrite(
    value: T,
    serialized: FabricValue,
    writeGeneration: number,
    queue: CellOperationQueue,
    authoritativeGeneration: number,
  ): Promise<boolean> {
    const before = this.#value;
    const updateGeneration = this.#updateGeneration;
    return this.#conn.request<RequestType.CellSet>({
      type: RequestType.CellSet,
      cell: this.ref(),
      value: serialized,
      awaitCommit: true,
    }).then(() => {
      const publish = writeGeneration === this.#writeGeneration &&
        updateGeneration === this.#updateGeneration &&
        authoritativeGeneration === queue.authoritativeGeneration &&
        this.#value === before;
      if (publish) this.#publishValue(value);
      return publish;
    });
  }

  #publishValue(value: T): void {
    this.#value = value;
    for (const callback of this.#callbacks.values()) {
      try {
        // A local update does not change the label; carry the current one.
        callback(value as Readonly<T>, this.#cfcLabel);
      } catch (error) {
        console.error("[CellHandle] Callback error:", error);
      }
    }
  }

  async send(event: T): Promise<void> {
    const serialized = CellHandle.serialize(event as ClientCellValue);
    await this.#enqueueOperation(() => this.#send(serialized));
  }

  /** Send a stream event and reject when the runtime refuses it. */
  async sendStrict(event: T): Promise<void> {
    const serialized = CellHandle.serialize(event as ClientCellValue);
    await this.#enqueueOperation(() => this.#send(serialized, true));
  }

  #send(event: FabricValue, propagateFailure = false): Promise<void> {
    const request = this.#conn.request<RequestType.CellSend>({
      type: RequestType.CellSend,
      cell: this.ref(),
      event,
      ...(propagateFailure && { awaitCommit: true }),
    });
    if (propagateFailure) return request;
    return request.catch((error) => {
      if (!this.#conn.signal.aborted) {
        console.error("[CellHandle] Send failed:", error);
      }
    });
  }

  /**
   * Get a child cell at the specified key.
   * Returns a new CellHandle with an extended path.
   */
  key<K extends keyof T>(valueKey: K): CellHandle<T[K]> {
    const childRef = this.#extendPath(String(valueKey));
    const child = new CellHandle<T[K]>(this.#rt, childRef);

    // If we have a cached value, pre-populate the child's cache
    if (this.#value != null) {
      const childValue = (this.#value as Record<string, unknown>)[
        String(valueKey)
      ];
      if (childValue !== undefined) {
        child.#value = childValue as T[K];
      }
    }

    return child;
  }

  /**
   * Appends `values` to the array this handle holds. A push publishes an
   * invocation-time local snapshot, but sends only the appended members. The
   * runtime owns the authoritative mergeable append, so an equivalent handle's
   * stale private cache cannot replace committed data.
   */
  push<U>(
    this: CellHandle<U[]>,
    ...values: T extends (infer U)[] ? U[] : never
  ): void {
    void this.#pushValues(values).catch((error) => {
      if (!this.#conn.signal.aborted) {
        console.error("[CellHandle] Push failed:", error);
      }
    });
  }

  /** Append values and reject when the runtime refuses the mergeable write. */
  pushStrict<U>(
    this: CellHandle<U[]>,
    ...values: T extends (infer U)[] ? U[] : never
  ): Promise<void> {
    return this.#pushValues(values);
  }

  #pushValues<U>(values: U[]): Promise<void> {
    const serializedValues = values.map((value) =>
      CellHandle.serialize(value as ClientCellValue)
    );
    const snapshots = values.map((value) => {
      const snapshot = CellHandle.#serialize(
        value as ClientCellValue,
        "sigil",
      );
      return applyValue(snapshot, value, this);
    }) as U[];
    const cached = this.#value;
    const fallback = cached === undefined ? undefined : applyValue(
      CellHandle.#serialize(cached as ClientCellValue, "sigil"),
      cached,
      this,
    );
    const writeGeneration = ++this.#writeGeneration;
    const append = (queue: CellOperationQueue): Promise<void> => {
      const authoritativeGeneration = queue.authoritativeGeneration;
      const current = (queue.hasValue ? queue.value : fallback) as unknown[];
      if (!Array.isArray(current)) {
        throw new Error("push() can only be used on array cells");
      }
      const value = [...current, ...snapshots] as unknown as U[];
      const updateGeneration = this.#updateGeneration;
      queue.value = value;
      queue.hasValue = true;
      if (writeGeneration === this.#writeGeneration) {
        this.#publishValue(value as unknown as T);
      }
      const rollback = () => {
        if (
          updateGeneration === this.#updateGeneration &&
          authoritativeGeneration === queue.authoritativeGeneration
        ) {
          // Keep the restored base explicit in the shared queue. A later
          // append may have captured this append's optimistic publication as
          // its private fallback before the refusal arrived.
          queue.hasValue = true;
          queue.value = current;
          if (writeGeneration === this.#writeGeneration) {
            this.#publishValue(current as unknown as T);
          }
        }
      };
      let request: Promise<unknown>;
      try {
        request = this.#conn.request<RequestType.CellPush>({
          type: RequestType.CellPush,
          cell: this.ref(),
          values: serializedValues,
          awaitCommit: true,
        });
      } catch (error) {
        rollback();
        return Promise.reject(error);
      }
      return request.then(() => {}, (error) => {
        rollback();
        throw error;
      });
    };
    return this.#enqueueOperation(append);
  }

  /** The cell's current display CFC label, for label-aware subscribers. */
  get cfcLabel(): CfcLabelView | undefined {
    return this.#cfcLabel;
  }

  /** Whether this handle subscribed asking for reactive CFC-label delivery. */
  get wantsCfcLabel(): boolean {
    return this.#wantsCfcLabel;
  }

  /**
   * Subscribe to cell value changes.
   * The callback is called immediately with the current value (even if undefined)
   * and whenever the value changes.
   * The callback's return value (if a Cancel function) is called before the next update.
   */
  subscribe(
    callback: (
      value: T | undefined,
      cfcLabel?: CfcLabelView | undefined,
    ) => Cancel | undefined | void,
    options: { includeCfcLabel?: boolean } = {},
  ): Cancel {
    this.#requireSchema("subscribe");
    // If a label-aware subscription is added AFTER a value-only one already
    // opened the backend subscription, that backend sub carries no label and
    // the connection would dedup this one away. Re-establish it so it delivers
    // labels (the worker recreates its sink with includeCfcLabel). This works
    // when this handle is the sole subscriber of its ref; a value-only handle
    // sharing the exact same ref would keep the backend sub label-less.
    const upgradeToCfcLabel = options.includeCfcLabel === true &&
      !this.#wantsCfcLabel && this.#callbacks.size > 0;
    if (options.includeCfcLabel) {
      this.#wantsCfcLabel = true;
    }
    const callbackId = this.#nextCallbackId++;
    let cleanup: Cancel | undefined | void;

    const wrappedCallback = (
      value: T | undefined,
      cfcLabel: CfcLabelView | undefined,
    ) => {
      if (typeof cleanup === "function") {
        try {
          cleanup();
        } catch (error) {
          console.error("[CellHandle] Cleanup error:", error);
        }
      }
      cleanup = undefined;
      try {
        cleanup = callback(value, cfcLabel);
      } catch (error) {
        console.error("[CellHandle] Callback error:", error);
      }
    };

    this.#callbacks.set(callbackId, wrappedCallback);
    if (upgradeToCfcLabel) {
      // Tear down the label-less backend sub, then re-open it label-aware.
      void this.#conn.unsubscribe(this).finally(() => {
        this.#conn.subscribe(this);
      });
    } else {
      this.#conn.subscribe(this);
    }

    // Always call callback immediately with current value
    // This matches Cell behavior - callback is always called, even if value is undefined
    wrappedCallback(this.#value, this.#cfcLabel);

    return () => {
      if (typeof cleanup === "function") {
        try {
          cleanup();
        } catch (error) {
          console.error("[CellHandle] Cleanup error:", error);
        }
      }
      this.#callbacks.delete(callbackId);
      if (this.#callbacks.size === 0) {
        this.#conn.unsubscribe(this);
      }
    };
  }

  /**
   * Fetch the current value from the worker.
   * If the value is itself a link, follows it to get the actual value.
   */
  async sync(): Promise<Readonly<T> | undefined> {
    const writeGeneration = this.#writeGeneration;
    const updateGeneration = this.#updateGeneration;
    const { value, authoritative } = await this.#enqueueOperation(
      async (queue) => {
        const authoritativeGeneration = queue.authoritativeGeneration;
        const response = await this.#conn.request<RequestType.CellGet>({
          type: RequestType.CellGet,
          cell: this.ref(),
        });
        const value = CellHandle.deserialize<T>(this, response.value) as T;
        const authoritative = updateGeneration === this.#updateGeneration &&
          authoritativeGeneration === queue.authoritativeGeneration;
        if (authoritative) {
          queue.value = value;
          queue.hasValue = true;
        }
        return { value, authoritative };
      },
    );

    if (
      writeGeneration === this.#writeGeneration &&
      updateGeneration === this.#updateGeneration &&
      authoritative
    ) {
      this.#value = value;
    }
    return value;
  }

  /** Demand lazy producers and their durable commits before fetching a value. */
  async pull(): Promise<Readonly<T> | undefined> {
    const writeGeneration = this.#writeGeneration;
    const updateGeneration = this.#updateGeneration;
    const { value, authoritative } = await this.#enqueueOperation(
      async (queue) => {
        const authoritativeGeneration = queue.authoritativeGeneration;
        const response = await this.#conn.request<RequestType.CellPull>({
          type: RequestType.CellPull,
          cell: this.ref(),
        });
        const value = CellHandle.deserialize<T>(this, response.value) as T;
        const authoritative = updateGeneration === this.#updateGeneration &&
          authoritativeGeneration === queue.authoritativeGeneration;
        if (authoritative) {
          queue.value = value;
          queue.hasValue = true;
        }
        return { value, authoritative };
      },
    );

    if (
      writeGeneration === this.#writeGeneration &&
      updateGeneration === this.#updateGeneration &&
      authoritative
    ) {
      this.#value = value;
    }
    return value;
  }

  /**
   * Resolve links in this cell to get the actual cell it points to.
   * Returns a new CellHandle pointing to the resolved cell.
   */
  async resolveAsCell(): Promise<CellHandle<T>> {
    const response = await this.#enqueueOperation(() =>
      this.#conn.request<RequestType.CellResolveAsCell>({
        type: RequestType.CellResolveAsCell,
        cell: this.ref(),
      })
    );

    return new CellHandle<T>(this.#rt, response.cell);
  }

  async getCfcLabel(): Promise<CfcLabelView | undefined> {
    const response = await this.#enqueueOperation(() =>
      this.#conn.request<RequestType.CellGetCfcLabel>({
        type: RequestType.CellGetCfcLabel,
        cell: this.ref(),
      })
    );
    return response.cfcLabel;
  }

  /** Run a read-only query when this handle refers to a SQLite database. */
  async querySqlite<Row = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<ClientCellValue> | Record<string, ClientCellValue>,
  ): Promise<Row[]> {
    const serializedParams = params === undefined
      ? undefined
      : CellHandle.#serializeSqliteParams(params);
    const response = await this.#enqueueOperation(() =>
      this.#conn.request<RequestType.SqliteQuery>({
        type: RequestType.SqliteQuery,
        cell: this.ref(),
        sql,
        ...(serializedParams !== undefined && {
          params: serializedParams,
        }),
      })
    );
    return response.rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          CellHandle.deserialize(this, value),
        ]),
      ) as Row
    );
  }

  /** Commit a SQL write when this handle refers to a SQLite database. */
  async execSqlite(
    sql: string,
    params?: ReadonlyArray<ClientCellValue> | Record<string, ClientCellValue>,
  ): Promise<void> {
    const serializedParams = params === undefined
      ? undefined
      : CellHandle.#serializeSqliteParams(params);
    await this.#enqueueOperation(() =>
      this.#conn.request<RequestType.SqliteExec>({
        type: RequestType.SqliteExec,
        cell: this.ref(),
        sql,
        ...(serializedParams !== undefined && {
          params: serializedParams,
        }),
      })
    );
  }

  equals(other: unknown): boolean {
    if (this === other) return true;
    if (!isCellHandle(other)) return false;
    return cellRefsEqual(this.ref(), other.ref());
  }

  /**
   * Create a new CellHandle with a different schema.
   */
  asSchema<U = unknown>(schema: JSONSchema): CellHandle<U> {
    const { schema: _schema, ...rest } = this.#ref;
    const newCell = new CellHandle(this.#rt, {
      ...rest,
      schema,
    });
    newCell.#value = this.#value;
    return newCell as CellHandle<U>;
  }

  #extendPath(key: string): CellRef {
    return {
      id: this.#ref.id,
      space: this.#ref.space,
      scope: this.#ref.scope,
      path: [...this.#ref.path, key],
      // Child schema is unknown, so we don't include it
      ...(this.#ref.cfcLabelView !== undefined && {
        cfcLabelView: rebaseCfcLabelView(this.#ref.cfcLabelView, [key]),
      }),
    };
  }

  /**
   * Returns the sigil link naming this cell.
   *
   * The link is what stands in for a cell wherever a cell itself has no
   * representation, and this is how a caller that has already recognized the
   * value as a handle asks for it -- by name, rather than by reaching for a
   * serialization protocol that happens to yield one. `Cell` is arranged the
   * same way, its `toSigilLinkOrNull()` answering the callers that have
   * recognized a cell and its `toJSON()` answering the protocol.
   *
   * The ref-carried `cfcLabelView` is deliberately not included, as
   * `toWireString()` omits it: what this produces re-enters the worker without
   * passing `getCell()` or `cellRefToSigilLink()`, and a main-thread display
   * copy must not go back in as label state.
   */
  toSigilLink(): SigilLink {
    return linkRefFrom<CfcCellLinkRefPayload>({
      id: this.#ref.id,
      space: this.#ref.space,
      scope: this.#ref.scope,
      path: this.#ref.path,
      ...(this.#ref.schema !== undefined && { schema: this.#ref.schema }),
      ...(this.#ref.overwrite !== undefined &&
        { overwrite: this.#ref.overwrite }),
    });
  }

  /**
   * Returns the same link under the JSON protocol's name, so a handle reads as
   * the cell it names wherever a renderer honors that protocol -- which is what
   * carries one through `JSON.stringify()`. A caller that has recognized the
   * handle asks {@link toSigilLink} instead.
   */
  toJSON(): SigilLink {
    return this.toSigilLink();
  }

  /**
   * Encodes this cell's link to a wire string (the `fcl1:` cell-link form) for
   * transport across a string boundary (e.g. an HTTP body) from which it will
   * be decoded back to a link. Only the plain addressing fields cross the wire;
   * `schema` and the cfc label view are deliberately omitted (see
   * {@link linkRefPayloadToString}).
   */
  toWireString(): string {
    return linkRefPayloadToString({
      id: this.#ref.id,
      space: this.#ref.space,
      ...(this.#ref.scope !== undefined && { scope: this.#ref.scope }),
      path: this.#ref.path,
      ...(this.#ref.overwrite !== undefined &&
        { overwrite: this.#ref.overwrite }),
    });
  }

  /**
   * Handles an update of the cell from the backend, whose raw value may
   * contain `CellRef`s.
   */
  [$onCellUpdate](
    value: unknown,
    labelUpdate?: { cfcLabel: CfcLabelView | undefined },
  ): void {
    this.#updateGeneration++;
    const applied = applyValue(
      value,
      this.#value,
      this as CellHandle<unknown>,
    ) as T;
    const queue = operationQueues.get(this.#rt)?.get(
      cellRefToIdentityKey(this.#ref),
    );
    if (queue) {
      queue.authoritativeGeneration++;
      queue.value = applied;
      queue.hasValue = true;
    }
    const valueChanged = !valuesOrCellsEqual(applied, this.#value);
    // A label-only change (value identical) still fires label-aware subscribers.
    // `labelUpdate` is present only on notifications that carried a label, so a
    // value-only notification never spuriously churns the label.
    const labelChanged = labelUpdate !== undefined && this.#wantsCfcLabel &&
      !cfcLabelViewsEqual(labelUpdate.cfcLabel, this.#cfcLabel);
    if (!valueChanged && !labelChanged) {
      return;
    }

    if (valueChanged) this.#value = applied;
    if (labelUpdate !== undefined) this.#cfcLabel = labelUpdate.cfcLabel;
    for (const callback of this.#callbacks.values()) {
      callback(this.#value as Readonly<T>, this.#cfcLabel);
    }
  }

  /**
   * Recursively hydrate any object, converting any sigil links into
   * CellHandle instances. `$alias` records are plain data — they are only
   * meaningful as bindings inside Pattern objects, which the client never
   * interprets. A `FabricPrimitive` comes back as itself.
   *
   * @throws If the value holds a `FabricInstance`, which is a container this
   *   walk cannot descend and so cannot hydrate a link inside.
   */
  static deserialize<T>(
    base: CellHandle<T>,
    value: unknown,
  ): unknown {
    if (
      !value && typeof value === "string" || typeof value === "boolean" ||
      typeof value === "number"
    ) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => CellHandle.deserialize(base, item));
    }

    // A `FabricPrimitive` is a leaf, so a walk that stops at it has already
    // done the right thing -- and this goes _before_ the record branch, which
    // rebuilds from enumerable own properties a fabric class does not have and
    // would put `{}` here in place of the value.
    if (value instanceof FabricPrimitive) return value;

    // An instance is a container, reached by its codec contents rather than by
    // property name, so a sigil link can sit inside one where this walk cannot
    // see it -- and a value handed back unhydrated would carry that link where
    // a `CellHandle` belongs.
    //
    // Nothing reaches this today, de facto rather than by construction. The
    // transport does not stop an instance: the envelope's encoding carries one
    // across with its class. What keeps it unreachable is the refusal at each
    // of the other ends of the crossing -- `convertCellsToLinks()` on the way
    // out of the worker, and `serialize()` below on the way in.
    if (value instanceof FabricInstance) {
      refuseFabricInstance(value, "when hydrating a value off the connection");
    }

    if (isObjectOrArray(value)) {
      const reference = parseAsCellRef(
        value as JSONValue | undefined,
        base.ref(),
      );
      if (reference) {
        return new CellHandle(base.#rt, reference);
      }

      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = CellHandle.deserialize(base, val);
      }
      return result;
    }

    return value;
  }

  static #serializeSqliteParams(
    params: ReadonlyArray<ClientCellValue> | Record<string, ClientCellValue>,
  ): SqliteParams {
    const serialize = (value: ClientCellValue) =>
      CellHandle.#sqliteFabricValue(value);
    return Array.isArray(params)
      ? { kind: "positional", values: params.map(serialize) }
      : {
        kind: "named",
        entries: Object.entries(params).map(([key, value]) => [
          key,
          serialize(value),
        ]),
      };
  }

  static #sqliteFabricValue(value: ClientCellValue): FabricValue {
    if (isCellHandle(value)) return value.ref();
    if (value instanceof FabricBytes) return value;
    if (isFabricSpecialObject(value)) {
      throw new TypeError(
        `SQLite bind values support \`FabricBytes\` but not ` +
          `\`${value.constructor.name}\`.`,
      );
    }
    if (Array.isArray(value)) {
      return value.map((member) => CellHandle.#sqliteFabricValue(member));
    }
    if (isObjectOrArray(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, member]) => [
          key,
          CellHandle.#sqliteFabricValue(member),
        ]),
      );
    }
    return value as FabricValue;
  }

  /**
   * Converts a value the client holds into the one the connection carries,
   * which is the same data with a `CellRef` wherever a `CellHandle` sat.
   *
   * A `FabricPrimitive` crosses as itself, the envelope's encoding carrying it
   * with its class, as it carries a `bigint` and a `symbol`.
   *
   * `CellHandle.deserialize()` is the inverse.
   *
   * @throws If the value holds a `FabricInstance`, which is a container this
   *   walk cannot descend and so cannot convert a handle inside.
   */
  static serialize(value: ClientCellValue): FabricValue {
    return CellHandle.#serialize(value, "ref") as FabricValue;
  }

  /**
   * Serializes `value` for the wire, converting each `CellHandle` to a link
   * in `linkFormat`: a `CellRef` (`ref`) or a hydratable sigil link (`sigil`).
   * An ordinary record that happens to resemble a `CellRef` is walked as data,
   * and a live `CellHandle` is never replaced in place.
   */
  static #serialize(
    value: ClientCellValue,
    linkFormat: "ref" | "sigil" = "ref",
  ): unknown {
    if (isCellHandle(value)) {
      return linkFormat === "sigil"
        ? linkRefFrom<CfcCellLinkRefPayload>(value.ref())
        : value.ref();
    }

    if (Array.isArray(value)) {
      return value.map((element) => CellHandle.#serialize(element, linkFormat));
    }

    // A `FabricPrimitive` crosses whole rather than being walked: it is a
    // leaf, so stopping at it loses nothing. This goes _before_ the record
    // test, since such a value is also a record and that branch would rebuild
    // it from enumerable own properties it is not supposed to have, putting
    // `{}` on the wire in place of a `FabricBytes`.
    if (value instanceof FabricPrimitive) return value;

    // An instance is a container whose contents this walk cannot reach, so a
    // `CellHandle` inside one would cross unconverted -- as a handle, which
    // the wire has no representation for. Refused here rather than downstream:
    // the worker's `mapCellRefsToSigilLinks()` refuses one as well, and a
    // refusal there arrives as an error reply, after this handle has already
    // cached the value and told its subscribers. Refused through the shared
    // helper, as `deserialize()` above already does, so the two walks say the
    // same thing about the same value.
    if (value instanceof FabricInstance) {
      refuseFabricInstance(value, "when sending a value over this connection");
    }

    if (isObjectOrArray(value)) {
      return Object.fromEntries(
        Object.entries(value).map((
          [key, member],
        ) => [key, CellHandle.#serialize(member, linkFormat)]),
      );
    }

    // Every remaining arm is a primitive the encoding carries as itself.
    // `CellHandle<T>` does not constrain `T`, so a caller can arrive here with
    // something `ClientCellValue` does not admit at all; that is the encode's
    // to answer, per the input contract, and not worth a check on the way to
    // it that every correct value would also pay.
    //
    // Cast because `Array.isArray()` does not narrow a `readonly` array out of
    // the union, though it does catch one at run time -- so the arm TypeScript
    // still sees here cannot actually reach it.
    return value as FabricValue;
  }
}

export function isCellHandle<T = unknown>(
  value: unknown,
): value is CellHandle<T> {
  return value instanceof CellHandle;
}

/**
 * Applies `current` to `previous`, returning the result.
 * Notably, this preserves `CellHandle` instances when encountering
 * a `CellRef` referencing the same `CellHandle`.
 */
function applyValue<T>(
  current: unknown,
  previous: unknown,
  base: CellHandle<T>,
): unknown {
  const cellRef = parseAsCellRef(current as JSONValue, base.ref());

  if (cellRef) {
    if (isCellHandle(previous) && cellRefsEqual(cellRef, previous.ref())) {
      return previous;
    }
    return new CellHandle(base.runtime(), cellRef);
  }

  // Currently, `current` will not contain `CellHandle`s,
  // but for completeness.
  if (isCellHandle(current)) {
    if (isCellHandle(previous) && current.equals(previous)) {
      return previous;
    }
    return current;
  }

  // For arrays, recursively apply to each element
  if (Array.isArray(current)) {
    const prevArray = Array.isArray(previous) ? previous : [];
    return current.map((item, index) =>
      applyValue(item, prevArray[index], base)
    );
  }

  // A leaf, carried through whole as `deserialize()` hydrates one: the record
  // branch below would rebuild it from enumerable own properties it does not
  // have.
  if (current instanceof FabricPrimitive) {
    return current;
  }

  // A container this walk cannot descend, so it cannot preserve a handle
  // inside one against the incoming value the way it does for a record.
  // Unreachable for the same reason as in `deserialize()`.
  if (current instanceof FabricInstance) {
    refuseFabricInstance(current, "when applying a delivered value");
  }

  // For plain objects, recursively apply to each property
  if (isObjectOrArray(current)) {
    const prevRecord = (isObjectNotArray(previous))
      ? previous as Record<string, unknown>
      : {};
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(current)) {
      result[key] = applyValue(val, prevRecord[key], base);
    }
    return result;
  }

  // For primitives, just return current
  return current;
}

function cellRefsEqual(a: CellRef, b: CellRef): boolean {
  if (a.id !== b.id) return false;
  if (a.space !== b.space) return false;
  if ((a.scope ?? "space") !== (b.scope ?? "space")) return false;
  if (a.path.length !== b.path.length) return false;
  for (let i = 0; i < a.path.length; i++) {
    if (a.path[i] !== b.path[i]) return false;
  }
  if (!cfcLabelViewsEqual(a.cfcLabelView, b.cfcLabelView)) return false;
  return true;
}

/**
 * Compares two values a cell can hold, deciding whether a delivered update is
 * a change this handle's subscribers hear about.
 *
 * Distinct from `valueEqual()`, which it calls: that settles a `FabricValue`
 * by content, and this also knows about cells. A `CellHandle` compares by the
 * cell it names rather than by what that cell holds, so two handles on one
 * cell are equal and a handle is equal to nothing else.
 */
function valuesOrCellsEqual(a: unknown, b: unknown): boolean {
  // `Object.is`, not `===`: an unchanged `NaN` leaf must compare equal (else
  // every delivery of a NaN-bearing value re-notifies all subscribers), and a
  // `0` -> `-0` change must compare unequal (else the update is dropped).
  if (Object.is(a, b)) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  // Either side being a handle is enough to ask. A handle holds its state
  // privately, so the record branch below would read `{}` off it and call it
  // equal to anything else without enumerable own keys -- `{}` itself among
  // them, so replacing a handle with a record would be judged a no-change and
  // reach no subscriber. A handle is a reference to a cell and equals only
  // another reference to the same cell.
  if (isCellHandle(a) || isCellHandle(b)) {
    return isCellHandle(a) && isCellHandle(b) && a.equals(b);
  }

  // A `FabricPrimitive` is compared by the data model rather than by this
  // walk, and _before_ the record branch, for the same reason: two
  // `FabricBytes` over different bytes both present as `{}` there and would
  // compare equal. A primitive is a leaf, so comparing its content is the
  // whole comparison.
  //
  // There is no arm for a `FabricInstance`. `applyValue()` is this function's
  // only caller and refuses one before it returns, so neither argument can
  // hold one -- an arm here would be unreachable rather than defensive, and
  // untestable with it.
  if (a instanceof FabricPrimitive || b instanceof FabricPrimitive) {
    return valueEqual(a as FabricValue, b as FabricValue);
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valuesOrCellsEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;

  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (!(key in (b as object))) return false;
    if (
      !valuesOrCellsEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    ) {
      return false;
    }
  }

  return true;
}

function parseAsCellRef(
  value: JSONValue | undefined,
  from: CellRef,
): CellRef | undefined {
  if (isSigilLink(value)) {
    const linkData = linkRefPayload(value);

    return {
      id: linkData.id ?? from.id,
      space: linkData.space ?? from.space,
      scope: linkData.scope === "space" || linkData.scope === "user" ||
          linkData.scope === "session"
        ? linkData.scope
        : from.scope,
      path: (linkData.path ?? []).map((p) => p.toString()),
      ...(linkData.schema !== undefined && { schema: linkData.schema }),
      ...((linkData as { cfcLabelView?: CfcLabelView }).cfcLabelView !==
          undefined && {
        cfcLabelView: (linkData as { cfcLabelView?: CfcLabelView })
          .cfcLabelView,
      }),
    };
  }
}

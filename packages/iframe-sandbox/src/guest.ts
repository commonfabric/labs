/**
 * Connects sandboxed guest code to the capabilities granted by its host.
 * Calls may begin before port handoff and settle once the host is ready.
 */

import {
  cloneIfNecessary,
  type FabricValue,
  valueEqual,
} from "@commonfabric/data-model";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { isObjectOrArray } from "@commonfabric/utils/types";

import {
  BRIDGE_PROTOCOL,
  BRIDGE_READ_REFUSED,
  BRIDGE_VERSION,
  type BridgeCellIdentity,
  type BridgeCellPath,
  type BridgeError,
  type BridgeHostMessage,
  type BridgeManifest,
  type BridgeOperation,
  type BridgeRequest,
  type BridgeResolvedCell,
  flushNonce,
  GUEST_PORT_HANDOFF,
  GUEST_PORT_ORDERED,
  type GuestError,
  type GuestFlush,
  type GuestPortRequest,
  isBridgeHostMessage,
} from "./ipc.ts";

/** Structured failure returned by a bridge operation. */
export class FabricBridgeError extends Error {
  readonly code: string;
  readonly resource?: string;

  constructor(error: BridgeError) {
    super(error.message);
    this.name = "FabricBridgeError";
    this.code = error.code;
    this.resource = error.resource;
  }
}

/** Current state of a remote resource watched by guest code. */
export type ResourceSnapshot<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; error: FabricBridgeError };

type SnapshotListener<T> = (snapshot: ResourceSnapshot<T>) => void;
type CellSink<T> = (value: Readonly<T> | undefined) => void | (() => void);

/**
 * Hears an error that stands in place of a sink's value, such as a refusal of
 * the read (`read-refused`).
 */
type CellSinkError = (error: FabricBridgeError) => void;

/**
 * One sink: the cleanup its listener returned for the last value, and what
 * hears an error in the value's place.
 */
type SinkEntry = {
  cleanup: (() => void) | void;
  readonly onError: CellSinkError | undefined;
};
type EncodedBridgeRequest = ReturnType<typeof realmFromFabricValue>;

type QueuedBridgeRequest = {
  id: number;
  encoded: EncodedBridgeRequest;
};

type CellOperationQueue = {
  tail?: Promise<void>;
};

export type RemoteCellTarget = {
  resource: string;
  handle?: never;
  path: BridgeCellPath;
} | {
  resource?: never;
  handle: string;
  path: BridgeCellPath;
};

function targetFields(target: RemoteCellTarget): Pick<
  BridgeRequest,
  "resource" | "handle" | "path"
> {
  return "handle" in target
    ? { handle: target.handle, path: target.path }
    : { resource: target.resource, path: target.path };
}

/** Cell-shaped guest handle rooted in an explicitly granted capability. */
export class RemoteCell<T = FabricValue> {
  readonly #client: FabricClient;
  readonly #target: RemoteCellTarget;
  readonly #snapshotListeners = new Set<SnapshotListener<T>>();
  readonly #sinks = new Map<CellSink<T>, SinkEntry>();
  readonly #identity: BridgeCellIdentity | undefined;
  readonly #operationQueue: CellOperationQueue;
  #snapshot: ResourceSnapshot<T> = { status: "loading" };
  /**
   * The refusal of the cell's read, while it stands in place of the value:
   * what a read (a pull, an initialization, or the remote sink) answered
   * with `read-refused`, until a value ends it.
   */
  #refusal: FabricBridgeError | undefined;
  #unsubscribeRemote: (() => void) | undefined;
  #eventGeneration = 0;
  #resolved: Promise<RemoteCell<T>> | undefined;

  constructor(
    client: FabricClient,
    target: string | RemoteCellTarget,
    options: { identity?: BridgeCellIdentity; value?: T } = {},
    operationQueue: CellOperationQueue = {},
  ) {
    this.#client = client;
    this.#target = typeof target === "string"
      ? { resource: target, path: [] }
      : target;
    this.#identity = options.identity;
    this.#operationQueue = operationQueue;
    if (Object.hasOwn(options, "value")) {
      this.#snapshot = { status: "ready", value: options.value as T };
    }
  }

  /** Stable identity metadata, present after resolve(). */
  get identity(): BridgeCellIdentity | undefined {
    return this.#identity;
  }

  /** Samples the current guest-side value without waiting for host work. */
  get(): Readonly<T> | undefined {
    return this.#snapshot.status === "ready" ? this.#snapshot.value : undefined;
  }

  getSnapshot = (): ResourceSnapshot<T> => this.#snapshot;

  /** Internal status subscription used by framework adapters. */
  subscribeSnapshot = (listener: SnapshotListener<T>): () => void => {
    this.#snapshotListeners.add(listener);
    listener(this.#snapshot);
    this.#ensureRemoteSink();
    return () => {
      this.#snapshotListeners.delete(listener);
      this.#closeRemoteSinkIfUnused();
    };
  };

  /**
   * Calls `listener` synchronously with get(), then again whenever the value
   * changes. A refusal of the read (`read-refused`) stands in place of the
   * value and is never handed to `listener` as one: the cleanup it returned
   * for the last value runs, and `onError` hears the refusal. A sink added
   * while a refusal stands hears it at once, through `onError` alone. A
   * failed write changes no value, so it reaches no sink. The returned
   * function tears down this sink.
   */
  sink(listener: CellSink<T>, onError?: CellSinkError): () => void {
    const entry: SinkEntry = { cleanup: undefined, onError };
    this.#sinks.set(listener, entry);
    if (this.#refusal === undefined) {
      entry.cleanup = listener(this.get());
    } else {
      this.#tellError(entry, this.#refusal);
    }
    this.#ensureRemoteSink();
    return () => {
      this.#runSinkCleanup(entry);
      this.#sinks.delete(listener);
      this.#closeRemoteSinkIfUnused();
    };
  }

  /** Waits for the host Cell.pull() barrier and returns its current value. */
  pull(): Promise<T> {
    return this.#enqueueOperation(() => this.#pull());
  }

  async #pull(): Promise<T> {
    const before = this.#snapshot;
    const eventGeneration = this.#eventGeneration;
    try {
      const value = await this.#client.request("pull", {
        ...targetFields(this.#target),
      }) as T;
      if (
        eventGeneration === this.#eventGeneration &&
        this.#snapshot === before
      ) {
        this.#setReady(value);
      }
      return value;
    } catch (error) {
      if (
        eventGeneration === this.#eventGeneration &&
        this.#snapshot === before
      ) {
        this.#setError(error, "read");
      }
      throw error;
    }
  }

  /** Replaces the cell's value. */
  set(value: T): Promise<void> {
    let snapshot: T;
    try {
      snapshot = cloneIfNecessary(value as FabricValue, {
        frozen: false,
      }) as T;
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#enqueueOperation(() => this.#set(snapshot));
  }

  /** Atomically stores a default while the cell has no backing value. */
  initialize(value: T): Promise<T> {
    if (value === undefined) {
      return Promise.reject(
        new TypeError("Cell initialize requires a defined value."),
      );
    }
    let snapshot: T;
    try {
      snapshot = cloneIfNecessary(value as FabricValue, {
        frozen: false,
      }) as T;
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#enqueueOperation(() => this.#initialize(snapshot));
  }

  update(updater: (current: T) => T): Promise<void> {
    return this.#enqueueOperation(async () => {
      const snapshot = this.#snapshot;
      const current = snapshot.status === "ready"
        ? snapshot.value
        : await this.#pull();
      await this.#set(updater(current));
    });
  }

  /** Appends members with the runtime's mergeable array operation. */
  push<U>(this: RemoteCell<U[]>, ...values: U[]): Promise<void> {
    return this.pushAll(values);
  }

  /**
   * Like `push()`, except that it takes the members to append as one list, so
   * the list can be of any length.
   */
  pushAll<U>(this: RemoteCell<U[]>, values: readonly U[]): Promise<void> {
    if (!Array.isArray(values)) {
      return Promise.reject(
        new TypeError("`pushAll()` requires an array of members."),
      );
    }
    let snapshots: U[];
    try {
      snapshots = cloneIfNecessary(values as FabricValue, {
        frozen: false,
      }) as U[];
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#enqueueOperation(async () => {
      const eventGeneration = this.#eventGeneration;
      const before = this.#snapshot;
      await this.#client.request("push", {
        ...targetFields(this.#target),
        values: snapshots as FabricValue[],
      });
      if (
        eventGeneration === this.#eventGeneration &&
        this.#snapshot === before && before.status === "ready" &&
        Array.isArray(before.value)
      ) {
        this.#setReady([...before.value, ...snapshots] as U[]);
      }
    });
  }

  /** Derives a path-scoped handle without a round trip. */
  key<K extends Extract<keyof T, string | number>>(key: K): RemoteCell<T[K]>;
  key(...keys: Array<string | number>): RemoteCell<unknown>;
  key(...keys: Array<string | number>): RemoteCell<any> {
    let value: unknown = this.get();
    let hasValue = this.#snapshot.status === "ready";
    for (const key of keys) {
      if (!isObjectOrArray(value)) {
        hasValue = false;
        break;
      }
      value = (value as Record<string, unknown>)[String(key)];
    }
    return this.#client.cellTarget(
      {
        ...this.#target,
        path: [...this.#target.path, ...keys],
      },
      hasValue ? { value } : {},
    );
  }

  /** Resolves links and returns a stable, host-minted cell capability. */
  resolve(): Promise<RemoteCell<T>> {
    this.#resolved ??= this.#enqueueOperation(async () => {
      const result = await this.#client.request("resolve", {
        ...targetFields(this.#target),
      }) as BridgeResolvedCell;
      return this.#client.resolvedCell<T>(result);
    });
    return this.#resolved;
  }

  #enqueueOperation<U>(operation: () => Promise<U>): Promise<U> {
    const running = this.#operationQueue.tail
      ? this.#operationQueue.tail.then(operation)
      : operation();
    const tail = running.then(() => {}, () => {});
    this.#operationQueue.tail = tail;
    void tail.then(() => {
      if (this.#operationQueue.tail === tail) {
        this.#operationQueue.tail = undefined;
      }
    });
    return running;
  }

  async #set(value: T): Promise<void> {
    const before = this.#snapshot;
    const eventGeneration = this.#eventGeneration;
    const snapshot = cloneIfNecessary(value as FabricValue, {
      frozen: false,
    }) as T;
    try {
      await this.#client.request("set", {
        ...targetFields(this.#target),
        value: snapshot as FabricValue,
      });
      if (
        eventGeneration === this.#eventGeneration &&
        this.#snapshot === before
      ) {
        this.#setReady(snapshot);
      }
    } catch (error) {
      if (
        eventGeneration === this.#eventGeneration &&
        this.#snapshot === before
      ) {
        this.#setError(error, "write");
      }
      throw error;
    }
  }

  async #initialize(value: T): Promise<T> {
    const before = this.#snapshot;
    const eventGeneration = this.#eventGeneration;
    try {
      const current = await this.#client.request("initialize", {
        ...targetFields(this.#target),
        value: value as FabricValue,
      }) as T;
      if (
        eventGeneration === this.#eventGeneration &&
        this.#snapshot === before
      ) {
        this.#setReady(current);
      }
      return current;
    } catch (error) {
      if (
        eventGeneration === this.#eventGeneration &&
        this.#snapshot === before
      ) {
        // An initialization answers with the stored value, so its refusal is
        // a refusal of that read.
        this.#setError(error, "read");
      }
      throw error;
    }
  }

  #setReady(value: T): void {
    const previous = this.get();
    const wasError = this.#snapshot.status === "error";
    this.#refusal = undefined;
    if (
      this.#snapshot.status === "ready" &&
      valueEqual(
        this.#snapshot.value as FabricValue,
        value as FabricValue,
      )
    ) {
      return;
    }
    this.#snapshot = { status: "ready", value };
    for (const listener of this.#snapshotListeners) listener(this.#snapshot);
    // A value that ends an error is news to the sinks that heard the error,
    // even one that holds nothing.
    if (wasError || previous !== undefined || value !== undefined) {
      for (const [listener, entry] of this.#sinks) {
        this.#runSinkCleanup(entry);
        entry.cleanup = listener(value);
      }
    }
  }

  /**
   * Records `error`, the failure of a `read` (a pull, an initialization, or
   * the remote sink) or a `write`. A read's refusal (`read-refused`) stands
   * in place of the value, so the value each sink was handed is withdrawn:
   * its cleanup runs and its `onError` hears the refusal. Any other failure,
   * and every failed write, leaves the sinks with what they hold: a write
   * that failed changed nothing the host will deliver again, so a sink
   * withdrawn for it would stay blank.
   */
  #setError(error: unknown, operation: "read" | "write"): void {
    const bridgeError = error instanceof FabricBridgeError
      ? error
      : new FabricBridgeError({
        code: "operation-failed",
        message: error instanceof Error ? error.message : String(error),
        resource: "resource" in this.#target
          ? this.#target.resource
          : undefined,
      });
    this.#snapshot = { status: "error", error: bridgeError };
    for (const listener of this.#snapshotListeners) listener(this.#snapshot);
    if (operation !== "read" || bridgeError.code !== BRIDGE_READ_REFUSED) {
      return;
    }
    this.#refusal = bridgeError;
    for (const entry of this.#sinks.values()) {
      this.#runSinkCleanup(entry);
      this.#tellError(entry, bridgeError);
    }
  }

  /**
   * Tells `entry`'s `onError` of `error`. One that throws stops neither the
   * other sinks nor the operation that failed.
   */
  #tellError(entry: SinkEntry, error: FabricBridgeError): void {
    try {
      entry.onError?.(error);
    } catch {
      // As for a broken cleanup: a consumer's failure is its own.
    }
  }

  #ensureRemoteSink(): void {
    if (this.#unsubscribeRemote) return;
    this.#unsubscribeRemote = this.#client.sinkCell(
      this.#target,
      (value) => {
        this.#eventGeneration++;
        this.#setReady(value as T);
      },
      (error) => this.#setError(error, "read"),
    );
  }

  #closeRemoteSinkIfUnused(): void {
    if (this.#sinks.size > 0 || this.#snapshotListeners.size > 0) return;
    this.#unsubscribeRemote?.();
    this.#unsubscribeRemote = undefined;
  }

  #runSinkCleanup(entry: SinkEntry): void {
    const cleanup = entry.cleanup;
    entry.cleanup = undefined;
    try {
      cleanup?.();
    } catch {
      // A broken consumer cleanup must not retain or block the other sinks.
    }
  }
}

/** SQL text and bind values accepted by a remote SQLite resource. */
export type SqliteQueryInput = {
  sql: string;
  params?: ReadonlyArray<FabricValue> | Record<string, FabricValue>;
};

/** Key-safe wire form of SQLite rows transported through the realm codec. */
export type SqliteQueryWireResult = {
  rows: Array<Array<[string, FabricValue]>>;
};

function sqliteOperationInput(
  sql: string,
  params?: SqliteQueryInput["params"],
): FabricValue {
  if (params === undefined) return { sql };
  return Array.isArray(params)
    ? { sql, params }
    : { sql, namedParams: Object.entries(params) };
}

/** Guest-side query and mutation interface for one SQLite resource. */
export class RemoteSqlite {
  readonly #client: FabricClient;
  readonly #name: string;

  constructor(client: FabricClient, name: string) {
    this.#client = client;
    this.#name = name;
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    params?: SqliteQueryInput["params"],
  ): Promise<{ rows: Row[] }> {
    const result = await this.#client.call(
      this.#name,
      "query",
      sqliteOperationInput(sql, params),
    ) as SqliteQueryWireResult;
    return {
      rows: result.rows.map((entries) => Object.fromEntries(entries) as Row),
    };
  }

  async exec(
    sql: string,
    params?: SqliteQueryInput["params"],
  ): Promise<void> {
    await this.#client.call(
      this.#name,
      "exec",
      sqliteOperationInput(sql, params),
    );
  }

  /** Sinks database invalidations until the returned function is called. */
  sink(listener: () => void): () => void {
    return this.#client.sinkResource(this.#name, () => listener());
  }
}

type PendingRequest = {
  resolve: (value: FabricValue | undefined) => void;
  reject: (error: unknown) => void;
};

type Subscription = {
  update: (value: FabricValue | undefined) => void;
  error?: (error: unknown) => void;
};

/** Guest connection to the resources granted by the embedding host. */
export class FabricClient {
  #port: MessagePort | undefined;
  #ordered = false;
  #awaitingFlushAck: string | undefined;
  #nextRequestId = 0;
  #nextSubscriptionId = 0;
  #pending = new Map<number, PendingRequest>();
  #queued: QueuedBridgeRequest[] = [];
  #subscriptions = new Map<string, Subscription>();
  #cells = new Map<string, RemoteCell<unknown>>();
  #cellOperationQueues = new Map<string, CellOperationQueue>();
  #resolvedOperations = new Map<string, ReadonlySet<string>>();
  #manifest: Promise<BridgeManifest> | undefined;
  #disconnected = false;

  constructor() {
    globalThis.addEventListener("message", this.#onHandoff);
    // The host hands a port over once this document has loaded. Listening
    // from before then, this client hears it. Listening from after, it may
    // have missed it, so it asks for another; if the first is still on its
    // way, whichever arrives first is the one it keeps.
    if (globalThis.document?.readyState === "complete") {
      globalThis.parent?.postMessage(
        { type: "port-request" } satisfies GuestPortRequest,
        "*",
      );
    }
  }

  describe(): Promise<BridgeManifest> {
    return this.#manifest ??= this.#request("describe") as Promise<
      BridgeManifest
    >;
  }

  cell<T = FabricValue>(name: string): RemoteCell<T> {
    return this.cellTarget<T>({ resource: name, path: [] });
  }

  /** Returns the one shared guest handle for a capability target and path. */
  cellTarget<T = FabricValue>(
    target: RemoteCellTarget,
    options: { identity?: BridgeCellIdentity; value?: T } = {},
  ): RemoteCell<T> {
    const key = JSON.stringify([
      "handle" in target ? "handle" : "resource",
      "handle" in target ? target.handle : target.resource,
      target.path,
    ]);
    const rootKey = JSON.stringify([
      "handle" in target ? "handle" : "resource",
      "handle" in target ? target.handle : target.resource,
    ]);
    let cell = this.#cells.get(key) as RemoteCell<T> | undefined;
    if (!cell) {
      let queue = this.#cellOperationQueues.get(rootKey);
      if (!queue) {
        queue = {};
        this.#cellOperationQueues.set(rootKey, queue);
      }
      cell = new RemoteCell(this, target, options, queue);
      this.#cells.set(key, cell as RemoteCell<unknown>);
    }
    return cell as unknown as RemoteCell<T>;
  }

  /** Rehydrates a host-minted stable cell capability. */
  resolvedCell<T = FabricValue>(
    descriptor: BridgeResolvedCell,
  ): RemoteCell<T> {
    this.#resolvedOperations.set(
      descriptor.handle,
      new Set(descriptor.operations ?? []),
    );
    return this.cellTarget<T>(
      { handle: descriptor.handle, path: [] },
      {
        ...(descriptor.identity !== undefined && {
          identity: descriptor.identity,
        }),
        // A cell that has read nothing yet is loading, so the first read of
        // it, an `update()` among them, pulls.
        ...(descriptor.hasValue !== false && { value: descriptor.value as T }),
      },
    );
  }

  sqlite(name: string): RemoteSqlite {
    return new RemoteSqlite(this, name);
  }

  call(
    resource: string,
    method: string,
    value?: FabricValue,
  ): Promise<FabricValue | undefined> {
    return this.request("call", { resource, method, value });
  }

  request(
    operation: BridgeOperation,
    fields: Partial<
      Omit<
        BridgeRequest,
        "protocol" | "version" | "type" | "id" | "operation"
      >
    > = {},
  ): Promise<FabricValue | undefined> {
    if (operation === "initialize") {
      return this.#initialize(fields);
    }
    return this.#request(operation, fields);
  }

  async #initialize(
    fields: Partial<
      Omit<
        BridgeRequest,
        "protocol" | "version" | "type" | "id" | "operation"
      >
    >,
  ): Promise<FabricValue | undefined> {
    if (this.#disconnected) {
      return await this.#request("initialize", fields);
    }
    if (typeof fields.handle === "string") {
      if (!this.#resolvedOperations.get(fields.handle)?.has("initialize")) {
        throw new FabricBridgeError({
          code: "method-not-supported",
          message: "The resolved cell does not support initialize().",
        });
      }
      return await this.#request("initialize", fields);
    }
    if (typeof fields.resource !== "string") {
      throw new FabricBridgeError({
        code: "method-not-supported",
        message: "The cell capability cannot negotiate initialize().",
      });
    }
    const manifest = await this.describe();
    const descriptor = manifest.resources.find((entry) =>
      entry.name === fields.resource
    );
    if (!descriptor?.operations.includes("initialize")) {
      throw new FabricBridgeError({
        code: "method-not-supported",
        message: `Cell \`${fields.resource}\` does not support initialize().`,
        resource: fields.resource,
      });
    }
    return await this.#request("initialize", fields);
  }

  #request(
    operation: BridgeOperation,
    fields: Partial<
      Omit<
        BridgeRequest,
        "protocol" | "version" | "type" | "id" | "operation"
      >
    > = {},
  ): Promise<FabricValue | undefined> {
    if (this.#disconnected) {
      return Promise.reject(
        new FabricBridgeError({
          code: "disconnected",
          message: "The Fabric bridge is disconnected.",
        }),
      );
    }
    const id = this.#nextRequestId++;
    const request: BridgeRequest = {
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_VERSION,
      type: "request",
      id,
      operation,
      ...fields,
    };
    // A call queues while there is no port, and while the port waits on the
    // flush acknowledgement that puts it behind the guest's earlier
    // parent-chain posts.
    const queues = !this.#port || this.#awaitingFlushAck !== undefined;
    let encoded: EncodedBridgeRequest;
    try {
      encoded = realmFromFabricValue(request);
      // `postMessage()` snapshots at send time. A queued call is not sent yet,
      // so it snapshots the encoded form at invocation time instead of
      // retaining caller-owned objects by reference until it is.
      if (queues) encoded = structuredClone(encoded);
    } catch (cause) {
      return Promise.reject(cause);
    }
    const result = Promise.withResolvers<FabricValue | undefined>();
    result.promise.catch(() => {});
    this.#pending.set(id, result);
    if (queues) this.#queued.push({ id, encoded });
    else this.#sendPending(id, encoded);
    return result.promise;
  }

  sinkResource(
    resource: string,
    update: (value: FabricValue | undefined) => void,
    error?: (error: unknown) => void,
  ): () => void {
    const subscription = `subscription-${this.#nextSubscriptionId++}`;
    this.#subscriptions.set(subscription, { update, error });
    void this.request("sink", { resource, subscription }).catch(
      (cause) => {
        this.#subscriptions.delete(subscription);
        error?.(cause);
      },
    );
    return () => {
      this.#subscriptions.delete(subscription);
      void this.request("unsink", { resource, subscription }).catch(
        () => {},
      );
    };
  }

  /** Opens a value sink on a cell target. */
  sinkCell(
    target: RemoteCellTarget,
    update: (value: FabricValue | undefined) => void,
    error?: (error: unknown) => void,
  ): () => void {
    const subscription = `subscription-${this.#nextSubscriptionId++}`;
    this.#subscriptions.set(subscription, { update, error });
    void this.request("sink", {
      ...targetFields(target),
      subscription,
    }).catch((cause) => {
      this.#subscriptions.delete(subscription);
      error?.(cause);
    });
    return () => {
      this.#subscriptions.delete(subscription);
      void this.request("unsink", {
        ...targetFields(target),
        subscription,
      }).catch(() => {});
    };
  }

  disconnect(): void {
    if (this.#disconnected) return;
    this.#disconnected = true;
    globalThis.removeEventListener("message", this.#onHandoff);
    if (this.#port) {
      this.#send({
        protocol: BRIDGE_PROTOCOL,
        version: BRIDGE_VERSION,
        type: "request",
        id: this.#nextRequestId++,
        operation: "disconnect",
      });
    }
    this.#port?.close();
    this.#port = undefined;
    const error = new FabricBridgeError({
      code: "disconnected",
      message: "The Fabric bridge disconnected before the operation completed.",
    });
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#subscriptions.clear();
    this.#resolvedOperations.clear();
    this.#manifest = undefined;
    this.#cellOperationQueues.clear();
    this.#queued = [];
    this.#awaitingFlushAck = undefined;
  }

  #send(request: BridgeRequest): void {
    this.#port?.postMessage(realmFromFabricValue(request));
  }

  #sendPending(id: number, encoded: EncodedBridgeRequest): void {
    try {
      this.#port?.postMessage(encoded);
    } catch (cause) {
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      pending.reject(cause);
    }
  }

  #onHandoff = (event: MessageEvent): void => {
    // The host owns the outer frame and posts directly to this inner guest, so
    // it is two parent hops away. The guest has an opaque origin and cannot
    // origin-check that post, but it can still refuse a message sent by any
    // other window.
    const expectedHost = globalThis.parent?.parent;
    if (expectedHost && event.source !== expectedHost) return;
    if (event.data === GUEST_PORT_ORDERED) {
      this.#ordered = true;
      return;
    }
    if (this.#port || event.data !== GUEST_PORT_HANDOFF || !event.ports[0]) {
      return;
    }
    this.#port = event.ports[0];
    this.#port.onmessage = this.#onPortMessage;
    this.#port.start();
    const parent: Window | undefined = globalThis.parent;
    if (this.#ordered && parent) {
      // The marker rides the parent chain behind everything this guest posted
      // there before its port, and port traffic holds until the host answers
      // it -- which the host does only once the relay is handled up to the
      // marker. That puts every pre-port post ahead of every port request.
      this.#awaitingFlushAck = flushNonce();
      parent.postMessage(
        {
          type: "flush",
          nonce: this.#awaitingFlushAck,
        } satisfies GuestFlush,
        "*",
      );
    } else {
      this.#flushQueued();
    }
  };

  /** Sends every queued request, in the order the calls were made. */
  #flushQueued(): void {
    const queued = this.#queued;
    this.#queued = [];
    for (const request of queued) {
      this.#sendPending(request.id, request.encoded);
    }
  }

  #onPortMessage = (event: MessageEvent): void => {
    let decoded: FabricValue;
    try {
      decoded = fabricFromRealmValue(event.data);
    } catch {
      return;
    }
    if (!isBridgeHostMessage(decoded)) return;
    this.#accept(decoded);
  };

  #accept(message: BridgeHostMessage): void {
    if (message.type === "event") {
      const subscription = this.#subscriptions.get(message.subscription);
      // An error stands in place of a value, a refused read among them: it is
      // never delivered as one.
      if (message.error !== undefined) {
        subscription?.error?.(new FabricBridgeError(message.error));
      } else {
        subscription?.update(message.value);
      }
      return;
    }
    if (message.type === "flush") {
      // Only the acknowledgement echoing this guest's own nonce opens its
      // port traffic; one answering another document's marker does not.
      if (
        this.#awaitingFlushAck !== undefined &&
        message.nonce === this.#awaitingFlushAck
      ) {
        this.#awaitingFlushAck = undefined;
        this.#flushQueued();
      }
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new FabricBridgeError(message.error));
  }
}

/** Connects to the capability port supplied by the embedding iframe host. */
export function connectFabric(): FabricClient {
  return new FabricClient();
}

/** Raises an alarm without relying on the bridge port. */
export function reportGuestError(error: GuestError): void {
  globalThis.parent.postMessage({ type: "error", data: error }, "*");
}

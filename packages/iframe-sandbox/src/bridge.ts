/**
 * Hosts explicit, discoverable capabilities for one sandboxed iframe guest.
 * Only resources named by the embedding host are reachable through the port.
 */

import type { FabricValue } from "@commonfabric/data-model";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { isObjectNotArray } from "@commonfabric/utils/types";

import {
  BRIDGE_PROTOCOL,
  BRIDGE_READ_REFUSED,
  BRIDGE_VERSION,
  type BridgeCellIdentity,
  type BridgeError,
  type BridgeHostMessage,
  type BridgeManifest,
  type BridgeRequest,
  type BridgeResolvedCell,
  type BridgeResourceDescriptor,
  isBridgeRequest,
} from "./ipc.ts";

export { BRIDGE_READ_REFUSED };

/** Behavior advertised for one named bridge resource. */
export type BridgeResourceKind = "cell" | "stream" | "sqlite" | "service";

/** Cancels a live bridge subscription. */
export type BridgeCancel = () => void;

/** Implements one named operation on a bridge resource. */
export type BridgeMethod = (
  input: FabricValue | undefined,
) => FabricValue | undefined | Promise<FabricValue | undefined>;

/**
 * Thrown by a host's bridge cell for a read the host was refused, or a write
 * it will not make through a cell whose read was refused. The bridge answers
 * the guest with its code, `BRIDGE_READ_REFUSED`, and holds the path the guest
 * named to the refusal: a write through that path is refused until a read of
 * it is admitted, whatever cell answers for the path by then.
 */
export class BridgeReadRefusedError extends Error {
  readonly code = BRIDGE_READ_REFUSED;

  constructor(message: string) {
    super(message);
    this.name = "BridgeReadRefusedError";
  }
}

/** Hears a sink's failure, such as a refusal of the read it delivers. */
export type BridgeSinkFailure = (error: BridgeError) => void;

/** Cell-shaped capability exposed beneath one named bridge resource. */
export type BridgeCell = {
  get(): FabricValue | undefined;
  pull(): FabricValue | undefined | Promise<FabricValue | undefined>;
  initialize?(value: FabricValue): FabricValue | Promise<FabricValue>;
  set?(value: FabricValue): void | Promise<void>;
  push?(values: readonly FabricValue[]): void | Promise<void>;
  /**
   * Delivers each value of the cell to `listener`, and each refusal of its
   * read to `failed`, which the guest hears as an error of its subscription
   * rather than as a value.
   */
  sink?(
    listener: (value: FabricValue | undefined) => void,
    failed: BridgeSinkFailure,
  ): BridgeCancel;
  key?(key: string | number): BridgeCell;
  resolve?(): BridgeCell | Promise<BridgeCell>;
  identity?: BridgeCellIdentity;
  /**
   * Whether the cell holds what a read of it found (or what was written
   * through it), so that `get()` is its value. False for one that has read
   * nothing yet, whose `get()` is no value, and whose sink delivers nothing
   * until a read answers. Left out, the cell always holds its value.
   */
  hasValue?(): boolean;
};

type BridgeResourceMetadata = {
  schema?: FabricValue;
  description?: string;
};

/** Host implementation and discoverable metadata for one capability. */
export type BridgeResource = BridgeResourceMetadata & {
  kind: BridgeResourceKind;
  cell?: BridgeCell;
  sink?: (
    listener: (value: FabricValue | undefined) => void,
  ) => BridgeCancel;
  methods?: Record<string, BridgeMethod>;
};

/** Named capabilities granted to one iframe guest. */
export type FabricBridge = {
  resources: Readonly<Record<string, BridgeResource>>;
};

/** Builds an explicit iframe capability grant from named resources. */
export function createFabricBridge(
  resources: Record<string, BridgeResource>,
): FabricBridge {
  return { resources };
}

const CORE_OPERATIONS = new Set([
  "get",
  "initialize",
  "key",
  "pull",
  "push",
  "resolve",
  "set",
  "sink",
]);

function resourceKind(
  name: string,
  resource: BridgeResource,
): BridgeResourceKind {
  const kind = Object.getOwnPropertyDescriptor(resource, "kind");
  if (
    !kind || !("value" in kind) ||
    kind.value !== "cell" && kind.value !== "stream" &&
      kind.value !== "sqlite" && kind.value !== "service"
  ) {
    throw new TypeError(
      `Bridge resource \`${name}\` must declare its own valid kind.`,
    );
  }
  return kind.value;
}

function namedMethodNames(
  name: string,
  resource: BridgeResource,
): string[] {
  const container = Object.getOwnPropertyDescriptor(resource, "methods");
  if (!container) return [];
  if ("value" in container && container.value === undefined) return [];
  if (
    !("value" in container) || !isObjectNotArray(container.value)
  ) {
    throw new TypeError(
      `Bridge resource \`${name}\` methods must be an object.`,
    );
  }
  const methods = container.value as Record<string, unknown>;
  return Object.keys(methods).sort().map((method) => {
    if (CORE_OPERATIONS.has(method)) {
      throw new TypeError(
        `Bridge resource \`${name}\` method \`${method}\` collides with a core operation.`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(methods, method);
    if (!descriptor || typeof descriptor.value !== "function") {
      throw new TypeError(
        `Bridge resource \`${name}\` method \`${method}\` must be a function.`,
      );
    }
    return method;
  });
}

type BridgeCellOperation =
  | "get"
  | "initialize"
  | "key"
  | "pull"
  | "push"
  | "resolve"
  | "set"
  | "sink";

function resourceCell(name: string, resource: BridgeResource): BridgeCell {
  if (resourceKind(name, resource) !== "cell") {
    throw bridgeError(
      "method-not-supported",
      `Resource \`${name}\` is not a cell.`,
      name,
    );
  }
  const property = Object.getOwnPropertyDescriptor(resource, "cell");
  if (!property || !("value" in property)) {
    throw new TypeError(
      `Bridge resource \`${name}\` must declare its own cell capability.`,
    );
  }
  return validateCell(name, property.value);
}

function validateCell(name: string, value: unknown): BridgeCell {
  if (!isObjectNotArray(value)) {
    throw new TypeError(`Cell \`${name}\` must be an object.`);
  }
  const cell = value as BridgeCell;
  if (!cellOperation(cell, "get") || !cellOperation(cell, "pull")) {
    throw new TypeError(
      `Cell \`${name}\` must implement get() and pull().`,
    );
  }
  return cell;
}

function cellOperation<K extends BridgeCellOperation>(
  cell: BridgeCell,
  operation: K,
): BridgeCell[K] | undefined {
  const property = Object.getOwnPropertyDescriptor(cell, operation);
  return property && "value" in property && typeof property.value === "function"
    ? property.value as BridgeCell[K]
    : undefined;
}

/** Whether `cell` holds its value ({@link BridgeCell.hasValue}). */
function cellHasValue(cell: BridgeCell): boolean {
  const property = Object.getOwnPropertyDescriptor(cell, "hasValue");
  if (
    !property || !("value" in property) || typeof property.value !== "function"
  ) {
    return true;
  }
  return property.value.call(cell) === true;
}

function cellOperationNames(cell: BridgeCell): BridgeCellOperation[] {
  return [...CORE_OPERATIONS].filter((operation) =>
    cellOperation(cell, operation as BridgeCellOperation) !== undefined
  ) as BridgeCellOperation[];
}

function resourceSink(
  resource: BridgeResource,
):
  | ((listener: (value: FabricValue | undefined) => void) => BridgeCancel)
  | undefined {
  const property = Object.getOwnPropertyDescriptor(resource, "sink");
  return property && "value" in property && typeof property.value === "function"
    ? property.value as (
      listener: (value: FabricValue | undefined) => void,
    ) => BridgeCancel
    : undefined;
}

function namedMethod(
  resource: BridgeResource,
  method: string | undefined,
): BridgeMethod | undefined {
  if (method === undefined || CORE_OPERATIONS.has(method)) return undefined;
  const container = Object.getOwnPropertyDescriptor(resource, "methods");
  if (
    !container || !("value" in container) || !isObjectNotArray(container.value)
  ) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(container.value, method);
  return descriptor?.enumerable && typeof descriptor.value === "function"
    ? descriptor.value as BridgeMethod
    : undefined;
}

function descriptor(
  name: string,
  resource: BridgeResource,
): BridgeResourceDescriptor {
  const kind = resourceKind(name, resource);
  const operations: string[] = [];
  if (kind === "cell") {
    const cell = resourceCell(name, resource);
    for (const operation of cellOperationNames(cell)) {
      operations.push(operation);
    }
  } else if (resourceSink(resource)) {
    operations.push("sink");
  }
  const methods = namedMethodNames(name, resource);
  const schema = Object.getOwnPropertyDescriptor(resource, "schema");
  const description = Object.getOwnPropertyDescriptor(resource, "description");
  return {
    name,
    kind,
    operations,
    methods,
    ...(schema && "value" in schema && schema.value !== undefined && {
      schema: schema.value,
    }),
    ...(description && "value" in description &&
      description.value !== undefined && {
      description: description.value,
    }),
  };
}

function discoverResource(
  resources: FabricBridge["resources"],
  name: string,
): BridgeResource | undefined {
  const property = Object.getOwnPropertyDescriptor(resources, name);
  if (!property?.enumerable) return undefined;
  if (!("value" in property)) {
    throw new TypeError(
      `Bridge resource \`${name}\` must be an own data property.`,
    );
  }
  if (!isObjectNotArray(property.value)) {
    throw new TypeError(`Bridge resource \`${name}\` must be an object.`);
  }
  const resource = property.value as BridgeResource;
  resourceKind(name, resource);
  return resource;
}

/** A path as a guest names it: a resource, then each key beneath it. */
type GuestPath = readonly string[];

/** `path` as the key of the paths a host holds to a refusal. */
function pathKey(path: GuestPath): string {
  return JSON.stringify(path);
}

function bridgeError(
  code: string,
  message: string,
  resource?: string,
): BridgeError {
  return { code, message, ...(resource !== undefined && { resource }) };
}

function normalizeBridgeError(
  error: unknown,
  resource?: string,
): BridgeError {
  if (
    error && typeof error === "object" && "code" in error &&
    "message" in error && typeof error.code === "string" &&
    typeof error.message === "string"
  ) {
    const errorResource = "resource" in error &&
        typeof error.resource === "string"
      ? error.resource
      : resource;
    return bridgeError(error.code, error.message, errorResource);
  }
  return bridgeError(
    "operation-failed",
    error instanceof Error ? error.message : String(error),
    resource,
  );
}

/** Whether `error` is a refusal of a read (`read-refused`). */
function isReadRefusal(error: unknown): boolean {
  return normalizeBridgeError(error).code === BRIDGE_READ_REFUSED;
}

/** Owns one loaded guest's access to one explicitly supplied bridge. */
export class FabricBridgeHost {
  readonly #bridge: FabricBridge;
  readonly #port: MessagePort;
  readonly #subscriptions = new Map<string, BridgeCancel>();
  readonly #cells = new Map<
    string,
    {
      cell: BridgeCell;
      operations: ReadonlySet<BridgeCellOperation>;
      resource: string;
      /** The path the guest resolved to this cell. */
      path: GuestPath;
    }
  >();
  /**
   * The paths whose last read the guest was refused, each held to that
   * refusal for the guest's writes through it until a read of it is
   * admitted. Kept by the path the guest names, not by the cell answering
   * for it, which may change between requests (a context whose own read is
   * refused reaches a field through itself rather than through the link the
   * field holds), and by the path a resolved cell was resolved from, so a
   * guest reaches no refused path afresh by resolving it. A path enters only
   * when a read of it is refused and leaves when one is admitted, so this
   * holds no more than one entry for each refused path the guest has read.
   */
  readonly #refusedPaths = new Set<string>();
  #nextCellHandle = 0;
  #operationTail: Promise<void> | undefined;
  #connected = true;
  #firstRequestReported = false;

  readonly #onFirstRequest:
    | ((session: FabricBridgeHost) => void)
    | undefined;

  /**
   * Constructs an instance serving `bridge` over `port`. `onFirstRequest`,
   * when supplied, is called once, ahead of handling the first valid request
   * to arrive: a request proves the guest holds this session's port, which is
   * what an embedder deciding between offered sessions needs to know.
   */
  constructor(
    bridge: FabricBridge,
    port: MessagePort,
    onFirstRequest?: (session: FabricBridgeHost) => void,
  ) {
    this.#bridge = bridge;
    this.#port = port;
    this.#onFirstRequest = onFirstRequest;
    this.#port.onmessage = this.#onMessage;
    this.#port.start();
  }

  /** Cancels subscriptions and closes this guest's port. */
  disconnect(): void {
    if (!this.#connected) return;
    this.#connected = false;
    for (const cancel of this.#subscriptions.values()) {
      try {
        cancel();
      } catch {
        // One broken resource must not retain the rest of the guest session.
      }
    }
    this.#subscriptions.clear();
    this.#cells.clear();
    this.#refusedPaths.clear();
    this.#port.close();
  }

  /**
   * Sends the acknowledgement for a flush marker carrying `nonce`. A marker
   * cannot say which session its guest holds, so an embedder answers every
   * session it has open; only the guest that minted the nonce acts on it.
   */
  acknowledgeFlush(nonce: string): void {
    this.#post({
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_VERSION,
      type: "flush",
      nonce,
    });
  }

  #post(message: BridgeHostMessage): void {
    if (this.#connected) {
      this.#port.postMessage(realmFromFabricValue(message));
    }
  }

  #manifest(): BridgeManifest {
    return {
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_VERSION,
      resources: Object.keys(this.#bridge.resources).map(
        (name) =>
          descriptor(
            name,
            discoverResource(this.#bridge.resources, name)!,
          ),
      ),
    };
  }

  #onMessage = (event: MessageEvent): void => {
    if (!this.#connected) return;
    let decoded: FabricValue;
    try {
      decoded = fabricFromRealmValue(event.data);
    } catch {
      return;
    }
    if (!isBridgeRequest(decoded)) return;
    if (!this.#firstRequestReported) {
      this.#firstRequestReported = true;
      this.#onFirstRequest?.(this);
    }
    if (decoded.operation === "disconnect") {
      this.disconnect();
      return;
    }
    const handling = this.#operationTail
      ? this.#operationTail.then(() => {
        if (!this.#connected) return undefined;
        return this.#handle(decoded);
      })
      : this.#handle(decoded);
    const tail = handling.catch(() => {});
    this.#operationTail = tail;
    void tail.then(() => {
      if (this.#operationTail === tail) this.#operationTail = undefined;
    });
  };

  async #handle(request: BridgeRequest): Promise<void> {
    try {
      const value = await this.#perform(request);
      this.#post({
        protocol: BRIDGE_PROTOCOL,
        version: BRIDGE_VERSION,
        type: "response",
        id: request.id,
        ok: true,
        ...(value !== undefined && { value }),
      });
    } catch (error) {
      this.#post({
        protocol: BRIDGE_PROTOCOL,
        version: BRIDGE_VERSION,
        type: "response",
        id: request.id,
        ok: false,
        error: normalizeBridgeError(error, request.resource),
      });
    }
  }

  async #perform(request: BridgeRequest): Promise<FabricValue | undefined> {
    const operation = request.operation;
    if (operation === "describe") return this.#manifest();

    if (operation === "unsink") {
      if (request.subscription !== undefined) {
        this.#subscriptions.get(request.subscription)?.();
        this.#subscriptions.delete(request.subscription);
      }
      return undefined;
    }

    const resource = request.resource !== undefined
      ? discoverResource(this.#bridge.resources, request.resource)
      : undefined;
    if (
      request.handle === undefined &&
      (!resource || request.resource === undefined)
    ) {
      throw bridgeError(
        "resource-not-found",
        `No bridge resource is named \`${request.resource ?? ""}\`.`,
        request.resource,
      );
    }

    switch (operation) {
      case "pull": {
        const { cell, resource: name, path } = this.#requestCell(
          request,
          "pull",
        );
        const pull = cellOperation(cell, "pull");
        if (!pull) {
          throw bridgeError(
            "method-not-supported",
            `Cell \`${name}\` is not pullable.`,
            name,
          );
        }
        return await this.#read(path, () => pull.call(cell));
      }
      case "initialize": {
        const { cell, resource: name, path } = this.#requestCell(
          request,
          "initialize",
        );
        const initialize = cellOperation(cell, "initialize");
        if (!initialize) {
          throw bridgeError(
            "method-not-supported",
            `Cell \`${name}\` does not support initialize().`,
            name,
          );
        }
        // Stores nothing over a value the cell holds, so a refused path does
        // not stop it, and it answers with the stored value: a read.
        return await this.#read(
          path,
          () => initialize.call(cell, request.value as FabricValue),
        );
      }
      case "set": {
        const { cell, resource: name, path } = this.#requestCell(
          request,
          "set",
        );
        const set = cellOperation(cell, "set");
        if (!set) {
          throw bridgeError(
            "method-not-supported",
            `Cell \`${name}\` is not writable.`,
            name,
          );
        }
        await this.#write(
          path,
          name,
          () => set.call(cell, request.value as FabricValue),
        );
        return undefined;
      }
      case "push": {
        const { cell, resource: name, path } = this.#requestCell(
          request,
          "push",
        );
        const push = cellOperation(cell, "push");
        if (!push) {
          throw bridgeError(
            "method-not-supported",
            `Cell \`${name}\` does not support push().`,
            name,
          );
        }
        await this.#write(
          path,
          name,
          () => push.call(cell, request.values ?? []),
        );
        return undefined;
      }
      case "resolve": {
        const target = this.#requestCell(request, "resolve");
        const resolve = cellOperation(target.cell, "resolve");
        const cell = validateCell(
          target.resource,
          resolve ? await resolve.call(target.cell) : target.cell,
        );
        const handle = `cell-${this.#nextCellHandle++}`;
        const operations = cellOperationNames(cell);
        this.#cells.set(handle, {
          cell,
          operations: new Set(operations),
          resource: target.resource,
          path: target.path,
        });
        const identity = Object.getOwnPropertyDescriptor(cell, "identity");
        // What the resolved cell holds already, which is not a read: it can
        // hold a refusal, and holds nothing when it has read nothing yet, so
        // it refuses a path and admits none. One that has read nothing hands
        // the guest no value, so the guest pulls before it reads.
        const hasValue = cellHasValue(cell);
        let value: FabricValue | undefined;
        try {
          value = hasValue ? cell.get() : undefined;
        } catch (error) {
          if (isReadRefusal(error)) this.#refuse(target.path);
          throw error;
        }
        return {
          handle,
          hasValue,
          operations,
          ...(identity && "value" in identity && identity.value !== undefined &&
            {
              identity: identity.value,
            }),
          ...(value !== undefined && { value }),
        } satisfies BridgeResolvedCell;
      }
      case "call": {
        if (!resource || request.resource === undefined) {
          throw bridgeError(
            "resource-not-found",
            `No bridge resource is named \`${request.resource ?? ""}\`.`,
            request.resource,
          );
        }
        const method = namedMethod(resource, request.method);
        if (!method) {
          throw bridgeError(
            "method-not-supported",
            `Resource \`${request.resource}\` has no method \`${
              request.method ?? ""
            }\`.`,
            request.resource,
          );
        }
        return await method(request.value);
      }
      case "sink": {
        if (request.subscription === undefined) {
          throw bridgeError(
            "method-not-supported",
            `Resource \`${
              request.resource ?? request.handle
            }\` is not sinkable.`,
            request.resource,
          );
        }
        let sinkResource:
          | ((
            listener: (value: FabricValue | undefined) => void,
            failed: BridgeSinkFailure,
          ) => BridgeCancel)
          | undefined;
        let receiver: object;
        let path: GuestPath | undefined;
        if (request.handle !== undefined || resource?.kind === "cell") {
          const target = this.#requestCell(request, "sink");
          const sink = cellOperation(target.cell, "sink");
          sinkResource = sink &&
            ((listener, failed) => sink.call(target.cell, listener, failed));
          receiver = target.cell;
          path = target.path;
        } else {
          const sink = resource && resourceSink(resource);
          sinkResource = sink && ((listener) => sink.call(resource, listener));
          receiver = resource ?? {};
        }
        if (!sinkResource) {
          throw bridgeError(
            "method-not-supported",
            `Resource \`${
              request.resource ?? request.handle
            }\` is not sinkable.`,
            request.resource,
          );
        }
        this.#subscriptions.get(request.subscription)?.();
        const subscription = request.subscription;
        // A value delivered while the sink opens is what the cell held
        // already, not a read: it admits no path. A refusal refuses one
        // whenever it arrives.
        let opening = true;
        const cancel = sinkResource.call(receiver, (value) => {
          if (path !== undefined && !opening) this.#admit(path);
          this.#post({
            protocol: BRIDGE_PROTOCOL,
            version: BRIDGE_VERSION,
            type: "event",
            subscription,
            ...(value !== undefined && { value }),
          });
        }, (error) => {
          if (path !== undefined && isReadRefusal(error)) this.#refuse(path);
          this.#post({
            protocol: BRIDGE_PROTOCOL,
            version: BRIDGE_VERSION,
            type: "event",
            subscription,
            error: normalizeBridgeError(error, request.resource),
          });
        });
        opening = false;
        this.#subscriptions.set(subscription, cancel);
        return undefined;
      }
    }
  }

  /**
   * Makes `read`, a read through `path`, and records what it found: an
   * admitted read ends the path's refusal, and a refused one starts it.
   */
  async #read<T>(path: GuestPath, read: () => T | Promise<T>): Promise<T> {
    let value: T;
    try {
      value = await read();
    } catch (error) {
      if (isReadRefusal(error)) this.#refuse(path);
      throw error;
    }
    this.#admit(path);
    return value;
  }

  /**
   * Makes `write`, a write through `path`, unless the path's last read was
   * refused: the guest then wrote what it could not have read, so the write
   * is refused with the read's code. A write that the cell refuses as
   * computed from a refused read holds the path to that refusal too. A
   * write that lands ends no refusal; only an admitted read does.
   */
  async #write(
    path: GuestPath,
    resource: string,
    write: () => void | Promise<void>,
  ): Promise<void> {
    if (this.#refusedPaths.has(pathKey(path))) {
      throw bridgeError(
        BRIDGE_READ_REFUSED,
        `The host was refused the last read of this path of \`${resource}\`, so it writes nothing through it until a read of it is admitted.`,
        resource,
      );
    }
    try {
      await write();
    } catch (error) {
      if (isReadRefusal(error)) this.#refuse(path);
      throw error;
    }
  }

  #refuse(path: GuestPath): void {
    this.#refusedPaths.add(pathKey(path));
  }

  #admit(path: GuestPath): void {
    this.#refusedPaths.delete(pathKey(path));
  }

  #requestCell(
    request: BridgeRequest,
    operation: BridgeCellOperation,
  ): {
    cell: BridgeCell;
    resource: string;
    /** The path the guest named, from its resource, resolved or not. */
    path: GuestPath;
  } {
    let cell: BridgeCell;
    let resourceName: string;
    let path: GuestPath;
    if (request.handle !== undefined) {
      const resolved = this.#cells.get(request.handle);
      if (!resolved) {
        throw bridgeError(
          "resource-not-found",
          `No resolved cell handle is named \`${request.handle}\`.`,
        );
      }
      if (!resolved.operations.has(operation)) {
        throw bridgeError(
          "method-not-supported",
          `Resolved cell \`${request.handle}\` does not support ${operation}().`,
          resolved.resource,
        );
      }
      if ((request.path?.length ?? 0) > 0 && !resolved.operations.has("key")) {
        throw bridgeError(
          "method-not-supported",
          `Resolved cell \`${request.handle}\` does not support key().`,
          resolved.resource,
        );
      }
      cell = resolved.cell;
      resourceName = resolved.resource;
      path = resolved.path;
    } else {
      resourceName = request.resource ?? "";
      const resource = discoverResource(this.#bridge.resources, resourceName);
      if (!resource) {
        throw bridgeError(
          "resource-not-found",
          `No bridge resource is named \`${resourceName}\`.`,
          resourceName,
        );
      }
      cell = resourceCell(resourceName, resource);
      path = [resourceName];
    }
    for (const key of request.path ?? []) {
      const descend = cellOperation(cell, "key");
      if (!descend) {
        throw bridgeError(
          "method-not-supported",
          `Cell \`${resourceName}\` does not support key().`,
          resourceName,
        );
      }
      cell = validateCell(resourceName, descend.call(cell, key));
      path = [...path, String(key)];
    }
    return { cell, resource: resourceName, path };
  }
}

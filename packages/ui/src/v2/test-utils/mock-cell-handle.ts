/**
 * Test utility: creates real CellHandle instances backed by a mock cell
 * network. The returned handles pass `isCellHandle()` (which uses
 * `instanceof CellHandle`) and support get/set/subscribe/key without
 * needing a live RuntimeClient or worker.
 *
 * ## Features
 *
 * - `createMockCellHandle(value)` — basic mock, same as before
 * - Parent-child propagation: when a child from `cell.key("foo")` calls
 *   `.set(v)`, the parent's value is updated and its subscribers fire
 * - `pushUpdate(cell, value)` — simulate a backend push via `$onCellUpdate`,
 *   letting tests distinguish local writes from runtime-originated updates
 * - `pushRefusal(cell)` — simulate the worker refusing the cell's read, via
 *   `$onCellRefused`
 * - `writesSent(cell)` — the writes the handle, or a handle reached from it
 *   through `key()`, sent the mock runtime
 * - `holdReads(cell)` — leave every read the handle's network is asked for
 *   unanswered, as a worker that has not answered yet does
 * - `refuseReads(cell)` — answer every read the handle's network is asked
 *   for with a refusal
 */

import {
  $conn,
  $onCellRefused,
  $onCellUpdate,
  CellHandle,
  type CellReadRefusal,
  type CellRef,
  type InitializedRuntimeConnection,
  type RuntimeClient,
} from "@commonfabric/runtime-client";
import { isObjectOrArray } from "@commonfabric/utils/types";

/** Default CellRef used when none is provided. */
const DEFAULT_REF: CellRef = {
  id: "of:mock-cell" as CellRef["id"],
  space: "did:key:mock" as CellRef["space"],
  scope: "space",
  path: [],
  schema: { type: "object" },
};

/**
 * Registry that tracks root CellHandles, enabling child→parent propagation.
 *
 * When a child CellHandle (created via `parent.key("foo")`) calls `.set()`,
 * the mock connection intercepts the CellSet request, finds the root handle,
 * deep-sets the nested value, and calls `$onCellUpdate` to propagate the
 * change — mirroring what the real runtime does.
 */
class MockCellNetwork {
  /** Root handles keyed by "id:space" */
  #roots = new Map<string, CellHandle>();

  /** Every write request sent through this network, in order. */
  readonly writes: { type: string; cell?: CellRef; value?: unknown }[] = [];

  /**
   * How reads (`cell:get`, `cell:pull`) are answered: as finding nothing,
   * not at all, or with a refusal.
   */
  reads: "nothing" | "held" | { refused: CellReadRefusal } = "nothing";

  /** What answers, or fails, each read held so far, in order. */
  readonly heldReads: Array<
    { answer: (answer: object) => void; fail: (error: Error) => void }
  > = [];

  register(handle: CellHandle): void {
    this.#roots.set(this.#rootKey(handle.ref()), handle);
  }

  #rootKey(ref: CellRef): string {
    return `${ref.id}:${ref.space}`;
  }

  /**
   * Resolve a ref the way the runtime does: if the value at the ref's path
   * is a stored `$link`, the resolution answers with the LINKED ref;
   * otherwise the asking ref is already canonical and echoes back. This is
   * what lets a test model an index row whose `piece` field holds a link —
   * the value an `asCell` position actually stores.
   */
  resolveRef(ref: CellRef): CellRef {
    const root = this.#roots.get(this.#rootKey(ref));
    // A root whose read is refused, or has read nothing, holds no link to
    // follow.
    const read = root?.lastRead();
    let value: unknown = read !== undefined && "value" in read
      ? read.value
      : undefined;
    for (const seg of ref.path ?? []) {
      if (!isObjectOrArray(value)) break;
      value = (value as Record<string, unknown>)[seg as string];
    }
    const link = isObjectOrArray(value) &&
      (value as Record<string, unknown>)["$link"];
    if (isObjectOrArray(link)) {
      return {
        scope: "space",
        path: [],
        schema: undefined,
        space: ref.space,
        ...(link as Partial<CellRef>),
      } as CellRef;
    }
    return ref;
  }

  /**
   * Handle a CellSet request: propagate child writes to the root handle.
   */
  handleCellSet(
    cellRef: CellRef,
    value: unknown,
  ): void {
    const root = this.#roots.get(this.#rootKey(cellRef));
    if (!root || cellRef.path.length === 0) return;

    // Reconstruct the root's full value with the nested path updated. A root
    // whose read is refused, or that has read nothing, holds nothing to
    // reconstruct it from.
    const rootRead = root.lastRead();
    if (!("value" in rootRead)) return;
    const rootValue = rootRead.value;
    if (!isObjectOrArray(rootValue)) return;

    const updated = deepSet(
      rootValue as Record<string, unknown>,
      cellRef.path as string[],
      value,
    );
    root[$onCellUpdate](updated);
  }
}

/** Immutable deep-set: returns a new object with path set to value. */
function deepSet(
  obj: Record<string, unknown>,
  path: string[],
  value: unknown,
): Record<string, unknown> {
  if (path.length === 0) return value as Record<string, unknown>;
  const [head, ...rest] = path;
  const child = obj[head];
  const nested = rest.length === 0 ? value : deepSet(
    (isObjectOrArray(child) ? child : {}) as Record<
      string,
      unknown
    >,
    rest,
    value,
  );
  if (Array.isArray(obj)) {
    const copy = [...obj];
    copy[Number(head)] = nested;
    return copy as unknown as Record<string, unknown>;
  }
  return { ...obj, [head]: nested };
}

/**
 * Create a mock InitializedRuntimeConnection backed by a MockCellNetwork.
 *
 * - `request()` intercepts CellSet to propagate child→parent writes,
 *   answers CellResolveAsCell by following a stored `$link` at the asked
 *   path (echoing the asking ref when there is none to follow — already
 *   canonical), and resolves everything else with `{}`.
 * - `subscribe()` / `unsubscribe()` are no-ops.
 * - Includes EventEmitter stubs (`on`, `off`, `emit`) to satisfy the type.
 */
function createMockConnection(
  network: MockCellNetwork,
): InitializedRuntimeConnection {
  return {
    request: (data: { type: string; cell?: CellRef; value?: unknown }) => {
      if (data.type === "cell:set" || data.type === "cell:push") {
        network.writes.push(data);
      }
      if (data.type === "cell:set" && data.cell && data.value !== undefined) {
        network.handleCellSet(data.cell, data.value);
      }
      if (data.type === "cell:resolveAsCell" && data.cell) {
        return Promise.resolve({ cell: network.resolveRef(data.cell) } as any);
      }
      if (data.type === "cell:get" || data.type === "cell:pull") {
        const reads = network.reads;
        if (reads === "held") {
          return new Promise((answer, fail) =>
            network.heldReads.push({ answer, fail })
          );
        }
        if (reads !== "nothing") return Promise.resolve(reads);
      }
      return Promise.resolve({} as any);
    },
    subscribe: () => Promise.resolve(),
    unsubscribe: () => Promise.resolve(),
    peersOf: () => [],
    on: () => ({}) as any,
    off: () => ({}) as any,
    once: () => ({}) as any,
    emit: () => false,
    removeAllListeners: () => ({}) as any,
    listenerCount: () => 0,
  } as unknown as InitializedRuntimeConnection;
}

/**
 * Create a mock RuntimeClient with a connection and a live lifetime signal.
 *
 * CellHandle's constructor only accesses `worker[$conn]()` — it doesn't call
 * any other RuntimeClient methods — so this minimal mock is sufficient.
 */
function createMockRuntimeClient(
  conn: InitializedRuntimeConnection,
): RuntimeClient {
  return {
    [$conn]: () => conn,
    signal: new AbortController().signal,
  } as unknown as RuntimeClient;
}

/**
 * Create a real CellHandle backed by a mock cell network.
 *
 * The returned handle:
 * - passes `isCellHandle()` (`instanceof CellHandle`)
 * - `.get()` returns the initial value
 * - `.set(v)` updates `.get()` and fires subscribers synchronously
 * - `.subscribe(cb)` calls `cb` immediately with the current value
 * - `.key("foo")` returns a child CellHandle
 * - child `.set()` propagates back to the parent (and fires parent subscribers)
 * - can receive simulated backend pushes via `pushUpdate(handle, value)`
 */
export function createMockCellHandle<T>(
  value?: T,
  ref?: Partial<CellRef>,
): CellHandle<T> {
  const network = new MockCellNetwork();
  const conn = createMockConnection(network);
  const rt = createMockRuntimeClient(conn);
  const cellRef: CellRef = { ...DEFAULT_REF, ...ref };
  // One made with no value has read nothing yet.
  const handle = new CellHandle<T>(
    rt,
    cellRef,
    value === undefined ? { unread: true } : { value },
  );
  network.register(handle as CellHandle<unknown>);
  networks.set(handle, network);
  return handle;
}

/** The network each mock handle was made on. */
const networks = new WeakMap<object, MockCellNetwork>();

/**
 * The writes (`CellSet` and `CellPush` requests) sent on the network
 * `handle` was made on, by it or by any handle reached from it.
 */
export function writesSent<T>(
  handle: CellHandle<T>,
): readonly { type: string; cell?: CellRef; value?: unknown }[] {
  const network = networks.get(handle);
  if (network === undefined) {
    throw new Error("writesSent() takes a handle createMockCellHandle() made");
  }
  return network.writes;
}

/**
 * Leaves every read (`cell:get`, `cell:pull`) the network `handle` was made
 * on is asked for unanswered, as a worker that has not answered yet does,
 * until the function it returns answers them, as the worker would, or fails
 * them with an error, and lets later reads through. A read the mock answers otherwise finds the cell
 * holding nothing.
 */
export function holdReads<T>(
  handle: CellHandle<T>,
): (
  answer: { value: T | undefined } | { refused: CellReadRefusal } | Error,
) => void {
  const network = networkOf(handle, "holdReads");
  network.reads = "held";
  return (answer) => {
    network.reads = "nothing";
    for (const read of network.heldReads.splice(0)) {
      if (answer instanceof Error) read.fail(answer);
      else read.answer(answer);
    }
  };
}

/**
 * Answers every read (`cell:get`, `cell:pull`) the network `handle` was made
 * on is asked for with `refusal`, as a worker that refuses it does.
 */
export function refuseReads<T>(
  handle: CellHandle<T>,
  refusal: CellReadRefusal = { refusedBy: "display-ceiling" },
): void {
  networkOf(handle, "refuseReads").reads = { refused: refusal };
}

/** The network `handle` was made on, for `caller`. */
function networkOf<T>(handle: CellHandle<T>, caller: string): MockCellNetwork {
  const network = networks.get(handle);
  if (network === undefined) {
    throw new Error(`${caller}() takes a handle createMockCellHandle() made`);
  }
  return network;
}

/**
 * Simulate the worker refusing `handle`'s read, the path a refused
 * subscription update takes.
 */
export function pushRefusal<T>(
  handle: CellHandle<T>,
  refusal: CellReadRefusal = { refusedBy: "display-ceiling" },
): void {
  handle[$onCellRefused](refusal);
}

/**
 * Simulate a backend-pushed value update on a CellHandle.
 *
 * This calls `$onCellUpdate` directly, which is the same code path the real
 * RuntimeConnection uses when the runtime pushes a cell update. Use this to
 * test how components react to external value changes (as opposed to local
 * writes via `.set()`).
 *
 * @example
 * ```ts
 * const cell = createMockCellHandle("initial");
 * cell.subscribe((v) => console.log("got:", v));
 * pushUpdate(cell, "from-backend");
 * // subscriber fires with "from-backend"
 * ```
 */
export function pushUpdate<T>(handle: CellHandle<T>, value: T): void {
  handle[$onCellUpdate](value);
}

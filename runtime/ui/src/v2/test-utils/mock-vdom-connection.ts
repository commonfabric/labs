/**
 * Test utility: a `CellHandle` whose connection speaks the VDOM session
 * protocol, so code that calls `render()` can be exercised without a worker.
 *
 * `createMockCellHandle` covers cell reads and writes; a renderer needs more
 * than that. It attaches a VDOM session to the connection, mounts a cell
 * reference over it, and unmounts on teardown. The session here records those
 * calls instead of talking to a worker, which is what lets a test assert
 * *which* cell a render mounted and that cancelling unmounted it.
 */

import {
  $conn,
  CellHandle,
  type CellRef,
  type InitializedRuntimeConnection,
  type RuntimeClient,
  type VDomConnection,
} from "@commonfabric/runtime-client";

/** What a mock session recorded, for a test to assert against. */
export interface VDomSessionLog {
  /** Cell references passed to `mount`, in order. */
  mounted: CellRef[];

  /** Mount ids passed to `unmount`, in order. */
  unmounted: number[];

  /** Whether the renderer detached its disposal teardown. */
  detached: boolean;

  /** Whether a VDOM session was attached at all. */
  attached: boolean;
}

const DEFAULT_REF: CellRef = {
  id: "of:mock-render-cell" as CellRef["id"],
  space: "did:key:mock" as CellRef["space"],
  scope: "space",
  path: [],
  schema: { type: "object" },
};

/** A batch of VDOM operations, as the worker sends one to a session. */
export type VDomBatch = Parameters<Parameters<VDomConnection["onBatch"]>[0]>[0];

/**
 * Create a `CellHandle` backed by a connection that can host a render.
 *
 * Returns the handle, the log its session writes to, and a function that
 * delivers a batch to every renderer listening on the session, as the worker
 * does.
 */
export function createRenderableCellHandle<T>(
  value?: T,
  ref?: Partial<CellRef>,
): {
  cell: CellHandle<T>;
  log: VDomSessionLog;
  deliver: (batch: VDomBatch) => void;
} {
  const log: VDomSessionLog = {
    mounted: [],
    unmounted: [],
    detached: false,
    attached: false,
  };
  const lifetime = new AbortController();
  const batchHandlers = new Set<(batch: VDomBatch) => void>();

  const session: VDomConnection = {
    signal: lifetime.signal,
    mount: (_mountId: number, cellRef: CellRef) => {
      log.mounted.push(cellRef);
      // `null`: nothing was rendered, so the tree has no root child.
      return Promise.resolve({ rootId: null });
    },
    unmount: (mountId: number) => {
      log.unmounted.push(mountId);
      return Promise.resolve();
    },
    sendEvent: () => {},
    ackBatch: () => {},
    onBatch: (handler) => {
      batchHandlers.add(handler);
    },
    offBatch: (handler) => {
      batchHandlers.delete(handler);
    },
    detach: () => {
      log.detached = true;
    },
  };

  const conn = {
    request: () => Promise.resolve({}),
    subscribe: () => Promise.resolve(),
    unsubscribe: () => Promise.resolve(),
    peersOf: () => [],
    signal: lifetime.signal,
    onDispose: (teardown: () => void) => {
      lifetime.signal.addEventListener("abort", teardown, { once: true });
      return () => lifetime.signal.removeEventListener("abort", teardown);
    },
    attachVDom: (_onDispose: () => void) => {
      log.attached = true;
      return session;
    },
  } as unknown as InitializedRuntimeConnection;

  // `getPiece` finds nothing: it is what `cf-render` opens a displayed piece
  // with, and a test that asserts the open replaces it.
  const rt = {
    [$conn]: () => conn,
    getPiece: () => Promise.resolve(null),
  } as unknown as RuntimeClient;
  const cell = new CellHandle<T>(
    rt,
    { ...DEFAULT_REF, ...ref },
    value === undefined ? { unread: true } : { value },
  );
  const deliver = (batch: VDomBatch) => {
    for (const handler of batchHandlers) handler(batch);
  };
  return { cell, log, deliver };
}

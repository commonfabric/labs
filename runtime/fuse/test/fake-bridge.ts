/**
 * A stand-in for `CellBridge`, the object through which the FUSE daemon reads
 * and writes cells, for tests that drive the daemon's operations.
 */

import type { PieceController } from "@commonfabric/piece/ops";

import type {
  HandlerTarget,
  SourceWritePath,
  WritePath,
} from "../cell-bridge.ts";
import type { FuseBridge } from "../operations.ts";

/** Cells holding empty objects. */
export const EMPTY: PieceCells = { input: {}, result: {} };

/** The values of a piece's two cells, which a fake piece reads and writes. */
export interface PieceCells {
  input: unknown;
  result: unknown;
}

function valueAt(root: unknown, path: (string | number)[] | undefined) {
  let current = root;
  for (const segment of path ?? []) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

/**
 * A piece whose cells hold `cells`, declared as the `PieceController` a write
 * path carries; the operations read a cell through it before rewriting a
 * parent. This is the one place a fake crosses that line.
 */
export function fakePiece(
  cells: PieceCells,
  source: Partial<
    Pick<PieceController, "getPatternSourceProgram" | "setPattern">
  > = {},
): PieceController {
  const prop = (cell: keyof PieceCells) => ({
    get: (path?: (string | number)[]) =>
      Promise.resolve(structuredClone(valueAt(cells[cell], path))),
  });
  return {
    id: "of:fake-piece",
    input: prop("input"),
    result: prop("result"),
    ...source,
  } as unknown as PieceController;
}

export function writePath(
  piece: PieceController,
  jsonPath: (string | number)[],
  options: Partial<WritePath> = {},
): WritePath {
  return {
    spaceName: "home",
    pieceName: "notes",
    cell: "input",
    jsonPath,
    isJsonFile: false,
    piece,
    ...options,
  };
}

/** A recorded call the operations made on the bridge. */
export type BridgeCall =
  | { method: "writeValue"; jsonPath: (string | number)[]; value: unknown }
  | { method: "writeFsFile"; jsonPath: (string | number)[]; text: string }
  | { method: "finalizeWritePath"; jsonPath: (string | number)[] }
  | { method: "invalidateWritePath"; jsonPath: (string | number)[] }
  | { method: "sendToHandlerTarget"; cellKey: string; value: unknown }
  | { method: "finalizeSourceWritePath"; relPath: string; receipt: unknown }
  | { method: "writeSourceErrorLog"; relPath: string; text: string };

/**
 * Stands in for `CellBridge`. A test registers the write paths that inodes
 * resolve to, and reads back the calls the operations made. Each method is a
 * property, so a case can replace one to make it fail or wait.
 */
export class FakeBridge implements FuseBridge {
  disconnected = false;
  readonly disconnectReasons: string[] = [];
  readonly calls: BridgeCall[] = [];
  readonly writePaths = new Map<bigint, WritePath>();
  readonly sourceWritePaths = new Map<bigint, SourceWritePath>();
  readonly handlerTargets = new Map<bigint, HandlerTarget>();
  readonly retained: string[] = [];
  readonly #waiters: { event: string; resolve: () => void }[] = [];

  /** Resolves when `event` next happens: a method's name, or `close <ino>`. */
  next(event: string): Promise<void> {
    return new Promise((resolve) => this.#waiters.push({ event, resolve }));
  }

  #emit(event: string): void {
    for (const waiter of [...this.#waiters]) {
      if (waiter.event !== event) continue;
      this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  }

  #call(call: BridgeCall): void {
    this.calls.push(call);
    this.#emit(call.method);
  }

  markDisconnected(reason: string): void {
    this.disconnected = true;
    this.disconnectReasons.push(reason);
  }

  connectSpace: (spaceName: string) => Promise<unknown> = () =>
    Promise.reject(new Error("no such space"));
  shouldPrepareLookup: (parentIno: bigint, name: string) => boolean = () =>
    false;
  shouldSynchronizeLookup: (parentIno: bigint) => boolean = () => false;
  prepareLookup: (parentIno: bigint, name: string) => Promise<boolean> = () =>
    Promise.resolve(false);
  shouldPrepareDirectory: (ino: bigint) => boolean = () => false;
  prepareDirectory: (ino: bigint) => Promise<boolean> = () =>
    Promise.resolve(true);
  prepareLookupForReply?: (
    parentIno: bigint,
    name: string,
  ) => Promise<bigint | undefined>;

  resolveWritePath(ino: bigint): WritePath | null {
    return this.writePaths.get(ino) ?? null;
  }

  resolveSourceWritePath(ino: bigint): SourceWritePath | null {
    return this.sourceWritePaths.get(ino) ?? null;
  }

  resolveHandlerTarget(ino: bigint): HandlerTarget | null {
    return this.handlerTargets.get(ino) ?? null;
  }

  sendToHandlerTarget: (target: HandlerTarget, value: unknown) => Promise<
    void
  > = (target, value) => {
    this.#call({
      method: "sendToHandlerTarget",
      cellKey: target.cellKey,
      value,
    });
    return Promise.resolve();
  };

  writeValue: (path: WritePath, value: unknown) => Promise<void> = (
    path,
    value,
  ) => {
    this.#call({ method: "writeValue", jsonPath: path.jsonPath, value });
    return Promise.resolve();
  };

  writeFsFile: (path: WritePath, text: string) => Promise<boolean> = (
    path,
    text,
  ) => {
    this.#call({ method: "writeFsFile", jsonPath: path.jsonPath, text });
    return Promise.resolve(true);
  };

  invalidateWritePath(path: WritePath): void {
    this.#call({
      method: "invalidateWritePath",
      jsonPath: path.jsonPath,
    });
  }

  finalizeWritePath: (path: WritePath) => Promise<void> = (path) => {
    this.#call({ method: "finalizeWritePath", jsonPath: path.jsonPath });
    return Promise.resolve();
  };

  finalizeSourceWritePath: (
    path: SourceWritePath,
    receipt?: unknown,
  ) => Promise<void> = (path, receipt) => {
    this.#call({
      method: "finalizeSourceWritePath",
      relPath: path.relPath,
      receipt,
    });
    return Promise.resolve();
  };

  writeSourceErrorLog(path: SourceWritePath, text: string): void {
    this.#call({
      method: "writeSourceErrorLog",
      relPath: path.relPath,
      text,
    });
  }

  parseSymlinkTarget: (
    parentIno: bigint,
    target: string,
  ) => { id?: string; path?: string[]; space?: string } | null = (
    _parentIno,
    target,
  ) => target.startsWith("../") ? { id: target.slice(3) } : null;

  retainEntityProjectionLookup(ino: bigint): void {
    this.retained.push(`lookup+${ino}`);
  }

  releaseEntityProjectionLookup(ino: bigint): void {
    this.retained.push(`lookup-${ino}`);
  }

  retainEntityProjectionOpen(ino: bigint): void {
    this.retained.push(`open+${ino}`);
  }

  releaseEntityProjectionOpen(ino: bigint): void {
    this.retained.push(`open-${ino}`);
    this.#emit(`close ${ino}`);
  }

  /** The calls made to `method`. */
  callsTo<M extends BridgeCall["method"]>(
    method: M,
  ): Extract<BridgeCall, { method: M }>[] {
    return this.calls.filter((call): call is Extract<
      BridgeCall,
      { method: M }
    > => call.method === method);
  }
}

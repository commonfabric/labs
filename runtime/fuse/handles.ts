// handles.ts — File handle tracking for write support

import type { CfcNodeAnnotation } from "./annotations.ts";
import type { CfcExistingWritebackOperation } from "./cfc-writeback.ts";
import { O_RDWR, O_WRONLY } from "./platform.ts";

export const MAX_VIRTUAL_FILE_SIZE = 64 * 1024 * 1024;

export type VirtualFileRangeValidation =
  | { ok: true }
  | { ok: false; reason: "invalid" | "too-large" };

export function validateVirtualFileRange(
  offset: number,
  length: number,
  maxSize = MAX_VIRTUAL_FILE_SIZE,
): VirtualFileRangeValidation {
  if (
    !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
    offset < 0 || length < 0
  ) {
    return { ok: false, reason: "invalid" };
  }
  const end = offset + length;
  if (!Number.isSafeInteger(end) || end > maxSize) {
    return { ok: false, reason: "too-large" };
  }
  return { ok: true };
}

/** An open descriptor's buffer, and `Target`, where its writes go. */
export interface HandleState<Target = unknown> {
  ino: bigint;
  flags: number;
  dirty: boolean;
  flushing: boolean;
  buffer: Uint8Array;
  bufferValid: boolean;
  truncatePending: boolean;
  version: number;
  writeTarget?: Target;
  cfcAuthorizedOperations: Set<CfcExistingWritebackOperation>;
  cfcAuthorizationAnnotation?: CfcNodeAnnotation;

  /**
   * For a read-only snapshot of a generated file, when its bytes were
   * published. A getattr on this handle reports it so the size and the
   * modification time it carries describe the same render.
   */
  readSnapshotMtime?: number;
}

export function handleHasPendingChanges(
  handle: HandleState | undefined,
): boolean {
  return Boolean(handle && (handle.dirty || handle.truncatePending));
}

export function handleHasBufferedContent(
  handle: HandleState | undefined,
): boolean {
  return Boolean(
    handle &&
      (handle.bufferValid || handle.dirty || handle.truncatePending),
  );
}

/**
 * Drops the buffer of `handle` once a flush has dealt with its writes without
 * making them the file's content: sent to a handler, or discarded for an
 * ignored name. The descriptor then reads the inode, and a later write or
 * truncate starts from an empty buffer.
 */
export function discardBuffer(handle: HandleState): void {
  handle.dirty = false;
  handle.truncatePending = false;
  handle.buffer = new Uint8Array(0);
  handle.bufferValid = false;
}

/** The open descriptors of a mount, each writing to a `Target`. */
export class HandleMap<Target = unknown> {
  #nextFh = 1n;
  #handles = new Map<bigint, HandleState<Target>>();

  /**
   * Open a file handle. Copies current content into buffer if writable.
   *
   * `readSnapshot` buffers a read-only handle as well, fixing the bytes it
   * serves for its lifetime. It is for generated files, whose published content
   * changes under a descriptor as readers ask the tree for their size.
   */
  open(
    ino: bigint,
    flags: number,
    content?: Uint8Array,
    options?: {
      writeTarget?: Target;
      cfcAuthorizedOperations?: CfcExistingWritebackOperation[];
      cfcAuthorizationAnnotation?: CfcNodeAnnotation;
      readSnapshot?: Uint8Array;
      readSnapshotMtime?: number;
    },
  ): bigint {
    const fh = this.#nextFh++;
    const isWritable = (flags & O_WRONLY) !== 0 || (flags & O_RDWR) !== 0;
    const snapshot = options?.readSnapshot;
    this.#handles.set(fh, {
      ino,
      flags,
      dirty: false,
      flushing: false,
      buffer: snapshot
        ? new Uint8Array(snapshot)
        : (isWritable ? new Uint8Array(content ?? []) : new Uint8Array(0)),
      bufferValid: snapshot !== undefined || isWritable,
      truncatePending: false,
      version: 0,
      writeTarget: options?.writeTarget,
      cfcAuthorizedOperations: new Set(options?.cfcAuthorizedOperations ?? []),
      cfcAuthorizationAnnotation: options?.cfcAuthorizationAnnotation,
      readSnapshotMtime: snapshot ? options?.readSnapshotMtime : undefined,
    });
    return fh;
  }

  get(fh: bigint): HandleState<Target> | undefined {
    return this.#handles.get(fh);
  }

  close(fh: bigint): HandleState<Target> | undefined {
    const state = this.#handles.get(fh);
    if (state) {
      this.#handles.delete(fh);
    }
    return state;
  }

  hasCfcAuthorization(
    fh: bigint,
    operation: CfcExistingWritebackOperation,
  ): boolean {
    return this.#handles.get(fh)?.cfcAuthorizedOperations.has(operation) ??
      false;
  }

  authorizeCfcOperation(
    fh: bigint,
    operation: CfcExistingWritebackOperation,
  ): boolean {
    const state = this.#handles.get(fh);
    if (!state) return false;
    state.cfcAuthorizedOperations.add(operation);
    return true;
  }

  /**
   * Writes `data` into the buffer of open handle `fh` at `offset`, extending
   * it as needed. A buffer a flush discarded starts again empty.
   *
   * @throws If `fh` is not open for writing, or the range is not a valid one.
   */
  write(fh: bigint, data: Uint8Array, offset: number): void {
    const state = this.#writable(fh);
    validRange(offset, data.length);
    const end = offset + data.length;
    if (end > state.buffer.length) {
      // Extend buffer
      const newBuf = new Uint8Array(end);
      newBuf.set(state.buffer);
      state.buffer = newBuf;
    }
    state.buffer.set(data, offset);
    state.bufferValid = true;
    state.dirty = true;
    state.truncatePending = false;
    state.version++;

    for (const [otherFh, otherState] of this.#handles) {
      if (otherFh !== fh && otherState.ino === state.ino) {
        otherState.truncatePending = false;
      }
    }
  }

  /**
   * Truncates the buffers of all handles for `ino` to `size`, leaving the
   * change pending on `pendingFh` alone.
   *
   * A handle holding no buffer reads the inode's own content. Truncated to
   * zero it is given an empty buffer, which is the truncated content whatever
   * the inode held. Truncated to another size it goes on reading the inode,
   * which takes the truncated content when the truncate is flushed.
   * `pendingFh` itself is resized whether or not it holds a buffer, as
   * `truncate()` resizes it.
   *
   * @throws If `pendingFh` is not open for writing, or `size` is not a valid
   * file size.
   */
  truncateByIno(ino: bigint, size: number, pendingFh: bigint): void {
    this.#writable(pendingFh);
    validRange(0, size);
    for (const [fh, state] of this.#handles) {
      const pending = fh === pendingFh;
      if (state.ino !== ino || (!pending && !state.bufferValid && size > 0)) {
        continue;
      }
      resizeBuffer(state, size, pending);
    }
  }

  /**
   * Truncates the buffer of open handle `fh` to `size`; at zero, the empty
   * buffer is a pending truncate rather than content. A buffer a flush
   * discarded is resized from empty.
   *
   * @throws If `fh` is not open for writing, or `size` is not a valid file
   * size.
   */
  truncate(fh: bigint, size: number): void {
    const state = this.#writable(fh);
    validRange(0, size);
    resizeBuffer(state, size, true);
  }

  #writable(fh: bigint): HandleState<Target> {
    const state = this.#handles.get(fh);
    if (!state) throw new Error(`No open file handle ${fh}`);
    if ((state.flags & (O_WRONLY | O_RDWR)) === 0) {
      throw new Error(`File handle ${fh} is not open for writing`);
    }
    return state;
  }
}

/** @throws A `RangeError` unless `offset` and `length` make a valid range. */
function validRange(offset: number, length: number): void {
  const validation = validateVirtualFileRange(offset, length);
  if (!validation.ok) {
    throw new RangeError(
      `${validation.reason} file range: ${length} bytes at ${offset}`,
    );
  }
}

/**
 * Truncates or zero-extends `state`'s buffer to `size`. With `flush` set, the
 * change is pending for the next flush: an empty buffer as a pending truncate,
 * and any other size as dirty content.
 */
function resizeBuffer(state: HandleState, size: number, flush: boolean): void {
  if (size === 0) {
    state.buffer = new Uint8Array(0);
    state.dirty = false;
    state.truncatePending = flush;
  } else {
    if (size < state.buffer.length) {
      state.buffer = state.buffer.slice(0, size);
    } else if (size > state.buffer.length) {
      const newBuf = new Uint8Array(size);
      newBuf.set(state.buffer);
      state.buffer = newBuf;
    }
    state.dirty = flush;
    state.truncatePending = false;
  }
  state.bufferValid = true;
  state.version++;
}

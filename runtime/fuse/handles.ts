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

export interface HandleState {
  ino: bigint;
  flags: number;
  dirty: boolean;
  flushing: boolean;
  buffer: Uint8Array;
  bufferValid: boolean;
  truncatePending: boolean;
  version: number;
  writeTarget?: unknown;
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

export class HandleMap {
  #nextFh = 1n;
  #handles = new Map<bigint, HandleState>();

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
      writeTarget?: unknown;
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

  get(fh: bigint): HandleState | undefined {
    return this.#handles.get(fh);
  }

  close(fh: bigint): HandleState | undefined {
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

  /** Write data into the handle's buffer at offset, extending if needed. */
  write(fh: bigint, data: Uint8Array, offset: number): boolean {
    const state = this.#handles.get(fh);
    if (!state) return false;

    if (!validateVirtualFileRange(offset, data.length).ok) return false;
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

    return true;
  }

  /** Mark a handle as truncated to an empty buffer without committing yet. */
  markTruncated(fh: bigint): boolean {
    const state = this.#handles.get(fh);
    if (!state) return false;
    state.buffer = new Uint8Array(0);
    state.bufferValid = true;
    state.dirty = false;
    state.truncatePending = true;
    state.version++;
    return true;
  }

  /** Truncate all handles for a given inode to the specified size. */
  truncateByIno(
    ino: bigint,
    size: number,
    options?: { pendingFh?: bigint },
  ): boolean {
    if (!validateVirtualFileRange(0, size).ok) return false;
    for (const [fh, state] of this.#handles) {
      if (state.ino === ino) {
        const shouldFlush = options?.pendingFh === undefined ||
          options.pendingFh === fh;
        if (size === 0) {
          state.buffer = new Uint8Array(0);
          state.bufferValid = true;
          state.dirty = false;
          state.truncatePending = shouldFlush;
        } else {
          if (size < state.buffer.length) {
            state.buffer = state.buffer.slice(0, size);
          } else if (size > state.buffer.length) {
            const newBuf = new Uint8Array(size);
            newBuf.set(state.buffer);
            state.buffer = newBuf;
          }
          state.bufferValid = true;
          state.dirty = shouldFlush;
          state.truncatePending = false;
        }
        state.version++;
      }
    }
    return true;
  }

  /** Truncate the handle's buffer to the given size. */
  truncate(fh: bigint, size: number): boolean {
    const state = this.#handles.get(fh);
    if (!state) return false;
    if (!validateVirtualFileRange(0, size).ok) return false;

    if (size === 0) {
      state.buffer = new Uint8Array(0);
      state.bufferValid = true;
      state.dirty = false;
      state.truncatePending = true;
    } else {
      if (size < state.buffer.length) {
        state.buffer = state.buffer.slice(0, size);
      } else if (size > state.buffer.length) {
        const newBuf = new Uint8Array(size);
        newBuf.set(state.buffer);
        state.buffer = newBuf;
      }
      state.bufferValid = true;
      state.dirty = true;
      state.truncatePending = false;
    }
    state.version++;
    return true;
  }
}

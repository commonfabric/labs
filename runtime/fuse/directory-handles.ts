import { DIR_MODE } from "./platform.ts";
import { nodeMode } from "./stat.ts";
import { FsTree } from "./tree.ts";

/** Minimal bridge surface needed to prepare a dynamic directory. */
export interface DirectoryPreparer {
  shouldPrepareDirectory(ino: bigint): boolean;
  prepareDirectory(ino: bigint): Promise<boolean>;
  prepareDirectorySnapshot?(
    ino: bigint,
  ): Promise<readonly DirectorySnapshotEntry[] | undefined>;
}

/** Bridge operations used directly by the FUSE lookup and directory callbacks. */
export interface FuseOperationPreparer extends DirectoryPreparer {
  shouldPrepareLookup(parentIno: bigint, name: string): boolean;
  prepareLookup(parentIno: bigint, name: string): Promise<boolean>;
  prepareLookupForReply?(
    parentIno: bigint,
    name: string,
  ): Promise<bigint | undefined>;
  retainEntityProjectionLookup?(ino: bigint, count?: bigint): void;
  releaseEntityProjectionLookup?(ino: bigint, count?: bigint): void;
  retainEntityProjectionOpen?(ino: bigint): void;
  releaseEntityProjectionOpen?(ino: bigint): void;
}

export interface DirectorySnapshotEntry {
  readonly name: string;
  readonly ino: bigint;
  readonly mode: number;
}

/** Capture the current directory entries and modes in iteration order. */
export function collectDirectorySnapshot(
  tree: FsTree,
  ino: bigint,
  isWritable: (childIno: bigint) => boolean = () => false,
): DirectorySnapshotEntry[] {
  const entries: DirectorySnapshotEntry[] = [
    { name: ".", ino, mode: DIR_MODE },
    {
      name: "..",
      ino: tree.parents.get(ino) ?? tree.rootIno,
      mode: DIR_MODE,
    },
  ];
  for (const [name, childIno] of tree.getChildren(ino)) {
    const child = tree.getNode(childIno);
    if (!child) continue;
    entries.push({
      name,
      ino: childIno,
      mode: nodeMode(child, isWritable(childIno)),
    });
  }
  return entries;
}

/** Capture virtual directory names without adding them to the inode tree. */
export function collectVirtualDirectorySnapshot(
  tree: FsTree,
  ino: bigint,
  names: readonly string[],
): DirectorySnapshotEntry[] {
  return [
    { name: ".", ino, mode: DIR_MODE },
    {
      name: "..",
      ino: tree.parents.get(ino) ?? tree.rootIno,
      mode: DIR_MODE,
    },
    ...names.map((name) => ({
      name,
      ino: tree.lookup(ino, name) ?? 0n,
      mode: DIR_MODE,
    })),
  ];
}

interface DirectoryHandleState {
  entries?: readonly DirectorySnapshotEntry[];
  ino: bigint;
  pending?: Promise<readonly DirectorySnapshotEntry[] | undefined>;
  prepared: boolean;
}

/** Tracks whether a directory has been prepared for an open FUSE handle. */
export class DirectoryHandleMap {
  #nextFh = 1n;
  #handles = new Map<bigint, DirectoryHandleState>();

  open(ino: bigint): bigint {
    const fh = this.#nextFh++;
    this.#handles.set(fh, { ino, prepared: false });
    return fh;
  }

  isPrepared(fh: bigint, ino: bigint): boolean {
    const state = this.#handles.get(fh);
    return state?.ino === ino && state.prepared;
  }

  markPrepared(fh: bigint, ino: bigint): void {
    const state = this.#handles.get(fh);
    if (state?.ino === ino) {
      state.pending = undefined;
      state.prepared = true;
    }
  }

  pending(
    fh: bigint,
    ino: bigint,
  ): Promise<readonly DirectorySnapshotEntry[] | undefined> | undefined {
    const state = this.#handles.get(fh);
    return state?.ino === ino ? state.pending : undefined;
  }

  trackPending(
    fh: bigint,
    ino: bigint,
    pending: Promise<readonly DirectorySnapshotEntry[] | undefined>,
  ): void {
    const state = this.#handles.get(fh);
    if (state?.ino === ino) state.pending = pending;
  }

  clearPending(
    fh: bigint,
    ino: bigint,
    pending: Promise<readonly DirectorySnapshotEntry[] | undefined>,
  ): void {
    const state = this.#handles.get(fh);
    if (state?.ino === ino && state.pending === pending) {
      state.pending = undefined;
    }
  }

  close(fh: bigint): void {
    this.#handles.delete(fh);
  }

  has(fh: bigint, ino: bigint): boolean {
    return this.#handles.get(fh)?.ino === ino;
  }

  snapshot(
    fh: bigint,
    ino: bigint,
    create: () => DirectorySnapshotEntry[],
  ): readonly DirectorySnapshotEntry[] {
    const state = this.#handles.get(fh);
    if (state?.ino !== ino) return create();
    state.entries ??= create();
    return state.entries;
  }

  setSnapshot(
    fh: bigint,
    ino: bigint,
    entries: readonly DirectorySnapshotEntry[],
  ): void {
    const state = this.#handles.get(fh);
    if (state?.ino === ino) state.entries = entries;
  }
}

/**
 * Shared state transitions for the FUSE lookup, forget, opendir, readdir, and
 * releasedir callbacks. Tests use this class without loading libfuse.
 */
export class FuseOperationState {
  readonly directoryHandles = new DirectoryHandleMap();

  readonly #tree: FsTree;
  readonly #preparer: FuseOperationPreparer | null | undefined;
  readonly #isWritable: (ino: bigint) => boolean;

  constructor(
    tree: FsTree,
    preparer: FuseOperationPreparer | null | undefined,
    isWritable: (ino: bigint) => boolean = () => false,
  ) {
    this.#tree = tree;
    this.#preparer = preparer;
    this.#isWritable = isWritable;
  }

  lookup(parentIno: bigint, name: string): bigint | undefined {
    const ino = this.#tree.lookup(parentIno, name);
    return ino !== undefined && this.#tree.getNode(ino) !== undefined
      ? ino
      : undefined;
  }

  async prepareLookup(
    parentIno: bigint,
    name: string,
  ): Promise<bigint | undefined> {
    if (this.#preparer?.prepareLookupForReply) {
      return await this.#preparer.prepareLookupForReply(parentIno, name);
    }
    if (!this.#preparer?.shouldPrepareLookup(parentIno, name)) {
      const ino = this.lookup(parentIno, name);
      if (ino !== undefined) this.retainLookup(ino);
      return ino;
    }
    if (!await this.#preparer.prepareLookup(parentIno, name)) return undefined;
    const ino = this.lookup(parentIno, name);
    if (ino !== undefined) this.retainLookup(ino);
    return ino;
  }

  retainLookup(ino: bigint): void {
    this.#preparer?.retainEntityProjectionLookup?.(ino);
  }

  forget(ino: bigint, nlookup: bigint): void {
    this.#preparer?.releaseEntityProjectionLookup?.(ino, nlookup);
  }

  openDirectory(ino: bigint): bigint | undefined {
    if (this.#tree.getNode(ino)?.kind !== "dir") return undefined;
    const fh = this.directoryHandles.open(ino);
    this.#preparer?.retainEntityProjectionOpen?.(ino);
    return fh;
  }

  prepareDirectory(
    fh: bigint,
    ino: bigint,
  ): Promise<readonly DirectorySnapshotEntry[] | undefined> | undefined {
    return prepareDirectoryForHandle(
      this.directoryHandles,
      fh,
      ino,
      this.#preparer,
    );
  }

  directorySnapshot(
    fh: bigint,
    ino: bigint,
    preparedEntries?: readonly DirectorySnapshotEntry[],
  ): readonly DirectorySnapshotEntry[] {
    return preparedEntries ??
      this.directoryHandles.snapshot(
        fh,
        ino,
        () => collectDirectorySnapshot(this.#tree, ino, this.#isWritable),
      );
  }

  closeDirectory(fh: bigint, ino: bigint): void {
    if (!this.directoryHandles.has(fh, ino)) return;
    this.directoryHandles.close(fh);
    this.#preparer?.releaseEntityProjectionOpen?.(ino);
  }
}

/** Visit directory entries using the continuation offsets passed to libfuse. */
export function visitDirectoryEntries(
  entries: readonly DirectorySnapshotEntry[],
  startOffset: number,
  visit: (entry: DirectorySnapshotEntry, nextOffset: number) => boolean,
): void {
  for (let index = startOffset; index < entries.length; index++) {
    if (!visit(entries[index], index + 1)) return;
  }
}

/** Roll back retained request state when libfuse rejects a reply. */
export function replyWithRetainedState(
  reply: () => number,
  rollback: () => void,
): boolean {
  let accepted = false;
  try {
    accepted = reply() === 0;
    return accepted;
  } finally {
    if (!accepted) rollback();
  }
}

/**
 * Prepare a dynamic directory unless this open handle already owns a prepared
 * snapshot. Calls without a tracked handle preserve the legacy behavior and
 * prepare on every read.
 */
export function prepareDirectoryForHandle(
  handles: DirectoryHandleMap,
  fh: bigint,
  ino: bigint,
  preparer: DirectoryPreparer | null | undefined,
): Promise<readonly DirectorySnapshotEntry[] | undefined> | undefined {
  if (handles.isPrepared(fh, ino)) return undefined;

  const tracked = handles.has(fh, ino);
  const pending = handles.pending(fh, ino);
  if (pending) return pending;
  if (!preparer?.shouldPrepareDirectory(ino)) {
    if (tracked) handles.markPrepared(fh, ino);
    return undefined;
  }

  const preparation = (
    preparer.prepareDirectorySnapshot
      ? preparer.prepareDirectorySnapshot(ino)
      : preparer.prepareDirectory(ino).then(() => undefined)
  ).then((entries) => {
    if (tracked) {
      if (entries) handles.setSnapshot(fh, ino, entries);
      handles.markPrepared(fh, ino);
    }
    return entries;
  });
  if (!tracked) return preparation;

  const trackedPreparation = preparation.finally(() => {
    handles.clearPending(fh, ino, trackedPreparation);
  });
  handles.trackPending(fh, ino, trackedPreparation);
  return trackedPreparation;
}

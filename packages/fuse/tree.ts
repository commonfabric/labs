/**
 * The in-memory filesystem tree the FUSE mount serves, with its inode
 * management. The filesystem spec under `docs/specs/fuse-filesystem/` decides
 * the behavior here: `4-read-write.md` for stat, read, and write semantics,
 * inode assignment, and the cell-error-to-errno mapping; `6-reactivity.md`
 * for how a cell change rebuilds a subtree and invalidates kernel caches, and
 * the cache timeouts that bound how long a client can hold a stale entry;
 * `10-cfc-filesystem-api-semantics.md` for the errno decision table.
 * `packages/fuse/RELIABILITY_DESIGN.md` says which module owns which state,
 * and `packages/fuse/README.md` covers mount options and client-side cache
 * tuning.
 */

import type { CallableKind } from "./callables.ts";
import {
  type CfcDirectoryEntryAnnotation,
  cfcDirectoryEntryKind,
  cfcDirectoryEntryNameDigest,
  type CfcNodeAnnotation,
} from "./annotations.ts";
import type { FsNode, JsonType } from "./types.ts";

/** Inode of the root directory. */
const ROOT_INO = 1n;

/** Encoder for content given as a string. */
const encoder = new TextEncoder();

/**
 * The kernel caches that a transplant invalidated.
 *
 * `changedInodes` lists inodes that survived the transplant but whose file
 * data, symlink target or callable script changed, so their cached data and
 * attributes are stale. `entryChanges` maps a directory inode to the child
 * names whose directory entry changed — a name that appeared, disappeared, or
 * now points at a different inode — so the directory's cached listing for
 * exactly those names is stale. Names that kept their inode are absent from
 * both, which is what lets the caller leave unchanged entries cached.
 */
export interface TransplantChanges {
  /** Inodes whose cached data and attributes are stale. */
  changedInodes: Set<bigint>;

  /** Per directory inode, the child names whose cached entry is stale. */
  entryChanges: Map<bigint, Set<string>>;
}

/** Returns whether `a` and `b` hold the same bytes. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Runs a generated file's renderer and returns bytes the tree owns. A string
 * is encoded, which already yields a fresh array; a `Uint8Array` is copied, so
 * a renderer reusing its buffer cannot mutate the published content.
 */
function ownedRender(render: () => Uint8Array | string): Uint8Array {
  const rendered = render();
  return typeof rendered === "string"
    ? encoder.encode(rendered)
    : new Uint8Array(rendered);
}

/**
 * In-memory filesystem tree: nodes by inode, each directory's children by
 * name, and parent, path, and name indexes kept in step with them. Inode 1 is
 * the root directory, and every other inode is allocated once and never
 * reused. A node is a directory, a file, a symlink, or a callable, as `FsNode`
 * says; a file may be generated, re-rendered by `refreshGenerated()` whenever
 * its size is asked for. A directory may carry a CFC annotation whose entry
 * list is indexed by name and sorted lazily, when it is next read.
 * `transplantSubtree()` reconciles a freshly built replacement onto a live
 * subtree so that surviving paths keep their inodes, and reports which kernel
 * caches went stale.
 */
export class FsTree {
  /** Nodes by inode. */
  #inodes: Map<bigint, FsNode> = new Map();

  /** Parent inode by child inode. */
  #parents: Map<bigint, bigint> = new Map();

  /** Inode by absolute path. */
  #paths: Map<string, bigint> = new Map();

  /** Absolute path by inode; the inverse of `#paths`. */
  #inoPaths: Map<bigint, string> = new Map();

  /** Name of each inode's entry in its parent. */
  #inoNames: Map<bigint, string> = new Map();

  /** Renderers of the files added by `addGeneratedFile()`, by inode. */
  #generated: Map<bigint, () => Uint8Array | string> = new Map();

  /**
   * Position of each name in an annotated directory's entry list, by directory
   * inode.
   */
  #cfcEntryIndexes = new Map<bigint, Map<string, number>>();

  /**
   * Annotated directories whose entry list has changed since it was last
   * sorted.
   */
  #unsortedCfcEntryDirectories = new Set<bigint>();

  /** The inode the next allocation returns. */
  #nextIno = 2n;

  /** Clock that mtimes are read from, in milliseconds. */
  #now: () => number;

  /**
   * Constructs an instance holding only the root directory, with mtimes read
   * from `now`.
   */
  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
    // Create root directory (inode 1)
    this.#inodes.set(ROOT_INO, {
      kind: "dir",
      children: new Map(),
      mtime: this.#now(),
    });
    this.#paths.set("/", ROOT_INO);
    this.#inoPaths.set(ROOT_INO, "/");
  }

  //
  // Instance members
  //

  /**
   * The lookup indexes this tree keeps, one per annotated directory, which a
   * test drives directly.
   */
  get accessForTestingOnly(): {
    readonly cfcEntryIndexes: Map<bigint, Map<string, number>>;
  } {
    return {
      cfcEntryIndexes: this.#cfcEntryIndexes,
    };
  }

  /** Nodes by inode. */
  get inodes(): Map<bigint, FsNode> {
    return this.#inodes;
  }

  /** Parent inode by child inode. */
  get parents(): Map<bigint, bigint> {
    return this.#parents;
  }

  /** Inode by absolute path. */
  get paths(): Map<string, bigint> {
    return this.#paths;
  }

  /** Inode of the root directory. */
  get rootIno(): bigint {
    return ROOT_INO;
  }

  /** Allocates the next unused inode number. */
  allocInode(): bigint {
    return this.#nextIno++;
  }

  /** Returns the path an entry named `name` under `parentIno` would have. */
  childPath(parentIno: bigint, name: string): string {
    const parentPath = this.getPath(parentIno);
    return parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
  }

  /**
   * Adds a directory named `name` under `parentIno`, with `jsonType` saying
   * which JSON container it projects when it projects one, and returns its
   * inode.
   *
   * @throws If `parentIno` is not a directory.
   */
  addDir(
    parentIno: bigint,
    name: string,
    jsonType?: "object" | "array",
  ): bigint {
    const parent = this.#inodes.get(parentIno);
    if (!parent || parent.kind !== "dir") {
      throw new Error(`Parent inode ${parentIno} is not a directory`);
    }

    const ino = this.allocInode();
    const node: FsNode = {
      kind: "dir",
      children: new Map(),
      jsonType,
      mtime: this.#now(),
    };
    this.#inodes.set(ino, node);
    parent.children.set(name, ino);
    this.#parents.set(ino, parentIno);
    this.#trackPath(ino, parentIno, name);

    return ino;
  }

  /**
   * Adds a file named `name` under `parentIno` holding `content` — a string
   * is encoded as UTF-8 — and projecting a JSON value of `jsonType`, and
   * returns its inode.
   *
   * @throws If `parentIno` is not a directory.
   */
  addFile(
    parentIno: bigint,
    name: string,
    content: Uint8Array | string,
    jsonType: "string" | "number" | "boolean" | "null" | "object" | "array",
  ): bigint {
    const parent = this.#inodes.get(parentIno);
    if (!parent || parent.kind !== "dir") {
      throw new Error(`Parent inode ${parentIno} is not a directory`);
    }

    const ino = this.allocInode();
    const data = typeof content === "string"
      ? encoder.encode(content)
      : content;
    const node: FsNode = {
      kind: "file",
      content: data,
      jsonType,
      mtime: this.#now(),
    };
    this.#inodes.set(ino, node);
    parent.children.set(name, ino);
    this.#parents.set(ino, parentIno);
    this.#trackPath(ino, parentIno, name);

    return ino;
  }

  /**
   * Adds a file whose bytes are produced by `render` rather than written.
   *
   * The node's content is whatever `refreshGenerated()` last published, and
   * reads serve that. A client stops a read at the size it last learned, so the
   * size a caller reports and the bytes it later serves have to come from one
   * render: publish where the size is reported. A render returning a
   * `Uint8Array` is copied, so a renderer reusing its buffer cannot change the
   * published content out from under a reader.
   */
  addGeneratedFile(
    parentIno: bigint,
    name: string,
    render: () => Uint8Array | string,
    jsonType: JsonType,
  ): bigint {
    const ino = this.addFile(parentIno, name, ownedRender(render), jsonType);
    this.#generated.set(ino, render);
    return ino;
  }

  /**
   * Re-renders a generated file and publishes the result as its content.
   *
   * Returns the published bytes, or `undefined` when `ino` is not a generated
   * file. Call this where the file's size is about to be reported, so that the
   * size a client caches and the bytes a following read serves are one render.
   *
   * A render equal to the published one leaves the content and the node's mtime
   * alone, so the mtime moves only when the bytes do, and then always forward.
   */
  refreshGenerated(ino: bigint): Uint8Array | undefined {
    const render = this.#generated.get(ino);
    if (render === undefined) return undefined;
    const node = this.#inodes.get(ino);
    if (!node || node.kind !== "file") return undefined;
    const bytes = ownedRender(render);
    if (bytesEqual(node.content, bytes)) return node.content;
    this.#bumpMtime(node);
    node.content = bytes;
    return node.content;
  }

  /** Returns whether `ino` was added by `addGeneratedFile()`. */
  isGenerated(ino: bigint): boolean {
    return this.#generated.has(ino);
  }

  /**
   * Adds a callable file named `name` under `parentIno` — a `callableKind` on
   * `cellKey` of the piece's `cellProp` cell, run by `script` — and returns
   * its inode.
   *
   * @throws If `parentIno` is not a directory.
   */
  addCallable(
    parentIno: bigint,
    name: string,
    callableKind: CallableKind,
    cellKey: string,
    cellProp: "input" | "result",
    script: Uint8Array,
  ): bigint {
    const parent = this.#inodes.get(parentIno);
    if (!parent || parent.kind !== "dir") {
      throw new Error(`Parent inode ${parentIno} is not a directory`);
    }

    const ino = this.allocInode();
    const node: FsNode = {
      kind: "callable",
      callableKind,
      cellKey,
      cellProp,
      script,
      mtime: this.#now(),
    };
    this.#inodes.set(ino, node);
    parent.children.set(name, ino);
    this.#parents.set(ino, parentIno);
    this.#trackPath(ino, parentIno, name);

    return ino;
  }

  /**
   * Adds a symlink named `name` under `parentIno` pointing at `target`, and
   * returns its inode.
   *
   * @throws If `parentIno` is not a directory.
   */
  addSymlink(parentIno: bigint, name: string, target: string): bigint {
    const parent = this.#inodes.get(parentIno);
    if (!parent || parent.kind !== "dir") {
      throw new Error(`Parent inode ${parentIno} is not a directory`);
    }

    const ino = this.allocInode();
    const node: FsNode = { kind: "symlink", target, mtime: this.#now() };
    this.#inodes.set(ino, node);
    parent.children.set(name, ino);
    this.#parents.set(ino, parentIno);
    this.#trackPath(ino, parentIno, name);

    return ino;
  }

  /**
   * Returns the inode of `name` under `parentIno`, or `undefined` when
   * `parentIno` is not a directory or has no such entry.
   */
  lookup(parentIno: bigint, name: string): bigint | undefined {
    const parent = this.#inodes.get(parentIno);
    if (!parent || parent.kind !== "dir") return undefined;
    return parent.children.get(name);
  }

  /** Returns the node at `ino`, or `undefined` when there is none. */
  getNode(ino: bigint): FsNode | undefined {
    return this.#inodes.get(ino);
  }

  /**
   * Advances a node's mtime, for an entry-set change that no transplant
   * reports. Content changes and transplant-reconciled entry changes advance
   * mtime on their own. Does nothing for an inode with no node.
   */
  touch(ino: bigint): void {
    const node = this.#inodes.get(ino);
    if (node) this.#bumpMtime(node);
  }

  /**
   * Sets `ino`'s CFC annotation, replacing any it had, and rebuilds the name
   * index over its entries.
   *
   * @throws If `ino` does not exist.
   */
  setCfcAnnotation(ino: bigint, annotation: CfcNodeAnnotation): void {
    const node = this.#inodes.get(ino);
    if (!node) {
      throw new Error(`Inode ${ino} does not exist`);
    }
    node.cfc = annotation;
    this.#rebuildCfcEntryIndex(ino, annotation);
  }

  /**
   * Returns `ino`'s CFC annotation, its entries sorted by name digest, or
   * `undefined` when it has none.
   */
  getCfcAnnotation(ino: bigint): CfcNodeAnnotation | undefined {
    this.#sortCfcEntries(ino);
    return this.#inodes.get(ino)?.cfc;
  }

  /**
   * Sets the annotation of the entry `name` in the annotated directory
   * `parentIno`, appending or replacing, and leaves the entry list to be sorted
   * on the next read. Does nothing for a directory carrying no entry
   * annotations.
   */
  setCfcEntryAnnotation(
    parentIno: bigint,
    name: string,
    entry: CfcDirectoryEntryAnnotation,
  ): void {
    const parent = this.#inodes.get(parentIno);
    if (!parent || parent.kind !== "dir" || !parent.cfc?.entries) return;
    const entries = parent.cfc.entries.entries;
    const index = this.#cfcEntryIndex(parentIno, entries);
    const existing = index.get(name);
    if (existing === undefined) {
      index.set(name, entries.length);
      entries.push(entry);
    } else {
      entries[existing] = entry;
    }
    this.#unsortedCfcEntryDirectories.add(parentIno);
  }

  /**
   * Returns the entries of the directory `ino` as name and inode pairs, in
   * insertion order; empty when `ino` is not a directory.
   */
  getChildren(ino: bigint): [string, bigint][] {
    const node = this.#inodes.get(ino);
    if (!node || node.kind !== "dir") return [];
    return [...node.children.entries()];
  }

  /**
   * Returns the absolute path of `ino`, or `/` for an inode with no tracked
   * path.
   */
  getPath(ino: bigint): string {
    return this.#inoPaths.get(ino) ?? "/";
  }

  /**
   * Updates a file node's content and, when given, its `jsonType`, advancing
   * its mtime only when the bytes change.
   *
   * @throws If `ino` is not a file, or is a generated file — a generated
   *   file's content comes from its renderer through `refreshGenerated()`, so
   *   writing it directly would be overwritten and is rejected.
   */
  updateFile(
    ino: bigint,
    content: Uint8Array | string,
    jsonType?: "string" | "number" | "boolean" | "null" | "object" | "array",
  ): void {
    const node = this.#inodes.get(ino);
    if (!node || node.kind !== "file") {
      throw new Error(`Inode ${ino} is not a file`);
    }
    if (this.#generated.has(ino)) {
      throw new Error(`Inode ${ino} is a generated file`);
    }
    const data = typeof content === "string"
      ? encoder.encode(content)
      : content;
    if (!bytesEqual(node.content, data)) {
      this.#bumpMtime(node);
    }
    node.content = data;
    if (jsonType !== undefined) {
      node.jsonType = jsonType;
    }
  }

  /**
   * Removes the entry `name` from the directory `parentIno` and clears its
   * subtree, and returns the inode removed, or `undefined` when there was no
   * such entry.
   */
  removeChild(parentIno: bigint, name: string): bigint | undefined {
    const parent = this.#inodes.get(parentIno);
    if (!parent || parent.kind !== "dir") return undefined;
    const childIno = parent.children.get(name);
    if (childIno === undefined) return undefined;
    // Don't use clear() since it also removes from parent — do it manually
    this.#clearSubtree(childIno);
    parent.children.delete(name);
    this.#removeCfcEntryAnnotation(parentIno, name);
    return childIno;
  }

  /**
   * Removes the entry `name` from the directory `parentIno` while retaining its
   * inode subtree, and returns the inode detached, or `undefined` when there
   * was no such entry.
   *
   * FUSE can keep an inode alive after its final directory entry disappears.
   * The caller clears the detached subtree after the kernel releases its lookup
   * and open references.
   */
  detachChild(parentIno: bigint, name: string): bigint | undefined {
    const parent = this.#inodes.get(parentIno);
    if (!parent || parent.kind !== "dir") return undefined;
    const childIno = parent.children.get(name);
    if (childIno === undefined) return undefined;
    parent.children.delete(name);
    this.#removeCfcEntryAnnotation(parentIno, name);
    return childIno;
  }

  /**
   * Moves the entry `oldName` under `oldParentIno` to `newName` under
   * `newParentIno`, replacing any entry already there, and carries its CFC
   * entry annotation and path tracking along.
   *
   * @throws If either parent is not a directory, or `oldName` is not an entry
   *   of `oldParentIno`.
   */
  rename(
    oldParentIno: bigint,
    oldName: string,
    newParentIno: bigint,
    newName: string,
  ): void {
    const oldParent = this.#inodes.get(oldParentIno);
    if (!oldParent || oldParent.kind !== "dir") {
      throw new Error(`Old parent ${oldParentIno} is not a directory`);
    }
    const childIno = oldParent.children.get(oldName);
    if (childIno === undefined) {
      throw new Error(`Child "${oldName}" not found in parent ${oldParentIno}`);
    }

    const newParent = this.#inodes.get(newParentIno);
    if (!newParent || newParent.kind !== "dir") {
      throw new Error(`New parent ${newParentIno} is not a directory`);
    }
    const movedCfcEntry = this.#getCfcEntryAnnotation(oldParentIno, oldName);

    // If target exists, remove it first
    const existingIno = newParent.children.get(newName);
    if (existingIno !== undefined) {
      this.#clearSubtree(existingIno);
      this.#removeCfcEntryAnnotation(newParentIno, newName);
    }

    // Move the child
    oldParent.children.delete(oldName);
    this.#removeCfcEntryAnnotation(oldParentIno, oldName);
    newParent.children.set(newName, childIno);
    this.#parents.set(childIno, newParentIno);
    const child = this.#inodes.get(childIno);
    const childAnnotation = this.getCfcAnnotation(childIno);
    if (movedCfcEntry && child) {
      this.setCfcEntryAnnotation(newParentIno, newName, {
        ...movedCfcEntry,
        name: newName,
        nameDigest: cfcDirectoryEntryNameDigest(newName),
        childRef: childAnnotation?.ref ?? movedCfcEntry.childRef,
        kind: cfcDirectoryEntryKind(child),
        metadataLabels: childAnnotation?.metadataLabels ??
          movedCfcEntry.metadataLabels,
      });
    }

    // Update path tracking for moved node and all descendants
    this.#retrackSubtree(childIno, newParentIno, newName);
  }

  /**
   * Returns the name of `ino`'s entry in its parent, or `undefined` for an
   * inode with none.
   */
  getNameForIno(ino: bigint): string | undefined {
    return this.#inoNames.get(ino);
  }

  /**
   * Adopts an existing subtree's inodes into a freshly built replacement.
   *
   * `oldIno` roots the live subtree; `newIno` roots a replacement built with
   * fresh inodes under a staging name. The two roots must have the same node
   * kind. For every path present in both trees with the same node kind, the
   * existing inode survives: the replacement's content is copied onto it and
   * its inode number is preserved, so a client that cached the path keeps
   * resolving it. Paths only in the replacement move across keeping their
   * freshly allocated inodes; paths only in the old tree are removed. The
   * replacement's nodes are discarded as their content is adopted, leaving
   * `oldIno` in place at its original path carrying the new content.
   *
   * The whole operation is synchronous, so no filesystem request can observe a
   * half-adopted tree: callers build the replacement asynchronously under a
   * staging name, then call this to swap it in atomically.
   *
   * Returns the kernel caches that went stale; see {@link TransplantChanges}.
   *
   * @throws If either root does not exist, or the two differ in kind, or a name
   *   present in both subtrees has, in one of them, an entry with no node.
   */
  transplantSubtree(oldIno: bigint, newIno: bigint): TransplantChanges {
    const oldNode = this.#inodes.get(oldIno);
    const newNode = this.#inodes.get(newIno);
    if (!oldNode || !newNode) {
      throw new Error(`Transplant root ${oldIno} or ${newIno} does not exist`);
    }
    if (oldNode.kind !== newNode.kind) {
      throw new Error(
        `Transplant roots differ in kind: ${oldNode.kind} vs ${newNode.kind}`,
      );
    }
    const changes: TransplantChanges = {
      changedInodes: new Set(),
      entryChanges: new Map(),
    };
    this.#transplantNode(oldIno, oldNode, newIno, newNode, changes);
    this.#discardNodeShallow(newIno);
    return changes;
  }

  /**
   * Removes the subtree rooted at `ino`, the node itself and its entry in its
   * parent included. Does nothing for an inode with no node.
   */
  clear(ino: bigint): void {
    const node = this.#inodes.get(ino);
    if (!node) return;

    this.#unlinkFromParent(ino);
    this.#clearSubtree(ino);
  }

  /**
   * Records `ino` as the entry `name` under `parentIno` in the path and name
   * indexes.
   */
  #trackPath(ino: bigint, parentIno: bigint, name: string): void {
    const path = this.childPath(parentIno, name);
    this.#paths.set(path, ino);
    this.#inoPaths.set(ino, path);
    this.#inoNames.set(ino, name);
  }

  /**
   * Removes `ino` from the path and name indexes, leaving a path that has come
   * to name another inode alone.
   */
  #untrackPath(ino: bigint): void {
    const path = this.#inoPaths.get(ino);
    if (path !== undefined) {
      if (this.#paths.get(path) === ino) {
        this.#paths.delete(path);
      }
      this.#inoPaths.delete(ino);
      this.#inoNames.delete(ino);
    }
  }

  /**
   * Removes `ino`'s entry, and its CFC entry annotation, from its parent's
   * children. Does nothing for an inode with no parent.
   */
  #unlinkFromParent(ino: bigint): void {
    const parentIno = this.#parents.get(ino);
    if (parentIno === undefined) return;
    const parent = this.#inodes.get(parentIno);
    if (!parent || parent.kind !== "dir") return;
    for (const [name, childIno] of parent.children) {
      if (childIno === ino) {
        parent.children.delete(name);
        this.#removeCfcEntryAnnotation(parentIno, name);
        break;
      }
    }
  }

  /**
   * Rebuilds the name index over `annotation`'s entries for `ino`, dropping the
   * index when the annotation has no entries, and marks the entries sorted.
   */
  #rebuildCfcEntryIndex(
    ino: bigint,
    annotation: CfcNodeAnnotation | undefined,
  ): void {
    this.#unsortedCfcEntryDirectories.delete(ino);
    const entries = annotation?.entries?.entries;
    if (!entries) {
      this.#cfcEntryIndexes.delete(ino);
      return;
    }
    this.#cfcEntryIndexes.set(
      ino,
      new Map(entries.map((entry, index) => [entry.name, index])),
    );
  }

  /**
   * Returns the name index over `entries` for the directory `ino`, building it
   * on first use.
   */
  #cfcEntryIndex(
    ino: bigint,
    entries: readonly CfcDirectoryEntryAnnotation[],
  ): Map<string, number> {
    let index = this.#cfcEntryIndexes.get(ino);
    if (!index) {
      index = new Map(entries.map((entry, offset) => [entry.name, offset]));
      this.#cfcEntryIndexes.set(ino, index);
    }
    return index;
  }

  /**
   * Sorts the directory `ino`'s CFC entries by name digest and rebuilds its
   * index, if the entries have changed since the last sort.
   */
  #sortCfcEntries(ino: bigint): void {
    if (!this.#unsortedCfcEntryDirectories.delete(ino)) return;
    const node = this.#inodes.get(ino);
    if (!node || node.kind !== "dir" || !node.cfc?.entries) return;
    node.cfc.entries.entries.sort((left, right) =>
      left.nameDigest.localeCompare(right.nameDigest)
    );
    this.#rebuildCfcEntryIndex(ino, node.cfc);
  }

  /**
   * Removes the annotation of the entry `name` from the annotated directory
   * `parentIno`, moving the last entry into its slot, and leaves the list to be
   * sorted on the next read.
   */
  #removeCfcEntryAnnotation(parentIno: bigint, name: string): void {
    const parent = this.#inodes.get(parentIno);
    if (!parent || parent.kind !== "dir" || !parent.cfc?.entries) return;
    const entries = parent.cfc.entries.entries;
    const index = this.#cfcEntryIndex(parentIno, entries);
    const removedIndex = index.get(name);
    if (removedIndex === undefined) return;
    const lastIndex = entries.length - 1;
    const last = entries[lastIndex];
    entries.pop();
    index.delete(name);
    if (removedIndex !== lastIndex) {
      entries[removedIndex] = last;
      index.set(last.name, removedIndex);
    }
    this.#unsortedCfcEntryDirectories.add(parentIno);
  }

  /**
   * Returns the annotation of the entry `name` in the annotated directory
   * `parentIno`, or `undefined` when there is none.
   */
  #getCfcEntryAnnotation(
    parentIno: bigint,
    name: string,
  ): CfcDirectoryEntryAnnotation | undefined {
    const parent = this.#inodes.get(parentIno);
    if (!parent || parent.kind !== "dir" || !parent.cfc?.entries) {
      return undefined;
    }
    const entries = parent.cfc.entries.entries;
    const index = this.#cfcEntryIndex(parentIno, entries).get(name);
    return index === undefined ? undefined : entries[index];
  }

  /**
   * Removes `ino` and all of its descendants from every index, leaving `ino`'s
   * entry in its parent to the caller.
   */
  #clearSubtree(ino: bigint): void {
    const node = this.#inodes.get(ino);
    if (!node) return;
    if (node.kind === "dir") {
      for (const [, childIno] of node.children) {
        this.#clearSubtree(childIno);
      }
    }
    this.#inodes.delete(ino);
    this.#parents.delete(ino);
    this.#generated.delete(ino);
    this.#cfcEntryIndexes.delete(ino);
    this.#unsortedCfcEntryDirectories.delete(ino);
    this.#untrackPath(ino);
  }

  /**
   * Re-records the paths of `ino`, as `name` under `parentIno`, and of all of
   * its descendants.
   */
  #retrackSubtree(
    ino: bigint,
    parentIno: bigint,
    name: string,
  ): void {
    this.#untrackPath(ino);
    this.#trackPath(ino, parentIno, name);
    const node = this.#inodes.get(ino);
    if (node?.kind === "dir") {
      for (const [childName, childIno] of node.children) {
        this.#retrackSubtree(childIno, ino, childName);
      }
    }
  }

  /**
   * Helper for `transplantSubtree()`, which reconciles one replacement node
   * onto its live counterpart, recursing into directory children. `oldNode`
   * and `newNode` are the nodes of `oldIno` and `newIno`. Assumes the two nodes
   * share a kind. Leaves `newIno`'s node in place for the caller to discard
   * once its content has been adopted.
   *
   * @throws If a name present in both directories has, in one of them, an
   *   entry with no node.
   */
  #transplantNode(
    oldIno: bigint,
    oldNode: FsNode,
    newIno: bigint,
    newNode: FsNode,
    changes: TransplantChanges,
  ): void {
    // Move the replacement's annotation onto the surviving node and clear it
    // from the replacement so discarding the replacement's children can't
    // mutate the now-shared entries list out from under the survivor.
    this.#sortCfcEntries(newIno);
    oldNode.cfc = newNode.cfc;
    newNode.cfc = undefined;
    this.#rebuildCfcEntryIndex(oldIno, oldNode.cfc);
    this.#cfcEntryIndexes.delete(newIno);
    this.#unsortedCfcEntryDirectories.delete(newIno);

    if (this.#adoptContent(oldNode, newNode)) {
      this.#bumpMtime(oldNode);
      changes.changedInodes.add(oldIno);
    }

    if (oldNode.kind !== "dir" || newNode.kind !== "dir") return;

    const oldChildren = [...oldNode.children];
    const newChildren = [...newNode.children];
    const oldByName = new Map(oldChildren);
    const newByName = new Map(newChildren);
    let entriesChanged = false;

    for (const [name, newChildIno] of newChildren) {
      const oldChildIno = oldByName.get(name);
      if (oldChildIno !== undefined) {
        const oldChildNode = this.#inodes.get(oldChildIno);
        const newChildNode = this.#inodes.get(newChildIno);
        if (!oldChildNode || !newChildNode) {
          throw new Error(
            `Transplant child ${oldChildIno} or ${newChildIno} does not exist`,
          );
        }
        if (oldChildNode.kind === newChildNode.kind) {
          // Same path, same kind: the existing inode survives.
          this.#transplantNode(
            oldChildIno,
            oldChildNode,
            newChildIno,
            newChildNode,
            changes,
          );
          this.#discardNodeShallow(newChildIno);
          continue;
        }
      }

      // New path, or a kind change that forces a new inode. Drop any old
      // node at this name, then splice the replacement's subtree in with
      // its freshly allocated inodes.
      if (oldChildIno !== undefined) {
        this.#clearSubtree(oldChildIno);
      }
      oldNode.children.set(name, newChildIno);
      this.#parents.set(newChildIno, oldIno);
      this.#retrackSubtree(newChildIno, oldIno, name);
      FsTree.recordEntryChange(changes, oldIno, name);
      entriesChanged = true;
    }

    for (const [name, oldChildIno] of oldChildren) {
      if (newByName.has(name)) continue;
      // Present in the old tree, gone from the replacement: remove it.
      this.#clearSubtree(oldChildIno);
      oldNode.children.delete(name);
      FsTree.recordEntryChange(changes, oldIno, name);
      entriesChanged = true;
    }

    // A directory whose entry set changed has been modified; advance its mtime
    // so a client that revalidates by attribute sees the change.
    if (entriesChanged) {
      this.#bumpMtime(oldNode);
    }
  }

  /**
   * Advances a node's mtime on a content change. Clamps to strictly greater
   * than the node's previous mtime so two changes that land in the same
   * wall-clock millisecond still produce distinct times — a client
   * revalidating by attribute always sees a newer mtime after a content
   * change, even on a backend that ignores the inode-invalidation
   * notifications.
   */
  #bumpMtime(node: FsNode): void {
    node.mtime = Math.max(this.#now(), node.mtime + 1);
  }

  /**
   * Copies a replacement node's content onto its surviving counterpart.
   * Returns true if the file data, symlink target or callable script changed,
   * so the caller can invalidate the inode's cached data. A directory returns
   * false — its listing changes are reported through `entryChanges` instead.
   */
  #adoptContent(oldNode: FsNode, newNode: FsNode): boolean {
    if (oldNode.kind === "dir" && newNode.kind === "dir") {
      oldNode.jsonType = newNode.jsonType;
      return false;
    }
    if (oldNode.kind === "file" && newNode.kind === "file") {
      const changed = oldNode.jsonType !== newNode.jsonType ||
        !bytesEqual(oldNode.content, newNode.content);
      oldNode.content = newNode.content;
      oldNode.jsonType = newNode.jsonType;
      return changed;
    }
    if (oldNode.kind === "symlink" && newNode.kind === "symlink") {
      const changed = oldNode.target !== newNode.target;
      oldNode.target = newNode.target;
      return changed;
    }
    if (oldNode.kind === "callable" && newNode.kind === "callable") {
      const changed = oldNode.callableKind !== newNode.callableKind ||
        oldNode.cellKey !== newNode.cellKey ||
        oldNode.cellProp !== newNode.cellProp ||
        !bytesEqual(oldNode.script, newNode.script);
      oldNode.callableKind = newNode.callableKind;
      oldNode.cellKey = newNode.cellKey;
      oldNode.cellProp = newNode.cellProp;
      oldNode.script = newNode.script;
      return changed;
    }
    return false;
  }

  /**
   * Removes a single node from tracking without touching its children, which is
   * how a replacement node is dropped once its content has been adopted: its
   * children have already been adopted or moved, so recursing would wrongly
   * clear them.
   */
  #discardNodeShallow(ino: bigint): void {
    this.#unlinkFromParent(ino);
    this.#inodes.delete(ino);
    this.#parents.delete(ino);
    this.#generated.delete(ino);
    this.#cfcEntryIndexes.delete(ino);
    this.#unsortedCfcEntryDirectories.delete(ino);
    this.#untrackPath(ino);
  }

  //
  // Static members
  //

  /**
   * Records in `changes` that the entry `name` under the directory `parentIno`
   * changed, which mutates `changes` in place. Recording an entry already
   * recorded changes nothing.
   */
  static recordEntryChange(
    changes: TransplantChanges,
    parentIno: bigint,
    name: string,
  ): void {
    let names = changes.entryChanges.get(parentIno);
    if (!names) {
      names = new Set();
      changes.entryChanges.set(parentIno, names);
    }
    names.add(name);
  }
}

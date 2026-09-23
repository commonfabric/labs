/**
 * The `CellBridge` driven with fake pieces over an in-memory `FsTree`: what
 * a space's directories hold, when a projection is hydrated, rebuilt, or
 * evicted, and what a write, a reconnect, or a status read observes. The
 * `sourceRefreshWarning()` text a source write leaves behind is covered here
 * too. Nothing here mounts a filesystem.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";

import { defer } from "@commonfabric/utils/defer";
import { createSession, Identity } from "@commonfabric/identity";
import type { Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  type PieceController,
  PiecesController,
} from "@commonfabric/piece/ops";
import { decomposeSchema, Runtime } from "@commonfabric/runner";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { registerSchemaDocument } from "../runner/src/schema-registry.ts";
import {
  type Options as V2StorageOptions,
  type SessionFactory,
  StorageManager as V2StorageManager,
} from "../runner/src/storage/v2.ts";
import { FsTree } from "./tree.ts";
import {
  CellBridge,
  type EntityProjectionLookupOwner,
  type SourceWritePath,
  type SpaceState,
  type UnhydratedEntityRootInfo,
  type WritePath,
} from "./cell-bridge.ts";
import {
  collectDirectorySnapshot,
  DirectoryHandleMap,
  FuseOperationState,
  prepareDirectoryForHandle,
  visitDirectoryEntries,
} from "./directory-handles.ts";
import {
  CFC_COMPAT_XATTR_PREFIX,
  CFC_FAIL_CLOSED_ATOM_CLASS,
  listCfcXattrNames,
} from "./annotations.ts";
import { encodeFuseComponent } from "./path-codec.ts";
import {
  finalizeCommittedSourceWrite,
  sourceRefreshWarning,
} from "./source-write-finalize.ts";

//
// Shared helpers
//

const decoder = new TextDecoder();

class IterationCountingMap<K, V> extends Map<K, V> {
  iteratedEntries = 0;

  override *[Symbol.iterator](): MapIterator<[K, V]> {
    for (const entry of super[Symbol.iterator]()) {
      this.iteratedEntries++;
      yield entry;
    }
    return undefined;
  }
}

interface FakeCell {
  schema: Record<string, unknown> | undefined;
  get(): unknown;
  getRaw(): unknown;
  asSchemaFromLinks(): FakeCell;
  key(segment: string): FakeCell;
  sink?: (fn: (v: unknown) => void) => () => void;
  isStream?: () => boolean;
}

function makeCell(
  value: unknown,
  schema: Record<string, unknown> | undefined,
  children: Record<string, FakeCell> = {},
  options: { isStream?: boolean } = {},
): FakeCell {
  return {
    schema,
    get: () => value,
    getRaw: () => value,
    asSchemaFromLinks() {
      return this;
    },
    key(segment: string) {
      return children[segment] ?? makeCell(undefined, undefined);
    },
    sink: () => () => {},
    isStream: options.isStream ? () => true : undefined,
  };
}

/**
 * The surface of a `PieceController` these tests stand in for: the members
 * the bridge reads, each optional so that a fake carries only what its case
 * touches.
 */
interface FakePiece {
  id: string;
  name?: () => string | undefined;
  getCell?: () => unknown;
  getPatternRef?: () => Promise<unknown>;
  getPatternSourceProgram?: () => Promise<unknown>;
  input?: FakePieceProp;
  result?: FakePieceProp;
}

/** One of a `FakePiece`'s `input` and `result` props. */
interface FakePieceProp {
  getCell: () => Promise<FakeCell>;
  get: (path?: (string | number)[]) => Promise<unknown>;
  set?: (value: unknown, path?: (string | number)[]) => Promise<void>;
}

/**
 * A fake piece declared as the `PieceController` the bridge takes it for,
 * which is the one place a fake crosses that line.
 */
function fakePiece(piece: FakePiece): PieceController {
  return piece as unknown as PieceController;
}

/**
 * A `FakeCell` that supports `sink()` subscriptions, enabling reactive rename
 * tests.
 */
class SinkableCell {
  _value: unknown;
  _sinks: Array<(v: unknown) => void> = [];
  schema = undefined;
  #root: SinkableCell;
  #path: string[];

  constructor(value: unknown, root?: SinkableCell, path: string[] = []) {
    this._value = value;
    this.#root = root ?? this;
    this.#path = path;
  }

  get() {
    let current = this.#root._value;
    for (const segment of this.#path) {
      if (!isObjectNotArray(current)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }

  getRaw() {
    return this.get();
  }

  set(v: unknown) {
    if (this.#root !== this) {
      throw new Error("set() is only supported on the root SinkableCell");
    }
    this._value = v;
    for (const fn of this._sinks) fn(v);
  }

  asSchemaFromLinks(): FakeCell {
    return this as unknown as FakeCell;
  }

  key(segment: string): FakeCell {
    return new SinkableCell(undefined, this.#root, [
      ...this.#path,
      segment,
    ]) as unknown as FakeCell;
  }

  sink(fn: (v: unknown) => void): () => void {
    if (this.#root !== this) {
      return this.#root.sink(() => fn(this.get()));
    }
    this._sinks.push(fn);
    return () => {
      this._sinks = this._sinks.filter((s) => s !== fn);
    };
  }
}

class PatternIdentityCell {
  #sinks = new Map<string, Set<() => void>>();

  asSchema() {
    return { sync: () => Promise.resolve() };
  }

  sinkMeta(key: string, sink: () => void): () => void {
    let sinks = this.#sinks.get(key);
    if (!sinks) {
      sinks = new Set();
      this.#sinks.set(key, sinks);
    }
    sinks.add(sink);
    return () => {
      const current = this.#sinks.get(key);
      current?.delete(sink);
      if (current?.size === 0) this.#sinks.delete(key);
    };
  }

  emit(key = "patternIdentity"): void {
    for (const sink of this.#sinks.get(key) ?? []) sink();
  }
}

function getFileContent(tree: FsTree, parentIno: bigint, name: string): string {
  const ino = tree.lookup(parentIno, name);
  if (ino === undefined) throw new Error(`File "${name}" not found`);
  const node = tree.getNode(ino);
  if (!node || node.kind !== "file") throw new Error(`"${name}" is not a file`);
  return decoder.decode(node.content);
}

/**
 * A source write path for a piece, as the flush path would hand one over;
 * `piece` is what a finalize consults, and the default serves callers whose
 * finalize never does.
 */
function sourceWritePath(
  spaceName: string,
  pieceName: string,
  srcIno: bigint,
  piece: unknown = {},
): SourceWritePath {
  return {
    spaceName,
    pieceName,
    relPath: "main.tsx",
    piece: piece as never,
    srcIno,
  };
}

/** Collect `console.error` lines for the length of one call. */
function captureConsoleErrors(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  return {
    lines,
    restore: () => {
      console.error = original;
    },
  };
}

/**
 * Read `.status` the way the daemon serves it: the getattr that reports the
 * file's size publishes a render, and the read that follows serves those bytes.
 */
function readStatusFile(tree: FsTree): string {
  tree.refreshGenerated(tree.lookup(tree.rootIno, ".status")!);
  return getFileContent(tree, tree.rootIno, ".status");
}

/**
 * Build a minimal SpaceState backed by a fake PiecesController.
 * Registers the state in bridge.spaces and bridge.knownSpaces.
 */
function buildTestSpace(
  bridge: CellBridge,
  spaceName: string,
  fakePieces: unknown[],
): SpaceState {
  const tree = bridge.tree;
  const spaceIno = tree.addDir(tree.rootIno, encodeFuseComponent(spaceName));
  const piecesIno = tree.addDir(spaceIno, "pieces");
  const entitiesIno = tree.addDir(spaceIno, "entities");

  const state: SpaceState = {
    pieces: {
      listEntityIds: () => Promise.resolve(undefined),
      getPieceRegistry: () => Promise.resolve({ sink: () => () => {} }),
      getRegisteredPieces: () => Promise.resolve(fakePieces),
    } as unknown as SpaceState["pieces"],
    spaceIno,
    piecesIno,
    entitiesIno,
    pieceMap: new Map(),
    pieceInos: new Map(),
    pieceControllers: new Map(),
    entityControllers: new Map(),
    allPieceIds: new Set(),
    entityIds: new Set(),
    piecesHydrated: true,
    piecesMaterializing: false,
    pieceListSubscribed: true,
    pieceManifest: new Map(),
    pieceSubs: new Map(),
    did: "did:key:zTest",
    unsubscribes: [],
    usedNames: new Set(),
    srcInos: new Map(),
    srcErrorLogInos: new Map(),
  };

  bridge.spaces.set(spaceName, state);
  bridge.knownSpaces.set(spaceName, state.did);
  return state;
}

async function openDirectorySnapshot(
  bridge: CellBridge,
  ino: bigint,
) {
  const handles = new DirectoryHandleMap();
  const fh = handles.open(ino);
  const prepared = await prepareDirectoryForHandle(handles, fh, ino, bridge);
  return prepared ?? handles.snapshot(
    fh,
    ino,
    () => collectDirectorySnapshot(bridge.tree, ino),
  );
}

/**
 * An `FsTree` that refuses to add one named entry, throwing `failure`; every
 * other add goes through.
 */
class RefusingTree extends FsTree {
  #refusedName: string;
  #failure: Error;

  /** Constructs an instance which throws `failure` at every add of `name`. */
  constructor(name: string, failure: Error) {
    super();
    this.#refusedName = name;
    this.#failure = failure;
  }

  override addDir(
    parentIno: bigint,
    name: string,
    jsonType?: "object" | "array",
  ): bigint {
    if (name === this.#refusedName) throw this.#failure;
    return super.addDir(parentIno, name, jsonType);
  }

  override addFile(
    parentIno: bigint,
    name: string,
    content: Uint8Array | string,
    jsonType: "string" | "number" | "boolean" | "null" | "object" | "array",
  ): bigint {
    if (name === this.#refusedName) throw this.#failure;
    return super.addFile(parentIno, name, content, jsonType);
  }
}

//
// Tests
//

describe("cell-bridge", () => {
  describe("CellBridge", () => {
    describe("constructor()", () => {
      it("throws a `RangeError` for an entity projection cache limit that is not a positive integer", () => {
        // An `Error` instance pins both the class and the message.

        for (const maxEntityProjections of [0, -1, 1.5, Number.NaN]) {
          expect(() =>
            new CellBridge(new FsTree(), "/tmp/cf-exec", {
              maxEntityProjections,
            })
          ).toThrow(
            new RangeError("maxEntityProjections must be a positive integer"),
          );
        }
      });
    });

    describe("instance members", () => {
      describe("connectSpace()", () => {
        it("removes the space's partial state after a late connection failure", async () => {
          // The failure lands at the connect's index write, after the space's
          // tree and state exist: the tree refuses `.index.json`. The space's
          // tree and state, and the per-space table entries seeded here as a
          // connect could have left them, must be gone afterward, and the
          // failing dispose of the space's runtime is warned about, not thrown.

          const connectionFailure = new Error("manifest generation failed");
          const tree = new RefusingTree(".index.json", connectionFailure);
          let disposeCalls = 0;
          const spacePieces = {
            getSpace: () => "did:key:zFailedSpace",
            runtime: {
              dispose: () => {
                disposeCalls++;
                return Promise.reject(new Error("dispose failed"));
              },
            },
          } as unknown as SpaceState["pieces"];
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            loadPieces: () => Promise.resolve(spacePieces),
          });
          bridge.init({ apiUrl: "https://example.invalid", identity: "test" });

          const internals = bridge.accessForTestingOnly;
          internals.pendingPieceHydrations.set("home", Promise.resolve());
          internals.pieceSyncs.set("home", Promise.resolve());
          internals.syncAgain.add("home");

          const warnings: unknown[][] = [];
          const originalWarn = console.warn;
          console.warn = (...args: unknown[]) => warnings.push(args);
          try {
            await expect(bridge.connectSpace("home")).rejects.toThrow(
              connectionFailure.message,
            );
          } finally {
            console.warn = originalWarn;
          }

          expect(disposeCalls).toBe(1);
          expect(warnings.length).toBe(1);
          expect(String(warnings[0][0])).toContain("dispose failed");
          expect(tree.lookup(tree.rootIno, encodeFuseComponent("home")))
            .toBeUndefined();
          expect(bridge.spaces.has("home")).toBe(false);
          expect(bridge.knownSpaces.has("home")).toBe(false);
          expect(bridge.isConnecting("home")).toBe(false);
          expect(internals.pendingPieceHydrations.has("home")).toBe(false);
          expect(internals.pieceSyncs.has("home")).toBe(false);
          expect(internals.syncAgain.has("home")).toBe(false);
        });

        it("keeps a mounted space visible when identifier listing fails", async () => {
          const tree = new FsTree();
          const entityId = "of:fid1:retry-entity";
          let managerLoads = 0;
          let listRequests = 0;
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            loadPieces: () => {
              managerLoads++;
              return Promise.resolve(
                {
                  getSpace: () => "did:key:zRetrySpace",
                  listEntityIdPage: () => {
                    listRequests++;
                    return listRequests === 1
                      ? Promise.reject(new Error("identifier list unavailable"))
                      : Promise.resolve({ serverSeq: 1, ids: [entityId] });
                  },
                } as unknown as SpaceState["pieces"],
              );
            },
          });
          bridge.init({ apiUrl: "https://example.invalid", identity: "test" });

          const state = await bridge.connectSpace("home");
          expect(tree.lookup(tree.rootIno, encodeFuseComponent("home")))
            .toBe(state.spaceIno);
          await expect(openDirectorySnapshot(bridge, state.entitiesIno)).rejects
            .toThrow("identifier list unavailable");
          expect(bridge.isConnecting("home")).toBe(false);
          expect(
            (await openDirectorySnapshot(bridge, state.entitiesIno)).slice(2)
              .map(
                ({ name }) => name,
              ),
          ).toEqual([encodeFuseComponent(entityId)]);
          expect(managerLoads).toBe(1);
        });

        it("returns the existing space while its entity directory snapshot is still pending", async () => {
          const tree = new FsTree();
          const discoveryStarted = defer();
          const identifiers = defer<{ serverSeq: number; ids: string[] }>();
          const entityId = "of:fid1:delayed-entity";
          let managerLoads = 0;
          const spacePieces = {
            getSpace: () => "did:key:zDelayedSpace",
            listEntityIdPage: () => {
              discoveryStarted.resolve();
              return identifiers.promise;
            },
          } as unknown as SpaceState["pieces"];
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            loadPieces: () => {
              managerLoads++;
              return Promise.resolve(spacePieces);
            },
          });
          bridge.init({ apiUrl: "https://example.invalid", identity: "test" });

          const firstState = await bridge.connectSpace("home");
          const listing = openDirectorySnapshot(bridge, firstState.entitiesIno);
          await discoveryStarted.promise;
          expect(tree.lookup(tree.rootIno, encodeFuseComponent("home")))
            .toBe(firstState.spaceIno);

          const secondState = await bridge.connectSpace("home");
          expect(managerLoads).toBe(1);
          identifiers.resolve({ serverSeq: 1, ids: [entityId] });

          expect(firstState.spaceIno).toBe(secondState.spaceIno);
          expect(bridge.isConnecting("home")).toBe(false);
          expect((await listing).slice(2).map(({ name }) => name)).toEqual([
            encodeFuseComponent(entityId),
          ]);
        });

        it("rejects an unauthorized initial space connection", async () => {
          const tree = new FsTree();
          const authorizationError = Object.assign(
            new Error("space access denied"),
            { name: "AuthorizationError" },
          );
          let disposedManagers = 0;
          const spacePieces = {
            ensureSpaceSession: () => Promise.resolve(),
            synced: () => Promise.resolve(),
            getSpace: () => "did:key:zDeniedInitialSpace",
            runtime: {
              storageManager: {
                authorizationError: () => authorizationError,
              },
              dispose: () => {
                disposedManagers++;
                return Promise.resolve();
              },
            },
          } as unknown as SpaceState["pieces"];
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            loadPieces: () => Promise.resolve(spacePieces),
          });
          bridge.init({ apiUrl: "https://example.invalid", identity: "test" });

          await expect(bridge.connectSpace("denied")).rejects.toThrow(
            "space access denied",
          );

          expect(disposedManagers).toBe(1);
          expect(tree.lookup(tree.rootIno, encodeFuseComponent("denied")))
            .toBeUndefined();
          expect(bridge.spaces.has("denied")).toBe(false);
        });
      });

      describe("initStatus()", () => {
        // The `.status` file `initStatus()` installs: what it reports, and when
        // its document is rendered.

        function makeStatusBridge(
          tree: FsTree,
          statusProvider: () => Record<string, unknown>,
        ): CellBridge {
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            statusProvider,
          });
          bridge.init({
            apiUrl: "http://localhost:8000",
            identity: "/tmp/test-identity.pem",
          });
          bridge.initStatus();
          return bridge;
        }

        it("reports `/pieces` as loaded only after materialization", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);
          const pieces = defer<unknown[]>();
          state.piecesHydrated = false;
          state.piecesMaterializing = false;
          state.pieceListSubscribed = false;
          Object.assign(
            state.pieces,
            {
              getRegisteredPieces: () => pieces.promise,
            } as unknown as SpaceState["pieces"],
          );
          bridge.initStatus();

          const preparing = bridge.prepareDirectory(state.piecesIno);
          expect(state.piecesMaterializing).toBe(true);
          expect(JSON.parse(readStatusFile(tree)).spaces.home.piecesLoaded)
            .toBe(false);

          pieces.resolve([]);
          expect(await preparing).toBe(true);
          expect(state.piecesMaterializing).toBe(false);
          expect(state.piecesHydrated).toBe(true);
          expect(JSON.parse(readStatusFile(tree)).spaces.home.piecesLoaded)
            .toBe(true);
        });

        it({
          name: "reports debounced rebuild metrics",
          sanitizeOps: false,
          fn: async () => {
            const tree = new FsTree();
            let cfcReconciliations = 0;
            const bridge = new CellBridge(tree, "/tmp/cf-exec", {
              statusProvider: () => ({
                cfc: {
                  writeback: {
                    counts: { "mutation-applied": cfcReconciliations },
                  },
                },
              }),
              onCfcProjectionRebuilt: () => {
                cfcReconciliations++;
              },
            });
            bridge.init({
              apiUrl: "http://localhost:8000",
              identity: "/tmp/test-identity.pem",
            });
            bridge.initStatus();
            const state = buildTestSpace(bridge, "home", []);

            const inputCell = new SinkableCell({});
            const resultCell = new SinkableCell({ content: "Initial" });

            const piece = {
              id: "of:status-piece",
              name: () => "Status Piece",
              input: {
                getCell: () =>
                  Promise.resolve(inputCell as unknown as FakeCell),
                get: () => Promise.resolve(resultCell.get()),
              },
              result: {
                getCell: () =>
                  Promise.resolve(resultCell as unknown as FakeCell),
                get: () => Promise.resolve(resultCell.get()),
              },
            };

            const addPiece = bridge.accessForTestingOnly.addPieceToSpace;
            await addPiece(state, fakePiece(piece), "home");

            const pieceIno = tree.lookup(state.piecesIno, "Status-Piece")!;
            expect(tree.lookup(pieceIno, "result")).toBeDefined();
            expect(tree.getChildren(tree.lookup(pieceIno, "result")!).length)
              .toBe(0);

            resultCell.set({ content: "Second" });
            resultCell.set({ content: "Final" });
            // Wait for debounce (150ms) + rebuild
            await new Promise((r) => setTimeout(r, 250));

            const resultIno = tree.lookup(pieceIno, "result")!;
            expect(getFileContent(tree, resultIno, "content")).toBe("Final");

            const status = JSON.parse(readStatusFile(tree));
            expect(status.debug).toBe(false);
            expect(status.rebuilds.pending).toBe(0);
            expect(status.rebuilds.completed).toBeGreaterThanOrEqual(1);
            expect(status.rebuilds.errors).toBe(0);
            expect(cfcReconciliations).toBeGreaterThanOrEqual(1);
            expect(status.cfc.writeback.counts["mutation-applied"]).toEqual(
              cfcReconciliations,
            );

            // Cancel subscriptions to avoid timer leaks
            const subs = state.pieceSubs.get("Status-Piece");
            if (subs) { for (const cancel of subs) cancel(); }
          },
        });

        it("reports state that moved since the last read", () => {
          const tree = new FsTree();
          const writes = { opened: 0, written: 0, flushed: 0 };
          const bridge = makeStatusBridge(
            tree,
            () => ({ writes: { ...writes } }),
          );

          const readStatus = () => JSON.parse(readStatusFile(tree));
          expect(readStatus().writes).toEqual({
            opened: 0,
            written: 0,
            flushed: 0,
          });

          // The write path moves these counters and tells the bridge nothing.
          // Each read still has to see the counts as of that read.
          writes.opened++;
          expect(readStatus().writes.opened).toBe(1);

          writes.written += 2;
          writes.flushed++;
          expect(readStatus().writes).toEqual({
            opened: 1,
            written: 2,
            flushed: 1,
          });

          bridge.setDebug(true);
          expect(readStatus().debug).toBe(true);
        });

        it("sizes `.status` from the bytes a read serves", () => {
          const tree = new FsTree();
          let diagnostics: string[] = [];
          makeStatusBridge(tree, () => ({ cfc: { diagnostics } }));

          const statusIno = tree.lookup(tree.rootIno, ".status")!;
          const sizeOf = () =>
            (tree.getNode(statusIno) as { content: Uint8Array }).content.length;
          const before = sizeOf();

          // State moving on its own must not move the size, which a reader has
          // already been given and will stop its read at.
          diagnostics = ["denied write to piece result"];
          expect(sizeOf()).toBe(before);

          // Publishing moves the size and the bytes together.
          tree.refreshGenerated(statusIno);
          const after = sizeOf();
          expect(after > before).toBe(true);
          expect(after).toEqual(
            getFileContent(tree, tree.rootIno, ".status").length,
          );
        });

        it("renders nothing when its state moves", () => {
          const tree = new FsTree();
          let renders = 0;
          const bridge = makeStatusBridge(tree, () => {
            renders++;
            return {};
          });

          // initStatus publishes once so the file has bytes before anyone reads
          // it.
          expect(renders).toBe(1);

          // Rendering the document walks every space and its piece map. Nothing
          // that moves the state it reports should pay for that — the reader
          // does.
          bridge.setDebug(true);
          bridge.markDisconnected("socket closed");
          expect(renders).toBe(1);
        });

        it("renders when `.status` is read", () => {
          const tree = new FsTree();
          let renders = 0;
          const bridge = makeStatusBridge(tree, () => {
            renders++;
            return {};
          });
          bridge.setDebug(true);

          expect(JSON.parse(readStatusFile(tree)).debug).toBe(true);
          expect(renders).toBe(2);
        });
      });

      describe("prepareLookup()", () => {
        it("looks up an exact entity without listing, and bounds the projection cache", async () => {
          const ids = [
            "of:fid1:entity-0",
            "of:fid1:entity-1",
            "of:fid1:entity-2",
          ];
          let listRequests = 0;
          const existenceRequests: string[] = [];
          const spacePieces = {
            getSpace: () => "did:key:zTargetedEntitySpace",
            listEntityIdPage: () => {
              listRequests++;
              return Promise.resolve({ serverSeq: 1, ids });
            },
            entityIdExists: (id: string) => {
              existenceRequests.push(id);
              return Promise.resolve(ids.includes(id));
            },
          } as unknown as SpaceState["pieces"];
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            loadPieces: () => Promise.resolve(spacePieces),
            maxEntityProjections: 2,
          });
          bridge.init({ apiUrl: "https://example.invalid", identity: "test" });
          const state = await bridge.connectSpace("home");

          for (const id of [ids[0], ids[1], ids[0], ids[2]]) {
            expect(
              await bridge.prepareLookup(
                state.entitiesIno,
                encodeFuseComponent(id),
              ),
            ).toBe(true);
          }

          expect(listRequests).toBe(0);
          expect(existenceRequests).toEqual([ids[0], ids[1], ids[0], ids[2]]);
          expect(state.entityIds).toEqual(new Set([ids[0], ids[2]]));
          expect(tree.getChildren(state.entitiesIno).map(([name]) => name))
            .toEqual([ids[0], ids[2]].map((id) => encodeFuseComponent(id)));
        });

        it("keeps a newly resolved projection while an older hydration is pending", async () => {
          const firstId = "of:fid1:pending-entity";
          const secondId = "of:fid1:new-entity";
          const firstPiece = defer<unknown>();
          const hydrationStarted = defer<void>();
          const piece = (id: string) => ({
            id,
            name: () => id,
            getPatternRef: () => Promise.resolve(undefined),
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
          });
          const spacePieces = {
            getSpace: () => "did:key:zPendingEntitySpace",
            entityIdExists: (id: string) =>
              Promise.resolve(id === firstId || id === secondId),
          } as unknown as SpaceState["pieces"];
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            loadPieces: () => Promise.resolve(spacePieces),
            maxEntityProjections: 1,
          });
          bridge.init({ apiUrl: "https://example.invalid", identity: "test" });
          const state = await bridge.connectSpace("home");
          Object.assign(
            state.pieces,
            {
              get: (id: string) => {
                if (id === firstId) {
                  hydrationStarted.resolve();
                  return firstPiece.promise;
                }
                return Promise.resolve(piece(id));
              },
            } as unknown as SpaceState["pieces"],
          );

          expect(
            await bridge.prepareLookup(
              state.entitiesIno,
              encodeFuseComponent(firstId),
            ),
          ).toBe(true);
          const firstIno = tree.lookup(
            state.entitiesIno,
            encodeFuseComponent(firstId),
          )!;
          const firstHydration = bridge.prepareLookup(firstIno, "meta.json");
          await hydrationStarted.promise;

          expect(
            await bridge.prepareLookup(
              state.entitiesIno,
              encodeFuseComponent(secondId),
            ),
          ).toBe(true);
          expect(tree.lookup(state.entitiesIno, encodeFuseComponent(secondId)))
            .toBeDefined();

          firstPiece.resolve(piece(firstId));
          await firstHydration;
          expect(tree.lookup(state.entitiesIno, encodeFuseComponent(firstId)))
            .toBeUndefined();
          expect(tree.lookup(state.entitiesIno, encodeFuseComponent(secondId)))
            .toBeDefined();
        });

        it("keeps a hydrated entity-only projection current", async () => {
          const time = new FakeTime();
          try {
            const entityId = "of:fid1:entity-only-reactive";
            const resultCell = new SinkableCell({ content: "before" });
            const piece = {
              id: entityId,
              name: () => "Entity Only",
              getPatternRef: () => Promise.resolve(undefined),
              input: {
                getCell: () => Promise.resolve(makeCell({}, undefined)),
                get: () => Promise.resolve({}),
              },
              result: {
                getCell: () =>
                  Promise.resolve(resultCell as unknown as FakeCell),
                get: () => Promise.resolve(resultCell.get()),
              },
            };
            const tree = new FsTree();
            const bridge = new CellBridge(tree, "/tmp/cf-exec");
            const state = buildTestSpace(bridge, "home", []);
            Object.assign(
              state.pieces,
              {
                entityIdExists: (id: string) =>
                  Promise.resolve(id === entityId),
              } as unknown as SpaceState["pieces"],
            );
            Object.assign(
              state.pieces,
              {
                get: () => Promise.resolve(piece),
              } as unknown as SpaceState["pieces"],
            );

            await bridge.prepareLookup(
              state.entitiesIno,
              encodeFuseComponent(entityId),
            );
            const entityIno = tree.lookup(
              state.entitiesIno,
              encodeFuseComponent(entityId),
            )!;
            expect(await bridge.prepareLookup(entityIno, "result")).toBe(true);
            const resultIno = tree.lookup(entityIno, "result")!;
            expect(getFileContent(tree, resultIno, "content")).toBe("before");

            resultCell.set({ content: "after" });
            await time.tickAsync(200);
            await time.runMicrotasks();
            expect(getFileContent(tree, resultIno, "content")).toBe("after");
          } finally {
            time.restore();
          }
        });

        it("materializes the piece registry when `/pieces` is first read", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const piece = {
            id: "of:lazy-piece",
            name: () => "Lazy Piece",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
          };
          const state = buildTestSpace(bridge, "home", [piece]);
          state.allPieceIds = new Set([piece.id]);
          state.piecesHydrated = false;
          state.pieceListSubscribed = false;

          expect(bridge.shouldPrepareDirectory(state.piecesIno)).toBe(true);
          expect(bridge.shouldPrepareLookup(state.piecesIno, "pieces.json"))
            .toBe(true);
          expect(bridge.shouldSynchronizeLookup(state.piecesIno)).toBe(true);
          expect(tree.lookup(state.piecesIno, "Lazy-Piece")).toBeUndefined();

          expect(await bridge.prepareLookup(state.piecesIno, "pieces.json"))
            .toBe(true);
          expect(state.piecesHydrated).toBe(true);
          expect(state.pieceListSubscribed).toBe(true);
          expect(tree.lookup(state.piecesIno, "Lazy-Piece")).toBeDefined();
        });

        it("hydrates `result.json` on a direct lookup", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");

          const piece = {
            id: "of:entity-result-json",
            name: () => "Lookup JSON",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () =>
                Promise.resolve(makeCell({ content: "hello" }, {
                  type: "object",
                  properties: { content: { type: "string" } },
                })),
              get: () => Promise.resolve({ content: "hello" }),
            },
          };

          const pieceIno = await bridge.accessForTestingOnly.loadPieceTree(
            fakePiece(piece),
            tree.rootIno,
            "Lookup JSON",
            "home",
          );

          // result.json exists as a stub placeholder before hydration
          expect(tree.lookup(pieceIno, "result.json")).toBeDefined();

          const prepared = await bridge.prepareLookup(pieceIno, "result.json");

          expect(prepared).toBe(true);
          expect(tree.lookup(pieceIno, "result.json")).toBeDefined();
          expect(JSON.parse(getFileContent(tree, pieceIno, "result.json")))
            .toEqual({ content: "hello" });
        });
      });

      describe("prepareLookupForReply()", () => {
        it("resolves a known piece without a point identifier lookup", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);
          const entityId = "of:fid1:known-piece";
          const encodedId = encodeFuseComponent(entityId);
          const existenceRequests: string[] = [];
          Object.assign(
            state.pieces,
            {
              entityIdExists: (id: string) => {
                existenceRequests.push(id);
                return Promise.resolve(undefined);
              },
            } as unknown as SpaceState["pieces"],
          );
          const piece = { id: entityId };
          state.pieceControllers.set(
            "Known Piece",
            fakePiece(piece),
          );

          const firstIno = await bridge.prepareLookupForReply(
            state.entitiesIno,
            encodedId,
          );
          expect(firstIno).toBeDefined();
          expect(tree.lookup(state.entitiesIno, encodedId)).toBe(firstIno);
          expect(state.entityControllers.get(entityId)).toBe(piece);
          bridge.releaseEntityProjectionLookup(firstIno!);

          const existingIno = await bridge.prepareLookupForReply(
            state.entitiesIno,
            encodedId,
          );
          expect(existingIno).toBe(firstIno);
          bridge.releaseEntityProjectionLookup(existingIno!);

          expect(
            await bridge.prepareLookup(
              state.entitiesIno,
              encodeFuseComponent("of:fid1:unknown-piece"),
            ),
          ).toBe(false);
          expect(existenceRequests).toEqual([
            entityId,
            entityId,
            "of:fid1:unknown-piece",
          ]);
        });
      });

      describe("prepareDirectory()", () => {
        it("materializes `/pieces` from the piece registry", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          let registeredPieceReads = 0;
          let registryReads = 0;
          let registrySink: (() => void) | undefined;
          let registryCancelCalls = 0;

          const spacePieces = {
            getSpace: () => "did:key:zPieceRegistryTest",
            listEntityIds: () => Promise.resolve(undefined),
            getRegisteredPieces: () => {
              registeredPieceReads++;
              return Promise.resolve([]);
            },
            getPieceRegistry: () => {
              registryReads++;
              return Promise.resolve({
                sink(callback: () => void) {
                  registrySink = callback;
                  return () => registryCancelCalls++;
                },
              });
            },
          } as unknown as SpaceState["pieces"];

          const state = bridge.accessForTestingOnly.buildSpaceTree(
            "registry-space",
            spacePieces,
          );

          expect(registeredPieceReads).toBe(0);
          expect(registryReads).toBe(0);
          expect(state.did).toBe("did:key:zPieceRegistryTest");
          expect(state.unsubscribes.length).toBe(0);
          expect(
            tree.lookup(tree.rootIno, encodeFuseComponent("registry-space")),
          ).toBeDefined();

          bridge.spaces.set("registry-space", state);
          expect(await bridge.prepareDirectory(state.piecesIno)).toBe(true);
          expect(registeredPieceReads).toBe(1);
          expect(registryReads).toBe(1);
          expect(typeof registrySink).toBe("function");
          expect(state.unsubscribes.length).toBe(1);

          state.unsubscribes[0]();
          expect(registryCancelCalls).toBe(1);
        });
      });

      describe("prepareDirectorySnapshot()", () => {
        it("lists entity identifiers without hydrating their values", async () => {
          const tree = new FsTree();
          const allPiecesEntityId = "of:fid1:piece-in-all-pieces";
          const entityIds = [
            allPiecesEntityId,
            "of:fid1:entity-alpha",
            "of:fid1:entity-beta",
            "of:fid1:entity-gamma",
          ].toSorted();
          let identifierRequests = 0;
          let identifierLookups = 0;
          let entityValueRequests = 0;
          let pieceListRequests = 0;
          const rejectEntityValueRequest = () => {
            entityValueRequests++;
            throw new Error(
              "entity values must not be requested while listing",
            );
          };
          const listedPieceCell = {
            entityId: { "/": allPiecesEntityId },
            asSchema() {
              return this;
            },
            get: rejectEntityValueRequest,
            getRaw: rejectEntityValueRequest,
            sync: rejectEntityValueRequest,
          };
          const piecesCell = { sink: () => () => {} };
          const spacePieces = {
            getSpace: () => "did:key:zEntityListSpace",
            getPieceRegistry: () => {
              pieceListRequests++;
              return Promise.resolve(piecesCell);
            },
            syncPieces: () => {
              pieceListRequests++;
              return Promise.resolve([listedPieceCell]);
            },
            listEntityIdPage: () => {
              identifierRequests++;
              return Promise.resolve({ serverSeq: 7, ids: [...entityIds] });
            },
            entityIdExists: (id: string) => {
              identifierLookups++;
              return Promise.resolve(entityIds.includes(id));
            },
            get: rejectEntityValueRequest,
          } as unknown as SpaceState["pieces"];
          let deferredSpaceCellSync = false;
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            loadPieces: (config) => {
              deferredSpaceCellSync = config.deferSpaceCellSync === true;
              return Promise.resolve(spacePieces);
            },
          });
          bridge.init({ apiUrl: "https://example.invalid", identity: "test" });
          bridge.initStatus();

          const state = await bridge.connectSpace("home");
          expect(JSON.parse(readStatusFile(tree)).spaces.home).toEqual({
            did: "did:key:zEntityListSpace",
            pieces: 0,
            piecesLoaded: false,
          });
          expect(identifierRequests).toBe(0);
          const entries = await openDirectorySnapshot(
            bridge,
            state.entitiesIno,
          );
          expect(entries.slice(2).map(({ name }) => name)).toEqual(
            entityIds.map((id) => encodeFuseComponent(id)),
          );
          expect(tree.getChildren(state.entitiesIno)).toEqual([]);

          for (const { name } of entries.slice(2)) {
            expect(await bridge.prepareLookup(state.entitiesIno, name)).toBe(
              true,
            );
            const ino = tree.lookup(state.entitiesIno, name)!;
            expect(tree.getNode(ino)?.kind).toBe("dir");
            expect(
              (await openDirectorySnapshot(bridge, ino)).map(({ name }) =>
                name
              ),
            ).toEqual([".", ".."]);
          }

          expect(identifierRequests).toBe(1);
          expect(identifierLookups).toBe(entityIds.length);
          expect(entityValueRequests).toBe(0);
          expect(pieceListRequests).toBe(0);
          expect(deferredSpaceCellSync).toBe(true);
          expect(state.pieceMap.size).toBe(0);
          expect(state.allPieceIds).toEqual(new Set());
        });

        it("returns a stable snapshot across entity identifier pages", async () => {
          const ids = Array.from(
            { length: 1_205 },
            (_, index) => `of:fid1:entity-${index.toString().padStart(4, "0")}`,
          );
          const requests: Array<Record<string, unknown>> = [];
          const spacePieces = {
            getSpace: () => "did:key:zPaginatedEntitySpace",
            listEntityIdPage: (options: {
              after?: string;
              limit?: number;
              expectedServerSeq?: number;
            }) => {
              requests.push({ ...options });
              const start = options.after === undefined
                ? 0
                : ids.indexOf(options.after) + 1;
              const pageIds = ids.slice(start, start + options.limit!);
              const hasMore = start + pageIds.length < ids.length;
              return Promise.resolve({
                serverSeq: 9,
                ids: pageIds,
                ...(hasMore ? { nextAfter: pageIds.at(-1)! } : {}),
              });
            },
          } as unknown as SpaceState["pieces"];
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            loadPieces: () => Promise.resolve(spacePieces),
          });
          bridge.init({ apiUrl: "https://example.invalid", identity: "test" });

          const state = await bridge.connectSpace("home");
          const entries = await openDirectorySnapshot(
            bridge,
            state.entitiesIno,
          );

          expect(entries.length).toBe(ids.length + 2);
          expect(entries.slice(2).map(({ name }) => name)).toEqual(
            ids.map((id) => encodeFuseComponent(id)),
          );
          expect(requests).toEqual([
            { limit: 1_000 },
            { after: ids[999], limit: 1_000, expectedServerSeq: 9 },
          ]);
          expect(tree.getChildren(state.entitiesIno)).toEqual([]);
        });

        describe("given inconsistent entity identifier pages", () => {
          type EntityIdPage = {
            serverSeq: number;
            ids: string[];
            nextAfter?: string;
          };

          const cases: Array<{
            title: string;
            pages: Array<EntityIdPage | undefined>;
            message: string;
          }> = [
            {
              title: "rejects a missing page",
              pages: [undefined],
              message: "does not support paginated entity identifier listing",
            },
            {
              title: "rejects a page whose server sequence changed",
              pages: [
                {
                  serverSeq: 1,
                  ids: ["of:fid1:first"],
                  nextAfter: "of:fid1:first",
                },
                { serverSeq: 2, ids: ["of:fid1:second"] },
              ],
              message: "snapshot changed from server sequence 1 to 2",
            },
            {
              title: "rejects unsorted identifiers",
              pages: [
                {
                  serverSeq: 1,
                  ids: ["of:fid1:second"],
                  nextAfter: "of:fid1:second",
                },
                {
                  serverSeq: 1,
                  ids: ["of:fid1:first"],
                },
              ],
              message: "entity identifier pages are not strictly sorted",
            },
            {
              title: "rejects a cursor that does not advance",
              pages: [{
                serverSeq: 1,
                ids: ["of:fid1:first"],
                nextAfter: "of:fid1:different",
              }],
              message: "entity identifier page did not advance",
            },
          ];

          for (const testCase of cases) {
            it(testCase.title, async () => {
              const tree = new FsTree();
              const bridge = new CellBridge(tree, "/tmp/cf-exec");
              const state = buildTestSpace(bridge, "home", []);
              let request = 0;
              Object.assign(
                state.pieces,
                {
                  listEntityIdPage: () =>
                    Promise.resolve(testCase.pages[request++]),
                } as unknown as SpaceState["pieces"],
              );

              await expect(openDirectorySnapshot(bridge, state.entitiesIno))
                .rejects.toThrow(testCase.message);
              expect(request).toBe(testCase.pages.length);
              expect(tree.getChildren(state.entitiesIno)).toEqual([]);
            });
          }
        });

        it("coalesces concurrent snapshots into one identifier request", async () => {
          const ids = ["of:fid1:first", "of:fid1:second"];
          const page = defer<{ serverSeq: number; ids: string[] }>();
          let requests = 0;
          const spacePieces = {
            getSpace: () => "did:key:zCoalescedEntitySpace",
            listEntityIdPage: () => {
              requests++;
              return page.promise;
            },
          } as unknown as SpaceState["pieces"];
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            loadPieces: () => Promise.resolve(spacePieces),
          });
          bridge.init({ apiUrl: "https://example.invalid", identity: "test" });
          const state = await bridge.connectSpace("home");

          const first = openDirectorySnapshot(bridge, state.entitiesIno);
          const second = openDirectorySnapshot(bridge, state.entitiesIno);
          expect(requests).toBe(1);
          page.resolve({ serverSeq: 1, ids });

          expect(await first).toBe(await second);
          expect(requests).toBe(1);
        });

        it("removes an entity deleted during its root hydration", async () => {
          const entityId = "of:fid1:deleted-during-hydration";
          let entityIds = [entityId];
          const pendingPiece = defer<unknown>();
          const hydrationStarted = defer<void>();
          const piece = {
            id: entityId,
            name: () => "Deleted Entity",
            getPatternRef: () => Promise.resolve(undefined),
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
          };
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);
          Object.assign(
            state.pieces,
            {
              listEntityIdPage: () =>
                Promise.resolve({ serverSeq: 1, ids: [...entityIds] }),
              entityIdExists: (id: string) =>
                Promise.resolve(entityIds.includes(id)),
            } as unknown as SpaceState["pieces"],
          );
          Object.assign(
            state.pieces,
            {
              get: () => {
                hydrationStarted.resolve();
                return pendingPiece.promise;
              },
            } as unknown as SpaceState["pieces"],
          );

          await openDirectorySnapshot(bridge, state.entitiesIno);
          await bridge.prepareLookup(
            state.entitiesIno,
            encodeFuseComponent(entityId),
          );
          const entityIno = tree.lookup(
            state.entitiesIno,
            encodeFuseComponent(entityId),
          )!;
          const hydration = bridge.prepareLookup(entityIno, "meta.json");
          await hydrationStarted.promise;

          entityIds = [];
          await openDirectorySnapshot(bridge, state.entitiesIno);
          expect(tree.lookup(state.entitiesIno, encodeFuseComponent(entityId)))
            .toBeUndefined();
          expect(tree.getNode(entityIno)).toBeDefined();

          pendingPiece.resolve(piece);
          expect(await hydration).toBe(false);
          expect(tree.getNode(entityIno)).toBeUndefined();
        });

        it("refreshes `/entities` from the complete identifier list", async () => {
          const tree = new FsTree();
          let entityIds = ["of:fid1:original"];
          const piecesCell = { sink: () => () => {} };
          const spacePieces = {
            getSpace: () => "did:key:zEntityRefreshSpace",
            getPieceRegistry: () => Promise.resolve(piecesCell),
            syncPieces: () => Promise.resolve([]),
            listEntityIdPage: () =>
              Promise.resolve({ serverSeq: 1, ids: [...entityIds] }),
            entityIdExists: (id: string) =>
              Promise.resolve(entityIds.includes(id)),
          } as unknown as SpaceState["pieces"];
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            loadPieces: () => Promise.resolve(spacePieces),
          });
          bridge.init({ apiUrl: "https://example.invalid", identity: "test" });
          const state = await bridge.connectSpace("home");

          expect(
            (await openDirectorySnapshot(bridge, state.entitiesIno)).slice(2)
              .map(
                ({ name }) => name,
              ),
          ).toEqual(entityIds.map((id) => encodeFuseComponent(id)));
          const originalName = encodeFuseComponent(entityIds[0]);
          expect(await bridge.prepareLookup(state.entitiesIno, originalName))
            .toBe(true);

          entityIds = ["of:fid1:replacement"];
          expect(
            (await openDirectorySnapshot(bridge, state.entitiesIno)).slice(2)
              .map(
                ({ name }) => name,
              ),
          ).toEqual(entityIds.map((id) => encodeFuseComponent(id)));
          expect(tree.lookup(state.entitiesIno, originalName)).toBeUndefined();
        });

        it("removes a deleted entity's property indexes", async () => {
          const tree = new FsTree();
          const entityId = "of:fid1:removed-entity";
          let entityIds = [entityId];
          const piece = {
            id: entityId,
            name: () => "Removed Entity",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
          };
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);
          Object.assign(
            state.pieces,
            {
              listEntityIdPage: () =>
                Promise.resolve({ serverSeq: 1, ids: [...entityIds] }),
              entityIdExists: (id: string) =>
                Promise.resolve(entityIds.includes(id)),
            } as unknown as SpaceState["pieces"],
          );
          Object.assign(
            state.pieces,
            {
              get: () => Promise.resolve(piece),
            } as unknown as SpaceState["pieces"],
          );

          await openDirectorySnapshot(bridge, state.entitiesIno);
          expect(
            await bridge.prepareLookup(
              state.entitiesIno,
              encodeFuseComponent(entityId),
            ),
          ).toBe(true);
          const entityIno = tree.lookup(
            state.entitiesIno,
            encodeFuseComponent(entityId),
          )!;
          expect(await bridge.prepareLookup(entityIno, "input")).toBe(true);
          const inputIno = tree.lookup(entityIno, "input")!;
          const resultIno = tree.lookup(entityIno, "result")!;
          expect(bridge.shouldPrepareDirectory(inputIno)).toBe(true);
          expect(bridge.shouldPrepareDirectory(resultIno)).toBe(true);

          entityIds = [];
          await openDirectorySnapshot(bridge, state.entitiesIno);
          expect(tree.getNode(inputIno)).toBeUndefined();
          expect(tree.getNode(resultIno)).toBeUndefined();
          expect(bridge.shouldPrepareDirectory(inputIno)).toBe(false);
          expect(bridge.shouldPrepareDirectory(resultIno)).toBe(false);
        });

        it("rejects when the space has no paginated identifier listing", async () => {
          const tree = new FsTree();
          const entityId = "of:fid1:legacy-piece";
          let entityValueRequests = 0;
          const rejectEntityValueRequest = () => {
            entityValueRequests++;
            throw new Error("legacy fallback must not load the entity value");
          };
          const listedPieceCell = {
            entityId: { "/": entityId },
            asSchema() {
              return this;
            },
            get: rejectEntityValueRequest,
            getRaw: rejectEntityValueRequest,
            sync: rejectEntityValueRequest,
          };
          let pieceListRequests = 0;
          const spacePieces = {
            getSpace: () => "did:key:zLegacyEntityListSpace",
            getPieceRegistry: () => {
              pieceListRequests++;
              return Promise.resolve({ sink: () => () => {} });
            },
            syncPieces: () => {
              pieceListRequests++;
              return Promise.resolve([listedPieceCell]);
            },
            listEntityIds: () => Promise.resolve(undefined),
            get: rejectEntityValueRequest,
          } as unknown as SpaceState["pieces"];
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            loadPieces: () => Promise.resolve(spacePieces),
          });
          bridge.init({ apiUrl: "https://example.invalid", identity: "test" });

          const state = await bridge.connectSpace("home");
          await expect(openDirectorySnapshot(bridge, state.entitiesIno)).rejects
            .toThrow("does not support paginated entity identifier listing");

          expect(tree.getChildren(state.entitiesIno).map(([name]) => name))
            .toEqual([]);
          expect(entityValueRequests).toBe(0);
          expect(pieceListRequests).toBe(0);
        });
      });

      describe("entity projection references", () => {
        // The lookup and open reference counts kept by
        // `retainEntityProjectionLookup()`, `releaseEntityProjectionLookup()`,
        // `retainEntityProjectionOpen()`, and `releaseEntityProjectionOpen()`,
        // and what a held reference keeps in the tree.

        it("keeps cache work linear while lookup references remain", async () => {
          const entityCount = 2_000;
          const ids = Array.from(
            { length: entityCount },
            (_, index) =>
              `of:fid1:retained-${index.toString().padStart(4, "0")}`,
          );
          const liveIds = new Set(ids);
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            loadPieces: () =>
              Promise.resolve(
                {
                  getSpace: () => "did:key:zRetainedEntitySpace",
                  entityIdExists: (id: string) =>
                    Promise.resolve(liveIds.has(id)),
                } as unknown as SpaceState["pieces"],
              ),
            maxEntityProjections: 1,
          });
          const lru = new IterationCountingMap<
            bigint,
            UnhydratedEntityRootInfo
          >();
          const candidates = new IterationCountingMap<
            bigint,
            UnhydratedEntityRootInfo
          >();
          const lookupOwners = new IterationCountingMap<
            bigint,
            EntityProjectionLookupOwner
          >();
          const internals = bridge.accessForTestingOnly;
          internals.entityProjectionLru = lru;
          internals.entityProjectionEvictionCandidates = candidates;
          internals.entityProjectionLookupOwners = lookupOwners;
          bridge.init({ apiUrl: "https://example.invalid", identity: "test" });
          const state = await bridge.connectSpace("home");
          const operations = new FuseOperationState(tree, bridge);
          const inodes: bigint[] = [];

          for (const id of ids) {
            const ino = await operations.prepareLookup(
              state.entitiesIno,
              encodeFuseComponent(id),
            );
            expect(ino).toBeDefined();
            inodes.push(ino!);
          }
          expect(tree.getChildren(state.entitiesIno).length).toEqual(
            entityCount,
          );

          for (const ino of inodes) operations.forget(ino, 1n);

          expect(tree.getChildren(state.entitiesIno).length).toBe(1);
          expect(lru.iteratedEntries).toBe(0);
          expect(lookupOwners.iteratedEntries).toBe(0);
          expect(candidates.iteratedEntries <= entityCount * 2).toBe(true);
        });

        it("defers projection eviction until lookup and open references close", async () => {
          const ids = [
            "of:fid1:referenced-entity",
            "of:fid1:middle-entity",
            "of:fid1:latest-entity",
          ];
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            loadPieces: () =>
              Promise.resolve(
                {
                  getSpace: () => "did:key:zReferencedEntitySpace",
                  entityIdExists: (id: string) =>
                    Promise.resolve(ids.includes(id)),
                } as unknown as SpaceState["pieces"],
              ),
            maxEntityProjections: 1,
          });
          bridge.init({ apiUrl: "https://example.invalid", identity: "test" });
          const state = await bridge.connectSpace("home");

          await bridge.prepareLookup(
            state.entitiesIno,
            encodeFuseComponent(ids[0]),
          );
          const firstIno = tree.lookup(
            state.entitiesIno,
            encodeFuseComponent(ids[0]),
          )!;
          bridge.retainEntityProjectionLookup(firstIno);
          bridge.retainEntityProjectionOpen(firstIno);

          await bridge.prepareLookup(
            state.entitiesIno,
            encodeFuseComponent(ids[1]),
          );
          await bridge.prepareLookup(
            state.entitiesIno,
            encodeFuseComponent(ids[2]),
          );
          const latestIno = tree.lookup(
            state.entitiesIno,
            encodeFuseComponent(ids[2]),
          )!;
          bridge.retainEntityProjectionLookup(latestIno);

          expect(tree.getNode(firstIno)).toBeDefined();
          expect(tree.getNode(latestIno)).toBeDefined();
          bridge.releaseEntityProjectionLookup(firstIno);
          expect(tree.getNode(firstIno)).toBeDefined();
          bridge.releaseEntityProjectionOpen(firstIno);
          expect(tree.getNode(firstIno)).toBeUndefined();
          expect(tree.getNode(latestIno)).toBeDefined();
          bridge.releaseEntityProjectionLookup(latestIno);
        });

        it("balances repeated lookup and open references", async () => {
          const entityId = "of:fid1:repeated-references";
          let exists = true;
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            loadPieces: () =>
              Promise.resolve(
                {
                  getSpace: () => "did:key:zRepeatedReferencesSpace",
                  entityIdExists: (id: string) =>
                    Promise.resolve(exists && id === entityId),
                } as unknown as SpaceState["pieces"],
              ),
          });
          bridge.init({ apiUrl: "https://example.invalid", identity: "test" });
          const state = await bridge.connectSpace("home");
          const encodedId = encodeFuseComponent(entityId);

          expect(await bridge.prepareLookup(state.entitiesIno, encodedId)).toBe(
            true,
          );
          const entityIno = tree.lookup(state.entitiesIno, encodedId)!;
          const childIno = tree.addFile(entityIno, "child", "value", "string");
          const internals = bridge.accessForTestingOnly;

          bridge.retainEntityProjectionLookup(childIno, 2n);
          bridge.retainEntityProjectionOpen(childIno);
          bridge.retainEntityProjectionOpen(childIno);
          bridge.retainEntityProjectionLookup(childIno, -1n);
          bridge.retainEntityProjectionLookup(tree.rootIno);
          expect(internals.entityProjectionLookupOwners.get(childIno)?.count)
            .toBe(2n);
          expect(internals.entityProjectionLookupOwners.has(tree.rootIno)).toBe(
            false,
          );
          expect(internals.entityProjectionLookupRefs.get(entityIno)).toBe(2n);

          bridge.releaseEntityProjectionLookup(childIno);
          bridge.releaseEntityProjectionOpen(childIno);
          bridge.releaseEntityProjectionLookup(childIno, -1n);
          expect(internals.entityProjectionLookupOwners.get(childIno)?.count)
            .toBe(1n);
          expect(internals.entityProjectionLookupRefs.get(entityIno)).toBe(1n);

          exists = false;
          expect(await bridge.prepareLookup(state.entitiesIno, encodedId)).toBe(
            false,
          );
          expect(tree.lookup(state.entitiesIno, encodedId)).toBeUndefined();
          expect(tree.getNode(entityIno)).toBeDefined();

          bridge.releaseEntityProjectionLookup(childIno);
          expect(tree.getNode(entityIno)).toBeDefined();
          bridge.releaseEntityProjectionOpen(childIno);
          expect(tree.getNode(entityIno)).toBeUndefined();
        });

        it("releases descendant references after a reactive removal", async () => {
          const ids = ["of:fid1:removed-child", "of:fid1:replacement-root"];
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            loadPieces: () =>
              Promise.resolve(
                {
                  getSpace: () => "did:key:zRemovedChildSpace",
                  entityIdExists: (id: string) =>
                    Promise.resolve(ids.includes(id)),
                } as unknown as SpaceState["pieces"],
              ),
            maxEntityProjections: 1,
          });
          bridge.init({ apiUrl: "https://example.invalid", identity: "test" });
          const state = await bridge.connectSpace("home");

          await bridge.prepareLookup(
            state.entitiesIno,
            encodeFuseComponent(ids[0]),
          );
          const firstIno = tree.lookup(
            state.entitiesIno,
            encodeFuseComponent(ids[0]),
          )!;
          const childIno = tree.addFile(firstIno, "child", "value", "string");
          bridge.retainEntityProjectionLookup(firstIno);
          bridge.retainEntityProjectionLookup(childIno);
          bridge.retainEntityProjectionOpen(childIno);
          tree.removeChild(firstIno, "child");

          await bridge.prepareLookup(
            state.entitiesIno,
            encodeFuseComponent(ids[1]),
          );
          expect(tree.getNode(firstIno)).toBeDefined();
          bridge.releaseEntityProjectionLookup(childIno);
          expect(tree.getNode(firstIno)).toBeDefined();
          bridge.releaseEntityProjectionLookup(childIno);
          bridge.releaseEntityProjectionOpen(childIno);
          await bridge.prepareLookup(
            state.entitiesIno,
            encodeFuseComponent(ids[1]),
          );
          expect(tree.getNode(firstIno)).toBeDefined();
          bridge.releaseEntityProjectionLookup(firstIno);
          await bridge.prepareLookup(
            state.entitiesIno,
            encodeFuseComponent(ids[1]),
          );
          expect(tree.getNode(firstIno)).toBeUndefined();
        });
      });

      describe("resolveEntity()", () => {
        it("returns `false` for a non-canonical entity alias", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);
          const piece = {
            id: "of:alias-piece",
            name: () => "Alias Piece",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
          };
          state.pieceControllers.set("Alias-Piece", fakePiece(piece));

          expect(
            await bridge.resolveEntity(state.entitiesIno, "of:alias-piece"),
          ).toBe(false);
          expect(
            await bridge.resolveEntity(state.entitiesIno, "%6Ff%3Aalias-piece"),
          ).toBe(false);
          expect(tree.lookup(state.entitiesIno, "of:alias-piece"))
            .toBeUndefined();
          expect(tree.lookup(state.entitiesIno, "%6Ff%3Aalias-piece"))
            .toBeUndefined();

          expect(
            await bridge.resolveEntity(state.entitiesIno, "of%3Aalias-piece"),
          ).toBe(true);
          expect(tree.lookup(state.entitiesIno, "of%3Aalias-piece"))
            .toBeDefined();
        });
      });

      describe("resolveWritePath()", () => {
        it("decodes an encoded space directory name", () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "did:key:zSpace", []);
          const piece = {
            id: "of:encoded-space-piece",
            name: () => "Encoded Space Piece",
          };
          state.pieceControllers.set("notes", fakePiece(piece));

          const pieceIno = tree.addDir(state.piecesIno, "notes");
          const resultIno = tree.addDir(pieceIno, "result");
          const titleIno = tree.addFile(resultIno, "title", "hello", "string");

          const writePath = bridge.resolveWritePath(titleIno);
          expect(writePath?.spaceName).toBe("did:key:zSpace");
          expect(writePath?.pieceName).toBe("notes");
          expect(writePath?.cell).toBe("result");
          expect(writePath?.jsonPath).toEqual(["title"]);
        });

        it("resolves a value file's write path after an in-place rebuild", () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "did:key:zSpace", []);
          const piece = { id: "of:rebuilt-piece", name: () => "Rebuilt Piece" };
          state.pieceControllers.set("notes", fakePiece(piece));

          const pieceIno = tree.addDir(state.piecesIno, "notes");
          const inputIno = tree.addDir(pieceIno, "input", "object");
          const lastMessageIno = tree.addFile(
            inputIno,
            "lastMessage",
            "hi",
            "string",
          );

          // A rebuild reconciles a freshly built staging subtree onto the live
          // one, so the value file survives the rebuild with the same inode. A
          // write that arrives on that cached inode still resolves to the same
          // cell.
          const pendingIno = tree.addDir(pieceIno, ".input.pending", "object");
          tree.addFile(pendingIno, "lastMessage", "hello", "string");
          tree.transplantSubtree(inputIno, pendingIno);

          expect(tree.lookup(inputIno, "lastMessage")).toBe(lastMessageIno);

          const writePath = bridge.resolveWritePath(lastMessageIno);
          expect(writePath?.spaceName).toBe("did:key:zSpace");
          expect(writePath?.pieceName).toBe("notes");
          expect(writePath?.cell).toBe("input");
          expect(writePath?.jsonPath).toEqual(["lastMessage"]);
        });
      });

      describe("resolveSourceWritePath()", () => {
        it("decodes an encoded space directory name", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "did:key:zSource", []);
          const pieceIno = tree.addDir(state.piecesIno, "notes");
          let patternRefReads = 0;
          const piece = {
            id: "of:encoded-source-piece",
            getPatternRef: () => {
              patternRefReads++;
              return Promise.resolve({
                identity: "C".repeat(43),
                symbol: "default",
                source: { ref: `cf:pattern:${"C".repeat(43)}` },
              });
            },
            getPatternSourceProgram: () =>
              Promise.resolve({
                main: "/src/main.ts",
                files: [
                  { name: "/src/main.ts", contents: "export default 1;" },
                ],
              }),
          };
          state.pieceControllers.set("notes", fakePiece(piece));
          state.pieceInos.set("notes", pieceIno);
          state.srcInos.set("notes", pieceIno);

          await bridge.accessForTestingOnly.buildSourceTree(
            pieceIno,
            fakePiece(piece),
            state,
            "notes",
          );

          const srcIno = tree.lookup(pieceIno, ".src")!;
          const srcDirIno = tree.lookup(srcIno, "src")!;
          const sourceIno = tree.lookup(srcDirIno, "main.ts")!;
          const sourcePath = bridge.resolveSourceWritePath(sourceIno);

          expect(sourcePath?.spaceName).toBe("did:key:zSource");
          expect(sourcePath?.pieceName).toBe("notes");
          expect(sourcePath?.relPath).toBe("src/main.ts");

          await bridge.finalizeSourceWritePath(sourcePath!);
          expect(patternRefReads).toBe(1);
        });
      });

      describe("finalizeWritePath()", () => {
        it("advances the CFC annotation generation after a committed writeback", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            cfcAnnotations: true,
          });
          const state = buildTestSpace(bridge, "home", []);

          let resultValue: Record<string, unknown> = { title: "one" };
          const resultCell: FakeCell = {
            schema: {
              type: "object",
              properties: { title: { type: "string" } },
            },
            get: () => resultValue,
            getRaw: () => resultValue,
            asSchemaFromLinks() {
              return this;
            },
            key(segment: string) {
              return makeCell(resultValue[segment], undefined);
            },
            sink: () => () => {},
          };
          const piece = {
            id: "of:entity-finalize-generation",
            name: () => "Finalize Generation",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(resultCell),
              get: () => Promise.resolve(resultValue),
              set: (value: unknown, path?: (string | number)[]) => {
                if (path?.length === 1 && typeof path[0] === "string") {
                  resultValue = { ...resultValue, [path[0]]: value };
                } else if (isObjectNotArray(value)) {
                  resultValue = value as Record<string, unknown>;
                }
                return Promise.resolve();
              },
            },
          };

          state.pieceControllers.set(
            "Finalize Generation",
            fakePiece(piece),
          );
          const pieceIno = await bridge.accessForTestingOnly.loadPieceTree(
            fakePiece(piece),
            state.piecesIno,
            "Finalize Generation",
            "home",
          );
          state.pieceMap.set("Finalize Generation", piece.id);
          state.pieceInos.set("Finalize Generation", pieceIno);

          await bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );
          const initialResultIno = tree.lookup(pieceIno, "result")!;
          const initialTitleIno = tree.lookup(initialResultIno, "title")!;
          const initialGeneration = tree.getCfcAnnotation(initialTitleIno)
            ?.generation;

          const titleWritePath: WritePath = {
            spaceName: "home",
            pieceName: "Finalize Generation",
            cell: "result",
            jsonPath: ["title"],
            isJsonFile: false,
            piece: fakePiece(piece),
          };
          await bridge.writeValue(titleWritePath, "two");
          await bridge.finalizeWritePath(titleWritePath);

          const updatedResultIno = tree.lookup(pieceIno, "result")!;
          const updatedTitleIno = tree.lookup(updatedResultIno, "title")!;
          expect(getFileContent(tree, updatedResultIno, "title")).toBe("two");
          expect(tree.getCfcAnnotation(updatedTitleIno)?.generation).not
            .toBe(initialGeneration);
          expect(tree.getCfcAnnotation(updatedTitleIno)?.ref.generation)
            .toBe(tree.getCfcAnnotation(updatedTitleIno)?.generation);

          const parentWritePath: WritePath = {
            ...titleWritePath,
            jsonPath: [],
            isJsonFile: true,
          };
          await bridge.writeValue(
            { ...parentWritePath, jsonPath: ["created"] },
            "child",
          );
          await bridge.finalizeWritePath(parentWritePath);

          const finalResultIno = tree.lookup(pieceIno, "result")!;
          const childIno = tree.lookup(finalResultIno, "created");
          expect(childIno).toBeDefined();
          expect(tree.getCfcAnnotation(childIno!)?.ref.projection).toBe(
            "value",
          );
        });

        it("advances the CFC annotation generation after a namespace mutation writeback", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            cfcAnnotations: true,
          });
          const state = buildTestSpace(bridge, "home", []);

          let resultValue: Record<string, unknown> = {
            file: "remove",
            dir: { child: "x" },
            from: { old: "move" },
            to: { stay: true },
          };
          const getAtPath = (path?: (string | number)[]) => {
            let current: unknown = resultValue;
            for (const segment of path ?? []) {
              if (!isObjectNotArray(current)) {
                return undefined;
              }
              current = (current as Record<string, unknown>)[String(segment)];
            }
            return current;
          };
          const setAtPath = (value: unknown, path?: (string | number)[]) => {
            if (!path || path.length === 0) {
              resultValue = value as Record<string, unknown>;
              return;
            }
            const next = { ...resultValue };
            let current: Record<string, unknown> = next;
            for (const segment of path.slice(0, -1)) {
              const key = String(segment);
              const child = current[key];
              const cloned = isObjectNotArray(child)
                ? { ...(child as Record<string, unknown>) }
                : {};
              current[key] = cloned;
              current = cloned;
            }
            current[String(path[path.length - 1])] = value;
            resultValue = next;
          };
          const resultCell: FakeCell = {
            schema: { type: "object" },
            get: () => resultValue,
            getRaw: () => resultValue,
            asSchemaFromLinks() {
              return this;
            },
            key(segment: string) {
              return makeCell(resultValue[segment], undefined);
            },
            sink: () => () => {},
          };
          const piece = {
            id: "of:entity-finalize-namespace",
            name: () => "Finalize Namespace",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(resultCell),
              get: (path?: (string | number)[]) =>
                Promise.resolve(getAtPath(path)),
              set: (value: unknown, path?: (string | number)[]) => {
                setAtPath(value, path);
                return Promise.resolve();
              },
            },
          };

          state.pieceControllers.set(
            "Finalize Namespace",
            fakePiece(piece),
          );
          const pieceIno = await bridge.accessForTestingOnly.loadPieceTree(
            fakePiece(piece),
            state.piecesIno,
            "Finalize Namespace",
            "home",
          );
          state.pieceMap.set("Finalize Namespace", piece.id);
          state.pieceInos.set("Finalize Namespace", pieceIno);

          await bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );
          const rootPath: WritePath = {
            spaceName: "home",
            pieceName: "Finalize Namespace",
            cell: "result",
            jsonPath: [],
            isJsonFile: true,
            piece: fakePiece(piece),
          };

          let resultIno = tree.lookup(pieceIno, "result")!;
          const initialRootGeneration = tree.getCfcAnnotation(resultIno)
            ?.generation;
          await bridge.writeValue(rootPath, {
            dir: { child: "x" },
            from: { old: "move" },
            to: { stay: true },
          });
          await bridge.finalizeWritePath(rootPath);
          resultIno = tree.lookup(pieceIno, "result")!;
          expect(tree.lookup(resultIno, "file")).toBeUndefined();
          expect(tree.getCfcAnnotation(resultIno)?.generation).not.toBe(
            initialRootGeneration,
          );

          const afterUnlinkGeneration = tree.getCfcAnnotation(resultIno)
            ?.generation;
          await bridge.writeValue(rootPath, {
            from: { old: "move" },
            to: { stay: true },
          });
          await bridge.finalizeWritePath(rootPath);
          resultIno = tree.lookup(pieceIno, "result")!;
          expect(tree.lookup(resultIno, "dir")).toBeUndefined();
          expect(tree.getCfcAnnotation(resultIno)?.generation).not.toBe(
            afterUnlinkGeneration,
          );

          const fromIno = tree.lookup(resultIno, "from")!;
          const toIno = tree.lookup(resultIno, "to")!;
          const fromGeneration = tree.getCfcAnnotation(fromIno)?.generation;
          const toGeneration = tree.getCfcAnnotation(toIno)?.generation;
          const toPath: WritePath = {
            ...rootPath,
            jsonPath: ["to", "new"],
            isJsonFile: false,
          };
          const fromPath: WritePath = {
            ...rootPath,
            jsonPath: ["from"],
            isJsonFile: true,
          };
          await bridge.writeValue(toPath, "move");
          await bridge.writeValue(fromPath, {});
          await bridge.finalizeWritePath(toPath);
          await bridge.finalizeWritePath(fromPath);

          resultIno = tree.lookup(pieceIno, "result")!;
          const updatedFromIno = tree.lookup(resultIno, "from")!;
          const updatedToIno = tree.lookup(resultIno, "to")!;
          expect(tree.lookup(updatedFromIno, "old")).toBeUndefined();
          expect(getFileContent(tree, updatedToIno, "new")).toBe("move");
          expect(tree.getCfcAnnotation(updatedFromIno)?.generation).not.toBe(
            fromGeneration,
          );
          expect(tree.getCfcAnnotation(updatedToIno)?.generation).not.toBe(
            toGeneration,
          );

          const beforeSymlinkGeneration = tree.getCfcAnnotation(resultIno)
            ?.generation;
          await bridge.writeValue(
            { ...rootPath, jsonPath: ["link"], isJsonFile: false },
            { "/": { "link@1": { path: ["to", "new"] } } },
          );
          await bridge.finalizeWritePath(rootPath);
          resultIno = tree.lookup(pieceIno, "result")!;
          const linkIno = tree.lookup(resultIno, "link")!;
          expect(tree.getNode(linkIno)?.kind).toBe("symlink");
          expect(tree.getCfcAnnotation(linkIno)?.ref.projection).toBe(
            "symlink",
          );
          expect(tree.getCfcAnnotation(resultIno)?.generation).not.toBe(
            beforeSymlinkGeneration,
          );
        });
      });

      describe("writeFsFile()", () => {
        it("writes markdown frontmatter and body to FS paths", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const writes: Array<{ path: (string | number)[]; value: unknown }> =
            [];

          const ok = await bridge.writeFsFile(
            {
              fsProjection: "markdown",
              piece: {
                result: {
                  set: (
                    value: unknown,
                    path?: (string | number)[],
                  ) => {
                    writes.push({ path: path ?? [], value });
                    return Promise.resolve();
                  },
                },
              },
            } as WritePath,
            "---\ntitle: Updated Title\n---\n\nUpdated body",
          );

          expect(ok).toBe(true);
          expect(writes).toEqual([
            { path: ["$FS", "frontmatter", "title"], value: "Updated Title" },
            { path: ["$FS", "content"], value: "Updated body" },
          ]);
        });

        it("removes deleted markdown frontmatter keys and preserves scalar types", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const writes: Array<{ path: (string | number)[]; value: unknown }> =
            [];

          const ok = await bridge.writeFsFile(
            {
              fsProjection: "markdown",
              piece: {
                result: {
                  get: (path?: (string | number)[]) => {
                    if (path?.join("/") === "$FS/frontmatter") {
                      return Promise.resolve({
                        title: "Old Title",
                        stale: true,
                      });
                    }
                    return Promise.resolve(undefined);
                  },
                  set: (
                    value: unknown,
                    path?: (string | number)[],
                  ) => {
                    writes.push({ path: path ?? [], value });
                    return Promise.resolve();
                  },
                },
              },
            } as WritePath,
            "---\ntitle: Updated Title\ncount: 42\npublished: true\n---\n\nUpdated body",
          );

          expect(ok).toBe(true);
          // A `value` of `undefined` is a deletion, and `toStrictEqual` is what
          // keeps an omitted key from passing for one.
          expect(writes).toStrictEqual([
            { path: ["$FS", "frontmatter", "title"], value: "Updated Title" },
            { path: ["$FS", "frontmatter", "count"], value: 42 },
            { path: ["$FS", "frontmatter", "published"], value: true },
            { path: ["$FS", "frontmatter", "stale"], value: undefined },
            { path: ["$FS", "content"], value: "Updated body" },
          ]);
        });

        it("removes deleted keys from an `application/json` projection", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const writes: Array<{ path: (string | number)[]; value: unknown }> =
            [];

          const ok = await bridge.writeFsFile(
            {
              fsProjection: "json",
              piece: {
                result: {
                  get: (path?: (string | number)[]) => {
                    if (path?.join("/") === "$FS") {
                      return Promise.resolve({
                        type: "application/json",
                        content: { title: "Old", stale: true },
                      });
                    }
                    if (path?.join("/") === "$FS/content") {
                      return Promise.resolve({ title: "Old", stale: true });
                    }
                    return Promise.resolve(undefined);
                  },
                  set: (
                    value: unknown,
                    path?: (string | number)[],
                  ) => {
                    writes.push({ path: path ?? [], value });
                    return Promise.resolve();
                  },
                },
              },
            } as WritePath,
            '{"title":"New"}',
          );

          expect(ok).toBe(true);
          // A `value` of `undefined` is a deletion, and `toStrictEqual` is what
          // keeps an omitted key from passing for one.
          expect(writes).toStrictEqual([
            { path: ["$FS", "content", "title"], value: "New" },
            { path: ["$FS", "content", "stale"], value: undefined },
          ]);
        });

        it("round-trips markdown FS projection scalars through hydration and writeback", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);
          const writes: Array<{ path: (string | number)[]; value: unknown }> =
            [];
          const resultValue = {
            $FS: {
              type: "text/markdown",
              content: "Hello body",
              frontmatter: {
                entityId: "user-supplied-entity",
                title: "Hello",
                count: 7,
                published: false,
                tags: ["alpha", "beta"],
                meta: { pinned: true },
              },
            },
          };
          const inputCell = new SinkableCell({});
          const resultCell = new SinkableCell(resultValue);

          const piece = {
            id: "of:fs-roundtrip",
            name: () => "FS Roundtrip",
            input: {
              getCell: () => Promise.resolve(inputCell as unknown as FakeCell),
              get: () => Promise.resolve(inputCell.get()),
            },
            result: {
              getCell: () => Promise.resolve(resultCell as unknown as FakeCell),
              get: (path?: (string | number)[]) => {
                if (path?.join("/") === "$FS/frontmatter") {
                  return Promise.resolve(resultValue.$FS.frontmatter);
                }
                return Promise.resolve(resultCell.get());
              },
              set: (value: unknown, path?: (string | number)[]) => {
                writes.push({ path: path ?? [], value });
                return Promise.resolve();
              },
            },
          };

          const addPiece = bridge.accessForTestingOnly.addPieceToSpace;
          await addPiece(state, fakePiece(piece), "home");

          const pieceIno = tree.lookup(state.piecesIno, "FS-Roundtrip")!;
          await bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );

          const index = getFileContent(tree, pieceIno, "index.md");
          expect(index).toBe(
            "---\nentityId: of:fs-roundtrip\ntitle: Hello\ncount: 7\npublished: false\n---\n\nHello body",
          );
          const tagsIno = tree.lookup(pieceIno, "tags")!;
          expect(getFileContent(tree, tagsIno, "0")).toBe("alpha");
          expect(getFileContent(tree, tagsIno, "1")).toBe("beta");
          const metaIno = tree.lookup(pieceIno, "meta")!;
          expect(getFileContent(tree, metaIno, "pinned")).toBe("true");

          const ok = await bridge.writeFsFile(
            {
              fsProjection: "markdown",
              piece: fakePiece(piece),
            } as WritePath,
            "---\nentityId: attacker\ntitle: Updated\ncount: 8\npublished: true\n---\n\nUpdated body",
          );

          expect(ok).toBe(true);
          // A `value` of `undefined` is a deletion, and `toStrictEqual` is what
          // keeps an omitted key from passing for one.
          expect(writes).toStrictEqual([
            { path: ["$FS", "frontmatter", "title"], value: "Updated" },
            { path: ["$FS", "frontmatter", "count"], value: 8 },
            { path: ["$FS", "frontmatter", "published"], value: true },
            { path: ["$FS", "frontmatter", "tags"], value: undefined },
            { path: ["$FS", "frontmatter", "meta"], value: undefined },
            { path: ["$FS", "content"], value: "Updated body" },
          ]);
        });
      });

      describe("invalidateWritePath()", () => {
        it("clears the hydrated piece result cache", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          const piece = {
            id: "of:invalidate-piece",
            name: () => "Invalidate Piece",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () =>
                Promise.resolve(makeCell({ content: "hello" }, {
                  type: "object",
                  properties: { content: { type: "string" } },
                })),
              get: () => Promise.resolve({ content: "hello" }),
            },
          };

          const addPiece = bridge.accessForTestingOnly.addPieceToSpace;
          await addPiece(state, fakePiece(piece), "home");

          const pieceIno = tree.lookup(state.piecesIno, "Invalidate-Piece")!;
          await bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );
          expect(tree.lookup(pieceIno, "result")).toBeDefined();

          bridge.invalidateWritePath({
            spaceName: "home",
            pieceName: "Invalidate-Piece",
            cell: "result",
            jsonPath: ["content"],
            isJsonFile: false,
            piece: fakePiece(piece),
          });

          const resultIno = tree.lookup(pieceIno, "result");
          expect(resultIno).toBeDefined();
          expect(
            tree.getChildren(resultIno!).length,
            "result/ should be restored as an empty stub after invalidation",
          ).toBe(0);
        });

        it("serializes hydrations of the same prop", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          let resolveFirstGet: (() => void) | undefined;
          const firstGetGate = new Promise<void>((resolve) => {
            resolveFirstGet = resolve;
          });
          let getCalls = 0;
          let maxConcurrentGets = 0;
          let activeGets = 0;

          const piece = {
            id: "of:race-piece",
            name: () => "Race Piece",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () =>
                Promise.resolve(makeCell({ content: "fresh" }, {
                  type: "object",
                  properties: { content: { type: "string" } },
                })),
              get: async () => {
                getCalls++;
                activeGets++;
                maxConcurrentGets = Math.max(maxConcurrentGets, activeGets);
                try {
                  if (getCalls === 2) {
                    await firstGetGate;
                  }
                  return { content: "fresh" };
                } finally {
                  activeGets--;
                }
              },
            },
          };

          const addPiece = bridge.accessForTestingOnly.addPieceToSpace;
          await addPiece(state, fakePiece(piece), "home");

          const pieceIno = tree.lookup(state.piecesIno, "Race-Piece")!;
          const firstHydration = bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );

          await Promise.resolve();
          bridge.invalidateWritePath({
            spaceName: "home",
            pieceName: "Race-Piece",
            cell: "result",
            jsonPath: ["content"],
            isJsonFile: false,
            piece: fakePiece(piece),
          });
          const secondHydration = bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );

          if (resolveFirstGet) resolveFirstGet();
          await Promise.all([firstHydration, secondHydration]);

          expect(maxConcurrentGets).toBe(1);
          expect(getCalls).toBeGreaterThanOrEqual(2);
          const resultIno = tree.lookup(pieceIno, "result");
          expect(resultIno).toBeDefined();
          expect(getFileContent(tree, resultIno!, "content")).toBe("fresh");
        });
      });

      describe("invalidateHandlerTarget()", () => {
        it("clears the hydrated entity result cache", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          const resultCell = makeCell({ content: "hello" }, {
            type: "object",
            properties: { content: { type: "string" } },
          });
          const piece = {
            id: "of:entity-handler-piece",
            name: () => "Handler Piece",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(resultCell),
              get: () => Promise.resolve({ content: "hello" }),
            },
          };

          const addPiece = bridge.accessForTestingOnly.addPieceToSpace;
          await addPiece(state, fakePiece(piece), "home");

          await bridge.resolveEntity(
            state.entitiesIno,
            "of%3Aentity-handler-piece",
          );
          const entityIno = tree.lookup(
            state.entitiesIno,
            "of%3Aentity-handler-piece",
          )!;
          expect(await bridge.prepareLookup(entityIno, "result")).toBe(true);
          expect(tree.lookup(entityIno, "result")).toBeDefined();

          bridge.invalidateHandlerTarget({
            piece: fakePiece(piece),
            cellProp: "result",
            cellKey: "content",
          });

          const resultIno = tree.lookup(entityIno, "result");
          expect(resultIno).toBeDefined();
          expect(
            tree.getChildren(resultIno!).length,
            "entity result/ should be restored as an empty stub after handler invalidation",
          ).toBe(0);
        });
      });

      describe("reportSourceRefreshWarning()", () => {
        it("writes the report into the current `.src` directory", () => {
          // A source write that committed but did not refresh has to leave a
          // report a reader can find, and the flush path can only write it
          // AFTER finalizing — rebuilding `.src` replaces the directory and
          // mints a fresh empty `error.log`. So this resolves the directory
          // from the state the rebuild updated, never from an inode a caller
          // captured earlier.

          const bridge = new CellBridge(new FsTree(), "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "space", []);
          const tree = bridge.tree;
          const pieceIno = tree.addDir(state.piecesIno, "notes");
          const staleSrcIno = tree.addDir(pieceIno, ".src-stale");
          tree.addFile(staleSrcIno, "error.log", "", "string");

          // What a rebuild leaves behind: a new directory, a new empty
          // error.log, and the piece's entry in `srcInos` pointing at it.
          const rebuiltSrcIno = tree.addDir(pieceIno, ".src");
          const rebuiltErrorLogIno = tree.addFile(
            rebuiltSrcIno,
            "error.log",
            "",
            "string",
          );
          state.srcInos.set("notes", rebuiltSrcIno);
          state.srcErrorLogInos.set("notes", rebuiltErrorLogIno);

          const errors = captureConsoleErrors();
          try {
            bridge.reportSourceRefreshWarning(
              sourceWritePath("space", "notes", staleSrcIno),
              "committed, but the refresh failed",
            );
          } finally {
            errors.restore();
          }

          expect(getFileContent(tree, rebuiltSrcIno, "error.log")).toBe(
            "committed, but the refresh failed",
          );
          expect(getFileContent(tree, staleSrcIno, "error.log")).toBe("");
          expect(errors.lines.length).toBe(1);
        });

        it("reports nothing for a refreshed write", () => {
          // `undefined` is the refresh having succeeded. The rebuild already
          // left `error.log` empty, and saying anything here would describe a
          // clean write as a broken one.

          const bridge = new CellBridge(new FsTree(), "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "space", []);
          const tree = bridge.tree;
          const pieceIno = tree.addDir(state.piecesIno, "notes");
          const srcIno = tree.addDir(pieceIno, ".src");
          const errorLogIno = tree.addFile(srcIno, "error.log", "", "string");
          state.srcInos.set("notes", srcIno);
          state.srcErrorLogInos.set("notes", errorLogIno);

          const errors = captureConsoleErrors();
          try {
            bridge.reportSourceRefreshWarning(
              sourceWritePath("space", "notes", srcIno),
              undefined,
            );
          } finally {
            errors.restore();
          }

          expect(getFileContent(tree, srcIno, "error.log")).toBe("");
          expect(errors.lines).toEqual([]);
        });

        it("leaves an authored `error.log` alone", () => {
          // `CellBridge.#buildSourceTree()` mints the synthetic `error.log`
          // only when no authored source file claims that name, so a piece that
          // ships one of its own has no synthetic file and no entry in
          // `srcErrorLogInos`. Resolving the file by name here would find the
          // authored one and overwrite committed source with this report; the
          // console line is the whole report such a piece gets.

          const bridge = new CellBridge(new FsTree(), "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "space", []);
          const tree = bridge.tree;
          const pieceIno = tree.addDir(state.piecesIno, "notes");
          const srcIno = tree.addDir(pieceIno, ".src");
          tree.addFile(srcIno, "error.log", "export default 1;\n", "string");
          state.srcInos.set("notes", srcIno);
          // No srcErrorLogInos entry: the authored file claimed the name.

          const errors = captureConsoleErrors();
          try {
            bridge.reportSourceRefreshWarning(
              sourceWritePath("space", "notes", srcIno),
              "committed, but the refresh failed",
            );
          } finally {
            errors.restore();
          }

          expect(getFileContent(tree, srcIno, "error.log")).toBe(
            "export default 1;\n",
          );
          expect(errors.lines.length).toBe(1);
        });

        it("reports to the console alone with no source tree to write into", () => {
          // A system piece, or one whose rebuild was skipped, has no `.src` and
          // so no synthetic error.log to keep the report in. The write still
          // committed, so the console line stands in for the file rather than
          // the report being lost or the call failing over a directory that was
          // never built.

          const bridge = new CellBridge(new FsTree(), "/tmp/cf-exec");
          buildTestSpace(bridge, "space", []);

          const errors = captureConsoleErrors();
          try {
            bridge.reportSourceRefreshWarning(
              sourceWritePath("space", "notes", 0n),
              "committed, but the refresh failed",
            );
          } finally {
            errors.restore();
          }

          expect(errors.lines.length).toBe(1);
        });
      });

      describe("finalizeSourceWritePath()", () => {
        it("preserves both warnings when the rebuild fails", async () => {
          // A committed write can fail twice: the piece refresh, carried by the
          // receipt, and then the projection rebuild here. The second failure
          // must not eat the first's message — "the source saved and the piece
          // is not running it" is the receipt's fact, not the rebuild's — so it
          // is reported even as the rebuild's own failure propagates to become
          // the caller's projection warning. The rebuild fails in its
          // metadata-refresh step, at the kernel invalidation of the piece's
          // `meta.json`, after the source tree has been rebuilt and a fresh
          // synthetic log tracked; a failure in the source-tree step itself
          // drops the tracked log before it can fail, and its receipt warning
          // reaches the console alone.

          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "space", []);
          const pieceIno = tree.addDir(state.piecesIno, "notes");
          const srcIno = tree.addDir(pieceIno, ".src");
          const errorLogIno = tree.addFile(srcIno, "error.log", "", "string");
          state.pieceInos.set("notes", pieceIno);
          state.srcInos.set("notes", srcIno);
          state.srcErrorLogInos.set("notes", errorLogIno);
          const piece = {
            id: "of:notes",
            getPatternSourceProgram: () =>
              Promise.resolve({
                main: "/main.tsx",
                files: [{ name: "/main.tsx", contents: "export default 2;" }],
              }),
            getPatternRef: () =>
              Promise.resolve({
                identity: "A".repeat(43),
                symbol: "default",
                source: {
                  ref: `cf:pattern:${"A".repeat(43)}`,
                  repository: "https://example.invalid/patterns",
                  entry: "/main.tsx",
                },
              }),
          };
          bridge.onInvalidate = (parentIno, names) => {
            if (parentIno === pieceIno && names.includes("meta.json")) {
              throw new Error("rebuild failed");
            }
          };
          const writePath = sourceWritePath("space", "notes", srcIno, piece);
          const receipt = {
            status: "committed" as const,
            ref: { identity: "A".repeat(43), symbol: "default" },
            revisionId: "revision-2",
            detachedOrigin: null,
            space: "did:key:test" as const,
            seq: 12,
            refresh: {
              status: "failed" as const,
              warning: "dependency unavailable",
            },
          };

          const errors = captureConsoleErrors();
          const finalized = await (async () => {
            try {
              return await finalizeCommittedSourceWrite(
                receipt,
                () => bridge.finalizeSourceWritePath(writePath, receipt),
              );
            } finally {
              errors.restore();
            }
          })();

          if (finalized.status !== "failed") {
            throw new Error(
              "the failed rebuild produced no persistent warning",
            );
          }
          // This is the outer flush's final write into the synthetic log.
          bridge.writeSourceErrorLog(writePath, finalized.logWarning);

          expect(
            errors.lines.filter((line) =>
              line.includes("refreshing the running piece failed")
            ).length,
          ).toBe(1);
          // The rebuild replaced `.src`, so the log is in the directory it
          // minted.
          expect(
            getFileContent(tree, tree.lookup(pieceIno, ".src")!, "error.log"),
          ).toEqual(
            `Source revision revision-2 committed as cf:module/${
              "A".repeat(43)
            }#default, but refreshing the running piece failed: dependency unavailable\n` +
              `Source revision revision-2 committed as cf:module/${
                "A".repeat(43)
              }#default, but refreshing the FUSE projection failed: rebuild failed`,
          );
        });
      });

      describe("#attemptReconnect()", () => {
        it("validates the existing piece registry", async () => {
          const tree = new FsTree();
          let piecesSyncs = 0;
          let piecesDisposals = 0;
          let registeredPieceReads = 0;
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            reconnectPiecesLoader: ({ apiUrl, space, identity }) => {
              expect(apiUrl).toBe("https://api.example.test/");
              expect(space).toBe("home");
              expect(identity).toBe("/tmp/test-identity.pem");
              return Promise.resolve(
                {
                  synced: () => {
                    piecesSyncs++;
                    return Promise.resolve();
                  },
                  runtime: {
                    dispose: () => {
                      piecesDisposals++;
                      return Promise.resolve();
                    },
                  },
                } as unknown as SpaceState["pieces"],
              );
            },
          });
          bridge.init({
            apiUrl: "https://api.example.test/",
            identity: "/tmp/test-identity.pem",
          });
          const state = buildTestSpace(bridge, "home", []);
          Object.assign(
            state.pieces,
            {
              getRegisteredPieces: () => {
                registeredPieceReads++;
                return Promise.resolve([]);
              },
            } as unknown as SpaceState["pieces"],
          );
          bridge.accessForTestingOnly.disconnected = true;

          await bridge.accessForTestingOnly.attemptReconnect();

          expect(piecesSyncs).toBe(1);
          expect(registeredPieceReads).toBe(1);
          expect(piecesDisposals).toBe(1);
          expect(bridge.disconnected).toBe(false);
        });

        it("reconnects a space whose manager has no entity listing support", async () => {
          const tree = new FsTree();
          let pieceListRequests = 0;
          let disposedManagers = 0;
          let sessionProbes = 0;
          const reconnectManager = {
            ensureSpaceSession: () => {
              sessionProbes++;
              return Promise.resolve();
            },
            synced: () => Promise.resolve(),
            getSpace: () => "did:key:zReconnectSpace",
            runtime: {
              storageManager: {
                authorizationError: () => undefined,
              },
              dispose: () => {
                disposedManagers++;
                return Promise.resolve();
              },
            },
          } as unknown as SpaceState["pieces"];
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            loadPieces: () => Promise.resolve(reconnectManager),
          });
          const state = buildTestSpace(bridge, "home", []);
          state.piecesHydrated = false;
          Object.assign(
            state.pieces,
            {
              getRegisteredPieces: () => {
                pieceListRequests++;
                return Promise.resolve([]);
              },
            } as unknown as SpaceState["pieces"],
          );

          const reconnectable = bridge.accessForTestingOnly;
          reconnectable.disconnected = true;
          await reconnectable.attemptReconnect();

          expect(bridge.disconnected).toBe(false);
          expect(sessionProbes).toBe(1);
          expect(pieceListRequests).toBe(0);
          expect(disposedManagers).toBe(1);
        });

        it("checks every space before resuming writes", async () => {
          const tree = new FsTree();
          const authorizationError = Object.assign(
            new Error("space access revoked"),
            { name: "AuthorizationError" },
          );
          const sessionProbes: string[] = [];
          const piecesSyncs: string[] = [];
          const disposedManagers: string[] = [];
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            loadPieces: ({ space }) =>
              Promise.resolve(
                {
                  ensureSpaceSession: () => {
                    sessionProbes.push(space);
                    return Promise.resolve();
                  },
                  synced: () => {
                    piecesSyncs.push(space);
                    return Promise.resolve();
                  },
                  getSpace: () => `did:key:z${space}`,
                  runtime: {
                    storageManager: {
                      authorizationError: () =>
                        space === "revoked" ? authorizationError : undefined,
                    },
                    dispose: () => {
                      disposedManagers.push(space);
                      return Promise.resolve();
                    },
                  },
                } as unknown as SpaceState["pieces"],
              ),
          });
          for (const space of ["authorized", "revoked"]) {
            const state = buildTestSpace(bridge, space, []);
            state.piecesHydrated = false;
            Object.assign(
              state.pieces,
              {
                getRegisteredPieces: () => {
                  throw new Error(
                    "unhydrated piece registries must not be read",
                  );
                },
              } as unknown as SpaceState["pieces"],
            );
          }

          const reconnectable = bridge.accessForTestingOnly;
          reconnectable.disconnected = true;
          await reconnectable.attemptReconnect();
          if (reconnectable.reconnectTimer !== null) {
            clearTimeout(reconnectable.reconnectTimer);
            reconnectable.reconnectTimer = null;
          }

          expect(bridge.disconnected).toBe(true);
          expect(sessionProbes).toEqual(["authorized", "revoked"]);
          expect(piecesSyncs).toEqual(["authorized", "revoked"]);
          expect(disposedManagers).toEqual(["authorized", "revoked"]);
        });
      });

      describe("#removeFailedSpaceTree()", () => {
        it("cancels every subscription and forgets every table entry of the space", () => {
          // The cleanup a late connection failure runs, driven on a space
          // seeded with every kind of state a partially built space can hold:
          // cancels in both subscription tables, a partial piece and entity
          // directory, and an entry in each per-entity and per-space table.

          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);
          const internals = bridge.accessForTestingOnly;
          let cancellations = 0;
          const cancel = () => {
            cancellations++;
          };
          state.unsubscribes.push(cancel);
          state.pieceSubs.set("partial-piece", [cancel]);
          tree.addDir(state.piecesIno, "partial-piece");
          const entityIno = tree.addDir(state.entitiesIno, "partial-entity");
          internals.entitySubscriptions.set(entityIno, [cancel]);
          internals.unhydratedEntityRoots.set(
            entityIno,
            {} as UnhydratedEntityRootInfo,
          );
          internals.pendingEntityHydrations.set(
            entityIno,
            Promise.resolve(false),
          );
          internals.entityProjectionLru.set(
            entityIno,
            {} as UnhydratedEntityRootInfo,
          );
          internals.entityProjectionEvictionCandidates.set(
            entityIno,
            {} as UnhydratedEntityRootInfo,
          );
          internals.entityProjectionUseOrder.set(entityIno, 1);
          internals.entityProjectionLookupRefs.set(entityIno, entityIno);
          internals.pendingEntityRemovals.set(
            entityIno,
            {} as UnhydratedEntityRootInfo,
          );
          internals.pendingPieceHydrations.set("home", Promise.resolve());
          internals.pieceSyncs.set("home", Promise.resolve());
          internals.syncAgain.add("home");

          internals.removeFailedSpaceTree("home", state);

          expect(cancellations).toBe(3);
          expect(tree.lookup(tree.rootIno, encodeFuseComponent("home")))
            .toBeUndefined();
          expect(internals.entitySubscriptions.has(entityIno)).toBe(false);
          expect(internals.unhydratedEntityRoots.has(entityIno)).toBe(false);
          expect(internals.pendingEntityHydrations.has(entityIno)).toBe(false);
          expect(internals.entityProjectionLru.has(entityIno)).toBe(false);
          expect(internals.entityProjectionEvictionCandidates.has(entityIno))
            .toBe(false);
          expect(internals.entityProjectionUseOrder.has(entityIno)).toBe(false);
          expect(internals.entityProjectionLookupRefs.has(entityIno)).toBe(
            false,
          );
          expect(internals.pendingEntityRemovals.has(entityIno)).toBe(false);
          expect(internals.pendingPieceHydrations.has("home")).toBe(false);
          expect(internals.pieceSyncs.has("home")).toBe(false);
          expect(internals.syncAgain.has("home")).toBe(false);
        });
      });

      describe("#loadPieceTree()", () => {
        it("creates `meta.json` with a pattern reference", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");

          const piece = {
            id: "of:entity-123",
            name: () => "My Note",
            getPatternRef: () =>
              Promise.resolve({
                identity: "A".repeat(43),
                symbol: "default",
                source: {
                  ref: `cf:pattern:${"A".repeat(43)}`,
                  repository: "https://github.com/commonfabric/labs",
                  entry: "/notes/note.tsx",
                },
              }),
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
          };

          const pieceIno = await bridge.accessForTestingOnly.loadPieceTree(
            fakePiece(piece),
            tree.rootIno,
            "My Note",
            "home",
          );

          const metaIno = tree.lookup(pieceIno, "meta.json");
          expect(metaIno, "meta.json should exist").toBeDefined();

          const meta = JSON.parse(getFileContent(tree, pieceIno, "meta.json"));
          expect(meta.id).toBe("of:entity-123");
          expect(meta.name).toBe("My Note");
          expect(meta.patternRef).toEqual({
            identity: "A".repeat(43),
            symbol: "default",
            source: {
              ref: `cf:pattern:${"A".repeat(43)}`,
              repository: "https://github.com/commonfabric/labs",
              entry: "/notes/note.tsx",
            },
          });
        });

        it("creates stable `input` and `result` stubs without eager hydration", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");

          const piece = {
            id: "of:entity-456",
            name: () => "Article",
            input: {
              getCell: () =>
                Promise.resolve(makeCell({ title: "hello" }, {
                  type: "object",
                  properties: { title: { type: "string" } },
                })),
              get: () => Promise.resolve({ title: "hello" }),
            },
            result: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
          };

          const pieceIno = await bridge.accessForTestingOnly.loadPieceTree(
            fakePiece(piece),
            tree.rootIno,
            "Article",
            "home",
          );

          const inputIno = tree.lookup(pieceIno, "input");
          const resultIno = tree.lookup(pieceIno, "result");
          expect(inputIno, "input/ stub dir should exist before hydration")
            .toBeDefined();
          expect(resultIno, "result/ stub dir should exist before hydration")
            .toBeDefined();
          expect(tree.getChildren(inputIno!).length).toBe(0);
          expect(tree.getChildren(resultIno!).length).toBe(0);
        });
      });

      describe("#hydratePieceProp()", () => {
        it("attaches CFC annotations to a hydrated JSON projection, failing closed without runner labels", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            cfcAnnotations: true,
            projectionGeneration: "test-generation",
          });
          const state = buildTestSpace(bridge, "home", []);

          const piece = {
            id: "of:entity-cfc",
            name: () => "Annotated Fixture",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () =>
                Promise.resolve(makeCell({ title: "secret" }, undefined)),
              get: () => Promise.resolve({ title: "secret" }),
            },
          };

          const pieceIno = await bridge.accessForTestingOnly.loadPieceTree(
            fakePiece(piece),
            state.piecesIno,
            "Annotated Fixture",
            "home",
          );
          await bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );

          const resultIno = tree.lookup(pieceIno, "result");
          expect(resultIno).toBeDefined();
          const titleIno = tree.lookup(resultIno!, "title");
          expect(titleIno).toBeDefined();

          const annotation = tree.getCfcAnnotation(titleIno!);
          expect(annotation?.ref).toEqual({
            type: "common-fabric-fuse-ref-v1",
            space: state.did,
            entity: "of:entity-cfc",
            rootKind: "pieces",
            cell: "result",
            path: ["title"],
            projection: "value",
            generation: "test-generation",
          });
          expect(
            JSON.stringify(annotation?.contentLabel).includes(
              CFC_FAIL_CLOSED_ATOM_CLASS,
            ),
          ).toBe(true);
          expect(
            listCfcXattrNames(tree, titleIno!, {
              enabled: true,
              namespace: "compat",
            }).includes(`${CFC_COMPAT_XATTR_PREFIX}ref`),
          ).toBe(true);
        });

        it("derives the CFC projection generation for a hydrated CFC mount", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            cfcAnnotations: true,
          });
          const state = buildTestSpace(bridge, "home", []);

          const makeResultCell = (title: string): FakeCell => {
            const searchToolCell = makeCell(
              {
                pattern: {
                  argumentSchema: {
                    type: "object",
                    properties: { query: { type: "string" } },
                  },
                },
                extraParams: { title },
              },
              undefined,
            );
            return makeCell(
              {
                title,
                search: searchToolCell.get(),
              },
              {
                type: "object",
                properties: {
                  title: { type: "string" },
                  search: { type: "object" },
                },
              },
              { search: searchToolCell },
            );
          };

          const initialResultCell = makeResultCell("one");
          const piece = {
            id: "of:entity-derived-generation",
            name: () => "Derived Generation",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(initialResultCell),
              get: () => Promise.resolve(initialResultCell.get()),
            },
          };

          const pieceIno = await bridge.accessForTestingOnly.loadPieceTree(
            fakePiece(piece),
            state.piecesIno,
            "Derived Generation",
            "home",
          );
          await bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );

          const resultIno = tree.lookup(pieceIno, "result");
          expect(resultIno).toBeDefined();
          const titleIno = tree.lookup(resultIno!, "title");
          const resultJsonIno = tree.lookup(pieceIno, "result.json");
          const callableIno = tree.lookup(resultIno!, "search.tool");
          expect(titleIno).toBeDefined();
          expect(resultJsonIno).toBeDefined();
          expect(callableIno).toBeDefined();

          const titleAnnotation = tree.getCfcAnnotation(titleIno!);
          const resultJsonAnnotation = tree.getCfcAnnotation(resultJsonIno!);
          const callableAnnotation = tree.getCfcAnnotation(callableIno!);
          expect(titleAnnotation?.generation.startsWith("sha256:")).toBe(true);
          expect(titleAnnotation?.generation).not.toBe("unavailable");
          expect(titleAnnotation?.ref.generation).toEqual(
            titleAnnotation?.generation,
          );
          expect(resultJsonAnnotation?.generation).toEqual(
            titleAnnotation?.generation,
          );
          expect(callableAnnotation?.generation).toEqual(
            titleAnnotation?.generation,
          );
          expect(callableAnnotation?.callable?.descriptor.generation).toEqual(
            titleAnnotation?.generation,
          );

          const rebuiltResultCell = makeResultCell("two");
          await bridge.accessForTestingOnly.rebuildPieceProp({
            cell: rebuiltResultCell as never,
            newValue: rebuiltResultCell.get(),
            pieceId: piece.id,
            pieceIno,
            pieceName: "Derived Generation",
            propName: "result",
            resolveLink: () => null,
            spaceName: "home",
          });

          const rebuiltResultIno = tree.lookup(pieceIno, "result");
          const rebuiltTitleIno = tree.lookup(rebuiltResultIno!, "title");
          const rebuiltAnnotation = tree.getCfcAnnotation(rebuiltTitleIno!);
          expect(rebuiltAnnotation?.generation).not.toBe(
            titleAnnotation?.generation,
          );
          expect(rebuiltAnnotation?.ref.generation).toEqual(
            rebuiltAnnotation?.generation,
          );
        });

        it("renders link-backed handlers only at discovered callable entries", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          const handlerLink = {
            "/": {
              "link@1": {
                path: ["recordMessage"],
                id: "of:handler-target",
                space: "did:key:zTest",
              },
            },
          };
          const nestedValue = { recordMessage: { text: "not callable" } };
          const handlerCell: FakeCell = {
            schema: { type: "object" },
            get: () => handlerLink,
            getRaw: () => undefined,
            asSchemaFromLinks() {
              return this;
            },
            key: () => makeCell(undefined, undefined),
            sink: () => () => {},
            isStream: () => true,
          };
          const resultCell = makeCell(
            { recordMessage: handlerLink, nested: nestedValue },
            {
              type: "object",
              properties: {
                recordMessage: { type: "object" },
                nested: { type: "object" },
              },
            },
            {
              recordMessage: handlerCell,
              nested: makeCell(nestedValue, { type: "object" }),
            },
          );

          const piece = {
            id: "of:entity-link-handler",
            name: () => "Link Handler",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(resultCell),
              get: () =>
                Promise.resolve({
                  recordMessage: handlerLink,
                  nested: nestedValue,
                }),
            },
          };

          const pieceIno = await bridge.accessForTestingOnly.loadPieceTree(
            fakePiece(piece),
            state.piecesIno,
            "Link-Handler",
            "home",
          );
          const hydrated = await bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );

          expect(hydrated).toBe(true);
          const resultIno = tree.lookup(pieceIno, "result");
          expect(tree.lookup(resultIno!, "recordMessage.handler"))
            .toBeDefined();

          const resultJson = JSON.parse(
            getFileContent(tree, pieceIno, "result.json"),
          );
          expect(resultJson.recordMessage).toEqual({
            "/handler": "recordMessage",
          });
          expect(resultJson.nested.recordMessage).toEqual({
            text: "not callable",
          });
          expect(
            JSON.parse(getFileContent(tree, resultIno!, "nested.json"))
              .recordMessage,
          ).toEqual({ text: "not callable" });
        });

        it("bakes a handler's content-addressed schema into the shim expanded", async () => {
          // The shim runs later, under `cf exec`, with no registry to resolve
          // against — so a schema the runtime carries as a `cid:` reference has
          // to be written into the shim in its expanded form, here and not
          // there.

          const eventSchema = {
            type: "object",
            properties: { text: { type: "string" } },
          } as const;
          const { rootRef, documents } = decomposeSchema(eventSchema);
          for (const [hash, document] of documents) {
            registerSchemaDocument(hash, document);
          }

          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          const handlerLink = {
            "/": {
              "link@1": {
                path: ["recordMessage"],
                id: "of:handler-target",
                space: "did:key:zTest",
              },
            },
          };
          const streamCell = (schema: unknown): FakeCell => ({
            schema: schema as FakeCell["schema"],
            get: () => handlerLink,
            getRaw: () => undefined,
            asSchemaFromLinks() {
              return this;
            },
            key: () => makeCell(undefined, undefined),
            sink: () => () => {},
            isStream: () => true,
          });
          // A reference the registry cannot supply stays a reference: the shim
          // carries it verbatim rather than inventing structure or failing the
          // bake.
          const absentRef = rootRef.slice(0, -4) + "AAAA";
          const resultCell = makeCell(
            { recordMessage: handlerLink, recordUnresolved: handlerLink },
            {
              type: "object",
              properties: {
                recordMessage: { type: "object" },
                recordUnresolved: { type: "object" },
              },
            },
            {
              recordMessage: streamCell({ $ref: rootRef }),
              recordUnresolved: streamCell({ $ref: absentRef }),
            },
          );

          const piece = {
            id: "of:entity-ref-schema-handler",
            name: () => "Ref Schema Handler",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(resultCell),
              get: () =>
                Promise.resolve({
                  recordMessage: handlerLink,
                  recordUnresolved: handlerLink,
                }),
            },
          };

          const pieceIno = await bridge.accessForTestingOnly.loadPieceTree(
            fakePiece(piece),
            state.piecesIno,
            "Ref-Schema-Handler",
            "home",
          );
          const hydrated = await bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );
          expect(hydrated).toBe(true);

          const resultIno = tree.lookup(pieceIno, "result");
          const shimIno = tree.lookup(resultIno!, "recordMessage.handler");
          const shimNode = tree.getNode(shimIno!);
          expect(shimNode?.kind).toBe("callable");
          const shim = new TextDecoder().decode(
            (shimNode as { script: Uint8Array }).script,
          );
          expect(shim).toContain('"text"');
          expect(shim).not.toContain("cid:");

          const unresolvedIno = tree.lookup(
            resultIno!,
            "recordUnresolved.handler",
          );
          const unresolvedNode = tree.getNode(unresolvedIno!);
          const unresolvedShim = new TextDecoder().decode(
            (unresolvedNode as { script: Uint8Array }).script,
          );
          expect(unresolvedShim).toContain(absentRef);
        });

        it("materializes `input` and `result` on demand", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          const piece = {
            id: "of:entity-789",
            name: () => "Post",
            input: {
              getCell: () =>
                Promise.resolve(makeCell({ title: "hello" }, {
                  type: "object",
                  properties: { title: { type: "string" } },
                })),
              get: () => Promise.resolve({ title: "hello" }),
            },
            result: {
              getCell: () =>
                Promise.resolve(makeCell({ content: "world" }, {
                  type: "object",
                  properties: { content: { type: "string" } },
                })),
              get: () => Promise.resolve({ content: "world" }),
            },
          };

          state.pieceControllers.set(
            "Post",
            fakePiece(piece),
          );
          const pieceIno = await bridge.accessForTestingOnly.loadPieceTree(
            fakePiece(piece),
            state.piecesIno,
            "Post",
            "home",
          );
          state.pieceMap.set("Post", piece.id);
          state.pieceInos.set("Post", pieceIno);

          await bridge.accessForTestingOnly.hydratePieceProp(pieceIno, "input");
          const inputIno = tree.lookup(pieceIno, "input");
          expect(inputIno, "input/ dir should exist after hydration")
            .toBeDefined();
          expect(getFileContent(tree, inputIno!, "title")).toBe("hello");

          await bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );
          const resultIno = tree.lookup(pieceIno, "result");
          expect(resultIno, "result/ dir should exist after hydration")
            .toBeDefined();

          const contentValue = getFileContent(tree, resultIno!, "content");
          expect(contentValue).toBe("world");
        });

        it("reads the cell once for a prop that is already hydrated", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);
          let resultGets = 0;
          let resultCellGets = 0;

          const piece = {
            id: "of:cached-piece",
            name: () => "Cached Piece",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => {
                resultCellGets++;
                return Promise.resolve(makeCell({ content: "world" }, {
                  type: "object",
                  properties: { content: { type: "string" } },
                }));
              },
              get: () => {
                resultGets++;
                return Promise.resolve({ content: "world" });
              },
            },
          };

          const addPiece = bridge.accessForTestingOnly.addPieceToSpace;
          await addPiece(state, fakePiece(piece), "home");

          const pieceIno = tree.lookup(state.piecesIno, "Cached-Piece")!;
          const initialResultCellGets = resultCellGets;
          const initialResultGets = resultGets;
          await bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );
          await bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );

          expect(resultCellGets - initialResultCellGets).toBe(1);
          expect(resultGets - initialResultGets).toBe(1);
          expect(tree.lookup(pieceIno, "result")).toBeDefined();
        });

        it("labels void handlers as no-arg callables in `.handlers`", async () => {
          // The stream's document holds no value: the result schema's
          // declaration is all that says `onAddContact` is a handler.
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          const onAddContactCell = makeCell(
            undefined,
            { asCell: ["stream"] },
            {},
            { isStream: true },
          );
          const resultCell = makeCell(
            {},
            {
              type: "object",
              properties: {
                onAddContact: { asCell: ["stream"] },
              },
            },
            { onAddContact: onAddContactCell },
          );

          const piece = {
            id: "of:entity-void-handler",
            name: () => "Contact Book",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(resultCell),
              get: () => Promise.resolve({}),
            },
          };

          state.pieceControllers.set(
            "Contact Book",
            fakePiece(piece),
          );
          const pieceIno = await bridge.accessForTestingOnly.loadPieceTree(
            fakePiece(piece),
            state.piecesIno,
            "Contact Book",
            "home",
          );
          state.pieceMap.set("Contact Book", piece.id);
          state.pieceInos.set("Contact Book", pieceIno);

          await bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );

          const handlers = getFileContent(tree, pieceIno, ".handlers");
          expect(
            handlers.includes(
              "onAddContact.handler  void (invoke with no args)",
            ),
          ).toBe(true);
        });
      });

      describe("#rebuildPieceProp()", () => {
        it("reuses a callable's inode across a rebuild", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          const initialToolCell = makeCell(
            {
              pattern: {
                argumentSchema: {
                  type: "object",
                  properties: { query: { type: "string" } },
                },
              },
              extraParams: { source: "before" },
            },
            undefined,
          );
          const initialResultCell = makeCell(
            {
              title: "before",
              search: initialToolCell.get(),
            },
            {
              type: "object",
              properties: {
                title: { type: "string" },
                search: { type: "object" },
              },
            },
            { search: initialToolCell },
          );

          const piece = {
            id: "of:entity-stale-callable",
            name: () => "Callable Fixture",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(initialResultCell),
              get: () => Promise.resolve(initialResultCell.get()),
            },
          };

          state.pieceControllers.set(
            "Callable Fixture",
            fakePiece(piece),
          );
          const pieceIno = await bridge.accessForTestingOnly.loadPieceTree(
            fakePiece(piece),
            state.piecesIno,
            "Callable Fixture",
            "home",
          );
          state.pieceMap.set("Callable Fixture", piece.id);
          state.pieceInos.set("Callable Fixture", pieceIno);

          await bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );

          const initialResultIno = tree.lookup(pieceIno, "result");
          expect(initialResultIno).toBeDefined();
          const initialToolIno = tree.lookup(initialResultIno!, "search.tool");
          expect(initialToolIno).toBeDefined();

          const rebuiltToolCell = makeCell(
            {
              pattern: {
                argumentSchema: {
                  type: "object",
                  properties: { query: { type: "string" } },
                },
              },
              extraParams: { source: "after" },
            },
            undefined,
          );
          const rebuiltResultCell = makeCell(
            {
              title: "after",
              search: rebuiltToolCell.get(),
            },
            {
              type: "object",
              properties: {
                title: { type: "string" },
                search: { type: "object" },
              },
            },
            { search: rebuiltToolCell },
          );

          await bridge.accessForTestingOnly.rebuildPieceProp({
            cell: rebuiltResultCell as never,
            newValue: rebuiltResultCell.get(),
            pieceId: piece.id,
            pieceIno,
            pieceName: "Callable Fixture",
            propName: "result",
            resolveLink: () => null,
            spaceName: "home",
          });

          // The result directory and the callable inside it both still exist at
          // the same path with the same kind, so the rebuild adopts their
          // inodes rather than allocating new ones.
          const currentResultIno = tree.lookup(pieceIno, "result");
          expect(currentResultIno).toBe(initialResultIno);
          const currentToolIno = tree.lookup(currentResultIno!, "search.tool");
          expect(currentToolIno).toBe(initialToolIno);
          expect(tree.getNode(currentToolIno!)?.kind).toBe("callable");
        });

        it("keeps inodes stable and invalidates only changed values", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          const inputSchema = {
            type: "object",
            properties: {
              title: { type: "string" },
              count: { type: "number" },
            },
          };
          const piece = {
            id: "of:stable-inode-piece",
            name: () => "Stable Piece",
            input: {
              getCell: () =>
                Promise.resolve(
                  makeCell({ title: "before", count: 1 }, inputSchema),
                ),
              get: () => Promise.resolve({ title: "before", count: 1 }),
            },
            result: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
          };

          state.pieceControllers.set(
            "Stable Piece",
            fakePiece(piece),
          );
          const pieceIno = await bridge.accessForTestingOnly.loadPieceTree(
            fakePiece(piece),
            state.piecesIno,
            "Stable Piece",
            "home",
          );
          state.pieceMap.set("Stable Piece", piece.id);
          state.pieceInos.set("Stable Piece", pieceIno);

          await bridge.accessForTestingOnly.hydratePieceProp(pieceIno, "input");

          const inputIno = tree.lookup(pieceIno, "input")!;
          const titleIno = tree.lookup(inputIno, "title")!;
          const countIno = tree.lookup(inputIno, "count")!;

          const invalidatedInodes: bigint[] = [];
          bridge.onInvalidateInode = (ino) => invalidatedInodes.push(ino);

          await bridge.accessForTestingOnly.rebuildPieceProp({
            cell: makeCell({ title: "after", count: 1 }, inputSchema) as never,
            newValue: { title: "after", count: 1 },
            pieceId: piece.id,
            pieceIno,
            pieceName: "Stable Piece",
            propName: "input",
            resolveLink: () => null,
            spaceName: "home",
          });

          // Same paths, same kinds: the inodes are reused, not reallocated.
          expect(tree.lookup(pieceIno, "input")).toBe(inputIno);
          expect(tree.lookup(inputIno, "title")).toBe(titleIno);
          expect(tree.lookup(inputIno, "count")).toBe(countIno);
          expect(getFileContent(tree, inputIno, "title")).toBe("after");

          // Only the changed value's inode cache is dropped; the unchanged
          // sibling is left cached.
          expect(invalidatedInodes).toContain(titleIno);
          expect(invalidatedInodes).not.toContain(countIno);
        });

        it("clears stale result mounts when the value becomes `null`", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          const initialResultCell = makeCell(
            { title: "before" },
            {
              type: "object",
              properties: {
                title: { type: "string" },
              },
            },
          );

          const piece = {
            id: "of:entity-null-result",
            name: () => "Null Result Fixture",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(initialResultCell),
              get: () => Promise.resolve(initialResultCell.get()),
            },
          };

          state.pieceControllers.set(
            "Null Result Fixture",
            fakePiece(piece),
          );
          const pieceIno = await bridge.accessForTestingOnly.loadPieceTree(
            fakePiece(piece),
            state.piecesIno,
            "Null Result Fixture",
            "home",
          );
          state.pieceMap.set("Null Result Fixture", piece.id);
          state.pieceInos.set("Null Result Fixture", pieceIno);

          await bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );

          const initialResultIno = tree.lookup(pieceIno, "result");
          expect(initialResultIno).toBeDefined();
          expect(getFileContent(tree, initialResultIno!, "title")).toBe(
            "before",
          );
          expect(tree.lookup(pieceIno, "result.json")).toBeDefined();

          await bridge.accessForTestingOnly.rebuildPieceProp({
            cell: makeCell(null, undefined) as never,
            newValue: null,
            pieceId: piece.id,
            pieceIno,
            pieceName: "Null Result Fixture",
            propName: "result",
            resolveLink: () => null,
            spaceName: "home",
          });

          expect(tree.lookup(pieceIno, "result")).toBeUndefined();
          expect(tree.lookup(pieceIno, "result.json")).toBeUndefined();
        });

        it("clears stale FS projection mounts when the value becomes `null`", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          const initialResultCell = new SinkableCell({
            $FS: {
              type: "text/markdown",
              content: "Hello",
              frontmatter: {
                meta: {
                  pinned: true,
                },
              },
            },
          });

          const piece = {
            id: "of:entity-null-fs",
            name: () => "Null FS Fixture",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () =>
                Promise.resolve(initialResultCell as unknown as FakeCell),
              get: () => Promise.resolve(initialResultCell.get()),
            },
          };

          const addPiece = bridge.accessForTestingOnly.addPieceToSpace;
          await addPiece(state, fakePiece(piece), "home");

          const pieceIno = tree.lookup(state.piecesIno, "Null-FS-Fixture")!;

          await bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );

          expect(tree.lookup(pieceIno, "index.md")).toBeDefined();
          expect(tree.lookup(pieceIno, "meta")).toBeDefined();

          await bridge.accessForTestingOnly.rebuildPieceProp({
            cell: makeCell(null, undefined) as never,
            newValue: null,
            pieceId: piece.id,
            pieceIno,
            pieceName: "Null FS Fixture",
            propName: "result",
            resolveLink: () => null,
            spaceName: "home",
          });

          expect(tree.lookup(pieceIno, "index.md")).toBeUndefined();
          expect(tree.lookup(pieceIno, "index.json")).toBeUndefined();
          expect(tree.lookup(pieceIno, "meta")).toBeUndefined();
        });

        it("keeps the FS projection index inode stable across a rebuild", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          const makeFsResult = (content: string) => ({
            $FS: {
              type: "text/markdown",
              content,
              frontmatter: { pinned: true },
            },
          });
          const resultCell = new SinkableCell(makeFsResult("Hello"));

          const piece = {
            id: "of:entity-stable-fs",
            name: () => "Stable FS Fixture",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(resultCell as unknown as FakeCell),
              get: () => Promise.resolve(resultCell.get()),
            },
          };

          state.pieceControllers.set(
            "Stable FS Fixture",
            fakePiece(piece),
          );
          const pieceIno = await bridge.accessForTestingOnly.loadPieceTree(
            fakePiece(piece),
            state.piecesIno,
            "Stable FS Fixture",
            "home",
          );
          state.pieceMap.set("Stable FS Fixture", piece.id);
          state.pieceInos.set("Stable FS Fixture", pieceIno);

          await bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );

          const indexIno = tree.lookup(pieceIno, "index.md")!;
          expect(indexIno).toBeDefined();
          expect(getFileContent(tree, pieceIno, "index.md").includes("Hello"))
            .toBe(true);

          const invalidatedInodes: bigint[] = [];
          bridge.onInvalidateInode = (ino) => invalidatedInodes.push(ino);

          resultCell.set(makeFsResult("Goodbye"));
          await bridge.accessForTestingOnly.rebuildPieceProp({
            cell: resultCell as never,
            newValue: resultCell.get(),
            pieceId: piece.id,
            pieceIno,
            pieceName: "Stable FS Fixture",
            propName: "result",
            resolveLink: () => null,
            spaceName: "home",
          });

          // The projection index survives with the same inode and updated
          // content, and its stale data cache is dropped.
          expect(tree.lookup(pieceIno, "index.md")).toBe(indexIno);
          expect(getFileContent(tree, pieceIno, "index.md").includes("Goodbye"))
            .toBe(true);
          expect(invalidatedInodes).toContain(indexIno);
        });

        it("reconciles a prop changing from an object to a scalar", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          const objectSchema = {
            type: "object",
            properties: { title: { type: "string" } },
          };
          const piece = {
            id: "of:object-to-scalar",
            name: () => "Object To Scalar",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () =>
                Promise.resolve(makeCell({ title: "x" }, objectSchema)),
              get: () => Promise.resolve({ title: "x" }),
            },
          };
          state.pieceControllers.set(
            "Object To Scalar",
            fakePiece(piece),
          );
          const pieceIno = await bridge.accessForTestingOnly.loadPieceTree(
            fakePiece(piece),
            state.piecesIno,
            "Object To Scalar",
            "home",
          );
          state.pieceMap.set("Object To Scalar", piece.id);
          state.pieceInos.set("Object To Scalar", pieceIno);

          await bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );
          expect(tree.getNode(tree.lookup(pieceIno, "result")!)?.kind).toBe(
            "dir",
          );
          expect(tree.lookup(pieceIno, "result.json")).toBeDefined();

          // The result becomes a bare string: `result` changes kind from a
          // directory to a file (its inode is replaced), and its `.json`
          // sibling disappears because a scalar has no aggregate form.
          await bridge.accessForTestingOnly.rebuildPieceProp({
            cell: makeCell("y", undefined) as never,
            newValue: "y",
            pieceId: piece.id,
            pieceIno,
            pieceName: "Object To Scalar",
            propName: "result",
            resolveLink: () => null,
            spaceName: "home",
          });

          const resultIno = tree.lookup(pieceIno, "result");
          expect(tree.getNode(resultIno!)?.kind).toBe("file");
          expect(getFileContent(tree, pieceIno, "result")).toBe("y");
          expect(tree.lookup(pieceIno, "result.json")).toBeUndefined();
        });

        it("invalidates the index dentry when an FS projection is removed", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          const resultCell = new SinkableCell({
            $FS: { type: "text/markdown", content: "Hello", frontmatter: {} },
          });
          const piece = {
            id: "of:entity-fs-removed",
            name: () => "FS Removed Fixture",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(resultCell as unknown as FakeCell),
              get: () => Promise.resolve(resultCell.get()),
            },
          };
          state.pieceControllers.set(
            "FS Removed Fixture",
            fakePiece(piece),
          );
          const pieceIno = await bridge.accessForTestingOnly.loadPieceTree(
            fakePiece(piece),
            state.piecesIno,
            "FS Removed Fixture",
            "home",
          );
          state.pieceMap.set("FS Removed Fixture", piece.id);
          state.pieceInos.set("FS Removed Fixture", pieceIno);

          await bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );
          expect(tree.lookup(pieceIno, "index.md")).toBeDefined();

          const entryInvalidations: string[] = [];
          bridge.onInvalidate = (parent, names) => {
            if (parent === pieceIno) entryInvalidations.push(...names);
          };

          resultCell.set(null);
          await bridge.accessForTestingOnly.rebuildPieceProp({
            cell: resultCell as never,
            newValue: null,
            pieceId: piece.id,
            pieceIno,
            pieceName: "FS Removed Fixture",
            propName: "result",
            resolveLink: () => null,
            spaceName: "home",
          });

          // The projection is gone from the tree, and its `index.md` dentry is
          // invalidated so a client drops the entry instead of resolving a
          // freed inode.
          expect(tree.lookup(pieceIno, "index.md")).toBeUndefined();
          expect(entryInvalidations).toContain("index.md");
        });

        it("advances the piece directory mtime only when its entries change", async () => {
          let clock = 1_000;
          const tree = new FsTree(() => clock);
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          const resultSchema = {
            type: "object",
            properties: {
              title: { type: "string" },
              count: { type: "number" },
            },
          };
          const piece = {
            id: "of:piece-dir-mtime",
            name: () => "Dir Mtime Fixture",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () =>
                Promise.resolve(
                  makeCell({ title: "a", count: 1 }, resultSchema),
                ),
              get: () => Promise.resolve({ title: "a", count: 1 }),
            },
          };
          state.pieceControllers.set(
            "Dir Mtime Fixture",
            fakePiece(piece),
          );
          const pieceIno = await bridge.accessForTestingOnly.loadPieceTree(
            fakePiece(piece),
            state.piecesIno,
            "Dir Mtime Fixture",
            "home",
          );
          state.pieceMap.set("Dir Mtime Fixture", piece.id);
          state.pieceInos.set("Dir Mtime Fixture", pieceIno);

          await bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );
          const afterHydrate = tree.getNode(pieceIno)!.mtime;

          // A content-only rebuild leaves the piece directory's entry set
          // unchanged, so its mtime is preserved.
          clock = 2_000;
          await bridge.accessForTestingOnly.rebuildPieceProp({
            cell: makeCell({ title: "b", count: 1 }, resultSchema) as never,
            newValue: { title: "b", count: 1 },
            pieceId: piece.id,
            pieceIno,
            pieceName: "Dir Mtime Fixture",
            propName: "result",
            resolveLink: () => null,
            spaceName: "home",
          });
          expect(tree.getNode(pieceIno)!.mtime).toBe(afterHydrate);

          // Removing the result drops result/, result.json and .handlers from
          // the piece directory, so its mtime advances.
          clock = 3_000;
          await bridge.accessForTestingOnly.rebuildPieceProp({
            cell: makeCell(null, undefined) as never,
            newValue: null,
            pieceId: piece.id,
            pieceIno,
            pieceName: "Dir Mtime Fixture",
            propName: "result",
            resolveLink: () => null,
            spaceName: "home",
          });
          expect(tree.getNode(pieceIno)!.mtime).toBe(3_000);
        });
      });

      describe("#enqueuePiecePropRebuild()", () => {
        it("runs rebuilds of the same prop one at a time", async () => {
          // Two real rebuilds of one prop. Each value is wider than one build
          // batch, so the first rebuild yields to a timer mid-way, and that
          // yield is where an unqueued second rebuild would start. A rebuild's
          // start is witnessed at the first thing it asks of the job's cell,
          // its schema, and its end at the projection-rebuilt hook.

          const time = new FakeTime();
          try {
            const tree = new FsTree();
            const events: string[] = [];
            let active = 0;
            let maxActive = 0;
            const bridge = new CellBridge(tree, "/tmp/cf-exec", {
              onCfcProjectionRebuilt: () => {
                active--;
                events.push("end");
              },
            });
            const state = buildTestSpace(bridge, "home", []);
            const pieceIno = tree.addDir(state.piecesIno, "queued");
            const enqueue = bridge.accessForTestingOnly.enqueuePiecePropRebuild;
            // More entries than one tree-builder batch (`BUILD_BATCH_SIZE` in
            // `tree-builder.ts`), so the build yields once mid-way.
            const entriesPerValue = 250;
            const wide = (label: string) =>
              Object.fromEntries(
                Array.from(
                  { length: entriesPerValue },
                  (_, i) => [`k${i}`, `${label}-${i}`],
                ),
              );
            const job = (label: string) => {
              const value = wide(label);
              const cell = makeCell(value, undefined);
              let started = false;
              const inner = cell.asSchemaFromLinks.bind(cell);
              cell.asSchemaFromLinks = () => {
                if (!started) {
                  started = true;
                  active++;
                  maxActive = Math.max(maxActive, active);
                  events.push(`start-${label}`);
                }
                return inner();
              };
              return {
                cell: cell as never,
                newValue: value,
                pieceId: "of:queued-prop",
                pieceIno,
                pieceName: "Queued Prop",
                propName: "input" as const,
                resolveLink: () => null,
                spaceName: "home",
              };
            };

            const first = enqueue(job("first"));
            await time.runMicrotasks();
            expect(events).toEqual(["start-first"]);

            // The first rebuild is parked on its mid-build yield; the second
            // must not start while it is.
            const second = enqueue(job("second"));
            await time.runMicrotasks();
            expect(events).toEqual(["start-first"]);

            // Each yield is scheduled by microtasks that run only after the
            // previous one fires, so the timers are fired one at a time with a
            // microtask drain between.
            while (await time.nextAsync()) {
              // The loop body is the firing.
            }
            await Promise.all([first, second]);

            expect(maxActive).toBe(1);
            expect(events).toEqual([
              "start-first",
              "end",
              "start-second",
              "end",
            ]);
            expect(
              getFileContent(tree, tree.lookup(pieceIno, "input")!, "k249"),
            ).toBe("second-249");
          } finally {
            time.restore();
          }
        });
      });

      describe("#addPieceToSpace()", () => {
        it("advances the pieces directory mtime", async () => {
          let clock = 1_000;
          const tree = new FsTree(() => clock);
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);
          const beforeAdd = tree.getNode(state.piecesIno)!.mtime;

          const piece = {
            id: "of:added-piece",
            name: () => "Added Piece",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
          };
          clock = 5_000;
          await bridge.accessForTestingOnly.addPieceToSpace(
            state,
            fakePiece(piece),
            "home",
          );

          // The pieces directory gained an entry, so its mtime advances past
          // its value at space construction.
          expect(tree.getNode(state.piecesIno)!.mtime > beforeAdd).toBe(true);
        });

        it("assigns a `-2` suffix on a name collision", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          const makeNotePiece = (id: string) => ({
            id,
            name: () => "My Note",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
          });

          const addPiece = bridge.accessForTestingOnly.addPieceToSpace;

          const name1 = await addPiece(
            state,
            fakePiece(makeNotePiece("of:id-1")),
            "home",
          );
          const name2 = await addPiece(
            state,
            fakePiece(makeNotePiece("of:id-2")),
            "home",
          );

          expect(name1).toBe("My-Note");
          expect(name2).toBe("My-Note-2");

          // Both entries should be in pieceMap
          expect(state.pieceMap.has("My-Note")).toBe(true);
          expect(state.pieceMap.has("My-Note-2")).toBe(true);

          // Both directories should exist in the tree
          expect(tree.lookup(state.piecesIno, "My-Note")).toBeDefined();
          expect(tree.lookup(state.piecesIno, "My-Note-2")).toBeDefined();
        });

        it("syncs a late-loading name before naming the directory", async () => {
          // On a cold runtime the piece list does not load the linked piece
          // docs, so a synchronous `piece.name()` read returns `undefined`
          // until the name doc is synced. The directory is named only after
          // that sync; named before it, the piece would mount under the opaque
          // id-derived fallback name, and stay there for as long as no later
          // change event fires.

          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          // name() returns undefined until getCell().asSchema(...).sync()
          // resolves — mirroring PieceController.name() reading a doc that
          // loads asynchronously.
          let nameLoaded = false;
          const piece = {
            id: "of:cold-start",
            name: () => (nameLoaded ? "Fuse Exec Fixture" : undefined),
            getCell: () => ({
              asSchema: () => ({
                sync: () => {
                  nameLoaded = true;
                  return Promise.resolve();
                },
              }),
            }),
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
          };

          const addPiece = bridge.accessForTestingOnly.addPieceToSpace;
          const name = await addPiece(state, fakePiece(piece), "home");

          expect(name).toBe("Fuse-Exec-Fixture");
          expect(
            tree.lookup(state.piecesIno, "Fuse-Exec-Fixture"),
            "piece dir should use the synced name, not the id fallback",
          ).toBeDefined();
        });

        it("assigns `-2` and `-3` suffixes for three collisions", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          const makeStandupPiece = (id: string) => ({
            id,
            name: () => "Standup",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
          });

          const addPiece = bridge.accessForTestingOnly.addPieceToSpace;

          const name1 = await addPiece(
            state,
            fakePiece(makeStandupPiece("of:su-1")),
            "home",
          );
          const name2 = await addPiece(
            state,
            fakePiece(makeStandupPiece("of:su-2")),
            "home",
          );
          const name3 = await addPiece(
            state,
            fakePiece(makeStandupPiece("of:su-3")),
            "home",
          );

          expect(name1).toBe("Standup");
          expect(name2).toBe("Standup-2");
          expect(name3).toBe("Standup-3");

          expect(tree.lookup(state.piecesIno, "Standup")).toBeDefined();
          expect(tree.lookup(state.piecesIno, "Standup-2")).toBeDefined();
          expect(tree.lookup(state.piecesIno, "Standup-3")).toBeDefined();
        });

        it("normalizes the projected piece directory name", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          const piece = {
            id: "of:piece-123",
            name: () => "  Hello, world! 🚀 / notes  ",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
          };

          const addPiece = bridge.accessForTestingOnly.addPieceToSpace;
          const projectedName = await addPiece(state, fakePiece(piece), "home");

          expect(projectedName).toBe("Hello-world-notes");
          expect(tree.lookup(state.piecesIno, "Hello-world-notes"))
            .toBeDefined();
          expect(
            JSON.parse(
              getFileContent(
                tree,
                tree.lookup(state.piecesIno, projectedName)!,
                "meta.json",
              ),
            ).name,
          ).toBe("  Hello, world! 🚀 / notes  ");
        });

        it("falls back to a normalized piece id for a symbol-only name", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          const piece = {
            id: "of:emoji-piece",
            name: () => "🔥✨",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
          };

          const addPiece = bridge.accessForTestingOnly.addPieceToSpace;
          const projectedName = await addPiece(state, fakePiece(piece), "home");

          expect(projectedName).toBe("of-emoji-piece");
          expect(tree.lookup(state.piecesIno, "of-emoji-piece")).toBeDefined();
        });

        it("reports a pattern metadata subscription failure", async () => {
          // The piece's root cell fires its meta sink at once, so the
          // subscription refreshes the pattern metadata immediately; the
          // refresh fails at the kernel invalidation of the piece's
          // `meta.json`, and the failure must be reported rather than
          // swallowed.

          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);
          const errors: string[] = [];
          const reported = defer<void>();
          const originalError = console.error;
          console.error = (...args: unknown[]) => {
            const line = args.join(" ");
            errors.push(line);
            if (line.includes("refresh failed")) reported.resolve();
          };

          const immediateRootCell = {
            asSchema: () => ({ sync: () => Promise.resolve() }),
            sinkMeta: (_key: string, sink: () => void) => {
              sink();
              return () => {};
            },
          };
          const patternRef = {
            identity: "B".repeat(43),
            symbol: "default",
            source: {
              ref: `cf:pattern:${"B".repeat(43)}`,
              repository: "https://example.invalid/patterns",
              entry: "/main.tsx",
            },
          };
          const piece = {
            id: "of:pattern-subscription-failure",
            name: () => "Pattern Subscription Failure",
            getCell: () => immediateRootCell,
            getPatternRef: () => Promise.resolve(patternRef),
            getPatternSourceProgram: () =>
              Promise.resolve({ main: "/main.tsx", files: [] }),
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
          };
          bridge.onInvalidate = (_parentIno, names) => {
            if (names.includes("meta.json")) throw new Error("refresh failed");
          };

          try {
            await bridge.accessForTestingOnly.addPieceToSpace(
              state,
              fakePiece(piece),
              "home",
            );
            await reported.promise;
          } finally {
            console.error = originalError;
          }

          expect(
            errors.some((line) =>
              line.includes("Could not refresh") &&
              line.includes("refresh failed")
            ),
          ).toBe(true);
          const subs = state.pieceSubs.get("Pattern Subscription Failure");
          if (subs) { for (const cancel of subs) cancel(); }
        });

        it("reports a pattern metadata setup failure", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);
          const errors: string[] = [];
          const originalError = console.error;
          console.error = (...args: unknown[]) => errors.push(args.join(" "));
          const piece = {
            id: "of:pattern-setup-failure",
            name: () => "Pattern Setup Failure",
            getCell: () => {
              throw new Error("root unavailable");
            },
            getPatternRef: () => Promise.resolve(undefined),
            getPatternSourceProgram: () =>
              Promise.resolve({ main: "/main.tsx", files: [] }),
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
          };

          try {
            await bridge.accessForTestingOnly.addPieceToSpace(
              state,
              fakePiece(piece),
              "home",
            );
          } finally {
            console.error = originalError;
          }

          expect(
            errors.some((line) =>
              line.includes("Could not subscribe") &&
              line.includes("root unavailable")
            ),
          ).toBe(true);
        });
      });

      describe("#refreshPiecePatternMetadata()", () => {
        it("leaves the manifest empty when the pattern reference is unavailable", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);
          const pieceIno = tree.addDir(state.piecesIno, "notes");
          let shouldReject = true;
          const piece = {
            id: "of:pattern-ref-failure",
            getPatternRef: () =>
              shouldReject
                ? Promise.reject(new Error("unavailable"))
                : Promise.resolve(undefined),
          };
          const refresh =
            bridge.accessForTestingOnly.refreshPiecePatternMetadata;

          await refresh(state, fakePiece(piece), pieceIno);
          shouldReject = false;
          await refresh(state, fakePiece(piece), pieceIno);

          expect(state.pieceManifest.size).toBe(0);
        });
      });

      describe("#updateIndexJson()", () => {
        it("writes `.index.json` mapping names to entity ids", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          const addPiece = bridge.accessForTestingOnly.addPieceToSpace;

          await addPiece(
            state,
            fakePiece({
              id: "of:alpha",
              name: () => "Alpha",
              input: {
                getCell: () => Promise.resolve(makeCell({}, undefined)),
                get: () => Promise.resolve({}),
              },
              result: {
                getCell: () => Promise.resolve(makeCell({}, undefined)),
                get: () => Promise.resolve({}),
              },
            }),
            "home",
          );

          await addPiece(
            state,
            fakePiece({
              id: "of:beta",
              name: () => "Beta",
              input: {
                getCell: () => Promise.resolve(makeCell({}, undefined)),
                get: () => Promise.resolve({}),
              },
              result: {
                getCell: () => Promise.resolve(makeCell({}, undefined)),
                get: () => Promise.resolve({}),
              },
            }),
            "home",
          );

          bridge.accessForTestingOnly.updateIndexJson(state);

          const indexJson = JSON.parse(
            getFileContent(tree, state.piecesIno, ".index.json"),
          );

          expect(indexJson["Alpha"]).toBe("of:alpha");
          expect(indexJson["Beta"]).toBe("of:beta");
        });
      });

      describe("#updatePiecesJson()", () => {
        it("writes cached manifest data without piece reads", () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          state.pieceMap.set("Alpha", "of:alpha");
          state.pieceMap.set("Beta", "of:beta");
          state.pieceManifest.set("of:alpha", {
            summary: "alpha summary",
            patternRef: {
              identity: "A".repeat(43),
              symbol: "default",
              source: {
                ref: `cf:pattern:${"A".repeat(43)}`,
                entry: "/alpha.tsx",
              },
            },
          });
          state.pieceManifest.set("of:beta", {
            summary: "beta summary",
          });

          bridge.accessForTestingOnly.updatePiecesJson(state);

          const piecesJson = JSON.parse(
            getFileContent(tree, state.piecesIno, "pieces.json"),
          );
          expect(piecesJson).toEqual([
            {
              id: "of:alpha",
              name: "Alpha",
              summary: "alpha summary",
              entityPath: "entities/of%3Aalpha",
              patternRef: {
                identity: "A".repeat(43),
                symbol: "default",
                source: {
                  ref: `cf:pattern:${"A".repeat(43)}`,
                  entry: "/alpha.tsx",
                },
              },
            },
            {
              id: "of:beta",
              name: "Beta",
              summary: "beta summary",
              entityPath: "entities/of%3Abeta",
            },
          ]);
        });
      });

      describe("#syncPieceListOnce()", () => {
        it("adds a new piece to the tree", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");

          const existingPiece = {
            id: "of:p1",
            name: () => "Piece One",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
          };

          const newPiece = {
            id: "of:p2",
            name: () => "Piece Two",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
          };

          // Build the space with only the first piece already added
          const state = buildTestSpace(bridge, "home", [
            existingPiece,
            newPiece,
          ]);

          const addPiece = bridge.accessForTestingOnly.addPieceToSpace;
          await addPiece(state, fakePiece(existingPiece), "home");

          // The registry mock now returns both pieces, so sync should add p2.
          await bridge.accessForTestingOnly.syncPieceListOnce(state, "home");

          expect(
            tree.lookup(state.piecesIno, "Piece-Two"),
            "Piece Two directory should appear after sync",
          ).toBeDefined();
          expect(state.pieceMap.has("Piece-Two")).toBe(true);
        });

        it("removes a deleted piece from the tree", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");

          const piece = {
            id: "of:gone",
            name: () => "Gone Piece",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
          };

          // Start with one piece in the tree
          const state = buildTestSpace(bridge, "home", []);

          const addPiece = bridge.accessForTestingOnly.addPieceToSpace;
          await addPiece(state, fakePiece(piece), "home");

          // Verify it was added
          expect(
            tree.lookup(state.piecesIno, "Gone-Piece"),
            "Piece should exist before sync",
          ).toBeDefined();

          // The registry mock now returns empty because the piece was deleted.
          Object.assign(
            state.pieces,
            {
              getRegisteredPieces: () => Promise.resolve([]),
            } as unknown as SpaceState["pieces"],
          );

          await bridge.accessForTestingOnly.syncPieceListOnce(state, "home");

          expect(
            tree.lookup(state.piecesIno, "Gone-Piece"),
            "Piece directory should be gone after sync",
          ).toBeUndefined();
          expect(state.pieceMap.size).toBe(0);
        });
      });

      describe("#subscribePiece()", () => {
        it("updates the `pieces.json` summary from the current result data after a rebuild", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);
          const resultCell = new SinkableCell({ summary: "before" });

          const piece = {
            id: "of:summary-piece",
            name: () => "Summary Piece",
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(resultCell as unknown as FakeCell),
              get: () => Promise.resolve(resultCell.get()),
            },
          };

          const addPiece = bridge.accessForTestingOnly.addPieceToSpace;
          await addPiece(state, fakePiece(piece), "home");

          bridge.accessForTestingOnly.updatePiecesJson(state);
          let piecesJson = JSON.parse(
            getFileContent(tree, state.piecesIno, "pieces.json"),
          );
          expect(piecesJson[0].summary).toBe("before");

          resultCell.set({ summary: "after" });
          // Wait for debounce (150ms) + rebuild
          await new Promise((resolve) => setTimeout(resolve, 250));

          piecesJson = JSON.parse(
            getFileContent(tree, state.piecesIno, "pieces.json"),
          );
          expect(piecesJson[0].summary).toBe("after");

          // Cancel subscriptions to avoid timer leaks
          const subs = state.pieceSubs.get("Summary-Piece");
          if (subs) { for (const cancel of subs) cancel(); }
        });

        it("keeps inodes stable across a reactive rebuild", async () => {
          const time = new FakeTime();
          try {
            const tree = new FsTree();
            const bridge = new CellBridge(tree, "/tmp/cf-exec");
            const state = buildTestSpace(bridge, "home", []);
            const resultCell = new SinkableCell({ title: "before", count: 1 });

            const piece = {
              id: "of:reactive-stable",
              name: () => "Reactive Stable",
              input: {
                getCell: () => Promise.resolve(makeCell({}, undefined)),
                get: () => Promise.resolve({}),
              },
              result: {
                getCell: () =>
                  Promise.resolve(resultCell as unknown as FakeCell),
                get: () => Promise.resolve(resultCell.get()),
              },
            };

            const addPiece = bridge.accessForTestingOnly.addPieceToSpace;
            await addPiece(state, fakePiece(piece), "home");

            const pieceIno = tree.lookup(state.piecesIno, "Reactive-Stable")!;
            await bridge.accessForTestingOnly.hydratePieceProp(
              pieceIno,
              "result",
            );

            const resultIno = tree.lookup(pieceIno, "result")!;
            const titleIno = tree.lookup(resultIno, "title")!;
            const countIno = tree.lookup(resultIno, "count")!;

            // An external mutation flows through the cell.sink subscription and
            // is rebuilt after the debounce.
            resultCell.set({ title: "after", count: 1 });
            await time.tickAsync(200);
            await time.runMicrotasks();

            // The reactive rebuild reconciled the mounted tree in place instead
            // of tearing it down, so a client that cached these paths keeps
            // their inodes.
            expect(tree.lookup(pieceIno, "result")).toBe(resultIno);
            expect(tree.lookup(resultIno, "title")).toBe(titleIno);
            expect(tree.lookup(resultIno, "count")).toBe(countIno);
            expect(getFileContent(tree, resultIno, "title")).toBe("after");

            const subs = state.pieceSubs.get("Reactive-Stable");
            if (subs) { for (const cancel of subs) cancel(); }
          } finally {
            time.restore();
          }
        });

        it("refreshes pattern references after an in-place swap", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);
          const rootCell = new PatternIdentityCell();
          let patternRef = {
            identity: "A".repeat(43),
            symbol: "default",
            source: {
              ref: `cf:pattern:${"A".repeat(43)}`,
              repository: "https://github.com/commonfabric/labs",
              entry: "/notes/note.tsx",
            },
          };
          const piece = {
            id: "of:swapped-piece",
            name: () => "Swapped Piece",
            getCell: () => rootCell,
            getPatternRef: () => Promise.resolve(patternRef),
            input: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({}),
            },
            result: {
              getCell: () => Promise.resolve(makeCell({}, undefined)),
              get: () => Promise.resolve({ summary: "current" }),
            },
          };

          const projectedName = await bridge.accessForTestingOnly
            .addPieceToSpace(
              state,
              fakePiece(piece),
              "home",
            );
          const entityName = encodeFuseComponent(piece.id);
          expect(await bridge.resolveEntity(state.entitiesIno, entityName))
            .toBe(true);
          const entityIno = tree.lookup(state.entitiesIno, entityName)!;
          expect(await bridge.prepareLookup(entityIno, "meta.json")).toBe(true);
          bridge.accessForTestingOnly.updatePiecesJson(
            state,
          );

          patternRef = {
            identity: "B".repeat(43),
            symbol: "default",
            source: {
              ref: `cf:pattern:${"B".repeat(43)}`,
              repository: "https://github.com/commonfabric/labs",
              entry: "/notes/note.tsx",
            },
          };
          const pieceIno = state.pieceInos.get(projectedName)!;
          const refreshed = defer();
          bridge.onInvalidate = (parentIno, names) => {
            if (parentIno === pieceIno && names.includes("meta.json")) {
              refreshed.resolve();
            }
          };
          rootCell.emit();
          await refreshed.promise;

          expect(
            JSON.parse(getFileContent(tree, pieceIno, "meta.json")).patternRef,
          ).toEqual(patternRef);
          expect(
            JSON.parse(getFileContent(tree, entityIno, "meta.json")).patternRef,
          ).toEqual(patternRef);
          const piecesJson = JSON.parse(
            getFileContent(tree, state.piecesIno, "pieces.json"),
          );
          expect(piecesJson[0].patternRef).toEqual(patternRef);

          patternRef = {
            ...patternRef,
            source: {
              ...patternRef.source,
              repository: "https://github.com/commonfabric/another-repo",
            },
          };
          const repositoryRefreshed = defer();
          bridge.onInvalidate = (parentIno, names) => {
            if (parentIno === pieceIno && names.includes("meta.json")) {
              repositoryRefreshed.resolve();
            }
          };
          rootCell.emit("patternRepository");
          await repositoryRefreshed.promise;
          expect(
            JSON.parse(getFileContent(tree, pieceIno, "meta.json")).patternRef,
          ).toEqual(patternRef);

          const subs = state.pieceSubs.get(projectedName);
          if (subs) { for (const cancel of subs) cancel(); }
        });

        it({
          name: "renames the directory when the piece name changes",
          sanitizeOps: false,
          fn: async () => {
            const tree = new FsTree();
            const bridge = new CellBridge(tree, "/tmp/cf-exec");
            const state = buildTestSpace(bridge, "home", []);

            // Mutable name — we'll change it before firing the sink
            let pieceName = "Old Name";

            const resultCell = new SinkableCell({});

            const piece = {
              id: "of:abc",
              name: () => pieceName,
              input: {
                getCell: () => Promise.resolve(makeCell({}, undefined)),
                get: () => Promise.resolve({}),
              },
              result: {
                getCell: () =>
                  Promise.resolve(resultCell as unknown as FakeCell),
                get: () => Promise.resolve({}),
              },
            };

            // First, add the piece to the space to set up the directory and
            // state maps
            const addPiece = bridge.accessForTestingOnly.addPieceToSpace;
            await addPiece(state, fakePiece(piece), "home");

            // Verify initial state
            expect(
              tree.lookup(state.piecesIno, "Old-Name"),
              "Old Name dir should exist initially",
            ).toBeDefined();

            // Cancel the addPieceToSpace subs before creating new ones
            const addedSubs = state.pieceSubs.get("Old-Name");
            if (addedSubs) { for (const cancel of addedSubs) cancel(); }

            // Now call subscribePiece separately to attach the rename sink
            const subs = await bridge.accessForTestingOnly.subscribePiece(
              fakePiece(piece),
              tree.lookup(state.piecesIno, "Old-Name")!,
              "Old-Name",
              "home",
              state,
            );

            // Store updated subs
            state.pieceSubs.set("Old-Name", subs);

            // Change the piece name before firing the sink
            pieceName = "New Name";

            // Trigger the result cell sink — rename is deferred via
            // setTimeout(0)
            resultCell.set({});

            // Wait for the deferred rename to execute
            await new Promise((r) => setTimeout(r, 10));

            expect(
              tree.lookup(state.piecesIno, "New-Name"),
              "New Name dir should exist after rename",
            ).toBeDefined();
            expect(
              tree.lookup(state.piecesIno, "Old-Name"),
              "Old Name dir should be gone after rename",
            ).toBeUndefined();

            // Cancel all subscriptions (clears debounce timers)
            for (const cancel of subs) cancel();
            for (const [, pieceSubs] of state.pieceSubs) {
              for (const cancel of pieceSubs) cancel();
            }
          },
        });

        it({
          name: "renames the directory using a normalized name",
          sanitizeOps: false,
          fn: async () => {
            const tree = new FsTree();
            const bridge = new CellBridge(tree, "/tmp/cf-exec");
            const state = buildTestSpace(bridge, "home", []);

            let pieceName = "Start Here";
            const resultCell = new SinkableCell({});

            const piece = {
              id: "of:abc",
              name: () => pieceName,
              input: {
                getCell: () => Promise.resolve(makeCell({}, undefined)),
                get: () => Promise.resolve({}),
              },
              result: {
                getCell: () =>
                  Promise.resolve(resultCell as unknown as FakeCell),
                get: () => Promise.resolve({}),
              },
            };

            const addPiece = bridge.accessForTestingOnly.addPieceToSpace;
            await addPiece(state, fakePiece(piece), "home");

            // Cancel the addPieceToSpace subs before creating new ones
            const addedSubs = state.pieceSubs.get("Start-Here");
            if (addedSubs) { for (const cancel of addedSubs) cancel(); }

            const subs = await bridge.accessForTestingOnly.subscribePiece(
              fakePiece(piece),
              tree.lookup(state.piecesIno, "Start-Here")!,
              "Start-Here",
              "home",
              state,
            );

            state.pieceSubs.set("Start-Here", subs);

            pieceName = "Renamed 🚀 Piece";
            resultCell.set({});
            await new Promise((r) => setTimeout(r, 10));

            expect(tree.lookup(state.piecesIno, "Renamed-Piece")).toBeDefined();
            expect(tree.lookup(state.piecesIno, "Start-Here")).toBeUndefined();

            // Cancel all subscriptions (clears debounce timers)
            for (const cancel of subs) cancel();
            for (const [, pieceSubs] of state.pieceSubs) {
              for (const cancel of pieceSubs) cancel();
            }
          },
        });

        it("clears stale FS root entries when the result switches to a `result/` tree", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);

          const inputCell = new SinkableCell({});
          const resultCell = new SinkableCell({
            $FS: {
              type: "text/markdown",
              content: "Hello",
              frontmatter: {
                meta: {
                  pinned: true,
                },
              },
            },
          });

          const piece = {
            id: "of:fs-piece",
            name: () => "FS Piece",
            input: {
              getCell: () => Promise.resolve(inputCell as unknown as FakeCell),
              get: () => Promise.resolve(inputCell.get()),
            },
            result: {
              getCell: () => Promise.resolve(resultCell as unknown as FakeCell),
              get: () => Promise.resolve(resultCell.get()),
            },
          };

          const addPiece = bridge.accessForTestingOnly.addPieceToSpace;
          await addPiece(state, fakePiece(piece), "home");

          const pieceIno = tree.lookup(state.piecesIno, "FS-Piece")!;
          await bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );
          expect(tree.lookup(pieceIno, "index.md")).toBeDefined();
          expect(tree.lookup(pieceIno, "meta")).toBeDefined();
          expect(tree.lookup(pieceIno, "result")).toBeUndefined();

          resultCell.set({ content: "Now a regular result tree" });
          await new Promise((r) => setTimeout(r, 10));
          bridge.invalidateWritePath({
            spaceName: "home",
            pieceName: "FS-Piece",
            cell: "result",
            jsonPath: ["content"],
            isJsonFile: false,
            piece: fakePiece(piece),
          });
          await bridge.accessForTestingOnly.hydratePieceProp(
            pieceIno,
            "result",
          );

          const resultIno = tree.lookup(pieceIno, "result");
          expect(resultIno, "result/ dir should exist").toBeDefined();
          expect(
            tree.lookup(pieceIno, "index.md"),
            "index.md should be removed when leaving FS projection mode",
          ).toBeUndefined();
          expect(
            tree.lookup(pieceIno, "meta"),
            "Complex frontmatter dirs should be removed when leaving FS projection mode",
          ).toBeUndefined();
          expect(
            resultIno !== undefined
              ? getFileContent(tree, resultIno, "content")
              : "",
          ).toBe("Now a regular result tree");

          // Cancel subscriptions to avoid timer leaks
          const subs = state.pieceSubs.get("FS-Piece");
          if (subs) { for (const cancel of subs) cancel(); }
        });

        it({
          name:
            "falls back to a pulled value when a sink update is `undefined`",
          sanitizeOps: false,
          fn: async () => {
            const tree = new FsTree();
            const bridge = new CellBridge(tree, "/tmp/cf-exec");
            const state = buildTestSpace(bridge, "home", []);

            const inputCell = new SinkableCell({});
            const resultCell = new SinkableCell({ content: "Initial" });

            const piece = {
              id: "of:undefined-sink-piece",
              name: () => "Undefined Sink Piece",
              input: {
                getCell: () =>
                  Promise.resolve(inputCell as unknown as FakeCell),
                get: () => Promise.resolve(inputCell.get()),
              },
              result: {
                getCell: () =>
                  Promise.resolve(resultCell as unknown as FakeCell),
                get: () => Promise.resolve({ content: "Pulled fallback" }),
              },
            };

            const addPiece = bridge.accessForTestingOnly.addPieceToSpace;
            await addPiece(state, fakePiece(piece), "home");

            const pieceIno = tree.lookup(
              state.piecesIno,
              "Undefined-Sink-Piece",
            )!;
            await bridge.accessForTestingOnly.hydratePieceProp(
              pieceIno,
              "result",
            );
            resultCell.set(undefined);
            await new Promise((r) => setTimeout(r, 250));

            const resultIno = tree.lookup(pieceIno, "result");
            expect(resultIno).toBeDefined();
            expect(getFileContent(tree, resultIno!, "content")).toBe(
              "Pulled fallback",
            );

            const subs = state.pieceSubs.get("Undefined-Sink-Piece");
            if (subs) { for (const cancel of subs) cancel(); }
          },
        });

        it({
          name:
            "keeps the mounted result when an `undefined` update has no replacement yet",
          sanitizeOps: false,
          fn: async () => {
            const tree = new FsTree();
            const bridge = new CellBridge(tree, "/tmp/cf-exec");
            const state = buildTestSpace(bridge, "home", []);

            const inputCell = new SinkableCell({});
            const resultCell = new SinkableCell({ content: "Initial" });
            let getterValue: unknown = { content: "Initial" };

            const piece = {
              id: "of:undefined-transient-piece",
              name: () => "Undefined Transient Piece",
              input: {
                getCell: () =>
                  Promise.resolve(inputCell as unknown as FakeCell),
                get: () => Promise.resolve(inputCell.get()),
              },
              result: {
                getCell: () =>
                  Promise.resolve(resultCell as unknown as FakeCell),
                get: () => Promise.resolve(getterValue),
              },
            };

            const addPiece = bridge.accessForTestingOnly.addPieceToSpace;
            await addPiece(state, fakePiece(piece), "home");

            const pieceIno = tree.lookup(
              state.piecesIno,
              "Undefined-Transient-Piece",
            )!;
            await bridge.accessForTestingOnly.hydratePieceProp(
              pieceIno,
              "result",
            );

            getterValue = undefined;
            resultCell.set(undefined);
            await new Promise((r) => setTimeout(r, 250));

            const resultIno = tree.lookup(pieceIno, "result");
            expect(resultIno).toBeDefined();
            expect(getFileContent(tree, resultIno!, "content")).toBe("Initial");

            const subs = state.pieceSubs.get("Undefined-Transient-Piece");
            if (subs) { for (const cancel of subs) cancel(); }
          },
        });
      });

      describe("#buildSourceTree()", () => {
        it("encodes source path segments and decodes write paths", async () => {
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);
          const pieceIno = tree.addDir(state.piecesIno, "notes");
          const piece = {
            id: "of:source-piece",
            getPatternSourceProgram: () =>
              Promise.resolve({
                main: "/src/has:colon.tsx",
                files: [
                  { name: "/src/has:colon.tsx", contents: "export default 1;" },
                ],
              }),
          };
          state.pieceControllers.set("notes", fakePiece(piece));
          state.srcInos.set("notes", pieceIno);

          await bridge.accessForTestingOnly.buildSourceTree(
            pieceIno,
            fakePiece(piece),
            state,
            "notes",
          );

          const srcIno = tree.lookup(pieceIno, ".src")!;
          const srcDirIno = tree.lookup(srcIno, "src")!;
          const sourceIno = tree.lookup(srcDirIno, "has%3Acolon.tsx")!;
          expect(bridge.resolveSourceWritePath(sourceIno)?.relPath).toBe(
            "src/has:colon.tsx",
          );
        });

        it("stops tracking a synthetic `error.log` the source takes over", async () => {
          // The synthetic log is minted only while no authored file claims the
          // name, so a rebuild whose new source DOES claim it leaves no
          // synthetic file at all. Tracking has to drop with it: writing
          // through the inode the previous rebuild recorded would hit a node
          // that is no longer a file, which turns a committed source update
          // into a failed write at the mount.

          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec");
          const state = buildTestSpace(bridge, "home", []);
          const pieceIno = tree.addDir(state.piecesIno, "notes");
          let files = [{ name: "/main.tsx", contents: "export default 1;" }];
          const piece = {
            id: "of:source-piece",
            getPatternSourceProgram: () =>
              Promise.resolve({ main: "/main.tsx", files }),
          };
          state.pieceControllers.set("notes", fakePiece(piece));
          const build = () =>
            bridge.accessForTestingOnly.buildSourceTree(
              pieceIno,
              fakePiece(piece),
              state,
              "notes",
            );

          // First rebuild: nothing claims the name, so the synthetic log
          // exists.
          await build();
          const syntheticIno = state.srcErrorLogInos.get("notes");
          expect(syntheticIno, "the synthetic error.log was not minted")
            .toBeDefined();

          // Second rebuild: the source now ships its own error.log.
          files = [
            { name: "/main.tsx", contents: "export default 1;" },
            { name: "/error.log", contents: "authored, not a diagnostic\n" },
          ];
          await build();

          expect(state.srcErrorLogInos.get("notes")).toBeUndefined();

          const errors = captureConsoleErrors();
          try {
            // Reporting neither throws nor touches the authored file; the
            // console line is the whole report a piece in this state gets.
            bridge.reportSourceRefreshWarning(
              sourceWritePath("home", "notes", tree.lookup(pieceIno, ".src")!),
              "committed, but the refresh failed",
            );
          } finally {
            errors.restore();
          }

          const srcIno = tree.lookup(pieceIno, ".src")!;
          expect(getFileContent(tree, srcIno, "error.log")).toBe(
            "authored, not a diagnostic\n",
          );
          expect(errors.lines.length).toBe(1);
        });
      });
    });

    describe("under `FuseOperationState`", () => {
      // The bridge driven the way the FUSE callbacks drive it, through a
      // `FuseOperationState`.

      it("reserves concurrent exact entity lookups", async () => {
        const ids = ["of:fid1:concurrent-first", "of:fid1:concurrent-second"];
        const tree = new FsTree();
        const bridge = new CellBridge(tree, "/tmp/cf-exec", {
          loadPieces: () =>
            Promise.resolve(
              {
                getSpace: () => "did:key:zConcurrentEntitySpace",
                entityIdExists: (id: string) =>
                  Promise.resolve(ids.includes(id)),
              } as unknown as SpaceState["pieces"],
            ),
          maxEntityProjections: 1,
        });
        bridge.init({ apiUrl: "https://example.invalid", identity: "test" });
        const state = await bridge.connectSpace("home");
        const operations = new FuseOperationState(tree, bridge);

        const [firstIno, secondIno] = await Promise.all(
          ids.map((id) =>
            operations.prepareLookup(state.entitiesIno, encodeFuseComponent(id))
          ),
        );

        expect(firstIno).toBeDefined();
        expect(secondIno).toBeDefined();
        expect(tree.getNode(firstIno!)).toBeDefined();
        expect(tree.getNode(secondIno!)).toBeDefined();

        operations.forget(firstIno!, 1n);
        expect(tree.getNode(firstIno!)).toBeUndefined();
        expect(tree.getNode(secondIno!)).toBeDefined();
        operations.forget(secondIno!, 1n);
      });

      it("transfers only identifiers when a callback traverses mounted `/entities`", async () => {
        const signer = await Identity.fromPassphrase(
          "fuse real spacePieces identifier listing",
        );
        const session = await createSession({
          identity: signer,
          spaceDid: signer.did(),
        });
        const space = session.space;
        const rootId = `of:${space}`;
        const hiddenId = "of:fid1:fuse-real-spacePieces-hidden";
        const rootPayload = "FUSE_ROOT_ENTITY_BYTES_0fb29de4".repeat(20);
        const hiddenPayload = "FUSE_HIDDEN_ENTITY_BYTES_6c6dfbec".repeat(20);
        const fillerPayloadMarker = "FUSE_FILLER_ENTITY_BYTES_7d23cbe1";
        const fillerIds = Array.from(
          { length: 1_000 },
          (_, index) =>
            `of:fid1:fuse-filler-${index.toString().padStart(4, "0")}`,
        );
        const audience = "did:key:z6Mk-fuse-entity-list-test-audience";
        const server = new MemoryV2Server.Server({
          authorizeSessionOpen: () => signer.did(),
          sessionOpenAuth: { audience },
          store: new URL(`memory://fuse-entity-list-${crypto.randomUUID()}`),
        });
        const sessionOpenAuth: MemoryV2Client.SessionOpenAuthFactory = (
          _space,
          _session,
          context,
        ) => ({
          invocation: {
            aud: context.audience,
            challenge: context.challenge.value,
          },
          authorization: {},
        });
        const writerClient = await MemoryV2Client.connect({
          transport: MemoryV2Client.loopback(server),
        });
        let runtime: Runtime | undefined;

        try {
          const writer = await writerClient.mount(space, {}, sessionOpenAuth);
          await writer.transact({
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [
              {
                op: "set",
                id: rootId,
                value: { value: { payload: rootPayload } },
              },
              {
                op: "set",
                id: hiddenId,
                value: { value: { payload: hiddenPayload } },
              },
              ...fillerIds.map((id, index) => ({
                op: "set" as const,
                id,
                value: {
                  value: { payload: `${fillerPayloadMarker}-${index}` },
                },
              })),
            ],
          });

          const serverPayloads: string[] = [];
          class RecordingSessionFactory implements SessionFactory {
            async create(spaceId: string, _signer?: Signer) {
              const inner = MemoryV2Client.loopback(server);
              const transport: MemoryV2Client.Transport = {
                send: (payload) => inner.send(payload),
                close: () => inner.close(),
                setReceiver: (receiver) => {
                  inner.setReceiver((payload) => {
                    serverPayloads.push(payload);
                    receiver(payload);
                  });
                },
                setCloseReceiver: (receiver) => {
                  inner.setCloseReceiver?.(receiver);
                },
              };
              const client = await MemoryV2Client.connect({ transport });
              const mounted = await client.mount(spaceId, {}, sessionOpenAuth);
              return { client, session: mounted };
            }
          }
          class RecordingStorageManager extends V2StorageManager {
            constructor(as: Identity) {
              super(
                { as, memoryHost: new URL("memory://") } as V2StorageOptions,
                new RecordingSessionFactory(),
              );
            }

            override registerSpaceHost(): boolean {
              return false;
            }
          }

          const storageManager = new RecordingStorageManager(signer);
          const expectedIds = [rootId, hiddenId, ...fillerIds].toSorted();
          expect(await storageManager.open(space).listEntityIds?.()).toEqual(
            expectedIds,
          );
          runtime = new Runtime({
            apiUrl: new URL("https://example.invalid"),
            storageManager,
          });
          const spacePieces = new PiecesController(session, runtime, {
            deferSpaceCellSync: true,
          });
          const tree = new FsTree();
          const bridge = new CellBridge(tree, "/tmp/cf-exec", {
            loadPieces: () => Promise.resolve(spacePieces),
          });
          bridge.init({ apiUrl: "https://example.invalid", identity: "test" });

          const state = await bridge.connectSpace("home");
          const fuseOperations = new FuseOperationState(tree, bridge);
          const entitiesFh = fuseOperations.openDirectory(state.entitiesIno);
          expect(entitiesFh).toBeDefined();
          const preparation = fuseOperations.prepareDirectory(
            entitiesFh!,
            state.entitiesIno,
          );
          expect(preparation).toBeDefined();
          const entries = fuseOperations.directorySnapshot(
            entitiesFh!,
            state.entitiesIno,
            await preparation,
          );

          const traversedEntries = [] as typeof entries[number][];
          let offset = 0;
          while (offset < entries.length) {
            const previousOffset = offset;
            let entriesInReply = 0;
            visitDirectoryEntries(entries, offset, (entry, nextOffset) => {
              if (entriesInReply === 2) return false;
              traversedEntries.push(entry);
              entriesInReply++;
              offset = nextOffset;
              return true;
            });
            expect(offset).not.toBe(previousOffset);
          }

          expect(traversedEntries).toEqual(entries);
          const entryNames = new Set(entries.slice(2).map(({ name }) => name));
          expect(entryNames.size).toBe(expectedIds.length);
          expect(entryNames.has(encodeFuseComponent(rootId))).toBe(true);
          expect(entryNames.has(encodeFuseComponent(hiddenId))).toBe(true);
          expect(entries.slice(2).every(({ ino }) => ino === 0n)).toBe(true);
          expect(tree.getChildren(state.entitiesIno)).toEqual([]);
          for (const { name } of entries.slice(2)) {
            const entityIno = await fuseOperations.prepareLookup(
              state.entitiesIno,
              name,
            );
            expect(entityIno).toBeDefined();
            expect(tree.getNode(entityIno!)?.kind).toBe("dir");

            const entityFh = fuseOperations.openDirectory(entityIno!);
            expect(entityFh).toBeDefined();
            const entityPreparation = fuseOperations.prepareDirectory(
              entityFh!,
              entityIno!,
            );
            const entityEntries = fuseOperations.directorySnapshot(
              entityFh!,
              entityIno!,
              entityPreparation === undefined
                ? undefined
                : await entityPreparation,
            );
            expect(entityEntries.map(({ name }) => name)).toEqual([".", ".."]);
            fuseOperations.closeDirectory(entityFh!, entityIno!);
            fuseOperations.forget(entityIno!, 1n);
          }
          fuseOperations.closeDirectory(entitiesFh!, state.entitiesIno);

          expect(
            serverPayloads.some((payload) => payload.includes(rootPayload)),
          ).toBe(false);
          expect(
            serverPayloads.some((payload) => payload.includes(hiddenPayload)),
          ).toBe(false);
          expect(
            serverPayloads.some((payload) =>
              payload.includes(fillerPayloadMarker)
            ),
          ).toBe(false);
          expect(serverPayloads.some((payload) => payload.includes(rootId)))
            .toBe(true);
          expect(serverPayloads.some((payload) => payload.includes(hiddenId)))
            .toBe(true);
          expect(
            serverPayloads.some((payload) => payload.includes(fillerIds[0])),
          ).toBe(true);
          expect(
            serverPayloads.some((payload) =>
              payload.includes(fillerIds.at(-1)!)
            ),
          ).toBe(true);
          expect(state.pieceMap.size).toBe(0);
          expect(state.pieceListSubscribed).toBe(false);
        } finally {
          await runtime?.dispose();
          await writerClient.close();
          await server.close();
        }
      });
    });
  });

  describe("sourceRefreshWarning()", () => {
    it("describes a committed write whose refresh failed", () => {
      // The write committed, so the flush succeeds and the file is saved — but
      // the piece is on the new source and not running it, and error.log is the
      // only place the mount can say so.

      expect(sourceRefreshWarning({
        status: "committed",
        ref: { identity: "A".repeat(43), symbol: "default" },
        revisionId: "revision-2",
        detachedOrigin: null,
        space: "did:key:test",
        seq: 12,
        refresh: { status: "failed", warning: "dependency unavailable" },
      })).toBe(
        `Source revision revision-2 committed as cf:module/${
          "A".repeat(43)
        }#default, but refreshing the running piece failed: dependency unavailable`,
      );
    });

    it("returns `undefined` for a refreshed or absent write", () => {
      expect(sourceRefreshWarning({
        status: "committed",
        ref: { identity: "A".repeat(43), symbol: "default" },
        revisionId: "revision-2",
        detachedOrigin: null,
        space: "did:key:test",
        seq: 12,
        refresh: { status: "completed" },
      })).toBeUndefined();
      // A finalize with no receipt — a metadata write, which updated no source.
      expect(sourceRefreshWarning(undefined)).toBeUndefined();
    });
  });
});

/**
 * Tier 2 of the pattern-update regime: prove a new pattern can still READ the
 * state an older version of itself wrote.
 *
 * Tier 1 (`deno task pattern-compat`) proves the argument/result contract is
 * backward compatible. That is a statement about schemas, and schemas do not
 * describe everything a pattern writes: move where a field is STORED
 * (`.for('items')` → `.for('itemList')`) and the declared contract does not
 * change by a single byte, while every document written under the old name
 * becomes unreachable. No contract comparison can see that, and nothing
 * throws — only replaying a real prior state catches it.
 *
 * It also replays additive required OUTPUT evolution. That class is compatible:
 * the candidate pattern generates the new result during setup, so Tier 1
 * accepts the result contract and the runner's role-aware CFC merge accepts the
 * generated write over the legacy root. The replay pins that behavior through
 * capture → snapshot → reopen → materialize rather than only at either isolated
 * schema boundary.
 *
 * The state is captured as a **SQLite space store**, not a bespoke JSON dump.
 * A space is one SQLite file, `snapshotSpaceStore` already writes a
 * crash-consistent copy of one, and restoring is a file copy — where a JSON
 * dump would need a re-writer that reconstructs docs, causes and links, and
 * getting causes wrong silently produces a fixture that is not the state that
 * was captured.
 *
 * Capture is deliberately file-backed: `StorageManager.emulate` runs a real
 * memory server against `:memory:`, which has no file to snapshot.
 */

import { fromFileUrl } from "@std/path/from-file-url";

// The comparison's two leaf cases. A materialized root is not plain data: at an
// `asCell`/`asStream` position it holds a live cell, and a durable doc may hold
// a `FabricSpecialObject` (bytes, an epoch). Neither survives a structural
// comparison unaided — see `comparableState`.
import type { JSONSchemaObj } from "@commonfabric/api";
import {
  isFabricSpecialObject,
  taggedHashStringOf,
} from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type { Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import {
  listSpaceStores,
  snapshotSpaceStore,
  spaceStorePath,
} from "@commonfabric/memory/v2/dump";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { resolveSpaceStoreUrl } from "@commonfabric/memory/v2/storage-path";
import {
  type Cell,
  CHIP_UI,
  decomposeSchema,
  getPatternIdentityRef,
  getPatternSetupIdentityRef,
  isCell,
  isStream,
  parseExternalSchemaRef,
  readResultSchemaMeta,
  Runtime,
  TILE_UI,
  UI,
} from "@commonfabric/runner";
import type { RuntimeProgram } from "@commonfabric/runner";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { Database } from "@db/sqlite";

import type { NormalizedFullLink } from "../../runner/src/link-types.ts";
// Relative into the runner's internals for the same reason as the test
// utilities below: `getMetaLink` and the link shape it returns are how the
// runtime itself reaches a root's argument document, and re-deriving that
// here would be a second spelling to drift.
import { getMetaLink } from "../../runner/src/link-utils.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../../runner/src/storage/v2.ts";
// Relative into the runner's test utilities: they are not part of the runner's
// public exports, and the loopback-server auth handshake has exactly one
// correct spelling — duplicating it here would be a second copy to drift.
import {
  TEST_MEMORY_SERVER_AUTH,
  testPrincipalSessionOpenAuthFactory,
} from "../../runner/test/memory-v2-test-utils.ts";
import {
  companionFileName,
  companionSpace,
  vintageCompanionDir,
} from "./vintage-layout.ts";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

class LoopbackSessions implements SessionFactory {
  readonly #server: () => MemoryV2Server.Server;

  constructor(server: () => MemoryV2Server.Server) {
    this.#server = server;
  }

  async create(spaceId: string, signer?: Signer) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.#server()),
    });
    const session = await client.mount(
      spaceId,
      {},
      testPrincipalSessionOpenAuthFactory(signer),
    );
    return { client, session };
  }
}

class FileBackedStorageManager extends StorageManager {
  static make(as: Identity, server: MemoryV2Server.Server) {
    return new FileBackedStorageManager(
      { as, memoryHost: new URL("memory://") } as Options,
      server,
    );
  }
  private constructor(options: Options, server: MemoryV2Server.Server) {
    super(options, new LoopbackSessions(() => server));
  }
  override registerSpaceHostDetailed() {
    return { accepted: false, reason: "no-remote-resolution" } as const;
  }
}

function serverOver(storeDir: string): MemoryV2Server.Server {
  return new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
    store: new URL(`file://${storeDir}/`),
  });
}

export interface VintageRuntime {
  runtime: Runtime;

  /**
   * The store behind `runtime`, exposed so another harness can write into the
   * same file. The vintage capture hands this to the pattern-test runner so a
   * pattern's OWN tests populate the fixture — real state through real
   * handlers, rather than a bare materialized root with nothing in it.
   */
  storageManager: StorageManager;

  /** The PRIMARY space: the signer's own, and the one a fixture is named for. */
  space: string;

  /**
   * Every space this runtime was restored WITH, primary and companions alike,
   * sorted. Empty for a fresh store.
   *
   * Read at open, before anything can write, so it answers "what did this
   * fixture CARRY" rather than "what has been touched since" — the engine opens
   * a store with `{ create: true }`, so by the time a replay has read anything
   * the answer would already have changed.
   *
   * It is a DIAGNOSIS, not a control: "carries the space" does not imply "holds
   * the root", since a store that opened but never committed restores as a
   * valid empty database. `vintageHoldsRoot` is the control; this is what lets
   * a failure say "the fixture does not carry did:key:…" instead of leaving the
   * reader to work out why a root was not there.
   */
  restoredSpaces: readonly string[];

  storeDir: string;

  /**
   * Snapshot EVERY space this runtime wrote — the primary to `destPath`, the
   * rest into its companion directory. Crash-consistent, runs no migrations.
   *
   * Not atomic: it writes the primary first, then one companion at a time, so a
   * caller that publishes into a shared tree has to clean up after a partial
   * write itself (`captureVintage` does).
   */
  snapshot(destPath: string): Promise<void>;

  dispose(): Promise<void>;
}

/**
 * Shrink a just-written fixture, in place, without changing what it holds for
 * a replay.
 *
 * Two measured wins, on the four committed fixtures (42.2 MiB together):
 *
 * - **`commit.original.operations` is a byte-for-byte duplicate of the whole
 *   `revision` table.** Verified by joining `json_each(original,'$.operations')`
 *   to `revision` on `commit_seq`+`op_index`: equal counts, ids, ops and
 *   payloads in all four. The `commit` table is 42-50% of each file and
 *   outweighs `revision` itself in three of them.
 * - **`page_size` is 32 KiB**, which costs 1.2-1.4 MiB of near-empty pages per
 *   file — 38% of the smallest one. Plain `VACUUM` reclaims nothing
 *   (`freelist_count` is already 0); the waste is inside pages, not between
 *   them.
 *
 * Together: 42.2 MiB → 21.8 MiB checked out. The fixtures stay RAW rather than
 * compressed, which is a separate measurement: git's own zlib beats
 * pre-gzipping (3.11 vs 3.25 MiB packed at one generation) and deltas a
 * recapture ~5x better (+0.21 vs +1.03 MiB on a second topics generation),
 * because it cannot delta a gzip stream.
 *
 * **Only `operations` goes, and the rest of the envelope stays.** Blanking the
 * whole column is smaller still (16.7 MiB) and was measured to leave the gate
 * byte-identical — but `commit.original` has THREE readers, not the one the
 * engine has, and the other two are the shipping `cf inspect`:
 *
 * - `state-inspector/conflicts.ts` prefilters candidate reader commits with
 *   `WHERE original LIKE '%'||id||'%'` and then reads `$.reads.confirmed`.
 *   With the column blanked, that prefilter matched 0 of topics' 353 commits,
 *   so the stale-read detector returned "no anomalies" for every fixture —
 *   a CONFIDENT CLEAN BILL it cannot otherwise produce, and the one output
 *   whose whole purpose is flagging corruption. Keeping `reads` restores it:
 *   309 of 353 match again.
 * - `state-inspector/queries.ts` `listCommits` decodes `original` for its
 *   `ops`/`reads` counts. Its `ops` column reads 0 on these fixtures, which is
 *   the one degradation this transform knowingly keeps: the operations are
 *   still all there in `revision`, which is where `cf inspect history`,
 *   `timeline` and `diff` read them from.
 *
 * The engine's own use is unaffected either way: `sameStoredOriginal`
 * (`memory/v2/engine.ts`) is a string equality reached only through
 * `SELECT_EXISTING_COMMIT`, keyed `session_id`+`local_seq`, and a fresh replay
 * session cannot match a stored session id. Commit ROWS always stay, so
 * `MAX(seq)` allocation and the `revision.commit_seq` foreign key are intact.
 *
 * Proven equivalent rather than assumed: the gate was run against a pruned
 * copy and an untouched one with every pattern's identity forced to change, so
 * 50 targets actually materialized, and the two produced byte-identical output
 * including all 18 failure diagnostics.
 *
 * The right long-term fix is in the engine — storing a hash of the operations
 * rather than the operations — at which point this becomes a no-op and should
 * be deleted.
 */
function compactVintageStore(path: string): void {
  const db = new Database(path);
  try {
    // Guarded on the codec prefix rather than assuming it: `json_remove` over a
    // string that is not JSON returns NULL, and the column is NOT NULL, so an
    // unprefixed row would fail the statement rather than corrupt quietly — but
    // the guard says which rows are meant to change instead of relying on that.
    db.exec(
      `UPDATE "commit" SET original = 'fvj1:' || ` +
        `json_remove(substr(original, 6), '$.operations') ` +
        `WHERE substr(original, 1, 5) = 'fvj1:'`,
    );
  } finally {
    db.close();
  }
  // Repage through a fresh copy: `page_size` only takes effect on a database
  // being written from scratch, which is what `VACUUM INTO` produces.
  const repaged = `${path}.repaged`;
  const source = new Database(path, { readonly: true });
  try {
    source.exec("PRAGMA page_size = 4096");
    const stmt = source.prepare("VACUUM main INTO ?");
    try {
      stmt.run(repaged);
    } finally {
      stmt.finalize();
    }
  } finally {
    source.close();
  }
  Deno.renameSync(repaged, path);
}

/** Every companion store beside `fixturePath`, as `[space, path]`. */
async function companionStores(
  fixturePath: string,
): Promise<[string, string][]> {
  const dir = vintageCompanionDir(fixturePath);
  const found: [string, string][] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile) continue;
      // A name this repo could not have written is not a companion — skipping
      // it cannot lose a real space, and every root whose space did not restore
      // is reported by the replay anyway.
      const space = companionSpace(entry.name);
      if (space === undefined) continue;
      found.push([space, `${dir}/${entry.name}`]);
    }
  } catch (error) {
    // No companion directory means a single-space fixture, which is the common
    // case and not a problem. Anything else must surface.
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  // Sorted so a restore is reproducible rather than directory-order dependent.
  // By code point, not `localeCompare`, which is locale-dependent and so is not
  // the same order on two machines — the property being bought here.
  found.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return found;
}

/**
 * A runtime whose space lives in a real file, so it can be snapshotted.
 *
 * `storeDir` is the caller's to clean up. Pass an existing `fromSnapshot` to
 * start from a captured vintage instead of an empty space.
 */
export async function openFileBackedRuntime(
  signer: Identity,
  storeDir: string,
  fromSnapshot?: string,
): Promise<VintageRuntime> {
  const space = signer.did();
  const storeUrl = new URL(`file://${storeDir}/`);

  if (fromSnapshot !== undefined) {
    // Place the snapshot where the engine resolves this space's store. The
    // path encodes the DID, and restoring under the SAME DID is deliberate:
    // re-keying is an unbounded migration that would destroy the fidelity the
    // fixture exists to buy (CFC labels name the space, among other things).
    await seedSpaceStore(storeDir, space, fromSnapshot);
    // Companions restore under the DID they were captured in, for the same
    // reason and more strictly: a cross-space child's recorded root names that
    // DID, so re-keying would leave the root unaddressable rather than merely
    // relabelled.
    for (const [companion, path] of await companionStores(fromSnapshot)) {
      await seedSpaceStore(storeDir, companion, path);
    }
  }

  const server = serverOver(storeDir);
  const storageManager = FileBackedStorageManager.make(signer, server);
  const runtime = new Runtime({
    apiUrl: new URL("http://toolshed.test"),
    storageManager,
  });

  return {
    runtime,
    storageManager,
    space,
    // Enumerated from disk rather than assumed from `fromSnapshot`, so this is
    // what actually landed where the engine looks — the thing the replay needs
    // to know.
    restoredSpaces: fromSnapshot === undefined
      ? []
      : listSpaceStores(storeUrl).map((info) => info.space).sort(),
    storeDir,
    async snapshot(destPath: string) {
      // Everything must be durable before the copy, or the fixture records a
      // state the capture never actually reached. `idle()` waits for scheduler
      // quiescence and no further; a COLD compile's write-back is awaited by
      // `compilePattern` itself, but the recovery and cross-space replication
      // paths are tracked separately and drained only by this flush. A fixture
      // is read by a FRESH runtime, which is precisely the case it exists for —
      // cheap insurance rather than a fix for a measured loss, since the
      // replication a companion store would carry does not currently succeed
      // under the pattern-test runner at all.
      await runtime.idle();
      await runtime.patternManager.flushCompileCacheWrites();
      await runtime.storageManager.synced();
      const path = spaceStorePath(storeUrl, space);
      if (path === null) {
        throw new Error(
          `no space store for ${space} under ${storeDir} — nothing was written`,
        );
      }
      snapshotSpaceStore(path, destPath);
      compactVintageStore(destPath);
      // Every OTHER space the run wrote travels too, enumerated from the store
      // itself rather than from what an observer recorded: the two can disagree,
      // and the copy has to be a statement about what is on disk.
      //
      // "Has a store file" is NOT "holds state" — the engine opens with
      // `{ create: true }`, so merely reaching a space leaves an empty database
      // behind, and copying one carries nothing. That is why the replay's
      // per-root control is `vintageHoldsRoot` and not a question about spaces.
      const companionDir = vintageCompanionDir(destPath);
      const companions = listSpaceStores(storeUrl).filter((info) =>
        info.space !== space
      );
      if (companions.length > 0) {
        await Deno.mkdir(companionDir, { recursive: true });
      }
      for (const info of companions) {
        // `listSpaceStores` just stat'd this file, so re-resolving it cannot
        // legitimately come back null; `!` rather than a branch nothing can
        // reach. `snapshotSpaceStore` throws on a path that is not there.
        const companionPath = `${companionDir}/${
          companionFileName(info.space)
        }`;
        snapshotSpaceStore(
          spaceStorePath(storeUrl, info.space)!,
          companionPath,
        );
        compactVintageStore(companionPath);
      }
    },
    async dispose() {
      await runtime.dispose();
      await storageManager.close();
      // The server owns what the file actually is: a SQLite engine per space,
      // a read pool, and a scheduled refresh timer. `storageManager.close()`
      // only tears down the client side, so without this every case leaks its
      // engines and its timer past the case that opened them — and the temp
      // dir is removed out from under still-open handles.
      await server.close();
    },
  };
}

/**
 * Copy a snapshot into the place the engine looks for `space`'s store.
 *
 * The layout is resolved with `resolveSpaceStoreUrl`, the same helper the
 * server resolves through — directory mode nests one level deeper than
 * single-file mode, and rebuilding that rule here would rot silently. Note it
 * COMPUTES a path rather than stat-ing one, which is what this needs: the
 * destination does not exist yet.
 */
async function seedSpaceStore(
  storeDir: string,
  space: string,
  snapshotPath: string,
): Promise<void> {
  const target = fromFileUrl(
    resolveSpaceStoreUrl(new URL(`file://${storeDir}/`), space as never),
  );
  await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
    recursive: true,
  });
  await Deno.copyFile(snapshotPath, target);
}

/**
 * The cause of a captured space's root cell — shared by the harness helper
 * below and by the capture, which pins the test pattern's result cell to it.
 *
 * The cause is fixed rather than minted, because `PiecesController.setupPersistent`
 * otherwise defaults to `{ space, random: crypto.randomUUID() }` and the root's
 * entity id would differ on every capture — the fixture could then never be
 * re-read by id. (Root creation through `ensureDefaultPattern` bakes
 * `Date.now()` into its cause for the same reason, so a root fixture has to go
 * around that path.)
 *
 * A fixture pins exactly one root under this cause. `getCell` derives the
 * entity id as `createRef({}, cause)` (`runtime.ts`), and that derivation does
 * not include the space, so two roots caused this way in one space store are
 * one cell. The other patterns a fixture holds are reached by the cell ids its
 * manifest records, through `materializeOnCell`.
 */
export function vintageRootCause(): { stateContinuity: string } {
  return { stateContinuity: "vintage-root" };
}

/** A stable root cell for a captured space, addressable across captures. */
export function vintageRoot<T>(
  vintage: VintageRuntime,
  schema: unknown,
): Cell<T> {
  return vintage.runtime.getCell<T>(
    vintage.space as never,
    vintageRootCause(),
    schema as never,
  );
}

/**
 * Cause of the doc a fixture stores its instantiation manifest under.
 *
 * The manifest lives INSIDE the store rather than in a sidecar file. A sidecar
 * would be a second artifact that can drift from the state it describes and
 * would need its own append-only discipline; an in-store doc travels in the
 * same file, is copied atomically with the state, and keeps "restore is a
 * single `Deno.copyFile`" true. The cost is one doc no pattern wrote —
 * acceptable for a fixture, and namespaced here so it cannot collide.
 */
export const VINTAGE_MANIFEST_CAUSE = {
  stateContinuity: "vintage-manifest",
} as const;

/** What a capture recorded about one pattern materialization. */
export interface VintageManifestEntry {
  identity: string;
  symbol: string;

  /** Entry filename, repo-root-relative (`/packages/patterns/system/home.tsx`). */
  main?: string;

  /** Entity id of the result cell the pattern was materialized onto. */
  cellId: string;

  space: string;
}

export interface VintageManifest {
  entries: VintageManifestEntry[];
}

/**
 * Schema for the manifest doc.
 *
 * Explicit rather than `undefined`: a schema-less read comes back as a
 * query-result proxy whose array elements resolve lazily, and iterating it gave
 * `undefined` entries — the manifest has to materialize as plain data before
 * anything reads it.
 */
const VINTAGE_MANIFEST_SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          identity: { type: "string" },
          symbol: { type: "string" },
          main: { type: "string" },
          cellId: { type: "string" },
          space: { type: "string" },
        },
        required: ["identity", "symbol", "cellId", "space"],
      },
    },
  },
  required: ["entries"],
} as const;

/** Write the manifest into the store, so it travels with the state. */
export async function writeVintageManifest(
  vintage: VintageRuntime,
  entries: readonly VintageManifestEntry[],
): Promise<void> {
  const cell = vintage.runtime.getCell<VintageManifest>(
    vintage.space as never,
    VINTAGE_MANIFEST_CAUSE,
    VINTAGE_MANIFEST_SCHEMA as never,
  );
  const { error } = await vintage.runtime.editWithRetry((tx) => {
    cell.withTx(tx).set({ entries: entries.map((e) => ({ ...e })) } as never);
  });
  if (error !== undefined) {
    throw new Error(`could not write vintage manifest: ${error.message}`);
  }
  await vintage.runtime.idle();
  // The snapshot copies the FILE, so the write has to be durable before it —
  // an in-flight manifest would produce a fixture whose state is real and whose
  // update targets are missing.
  await vintage.runtime.storageManager.synced();
}

/** Read a restored fixture's manifest. `undefined` = none recorded. */
export async function readVintageManifest(
  vintage: VintageRuntime,
): Promise<VintageManifest | undefined> {
  const cell = vintage.runtime.getCell<VintageManifest>(
    vintage.space as never,
    VINTAGE_MANIFEST_CAUSE,
    VINTAGE_MANIFEST_SCHEMA as never,
  );
  await cell.sync();
  try {
    const value = cell.get() as VintageManifest | undefined;
    if (value === undefined || !Array.isArray(value.entries)) return undefined;
    // Detach from the query-result proxy: its array elements resolve lazily,
    // and a caller that iterates the live view sees `undefined` entries.
    const entries = value.entries
      .map((entry) => (entry === undefined ? undefined : { ...entry }))
      .filter((entry): entry is VintageManifestEntry => entry !== undefined);
    return { entries };
  } catch {
    // An absent doc reads as a throw rather than undefined; for this question
    // the two are the same answer.
    return undefined;
  }
}

/**
 * The link to a root's durable ARGUMENT document.
 *
 * State a pattern RETURNS lives in the cells it owns (`.for('items')`); state
 * it RECEIVES lives in a separate document the root points at through its
 * `argument` meta link. The two travel different code paths on an update — the
 * result doc goes through the CFC schema merge, the argument through the
 * runner's setup validation — so a tier that only ever populates results
 * measures half the surface.
 *
 * Returned as a link rather than a `Cell` because callers need to build the
 * cell against their own transaction, and because the schema to read it under
 * is the question (a value stored under the OLD argument schema is exactly
 * what a NEW one may no longer accept).
 */
export async function vintageArgumentLink(
  vintage: VintageRuntime,
  resultSchema: unknown,
): Promise<NormalizedFullLink> {
  const root = vintageRoot<Record<string, unknown>>(vintage, resultSchema);
  await root.sync();
  const link = getMetaLink(root as never, "argument");
  if (link === undefined) {
    throw new Error(
      "vintage root has no argument meta link — it was never set up, so " +
        "there is no durable argument to capture or replay",
    );
  }
  return link;
}

/** What a cycle in a materialized root becomes. Structural, so two of them
 * compare equal, and JSON-safe, so a report can print it. */
const CYCLE = Object.freeze({ "[cycle]": true });

/** What a RENDERING becomes. Carries nothing, so two of them always compare
 * equal — which is the point: a rendering is not state. */
const VNODE = Object.freeze({ "[vnode]": true });

/**
 * Whether a value is a RENDERING rather than state.
 *
 * `type: "vnode"` is the whole test, and it is the runner's own definition of
 * one — `vnodeSchema` in `runner/src/schemas.ts` requires that tag. An object
 * carrying a `$UI` is deliberately not counted: that shape is a piece with a
 * rendering ON it, whose other keys are exactly the state this comparison
 * exists to check.
 */
function isVNode(value: object): boolean {
  return (value as { type?: unknown }).type === "vnode";
}

/**
 * A materialized root, detached and reduced to something two of can be
 * COMPARED.
 *
 * A materialized root is not plain data, and three of the things in it defeat a
 * structural comparison outright:
 *
 * - **A live cell.** At every `asCell`/`asStream` position — the six handler
 *   streams on `home.tsx`'s root, among others — the read yields a `Cell`,
 *   whose own enumerable properties include `runtime`. A generic deep copy
 *   therefore copies the whole runtime object graph into the snapshot, cycles
 *   and all. Measured on the committed `home.tsx` fixture: the copy is cyclic
 *   (`scheduler` → `runtime` → back), `JSON.stringify` on it throws, and the
 *   copy compares UNEQUAL to the live cell it came from because one side is a
 *   plain object and the other a class instance — so every stream key reports
 *   as stranded and printing the finding takes the run down with it. Reduced
 *   here to the DOCUMENT the cell points at, which is the durable thing about
 *   it: a stream that moved to a different doc still shows up, and the schema
 *   is deliberately dropped, being a view rather than data.
 * - **A `FabricSpecialObject`** (`FabricBytes`, an epoch). These hold their
 *   state in private fields, so a structural comparison sees two objects with
 *   no properties and calls them equal REGARDLESS of contents —
 *   `deepEqual`'s own documentation says so, and it is the quietest way a
 *   comparison can pass. Reduced to a tagged content hash, which is the
 *   data-model's own notion of equality for them (`valueEqual` ends in the same
 *   hash) without needing a comparator that also has to survive link sigils.
 * - **A cycle.** Even with cells reduced, the data itself may point back at
 *   itself; `deepEqual` recurses until the stack ends. Cut with a marker rather
 *   than by sharing the copy, so what comes out of here is acyclic — which is
 *   what lets a failure report stringify it.
 * - **A rendering.** A VNode is recomputed by the setup from the pattern body,
 *   so the stored one and a fresh one differ whenever the source that renders
 *   them was touched at all. `strandedKeys` excludes the `$UI` FAMILY by name,
 *   which reaches a rendering stored AT a known key and nothing else — and a
 *   transformer hoist (`__cfPattern_N`, the body of a `map`) is a recorded
 *   instantiation whose whole result IS a vnode, with keys `type`/`name`/
 *   `props`/`children`. Measured on the committed `default-app.tsx` fixture: a
 *   UI-only edit inside that map body reported `children` stranded on both
 *   recorded hoist roots and took the gate to exit 1, for a change that stores
 *   nothing. Reduced by SHAPE here, so a rendering is out of the comparison
 *   wherever it sits rather than only where it is named.
 *
 * Everything else is copied plainly, and `bigint` and `undefined` pass through
 * as themselves — the two values a JSON round-trip could not carry.
 *
 * Idempotent: run over its own output it returns an equal structure, so a
 * caller that normalizes early and a caller that normalizes late agree.
 */
export function comparableState(value: unknown): unknown {
  // Cycle detection is per-PATH, not per-value: a shared subtree is expanded at
  // each place it appears, which keeps the copy an honest picture of what was
  // read. Only a genuine loop is cut.
  const onPath = new Set<object>();
  const walk = (current: unknown): unknown => {
    if (!isObjectOrArray(current)) return current;
    if (isFabricSpecialObject(current)) {
      return { "[fabric]": taggedHashStringOf(current) };
    }
    if (isCell(current) || isStream(current)) {
      const link = current.getAsNormalizedFullLink();
      return {
        "[cell]": {
          space: link.space,
          id: link.id,
          path: [...link.path],
        },
      };
    }
    if (isVNode(current)) return VNODE;
    if (onPath.has(current)) return CYCLE;
    onPath.add(current);
    try {
      if (Array.isArray(current)) return current.map(walk);
      const copy: Record<string, unknown> = {};
      for (const key of Object.keys(current)) {
        copy[key] = walk((current as Record<string, unknown>)[key]);
      }
      return copy;
    } finally {
      onPath.delete(current);
    }
  };
  return walk(value);
}

/**
 * `schema` relaxed for READING rather than for validating: every `unknown` TYPE
 * dropped so a read descends where the declared type stopped it, and every
 * `required` dropped so one property that does not resolve cannot hide the
 * rest of the object.
 *
 * A schema-driven read carries nothing at a `{"type": "unknown"}` position —
 * `schemaTypeValidity` in `traverse.ts` returns `Unknown` there, so the read
 * stops at a reference WHATEVER the document holds. That is the right answer
 * for a reader; it is the wrong one for this comparison, because "the schema
 * declined to look" then reads exactly like "the document does not hold it",
 * and `isPreserved` treats the second as nothing to lose.
 *
 * It is not a corner. Measured on the committed fixtures, `unknown` is what a
 * declared `unknown` field and an INDEX SIGNATURE both lower to — the second
 * as `additionalProperties: {"type": "unknown"}` — and `default-app.tsx`
 * declares `[key: string]: unknown` on its output. Its root holds
 * `summaryIndex`, a whole nested pattern result. Under the stored schema
 * verbatim it reads back carrying none of its contents, and a change that
 * stranded it would have replayed clean.
 *
 * `required` goes for a different reason, measured on the committed topics
 * fixture. A schema-driven read returns `undefined` for the WHOLE object when a
 * required property does not resolve — and a pattern's own result schema marks
 * its session-local drafts required: `topic.tsx` requires `bodyDraft`,
 * `commentDraft`, `editingBody`, `linkUrlDraft` and `linkLabelDraft`, each a
 * link to a per-session cell that holds nothing in a fresh replay runtime. All
 * 28 keys of real state then read as nothing, and the entry was reported as a
 * recorded root the fixture does not hold. EVERY recorded `topic.tsx` target
 * failed that way, so the gate examined no topics state at all while reporting
 * loudly. `main.tsx` fell to the same collapse through `$NAME` and `newTitle`.
 *
 * Dropping it cannot hide a loss, which is what makes this safe rather than
 * merely convenient: the comparison is per key, so a key that resolved before
 * and does not after is still a finding. `required` only ever decided whether
 * the object collapsed ENTIRELY — and a collapse reports one unreadable root
 * instead of the moved key it was hiding. It is dropped at every depth for the
 * same reason it is dropped at the top: a nested object collapses identically,
 * and the key holding it would read as stranded.
 *
 * Beyond those two, keywords survive — that is what keeps this a RELAXATION
 * rather than a different read: `asCell`, `ifc` and the rest still apply, so a
 * stream still reduces to the document it points at (reading under a bare `{}`
 * instead would resolve it to its value and lose the moved-document class this
 * comparison exists for). The result is still a schema-driven read, so it is
 * still deterministic — unlike a schema-less `.get()`, which resolves whatever
 * is already loaded and is the shape of bug that made a cross-space profile
 * read as absent (#3830).
 */
export function schemaRelaxedForComparison(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(schemaRelaxedForComparison);
  if (!isObjectOrArray(schema)) return schema;
  const relaxed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    // `type: "unknown"` and `type: [… "unknown" …]` both match anything, so
    // dropping the keyword loses no constraint. Matched on the KEY as well as
    // the value, so a property that happens to be NAMED `type` — whose value is
    // a schema object, never the string — is recursed into rather than dropped.
    if (
      key === "type" &&
      (value === "unknown" ||
        (Array.isArray(value) && value.includes("unknown")))
    ) {
      continue;
    }
    // Matched on the KEY and on the VALUE's shape, for the reason above: a
    // property legitimately NAMED `required` holds a schema object, never the
    // array of names this drops.
    if (key === "required" && Array.isArray(value)) continue;
    relaxed[key] = schemaRelaxedForComparison(value);
  }
  return relaxed;
}

/**
 * A root's state under `schema`, detached and reduced so two of them can be
 * compared.
 *
 * One spelling, used for the BEFORE state (under the root's stored schema) and
 * for the AFTER state (under the candidate's compiled one). The two sides have
 * to be read the same way or the comparison measures the reading rather than
 * the data — a relaxation applied to one side alone would report every key it
 * newly resolves as stranded.
 *
 * Returns a copy: the live value is a query-result proxy that re-reads through
 * the transaction, so holding it across a materialize would compare the new
 * state against itself. `comparableState`, not a JSON round-trip and not a
 * generic deep copy — a JSON round-trip is lossy on exactly the values a
 * durable doc may hold (`FabricBytes` and epoch wrappers collapse to `{}`, a
 * `bigint` throws), and a generic copy drags the runtime object graph in behind
 * every live cell.
 */
export async function readStateUnder(
  vintage: VintageRuntime,
  space: string,
  cellId: string,
  schema: unknown,
): Promise<Record<string, unknown> | undefined> {
  try {
    const cell = vintage.runtime.getCellFromEntityId(
      space as never,
      cellId as never,
      [],
      schemaRelaxedForComparison(schema) as never,
    );
    // Pulled, not merely synced: a link the schema reads through into
    // another space loads on a round trip of its own after the root arrives,
    // and the read has to converge on that target too, or both sides of a
    // comparison read the same absence.
    await cell.pull();
    const detached = comparableState(cell.get());
    // Narrow rather than cast. A root is an object in practice, but asserting
    // it would hand `strandedKeys` a non-object to enumerate — and "no keys"
    // reads exactly like "nothing stranded".
    if (!isObjectOrArray(detached)) return undefined;
    return detached as Record<string, unknown>;
  } catch {
    // A cell that cannot be read is `undefined`, not a throw. The caller treats
    // that as a FAILURE for this entry (a recorded root the fixture does not
    // hold), which is the right verdict — but only if it can be reported. Left
    // throwing, one unreadable cell would abort the whole vintage and take
    // every remaining target and fixture with it.
    return undefined;
  }
}

/**
 * The result schema a root carries in meta, or `undefined` if it carries none.
 *
 * Split out so a caller reporting a failed read can say WHICH half failed —
 * a root with no stored schema and a root whose stored schema reads back
 * nothing are different findings with different fixes, and one message for
 * both sent a reader hunting a missing schema that was present all along.
 */
export async function readStoredResultSchema(
  vintage: VintageRuntime,
  space: string,
  cellId: string,
): Promise<unknown> {
  try {
    const raw = vintage.runtime.getCellFromEntityId(
      space as never,
      cellId as never,
      [],
      undefined as never,
    );
    await raw.sync();
    // The inline form: a reference-form member is recomposed, so the
    // relaxation below sees the schema's `unknown` positions rather than a
    // bare `$ref` with none.
    return readResultSchemaMeta(raw as Cell<unknown>);
  } catch {
    return undefined;
  }
}

/**
 * A captured root's state, read the way the version that WROTE it saw it.
 *
 * Read under the root's OWN stored result schema, which it carries in meta — so
 * the writing version's view of its data is recoverable without its source, and
 * without this replay having to decide what that view should be. Relaxed at its
 * `unknown` positions first — see `schemaRelaxedForComparison` for what that
 * buys and why it is still the writer's own schema.
 */
export async function readVintageState(
  vintage: VintageRuntime,
  space: string,
  cellId: string,
): Promise<Record<string, unknown> | undefined> {
  const storedSchema = await readStoredResultSchema(vintage, space, cellId);
  // No stored schema is not "read it some other way": the caller reports it,
  // because a recorded root with none is a fixture that does not hold what it
  // claims.
  if (storedSchema === undefined) return undefined;
  return await readStateUnder(vintage, space, cellId, storedSchema);
}

/**
 * The result keys that hold a RENDERING rather than state.
 *
 * Taken from the runner's own constants rather than spelled as strings here:
 * the set of UI variants is the runtime's to define, and a copy would silently
 * stop matching the day a variant is added.
 */
const RENDERINGS: ReadonlySet<string> = new Set([UI, TILE_UI, CHIP_UI]);

/**
 * The single-key objects `comparableState` reduces a value TO.
 *
 * Every one of them stands for something the comparison cannot see through, so
 * every one of them has to be compared WHOLE — see `isPreserved`, which would
 * otherwise apply its subset rule to the reduction's own innards.
 */
const REDUCTIONS: ReadonlySet<string> = new Set([
  "[cell]",
  "[fabric]",
  "[cycle]",
  "[vnode]",
]);

/** Whether `value` is one of `comparableState`'s reductions. */
export function isReduction(value: unknown): boolean {
  if (!isObjectNotArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length === 1 && REDUCTIONS.has(keys[0]);
}

/**
 * Whether everything `before` held is still reachable, at the same path, in
 * `after`.
 *
 * SUBSET, not equality — and the difference is not a nicety. An update may
 * legitimately ADD, which is what `Default<>` is for, and additions are not
 * only top-level: a nested pattern gaining a defaulted field turns
 * `{note, owner}` into `{note, owner, addedLater: []}` several levels down.
 * Comparing those for equality reports the whole key stranded and reds a
 * perfectly compatible change — measured, on the cross-space case in
 * `pattern-vintage-run.test.ts`.
 *
 * Arrays compare elementwise by INDEX, so appending is fine while truncating or
 * reordering is not: an element that moved is an element the old reader can no
 * longer find where it left it.
 *
 * Two things the subset rule does NOT apply to, both of them ways it would
 * otherwise pass on a value that changed:
 *
 * - **A reduction is an identity, not a structure.** `{"[cell]": {space, id,
 *   path}}` says WHICH document a cell-valued key points at; descending into it
 *   makes its `path` a subset-able array, so a stream that moved from `[]` to
 *   `["value"]` in the same document — a longer path, nothing missing from it —
 *   reads as preserved. Compared whole instead.
 * - **A before-value of `undefined` is not data.** The before state is read
 *   under the root's stored schema, and a schema-driven read enumerates the
 *   keys the schema declares whether or not the document holds them: measured
 *   on the committed fixtures, `defaultProfile` on `home.tsx` reads as
 *   `undefined` because the root predates any profile being created.
 *   Comparing that would report an update that starts filling it in — adding a
 *   `Default<>` to a field already declared — as having stranded state that
 *   was never there. Held nothing, lost nothing.
 *
 *   This branch is only honest because the read cannot ALSO return `undefined`
 *   for a key the document does hold. It could, before
 *   `schemaRelaxedForComparison`: an `unknown` position resolves to `undefined`
 *   whatever is stored there, and measured on the committed `default-app.tsx`
 *   fixture that hid `summaryIndex`, which held real state and was
 *   indistinguishable here from a key holding nothing. Whatever else changes,
 *   the two must not be allowed to collapse again.
 */

/**
 * Whether one side is a schema written as a content-addressed reference and
 * the other the same schema written out. Representation is not state: a
 * vintage that held a schema inline is preserved by an update that wrote
 * `{"$ref": "cid:…"}` naming the same content. Recomposing the reference and
 * comparing structurally does not settle this — recomposition derives `$defs`
 * names from content hashes where the inline side carries the author's — so
 * the INLINE side is decomposed instead, and the two canonical root
 * references either match or they do not. `undefined` means neither side is
 * a bare reference and the ordinary walk decides; a bare reference paired
 * with anything that does not decompose to it is a change.
 */
function externalSchemaRefEquivalent(
  before: unknown,
  after: unknown,
): boolean | undefined {
  const bareRefOf = (value: unknown): string | undefined => {
    if (!isObjectNotArray(value)) {
      return undefined;
    }
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== "$ref") return undefined;
    const ref = (value as { $ref?: unknown }).$ref;
    return typeof ref === "string" && parseExternalSchemaRef(ref) !== undefined
      ? ref
      : undefined;
  };
  const canonicalRefOf = (value: unknown): string | undefined => {
    const own = bareRefOf(value);
    if (own !== undefined) return own;
    if (!isObjectNotArray(value)) {
      return undefined;
    }
    try {
      return decomposeSchema(value as JSONSchemaObj).rootRef;
    } catch {
      return undefined;
    }
  };
  if (bareRefOf(before) === undefined && bareRefOf(after) === undefined) {
    return undefined;
  }
  const beforeRef = canonicalRefOf(before);
  const afterRef = canonicalRefOf(after);
  if (beforeRef === undefined || afterRef === undefined) return false;
  return beforeRef === afterRef;
}

function isPreserved(before: unknown, after: unknown): boolean {
  if (before === undefined) return true;
  const schemaEquivalent = externalSchemaRefEquivalent(before, after);
  if (schemaEquivalent !== undefined) return schemaEquivalent;
  if (isReduction(before) || isReduction(after)) {
    return deepEqual(before, after);
  }
  if (Array.isArray(before)) {
    if (!Array.isArray(after) || after.length < before.length) return false;
    return before.every((item, index) => isPreserved(item, after[index]));
  }
  if (
    isObjectOrArray(before) &&
    isObjectNotArray(after)
  ) {
    return Object.entries(before as Record<string, unknown>).every(
      ([key, value]) =>
        isPreserved(value, (after as Record<string, unknown>)[key]),
    );
  }
  return deepEqual(before, after);
}

/**
 * One key the update did not preserve, and how bad that is.
 *
 * The two are graded rather than lumped together because a replay recomputes
 * as well as reads. A pattern's derived values are a function of state the
 * vintage may never have pulled on — measured on the committed fixtures,
 * `createdBy` goes `{name:""}` → `{name:"t"}` (the pattern backfilling from
 * its OWN `createdByName` compatibility shadow), `$NAME` goes `"Topics (2)"` →
 * `"Topics (3)"`, `artSyncState` goes `""` → `"generated"`. None of those is
 * data going missing; all three are the new version resolving something the
 * old one had left unresolved.
 *
 * So a value that merely CHANGED is reported and not failed on, while a
 * non-empty value that went empty is the shape worth stopping for: that is a
 * reader that could see something and now cannot.
 *
 * A refinement deliberately not taken yet: weighting a key by whether it is
 * backed by an `of:` document rather than a `computed:` one. A computed cell
 * is a function of other state by definition, so it recomputing is never loss
 * and losing its INPUTS would surface at the input. The reduction carries the
 * id that would answer it, but a plain data key carries no id at all, so it
 * would grade only some of the findings — worth doing when the warnings have
 * been read for a while and the noise is understood.
 */
export interface StateFinding {
  key: string;
  before: unknown;
  after: unknown;

  /**
   * The value went from something to nothing, rather than to something else.
   * FAILS the gate; a bare change only warns.
   */
  lost: boolean;
}

/**
 * Keys whose value the update did not preserve.
 *
 * Only keys present BEFORE are compared: an update may legitimately ADD a
 * field (that is what `Default<>` is for), so a new key is not a finding. An
 * existing key whose value changed is — that is data the old version wrote and
 * the new one no longer reads back.
 *
 * The RENDERINGS are excluded BY NAME, and nothing else is. A root's
 * `$UI`/`$TILE_UI`/`$CHIP_UI` is a projection the setup recomputes, and the
 * stored rendering and a fresh one are not the same artifact even when nothing
 * about the data changed: measured on the committed `default-app.tsx` fixture,
 * a COMMENT-only edit to `piece-grid.tsx` reports `$UI` as stranded —
 * `children: [null]` where the vintage held it against `children: [[]]` freshly
 * rendered — and the same edit to `note.tsx` reports `$UI` and `$TILE_UI`, one
 * side carrying a `type: "vnode"` tag the other does not. Comparing those keys
 * says nothing about data and reds every pattern edit, so the gate would be
 * turned off within a week of landing.
 *
 * A name is not enough on its own, which is why `comparableState` also reduces
 * a rendering by SHAPE: a transformer hoist's whole result is a vnode, stored
 * under no `$UI` at all. The name list stays because the shape check cannot
 * replace it — the `note.tsx` measurement above is one side that carries the
 * `type: "vnode"` tag against one side that does not.
 *
 * The exclusion is deliberately not "derived values" in general: `$NAME` is
 * derived too and stayed equal across both of those edits, so it is compared —
 * it is a cheap tell that the data behind it went missing. The cost is real and
 * worth naming: a root whose only key is a rendering (`profile-picker.tsx`) has
 * nothing left for this check to compare, and rests on the refusal, completion
 * and reads-as-something checks instead.
 *
 * Everything else is compared by SHAPE rather than by name. A value the
 * comparison cannot see through — a live cell, a `FabricSpecialObject`, a
 * cycle, a rendering — is reduced by `comparableState` on both sides rather
 * than skipped.
 *
 * Both sides go through it here rather than only at the call site: the before
 * state arrives already reduced, but the after state is whatever the
 * materialize returned — a LIVE root value — and comparing a detached copy
 * against a live one reports every cell-valued key as stranded. It is
 * idempotent, so normalizing the already-normalized side costs a walk and
 * removes a way to hold this wrong.
 *
 * Compared with `deepEqual`, not stringified. Serialization is the wrong
 * instrument twice over: it is key-order sensitive, so two equivalent objects
 * whose properties were emitted in a different order would report as stranded,
 * and it cannot represent everything a durable doc may hold — a `bigint` throws.
 *
 * `deepEqual` rather than the data-model's `valueEqual`, which is the more
 * obvious choice. `valueEqual` refuses a materialized root outright — measured,
 * it throws ``Cannot compare value `{"/":{"link@1":{…}}}` `` — but NOT for the
 * reason that message reads as: a link sigil compares fine, and the value it
 * actually refused was a live CELL, rendered through its `toJSON()` and so
 * printed as the sigil it points at. That is the same fact `comparableState`
 * exists for. Both comparators work once the reduction has run, and this one is
 * kept because it needs no value to be a well-formed `FabricValue` and
 * short-circuits instead of hashing a whole VNode tree; the one class it cannot
 * judge, a `FabricSpecialObject` with its state in private fields, is reduced
 * to a content hash before it gets here rather than being compared by it.
 */
export function strandedKeys(
  before: Record<string, unknown>,
  after: unknown,
): StateFinding[] {
  const beforeState = comparableState(before) as Record<string, unknown>;
  const afterState = comparableState(after);
  const afterView = isObjectOrArray(afterState)
    ? afterState as Record<string, unknown>
    : undefined;
  const findings: StateFinding[] = [];
  for (const key of Object.keys(beforeState)) {
    if (RENDERINGS.has(key)) continue;
    const wasThere = beforeState[key];
    const nowThere = afterView?.[key];
    if (isPreserved(wasThere, nowThere)) continue;
    findings.push({
      key,
      before: wasThere,
      after: nowThere,
      lost: lostAnything(wasThere, nowThere),
    });
  }
  return findings;
}

/**
 * Whether anything that carried a value now carries nothing, AT ANY DEPTH.
 *
 * Asked per leaf rather than of the top-level value, and that is the whole
 * point: a durable root's keys are mostly containers, and `.for()` lists are
 * the commonest shape in the system. Judging emptiness only at the top means a
 * key FAILS only when it empties ENTIRELY, so the losses that actually happen
 * pass as warnings — measured, before this recursed:
 *
 *   items ["a","b","c"] → ["a"]                     two rows gone, WARNED
 *   items ["a","b","c"] → [undefined,undefined,…]   every row unreadable, WARNED
 *   profile {name:"ada",id:1} → {id:1}              field gone, WARNED
 *   items [{t,body:"real"}] → [{t,body:""}]         row emptied, WARNED
 *
 * Recursing restores all four to failures and costs none of the measurements
 * that motivated the grading in the first place — `createdBy {name:""} →
 * {name:"t"}`, `$NAME "Topics (2)" → "Topics (3)"`, `artSyncState "" →
 * "generated"` and the pinned seeded `note "written" → "captured"` all still
 * warn, because a leaf that was ALREADY empty had nothing to lose and two
 * non-empty scalars are a change rather than a loss.
 *
 * A REDUCTION compares as an identity, not a container. `{"[cell]": {space,
 * id, path}}` naming a different document is a change, not an emptying — and
 * it must stay that way: a pattern update rotates compiler-generated internal
 * cell identities on purpose, so failing on a moved reduction would red every
 * edit. A reduction that became NOTHING is still lost, caught by the emptiness
 * test above before this branch is reached.
 */
function lostAnything(before: unknown, after: unknown): boolean {
  // Nothing to lose.
  if (isEmptyValue(before)) return false;
  // Held something, holds nothing now.
  if (isEmptyValue(after)) return true;
  // A schema whose representation changed still carries everything it did.
  if (externalSchemaRefEquivalent(before, after) === true) return false;
  if (isReduction(before) || isReduction(after)) return false;
  // A CONTAINER that stopped being one took everything under it with it,
  // whichever direction the flip went. Guarding only the array side let
  // `{a:1}` → `["x"]` and `{a:1}` → `"x"` fall through to "merely changed" —
  // a whole object's worth of state gone, reported as a warning, and NOT the
  // pinned seeded-`.for()` limit, which is a moved key rather than a type
  // change.
  const beforeIsObject = isObjectOrArray(before);
  if (Array.isArray(before)) {
    // A shorter array reaches this through the per-element `undefined`.
    if (!Array.isArray(after)) return true;
    return before.some((item, index) => lostAnything(item, after[index]));
  }
  if (beforeIsObject) {
    if (!isObjectNotArray(after)) {
      return true;
    }
    return Object.entries(before as Record<string, unknown>).some(
      ([key, value]) =>
        lostAnything(value, (after as Record<string, unknown>)[key]),
    );
  }
  // Two non-empty values that simply differ.
  return false;
}

/**
 * Whether a value carries nothing a reader could act on.
 *
 * The falsy primitives are here alongside the empty containers on purpose:
 * `""`, `0` and `false` are what a declared `Default<>` gives a field nobody
 * has written, so a value reverting to one is the same event as a value
 * disappearing — the update stopped being able to read what was there and the
 * schema filled the hole. Distinguishing the two would mean knowing each
 * field's declared default, which the stored schema carries but the comparison
 * does not need: they are the same finding either way.
 *
 * A REDUCTION is never empty. `{"[cell]": {space, id, path}}` names a document,
 * so an empty-looking one is a cell that exists and points somewhere.
 */
function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (isReduction(value)) return false;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length === 0;
  }
  return value === "" || value === 0 || value === false;
}

/**
 * Whether a root value counts as STATE rather than nothing.
 *
 * One predicate, shared by the pre-check below and by the replay's post-check on
 * each migrated root — the two ask the same question, and answering it two ways
 * is how "the root reads as something" comes to mean different things at the two
 * ends of the same run.
 */
export function isPresentRootValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  // An object with no keys is what a fresh space yields for a doc nobody
  // wrote, so it is not evidence either.
  return typeof value !== "object" ||
    Object.keys(value as Record<string, unknown>).length > 0;
}

/**
 * Whether the fixture actually HOLDS the root a manifest entry names.
 *
 * The control that has to run per entry, before today's source is applied to
 * it. "The fixture carries this space" is not the same claim: a space store
 * that opened but never committed is a valid empty database, an entity id is
 * content-derived and so names a cell in any space, and a cell nobody wrote
 * reads as absent rather than as an error. Materializing onto one of those
 * SUCCEEDS — the root then holds today's defaults, `isPresentRootValue` is
 * satisfied, and the entry counts as updated cleanly over state that was never
 * there. Measured: with a companion store truncated to zero bytes, a break that
 * the gate is built to catch replays with no failures at all.
 *
 * The evidence is a RUNNER-WRITTEN MARKER, not a value. A value check would
 * depend on the pattern's result shape, and a root whose result is
 * legitimately `{}` would read as missing. For a NATIVE capture the marker is
 * `patternSetupIdentity`: the runner stamps it under the same condition that
 * reports an instantiation to the capture observer (`runner.ts` —
 * deliberately the same, so the store cannot label roots the observer missed
 * or vice versa), so every observer-recorded entry's cell carries one by
 * construction. An ADOPTED fixture's manifest is written by
 * `tasks/vintage-adopt.ts` instead of the observer, and its store may predate
 * the setup marker entirely — its roots carry only `patternIdentity`.
 *
 * PRESENCE only — this does not check that the marker names the entry's own
 * identity and symbol. Deliberately: a root set up twice under different
 * identities in one capture would then false-red, and correspondence is not
 * reachable from a legitimate capture anyway, since the observer and the stamp
 * describe the same `resultCell`.
 *
 * EITHER marker satisfies presence, therefore. `patternSetupIdentity` (#4915)
 * postdates spaces the runner still rolls forward in production, whose roots
 * carry only `patternIdentity` — a fixture captured by an old toolchain
 * (CT-1941) holds exactly that shape, and refusing it would exclude the
 * vintages this tier exists to replay. The older marker is a weaker claim
 * (pattern loaded, not setup completed), but for THIS question — "was
 * something really captured here, or is this a valid empty database?" —
 * either stamp is evidence only the runner writes.
 */
export async function vintageHoldsRoot(
  vintage: VintageRuntime,
  space: string,
  cellId: string,
): Promise<boolean> {
  const cell = vintage.runtime.getCellFromEntityId(
    space as never,
    cellId as never,
    [],
    undefined as never,
  );
  try {
    await cell.sync();
    return getPatternSetupIdentityRef(cell as Cell<unknown>) !== undefined ||
      getPatternIdentityRef(cell as Cell<unknown>) !== undefined;
  } catch {
    // An absent doc surfaces as a throw rather than `undefined`, and for this
    // question the two are the same answer: nothing was captured here.
    return false;
  }
}

/**
 * Whether a restored fixture's root already holds state.
 *
 * This is a CONTROL, and the replay gate is unsound without one. A fixture that
 * did not restore — truncated, empty, or seeded where the engine does not look
 * — presents to the runtime as a fresh empty space, and materializing today's
 * source onto a fresh empty space succeeds. The replay would then read green
 * having proved nothing at all: emptiness is indistinguishable from a fixture
 * that was never there.
 *
 * The evidence is "the root holds a value", NOT "the root carries a matching
 * patternIdentity stamp". A vintage is captured by running the pattern's own
 * TESTS, and the test harness roots its graph with `runtime.run`, so the stamp
 * at the root belongs to the TEST pattern rather than to the pattern the
 * fixture is named for — an identity check would reject every fixture the
 * capture produces.
 */
export async function vintageRootHasState(
  vintage: VintageRuntime,
): Promise<boolean> {
  const root = vintageRoot<Record<string, unknown>>(vintage, undefined);
  await root.sync();
  try {
    return isPresentRootValue(root.get());
  } catch {
    // An absent doc reads as a throw rather than `undefined`, and for this
    // question the two are the same answer: nothing was captured here.
    return false;
  }
}

/** Read a vintage's stored argument under `schema` (`undefined` = raw). */
export async function readVintageArgument(
  vintage: VintageRuntime,
  link: NormalizedFullLink,
  schema: unknown,
): Promise<unknown> {
  const cell = vintage.runtime.getCellFromLink(link).asSchema(schema as never);
  await cell.sync();
  return cell.get();
}

/**
 * A readable message for anything thrown out of a setup commit.
 *
 * Not every rejection on this path is an `Error`: the storage layer surfaces
 * plain `{ name, message, reason }` records, and `String()` renders those as
 * "[object Object]" — which would still satisfy a `toBeDefined()` assertion
 * while destroying the one thing a caller needs to tell a real migration
 * refusal from an unrelated failure. Chase `cause`/`reason` so the CFC token
 * survives the re-wraps between the merge and here.
 */
function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 8;) {
    depth++;
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current !== "object") {
      parts.push(String(current));
      break;
    }
    const record = current as {
      message?: unknown;
      name?: unknown;
      cause?: unknown;
      reason?: unknown;
    };
    if (typeof record.message === "string") parts.push(record.message);
    else if (typeof record.name === "string") parts.push(record.name);
    current = record.cause ?? record.reason;
  }
  return parts.length > 0 ? parts.join(": ") : String(error);
}

/** What materializing a candidate over a captured vintage did. */
export interface MaterializeOutcome {
  /** The setup-commit rejection, if the candidate could not be applied. */
  error?: string;

  /**
   * Set when the refusal is that the candidate module does not define the
   * recorded symbol. A field rather than a message shape, because `error` is
   * prose: `describeError` strings arbitrary setup failures through it, so a
   * caller that classified this refusal by matching the message would accept
   * any error whose text happened to carry the phrase. The verdict travels
   * beside the message instead of inside it.
   */
  missingArtifact?: true;

  /** The root's value after a successful materialize. */
  value?: Record<string, unknown>;

  /**
   * The candidate's compiled result schema. Handed back so a caller that needs
   * to address the root afterwards reads it off the pattern that was actually
   * materialized, rather than compiling a second time and trusting the two to
   * agree.
   */
  resultSchema: unknown;

  /** The candidate's compiled argument schema, for the same reason. */
  argumentSchema: unknown;

  /**
   * Identity of the pattern that was materialized — the artifact entry ref's
   * identity, not a hash of the source text. A fixture is NAMED with this, so
   * taking it off the compiled artifact is what makes the name provenance
   * rather than a guess: it records the version that actually wrote the state.
   */
  identity: string;
}

/**
 * Materialize `program` onto a captured vintage's root, the way production
 * does.
 *
 * This is the production ROOT REPAIR call, not a bare `runtime.setup`:
 * `PiecesController` commits the candidate's identity onto the root and then
 * runs `runSynced(root.withTx(), pattern, undefined, { expectedPatternIdentity })`
 * (`pieces-controller.ts` — the cold-start repair and the roll-forward
 * materialize both spell it this way). Two things about that shape matter
 * here and neither holds for a bare setup:
 *
 * - `expectedPatternIdentity` is what makes `runSynced` THROW on a
 *   setup-commit rejection instead of logging and continuing. Without it a
 *   refused migration reads as a successful materialize over a dead root —
 *   the gate would be green on exactly the failure it exists to catch.
 * - Stamping the identity first is the update itself. Passing a ref the root
 *   does not carry fails the precondition rather than the migration, which
 *   would be a green-for-the-wrong-reason.
 */
export async function materializeOver(
  vintage: VintageRuntime,
  program: RuntimeProgram,
): Promise<MaterializeOutcome> {
  return await materializeOnCell(
    vintage,
    program,
    (v, schema) => vintageRoot<Record<string, unknown>>(v, schema),
  );
}

/**
 * Materialize `program` onto a cell chosen by `locate`, through the production
 * repair call.
 *
 * The indirection exists so the replay can target a cell recorded in a
 * fixture's manifest rather than only the well-known vintage root. `locate`
 * receives the compiled result schema, because a root has to be read under the
 * schema of the pattern being applied to it.
 *
 * `options.symbol` names WHICH artifact in the module to apply. A module
 * contributes more than one instantiable pattern — its default export, plus
 * every transformer hoist (`__cfPattern_N`, the body of a `map`/`filter`/
 * `flatMap`) — and a stored root records the one it was materialized from.
 * Defaulting to the entry export would apply the module's ROOT pattern to a
 * nested pattern's cell, which can refuse a valid migration or, worse, accept
 * an invalid one having checked the wrong artifact.
 *
 * `options.space` is the space to COMPILE in, which production takes from the
 * piece being updated (`SourceReconciler` compiles a candidate in the piece's
 * own space).
 * It is not cosmetic: it selects the space a `cf:` fabric import resolves
 * against and the space the compiled/source closure is persisted into
 * (`compileViaCellCache`), so compiling a cross-space root's candidate in the
 * fixture's primary space could resolve a different closure than the one that
 * root actually loads. Defaults to the primary space, which is where a
 * single-space fixture's roots live.
 */
export async function materializeOnCell(
  vintage: VintageRuntime,
  program: RuntimeProgram,
  locate: (
    vintage: VintageRuntime,
    resultSchema: unknown,
  ) => Cell<Record<string, unknown>>,
  options: { symbol?: string; space?: string } = {},
): Promise<MaterializeOutcome> {
  const { runtime } = vintage;
  const { symbol, space = vintage.space } = options;
  const entryPattern = await runtime.patternManager.compilePattern(program, {
    space: space as never,
  });
  const entryRef = runtime.patternManager.getArtifactEntryRef(entryPattern);
  if (entryRef === undefined) {
    throw new Error("compiled candidate has no artifact entry ref");
  }
  // `compilePattern` registers the whole evaluated module — exports and
  // `__cfReg` hoists alike — so the named artifact is resolvable in-index
  // under the identity just compiled.
  const selected = symbol === undefined || symbol === entryRef.symbol
    ? entryPattern
    : runtime.patternManager.artifactFromIdentitySync(
      entryRef.identity,
      symbol,
    ) as typeof entryPattern | undefined;
  if (selected === undefined) {
    // Fails CLOSED rather than falling back to the entry pattern: a stored root
    // naming a symbol today's module does not define is a migration hazard to
    // report, not one to paper over.
    //
    // ABSENCE is all this catches, and hoist symbols have a second failure mode
    // it does not. `__cfPattern_N` is positional, so inserting an earlier `map`
    // REBINDS the name instead of removing it — measured: with one `map` the
    // hoist `__cfPattern_1` carried result `{shout}`, and after an earlier `map`
    // was added the same name carried `{other}` while `{shout}` moved to
    // `__cfPattern_2`. A root recorded as `__cfPattern_1` then resolves here to a
    // DIFFERENT nested pattern and this branch never fires. The schema merge
    // catches it only when the two bodies differ in shape. That is a property of
    // the compiler's positional hoist names, inherited by any path that
    // resolves a recorded hoist symbol against a newer version of its module,
    // as this one does; not something this gate can fix. Selecting the
    // recorded symbol is still strictly better than applying the module's
    // entry export to every nested root.
    return {
      error:
        `today's ${program.main} defines no "${symbol}"; the stored root ` +
        `names an artifact this version does not have`,
      missingArtifact: true,
      resultSchema: entryPattern.resultSchema,
      argumentSchema: entryPattern.argumentSchema,
      identity: entryRef.identity,
    };
  }
  const pattern = selected;
  // The ref the RUNNER will write, not the one the caller asked by. `setup()`
  // stamps `getArtifactEntryRef(pattern)`, and that map is first-write-wins — so
  // an artifact exported under two names has ONE canonical symbol, decided by
  // export enumeration order, which need not be the name the fixture recorded.
  // Deriving the stamp and the completion comparison from anything else makes a
  // cosmetic export reorder read as a failed migration: measured, flipping
  // `export { Row }` and `export { Row as RowAlias }` reported "setup did not
  // complete for …#Row: the root carries …#RowAlias" for a swap that in fact
  // succeeded, on the same artifact object.
  //
  // Constrained to the identity just compiled. `setArtifactEntryRef` is
  // first-write-wins over the whole session, so an artifact re-registered under a
  // changed identity keeps its original ref — and stamping THAT would write a
  // root's pointer to a version this replay did not compile. Taking the canonical
  // ref only when its identity agrees keeps the alias fix (same module, different
  // name) without inheriting a stale one.
  const canonical = runtime.patternManager.getArtifactEntryRef(pattern);
  const ref = canonical?.identity === entryRef.identity
    ? canonical
    : { identity: entryRef.identity, symbol: symbol ?? entryRef.symbol };
  const root = locate(vintage, pattern.resultSchema);
  await root.sync();

  const { error: stampError } = await runtime.editWithRetry((tx) => {
    root.withTx(tx).setMetaRaw("patternIdentity", {
      identity: ref.identity,
      symbol: ref.symbol,
    }, rawMetaWriteAuthorization);
  });
  if (stampError !== undefined) {
    throw new Error(
      `could not stamp candidate identity: ${stampError.message}`,
    );
  }

  const schemas = {
    resultSchema: pattern.resultSchema,
    argumentSchema: pattern.argumentSchema,
    identity: ref.identity,
  };
  try {
    await runtime.runSynced(root.withTx(), pattern, undefined, {
      expectedPatternIdentity: ref,
    });
    await runtime.idle();
  } catch (error) {
    return { error: describeError(error), ...schemas };
  }
  // `expectedPatternIdentity` makes a rejected setup COMMIT throw, but a swap
  // whose setup itself fails (the candidate refusing the root's stored
  // arguments, say) is only LOGGED as `pattern-swap-setup-error` — `runSynced`
  // returns normally and the migration reads as applied. The completion marker
  // is the honest signal: `setup()` stamps `patternSetupIdentity` only once it
  // has staged the schema, arguments, internal cells, and result projection, so
  // a root that does not carry the candidate's ref was not actually migrated.
  await root.sync();
  const staged = getPatternSetupIdentityRef(root as Cell<unknown>);
  if (staged?.identity !== ref.identity || staged?.symbol !== ref.symbol) {
    return {
      error: `setup did not complete for ${ref.identity}#${ref.symbol}: the ` +
        `root carries ${
          staged === undefined
            ? "no setup marker"
            : `${staged.identity}#${staged.symbol}`
        }`,
      ...schemas,
    };
  }
  await root.pull();
  return {
    value: root.get() as Record<string, unknown> | undefined,
    ...schemas,
  };
}

export type { RuntimeProgram };

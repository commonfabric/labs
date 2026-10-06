// Rehearsal-grade space clones — a writable copy of a real space store, plus
// the bookkeeping that makes repeated rehearsal attempts comparable.
//
// Design + evidence: docs/plans/space-clone-rehearsal.md. Two findings from the
// July 2026 Topics migration shape this module:
//
//   * The COPY was never the hard part. A server-side `VACUUM INTO` already
//     emits one correctly-named, companion-free file, and a plain `cp` was
//     enough. So the copy path here is deliberately thin.
//   * The BOOKKEEPING was re-invented every attempt (ad-hoc SQL and Python
//     heredocs). Two rehearsals whose fingerprints were computed differently
//     cannot be compared, and an improvised check that quietly measures less
//     than last time looks exactly like a pass. The manifest is the payload.
//
// Layout written by `createClone`:
//
//   <dir>/clone.json               manifest: source, hashes, counts
//   <dir>/.cf-clone                marker — "this store is NOT production"
//   <dir>/pristine/<did>.sqlite    the baseline; never opened read-write
//   <dir>/engine-v3/engine-v3/<did>.sqlite
//                                  the working copy a toolshed serves
//
// That path is not decoration, and the doubled segment is not a typo: it is
// what the memory server composes, so `clonePaths` DERIVES it rather than
// spelling it out. Pointing `MEMORY_DIR` at <dir> then serves the clone as a
// live space under the SAME DID.

import * as Path from "@std/path";
// The only read-WRITE database handle in this package, and it opens nothing:
// `assertNotInUse` takes a lock to ask whether a server is still holding the
// working copy. `db.ts` stays read-only by contract, so the probe lives here
// with the rest of the code that legitimately writes to a clone.
import { Database } from "@db/sqlite";
import {
  resolveMemoryEngineStoreRootUrl,
  resolveSpaceStoreUrl,
} from "@commonfabric/memory/v2/storage-path";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { createHasher } from "@commonfabric/content-hash";
import { isDID } from "@commonfabric/identity/did";
import { openSpace } from "./db.ts";
import {
  contentFingerprint,
  diffFingerprints,
  entityAddressKey,
  FINGERPRINT_SCHEME,
  type FingerprintReport,
  type ScopedEntity,
} from "./fingerprint.ts";

/** Manifest filename the layout depends on. */
const MANIFEST = "clone.json";

/**
 * Per-entity baseline hashes, written beside the manifest at clone time.
 *
 * `createClone` already fingerprints the pristine snapshot; keeping its
 * per-entity rows means `verify` diffs against a file instead of re-opening and
 * re-fingerprinting a multi-gigabyte baseline on every call — measured at 43s
 * vs 13s on the 1.0 GB Estuary store, on the operation a rehearsal runs most.
 * Kept out of `clone.json` so that file stays small enough to read by eye.
 */
const BASELINE = "baseline-entities.json";

const MARKER = ".cf-clone";
const PRISTINE_DIR = "pristine";

/** What every manifest version records about a clone. */
interface CloneManifestFields {
  /** Space DID — the clone keeps it (see the design doc's identity section). */
  space: string;

  /** Where the snapshot came from: a path or URL, verbatim, for provenance. */
  source: string;

  /** ISO timestamp the clone was taken. */
  createdAt: string;

  /** SHA-256 of the pristine snapshot file. */
  snapshotHash: string;

  /**
   * SHA-256 of the per-entity baseline sidecar.
   *
   * The sidecar feeds `diff` and therefore `okAfterMigration` — the verdict a
   * rehearsal script gates on — so it gets the same integrity treatment as the
   * snapshot. Without this, a corrupted-but-parseable sidecar (two hashes
   * swapped inside valid JSON) would produce a confident, wrong diff while
   * `baselineIntact` still reported true. Absent on clones taken before the
   * sidecar existed, which fall back to recomputing.
   */
  baselineHash?: string;

  snapshotBytes: number;

  /** Durable counts at clone time — the cheap half of "did content survive?". */
  counts: {
    commits: number;
    revisions: number;
    entities: number;
    maxSeq: number;
  };
}

/**
 * A clone's manifest, as written by {@link createClone} and read by
 * {@link readManifest}.
 *
 * Version 2 records `fingerprint.scheme`, and a version-2 manifest without one
 * is refused as damaged rather than read as a version-1 clone. A tool that
 * understands only 1 refuses a version-2 clone before touching it, which is
 * what keeps an older checkout from resetting or verifying a clone whose
 * baseline it would fingerprint differently, or with defects since fixed.
 */
export type CloneManifest =
  | CloneManifestFields & { version: 1; fingerprint: ManifestFingerprint }
  | CloneManifestFields & {
    version: 2;
    fingerprint: ManifestFingerprint & {
      /** The {@link FINGERPRINT_SCHEME} the baseline was computed under. */
      scheme: number;
    };
  };

/**
 * Content fingerprint at clone time, generated cells excluded.
 *
 * `unhashable` and `ambiguous` record what the baseline fingerprint could NOT
 * speak for. Both are absent from the roll-up by construction, so a verdict
 * computed from the hash alone rests on however much evidence happened to
 * exist — and without recording the number here, nobody could tell whether
 * that was all of it. Optional: clones taken before these were recorded
 * report them as unknown rather than as zero.
 */
interface ManifestFingerprint {
  hash: string;
  entities: number;
  excludedGenerated: number;
  unhashable?: number;
  ambiguous?: number;
}

export interface CreateCloneOptions {
  /** Path to a `.sqlite` snapshot (a server-side `VACUUM INTO` output). */
  source: string;

  /** Space DID; determines the on-disk filename the server resolves. */
  space: string;

  /** Destination clone directory. Created if absent, must be empty otherwise. */
  targetDir: string;

  /**
   * Store directories that must never be written to — normally the live
   * server's. Callers pass what the environment says (`MEMORY_DIR`/`DB_PATH`).
   */
  forbiddenDirs?: string[];

  /** Timestamp source, injectable so tests need no clock. */
  now?: () => Date;
}

export interface ClonePaths {
  dir: string;
  manifestPath: string;

  /** Per-entity baseline hashes (see {@link BASELINE}). */
  baselinePath: string;

  pristinePath: string;
  workingPath: string;
}

/**
 * Where each artifact lives for a clone of `space` in `dir`.
 *
 * The working copy's path is DERIVED, never spelled out: `dir` is used exactly
 * as a server's `MEMORY_DIR`, and the store lands wherever composing
 * `resolveMemoryEngineStoreRootUrl` with `resolveSpaceStoreUrl` puts it — which
 * today means a doubled `engine-v3/engine-v3/`. Restating that here is how the
 * first version of this file wrote a clone to a path no server ever reads: the
 * copy/verify/reset loop was self-consistent and served nothing.
 */
export function clonePaths(dir: string, space: string): ClonePaths {
  const workingPath = Path.fromFileUrl(
    resolveSpaceStoreUrl(
      resolveMemoryEngineStoreRootUrl(
        Path.toFileUrl(dir.endsWith("/") ? dir : `${dir}/`),
        { singleFileMode: false },
      ),
      space as MemorySpace,
    ),
  );
  return {
    dir,
    manifestPath: `${dir}/${MANIFEST}`,
    baselinePath: `${dir}/${BASELINE}`,
    pristinePath: `${dir}/${PRISTINE_DIR}/${space}.sqlite`,
    workingPath,
  };
}

/**
 * Build a clone from a snapshot: copy to `pristine/`, copy that to
 * `engine-v3/`, and record a manifest.
 *
 * The source is never opened read-write and never mutated — it is read for
 * hashing and copied. Refuses to write into a forbidden (live) store directory
 * or into the source's own directory.
 */
export async function createClone(
  options: CreateCloneOptions,
): Promise<CloneManifest> {
  const now = options.now ?? (() => new Date());
  const dir = await canonicalPath(options.targetDir);
  const source = await canonicalPath(options.source);
  // Drop blank entries BEFORE canonicalizing: `Path.resolve("")` is the current
  // working directory, which would forbid every target beneath it.
  const forbidden = await Promise.all(
    (options.forbiddenDirs ?? [])
      .filter((entry) => entry.trim() !== "")
      .map(canonicalPath),
  );

  assertSafeTarget(dir, source, forbidden);
  await assertEmptyOrAbsent(dir);

  const paths = clonePaths(dir, options.space);
  await Deno.mkdir(`${dir}/${PRISTINE_DIR}`, { recursive: true });
  await Deno.mkdir(Path.dirname(paths.workingPath), { recursive: true });

  // Plain copies. `VACUUM INTO` server-side already produced a consistent,
  // companion-free file; re-vacuuming here would need the live source, which by
  // this point is typically an scp'd file on a laptop.
  await Deno.copyFile(source, paths.pristinePath);
  await Deno.copyFile(paths.pristinePath, paths.workingPath);

  const snapshotHash = await hashFile(paths.pristinePath);
  const snapshotBytes = (await Deno.stat(paths.pristinePath)).size;

  const space = openSpace(paths.pristinePath);
  let counts: CloneManifest["counts"];
  let fingerprint: FingerprintReport;
  try {
    counts = storeCounts(space);
    fingerprint = contentFingerprint(space);
  } finally {
    space.close();
  }

  const manifest: CloneManifest = {
    version: 2,
    space: options.space,
    source: options.source,
    createdAt: now().toISOString(),
    snapshotHash,
    snapshotBytes,
    counts,
    fingerprint: {
      hash: fingerprint.hash,
      entities: fingerprint.entities,
      excludedGenerated: fingerprint.excludedGenerated,
      unhashable: fingerprint.unhashable.length,
      ambiguous: fingerprint.ambiguous.length,
      scheme: FINGERPRINT_SCHEME,
    },
  };

  await Deno.writeTextFile(
    paths.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await Deno.writeTextFile(
    paths.baselinePath,
    JSON.stringify(fingerprint.perEntity),
  );
  // Recorded after the write so the manifest describes what is actually on disk.
  manifest.baselineHash = await hashFile(paths.baselinePath);
  await Deno.writeTextFile(
    paths.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await Deno.writeTextFile(
    `${dir}/${MARKER}`,
    `This directory is a CLONE of space ${options.space}, not production.\n` +
      `Taken ${manifest.createdAt} from ${options.source}.\n` +
      `Reset it with: cf space reset ${dir}\n`,
  );
  return manifest;
}

/** What {@link resetClone} restored, and what it cleared away. */
export interface ResetResult {
  manifest: CloneManifest;

  /**
   * DIDs of the other spaces whose stores the reset removed from beside the
   * working copy.
   *
   * The engine directory holds the cloned space alone when a clone is taken, so
   * any other store in it was created by the attempt being discarded: a link
   * into another space makes the server create a store for that space on
   * demand, and the pass then writes into it. Left in place, the next pass
   * starts from the last one's state there while `verify` — which reads only
   * the cloned space — reports the clone pristine.
   */
  removedStores: string[];

  /**
   * File names of the cell-derived databases the reset removed.
   *
   * The memory server keeps these beside a file store (`#cellDbPath` in
   * `packages/memory/v2/server.ts`), for the cloned space as much as for any
   * other. A snapshot is the space's store alone, so a clone starts with none,
   * and any present at reset time were written by the attempt.
   */
  removedCellDatabases: string[];
}

/**
 * Restore the working copy from the pristine snapshot, and remove every other
 * database the attempt created beside it (see {@link ResetResult}).
 *
 * Deletes the `-wal`/`-shm` companions the engine creates on open. Leaving them
 * behind would let a checkpoint replay part of the discarded attempt over the
 * fresh copy — a reset that silently isn't one.
 *
 * REFUSES while a server still has any of those databases open, because unlinking
 * a file does not disturb a process that already holds it: the server keeps
 * reading and writing the unlinked inode while every new reader — including the
 * `verify` this function's caller runs next — sees the restored one. Pass two of
 * a rehearsal would then run against pass one's state while `cf space verify`
 * reported the clone pristine, which is the failure mode the whole two-pass
 * procedure exists to rule out.
 *
 * That check is a TRIPWIRE, not mutual exclusion. It catches the case that
 * actually happens — an operator who forgot to stop a toolshed that is already
 * serving the clone — and cannot prevent one that opens the store in the
 * instant between the probe and the unlink. No external check can: a process
 * that opens a SQLite file takes no lock in doing so, so there is no state to
 * hold against it, and holding our own lock across the unlink would be worse
 * (the probe connection would then rewrite `-wal`/`-shm` beside the freshly
 * restored copy on close). Stopping the server is what makes a reset correct;
 * this makes forgetting to loud rather than silent.
 */
export async function resetClone(dir: string): Promise<ResetResult> {
  const manifest = await readManifest(dir);
  // A reset is judged by the verify that follows it, so a clone this tool
  // cannot verify is refused before anything is restored.
  assertComparableScheme(dir, manifest);
  const paths = clonePaths(await canonicalPath(dir), manifest.space);
  // Every database is probed before any is removed, so a refusal leaves the
  // clone exactly as it was rather than half cleared. The working copy goes
  // first: it is the store a forgotten server is most likely to hold, and the
  // one a reset exists for.
  await assertNotInUse(paths.workingPath);
  const { stores, cellDatabases } = await attemptDatabases(paths.workingPath);
  for (const database of [...stores, ...cellDatabases]) {
    await assertNotInUse(database);
  }
  const databases = [paths.workingPath, ...stores, ...cellDatabases];
  // The companions are absent on a database no engine has opened yet — the
  // normal case at the start of a rehearsal — so their absence is not an error,
  // while any OTHER failure must surface rather than leave a half-reset clone.
  for (const database of databases) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = `${database}${suffix}`;
      if (await pathExists(path)) await Deno.remove(path);
    }
  }
  await Deno.mkdir(Path.dirname(paths.workingPath), { recursive: true });
  await Deno.copyFile(paths.pristinePath, paths.workingPath);
  return {
    manifest,
    removedStores: stores.map((path) => Path.basename(path, ".sqlite")),
    removedCellDatabases: cellDatabases.map((path) => Path.basename(path)),
  };
}

/**
 * The databases beside `workingPath` that a server created during an attempt,
 * each kind sorted: other spaces' stores, and cell-derived databases.
 *
 * Both are recognized by the names the memory server gives them — a space's
 * store is `<did>.sqlite`, a cell-derived database `cell-<tag>.sqlite` — so
 * anything else in the directory was put there by someone other than a server,
 * and is left alone. What counts as a DID is `isDID`'s to say, the same test
 * that admits a space in the first place, so no store a server could have
 * created is missed for failing a narrower one.
 */
async function attemptDatabases(
  workingPath: string,
): Promise<{ stores: string[]; cellDatabases: string[] }> {
  const dir = Path.dirname(workingPath);
  const own = Path.basename(workingPath);
  const stores: string[] = [];
  const cellDatabases: string[] = [];
  // A clone whose engine directory was deleted outright has nothing beside the
  // working copy, and the restore recreates the directory.
  if (!(await pathExists(dir))) return { stores, cellDatabases };
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || entry.name === own) continue;
    if (!entry.name.endsWith(".sqlite")) continue;
    const stem = entry.name.slice(0, -".sqlite".length);
    if (isDID(stem)) {
      stores.push(`${dir}/${entry.name}`);
    } else if (stem.startsWith("cell-")) {
      cellDatabases.push(`${dir}/${entry.name}`);
    }
  }
  return { stores: stores.sort(), cellDatabases: cellDatabases.sort() };
}

/**
 * Refuse if any process still holds the store at `storePath` open, as of now.
 *
 * "As of now" is the honest scope — see the tripwire note on {@link resetClone}
 * for why nothing stronger is available from outside the server.
 *
 * The probe is the hazard itself rather than a proxy for it: take SQLite's
 * exclusive lock, which in WAL mode cannot be granted while another connection
 * has the shared-memory index mapped. A PID or lease file would have to be
 * written by the server, kept in step with it, and disbelieved when stale; this
 * asks the operating system the actual question and needs no bookkeeping. It
 * also gives the right answer in the case a marker would get wrong: a toolshed
 * that is running but has never opened THIS space's engine holds nothing, and
 * resetting under it is safe because it will open the restored file when it
 * first reads.
 *
 * Locking is the only signal the binding exposes — its errors carry a message
 * and nothing else — so the two outcomes are separated by message. Anything
 * that is not a lock conflict means the store could not be opened as a
 * database at all, and that is precisely when a reset is the remedy rather than
 * the risk, so it proceeds.
 */
async function assertNotInUse(storePath: string): Promise<void> {
  // Nothing to hold open, and `Database` would otherwise create an empty file
  // just to probe it.
  if (!(await pathExists(storePath))) return;
  let db: Database;
  try {
    db = new Database(storePath, { create: false });
  } catch {
    return; // unopenable — reset is the fix, not the hazard
  }
  try {
    db.exec("PRAGMA locking_mode=EXCLUSIVE");
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/database (is|table is) locked/i.test(message)) return;
    throw new Error(
      `refusing to reset ${storePath}: another process still has it open ` +
        `(${message}). Unlinking it would not reach that process — it would ` +
        `keep serving the discarded attempt while verify reported the clone ` +
        `pristine. Stop the server first (scripts/stop-local-dev.sh ` +
        `--port-offset 10), reset, then start it again.`,
    );
  } finally {
    db.close();
  }
}

export interface VerifyResult {
  /**
   * Strict: the baseline is intact AND nothing moved at all.
   *
   * Correct for "is this clone still pristine?", and correct for catching an
   * accidental clobber. NOT usable as the verdict after a migration: a schema
   * update rewrites every piece's result value, so this is false after every
   * successful one.
   *
   * Which of those two situations applies is something only the caller knows,
   * so the tool does not guess — see `okAfterMigration`.
   */
  ok: boolean;

  /**
   * Relaxed: the baseline is intact and nothing was REMOVED.
   *
   * The verdict to gate on when a migration was expected. Content *changing* is
   * then information (results are rewritten by design); content *disappearing*
   * is the alarm. It cannot distinguish a clobber from a migration — nothing
   * hash-shaped can — which is why the runbook insists authored content be
   * checked separately.
   */
  okAfterMigration: boolean;

  /** The pristine snapshot still hashes to what the manifest recorded. */
  baselineIntact: boolean;

  /** Working-copy counts, against the manifest's. */
  counts: {
    manifest: CloneManifest["counts"];
    working: CloneManifest["counts"];
  };

  /** Working-copy content fingerprint, and whether it matches the baseline. */
  fingerprint: {
    manifest: string;
    working: string;
    match: boolean;
    excludedGenerated: number;
  };

  /**
   * WHAT moved, against the pristine baseline — the part an operator can act on.
   *
   * A schema migration necessarily rewrites every piece's result value, so
   * `fingerprint.match` is false after ANY successful migration and cannot by
   * itself distinguish "the update worked" from "content was destroyed". The
   * shape of the change is what separates them: entities `removed` is the alarm,
   * while `changed` confined to pieces and their derived cells is the migration
   * doing its job. Measured on the July 2026 Topics rehearsal: 74 pieces and 73
   * owned cells changed, 3,189 added, **0 removed**, with every authored title,
   * body, comment and link byte-identical.
   */
  diff: {
    removed: number;
    changed: number;
    added: number;

    /**
     * Entities the baseline hashed and this store's manifests call generated at
     * that same (id, scope). They are present in both stores, so they are not
     * removed; the two sides derive their exclusions from their own pieces, and
     * a migration that adopts an unlisted cell into a generated slot moves it
     * from one list to the other. Reported rather than dropped: a number that
     * silently disappears is one nobody can check.
     */
    reclassifiedGenerated: number;

    /**
     * `changed` broken out per entity kind, so that "74 pieces" reads
     * differently from "74 cells".
     */
    changedByKind: Record<string, number>;

    /** `removed` broken out the same way. */
    removedByKind: Record<string, number>;
  };

  /**
   * How much of the store the fingerprint could not speak for, on each side.
   *
   * Neither verdict above is computed from these, and that is deliberate rather
   * than an omission — but a verdict that silently rests on partial evidence is
   * indistinguishable from one that rests on all of it, so the number is
   * reported wherever the verdict is.
   *
   * The two behave differently, and only one is already covered:
   *
   *   * `unhashable` — an entity that BECOMES unhashable drops out of the
   *     working fingerprint entirely, so the diff already counts it as
   *     `removed` and both verdicts already fail. The gap the count closes is
   *     the entity unhashable on BOTH sides: invisible to the diff, so a change
   *     to it is silent, and the only way to know is that the number is nonzero.
   *   * `ambiguous` — an id one manifest calls generated and another calls
   *     named is counted as generated and excluded, which can hide a real
   *     change to authored content. Nothing gates on it, so the count is the
   *     whole signal.
   *
   * `manifest` is null on clones taken before these were recorded.
   */
  uncertainty: {
    unhashable: { manifest: number | null; working: number };
    ambiguous: { manifest: number | null; working: number };

    /**
     * The fingerprint scheme the baseline was computed under, and this tool's.
     * A verify under a different recorded scheme is refused, so the two differ
     * only when the manifest's is null: a clone taken before the scheme was
     * recorded, whose baseline may have been fingerprinted another way.
     */
    scheme: { manifest: number | null; working: number };
  };
}

/**
 * Check a clone against its manifest: the baseline is what it claims to be, and
 * the working copy still holds the same durable content.
 *
 * A migration rehearsal EXPECTS counts to grow — that is what a migration does.
 *
 * It also expects the content fingerprint to MOVE. Excluding generated cells is
 * not enough to hold it still: a schema update rewrites every piece's result
 * value, and results are part of the fingerprint. The first real rehearsal
 * proved this — 74 pieces and 73 owned cells changed while every authored
 * title, body, comment and link stayed byte-identical.
 *
 * So the hash cannot be the verdict after a migration. `diff` is: entities
 * `removed` is the alarm, and changes confined to pieces and their derived
 * cells are the update working. `ok` stays strict for checking an untouched
 * clone; `okAfterMigration` is the one to gate a rehearsal on. Neither can see
 * a clobber of authored content, which is why the runbook checks that
 * separately.
 */
export async function verifyClone(dir: string): Promise<VerifyResult> {
  const manifest = await readManifest(dir);
  assertComparableScheme(dir, manifest);
  const paths = clonePaths(await canonicalPath(dir), manifest.space);

  const baselineIntact = await hashFile(paths.pristinePath) ===
    manifest.snapshotHash;

  const space = openSpace(paths.workingPath);
  let counts: CloneManifest["counts"];
  let fingerprint: FingerprintReport;
  try {
    counts = storeCounts(space);
    fingerprint = contentFingerprint(space);
  } finally {
    space.close();
  }

  // Diff against the baseline recorded at clone time, so the report can say
  // WHAT moved rather than merely that something did. Reading the sidecar
  // avoids re-fingerprinting the pristine snapshot on every verify; a clone
  // taken before the sidecar existed falls back to computing it.
  let before: FingerprintReport;
  try {
    if (manifest.baselineHash !== undefined) {
      const actual = await hashFile(paths.baselinePath);
      if (actual !== manifest.baselineHash) {
        throw new Error(
          `${paths.baselinePath} does not match the hash recorded in ` +
            `${MANIFEST}; the baseline is damaged and its diff would be wrong. ` +
            `Re-clone rather than trusting this verdict.`,
        );
      }
    }
    const rows = JSON.parse(
      await Deno.readTextFile(paths.baselinePath),
    ) as FingerprintReport["perEntity"];
    before = {
      hash: manifest.fingerprint.hash,
      entities: rows.length,
      excludedGenerated: manifest.fingerprint.excludedGenerated,
      // The sidecar records how many the baseline excluded, not which. Empty
      // is honest here and costs nothing: the reclassification below reads
      // the WORKING store's exclusions, which is the side that can turn a
      // present entity into an absent row.
      excludedGeneratedAddresses: [],
      ambiguous: [],
      unhashable: [],
      perEntity: rows,
    };
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    const baseline = openSpace(paths.pristinePath);
    try {
      before = contentFingerprint(baseline);
    } finally {
      baseline.close();
    }
  }

  const d = diffFingerprints(before, fingerprint);
  // Keyed by id AND scope throughout, through the shared `entityAddressKey`:
  // one id can hold a shared space value plus per-user/per-session overrides
  // that are genuinely different entities, and a by-id lookup would let the
  // last scope win — misclassifying the tally, and clearing a removal below
  // because some OTHER scope of the same id is generated. `diffFingerprints`
  // reports the address it compared by and keys it the same way, so there is
  // nothing left to guess at here and no second spelling to drift from.
  //
  // A removal is an entity gone from the store, never one this store's own
  // manifests reclassified. The two sides compute their exclusions
  // independently — the baseline from the pristine pieces, this from the
  // working ones — so a cell no pristine manifest listed and a migrated piece
  // now calls generated is present in both stores and absent from one list.
  // Subtracting them here is what keeps `removed` meaning destroyed content,
  // which is the verdict the runbook tells an operator to stop on. A manifest
  // link carries no scope, so an adopted id is excluded in every scope that
  // holds it: only the addresses this store actually enumerated are subtracted,
  // and a scope whose rows are gone is not among them.
  const excludedNow = new Set(
    fingerprint.excludedGeneratedAddresses.map(entityAddressKey),
  );
  const reclassifiedGenerated = d.removed.filter((at) =>
    excludedNow.has(entityAddressKey(at))
  );
  const removed = d.removed.filter((at) =>
    !excludedNow.has(entityAddressKey(at))
  );
  const kindIndex = (rows: FingerprintReport["perEntity"]) => {
    const byAddress = new Map(rows.map((e) => [entityAddressKey(e), e.kind]));
    return (at: ScopedEntity) =>
      byAddress.get(entityAddressKey(at)) ?? "unknown";
  };
  const kindOf = kindIndex(fingerprint.perEntity);
  const kindWas = kindIndex(before.perEntity);
  const tally = (
    entities: ScopedEntity[],
    lookup: (at: ScopedEntity) => string,
  ) => {
    const out: Record<string, number> = {};
    for (const at of entities) {
      const k = lookup(at);
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };
  const delta = {
    removed: removed.length,
    changed: d.changed.length,
    added: d.added.length,
    reclassifiedGenerated: reclassifiedGenerated.length,
    changedByKind: tally(d.changed, kindOf),
    removedByKind: tally(removed, kindWas),
  };

  const match = fingerprint.hash === manifest.fingerprint.hash;
  return {
    ok: baselineIntact && match,
    okAfterMigration: baselineIntact && delta.removed === 0,
    baselineIntact,
    counts: { manifest: manifest.counts, working: counts },
    fingerprint: {
      manifest: manifest.fingerprint.hash,
      working: fingerprint.hash,
      match,
      excludedGenerated: fingerprint.excludedGenerated,
    },
    diff: delta,
    uncertainty: {
      unhashable: {
        manifest: manifest.fingerprint.unhashable ?? null,
        working: fingerprint.unhashable.length,
      },
      ambiguous: {
        manifest: manifest.fingerprint.ambiguous ?? null,
        working: fingerprint.ambiguous.length,
      },
      scheme: {
        manifest: manifest.version === 2 ? manifest.fingerprint.scheme : null,
        working: FINGERPRINT_SCHEME,
      },
    },
  };
}

/** Read and validate a clone manifest. */
export async function readManifest(dir: string): Promise<CloneManifest> {
  const path = `${await canonicalPath(dir)}/${MANIFEST}`;
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`${dir} is not a clone directory (no ${MANIFEST}).`);
    }
    throw error;
  }
  const parsed = JSON.parse(text) as {
    version?: unknown;
    fingerprint?: { scheme?: unknown };
  };
  if (parsed.version !== 1 && parsed.version !== 2) {
    throw new Error(
      `${path} has manifest version ${parsed.version}; this tool understands ` +
        `1 and 2.`,
    );
  }
  // Version 2 is the version that records the scheme, so one without it is a
  // damaged manifest. Reading it as a version-1 clone would let a verify
  // proceed under a scheme nobody can name, which is what the record is for.
  if (parsed.version === 2 && typeof parsed.fingerprint?.scheme !== "number") {
    throw new Error(
      `${path} has manifest version 2 but records no fingerprint scheme, so ` +
        `the manifest is damaged; clone the snapshot again.`,
    );
  }
  return parsed as CloneManifest;
}

/**
 * Refuse a clone whose baseline was fingerprinted under a scheme other than
 * this tool's, before anything is read or restored. A version-1 clone, which
 * never recorded its scheme, passes, and its verify reports the scheme as
 * unknown.
 */
function assertComparableScheme(dir: string, manifest: CloneManifest): void {
  if (manifest.version === 1) return;
  const scheme = manifest.fingerprint.scheme;
  if (scheme === FINGERPRINT_SCHEME) return;
  throw new Error(
    `${dir}'s baseline was fingerprinted under scheme ${scheme}, and this ` +
      `tool fingerprints under scheme ${FINGERPRINT_SCHEME}, so the two cannot ` +
      `be compared. Use a checkout whose \`cf\` fingerprints under scheme ` +
      `${scheme}, or clone the snapshot again with this one.`,
  );
}

function storeCounts(
  space: ReturnType<typeof openSpace>,
): CloneManifest["counts"] {
  const one = <T extends object>(sql: string): T =>
    space.db.prepare(sql).get<T>() as T;
  const c = one<{ n: number; hi: number | null }>(
    `SELECT count(*) n, max(seq) hi FROM "commit"`,
  );
  const r = one<{ n: number; e: number }>(
    `SELECT count(*) n, count(DISTINCT id) e FROM revision`,
  );
  return { commits: c.n, revisions: r.n, entities: r.e, maxSeq: c.hi ?? 0 };
}

/**
 * SHA-256 of a file, streamed through the canonical hasher
 * (`@commonfabric/content-hash`) so a multi-GB store never lands in memory.
 */
async function hashFile(path: string): Promise<string> {
  const hasher = createHasher();
  using file = await Deno.open(path, { read: true });
  for await (const chunk of file.readable) hasher.update(chunk);
  return hasher.digest("base64url");
}

/**
 * An absolute, symlink-resolved form of `path` — even when it does not exist
 * yet.
 *
 * Both properties are load-bearing for the safety rails. A relative path can
 * never overlap an absolute live-store directory, so returning one verbatim
 * silently disarms `assertSafeTarget` — the clone lands inside the store the
 * rail was meant to protect, under a banner claiming it did not. And on macOS
 * `/tmp` is a symlink to `/private/tmp`, so two spellings of one directory must
 * canonicalize together or the comparison misses.
 *
 * `realPath` needs the path to exist, so for a target we are about to create we
 * resolve the nearest existing ancestor and re-append the rest.
 */
async function canonicalPath(path: string): Promise<string> {
  const absolute = Path.resolve(path);
  const tail: string[] = [];
  let current = absolute;
  while (true) {
    try {
      const real = await Deno.realPath(current);
      return tail.length === 0
        ? real
        : Path.join(real, ...tail.slice().reverse());
    } catch (error) {
      // Anything other than "not there yet" — a component that is a regular
      // file, a permission problem — is a real error the caller must see.
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      const parent = Path.dirname(current);
      if (parent === current) return absolute; // reached the filesystem root
      tail.push(Path.basename(current));
      current = parent;
    }
  }
}

function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * The rail that matters: never write a clone into the store a live server is
 * serving, and never into the source's own directory.
 *
 * Explicit path refusal, not a "looks like production" heuristic — a guess that
 * says yes when it should say no is worse than no check at all.
 */
function assertSafeTarget(
  dir: string,
  source: string,
  forbiddenDirs: string[],
): void {
  const sourceDir = source.replace(/\/[^/]*$/, "");
  if (isWithin(dir, sourceDir) || isWithin(sourceDir, dir)) {
    throw new Error(
      `refusing to clone into the snapshot's own directory (${sourceDir}).`,
    );
  }
  // Blank entries are dropped by the caller before canonicalization (a blank
  // would resolve to the working directory and forbid everything under it), so
  // there is no empty-string case to re-check here.
  for (const raw of forbiddenDirs) {
    const forbidden = raw.replace(/\/+$/, "");
    if (isWithin(dir, forbidden) || isWithin(forbidden, dir)) {
      throw new Error(
        `refusing to write a clone into ${dir}: it overlaps the live store ` +
          `directory ${forbidden}. Pick a target outside it.`,
      );
    }
  }
}

/**
 * Whether a path exists. An absent path is an ordinary answer; every other
 * failure (a component that is not a directory, a permission problem) is a real
 * error and propagates — treating those as "absent" would silently skip a
 * reset or merge a clone into occupied ground.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** A clone directory must not silently merge into existing contents. */
async function assertEmptyOrAbsent(dir: string): Promise<void> {
  // Absent is the normal case — we are about to create it.
  if (!(await pathExists(dir))) return;
  for await (const entry of Deno.readDir(dir)) {
    throw new Error(
      `${dir} is not empty (found ${entry.name}); pick a fresh directory or ` +
        `remove it first.`,
    );
  }
}

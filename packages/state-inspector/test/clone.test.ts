// A clone exists so a rehearsal can be run, judged, and REPEATED from an
// identical baseline. These tests pin the three properties that makes true:
// the source is never touched, a reset really discards the attempt, and verify
// can tell a clean migration from data loss.

import { assert, assertEquals, assertRejects } from "@std/assert";
import * as Path from "@std/path";

import {
  resolveMemoryEngineStoreRootUrl,
  resolveSpaceStoreUrl,
} from "@commonfabric/memory/v2/storage-path";
import { Database } from "@db/sqlite";

import {
  clonePaths,
  createClone,
  readManifest,
  resetClone,
  verifyClone,
} from "../clone.ts";
import { FINGERPRINT_SCHEME } from "../fingerprint.ts";

const SPACE = "did:key:z6MkExampleSpace";
const SESSION = "session:did:key:zSpaceAAAA:11111111-2222-3333";
const MODULE_IDENTITY = "pf1v3J_M5Nep7cq-Uh8EYG0ZQaE217FfDfcjbwGdjVI";
const NOW = () => new Date("2026-07-27T12:00:00.000Z");

/** A per-user scope_key, %-encoded as the runtime stores one. */
const USER_SCOPE = "user:did%3Akey%3AzAlice";

const link = (id: string) => ({ "/": { "link@1": { id, path: [] } } });

/**
 * The piece as a pattern update rewrites it: `of:orphan` — a cell no earlier
 * manifest listed — adopted into a generated slot.
 */
const PIECE_ADOPTING_ORPHAN = {
  value: { $NAME: "Board" },
  argument: link("of:input"),
  internal: [
    { partialCause: "entries", link: link("of:named") },
    { partialCause: { $generated: 0 }, link: link("of:generated") },
    { partialCause: { $generated: 1 }, link: link("of:orphan") },
  ],
  patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
  schema: { type: "object", properties: {}, $defs: {} },
};

/** A source store shaped like a real one: a piece with one named and one
 *  generated internal cell, plus its input. */
function seedSource(path: string): void {
  const db = new Database(path, { create: true });
  db.exec(`
CREATE TABLE "commit" (
  seq INTEGER NOT NULL PRIMARY KEY, branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL, local_seq INTEGER NOT NULL,
  invocation_ref TEXT, authorization_ref TEXT,
  original JSON NOT NULL, resolution JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'space', seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL, op TEXT NOT NULL, data JSON, commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index)
);`);
  writeDocs(db, [
    ["of:piece", {
      value: { $NAME: "Board" },
      argument: link("of:input"),
      internal: [
        { partialCause: "entries", link: link("of:named") },
        { partialCause: { $generated: 0 }, link: link("of:generated") },
      ],
      patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
      schema: { type: "object", properties: {}, $defs: {} },
    }],
    ["of:input", { value: { title: "a topic" } }],
    ["of:named", { value: "named-v1", result: link("of:piece") }],
    ["of:generated", { value: "generated-v1", result: link("of:piece") }],
  ]);
  db.close();
}

/**
 * Append documents to an existing store, continuing its seq sequence.
 *
 * `scope` is the stored `scope_key`: `space` for shared state, and
 * `user:<DID>` / `session:<DID>:<uuid>` for the per-identity rows that can
 * carry the SAME id as a shared one.
 */
function writeDocs(
  db: Database,
  docs: [string, unknown][],
  scope = "space",
): void {
  const next = db.prepare(`SELECT coalesce(max(seq), 0) s FROM "commit"`)
    .get<{ s: number }>()!.s;
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, ?, ?, '{}', '{}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, scope_key, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, ?, 0, 'set', ?, ?)`,
  );
  docs.forEach(([id, doc], i) => {
    const seq = next + i + 1;
    commit.run(seq, SESSION, seq);
    rev.run(id, scope, seq, JSON.stringify(doc), seq);
  });
}

/** Apply writes to a store on disk (what a rehearsal's migration would do). */
function mutate(
  path: string,
  docs: [string, unknown][],
  scope?: string,
): void {
  const db = new Database(path);
  writeDocs(db, docs, scope);
  db.close();
}

/**
 * Destroy an entity's rows in one scope — content loss at rest, which is what
 * `removed` names. A `delete` op would not do: a listing keeps tombstones, so
 * the entity still enumerates and the fingerprint records it with a null hash,
 * which the diff reads as a change.
 */
function dropEntity(path: string, id: string, scope: string): void {
  const db = new Database(path);
  db.prepare(`DELETE FROM revision WHERE id = ? AND scope_key = ?`)
    .run(id, scope);
  db.close();
}

async function withDirs(
  run: (t: { root: string; source: string; clone: string }) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "clone-test-" });
  try {
    const sourceDir = `${root}/source`;
    await Deno.mkdir(sourceDir);
    const source = `${sourceDir}/${SPACE}.sqlite`;
    seedSource(source);
    await run({ root, source, clone: `${root}/clone` });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("a clone is servable, recorded, and leaves the source untouched", async () => {
  await withDirs(async ({ source, clone }) => {
    const before = await Deno.readFile(source);
    const manifest = await createClone({
      source,
      space: SPACE,
      targetDir: clone,
      now: NOW,
    });

    const paths = clonePaths(clone, SPACE);
    // The working copy must sit exactly where a server pointed at this
    // directory looks — computed here through the SAME resolvers the server
    // composes, so this cannot drift into agreeing only with itself.
    assertEquals(
      paths.workingPath,
      Path.fromFileUrl(
        resolveSpaceStoreUrl(
          resolveMemoryEngineStoreRootUrl(Path.toFileUrl(`${clone}/`), {
            singleFileMode: false,
          }),
          SPACE as never,
        ),
      ),
    );
    assertEquals((await Deno.stat(paths.workingPath)).isFile, true);
    assertEquals((await Deno.stat(paths.pristinePath)).isFile, true);
    assertEquals((await Deno.stat(`${clone}/.cf-clone`)).isFile, true);

    assertEquals(manifest.space, SPACE);
    assertEquals(manifest.createdAt, "2026-07-27T12:00:00.000Z");
    assertEquals(manifest.counts.commits, 4);
    assertEquals(manifest.counts.entities, 4);
    // One generated cell excluded; the piece, input and named cell remain.
    assertEquals(manifest.fingerprint.excludedGenerated, 1);
    assertEquals(manifest.fingerprint.entities, 3);

    assertEquals(await Deno.readFile(source), before, "source is untouched");
    assertEquals(await readManifest(clone), manifest, "manifest round-trips");
  });
});

Deno.test("a clean migration keeps the fingerprint even as commits climb", async () => {
  // The whole reason generated cells are excluded. A pattern update rotates
  // them and adds commits; content is unchanged, so verify must still pass.
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    const paths = clonePaths(clone, SPACE);

    mutate(paths.workingPath, [
      ["of:generated", { value: "generated-v2", result: link("of:piece") }],
      ["of:generated", { value: "generated-v3", result: link("of:piece") }],
    ]);

    const v = await verifyClone(clone);
    assert(v.ok, "a generated-cell rewrite is not a content change");
    assert(v.fingerprint.match);
    assert(
      v.counts.working.commits > v.counts.manifest.commits,
      "counts grew, as a migration should",
    );
  });
});

Deno.test("verify reports WHAT moved, not merely that something did", async () => {
  // The headline hash cannot distinguish a successful migration from data
  // loss: a schema update rewrites every piece result, so it always differs.
  // `removed` is the unambiguous alarm, and the per-kind tally is what lets an
  // operator judge the rest.
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    const paths = clonePaths(clone, SPACE);
    mutate(paths.workingPath, [
      ["of:named", { value: "named-v2", result: link("of:piece") }],
      ["of:newcomer", { value: "hello" }],
    ]);

    const v = await verifyClone(clone);
    assertEquals(v.diff.removed, 0, "nothing was destroyed");
    assertEquals(v.diff.changed, 1);
    assertEquals(v.diff.added, 1);
    assertEquals(v.diff.changedByKind["owned-cell"], 1);
    assertEquals(v.diff.removedByKind, {});
  });
});

Deno.test("a migration-shaped change is a PASS, not a failure", async () => {
  // The verdict and the message have to agree. An earlier version reported
  // "this is the EXPECTED result of a migration" while returning ok=false, so
  // the CLI exited nonzero — meaning a rehearsal script written from the
  // documented procedure would treat every successful migration as a failure
  // and refuse to proceed. Content CHANGING is information; content
  // DISAPPEARING is the alarm.
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    const paths = clonePaths(clone, SPACE);
    // What a migration does: rewrite derived values, add new cells, drop nothing.
    mutate(paths.workingPath, [
      ["of:named", {
        value: "rewritten-by-migration",
        result: link("of:piece"),
      }],
      ["of:brand-new-derived-cell", { value: 1, result: link("of:piece") }],
    ]);

    const v = await verifyClone(clone);
    assertEquals(v.diff.removed, 0);
    assert(!v.fingerprint.match, "the hash necessarily moves");
    assert(!v.ok, "strict stays strict — something DID change");
    assert(
      v.okAfterMigration,
      "but the migration verdict passes: nothing lost",
    );
  });
});

Deno.test("a cell a migration adopts as generated is not a removal", async () => {
  // Measured on a 5 GB clone of the real Topics store: `verify` reported 114
  // owned cells REMOVED — "durable content was destroyed", the loudest verdict
  // it has — while every one of them was present at head in BOTH stores. The
  // two sides derive their exclusions from their own pieces: the baseline
  // hashed cells no pristine manifest listed, and after the migration the
  // pieces call those same cells generated, so they drop out of the second
  // list. An operator following the runbook aborts a healthy migration on it.
  await withDirs(async ({ source, clone }) => {
    // A cell no piece's manifest lists: the baseline hashes it.
    mutate(source, [["of:orphan", {
      value: "orphan-v1",
      result: link("of:piece"),
    }]]);
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    const paths = clonePaths(clone, SPACE);
    // What the migration does: the new pattern adopts it into a generated slot.
    mutate(paths.workingPath, [["of:piece", PIECE_ADOPTING_ORPHAN]]);

    const v = await verifyClone(clone);
    assertEquals(v.diff.removed, 0, "it is in both stores; nothing was lost");
    assertEquals(
      v.diff.reclassifiedGenerated,
      1,
      "and the reclassification is reported rather than dropped",
    );
    assert(v.okAfterMigration, "so the migration verdict passes");
  });
});

Deno.test("an adoption in one scope does not excuse a removal in another", async () => {
  // The reclassification has to key by (id, scope) for the same reason the
  // diff does. A manifest link carries an id and no scope, so adopting a cell
  // excludes EVERY scope holding that id from the working fingerprint —
  // subtracting by id alone therefore clears the alarm for a scope whose rows
  // are gone, and reports destroyed per-user state as a filter disagreement.
  // That inverts the whole point: the reclassification exists to preserve
  // `removed` as "durable content was destroyed", not to suppress it.
  await withDirs(async ({ source, clone }) => {
    // One id in two scopes, listed by no manifest: the baseline hashes both.
    mutate(source, [["of:orphan", {
      value: "orphan-v1",
      result: link("of:piece"),
    }]]);
    mutate(source, [["of:orphan", {
      value: "orphan-per-user",
      result: link("of:piece"),
    }]], USER_SCOPE);
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    const paths = clonePaths(clone, SPACE);

    // The migration adopts the id into a generated slot — and the per-user
    // rows are destroyed, which no reclassification can account for.
    mutate(paths.workingPath, [["of:piece", PIECE_ADOPTING_ORPHAN]]);
    dropEntity(paths.workingPath, "of:orphan", USER_SCOPE);

    const v = await verifyClone(clone);
    assertEquals(v.diff.removed, 1, "the destroyed per-user row is a removal");
    assertEquals(
      v.diff.removedByKind,
      { "owned-cell": 1 },
      "classified from the removed entity's own baseline (id, scope)",
    );
    assertEquals(
      v.diff.reclassifiedGenerated,
      1,
      "only the space-scope row is present in both stores",
    );
    assert(!v.okAfterMigration, "so the alarm still sounds");
  });
});

Deno.test("verify catches a real content change", async () => {
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    const paths = clonePaths(clone, SPACE);

    mutate(paths.workingPath, [["of:input", {
      value: { title: "CLOBBERED" },
    }]]);

    const v = await verifyClone(clone);
    assert(!v.ok, "the strict verdict catches an accidental clobber");
    assert(!v.fingerprint.match, "authored content moved");
    assertEquals(v.diff.changed, 1);
    assert(v.baselineIntact, "the baseline itself is still fine");
    // Honest limit: a clobber is a CHANGE, so the migration verdict cannot see
    // it. That is why authored content must be checked separately after a run.
    assert(
      v.okAfterMigration,
      "documented blind spot, asserted so it stays known",
    );
  });
});

Deno.test("reset discards the attempt, including WAL companions", async () => {
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    const paths = clonePaths(clone, SPACE);

    // Open in WAL like the engine does, so real companions exist to clean up.
    const db = new Database(paths.workingPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.close();
    mutate(paths.workingPath, [["of:input", {
      value: { title: "CLOBBERED" },
    }]]);
    assert(
      !(await verifyClone(clone)).ok,
      "the attempt landed",
    );

    await resetClone(clone);

    for (const suffix of ["-wal", "-shm"]) {
      await assertRejects(
        () => Deno.stat(`${paths.workingPath}${suffix}`),
        Deno.errors.NotFound,
        undefined,
        `${suffix} must not survive a reset`,
      );
    }
    const v = await verifyClone(clone);
    assert(v.ok, "back to baseline");
    assert(v.fingerprint.match, "and byte-for-byte identical again");
    assertEquals(v.counts.working.commits, v.counts.manifest.commits);
  });
});

Deno.test("reset refuses while a server still holds the working copy", async () => {
  // The defect this pins: unlinking a file does not reach a process that
  // already has it open. A toolshed keeps reading and writing the unlinked
  // inode while every NEW reader — including the verify that `cf space reset`
  // runs immediately afterwards — sees the restored one, so the reset reports
  // success while pass two runs against pass one's state. Every other reset
  // test in this file closes its connection first, which is exactly the case
  // that cannot catch this.
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    const paths = clonePaths(clone, SPACE);

    // Stand in for the served store: WAL, and still open.
    const server = new Database(paths.workingPath);
    server.exec("PRAGMA journal_mode = WAL");
    server.prepare(`SELECT count(*) FROM "commit"`).get();
    try {
      const error = await assertRejects(
        () => resetClone(clone),
        Error,
        "still has it open",
      );
      assert(
        /stop the server/i.test(error.message),
        `the message must say what to do, got: ${error.message}`,
      );
    } finally {
      server.close();
    }

    // And the refusal is not a permanent lockout: once the holder is gone the
    // same reset succeeds. A guard that could not be cleared would push
    // operators straight back to `rm -rf`.
    await resetClone(clone);
    assert((await verifyClone(clone)).ok, "reset works once the server stops");
  });
});

Deno.test("reset removes the databases an attempt created beside the working copy", async () => {
  // A link into another space makes the server create a store for that space
  // on demand, beside the working copy, and the pass writes into it; the server
  // keeps cell-derived databases there too. `verify` reads only the cloned
  // space, so a reset that left these behind would report the clone pristine
  // while pass two started from pass one's state in them.
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    const engineDir = Path.dirname(clonePaths(clone, SPACE).workingPath);
    /** A database as the engine leaves one: WAL mode, companions beside it. */
    const openedDatabase = async (name: string): Promise<void> => {
      const db = new Database(`${engineDir}/${name}`);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("CREATE TABLE t (x)");
      db.close();
      await Deno.writeTextFile(`${engineDir}/${name}-wal`, "");
      await Deno.writeTextFile(`${engineDir}/${name}-shm`, "");
    };
    // `did:` itself is a DID by `isDID`, so a server resolves a store for it.
    const others = ["did:", "did:key:z6MkOtherSpace"];
    for (const other of others) await openedDatabase(`${other}.sqlite`);
    // Not a space, so reported apart from the stores.
    const cellDb = "cell-deadbeef-cafe.sqlite";
    await openedDatabase(cellDb);
    // Neither name the server gives a database, so not the reset's to remove.
    await Deno.writeTextFile(`${engineDir}/operator-notes.txt`, "keep me");
    await Deno.writeTextFile(`${engineDir}/scratch.sqlite`, "keep me too");

    const result = await resetClone(clone);

    assertEquals(result.removedStores, others);
    assertEquals(result.removedCellDatabases, [cellDb]);
    for (const name of [...others.map((d) => `${d}.sqlite`), cellDb]) {
      for (const suffix of ["", "-wal", "-shm"]) {
        await assertRejects(
          () => Deno.stat(`${engineDir}/${name}${suffix}`),
          Deno.errors.NotFound,
          undefined,
          `${name}${suffix} must not survive a reset`,
        );
      }
    }
    assertEquals(
      await Deno.readTextFile(`${engineDir}/scratch.sqlite`),
      "keep me too",
    );
    assertEquals(
      await Deno.readTextFile(`${engineDir}/operator-notes.txt`),
      "keep me",
    );
    assert((await verifyClone(clone)).ok, "and the clone is back to baseline");
  });
});

Deno.test("reset refuses while a server still holds another space's store", async () => {
  // The same stale-inode hazard as the working copy: removing a store a server
  // still has open would not reach the server. And nothing is removed before
  // every store has been probed, so the refusal leaves the clone as it was.
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    const paths = clonePaths(clone, SPACE);
    const otherPath = `${
      Path.dirname(paths.workingPath)
    }/did:key:z6MkOther.sqlite`;
    mutate(paths.workingPath, [["of:input", { value: { title: "ATTEMPT" } }]]);

    const server = new Database(otherPath);
    server.exec("PRAGMA journal_mode = WAL");
    server.exec("CREATE TABLE t (x)");
    try {
      await assertRejects(
        () => resetClone(clone),
        Error,
        "still has it open",
      );
      assert(
        !(await verifyClone(clone)).ok,
        "the working copy was not restored by the refused reset",
      );
    } finally {
      server.close();
    }

    const result = await resetClone(clone);
    assertEquals(result.removedStores, ["did:key:z6MkOther"]);
    assert((await verifyClone(clone)).ok, "reset works once the server stops");
  });
});

Deno.test("reset restores a working copy that was deleted outright", async () => {
  // Nothing to hold open, and nothing to unlink. The probe must not treat an
  // absent file as a reason to fail — and must not create one just to ask.
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    await Deno.remove(clonePaths(clone, SPACE).workingPath);

    await resetClone(clone);
    assert((await verifyClone(clone)).ok, "restored from pristine");
  });
});

Deno.test("reset recreates an engine directory that was deleted outright", async () => {
  // The same remedy as a deleted working copy, one level up: nothing is beside
  // the working copy to clear, and the restore puts the directory back.
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    const engineDir = Path.dirname(clonePaths(clone, SPACE).workingPath);
    await Deno.remove(engineDir, { recursive: true });

    const result = await resetClone(clone);

    assertEquals(result.removedStores, []);
    assertEquals(result.removedCellDatabases, []);
    assert((await verifyClone(clone)).ok, "restored from pristine");
  });
});

Deno.test("reset works when the working path cannot be opened at all", async () => {
  // The probe fails at open rather than at lock — a different branch from a
  // file that opens and turns out not to be a database, and the same verdict:
  // whatever is in the way, restoring from pristine is the remedy.
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    const paths = clonePaths(clone, SPACE);
    await Deno.remove(paths.workingPath);
    await Deno.mkdir(paths.workingPath);

    await resetClone(clone);
    assert((await verifyClone(clone)).ok, "restored from pristine");
  });
});

Deno.test("reset still works on a working copy that is not a database", async () => {
  // The mirror image of the guard above: a probe that refuses whenever it
  // cannot take the lock would refuse hardest on a corrupt working copy, which
  // is precisely when a reset is the remedy rather than the risk.
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    const paths = clonePaths(clone, SPACE);
    await Deno.writeTextFile(paths.workingPath, "not a database at all");

    await resetClone(clone);
    assert((await verifyClone(clone)).ok, "restored from pristine");
  });
});

Deno.test("verify reports a corrupted baseline rather than trusting it", async () => {
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    const paths = clonePaths(clone, SPACE);
    // A baseline that rotted is not a baseline; resetting to it would silently
    // rehearse against the wrong data.
    mutate(paths.pristinePath, [["of:input", { value: { title: "rot" } }]]);

    const v = await verifyClone(clone);
    assert(!v.baselineIntact);
    assert(!v.ok);
  });
});

Deno.test("refuses to write into the live store directory", async () => {
  await withDirs(async ({ root, source, clone }) => {
    const live = `${root}/live-memory`;
    await Deno.mkdir(live);
    await assertRejects(
      () =>
        createClone({
          source,
          space: SPACE,
          targetDir: `${live}/nested`,
          forbiddenDirs: [live],
          now: NOW,
        }),
      Error,
      "overlaps the live store directory",
    );
    assertEquals(await exists(clone), false);
  });
});

Deno.test("the live-store refusal survives a RELATIVE target path", async () => {
  // Regression: every other fixture here uses absolute temp-dir paths, and the
  // rail passed for all of them while a relative `--to` sailed straight
  // through — a relative path can never overlap an absolute forbidden one, so
  // the clone landed inside the live store under a banner saying it had not.
  await withDirs(async ({ root, source }) => {
    const live = `${root}/live-memory`;
    await Deno.mkdir(live);
    const cwd = Deno.cwd();
    Deno.chdir(root);
    try {
      await assertRejects(
        () =>
          createClone({
            source,
            space: SPACE,
            targetDir: "./live-memory/clone", // relative, as a shell user types
            forbiddenDirs: [live],
            now: NOW,
          }),
        Error,
        "overlaps the live store directory",
      );
    } finally {
      Deno.chdir(cwd);
    }
    assertEquals(await exists(`${live}/clone`), false);
  });
});

Deno.test("a symlinked spelling of the live store is still refused", async () => {
  // On macOS `/tmp` is a symlink to `/private/tmp`, so the same directory has
  // two spellings. Comparing them unresolved would miss the overlap.
  await withDirs(async ({ root, source }) => {
    const live = `${root}/live-memory`;
    await Deno.mkdir(live);
    const alias = `${root}/live-alias`;
    await Deno.symlink(live, alias);

    await assertRejects(
      () =>
        createClone({
          source,
          space: SPACE,
          targetDir: `${alias}/clone`, // same directory, different spelling
          forbiddenDirs: [live],
          now: NOW,
        }),
      Error,
      "overlaps the live store directory",
    );
    assertEquals(await exists(`${live}/clone`), false);
  });
});

Deno.test("refuses to clone into the snapshot's own directory", async () => {
  await withDirs(async ({ source }) => {
    await assertRejects(
      () =>
        createClone({
          source,
          space: SPACE,
          targetDir: source.replace(/\/[^/]*$/, ""),
          now: NOW,
        }),
      Error,
      "snapshot's own directory",
    );
  });
});

Deno.test("refuses a non-empty target rather than merging into it", async () => {
  await withDirs(async ({ source, clone }) => {
    await Deno.mkdir(clone, { recursive: true });
    await Deno.writeTextFile(`${clone}/something.txt`, "prior contents");
    await assertRejects(
      () => createClone({ source, space: SPACE, targetDir: clone, now: NOW }),
      Error,
      "is not empty",
    );
  });
});

Deno.test("the per-kind tally respects scope, not just id", async () => {
  // One id can hold a shared space value AND per-user overrides that are
  // genuinely different entities; `diffFingerprints` keys by id AND scope.
  // Keying the kind lookup by id alone let the last scope win and misclassify
  // the tally — the precision ("74 pieces vs 73 cells") the diff exists for.
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    const working = clonePaths(clone, SPACE).workingPath;
    // Same id as an existing space-scope cell, in a per-user scope.
    mutate(working, [["of:named", { value: "per-user override" }]], USER_SCOPE);

    // Also CHANGE the space-scope row of the same id, so the tally has to
    // classify a real entry rather than an empty map. Without this the
    // assertions below pass no matter how the kind lookup behaves.
    mutate(working, [[
      "of:named",
      { value: "named-v2", result: link("of:piece") },
    ]]);

    const v = await verifyClone(clone);
    assertEquals(v.diff.removed, 0);
    assertEquals(v.diff.added, 1, "the per-user entity is new, not a rewrite");
    assertEquals(v.diff.changed, 1, "the space-scope row of the same id moved");
    // The point of the test: `of:named` exists at two scopes, and the changed
    // one must be classified from ITS OWN row. A by-id lookup would let
    // whichever scope enumerated last supply the kind for both.
    assertEquals(
      v.diff.changedByKind,
      { "owned-cell": 1 },
      "classified from the changed entity's own (id, scope), not by id alone",
    );
    assertEquals(v.diff.removedByKind, {});
  });
});

Deno.test("a clone taken before the baseline sidecar still verifies", async () => {
  // Backward compatibility: clones made before per-entity baselines were
  // recorded have no sidecar, and must still produce a real diff by
  // recomputing from the pristine snapshot rather than silently comparing
  // against nothing — which would report every entity as "added" and pass.
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    await Deno.remove(clonePaths(clone, SPACE).baselinePath);

    const clean = await verifyClone(clone);
    assertEquals(clean.diff.added, 0, "not 'everything is new'");
    assertEquals(clean.diff.changed, 0);
    assert(clean.ok);

    // And it still detects a real change without the sidecar.
    mutate(clonePaths(clone, SPACE).workingPath, [
      ["of:input", { value: { title: "CLOBBERED" } }],
    ]);
    const dirty = await verifyClone(clone);
    assertEquals(dirty.diff.changed, 1);
    assert(!dirty.ok);
  });
});

Deno.test("a corrupted-but-PARSEABLE sidecar is caught by its hash", async () => {
  // The dangerous case is not unparseable JSON — it is valid JSON with wrong
  // contents. The sidecar feeds `diff` and therefore `okAfterMigration`, the
  // verdict a rehearsal gates on, so a silently wrong baseline would produce a
  // confident wrong answer while `baselineIntact` still reported true.
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    const path = clonePaths(clone, SPACE).baselinePath;
    const rows = JSON.parse(await Deno.readTextFile(path)) as {
      id: string;
      hash: string | null;
    }[];
    // Still valid JSON, still the right shape — one hash quietly altered.
    rows[0].hash = "fid1:tamperedtamperedtamperedtamperedtamperedta";
    await Deno.writeTextFile(path, JSON.stringify(rows));

    const error = await assertRejects(() => verifyClone(clone), Error);
    assert(
      error.message.includes("does not match the hash recorded"),
      `expected an integrity failure, got: ${error.message}`,
    );
  });
});

Deno.test("a corrupt baseline sidecar fails loudly rather than recomputing", async () => {
  // Absent is ordinary — an older clone simply has no sidecar. UNREADABLE is
  // not: silently falling back to recomputation would produce a correct-looking
  // verdict while hiding that the clone directory is damaged, and verify's job
  // is to report damage, not paper over it.
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    await Deno.writeTextFile(
      clonePaths(clone, SPACE).baselinePath,
      "{ this is not json",
    );
    await assertRejects(() => verifyClone(clone), Error);
  });
});

Deno.test("an IO error while clearing the working set is surfaced", async () => {
  // reset probes the working copy and its `-wal`/`-shm` companions; only
  // "absent" is an ordinary answer. A component that is not a directory yields NotADirectory, which
  // must propagate rather than be read as "nothing there" — treating it as
  // absent would skip a file it failed to delete and call the clone pristine.
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    const working = clonePaths(clone, SPACE).workingPath;
    // Replace the directory holding the working copy with a regular file.
    const dir = working.replace(/\/[^/]*$/, "");
    await Deno.remove(dir, { recursive: true });
    await Deno.writeTextFile(dir, "not a directory");

    const error = await assertRejects(() => resetClone(clone), Error);
    assert(
      error instanceof Deno.errors.NotADirectory,
      `expected the real IO error, got ${error.constructor.name}`,
    );
  });
});

Deno.test("a directory without a manifest is not a clone", async () => {
  await withDirs(async ({ root }) => {
    await assertRejects(
      () => verifyClone(root),
      Error,
      "is not a clone directory",
    );
  });
});

Deno.test("reset works on a clone that was never opened", async () => {
  // The common case at the START of a rehearsal: no engine has run yet, so
  // there are no WAL companions to remove. Absent companions are not an error.
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    const paths = clonePaths(clone, SPACE);
    assertEquals(await exists(`${paths.workingPath}-wal`), false);

    await resetClone(clone);
    assert((await verifyClone(clone)).ok);
  });
});

Deno.test("a clone records the fingerprint scheme its baseline was taken under", async () => {
  // Version 2 is what an older tool refuses; the scheme is what a newer one
  // checks before comparing anything against the baseline.
  await withDirs(async ({ source, clone }) => {
    const manifest = await createClone({
      source,
      space: SPACE,
      targetDir: clone,
      now: NOW,
    });

    assert(manifest.version === 2, "a new clone writes version 2");
    assertEquals(manifest.fingerprint.scheme, FINGERPRINT_SCHEME);
    assertEquals(
      (await verifyClone(clone)).uncertainty.scheme,
      { manifest: FINGERPRINT_SCHEME, working: FINGERPRINT_SCHEME },
    );
  });
});

Deno.test("a clone fingerprinted under another scheme is refused, not compared", async () => {
  // Two fingerprints computed different ways can differ with no change to the
  // content, or agree across one. The reset is refused too, before restoring
  // anything, since the verify that judges it would be.
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    const manifestPath = `${clone}/clone.json`;
    const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
    manifest.fingerprint.scheme = FINGERPRINT_SCHEME + 1;
    await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));
    const working = clonePaths(clone, SPACE).workingPath;
    mutate(working, [["of:input", { value: { title: "ATTEMPT" } }]]);
    const before = await Deno.readFile(working);

    await assertRejects(() => verifyClone(clone), Error, "cannot be compared");
    await assertRejects(() => resetClone(clone), Error, "cannot be compared");
    assertEquals(
      await Deno.readFile(working),
      before,
      "the refused reset restored nothing",
    );
  });
});

Deno.test("a version-2 manifest without a scheme is refused as damaged", async () => {
  // Only a version-1 clone may lack the scheme. A version-2 one without it
  // would otherwise pass as unknown and be verified or reset under a scheme
  // nobody can name.
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    const manifestPath = `${clone}/clone.json`;
    const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
    delete manifest.fingerprint.scheme;
    await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));
    const working = clonePaths(clone, SPACE).workingPath;
    mutate(working, [["of:input", { value: { title: "ATTEMPT" } }]]);
    const before = await Deno.readFile(working);

    await assertRejects(
      () => verifyClone(clone),
      Error,
      "records no fingerprint scheme",
    );
    await assertRejects(
      () => resetClone(clone),
      Error,
      "records no fingerprint scheme",
    );
    assertEquals(
      await Deno.readFile(working),
      before,
      "the refused reset restored nothing",
    );
  });
});

Deno.test("a clone taken before the scheme was recorded verifies, and says so", async () => {
  // Version-1 clones carry no scheme. They stay usable, but the result reports
  // the baseline's scheme as unknown rather than as this tool's.
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    const manifestPath = `${clone}/clone.json`;
    const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
    delete manifest.fingerprint.scheme;
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({ ...manifest, version: 1 }),
    );

    const result = await verifyClone(clone);

    assert(result.ok, "an untouched version-1 clone still verifies");
    assertEquals(result.uncertainty.scheme, {
      manifest: null,
      working: FINGERPRINT_SCHEME,
    });
  });
});

Deno.test("a manifest from a future tool version is refused, not guessed at", async () => {
  // Reading a newer layout with older rules could reset to the wrong file or
  // compare against a fingerprint computed a different way.
  await withDirs(async ({ source, clone }) => {
    await createClone({ source, space: SPACE, targetDir: clone, now: NOW });
    const manifestPath = `${clone}/clone.json`;
    const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({ ...manifest, version: 3 }),
    );

    await assertRejects(
      () => readManifest(clone),
      Error,
      "this tool understands 1 and 2",
    );
  });
});

Deno.test("an unreadable manifest surfaces its real error", async () => {
  // Only ENOENT means "not a clone". Any other IO failure must not be
  // reported as a missing manifest — that would send an operator looking in
  // the wrong place.
  await withDirs(async ({ root }) => {
    const dir = `${root}/odd-clone`;
    await Deno.mkdir(`${dir}/clone.json`, { recursive: true });
    const error = await assertRejects(() => readManifest(dir), Error);
    assert(
      !error.message.includes("is not a clone directory"),
      `expected the underlying IO error, got: ${error.message}`,
    );
  });
});

Deno.test("a filesystem error other than 'absent' is surfaced, not swallowed", async () => {
  // Only ENOENT means "nothing there". Treating any other failure as absent
  // would let `createClone` merge onto occupied ground, or let `reset` skip a
  // file it failed to delete and call the clone pristine. A path whose parent
  // component is a regular file yields NotADirectory — deterministically, with
  // no permission games that a root-running CI would bypass.
  await withDirs(async ({ root, source }) => {
    const regularFile = `${root}/not-a-dir.txt`;
    await Deno.writeTextFile(regularFile, "x");
    const error = await assertRejects(
      () =>
        createClone({
          source,
          space: SPACE,
          targetDir: `${regularFile}/clone`,
          now: NOW,
        }),
      Error,
    );
    assert(
      error instanceof Deno.errors.NotADirectory,
      `expected the real IO error, got ${error.constructor.name}`,
    );
  });
});

Deno.test("an empty forbidden-directory entry is ignored, not treated as '/'", async () => {
  // The CLI builds this list from the environment, where an unset variable can
  // arrive as "". Treating that as a path prefix would refuse every target.
  await withDirs(async ({ source, clone }) => {
    const manifest = await createClone({
      source,
      space: SPACE,
      targetDir: clone,
      forbiddenDirs: ["", "  ", "/definitely/not/this/one"],
      now: NOW,
    });
    assertEquals(manifest.space, SPACE);
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

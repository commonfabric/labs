// Unit tests for the read-only dump helpers (list / resolve / snapshot).
//
// Fixtures are seeded through the SAME `resolveSpaceStoreUrl` the live
// `MemoryServer` uses, so the test exercises the real on-disk layout (where
// directory-mode stores nest space DBs one `engine-v3/` deeper than the store
// root) rather than a hand-simplified path.

import { assertEquals } from "@std/assert";
import * as Path from "@std/path";

import { Database } from "@db/sqlite";

import type { MemorySpace } from "../interface.ts";
import {
  listSpaceStores,
  snapshotSpaceStore,
  spaceStorePath,
} from "../v2/dump.ts";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";

const SPACE_A = "did:key:z6MkDumpHelperSpaceAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SPACE_B = "did:key:z6MkDumpHelperSpaceBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

/** A store dir as the toolshed would pass to MemoryServer (directory mode). */
async function makeStore(): Promise<URL> {
  const tmp = await Deno.makeTempDir({ prefix: "cf-dump-unit-" });
  return Path.toFileUrl(`${tmp}/`);
}

// Seed a space exactly where the server would write it.
function seedStore(store: URL, space: string, rows: number): void {
  const path = canonicalPath(store, space);
  Deno.mkdirSync(Path.dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.exec("CREATE TABLE probe (n INTEGER)");
    for (let i = 0; i < rows; i++) {
      db.exec("INSERT INTO probe (n) VALUES (?)", i);
    }
  } finally {
    db.close();
  }
}

function canonicalPath(store: URL, space: string): string {
  return Path.fromFileUrl(resolveSpaceStoreUrl(store, space as MemorySpace));
}

async function rm(store: URL): Promise<void> {
  await Deno.remove(Path.fromFileUrl(store), { recursive: true }).catch(
    () => {},
  );
}

Deno.test("listSpaceStores returns decoded DIDs, newest first", async () => {
  const store = await makeStore();
  try {
    seedStore(store, SPACE_A, 1);
    seedStore(store, SPACE_B, 1);
    const spaces = listSpaceStores(store);
    const dids = spaces.map((s) => s.space).sort();
    assertEquals(dids, [SPACE_A, SPACE_B].sort());
    for (const s of spaces) {
      // DIDs come back decoded (literal ":"), not percent-encoded.
      assertEquals(s.space.includes("%3A"), false);
      assertEquals(s.sizeBytes > 0, true);
    }
  } finally {
    await rm(store);
  }
});

Deno.test("spaceStorePath matches the server's canonical path + blocks traversal", async () => {
  const store = await makeStore();
  try {
    seedStore(store, SPACE_A, 1);
    // Must equal the exact path `Server.#openEngine()` would resolve.
    assertEquals(spaceStorePath(store, SPACE_A), canonicalPath(store, SPACE_A));
    assertEquals(spaceStorePath(store, "did:key:zMissing"), null);
    // Path traversal in the id is rejected by the encode guard.
    assertEquals(spaceStorePath(store, "../../etc/passwd"), null);
    assertEquals(spaceStorePath(store, "a/b"), null);
  } finally {
    await rm(store);
  }
});

Deno.test("snapshotSpaceStore produces a consistent, openable copy", async () => {
  const store = await makeStore();
  try {
    seedStore(store, SPACE_A, 100);
    const source = spaceStorePath(store, SPACE_A)!;
    const destDir = await Deno.makeTempDir({ prefix: "cf-dump-snap-" });
    const dest = Path.join(destDir, "snap.sqlite");
    try {
      snapshotSpaceStore(source, dest);
      // No WAL/SHM companions: VACUUM INTO yields a single self-contained file.
      assertEquals(await exists(`${dest}-wal`), false);
      const db = new Database(dest, { readonly: true });
      try {
        const row = db.prepare("SELECT count(*) AS c FROM probe").get<
          { c: number }
        >();
        assertEquals(row?.c, 100);
      } finally {
        db.close();
      }
    } finally {
      await Deno.remove(destDir, { recursive: true });
    }
  } finally {
    await rm(store);
  }
});

Deno.test("single-file (DB_PATH) mode: literal-%3A filenames round-trip", async () => {
  // Single-file/clustering mode keeps the percent-encoded filename literally on
  // disk (`did%3Akey%3A….sqlite`) — distinct from directory mode. Lock it so a
  // refactor can't silently fork existing clustered data into new files.
  const tmp = await Deno.makeTempDir({ prefix: "cf-dump-file-" });
  const store = Path.toFileUrl(Path.join(tmp, "cluster.sqlite"));
  try {
    seedStore(store, SPACE_A, 1);
    // On-disk name is the literal percent-encoded form for this mode.
    const onDisk = Path.basename(canonicalPath(store, SPACE_A));
    assertEquals(onDisk, `${encodeURIComponent(SPACE_A)}.sqlite`);
    assertEquals(onDisk.includes("%3A"), true);
    // …yet listing decodes it back to the canonical DID, and resolution matches.
    assertEquals(listSpaceStores(store).map((s) => s.space), [SPACE_A]);
    assertEquals(spaceStorePath(store, SPACE_A), canonicalPath(store, SPACE_A));
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("directory mode: an id with a literal percent-sequence round-trips", async () => {
  // e.g. a did:web with an encoded port. Directory-mode stems are the LITERAL
  // id, so listing must NOT decodeURIComponent them (that corrupted `%3A`→`:`
  // and made the listed id unresolvable).
  const id = "did:web:example.com%3A8080";
  const store = await makeStore();
  try {
    seedStore(store, id, 1);
    assertEquals(listSpaceStores(store).map((s) => s.space), [id]);
    assertEquals(spaceStorePath(store, id), canonicalPath(store, id));
  } finally {
    await rm(store);
  }
});

Deno.test("listSpaceStores skips entries that aren't space stores", async () => {
  const store = await makeStore();
  try {
    seedStore(store, SPACE_A, 1);
    const dir = Path.dirname(canonicalPath(store, SPACE_A));
    // A non-sqlite file and a directory with a .sqlite name are never stores.
    Deno.writeTextFileSync(Path.join(dir, "README.txt"), "not a store");
    Deno.mkdirSync(Path.join(dir, "subdir.sqlite"));
    assertEquals(listSpaceStores(store).map((s) => s.space), [SPACE_A]);
  } finally {
    await rm(store);
  }
});

Deno.test("single-file mode: an undecodable stem is skipped", async () => {
  // In single-file mode stems are percent-ENCODED, so a stem that fails to
  // decode cannot be a store we wrote. (In directory mode stems are literal,
  // so the same name would be a valid literal id — no decode happens there.)
  const tmp = await Deno.makeTempDir({ prefix: "cf-dump-badenc-" });
  const store = Path.toFileUrl(Path.join(tmp, "cluster.sqlite"));
  try {
    seedStore(store, SPACE_A, 1);
    const dir = Path.dirname(canonicalPath(store, SPACE_A));
    Deno.writeTextFileSync(Path.join(dir, "%zz.sqlite"), "bad encoding");
    assertEquals(listSpaceStores(store).map((s) => s.space), [SPACE_A]);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("listSpaceStores: stat races and null mtimes degrade gracefully", async () => {
  const store = await makeStore();
  const realStat = Deno.statSync;
  try {
    seedStore(store, SPACE_A, 1);
    seedStore(store, SPACE_B, 1);

    // A file deleted between readdir and stat (TOCTOU) is skipped, not fatal.
    // (Directory-mode filenames are the LITERAL did — match on that.)
    Deno.statSync = ((p: string | URL) => {
      if (String(p).includes(SPACE_B)) {
        throw new Deno.errors.NotFound("raced");
      }
      return realStat(p);
    }) as typeof Deno.statSync;
    assertEquals(listSpaceStores(store).map((s) => s.space), [SPACE_A]);

    // A filesystem with no mtime reports 0, not a crash.
    Deno.statSync = ((p: string | URL) => {
      const real = realStat(p);
      return { ...real, isFile: real.isFile, mtime: null };
    }) as typeof Deno.statSync;
    for (const s of listSpaceStores(store)) assertEquals(s.mtimeMs, 0);

    // Any other stat error (permissions, IO) surfaces.
    Deno.statSync = ((p: string | URL) => {
      if (String(p).endsWith(".sqlite")) {
        throw new Deno.errors.PermissionDenied("io");
      }
      return realStat(p);
    }) as typeof Deno.statSync;
    let threw = false;
    try {
      listSpaceStores(store);
    } catch (e) {
      threw = e instanceof Deno.errors.PermissionDenied;
    }
    assertEquals(threw, true);
  } finally {
    Deno.statSync = realStat;
    await rm(store);
  }
});

Deno.test("spaceStorePath surfaces non-NotFound stat errors", async () => {
  // A store whose engine-v3 "dir" is a FILE → stat of engine-v3/<did>.sqlite
  // fails with NotADirectory, which must rethrow rather than read as "absent".
  const tmp = await Deno.makeTempDir({ prefix: "cf-dump-nadir-" });
  const store = Path.toFileUrl(`${tmp}/`);
  try {
    Deno.writeTextFileSync(Path.join(tmp, "engine-v3"), "file, not dir");
    let threw = false;
    try {
      spaceStorePath(store, SPACE_A);
    } catch (e) {
      threw = !(e instanceof Deno.errors.NotFound);
    }
    assertEquals(threw, true);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("resolveSpaceStoreUrl rejects an unencodable space id", async () => {
  // A lone surrogate passes the character guard but encodeURIComponent throws.
  const store = await makeStore();
  try {
    let threw = false;
    try {
      resolveSpaceStoreUrl(store, "\uD800bad" as MemorySpace);
    } catch (e) {
      threw = e instanceof Error &&
        e.message.includes("Invalid memory space identifier");
    }
    assertEquals(threw, true);
  } finally {
    await rm(store);
  }
});

Deno.test("listSpaceStores: missing store dir is empty, IO error rethrows", async () => {
  const store = await makeStore(); // exists, but no engine-v3 dir seeded yet
  try {
    assertEquals(listSpaceStores(store), []); // NotFound → []
  } finally {
    await rm(store);
  }

  // A store whose engine-v3 "dir" is actually a FILE → readDir throws a
  // non-NotFound error, which must surface rather than look like "no spaces".
  const tmp = await Deno.makeTempDir({ prefix: "cf-dump-notdir-" });
  const fileStore = Path.toFileUrl(`${tmp}/`);
  try {
    Deno.writeTextFileSync(Path.join(tmp, "engine-v3"), "not a directory");
    let threw = false;
    try {
      listSpaceStores(fileStore);
    } catch (e) {
      threw = !(e instanceof Deno.errors.NotFound);
    }
    assertEquals(threw, true);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

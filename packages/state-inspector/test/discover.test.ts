// Hermetic test for local DB discovery + space resolution. Builds a fake
// engine-v3 cache layout in a temp dir and checks discovery, DID resolution,
// and quick stats. Side-effect free.

import { assert, assertEquals, assertThrows } from "@std/assert";
import * as Path from "@std/path";
import { Database } from "@db/sqlite";

import {
  candidateRoots,
  deriveSpaceDid,
  discoverSpaceDbs,
  quickStats,
  resolveSpace,
  resolveSpacePath,
} from "../discover.ts";

const SCHEMA = `
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
);
`;

function makeSpace(path: string, entityCount: number) {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  for (let i = 0; i < entityCount; i++) {
    db.prepare(
      `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution, created_at)
       VALUES (?, 's', 1, '{}', '{}', '2026-06-2${i}')`,
    ).run(i + 1);
    db.prepare(
      `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
       VALUES (?, ?, 0, 'set', '{"value":1}', ?)`,
    ).run(`of:e${i}`, i + 1, i + 1);
  }
  db.close();
}

const DID_1 = "did:key:zAlphaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const DID_2 = "did:key:zBetaBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

Deno.test("discovery + resolution", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-discover-" });
  try {
    // Mimic the doubled engine-v3 cache layout under a "cache/memory" base.
    const engine = `${dir}/cache/memory/engine-v3/engine-v3`;
    await Deno.mkdir(engine, { recursive: true });
    makeSpace(`${engine}/${DID_1}.sqlite`, 2);
    makeSpace(`${engine}/${DID_2}.sqlite`, 3);
    // A non-sqlite sibling and a WAL file should be ignored.
    await Deno.writeTextFile(`${engine}/notes.txt`, "ignore me");
    await Deno.writeTextFile(`${engine}/${DID_1}.sqlite-wal`, "");

    await t.step("discovers both DBs by walking the cache base", () => {
      const found = discoverSpaceDbs({
        dirs: [`${dir}/cache/memory`],
        defaultRoots: false,
      });
      assertEquals(found.length, 2);
      assertEquals(new Set(found.map((s) => s.did)), new Set([DID_1, DID_2]));
      assert(found.every((s) => s.sizeBytes > 0));
    });

    await t.step("default roots find the DBs via the cwd walk", () => {
      // No explicit dirs: the cwd walk must reach `<cwd>/cache/memory`. On a
      // real machine the default roots may surface OTHER DBs too (env
      // overrides, ~/.cache/cf-inspect), so assert superset, never counts.
      const found = discoverSpaceDbs({ cwd: dir });
      const dids = new Set(found.map((s) => s.did));
      assert(dids.has(DID_1) && dids.has(DID_2));
    });

    await t.step("resolveSpacePath matches by DID prefix", () => {
      const found = discoverSpaceDbs({
        dirs: [`${dir}/cache/memory`],
        defaultRoots: false,
      });
      const path = resolveSpacePath("zAlpha", found);
      assert(path.endsWith(`${DID_1}.sqlite`));
    });

    await t.step("resolveSpacePath accepts an explicit path", () => {
      const p = `${engine}/${DID_2}.sqlite`;
      assertEquals(resolveSpacePath(p), p);
    });

    await t.step("ambiguous prefix throws", () => {
      const found = discoverSpaceDbs({
        dirs: [`${dir}/cache/memory`],
        defaultRoots: false,
      });
      assertThrows(
        () => resolveSpacePath("did:key:z", found),
        Error,
        "ambiguous",
      );
    });

    await t.step("quickStats returns counts", () => {
      const stats = quickStats(`${engine}/${DID_2}.sqlite`);
      assertEquals(stats?.commits, 3);
      assertEquals(stats?.entities, 3);
    });

    await t.step(
      "resolveSpace resolves a space NAME via the runtime derivation",
      async () => {
        // The runtime derives a named space's DID; we mirror it, so addressing a
        // space by the name the shell shows finds the same DB.
        const name = "state-inspector-test-space";
        const did = await deriveSpaceDid(name);
        assert(did.startsWith("did:key:z"), "derives a did:key DID");
        makeSpace(`${engine}/${did}.sqlite`, 1);
        const found = discoverSpaceDbs({
          dirs: [`${dir}/cache/memory`],
          defaultRoots: false,
        });

        const byName = await resolveSpace(name, found);
        assert(
          byName.endsWith(`${did}.sqlite`),
          "a name resolves to its derived DID's DB",
        );
        // the same async entry point still honors DID-prefix and path matching
        const byPrefix = await resolveSpace("zAlpha", found);
        assert(byPrefix.endsWith(`${DID_1}.sqlite`));
      },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("candidateRoots orders env overrides before caches and cwd walk", () => {
  const saved = {
    MEMORY_DIR: Deno.env.get("MEMORY_DIR"),
    DB_PATH: Deno.env.get("DB_PATH"),
  };
  const restore = (k: keyof typeof saved) =>
    saved[k] === undefined ? Deno.env.delete(k) : Deno.env.set(k, saved[k]!);
  try {
    Deno.env.set("MEMORY_DIR", "/env/memory");
    Deno.env.set("DB_PATH", "/env/db/space.sqlite");
    const roots = candidateRoots("/a/b");
    // env overrides first (a .sqlite DB_PATH contributes its directory)…
    assertEquals(roots[0], "/env/memory");
    assertEquals(roots[1], "/env/db");
    // …then the remote-pull cache…
    assert(roots[2].endsWith("/.cache/cf-inspect"));
    // …then both cache layouts at each level of the upward walk.
    assert(roots.includes("/a/b/packages/toolshed/cache/memory"));
    assert(roots.includes("/a/b/cache/memory"));
    assert(roots.includes("/a/cache/memory"));

    // A bare relative DB_PATH filename resolves to ".", not an empty root.
    Deno.env.set("DB_PATH", "space.sqlite");
    assert(candidateRoots("/a/b").includes("."));

    // The upward walk stops at the filesystem root rather than looping on it,
    // which is a root being its own parent.
    Deno.env.delete("DB_PATH");
    Deno.env.delete("MEMORY_DIR");
    const fromRoot = candidateRoots("/");
    assertEquals(fromRoot.filter((r) => r === "/cache/memory").length, 1);
  } finally {
    restore("MEMORY_DIR");
    restore("DB_PATH");
  }
});

Deno.test("discovery finds a space under a MEMORY_DIR written as a file URL", async () => {
  // The form a server's own configuration uses: `packages/toolshed/env.ts`
  // defaults MEMORY_DIR to a `file:` URL, and the server hands it to `new URL()`.
  // Left as a URL it names no directory, so the walk finds nothing and every
  // space in that store reads as absent — which is what this covers, by taking
  // the same route `cf inspect <space>` takes to a store the environment names.
  const saved = Deno.env.get("MEMORY_DIR");
  const restore = () =>
    saved === undefined
      ? Deno.env.delete("MEMORY_DIR")
      : Deno.env.set("MEMORY_DIR", saved);
  const dir = await Deno.makeTempDir({ prefix: "cf-store-url-" });
  try {
    const engine = `${dir}/engine-v3/engine-v3`;
    await Deno.mkdir(engine, { recursive: true });
    const name = "state-inspector-url-space";
    const did = await deriveSpaceDid(name);
    makeSpace(`${engine}/${did}.sqlite`, 1);

    // The trailing separator is the one the default carries.
    Deno.env.set("MEMORY_DIR", Path.toFileUrl(`${dir}/`).href);
    const found = discoverSpaceDbs({ cwd: dir });
    assertEquals(await resolveSpace(name, found), `${engine}/${did}.sqlite`);

    // A path written by hand reaches the same store, and the same file.
    Deno.env.set("MEMORY_DIR", dir);
    assertEquals(
      await resolveSpace(name, discoverSpaceDbs({ cwd: dir })),
      `${engine}/${did}.sqlite`,
    );
  } finally {
    restore();
    await Deno.remove(dir, { recursive: true });
  }
});

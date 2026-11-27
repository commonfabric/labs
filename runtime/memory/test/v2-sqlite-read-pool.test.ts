import { Database } from "@db/sqlite";
import { expect } from "@std/expect";
import { ensureColumnOriginAvailable } from "../v2/sqlite/column-origin.ts";
import { ReadConnectionPool } from "../v2/sqlite/read-pool.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

// `queryWithOrigins()` resolves column origins over FFI, which production
// binds once before issuing one.
await ensureColumnOriginAvailable();

describe("ReadConnectionPool", () => {
  // Whether a path's connection is still pooled shows after its file is
  // removed: a pooled connection keeps the open file and still reads it,
  // while a path the pool has to open again throws.

  let dir: string;

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "read-pool-" });
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true });
  });

  function makeDb(name: string): string {
    const path = `${dir}/${name}.sqlite`;
    const db = new Database(path);
    db.exec("CREATE TABLE t (v TEXT)");
    db.exec("INSERT INTO t (v) VALUES (?)", name);
    db.close();
    return path;
  }

  const read = (pool: ReadConnectionPool, path: string) =>
    pool.query<{ v: string }>(path, "SELECT v FROM t");

  it("keeps serving a path while it is within the pool's size", () => {
    const pool = new ReadConnectionPool(2);
    try {
      const a = makeDb("a");
      const b = makeDb("b");
      expect(read(pool, a)).toEqual([{ v: "a" }]);
      expect(read(pool, b)).toEqual([{ v: "b" }]);
      Deno.removeSync(a);
      expect(read(pool, a)).toEqual([{ v: "a" }]);
    } finally {
      pool.close();
    }
  });

  it("evicts the least recently used connection once the pool is over its size", () => {
    const pool = new ReadConnectionPool(2);
    try {
      const a = makeDb("a");
      const b = makeDb("b");
      const c = makeDb("c");
      read(pool, a);
      read(pool, b);
      // Reading `a` again makes `b` the least recently used.
      read(pool, a);
      expect(read(pool, c)).toEqual([{ v: "c" }]);
      Deno.removeSync(a);
      Deno.removeSync(b);
      expect(read(pool, a)).toEqual([{ v: "a" }]);
      expect(() => read(pool, b)).toThrow("unable to open database file");
    } finally {
      pool.close();
    }
  });

  it("serves a path's labeled and ordinary reads from one connection", () => {
    // A pool of one keeps the connection across both kinds of read, so each
    // still reads the file after it is removed.

    const pool = new ReadConnectionPool(1);
    try {
      const a = makeDb("a");
      read(pool, a);
      pool.queryWithOrigins(a, "SELECT v FROM t");
      expect(pool.accessForTestingOnly.byPath.size).toBe(1);
      Deno.removeSync(a);
      expect(pool.queryWithOrigins(a, "SELECT v FROM t").rows).toEqual([
        { v: "a" },
      ]);
      expect(read(pool, a)).toEqual([{ v: "a" }]);
    } finally {
      pool.close();
    }
  });

  // Dropping a connection from the pool does not release its file; closing
  // it does, so these read each connection's own `open`.
  const pooled = (pool: ReadConnectionPool) => [
    ...pool.accessForTestingOnly.byPath.values(),
  ];

  it("closes the connection it evicts", () => {
    const pool = new ReadConnectionPool(1);
    try {
      const a = makeDb("a");
      const b = makeDb("b");
      read(pool, a);
      const [first] = pooled(pool);
      read(pool, b);
      const [second] = pooled(pool);
      expect(first.open).toBe(false);
      expect(second.open).toBe(true);
    } finally {
      pool.close();
    }
  });

  it("closes every pooled connection on `close()`, and opens new ones afterwards", () => {
    const pool = new ReadConnectionPool(2);
    try {
      const a = makeDb("a");
      const b = makeDb("b");
      read(pool, a);
      read(pool, b);
      const connections = pooled(pool);
      expect(connections.map((db) => db.open)).toEqual([true, true]);
      pool.close();
      expect(connections.map((db) => db.open)).toEqual([false, false]);
      expect(pooled(pool)).toEqual([]);
      expect(read(pool, b)).toEqual([{ v: "b" }]);
      pool.close();
      Deno.removeSync(a);
      expect(() => read(pool, a)).toThrow("unable to open database file");
    } finally {
      pool.close();
    }
  });
});

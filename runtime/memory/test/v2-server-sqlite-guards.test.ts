/**
 * The checks the server makes on SQLite work before it touches a database: a
 * read of a cell database whose file or table is missing or unreadable, an
 * injected on-disk source that would reach into the store, and the folded
 * `sqlite` operations of a commit.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { dirname, fromFileUrl, join, toFileUrl } from "@std/path";

import type { Operation, SqliteDbRef } from "../v2.ts";
import { connect, loopback } from "../v2/client.ts";
import type * as Engine from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import { table } from "../v2/sqlite/schema.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-memory-v2-sqlite-guards-space";

const notes = table({ id: "integer primary key", body: "text" });

/** A database id no other test, or earlier run, has written. */
const freshDbId = (): string => `of:sqlite-guards-${crypto.randomUUID()}`;

/** A `sqlite` operation writing to `db`. */
const write = (db: SqliteDbRef): Operation => ({
  op: "sqlite",
  db,
  sql: "INSERT INTO notes (body) VALUES ('hello')",
});

describe("server", () => {
  describe("sqliteQuery()", () => {
    /** Runs `body` against a mounted session on a memory store. */
    const withSession = async (
      name: string,
      body: (session: {
        transact: (operation: Operation) => Promise<unknown>;
        query: (db: SqliteDbRef, sql: string) => Promise<unknown>;
      }) => Promise<void>,
    ): Promise<void> => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL(`memory://memory-v2-sqlite-guards-${name}`),
        subscriptionRefreshDelayMs: "manual",
      });
      const client = await connect({ transport: loopback(server) });
      try {
        const session = await client.mount(
          SPACE,
          {},
          testSessionOpenAuthFactory,
        );
        let localSeq = 1;
        await body({
          transact: (operation) =>
            session.transact({
              localSeq: localSeq++,
              reads: { confirmed: [], pending: [] },
              operations: [operation],
            }),
          query: async (db, sql) => (await session.sqliteQuery(db, sql)).rows,
        });
      } finally {
        await client.close();
        await server.close();
      }
    };

    it("returns no rows for a declared table whose dotted name the file does not have yet", async () => {
      await withSession("declared-dotted", async ({ transact, query }) => {
        const id = freshDbId();
        await transact(write({ id, tables: { notes } }));
        const evolved = { id, tables: { notes, "my.notes": notes } };
        expect(await query(evolved, 'SELECT * FROM "my.notes"')).toEqual([]);
        expect(await query(evolved, "SELECT body FROM notes")).toEqual([
          { body: "hello" },
        ]);
      });
    });

    it("throws the missing-table error for an undeclared table", async () => {
      await withSession("undeclared", async ({ transact, query }) => {
        const id = freshDbId();
        await transact(write({ id, tables: { notes } }));
        await expect(
          query({ id, tables: { notes } }, 'SELECT * FROM "other.notes"'),
        ).rejects.toThrow("no such table: other.notes");
        await expect(query({ id }, "SELECT * FROM absent")).rejects.toThrow(
          "no such table: absent",
        );
        // A table literally named `main.notes` is not the declared `notes`:
        // the statement guard refuses a schema-qualified reference, so a
        // dotted name SQLite reports is always the table's whole name.
        await expect(
          query({ id, tables: { notes } }, 'SELECT * FROM "main.notes"'),
        ).rejects.toThrow("no such table: main.notes");
      });
    });

    it("throws a failure to examine the database file, which a missing file is not", async () => {
      // A memory store keeps its cell databases under `TMPDIR`. Naming a
      // regular file there makes every cell database path one whose parent
      // is not a directory.

      await withSession("unreadable-file", async ({ query }) => {
        const db = { id: freshDbId(), tables: { notes } };
        expect(await query(db, "SELECT * FROM notes")).toEqual([]);
        const notADirectory = Deno.makeTempFileSync();
        const tmpdir = Deno.env.get("TMPDIR");
        Deno.env.set("TMPDIR", notADirectory);
        try {
          await expect(query(db, "SELECT * FROM notes")).rejects.toThrow(
            "Not a directory",
          );
        } finally {
          if (tmpdir === undefined) Deno.env.delete("TMPDIR");
          else Deno.env.set("TMPDIR", tmpdir);
          Deno.removeSync(notADirectory);
        }
      });
    });
  });

  describe("registerDiskSource()", () => {
    /** Runs `body` against a server on a file store in a scratch directory. */
    const withFileStore = async (
      body: (server: Server, storeDir: string) => Promise<void>,
    ): Promise<void> => {
      const root = Deno.makeTempDirSync();
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: toFileUrl(`${root}/store/`),
        subscriptionRefreshDelayMs: "manual",
      });
      try {
        const engine = await server.engineForSpace(SPACE);
        await body(server, dirname(fromFileUrl(engine.url)));
      } finally {
        await server.close();
        Deno.removeSync(root, { recursive: true });
      }
    };

    it("throws for a path inside the store directory", async () => {
      await withFileStore(async (server, storeDir) => {
        const inside = join(storeDir, "planted.sqlite");
        Deno.writeFileSync(inside, new Uint8Array());
        await expect(server.registerDiskSource(SPACE, "of:inside", inside))
          .rejects.toThrow(
            "disk source path may not resolve inside the store directory",
          );
      });
    });

    it("throws for a file named as an internal cell database", async () => {
      await withFileStore(async (server, storeDir) => {
        const outside = Deno.makeTempDirSync();
        try {
          const cellDb = join(outside, "cell-planted.sqlite");
          Deno.writeFileSync(cellDb, new Uint8Array());
          await expect(server.registerDiskSource(SPACE, "of:cell", cellDb))
            .rejects.toThrow(
              "disk source path may not be an internal cell-db file",
            );
          expect(storeDir).not.toBe(outside);
        } finally {
          Deno.removeSync(outside, { recursive: true });
        }
      });
    });

    it("registers an ordinary file outside the store directory", async () => {
      await withFileStore(async (server) => {
        const outside = Deno.makeTempDirSync();
        try {
          const source = join(outside, "source.sqlite");
          Deno.writeFileSync(source, new Uint8Array());
          const engines: Engine.Engine[] = [];
          await server.registerDiskSource(
            SPACE,
            "of:source",
            source,
            (engine) => engines.push(engine),
          );
          expect(engines).toHaveLength(1);
        } finally {
          Deno.removeSync(outside, { recursive: true });
        }
      });
    });
  });

  describe("attachWaveCommitSqliteDbs()", () => {
    /** Runs `body` against the engine of a server on a memory store. */
    const withEngine = async (
      name: string,
      body: (server: Server, engine: Engine.Engine) => void | Promise<void>,
    ): Promise<void> => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL(`memory://memory-v2-sqlite-guards-wave-${name}`),
        subscriptionRefreshDelayMs: "manual",
      });
      try {
        await body(server, await server.engineForSpace(SPACE));
      } finally {
        await server.close();
      }
    };

    /** The scope key `space` for each of `operations`. */
    const spaceKeys = (operations: readonly Operation[]) =>
      new Map(operations.map((_, index) => [index, "space"]));

    it("throws for a database declaring more tables than the limit", async () => {
      await withEngine("too-many-tables", (server, engine) => {
        const tables = Object.fromEntries(
          Array.from({ length: 257 }, (_, index) => [`t${index}`, notes]),
        );
        const operations = [write({ id: freshDbId(), tables })];
        expect(() =>
          server.attachWaveCommitSqliteDbs(
            engine,
            SPACE,
            operations,
            spaceKeys(operations),
          )
        ).toThrow("sqlite db declares too many tables");
      });
    });

    it("throws for a database declaring a scope that does not exist", async () => {
      await withEngine("invalid-scope", (server, engine) => {
        // As a `transact` commit's loose parse delivers it, unchecked.
        const db: SqliteDbRef = JSON.parse(
          JSON.stringify({
            id: freshDbId(),
            tables: { notes },
            scope: "galaxy",
          }),
        );
        const operations = [write(db)];
        expect(() =>
          server.attachWaveCommitSqliteDbs(
            engine,
            SPACE,
            operations,
            spaceKeys(operations),
          )
        ).toThrow("sqlite op declares an invalid scope");
      });
    });

    it("throws for one database written under two scope keys", async () => {
      await withEngine("conflicting-scope", (server, engine) => {
        const db = { id: freshDbId(), tables: { notes } };
        const operations = [write(db), write(db)];
        expect(() =>
          server.attachWaveCommitSqliteDbs(
            engine,
            SPACE,
            operations,
            new Map([[0, "space"], [1, "user:did:key:z6Mk-someone"]]),
          )
        ).toThrow(
          "conflicting scope for the same sqlite database in one commit",
        );
        // Under one scope key, the same database twice is one attachment.
        const { attachments, detach } = server.attachWaveCommitSqliteDbs(
          engine,
          SPACE,
          operations,
          spaceKeys(operations),
        );
        expect([...attachments.keys()]).toEqual([db.id]);
        detach();
      });
    });

    it("throws for a commit writing two databases", async () => {
      await withEngine("two-databases", (server, engine) => {
        const operations = [
          write({ id: freshDbId(), tables: { notes } }),
          write({ id: freshDbId(), tables: { notes } }),
        ];
        expect(() =>
          server.attachWaveCommitSqliteDbs(
            engine,
            SPACE,
            operations,
            spaceKeys(operations),
          )
        ).toThrow("a commit may write to at most one sqlite database");
      });
    });

    it("throws the table error when detaching the failed attachment fails too", async () => {
      await withEngine("detach-fails", (server, engine) => {
        const detaches: string[] = [];
        const database = new Proxy(engine.database, {
          get(target, property) {
            if (property === "exec") {
              return (sql: string, ...args: unknown[]) => {
                if (sql.startsWith("DETACH")) {
                  detaches.push(sql);
                  throw new Error("database is locked");
                }
                return target.exec(sql, ...(args as []));
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const operations = [write({
          id: freshDbId(),
          tables: { empty: { type: "object", properties: {} } },
        })];
        expect(() =>
          server.attachWaveCommitSqliteDbs(
            { ...engine, database },
            SPACE,
            operations,
            spaceKeys(operations),
          )
        ).toThrow('table "empty" must declare at least one column');
        expect(detaches).toHaveLength(1);
      });
    });
  });
});

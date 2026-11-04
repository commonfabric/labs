import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";

import {
  checkRewrittenStore,
  entryExists,
  fileSize,
  preflightOfflineStore,
} from "../v2/offline-store.ts";

/** A refusal as the rail reports one, for these tests to tell apart. */
class Refused extends Error {}

describe("offline-store", () => {
  let dir: string;
  let store: string;
  let out: string;
  const opened: Database[] = [];

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "offline-store-" });
    store = `${dir}/space.sqlite`;
    out = `${dir}/space.out.sqlite`;
  });
  afterEach(async () => {
    for (const db of opened) db.close();
    opened.length = 0;
    await Deno.remove(dir, { recursive: true });
  });

  /** Writes a store in `mode` holding one row, and closes it. */
  const write = (mode: "wal" | "delete") => {
    const db = new Database(store);
    db.exec(`PRAGMA journal_mode = ${mode}`);
    db.exec(`CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1)`);
    db.close();
  };

  /** Opens another connection to the store, which the test closes. */
  const hold = (): Database => {
    const db = new Database(store);
    opened.push(db);
    return db;
  };

  const preflight = () =>
    preflightOfflineStore(store, out, (reason) => new Refused(reason));

  describe("preflightOfflineStore()", () => {
    it("passes a store nothing holds, and leaves it as it was, with no companion beside it", () => {
      write("wal");
      const before = Deno.readFileSync(store);

      preflight();

      expect(Deno.readFileSync(store)).toEqual(before);
      for (const companion of ["-wal", "-shm", "-journal"]) {
        expect(entryExists(`${store}${companion}`)).toBe(false);
      }
    });

    it("refuses a WAL-mode store another connection holds open, even idle", () => {
      write("wal");
      hold().prepare("SELECT * FROM t").all();

      expect(preflight).toThrow(Refused);
      expect(preflight).toThrow("is held by another connection");
    });

    it("refuses a rollback-mode store another connection is reading", () => {
      write("delete");
      const reader = hold();
      reader.exec("BEGIN");
      reader.prepare("SELECT * FROM t").all();

      expect(preflight).toThrow("is held by another connection");
    });

    it("passes a rollback-mode store an idle connection holds, which holds no lock to see", () => {
      // The one holder the rail cannot see: the procedure, which runs the
      // reap on a copy of a backup, is what keeps it out.

      write("delete");
      hold().prepare("SELECT * FROM t").all();

      preflight();
    });

    it("refuses a store with a log beside it that is not empty", () => {
      write("delete");
      Deno.writeTextFileSync(`${store}-journal`, "x");

      expect(preflight).toThrow(`${store}-journal is not empty`);
    });

    it("refuses a missing store, and a result path that exists", () => {
      expect(preflight).toThrow(`no store at ${store}`);
      write("delete");
      Deno.writeTextFileSync(out, "");

      expect(preflight).toThrow("the result is never overwritten");
      expect(fileSize(out)).toBe(0);
    });
  });

  describe("checkRewrittenStore()", () => {
    it("passes a store whose checks hold", () => {
      write("wal");
      const db = hold();

      checkRewrittenStore(db);
    });

    it("refuses when another connection's read keeps the log from being checkpointed", () => {
      write("wal");
      const writer = hold();
      const reader = hold();
      reader.exec("BEGIN");
      reader.prepare("SELECT * FROM t").all();
      writer.exec("INSERT INTO t VALUES (2)");

      expect(() => checkRewrittenStore(writer)).toThrow(
        "wal_checkpoint(TRUNCATE) could not finish",
      );
    });

    it("refuses a store whose foreign keys do not hold", () => {
      write("delete");
      const db = hold();
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec(
        `CREATE TABLE parent (id INTEGER PRIMARY KEY);
         CREATE TABLE child (p INTEGER REFERENCES parent(id));
         INSERT INTO child VALUES (7)`,
      );

      expect(() => checkRewrittenStore(db)).toThrow(
        "PRAGMA foreign_key_check reports 1 violation(s)",
      );
    });
  });
});

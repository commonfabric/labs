import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Database } from "@db/sqlite";

import { prepare } from "../../v2/prepared-statement.ts";

describe("prepare()", () => {
  let database: Database;

  beforeEach(() => {
    database = new Database(":memory:");
    database.exec(`
      CREATE TABLE pair (name TEXT PRIMARY KEY, left INTEGER, right INTEGER);
      INSERT INTO pair VALUES ('a', 1, 2), ('b', 3, 4), ('c', 5, NULL);
    `);
  });

  afterEach(() => {
    database.close();
  });

  describe("get()", () => {
    it("binds each named parameter wherever the statement uses it", () => {
      const statement = prepare(
        database,
        `SELECT name, left, right FROM pair
         WHERE left >= :bound AND right >= :bound AND name <> :skip`,
      );

      expect(statement.get({ skip: "a", bound: 1 })).toEqual({
        name: "b",
        left: 3,
        right: 4,
      });
      expect(statement.get({ skip: "b", bound: 3 })).toBeUndefined();
    });

    it("binds NULL for a parameter the execution leaves out", () => {
      const statement = prepare(
        database,
        `SELECT name FROM pair WHERE right IS :right`,
      );

      expect(statement.get()).toEqual({ name: "c" });
      expect(statement.get({ right: 2 })).toEqual({ name: "a" });
    });

    it("returns a new row each time", () => {
      const statement = prepare(database, `SELECT COUNT(*) AS count FROM pair`);

      const first = statement.get();
      const second = statement.get();
      expect(first).toEqual({ count: 3 });
      expect(second).not.toBe(first);
    });

    it("binds a parameter whatever prefix the statement names it with", () => {
      const statement = prepare(
        database,
        `SELECT name FROM pair WHERE left = @left AND right = $right`,
      );

      expect(statement.get({ left: 3, right: 4 })).toEqual({ name: "b" });
      expect(statement.get({ left: 3, right: 2 })).toBeUndefined();
    });

    it("returns a BLOB as bytes and an integer as a number", () => {
      database.exec(`CREATE TABLE blob (id INTEGER, data BLOB)`);
      prepare(database, `INSERT INTO blob VALUES (:id, :data)`).run({
        id: 7,
        data: new Uint8Array([0, 1, 255]),
      });

      expect(prepare(database, `SELECT id, data FROM blob`).get()).toEqual({
        id: 7,
        data: new Uint8Array([0, 1, 255]),
      });
    });
  });

  describe("errors", () => {
    it("throws for a parameter the statement does not have, whichever way it runs", () => {
      const statement = prepare(
        database,
        `SELECT name FROM pair WHERE left = :left`,
      );
      const parameters = { left: 1, right: 2 };

      expect(() => statement.get(parameters)).toThrow(
        "No such parameter: right",
      );
      expect(() => statement.all(parameters)).toThrow(
        "No such parameter: right",
      );
      expect(() => statement.iter(parameters)).toThrow(
        "No such parameter: right",
      );
      expect(() => statement.run(parameters)).toThrow(
        "No such parameter: right",
      );
      expect(statement.get({ left: 1 })).toEqual({ name: "a" });
    });

    it("throws for any parameter given to a statement that has none", () => {
      const statement = prepare(database, `SELECT COUNT(*) AS count FROM pair`);

      expect(() => statement.get({ left: 1 })).toThrow(
        "No such parameter: left",
      );
    });

    it("throws at prepare for one name written with two prefixes", () => {
      expect(() =>
        prepare(database, `SELECT name FROM pair WHERE left = :n OR right = $n`)
      ).toThrow("Parameters share a name: n, n");
    });
  });

  describe("all() and iter()", () => {
    it("return every row, in order, by column name", () => {
      const statement = prepare(
        database,
        `SELECT name, left FROM pair WHERE left > :left ORDER BY name`,
      );
      const expected = [{ name: "b", left: 3 }, { name: "c", left: 5 }];

      expect(statement.all({ left: 1 })).toEqual(expected);
      expect([...statement.iter({ left: 1 })]).toEqual(expected);
      expect(statement.all({ left: 5 })).toEqual([]);
    });
  });

  describe("run()", () => {
    it("returns the number of rows it changed", () => {
      const statement = prepare(
        database,
        `UPDATE pair SET right = :right WHERE right IS NULL OR right < :right`,
      );

      expect(statement.run({ right: 3 })).toBe(2);
      expect(statement.run({ right: 3 })).toBe(0);
    });
  });
});

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { close, type Engine, open } from "../../v2/engine.ts";

describe("engine", () => {
  // The engine prepares a statement the first time it is asked for one and
  // keeps it, so every caller with the same SQL shares one statement.

  let engine: Engine;

  beforeEach(async () => {
    engine = await open({ url: new URL("memory:engine-statements") });
  });

  afterEach(() => {
    close(engine);
  });

  describe("prepare()", () => {
    it("returns the same statement each time it is given the same SQL", () => {
      const sql = "SELECT :a AS a";
      expect(engine.prepare(sql)).toBe(engine.prepare(sql));
      expect(engine.prepare("SELECT :b AS b")).not.toBe(engine.prepare(sql));
      expect(engine.prepare(sql).get({ a: 1 })).toEqual({ a: 1 });
    });
  });

  describe("statement()", () => {
    it("returns the same statement each time it is given the same name", () => {
      expect(engine.statement("selectServerSeq")).toBe(
        engine.statement("selectServerSeq"),
      );
      expect(engine.statement("selectServerSeq")).not.toBe(
        engine.statement("selectNextSeq"),
      );
    });
  });
});

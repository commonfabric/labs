// A rejection's conflict descriptor names one entity, which a retrier pulls
// before re-running. Most commits address at least one entity, so the first
// operation names it. A commit of nothing but SQLite writes addresses none —
// a SQLite operation carries a database reference and a statement, never an
// entity identifier — and the descriptor falls back to a placeholder the
// retrier compares against rather than pulls.

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { ClientCommit, Operation } from "@commonfabric/memory/v2";

import {
  conflictEntityOf,
  UNKNOWN_CONFLICT_ENTITY,
} from "../src/storage/v2.ts";

const commitOf = (...operations: Operation[]): ClientCommit => ({
  localSeq: 0,
  reads: { confirmed: [], pending: [] },
  operations,
});

const sqliteWrite: Operation = {
  op: "sqlite",
  db: { id: "of:notes-db", scope: "space" },
  sql: "INSERT INTO note (body) VALUES (?)",
  params: ["hello"],
} as Operation;

describe("conflictEntityOf()", () => {
  it("returns the entity of the only operation", () => {
    const commit = commitOf({ op: "delete", id: "of:sole" });

    expect(conflictEntityOf(commit)).toBe("of:sole");
  });

  it("returns the entity of the first operation that addresses one", () => {
    const commit = commitOf(
      sqliteWrite,
      { op: "set", id: "of:second", value: { value: 1 } },
      { op: "set", id: "of:third", value: { value: 2 } },
    );

    expect(conflictEntityOf(commit)).toBe("of:second");
  });

  it("returns the placeholder for a commit of nothing but SQLite writes", () => {
    const commit = commitOf(sqliteWrite, sqliteWrite);

    expect(conflictEntityOf(commit)).toBe(UNKNOWN_CONFLICT_ENTITY);
  });

  it("returns the placeholder for a commit carrying no operations", () => {
    expect(conflictEntityOf(commitOf())).toBe(UNKNOWN_CONFLICT_ENTITY);
  });
});

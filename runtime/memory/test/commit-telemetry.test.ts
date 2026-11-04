import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { ClientCommit, Operation } from "../v2.ts";
import { classifyCommitTelemetry } from "../v2/commit-telemetry.ts";

const commit = (
  operations: Operation[] = [],
  extra: Partial<ClientCommit> = {},
): ClientCommit => ({
  localSeq: 1,
  reads: { confirmed: [], pending: [] },
  operations,
  ...extra,
});

const semanticOperation: Operation = {
  op: "set",
  id: "of:telemetry-test",
  value: { value: "hello" },
};

const sqliteOperation: Operation = {
  op: "sqlite",
  db: { id: "of:telemetry-db" },
  sql: "CREATE TABLE example (value TEXT)",
};

describe("commit-telemetry", () => {
  // Server-execution v2 stage C.2 removed the scheduler-observation wire
  // fields, so no commit can classify as `scheduler_observation` anymore;
  // the kind stays in the union so dashboards keep their shape.

  it("returns `semantic` for non-SQLite entity operations", () => {
    expect(classifyCommitTelemetry(commit([semanticOperation]))).toEqual({
      kind: "semantic",
      entityCount: 1,
      schedulerObservationCount: 0,
      sqliteOperationCount: 0,
    });
  });

  it("returns `sqlite` for SQLite-only requests", () => {
    expect(classifyCommitTelemetry(commit([sqliteOperation]))).toEqual({
      kind: "sqlite",
      entityCount: 0,
      schedulerObservationCount: 0,
      sqliteOperationCount: 1,
    });
  });

  it("returns `mixed` when several operation classes are present", () => {
    expect(classifyCommitTelemetry(
      commit([semanticOperation, sqliteOperation]),
    )).toEqual({
      kind: "mixed",
      entityCount: 1,
      schedulerObservationCount: 0,
      sqliteOperationCount: 1,
    });
  });

  it("returns `precondition` for precondition-only requests", () => {
    expect(classifyCommitTelemetry(commit([], {
      preconditions: [{ kind: "entity-absent", id: "of:missing" }],
    }))).toEqual({
      kind: "precondition",
      entityCount: 0,
      schedulerObservationCount: 0,
      sqliteOperationCount: 0,
    });
  });

  it("uses preconditions only as a fallback category", () => {
    expect(classifyCommitTelemetry(commit([semanticOperation], {
      preconditions: [{ kind: "entity-absent", id: "of:missing" }],
    }))).toEqual({
      kind: "semantic",
      entityCount: 1,
      schedulerObservationCount: 0,
      sqliteOperationCount: 0,
    });
  });

  it("returns `empty` for requests without classifiable content", () => {
    expect(classifyCommitTelemetry(commit())).toEqual({
      kind: "empty",
      entityCount: 0,
      schedulerObservationCount: 0,
      sqliteOperationCount: 0,
    });
  });
});

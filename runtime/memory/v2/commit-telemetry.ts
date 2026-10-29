import type { ClientCommit } from "../v2.ts";

/** Stable categories used to separate memory transaction traffic in telemetry. */
export type CommitTelemetryKind =
  | "semantic"
  | "scheduler_observation"
  | "sqlite"
  | "mixed"
  | "precondition"
  | "empty";

/** Counts and category attached to a `memory.transact` span. */
export interface CommitTelemetryClassification {
  kind: CommitTelemetryKind;
  entityCount: number;
  schedulerObservationCount: number;
  sqliteOperationCount: number;
}

/**
 * Classify the requested commit without changing validation or persistence.
 *
 * This deliberately describes the wire request, so rejected/conflicting
 * attempts carry the same dimensions as successful attempts. `entityCount`
 * retains the existing meaning: non-SQLite entity operations.
 */
export const classifyCommitTelemetry = (
  commit: ClientCommit,
): CommitTelemetryClassification => {
  const entityCount =
    commit.operations.filter((operation) => operation.op !== "sqlite").length;
  const sqliteOperationCount = commit.operations.length - entityCount;
  // Server-execution v2 stage C.2 removed the persisted scheduler-observation
  // wire fields (the v2 basis index replaced them), so a commit can no longer
  // carry any. Kept as a dimension so dashboards keep their shape.
  const schedulerObservationCount = 0;
  const componentCount = Number(entityCount > 0) +
    Number(sqliteOperationCount > 0) +
    Number(schedulerObservationCount > 0);

  const kind: CommitTelemetryKind = componentCount > 1
    ? "mixed"
    : entityCount > 0
    ? "semantic"
    : schedulerObservationCount > 0
    ? "scheduler_observation"
    : sqliteOperationCount > 0
    ? "sqlite"
    : (commit.preconditions?.length ?? 0) > 0
    ? "precondition"
    : "empty";

  return {
    kind,
    entityCount,
    schedulerObservationCount,
    sqliteOperationCount,
  };
};

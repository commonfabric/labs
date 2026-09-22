import type { FabricValue } from "@commonfabric/data-model";
import { parsePointer } from "@commonfabric/memory/v2/path";

import type { SpaceDb } from "./db.ts";
import { tableNames } from "./db.ts";
import { decodeStored } from "./decode.ts";
import { hashEntityValue } from "./fingerprint.ts";
import { reconstructDocument, selectAtPath } from "./reconstruct.ts";

const DEFAULT_FIELD_LIMIT = 50;
const DEFAULT_HISTORY_LIMIT = 100;
const MAX_LIMIT = 1_000;

type OperationFieldRow = {
  branch: string;
  id: string;
  scope_key: string;
  path: string;
  epoch: number;
  codec: string;
  version: number;
  baseline_hash: string;
  materialized: string;
  active: number;
  commit_seq: number;
};

type IntegratedRow = {
  epoch: number;
  version: number;
  op_id: string;
  submission_id: string;
  payload: string;
  commit_seq: number;
};

type SubmissionRow = {
  epoch: number;
  submission_id: string;
  codec: string;
  base_version: number;
  submitted_payload: string;
  integrated_from: number;
  integrated_to: number;
  integrated_payload: string;
  commit_seq: number;
  op_index: number;
};

type CheckpointRow = {
  epoch: number;
  version: number;
  materialized: string;
  commit_seq: number;
};

export interface OperationInspectionOptions {
  id?: string;
  branch?: string;
  scope?: string;
  fieldLimit?: number;
  historyLimit?: number;
  submissionAfterSeq?: number;
}

export interface OperationFieldInspection {
  address: {
    branch: string;
    id: string;
    scope: string;
    path: string[];
    pathPointer: string;
  };
  active: boolean;
  codec: string;
  cursor: { epoch: number; version: number };
  baselineHash: string;
  materialized: unknown;
  commitSeq: number;
  retainedFrom: { epoch: number; version: number };
  submissions: Array<{
    epoch: number;
    submissionId: string;
    codec: string;
    baseVersion: number;
    submitted: unknown;
    integratedFrom: number;
    integratedTo: number;
    integrated: unknown;
    commitSeq: number;
    operationIndex: number;
  }>;
  integrated: Array<{
    epoch: number;
    version: number;
    opId: string;
    submissionId: string;
    payload: unknown;
    commitSeq: number;
  }>;
  checkpoints: Array<{
    epoch: number;
    version: number;
    materialized: unknown;
    commitSeq: number;
    matchesCurrentHead: boolean | null;
  }>;
  pagination: {
    historyLimit: number;
    submissionsTruncated: boolean;
    nextSubmissionAfterSeq: number | null;
    integratedTruncated: boolean;
  };
  consistency: {
    baselineCheckpointPresent: boolean;
    retainedSuffixContiguous: boolean;
    ordinaryMaterializedMatches: boolean | null;
    currentCheckpointMatches: boolean | null;
    healthy: boolean;
  };
}

export interface OperationInspection {
  available: boolean;
  fieldLimit: number;
  fieldsTruncated: boolean;
  fields: OperationFieldInspection[];
}

const boundedLimit = (value: number | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_LIMIT) {
    throw new Error(
      `operation inspection limits must be between 1 and ${MAX_LIMIT}`,
    );
  }
  return value;
};

const decode = (value: string): FabricValue => {
  try {
    return decodeStored(value);
  } catch (error) {
    return {
      decodeError: error instanceof Error ? error.message : String(error),
      stored: value,
    };
  }
};

const valuesMatch = (left: FabricValue, right: FabricValue): boolean => {
  const leftHash = hashEntityValue(left);
  const rightHash = hashEntityValue(right);
  return "hash" in leftHash && "hash" in rightHash &&
    leftHash.hash === rightHash.hash;
};

/** Inspect durable collaborative operation state without opening a live Engine. */
export function inspectOperationFields(
  space: SpaceDb,
  options: OperationInspectionOptions = {},
): OperationInspection {
  const fieldLimit = boundedLimit(options.fieldLimit, DEFAULT_FIELD_LIMIT);
  const historyLimit = boundedLimit(
    options.historyLimit,
    DEFAULT_HISTORY_LIMIT,
  );
  const tables = new Set(tableNames(space.db));
  if (
    !tables.has("op_field_epoch") || !tables.has("op_submission") ||
    !tables.has("op_integrated") || !tables.has("op_checkpoint")
  ) {
    return { available: false, fieldLimit, fieldsTruncated: false, fields: [] };
  }

  const filters = ["branch = :branch"];
  const params: Record<string, string | number> = {
    branch: options.branch ?? "",
    limit: fieldLimit + 1,
  };
  if (options.id !== undefined) {
    filters.push("id = :id");
    params.id = options.id;
  }
  if (options.scope !== undefined) {
    filters.push("scope_key = :scope_key");
    params.scope_key = options.scope;
  }
  const rows = space.db.prepare(`
    SELECT branch, id, scope_key, path, epoch, codec, version, baseline_hash,
           materialized, active, commit_seq
    FROM op_field_epoch
    WHERE ${filters.join(" AND ")}
    ORDER BY id, scope_key, path
    LIMIT :limit
  `).all(params) as OperationFieldRow[];
  const fieldsTruncated = rows.length > fieldLimit;

  return {
    available: true,
    fieldLimit,
    fieldsTruncated,
    fields: rows.slice(0, fieldLimit).map((field) =>
      inspectOperationField(space, field, {
        historyLimit,
        submissionAfterSeq: options.submissionAfterSeq ?? 0,
      })
    ),
  };
}

function inspectOperationField(
  space: SpaceDb,
  field: OperationFieldRow,
  options: { historyLimit: number; submissionAfterSeq: number },
): OperationFieldInspection {
  const address = {
    branch: field.branch,
    id: field.id,
    scope_key: field.scope_key,
    path: field.path,
  };
  let path: string[] = [];
  let pathValid = true;
  try {
    path = parsePointer(field.path);
  } catch {
    pathValid = false;
    // Consistency is reported as unhealthy below; keep the corrupt pointer in
    // `pathPointer` so an operator can identify the exact durable row.
  }

  const integratedRows = space.db.prepare(`
    SELECT epoch, version, op_id, submission_id, payload, commit_seq
    FROM op_integrated
    WHERE branch = :branch AND id = :id AND scope_key = :scope_key
      AND path = :path
    ORDER BY epoch, version
    LIMIT :limit
  `).all({
    ...address,
    limit: options.historyLimit + 1,
  }) as IntegratedRow[];
  const integratedTruncated = integratedRows.length > options.historyLimit;
  const visibleIntegrated = integratedRows.slice(0, options.historyLimit);

  const floorRow = space.db.prepare(`
    SELECT MIN(version) AS version
    FROM op_integrated
    WHERE branch = :branch AND id = :id AND scope_key = :scope_key
      AND path = :path AND epoch = :epoch
  `).get({ ...address, epoch: field.epoch }) as { version: number | null };
  const retainedVersion = floorRow.version === null
    ? field.version
    : floorRow.version - 1;
  const retainedRows = space.db.prepare(`
    SELECT version
    FROM op_integrated
    WHERE branch = :branch AND id = :id AND scope_key = :scope_key
      AND path = :path AND epoch = :epoch AND version > :retained_version
    ORDER BY version
  `).all({
    ...address,
    epoch: field.epoch,
    retained_version: retainedVersion,
  }) as Array<{ version: number }>;
  const retainedSuffixContiguous =
    retainedRows.length === field.version - retainedVersion &&
    retainedRows.every((row, index) =>
      row.version === retainedVersion + index + 1
    );

  let submissionRows = space.db.prepare(`
    SELECT epoch, submission_id, codec, base_version, submitted_payload,
           integrated_from, integrated_to, integrated_payload, commit_seq,
           op_index
    FROM op_submission
    WHERE branch = :branch AND id = :id AND scope_key = :scope_key
      AND path = :path AND commit_seq > :after_seq
    ORDER BY commit_seq, op_index
    LIMIT :limit
  `).all({
    ...address,
    after_seq: options.submissionAfterSeq,
    limit: options.historyLimit + 1,
  }) as SubmissionRow[];
  let submissionsTruncated = submissionRows.length > options.historyLimit;
  if (
    submissionsTruncated &&
    submissionRows[options.historyLimit - 1].commit_seq ===
      submissionRows[options.historyLimit].commit_seq
  ) {
    const boundarySeq = submissionRows[options.historyLimit - 1].commit_seq;
    submissionRows = space.db.prepare(`
      SELECT epoch, submission_id, codec, base_version, submitted_payload,
             integrated_from, integrated_to, integrated_payload, commit_seq,
             op_index
      FROM op_submission
      WHERE branch = :branch AND id = :id AND scope_key = :scope_key
        AND path = :path AND commit_seq > :after_seq
        AND commit_seq <= :boundary_seq
      ORDER BY commit_seq, op_index
    `).all({
      ...address,
      after_seq: options.submissionAfterSeq,
      boundary_seq: boundarySeq,
    }) as SubmissionRow[];
    submissionsTruncated = space.db.prepare(`
      SELECT 1
      FROM op_submission
      WHERE branch = :branch AND id = :id AND scope_key = :scope_key
        AND path = :path AND commit_seq > :boundary_seq
      LIMIT 1
    `).get({ ...address, boundary_seq: boundarySeq }) !== undefined;
  }
  const visibleSubmissions = submissionsTruncated &&
      submissionRows.length > options.historyLimit &&
      submissionRows[options.historyLimit - 1].commit_seq !==
        submissionRows[options.historyLimit].commit_seq
    ? submissionRows.slice(0, options.historyLimit)
    : submissionRows;

  const checkpointRows = space.db.prepare(`
    SELECT epoch, version, materialized, commit_seq
    FROM op_checkpoint
    WHERE branch = :branch AND id = :id AND scope_key = :scope_key
      AND path = :path
    ORDER BY epoch, version
  `).all(address) as CheckpointRow[];
  const materialized = decode(field.materialized);
  const currentCheckpoint = checkpointRows.find((row) =>
    row.epoch === field.epoch && row.version === field.version
  );
  const currentCheckpointMatches = currentCheckpoint === undefined
    ? null
    : valuesMatch(materialized, decode(currentCheckpoint.materialized));
  const baselineCheckpointPresent = checkpointRows.some((row) =>
    row.epoch === field.epoch && row.version === 0
  );

  const document = reconstructDocument(space, {
    id: field.id,
    scope: field.scope_key,
    branch: field.branch,
  });
  const ordinary = document == null || field.active !== 1
    ? null
    : selectAtPath(document.value ?? null, path);
  const ordinaryMaterializedMatches = ordinary === null || !ordinary.found
    ? null
    : valuesMatch(materialized, ordinary.value);
  const healthy = pathValid && baselineCheckpointPresent &&
    retainedSuffixContiguous &&
    ordinaryMaterializedMatches !== false &&
    currentCheckpointMatches !== false;

  return {
    address: {
      branch: field.branch,
      id: field.id,
      scope: field.scope_key,
      path,
      pathPointer: field.path,
    },
    active: field.active === 1,
    codec: field.codec,
    cursor: { epoch: field.epoch, version: field.version },
    baselineHash: field.baseline_hash,
    materialized,
    commitSeq: field.commit_seq,
    retainedFrom: { epoch: field.epoch, version: retainedVersion },
    submissions: visibleSubmissions.map((row) => ({
      epoch: row.epoch,
      submissionId: row.submission_id,
      codec: row.codec,
      baseVersion: row.base_version,
      submitted: decode(row.submitted_payload),
      integratedFrom: row.integrated_from,
      integratedTo: row.integrated_to,
      integrated: decode(row.integrated_payload),
      commitSeq: row.commit_seq,
      operationIndex: row.op_index,
    })),
    integrated: visibleIntegrated.map((row) => ({
      epoch: row.epoch,
      version: row.version,
      opId: row.op_id,
      submissionId: row.submission_id,
      payload: decode(row.payload),
      commitSeq: row.commit_seq,
    })),
    checkpoints: checkpointRows.map((row) => ({
      epoch: row.epoch,
      version: row.version,
      materialized: decode(row.materialized),
      commitSeq: row.commit_seq,
      matchesCurrentHead: row.epoch === field.epoch &&
          row.version === field.version
        ? currentCheckpointMatches
        : null,
    })),
    pagination: {
      historyLimit: options.historyLimit,
      submissionsTruncated,
      nextSubmissionAfterSeq: submissionsTruncated
        ? visibleSubmissions.at(-1)?.commit_seq ?? null
        : null,
      integratedTruncated,
    },
    consistency: {
      baselineCheckpointPresent,
      retainedSuffixContiguous,
      ordinaryMaterializedMatches,
      currentCheckpointMatches,
      healthy,
    },
  };
}

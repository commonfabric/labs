import { isLinkRef, linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { canonicalJson, hashFabricValue } from "./canonical-json.ts";
import { stableFabricValue } from "./stable-fabric-value.ts";

type PlannedLeaf = { kind: "leaf"; value: unknown };
type PlannedArray = { kind: "array"; items: StableArrayCellPlan[] };
type PlannedRecord = {
  kind: "record";
  entries: Array<[string, StableArrayCellPlan]>;
};
type PlannedCell = {
  kind: "cell";
  cause: StableArrayElementCause;
  value: StableArrayCellPlan;
};

/** A value tree annotated with deterministic causes for every array element. */
export type StableArrayCellPlan =
  | PlannedLeaf
  | PlannedArray
  | PlannedRecord
  | PlannedCell;

export interface StableArrayElementCause {
  agentConnector: "array-element";
  scope: unknown;
  path: string[];
  identity: Record<string, unknown>;
  collisionHash?: string;
  duplicate?: number;
}

export type StableArrayCellMaterializer = (
  cause: unknown,
  value: unknown,
) => unknown;

type AnalyzedLeaf = {
  kind: "leaf";
  value: unknown;
  contentHash: string;
};
type AnalyzedArray = {
  kind: "array";
  value: unknown[];
  items: AnalyzedValue[];
  contentHash: string;
};
type AnalyzedRecord = {
  kind: "record";
  value: Record<string, unknown>;
  entries: Array<[string, AnalyzedValue]>;
  contentHash: string;
};
type AnalyzedValue = AnalyzedLeaf | AnalyzedArray | AnalyzedRecord;

const PRIMARY_IDENTITY_FIELDS = [
  "key",
  "id",
  "uuid",
  "commandId",
  "messageId",
  "toolCallId",
  "toolUseId",
] as const;

const SECONDARY_IDENTITY_FIELDS = [
  "nativeSessionId",
  "sessionId",
  "part",
  "contentHash",
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isObjectNotArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function usableIdentityValue(value: unknown): value is string | number {
  return (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isFinite(value));
}

function identityFor(value: AnalyzedValue): Record<string, unknown> {
  const source = value.value;
  if (isPlainRecord(source)) {
    for (const field of PRIMARY_IDENTITY_FIELDS) {
      if (usableIdentityValue(source[field])) {
        return { field, value: source[field] };
      }
    }
    if (
      usableIdentityValue(source.sourceId) &&
      usableIdentityValue(source.nativeSessionId)
    ) {
      return {
        sourceId: source.sourceId,
        nativeSessionId: source.nativeSessionId,
      };
    }
    for (const field of SECONDARY_IDENTITY_FIELDS) {
      if (usableIdentityValue(source[field])) {
        return { field, value: source[field] };
      }
    }
  }
  return { contentHash: value.contentHash };
}

function analyzeValue(value: unknown): AnalyzedValue {
  if (isLinkRef(value)) {
    return {
      kind: "leaf",
      value,
      contentHash: hashFabricValue(value),
    };
  }
  if (Array.isArray(value)) {
    const items: AnalyzedValue[] = [];
    const itemHashes: string[] = [];
    for (let index = 0; index < value.length; index++) {
      if (index in value) {
        const item = analyzeValue(value[index]);
        items[index] = item;
        itemHashes[index] = item.contentHash;
      } else {
        items.length = index + 1;
        itemHashes.length = index + 1;
      }
    }
    return {
      kind: "array",
      value,
      items,
      contentHash: hashFabricValue({
        kind: "array",
        items: itemHashes,
      }),
    };
  }
  if (isPlainRecord(value)) {
    const entries = Object.entries(value).map(
      ([key, child]) => [key, analyzeValue(child)] as [string, AnalyzedValue],
    );
    return {
      kind: "record",
      value,
      entries,
      contentHash: hashFabricValue({
        kind: "record",
        entries: Object.fromEntries(
          entries.map(([key, child]) => [key, child.contentHash]),
        ),
      }),
    };
  }
  return {
    kind: "leaf",
    value,
    contentHash: hashFabricValue(value),
  };
}

function planArray(
  value: AnalyzedArray,
  scope: unknown,
  path: string[],
): PlannedArray {
  const candidates: Array<{
    identity: Record<string, unknown>;
    identityKey: string;
  }> = [];
  const identityCounts = new Map<string, number>();
  for (let index = 0; index < value.items.length; index++) {
    if (!(index in value.items)) continue;
    const identity = identityFor(value.items[index]);
    const candidate = {
      identity,
      identityKey: canonicalJson(identity),
    };
    candidates[index] = candidate;
    identityCounts.set(
      candidate.identityKey,
      (identityCounts.get(candidate.identityKey) ?? 0) + 1,
    );
  }
  const duplicateCounts = new Map<string, number>();
  const items: StableArrayCellPlan[] = [];
  for (let index = 0; index < value.items.length; index++) {
    if (!(index in value.items)) {
      items.length = index + 1;
      continue;
    }
    const candidate = candidates[index];
    const analyzedItem = value.items[index];
    const collisionHash = (identityCounts.get(candidate.identityKey) ?? 0) > 1
      ? analyzedItem.contentHash
      : undefined;
    const duplicateKey = `${candidate.identityKey}\0${collisionHash ?? ""}`;
    const duplicate = duplicateCounts.get(duplicateKey) ?? 0;
    duplicateCounts.set(duplicateKey, duplicate + 1);
    const cause: StableArrayElementCause = {
      agentConnector: "array-element",
      scope,
      path: [...path],
      identity: candidate.identity,
      ...(collisionHash ? { collisionHash } : {}),
      ...(duplicate > 0 ? { duplicate } : {}),
    };
    items[index] = {
      kind: "cell",
      cause,
      value: planAnalyzedValue(analyzedItem, cause, []),
    } satisfies PlannedCell;
  }
  return { kind: "array", items };
}

function planAnalyzedValue(
  value: AnalyzedValue,
  scope: unknown,
  path: string[],
): StableArrayCellPlan {
  switch (value.kind) {
    case "array":
      return planArray(value, scope, path);
    case "record":
      return {
        kind: "record",
        entries: value.entries.map(([key, child]) => [
          key,
          planAnalyzedValue(child, scope, [...path, key]),
        ]),
      };
    case "leaf":
      return { kind: "leaf", value: value.value };
  }
}

function planCapturedValue(
  value: unknown,
  scope: unknown,
): StableArrayCellPlan {
  return planAnalyzedValue(analyzeValue(value), scope, []);
}

/**
 * Precompute stable identities before entering the runner's synchronous global
 * frame. Array positions are deliberately absent from causes: provider IDs win,
 * with a content hash fallback for values that expose no canonical identity.
 */
export function planStableArrayCells(
  value: unknown,
  scope: unknown,
): Promise<StableArrayCellPlan> {
  return Promise.resolve().then(() =>
    planCapturedValue(stableFabricValue(value), scope)
  );
}

const HASH_SCOPE = {
  agentConnector: "stable-array-value-hash",
} as const;

interface StoredCellFingerprint {
  causeHash: string;
  valueHash: string;
}

function materializeHashGraph(
  plan: StableArrayCellPlan,
  cells: StoredCellFingerprint[],
): unknown {
  switch (plan.kind) {
    case "leaf":
      return plan.value;
    case "array":
      return plan.items.map((item) => materializeHashGraph(item, cells));
    case "record":
      return Object.fromEntries(
        plan.entries.map(([key, value]) => [
          key,
          materializeHashGraph(value, cells),
        ]),
      );
    case "cell": {
      const causeHash = hashFabricValue(plan.cause);
      const valueHash = hashFabricValue(
        materializeHashGraph(plan.value, cells),
      );
      cells.push({ causeHash, valueHash });
      return linkRefFrom({
        id: `of:${causeHash.slice("sha256:".length)}`,
      });
    }
  }
}

/**
 * Hash the graph produced by the stable-array planner. Each cell value is
 * converted independently, matching the conversion boundary used when the
 * graph is written.
 */
function calculateStableArrayValueHash(plan: StableArrayCellPlan): string {
  const cells: StoredCellFingerprint[] = [];
  const rootHash = hashFabricValue(materializeHashGraph(plan, cells));
  cells.sort((left, right) =>
    left.causeHash.localeCompare(right.causeHash) ||
    left.valueHash.localeCompare(right.valueHash)
  );
  return hashFabricValue({
    rootHash,
    cells,
  });
}

export function hashStableArrayValue(value: unknown): Promise<string> {
  return Promise.resolve().then(() =>
    calculateStableArrayValueHash(
      planCapturedValue(stableFabricValue(value), HASH_SCOPE),
    )
  );
}

/** Materialize a precomputed plan with a transaction-backed cell writer. */
export function materializeStableArrayCells(
  plan: StableArrayCellPlan,
  materializeCell: StableArrayCellMaterializer,
): unknown {
  switch (plan.kind) {
    case "leaf":
      return plan.value;
    case "array":
      return plan.items.map((item) =>
        materializeStableArrayCells(item, materializeCell)
      );
    case "record":
      return Object.fromEntries(
        plan.entries.map(([key, value]) => [
          key,
          materializeStableArrayCells(value, materializeCell),
        ]),
      );
    case "cell":
      return materializeCell(
        plan.cause,
        materializeStableArrayCells(plan.value, materializeCell),
      );
  }
}

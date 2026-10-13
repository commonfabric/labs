/**
 * Deduplicates exact CFC labels and paths in endpoint transport envelopes.
 * This host serialization preserves label contents and entry order; consumers
 * receive expanded metadata before interpreting it.
 */

import {
  cloneIfNecessary,
  deepFreeze,
  type FabricPlainObject,
  type FabricValue,
  hashOf,
  isValidFabricPlainObject,
  isValidFabricValue,
} from "@commonfabric/data-model";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { isPlainObject } from "@commonfabric/utils/types";

import { encodeMemoryBoundary } from "../v2.ts";
import { findSyncSchemaRef } from "./sync-schema-ref.ts";

const textEncoder = new TextEncoder();

/**
 * Maximum cumulative encoded label and path bytes resolved by an envelope's refs.
 * Each occurrence includes the codec tag, making the accounting conservative.
 * Inline values remain subject to the enclosing transport's limits.
 */
export const MAX_LABEL_METADATA_EXPANSION_BYTES = 16 * 1024 * 1024;

/** Independent, envelope-local dictionaries of exact CFC metadata. */
export type LabelMetadataTables = {
  /** Dense label array addressed by integer-valued metadata label positions. */
  labelTable?: FabricPlainObject[];

  /** Dense path array addressed by integer-valued metadata path positions. */
  labelPathTable?: (readonly string[])[];
};

/** Whole label or path position, never a component inside either value. */
export type MetadataField = "label" | "path";

/** Rewriter applied only at whole CFC metadata label and path positions. */
export type MapMetadataValue = (
  value: unknown,
  field: MetadataField,
) => unknown;

/** Envelope-specific traversal that preserves every non-metadata position. */
export type MapMetadataEnvelope = (
  envelope: Record<string, unknown>,
  map: MapMetadataValue,
) => Record<string, unknown>;

/** Opaque metadata value admitted by one of the transport dictionaries. */
type TableValue = FabricPlainObject | readonly string[];

/** Position and structural validator owned by a message-local dictionary. */
interface TableSpec {
  /** Envelope property holding this dictionary. */
  name: "labelTable" | "labelPathTable";

  /** Label-map entry property holding an inline value or an integer ref. */
  field: "label" | "path";

  /** Structural check that leaves values and their order unchanged. */
  valid: (value: unknown) => value is TableValue;
}

const tables: readonly TableSpec[] = [
  { name: "labelTable", field: "label", valid: isValidFabricPlainObject },
  { name: "labelPathTable", field: "path", valid: isLabelPath },
];

/** Candidate shared value and its exact transport cost. */
interface Candidate {
  /** Canonical content identity, including the hash algorithm tag. */
  hash: string;

  /** Original value, kept opaque to the transport. */
  value: TableValue;

  /** Number of metadata positions containing this content. */
  count: number;

  /** Encoded byte length of one inline occurrence, including the codec tag. */
  bytes: number;
}

/** Per-envelope compression state for one independent metadata dictionary. */
interface CompressionTable {
  /** Position and accepted input shape. */
  spec: TableSpec;

  /** Avoids repeated validation and hashing of the same object. */
  byIdentity: WeakMap<object, Candidate>;

  /** Deduplicates independently allocated equal values by canonical hash. */
  byHash: Map<string, Candidate>;

  /** Index selected for each beneficial candidate. */
  selected: Map<string, number>;

  /** Dictionary emitted only when its aggregate wire cost is beneficial. */
  values: TableValue[];
}

/**
 * Compresses repeated labels and paths when reference and table costs save bytes.
 * Inputs are neither mutated nor frozen. Call only for a negotiated endpoint.
 * Preserves uninterpreted inline metadata. Throws on numeric input refs, an
 * already-compressed envelope, or a selected label
 * containing a reserved schema reference. Compress labels before schemas when
 * labels contain schema-bearing links.
 */
export function compressLabelMetadata(
  envelope: Record<string, unknown>,
  mapEnvelope: MapMetadataEnvelope,
): Record<string, unknown> {
  const states: CompressionTable[] = tables.map((spec) => {
    if (Object.hasOwn(envelope, spec.name)) {
      throw new Error(`Cannot compress metadata containing \`${spec.name}\``);
    }
    return {
      spec,
      byIdentity: new WeakMap(),
      byHash: new Map(),
      selected: new Map(),
      values: [],
    };
  });
  mapEnvelope(envelope, (value, field) => {
    const state = states[field === "label" ? 0 : 1];
    collectCandidate(state, value);
    return value;
  });
  let expandedBytes = 0;
  const dictionaries: Record<string, TableValue[]> = {};
  for (const state of states) {
    expandedBytes += selectCandidates(state);
    if (state.values.length > 0) dictionaries[state.spec.name] = state.values;
  }
  if (Object.keys(dictionaries).length === 0) return envelope;
  requireExpansionBudget(expandedBytes);
  const rewritten = mapEnvelope(envelope, (value, field) => {
    const state = states[field === "label" ? 0 : 1];
    if (!isPlainObject(value) && !Array.isArray(value)) return value;
    const candidate = state.byIdentity.get(value);
    return candidate === undefined
      ? value
      : state.selected.get(candidate.hash) ?? value;
  });
  return { ...rewritten, ...dictionaries };
}

/**
 * Expands and removes metadata tables, validating all entries and refs.
 * Returns a deeply frozen expanded envelope, with one frozen copy per table value.
 * Unchanged subtrees shared with the input may be frozen in place.
 * Table contents must be self-contained: reserved schema refs are rejected even
 * when a sibling schema table defines them.
 * Uncompressed envelopes retain identity. Invalid tables, refs, or expansion above
 * `MAX_LABEL_METADATA_EXPANSION_BYTES` throws before the envelope is returned.
 */
export function expandLabelMetadata(
  envelope: Record<string, unknown>,
  mapEnvelope: MapMetadataEnvelope,
): Record<string, unknown> {
  const states = tables.map((spec) => readTable(envelope, spec));
  let expandedBytes = 0;
  const expanded = mapEnvelope(envelope, (value, field) => {
    const { spec, values, costs } = states[field === "label" ? 0 : 1];
    if (typeof value === "number") {
      if (
        !Number.isSafeInteger(value) || Object.is(value, -0) || value < 0 ||
        value >= values.length
      ) {
        throw new Error(`Invalid metadata \`${spec.name}\` reference`);
      }
      expandedBytes += costs[value];
      requireExpansionBudget(expandedBytes);
      return values[value];
    }
    return value;
  });
  if (!states.some(({ present }) => present)) return expanded;
  const {
    labelTable: _labelTable,
    labelPathTable: _labelPathTable,
    ...result
  } = expanded;
  return deepFreeze(result);
}

/**
 * Detects dictionaries or numeric refs without validating inline CFC semantics.
 * Uses the same position traversal as compression and expansion.
 */
export function hasLabelMetadata(
  envelope: Record<string, unknown>,
  mapEnvelope: MapMetadataEnvelope,
): boolean {
  if (tables.some((spec) => Object.hasOwn(envelope, spec.name))) return true;
  let found = false;
  mapEnvelope(envelope, (value) => {
    found ||= typeof value === "number";
    return value;
  });
  return found;
}

/**
 * Validates the `readonly string[]` shape of a stored label-map entry's path.
 * Dense indices matter: the array methods' skipped holes are not path segments.
 */
function isLabelPath(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || !isValidFabricValue(value)) return false;
  for (const segment of value) if (typeof segment !== "string") return false;
  return true;
}

/** Helper for compression, which hashes each object once within its envelope. */
function collectCandidate(state: CompressionTable, value: unknown): void {
  if (typeof value === "number") {
    throw new Error(
      `Cannot compress metadata \`${state.spec.field}\` reference`,
    );
  }
  if (!isPlainObject(value) && !Array.isArray(value)) {
    return;
  }
  let candidate = state.byIdentity.get(value);
  if (candidate === undefined) {
    if (!state.spec.valid(value)) {
      return;
    }
    const hash = hashOf(value).toString();
    candidate = state.byHash.get(hash);
    if (candidate === undefined) {
      candidate = { hash, value, count: 0, bytes: encodedBytes(value) };
      state.byHash.set(hash, candidate);
    }
    state.byIdentity.set(value, candidate);
  }
  candidate.count++;
}

/**
 * Helper for compression, which selects profitable references and a profitable
 * dictionary, returning the cumulative encoded bytes its refs will expand to.
 */
function selectCandidates(state: CompressionTable): number {
  let savings = 0;
  let expandedBytes = 0;
  for (const candidate of state.byHash.values()) {
    const reference = state.values.length;
    // The codec tag cancels between the two one-value encodings. A singleton
    // array measures the table member including escaped content.
    const inlineSavings = candidate.count *
      (candidate.bytes - encodedBytes(reference));
    const memberCost = encodedBytes([candidate.value]) - encodedBytes([]) + 1;
    const net = inlineSavings - memberCost;
    if (net > 0) {
      state.selected.set(candidate.hash, reference);
      state.values.push(candidate.value);
      savings += net;
      expandedBytes += candidate.bytes * candidate.count;
    }
  }
  // Each member paid for a trailing comma above, so the final one pays for
  // the comma separating the dictionary from the envelope's existing properties.
  const tableCost = encodedBytes({ [state.spec.name]: [] }) - encodedBytes({});
  if (savings <= tableCost) {
    state.selected.clear();
    state.values.length = 0;
    return 0;
  }
  for (const value of state.values) {
    requireSelfContainedLabel(value, state.spec);
  }
  return expandedBytes;
}

/**
 * Rejects reserved refs at schema positions in dictionary labels. Schema-table
 * expansion visits documents and crossings; dictionary contents are opaque to it.
 */
function requireSelfContainedLabel(value: TableValue, spec: TableSpec): void {
  if (spec.field === "label" && findSyncSchemaRef(value) !== undefined) {
    throw new Error("Invalid metadata `labelTable`: reserved schema reference");
  }
}

/** Helper for expansion, which validates, weighs, and freezes each table slot. */
function readTable(sync: Record<string, unknown>, spec: TableSpec): {
  spec: TableSpec;
  present: boolean;
  values: TableValue[];
  costs: number[];
} {
  const values: TableValue[] = [];
  const costs: number[] = [];
  const present = Object.hasOwn(sync, spec.name);
  if (present) {
    const table = sync[spec.name];
    if (!Array.isArray(table)) {
      throw new Error(`Invalid metadata \`${spec.name}\`: expected an array`);
    }
    for (let index = 0; index < table.length; index++) {
      if (!Object.hasOwn(table, index)) {
        throw new Error(`Invalid metadata \`${spec.name}\`: sparse array`);
      }
      const value: unknown = table[index];
      if (!spec.valid(value)) {
        throw new Error(`Invalid metadata \`${spec.name}\` content`);
      }
      requireSelfContainedLabel(value, spec);
      values.push(cloneIfNecessary(value));
      costs.push(encodedBytes(value));
    }
  }
  return { spec, present, values, costs };
}

/** Helper for cost selection, which measures canonical memory wire bytes. */
function encodedBytes(
  value: FabricValue,
): number {
  return textEncoder.encode(encodeMemoryBoundary(value)).byteLength;
}

/** Helper for expansion, which bounds later consumers' logical label work. */
function requireExpansionBudget(bytes: number): void {
  if (bytes > MAX_LABEL_METADATA_EXPANSION_BYTES) {
    throw new Error("Metadata expansion exceeds the encoded byte limit");
  }
}

/**
 * Maps metadata in a value placed at a document-rooted path. Only the `cfc`,
 * `labelMap`, and `entries` spine is traversed. Whole labels and paths are opaque
 * leaves; their components and application payloads retain their exact values.
 * Inline malformed containers and entries remain for semantic CFC readers.
 * A numeric whole-field value is a reserved ref even with missing siblings or
 * unsupported versions, including numeric entry keys in a malformed entries
 * record. Such a record is preserved as a record, with only its refs expanded.
 */
export function mapLabelMetadataAtPath(
  value: unknown,
  path: readonly string[],
  map: MapMetadataValue,
): unknown {
  if (path.length > 0 && path[0] !== "cfc") return value;
  if (path.length > 1 && path[1] !== "labelMap") return value;
  if (path.length > 2 && path[2] !== "entries") return value;
  if (
    path.length > 3 && path[3] !== "-" && !isArrayIndexPropertyName(path[3])
  ) {
    return value;
  }
  if (path.length === 5) {
    return path[4] === "label" || path[4] === "path"
      ? map(value, path[4])
      : value;
  }
  if (path.length > 5) return value;
  if ((path.length === 1 || path.length === 2) && value === undefined) {
    return value;
  }
  if (path.length === 3) {
    if (!Array.isArray(value)) {
      if (!isPlainObject(value)) return value;
      let entries: Record<string, unknown> | undefined;
      for (const [key, entry] of Object.entries(value)) {
        if (!isArrayIndexPropertyName(key)) continue;
        const mapped = mapLabelMetadataAtPath(
          entry,
          [...path, key],
          (child, field) =>
            typeof child === "number" ? map(child, field) : child,
        );
        if (!Object.is(mapped, entry)) {
          entries ??= { ...value };
          entries[key] = mapped;
        }
      }
      return entries ?? value;
    }
    let changed = false;
    const entries = value.map((entry: unknown, index: number) => {
      const mapped = mapLabelMetadataAtPath(
        entry,
        [...path, String(index)],
        map,
      );
      changed ||= !Object.is(mapped, entry);
      return mapped;
    });
    return changed ? entries : value;
  }
  if (!isPlainObject(value)) return value;
  if (path.length === 4) {
    const inlineEntry = isPlainObject(value.label) && isLabelPath(value.path);
    let entry = value;
    for (const field of ["label", "path"] as const) {
      if (!Object.hasOwn(value, field)) continue;
      const child = value[field];
      if (!inlineEntry && typeof child !== "number") continue;
      const mapped = map(child, field);
      if (!Object.is(mapped, child)) entry = { ...entry, [field]: mapped };
    }
    return entry;
  }
  const key = ["cfc", "labelMap", "entries"][path.length];
  if (path.length < 2 && value[key] === undefined) return value;
  const child = mapLabelMetadataAtPath(value[key], [...path, key], map);
  return Object.is(child, value[key]) ? value : { ...value, [key]: child };
}

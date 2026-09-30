import { encodeHex } from "@std/encoding/hex";

import { sha256 } from "@commonfabric/content-hash";
import { cloneIfNecessary, type FabricValue } from "@commonfabric/data-model";
import {
  CFC_ENFORCEMENT_MODES,
  type CfcEnforcementMode as RunnerCfcEnforcementMode,
  isCfcEnforcementMode,
} from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/utils/types";

import {
  canonicalCfcJsonStringify,
  type CfcDerivedSlotsAnnotation,
  type CfcDirectoryEntryAnnotation,
  cfcFailClosedLabel,
  type CfcLabel,
  type CfcMetadataLabels,
  type CfcNodeAnnotation,
  type CfcPathSegment,
  type CfcProjectionKind,
  type CfcProjectionRef,
} from "./annotations.ts";
import {
  FUSE_SET_ATTR_ATIME,
  FUSE_SET_ATTR_ATIME_NOW,
  FUSE_SET_ATTR_BKUPTIME,
  FUSE_SET_ATTR_CHGTIME,
  FUSE_SET_ATTR_CRTIME,
  FUSE_SET_ATTR_CTIME,
  FUSE_SET_ATTR_FILE,
  FUSE_SET_ATTR_FLAGS,
  FUSE_SET_ATTR_FORCE,
  FUSE_SET_ATTR_GID,
  FUSE_SET_ATTR_KILL_PRIV,
  FUSE_SET_ATTR_KILL_SGID,
  FUSE_SET_ATTR_KILL_SUID,
  FUSE_SET_ATTR_METADATA_KNOWN_MASK,
  FUSE_SET_ATTR_MODE,
  FUSE_SET_ATTR_MTIME,
  FUSE_SET_ATTR_MTIME_NOW,
  FUSE_SET_ATTR_OPEN,
  FUSE_SET_ATTR_TIMES_SET,
  FUSE_SET_ATTR_TOUCH,
  FUSE_SET_ATTR_UID,
} from "./platform.ts";
import type { FsTree } from "./tree.ts";

export type CfcEnforcementMode = RunnerCfcEnforcementMode;

export type CfcWritebackOperation =
  | "write"
  | "truncate"
  | "create"
  | "mkdir"
  | "unlink"
  | "rmdir"
  | "rename-source"
  | "rename-destination"
  | "symlink"
  | "setattr-metadata";
export type CfcCreateWritebackOperation = "create" | "mkdir";
export type CfcExistingWritebackOperation = "write" | "truncate";
export type CfcNamespaceMutationWritebackOperation =
  | "unlink"
  | "rmdir"
  | "rename-source"
  | "rename-destination";
export type CfcSymlinkWritebackOperation = "symlink";
export type CfcMetadataWritebackOperation = "setattr-metadata";
export type CfcMetadataLabelKey = keyof CfcMetadataLabels;

export const CFC_WRITEBACK_PREPARE_XATTR = "trusted.cfc.writeback.prepare";
export const CFC_WRITEBACK_FINALIZE_XATTR = "trusted.cfc.writeback.finalize";
export const CFC_COMPAT_WRITEBACK_PREPARE_XATTR =
  "user.commonfabric.cfc.writeback.prepare";
export const CFC_COMPAT_WRITEBACK_FINALIZE_XATTR =
  "user.commonfabric.cfc.writeback.finalize";

export function normalizeCfcWritebackXattrName(name: string): string | null {
  if (
    name === CFC_WRITEBACK_PREPARE_XATTR ||
    name === CFC_COMPAT_WRITEBACK_PREPARE_XATTR
  ) {
    return CFC_WRITEBACK_PREPARE_XATTR;
  }
  if (
    name === CFC_WRITEBACK_FINALIZE_XATTR ||
    name === CFC_COMPAT_WRITEBACK_FINALIZE_XATTR
  ) {
    return CFC_WRITEBACK_FINALIZE_XATTR;
  }
  return null;
}

export type CfcPreparedWritebackLabels = {
  contentLabel?: CfcLabel;
  nameLabel?: CfcLabel;
  existenceLabel?: CfcLabel;
  namespaceLabel?: CfcLabel;
  linkTextLabel?: CfcLabel;
  targetIdentityLabel?: CfcLabel;
  metadataLabels?: Partial<CfcMetadataLabels>;
};

export type CfcPreparedWriteback = {
  version: 1;
  operation: CfcWritebackOperation;
  target: {
    ref?: CfcProjectionRef;
    parentRef?: CfcProjectionRef;
    sourceParentRef?: CfcProjectionRef;
    destinationParentRef?: CfcProjectionRef;
    path?: CfcPathSegment[];
    name?: string;
    sourceName?: string;
    destinationName?: string;
    targetText?: string;
    targetIdentity?: unknown;
    metadataFields?: CfcMetadataLabelKey[];
  };
  expectedGeneration: string;
  labels: CfcPreparedWritebackLabels;
};

export type CfcFinalizedWriteback = {
  version: 1;
  operation: CfcWritebackOperation;
  committedGeneration: string;
};

export type CfcWritebackAuthorization =
  | {
    allowed: true;
    requiresPrepare: boolean;
    prepared?: CfcPreparedWriteback;
  }
  | {
    allowed: false;
    requiresPrepare: boolean;
    reason: string;
  };

export type CfcPreparedWritebackStatus =
  | "pending-prepare"
  | "mutation-applied"
  | "runner-commit-failed"
  | "stale-generation"
  | "malformed-prepare"
  | "ready-for-exact-recomputation"
  | "finalized-pending-cleanup";

export type CfcWritebackRecoveryRecord = {
  version: 1;
  key: string;
  status: CfcPreparedWritebackStatus;
  ino?: string;
  operation?: CfcWritebackOperation;
  name?: string;
  prepared?: CfcPreparedWriteback;
  expectedGeneration?: string;
  targetRef?: CfcProjectionRef;
  requestedFields?: CfcMetadataLabelKey[];
  diagnostics: string[];
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  commitFailedAt?: string;
  readyAt?: string;
  finalizedAt?: string;
};

export type CfcWritebackSnapshot = {
  version: 1;
  storagePath?: string;
  records: CfcWritebackRecoveryRecord[];
  counts: Record<CfcPreparedWritebackStatus, number>;
};

export type CfcWritebackReconciliationResult = {
  inspected: number;
  rebound: number;
  reapplied: number;
  finalized: number;
  stale: number;
  diagnostics: string[];
};

export function safeReconcileCfcWritebacks(options: {
  context: string;
  reconcile: () => CfcWritebackReconciliationResult;
  recordDiagnostics: (messages: string[]) => void;
}): boolean {
  try {
    const result = options.reconcile();
    options.recordDiagnostics(result.diagnostics);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.recordDiagnostics([
      `${options.context} reconciliation failed: ${message}`,
    ]);
    return false;
  }
}

/**
 * The mode a source states, checked against the ladder.
 *
 * @throws Error when the source states a name the ladder does not hold.
 */
function statedCfcMode(
  value: string,
  source: string,
): CfcEnforcementMode {
  if (!isCfcEnforcementMode(value)) {
    throw new Error(
      `${source}=${value} is not a CFC enforcement mode; expected one of ${
        CFC_ENFORCEMENT_MODES.join(", ")
      }`,
    );
  }
  return value;
}

/**
 * The rung a mount runs at when neither `--cfc-mode` nor `CF_CFC_MODE` names
 * one. A mount is a write path into a real space, so it takes the rung the
 * first-party presets pin rather than the floor an unconfigured transaction
 * carries.
 */
export const DEFAULT_FUSE_CFC_MODE: CfcEnforcementMode = "enforce-strict";

/**
 * The mode a mount runs its CFC guardrails at.
 *
 * `--cfc-mode` decides when it names a mode, `CF_CFC_MODE` decides otherwise,
 * and a mount that names a mode nowhere runs at
 * {@link DEFAULT_FUSE_CFC_MODE}. An empty value names nothing: the
 * mount reads an absent flag as one, and so is an exported but unset
 * environment variable.
 *
 * @throws Error when the deciding source names a mode off the ladder, giving
 * the value, the source that named it, and the accepted names.
 */
export function resolveCfcMode(options: {
  cliMode?: string;
  envMode?: string;
}): CfcEnforcementMode {
  if (options.cliMode) return statedCfcMode(options.cliMode, "--cfc-mode");
  if (options.envMode) return statedCfcMode(options.envMode, "CF_CFC_MODE");
  return DEFAULT_FUSE_CFC_MODE;
}

export function shouldEnableCfcAnnotations(options: {
  annotationsRequested: boolean;
  mode: CfcEnforcementMode;
}): boolean {
  return options.annotationsRequested || options.mode !== "disabled";
}

export function isCfcEnforcing(mode: CfcEnforcementMode): boolean {
  return mode === "enforce-explicit" || mode === "enforce-strict";
}

export function metadataFieldsForSetattrFlags(
  flags: number,
): CfcMetadataLabelKey[] {
  const fields = new Set<CfcMetadataLabelKey>();
  const unsignedFlags = flags >>> 0;
  const has = (flag: number) => (unsignedFlags & (flag >>> 0)) !== 0;

  if (
    has(FUSE_SET_ATTR_MODE) ||
    has(FUSE_SET_ATTR_KILL_SUID) ||
    has(FUSE_SET_ATTR_KILL_SGID) ||
    has(FUSE_SET_ATTR_KILL_PRIV) ||
    has(FUSE_SET_ATTR_FLAGS)
  ) {
    fields.add("mode");
  }
  if (has(FUSE_SET_ATTR_UID)) fields.add("uid");
  if (has(FUSE_SET_ATTR_GID)) fields.add("gid");
  if (
    has(FUSE_SET_ATTR_ATIME) ||
    has(FUSE_SET_ATTR_MTIME) ||
    has(FUSE_SET_ATTR_ATIME_NOW) ||
    has(FUSE_SET_ATTR_MTIME_NOW) ||
    has(FUSE_SET_ATTR_TIMES_SET) ||
    has(FUSE_SET_ATTR_TOUCH)
  ) {
    fields.add("mtime");
  }
  if (
    has(FUSE_SET_ATTR_CTIME) ||
    has(FUSE_SET_ATTR_CRTIME) ||
    has(FUSE_SET_ATTR_CHGTIME) ||
    has(FUSE_SET_ATTR_BKUPTIME)
  ) {
    fields.add("ctime");
  }
  if (
    has(FUSE_SET_ATTR_FORCE) ||
    has(FUSE_SET_ATTR_FILE) ||
    has(FUSE_SET_ATTR_OPEN)
  ) {
    fields.add("generation");
  }

  const unknownFlags = unsignedFlags &
    ~(FUSE_SET_ATTR_METADATA_KNOWN_MASK >>> 0);
  if (unknownFlags !== 0) {
    for (const key of allMetadataLabelKeys) fields.add(key);
  }

  return [...fields].sort();
}

export function shouldRequirePrepareForExisting(options: {
  mode: CfcEnforcementMode;
  annotation?: CfcNodeAnnotation;
}): boolean {
  if (options.mode === "enforce-strict") return true;
  return options.mode === "enforce-explicit" &&
    options.annotation !== undefined;
}

export function shouldRequirePrepareForMetadata(options: {
  mode: CfcEnforcementMode;
  annotation?: CfcNodeAnnotation;
}): boolean {
  return shouldRequirePrepareForExisting(options);
}

export function shouldRequirePrepareForCreate(options: {
  mode: CfcEnforcementMode;
  parentAnnotation?: CfcNodeAnnotation;
}): boolean {
  return shouldRequirePrepareForAnnotatedParent(options);
}

export function shouldRequirePrepareForNamespaceMutation(options: {
  mode: CfcEnforcementMode;
  parentAnnotation?: CfcNodeAnnotation;
}): boolean {
  return shouldRequirePrepareForAnnotatedParent(options);
}

export function shouldRequirePrepareForSymlink(options: {
  mode: CfcEnforcementMode;
  parentAnnotation?: CfcNodeAnnotation;
}): boolean {
  return shouldRequirePrepareForAnnotatedParent(options);
}

function shouldRequirePrepareForAnnotatedParent(options: {
  mode: CfcEnforcementMode;
  parentAnnotation?: CfcNodeAnnotation;
}): boolean {
  if (options.mode === "enforce-strict") return true;
  if (options.mode !== "enforce-explicit") return false;
  const annotation = options.parentAnnotation;
  return Boolean(annotation?.namespaceLabel || annotation?.entries);
}

export function authorizeExistingWriteback(options: {
  mode: CfcEnforcementMode;
  operation: CfcExistingWritebackOperation;
  annotation?: CfcNodeAnnotation;
  prepared?: CfcPreparedWriteback;
  diagnostics?: string[];
}): CfcWritebackAuthorization {
  const requiresPrepare = shouldRequirePrepareForExisting(options);
  if (options.mode === "disabled") {
    return { allowed: true, requiresPrepare: false };
  }
  if (options.mode === "observe") {
    if (!options.prepared) {
      options.diagnostics?.push(
        `missing prepared CFC writeback metadata for ${options.operation}`,
      );
    }
    return {
      allowed: true,
      requiresPrepare: false,
      prepared: validPreparedForExisting(options)
        ? options.prepared
        : undefined,
    };
  }

  if (!requiresPrepare) {
    return { allowed: true, requiresPrepare: false };
  }
  if (!options.annotation) {
    return {
      allowed: false,
      requiresPrepare,
      reason: "missing coherent CFC annotation",
    };
  }
  if (options.annotation.ref.generation !== options.annotation.generation) {
    return {
      allowed: false,
      requiresPrepare,
      reason: "stale CFC ref generation",
    };
  }
  if (!validPreparedForExisting(options)) {
    return {
      allowed: false,
      requiresPrepare: true,
      reason: "missing or stale prepared CFC writeback metadata",
    };
  }
  return {
    allowed: true,
    requiresPrepare: true,
    prepared: options.prepared,
  };
}

export function authorizeMetadataWriteback(options: {
  mode: CfcEnforcementMode;
  annotation?: CfcNodeAnnotation;
  prepared?: CfcPreparedWriteback;
  requestedFields: CfcMetadataLabelKey[];
  diagnostics?: string[];
}): CfcWritebackAuthorization {
  const requiresPrepare = shouldRequirePrepareForMetadata(options);
  if (options.mode === "disabled") {
    return { allowed: true, requiresPrepare: false };
  }
  if (options.mode === "observe") {
    if (!options.prepared) {
      options.diagnostics?.push(
        "missing prepared CFC writeback metadata for setattr-metadata",
      );
    } else if (!validPreparedForMetadata(options)) {
      options.diagnostics?.push(
        "malformed prepared CFC writeback metadata for setattr-metadata",
      );
    }
    return {
      allowed: true,
      requiresPrepare: false,
      prepared: validPreparedForMetadata(options)
        ? options.prepared
        : undefined,
    };
  }

  if (!requiresPrepare) {
    return { allowed: true, requiresPrepare: false };
  }
  if (!options.annotation) {
    return {
      allowed: false,
      requiresPrepare,
      reason: "missing coherent CFC annotation",
    };
  }
  if (options.annotation.ref.generation !== options.annotation.generation) {
    return {
      allowed: false,
      requiresPrepare,
      reason: "stale CFC ref generation",
    };
  }
  if (!validPreparedForMetadata(options)) {
    return {
      allowed: false,
      requiresPrepare: true,
      reason: "missing or stale prepared CFC metadata writeback",
    };
  }
  return {
    allowed: true,
    requiresPrepare: true,
    prepared: options.prepared,
  };
}

export function authorizeNamespaceMutationWriteback(options: {
  mode: CfcEnforcementMode;
  operation: CfcNamespaceMutationWritebackOperation;
  parentAnnotation?: CfcNodeAnnotation;
  prepared?: CfcPreparedWriteback;
  name: string;
  pairedName?: string;
  allowPairedRenamePrepare?: boolean;
  diagnostics?: string[];
}): CfcWritebackAuthorization {
  const requiresPrepare = shouldRequirePrepareForNamespaceMutation(options);
  if (options.mode === "disabled") {
    return { allowed: true, requiresPrepare: false };
  }
  if (options.mode === "observe") {
    if (!options.prepared) {
      options.diagnostics?.push(
        `missing prepared CFC writeback metadata for ${options.operation}:${options.name}`,
      );
    } else if (!validPreparedForNamespaceMutation(options)) {
      options.diagnostics?.push(
        `malformed prepared CFC writeback metadata for ${options.operation}:${options.name}`,
      );
    }
    return {
      allowed: true,
      requiresPrepare: false,
      prepared: validPreparedForNamespaceMutation(options)
        ? options.prepared
        : undefined,
    };
  }
  if (options.mode === "enforce-strict" && !options.parentAnnotation) {
    return {
      allowed: false,
      requiresPrepare,
      reason: "missing coherent parent CFC annotation",
    };
  }
  if (
    options.parentAnnotation &&
    options.parentAnnotation.ref.generation !==
      options.parentAnnotation.generation
  ) {
    return {
      allowed: false,
      requiresPrepare,
      reason: "stale parent CFC ref generation",
    };
  }
  if (!requiresPrepare) {
    return { allowed: true, requiresPrepare: false };
  }
  if (!validPreparedForNamespaceMutation(options)) {
    return {
      allowed: false,
      requiresPrepare: true,
      reason: "missing or stale parent prepared CFC writeback metadata",
    };
  }
  return {
    allowed: true,
    requiresPrepare: true,
    prepared: options.prepared,
  };
}

export function authorizeSymlinkWriteback(options: {
  mode: CfcEnforcementMode;
  parentAnnotation?: CfcNodeAnnotation;
  prepared?: CfcPreparedWriteback;
  name: string;
  targetText: string;
  targetIdentity?: unknown;
  allowDeferredTargetIdentity?: boolean;
  diagnostics?: string[];
}): CfcWritebackAuthorization {
  const requiresPrepare = shouldRequirePrepareForSymlink(options);
  if (options.mode === "disabled") {
    return { allowed: true, requiresPrepare: false };
  }
  if (options.mode === "observe") {
    if (!options.prepared) {
      options.diagnostics?.push(
        `missing prepared CFC writeback metadata for symlink:${options.name}`,
      );
    } else if (!validPreparedForSymlink(options)) {
      options.diagnostics?.push(
        `malformed prepared CFC writeback metadata for symlink:${options.name}`,
      );
    }
    return {
      allowed: true,
      requiresPrepare: false,
      prepared: validPreparedForSymlink(options) ? options.prepared : undefined,
    };
  }
  if (options.mode === "enforce-strict" && !options.parentAnnotation) {
    return {
      allowed: false,
      requiresPrepare,
      reason: "missing coherent parent CFC annotation",
    };
  }
  if (
    options.parentAnnotation &&
    options.parentAnnotation.ref.generation !==
      options.parentAnnotation.generation
  ) {
    return {
      allowed: false,
      requiresPrepare,
      reason: "stale parent CFC ref generation",
    };
  }
  if (!requiresPrepare) {
    return { allowed: true, requiresPrepare: false };
  }
  if (!validPreparedForSymlink(options)) {
    return {
      allowed: false,
      requiresPrepare: true,
      reason: "missing or stale parent prepared CFC writeback metadata",
    };
  }
  return {
    allowed: true,
    requiresPrepare: true,
    prepared: options.prepared,
  };
}

export function authorizeCreateWriteback(options: {
  mode: CfcEnforcementMode;
  operation: CfcCreateWritebackOperation;
  parentAnnotation?: CfcNodeAnnotation;
  prepared?: CfcPreparedWriteback;
  name: string;
  diagnostics?: string[];
}): CfcWritebackAuthorization {
  const requiresPrepare = shouldRequirePrepareForCreate(options);
  if (options.mode === "disabled") {
    return { allowed: true, requiresPrepare: false };
  }
  if (options.mode === "observe") {
    if (!options.prepared) {
      options.diagnostics?.push(
        `missing prepared CFC writeback metadata for ${options.operation}:${options.name}`,
      );
    }
    return {
      allowed: true,
      requiresPrepare: false,
      prepared: validPreparedForCreate(options) ? options.prepared : undefined,
    };
  }
  if (options.mode === "enforce-strict" && !options.parentAnnotation) {
    return {
      allowed: false,
      requiresPrepare,
      reason: "missing coherent parent CFC annotation",
    };
  }
  if (
    options.parentAnnotation &&
    options.parentAnnotation.ref.generation !==
      options.parentAnnotation.generation
  ) {
    return {
      allowed: false,
      requiresPrepare,
      reason: "stale parent CFC ref generation",
    };
  }
  if (!requiresPrepare) {
    return { allowed: true, requiresPrepare: false };
  }
  if (!validPreparedForCreate(options)) {
    return {
      allowed: false,
      requiresPrepare: true,
      reason: "missing or stale parent prepared CFC writeback metadata",
    };
  }
  return {
    allowed: true,
    requiresPrepare: true,
    prepared: options.prepared,
  };
}

function validPreparedForExisting(options: {
  operation: CfcExistingWritebackOperation;
  annotation?: CfcNodeAnnotation;
  prepared?: CfcPreparedWriteback;
}): boolean {
  const { annotation, prepared } = options;
  if (!annotation || !prepared) return false;
  return prepared.version === 1 &&
    prepared.operation === options.operation &&
    prepared.expectedGeneration === annotation.generation &&
    prepared.target.ref?.generation === annotation.generation &&
    prepared.target.ref?.projection === annotation.ref.projection &&
    canonicalCfcJsonStringify(prepared.target.ref) ===
      canonicalCfcJsonStringify(annotation.ref);
}

function validPreparedForMetadata(options: {
  annotation?: CfcNodeAnnotation;
  prepared?: CfcPreparedWriteback;
  requestedFields: CfcMetadataLabelKey[];
}): boolean {
  const { annotation, prepared } = options;
  if (!annotation || !prepared) return false;
  if (
    prepared.version !== 1 ||
    prepared.operation !== "setattr-metadata" ||
    prepared.expectedGeneration !== annotation.generation ||
    prepared.target.ref?.generation !== annotation.generation ||
    canonicalCfcJsonStringify(prepared.target.ref) !==
      canonicalCfcJsonStringify(annotation.ref)
  ) {
    return false;
  }

  const labels = prepared.labels.metadataLabels;
  if (!labels) return false;
  for (const field of options.requestedFields) {
    if (labels[field] === undefined) return false;
  }
  return true;
}

function validPreparedForCreate(options: {
  operation: CfcCreateWritebackOperation;
  parentAnnotation?: CfcNodeAnnotation;
  prepared?: CfcPreparedWriteback;
  name: string;
}): boolean {
  const { parentAnnotation, prepared } = options;
  if (!parentAnnotation || !prepared) return false;
  const preparedParentRef = prepared.target.parentRef ?? prepared.target.ref;
  return prepared.version === 1 &&
    prepared.operation === options.operation &&
    prepared.expectedGeneration === parentAnnotation.generation &&
    prepared.target.name === options.name &&
    preparedParentRef?.generation === parentAnnotation.generation &&
    canonicalCfcJsonStringify(preparedParentRef) ===
      canonicalCfcJsonStringify(parentAnnotation.ref);
}

function validPreparedForNamespaceMutation(options: {
  operation: CfcNamespaceMutationWritebackOperation;
  parentAnnotation?: CfcNodeAnnotation;
  prepared?: CfcPreparedWriteback;
  name: string;
  pairedName?: string;
  allowPairedRenamePrepare?: boolean;
}): boolean {
  const { parentAnnotation, prepared } = options;
  if (!parentAnnotation || !prepared) return false;
  if (prepared.version !== 1) return false;
  if (prepared.expectedGeneration !== parentAnnotation.generation) {
    return false;
  }

  const preparedParentRef = parentRefForPrepared(prepared, options.operation);
  if (
    preparedParentRef?.generation !== parentAnnotation.generation ||
    canonicalCfcJsonStringify(preparedParentRef) !==
      canonicalCfcJsonStringify(parentAnnotation.ref)
  ) {
    return false;
  }

  if (prepared.operation === options.operation) {
    return preparedNameMatches(prepared, options.operation, options.name) &&
      pairedRenameNameMatches(prepared, options);
  }

  if (
    !options.allowPairedRenamePrepare ||
    !isRenameOperation(options.operation) ||
    !isRenameOperation(prepared.operation)
  ) {
    return false;
  }
  return renameNamesMatch(prepared, options.operation, options.name) &&
    pairedRenameNameMatches(prepared, options);
}

function parentRefForPrepared(
  prepared: CfcPreparedWriteback,
  operation: CfcNamespaceMutationWritebackOperation,
): CfcProjectionRef | undefined {
  if (operation === "rename-source") {
    return prepared.target.sourceParentRef ??
      (prepared.operation === "rename-destination"
        ? prepared.target.destinationParentRef
        : undefined) ??
      prepared.target.parentRef ??
      prepared.target.ref;
  }
  if (operation === "rename-destination") {
    return prepared.target.destinationParentRef ??
      (prepared.operation === "rename-source"
        ? prepared.target.sourceParentRef
        : undefined) ??
      prepared.target.parentRef ??
      prepared.target.ref;
  }
  return prepared.target.parentRef ?? prepared.target.ref;
}

function preparedNameMatches(
  prepared: CfcPreparedWriteback,
  operation: CfcNamespaceMutationWritebackOperation,
  name: string,
): boolean {
  if (operation === "rename-source") {
    return (prepared.target.sourceName ?? prepared.target.name) === name;
  }
  if (operation === "rename-destination") {
    return (prepared.target.destinationName ?? prepared.target.name) === name;
  }
  return prepared.target.name === name;
}

function pairedRenameNameMatches(
  prepared: CfcPreparedWriteback,
  options: {
    operation: CfcNamespaceMutationWritebackOperation;
    pairedName?: string;
  },
): boolean {
  if (
    !isRenameOperation(options.operation) || options.pairedName === undefined
  ) {
    return true;
  }
  if (options.operation === "rename-source") {
    return (prepared.target.destinationName ??
      (prepared.operation === "rename-destination"
        ? prepared.target.name
        : undefined)) === options.pairedName;
  }
  return (prepared.target.sourceName ??
    (prepared.operation === "rename-source"
      ? prepared.target.name
      : undefined)) ===
    options.pairedName;
}

function renameNamesMatch(
  prepared: CfcPreparedWriteback,
  requestedOperation: CfcNamespaceMutationWritebackOperation,
  requestedName: string,
): boolean {
  if (requestedOperation === "rename-source") {
    return prepared.target.sourceName === requestedName;
  }
  if (requestedOperation === "rename-destination") {
    return prepared.target.destinationName === requestedName;
  }
  return false;
}

function validPreparedForSymlink(options: {
  parentAnnotation?: CfcNodeAnnotation;
  prepared?: CfcPreparedWriteback;
  name: string;
  targetText: string;
  targetIdentity?: unknown;
  allowDeferredTargetIdentity?: boolean;
}): boolean {
  const { parentAnnotation, prepared } = options;
  if (!parentAnnotation || !prepared) return false;
  if (prepared.version !== 1) return false;
  const preparedParentRef = prepared.target.parentRef ?? prepared.target.ref;
  if (
    prepared.operation !== "symlink" ||
    prepared.expectedGeneration !== parentAnnotation.generation ||
    prepared.target.name !== options.name ||
    preparedParentRef?.generation !== parentAnnotation.generation ||
    canonicalCfcJsonStringify(preparedParentRef) !==
      canonicalCfcJsonStringify(parentAnnotation.ref)
  ) {
    return false;
  }

  if (typeof prepared.target.targetText === "string") {
    return prepared.target.targetText === options.targetText;
  }
  if (prepared.target.targetIdentity === undefined) return false;
  if (options.targetIdentity === undefined) {
    return options.allowDeferredTargetIdentity === true;
  }
  return canonicalCfcJsonStringify(prepared.target.targetIdentity) ===
    canonicalCfcJsonStringify(options.targetIdentity);
}

function isRenameOperation(
  operation: CfcWritebackOperation,
): operation is "rename-source" | "rename-destination" {
  return operation === "rename-source" || operation === "rename-destination";
}

const RECOVERY_STATUSES: CfcPreparedWritebackStatus[] = [
  "pending-prepare",
  "mutation-applied",
  "runner-commit-failed",
  "stale-generation",
  "malformed-prepare",
  "ready-for-exact-recomputation",
  "finalized-pending-cleanup",
];

export class CfcWritebackStore {
  #prepared = new Map<string, CfcPreparedWriteback>();
  #records = new Map<string, CfcWritebackRecoveryRecord>();
  #malformedCounter = 0;
  #storagePath: string | undefined;

  constructor(options: { storagePath?: string } = {}) {
    this.#storagePath = options.storagePath;
    this.#load();
  }

  setPreparedXattr(
    ino: bigint,
    name: string,
    value: string,
  ): { ok: true; prepared: CfcPreparedWriteback } | {
    ok: false;
    reason: string;
  } {
    if (normalizeCfcWritebackXattrName(name) !== CFC_WRITEBACK_PREPARE_XATTR) {
      this.#recordMalformed(ino, name, "unsupported writeback xattr");
      return { ok: false, reason: "unsupported writeback xattr" };
    }
    const parsed = parsePreparedWriteback(value);
    if (!parsed) {
      this.#recordMalformed(ino, name, "invalid prepare metadata");
      return { ok: false, reason: "invalid prepare metadata" };
    }
    const key = this.#key(ino, parsed.operation, preparedKeyName(parsed));
    this.#prepared.set(key, parsed);
    const now = new Date().toISOString();
    this.#records.set(key, {
      version: 1,
      key,
      status: "pending-prepare",
      ino: ino.toString(),
      operation: parsed.operation,
      name: preparedKeyName(parsed),
      prepared: parsed,
      expectedGeneration: parsed.expectedGeneration,
      targetRef: primaryPreparedRef(parsed),
      requestedFields: parsed.target.metadataFields,
      diagnostics: [],
      createdAt: now,
      updatedAt: now,
    });
    this.#persist();
    return { ok: true, prepared: parsed };
  }

  setFinalizeXattr(
    ino: bigint,
    name: string,
    value: string,
  ): { ok: true; finalized: CfcFinalizedWriteback } | {
    ok: false;
    reason: string;
  } {
    if (
      normalizeCfcWritebackXattrName(name) !== CFC_WRITEBACK_FINALIZE_XATTR
    ) {
      return { ok: false, reason: "unsupported writeback xattr" };
    }
    const parsed = parseFinalizedWriteback(value);
    if (!parsed) return { ok: false, reason: "invalid finalize metadata" };
    const names = this.#preparedNamesForOperation(ino, parsed.operation);
    if (names.length === 0) {
      this.markFinalizedPendingCleanup(ino, parsed.operation);
      this.deletePrepared(ino, parsed.operation);
    } else {
      for (const preparedName of names) {
        this.markFinalizedPendingCleanup(ino, parsed.operation, preparedName);
        this.deletePrepared(ino, parsed.operation, preparedName);
      }
    }
    return { ok: true, finalized: parsed };
  }

  getPrepared(
    ino: bigint,
    operation: CfcWritebackOperation,
    name?: string,
  ): CfcPreparedWriteback | undefined {
    return this.#prepared.get(this.#key(ino, operation, name));
  }

  deletePrepared(
    ino: bigint,
    operation: CfcWritebackOperation,
    name?: string,
  ): void {
    const key = this.#key(ino, operation, name);
    this.#prepared.delete(key);
    this.#records.delete(key);
    this.#persist();
  }

  deleteAllForIno(ino: bigint): void {
    const prefix = `${ino}:`;
    for (const key of [...this.#prepared.keys()]) {
      if (key.startsWith(prefix)) this.#prepared.delete(key);
    }
    for (const key of [...this.#records.keys()]) {
      if (key.startsWith(prefix)) this.#records.delete(key);
    }
    this.#persist();
  }

  markMutationApplied(
    ino: bigint,
    operation: CfcWritebackOperation,
    name?: string,
    options: { requestedFields?: CfcMetadataLabelKey[] } = {},
  ): void {
    const record = this.#findRecord(ino, operation, name);
    if (!record) return;
    const now = new Date().toISOString();
    record.status = "mutation-applied";
    record.appliedAt = now;
    record.updatedAt = now;
    if (options.requestedFields) {
      record.requestedFields = [...options.requestedFields].sort();
    }
    this.#persist();
  }

  markRunnerCommitFailed(
    ino: bigint,
    operation: CfcWritebackOperation,
    reason: string,
    name?: string,
  ): void {
    const record = this.#findRecord(ino, operation, name);
    if (!record) return;
    const now = new Date().toISOString();
    record.status = "runner-commit-failed";
    record.commitFailedAt = now;
    record.updatedAt = now;
    record.diagnostics.push(reason);
    this.#persist();
  }

  markReadyForExactRecomputation(
    ino: bigint,
    operation: CfcWritebackOperation,
    name?: string,
  ): void {
    const record = this.#findRecord(ino, operation, name);
    if (!record) return;
    const now = new Date().toISOString();
    record.status = "ready-for-exact-recomputation";
    record.readyAt = now;
    record.updatedAt = now;
    this.#persist();
  }

  markFinalizedPendingCleanup(
    ino: bigint,
    operation: CfcWritebackOperation,
    name?: string,
  ): void {
    const record = this.#findRecord(ino, operation, name);
    if (!record) return;
    const now = new Date().toISOString();
    record.status = "finalized-pending-cleanup";
    record.finalizedAt = now;
    record.updatedAt = now;
    this.#persist();
  }

  reconcileTree(tree: FsTree): CfcWritebackReconciliationResult {
    const result: CfcWritebackReconciliationResult = {
      inspected: 0,
      rebound: 0,
      reapplied: 0,
      finalized: 0,
      stale: 0,
      diagnostics: [],
    };

    for (const record of [...this.#records.values()]) {
      if (!record.prepared) continue;
      result.inspected++;
      const match = findPreparedNode(tree, record.prepared);
      if (!match) {
        result.diagnostics.push(
          `prepared CFC writeback ${record.key} has no current projection node`,
        );
        continue;
      }

      const reboundKey = this.#key(
        match.ino,
        record.prepared.operation,
        preparedKeyName(record.prepared),
      );
      if (record.key !== reboundKey) {
        this.#records.delete(record.key);
        this.#prepared.delete(record.key);
        record.key = reboundKey;
        record.ino = match.ino.toString();
        record.updatedAt = new Date().toISOString();
        this.#records.set(reboundKey, record);
        this.#prepared.set(reboundKey, record.prepared);
        result.rebound++;
      }

      if (
        (record.status === "ready-for-exact-recomputation" ||
          record.status === "finalized-pending-cleanup") &&
        isCoherentExactAnnotation(match.annotation)
      ) {
        this.#records.delete(record.key);
        this.#prepared.delete(record.key);
        result.finalized++;
        continue;
      }

      if (
        record.status !== "ready-for-exact-recomputation" &&
        record.status !== "finalized-pending-cleanup" &&
        !isPreparedGeneration(match.annotation.generation) &&
        match.annotation.generation !== record.prepared.expectedGeneration
      ) {
        record.status = "stale-generation";
        record.updatedAt = new Date().toISOString();
        result.stale++;
      }

      applyPreparedForRecovery(tree, match.ino, record);
      result.reapplied++;
    }

    this.#persist();
    return result;
  }

  snapshot(): CfcWritebackSnapshot {
    const records = [...this.#records.values()].map((record) =>
      cloneRecoveryRecord(record, true)
    );
    const counts = Object.fromEntries(
      RECOVERY_STATUSES.map((status) => [status, 0]),
    ) as Record<CfcPreparedWritebackStatus, number>;
    for (const record of records) {
      counts[record.status]++;
    }
    return {
      version: 1,
      storagePath: this.#storagePath,
      records,
      counts,
    };
  }

  status(): Record<string, unknown> {
    const snapshot = this.snapshot();
    return {
      storagePath: snapshot.storagePath,
      counts: snapshot.counts,
      records: snapshot.records.map((record) => ({
        status: record.status,
        operation: record.operation,
        name: record.name,
        ino: record.ino,
        expectedGeneration: record.expectedGeneration,
        diagnostics: record.diagnostics,
        updatedAt: record.updatedAt,
      })),
    };
  }

  #key(
    ino: bigint,
    operation: CfcWritebackOperation,
    name?: string,
  ): string {
    return `${ino}:${operation}:${name ?? ""}`;
  }

  #findRecord(
    ino: bigint,
    operation: CfcWritebackOperation,
    name?: string,
  ): CfcWritebackRecoveryRecord | undefined {
    return this.#records.get(this.#key(ino, operation, name));
  }

  #preparedNamesForOperation(
    ino: bigint,
    operation: CfcWritebackOperation,
  ): Array<string | undefined> {
    const prefix = `${ino}:${operation}:`;
    return [...this.#prepared.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => {
        const name = key.slice(prefix.length);
        return name === "" ? undefined : name;
      });
  }

  #recordMalformed(ino: bigint, name: string, reason: string): void {
    const now = new Date().toISOString();
    const key = `malformed:${ino}:${this.#malformedCounter++}`;
    this.#records.set(key, {
      version: 1,
      key,
      status: "malformed-prepare",
      ino: ino.toString(),
      name,
      diagnostics: [reason],
      createdAt: now,
      updatedAt: now,
    });
    this.#persist();
  }

  #load(): void {
    if (!this.#storagePath) return;
    let text: string;
    try {
      text = Deno.readTextFileSync(this.#storagePath);
    } catch {
      return;
    }
    if (text.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.#recordMalformed(
        0n,
        this.#storagePath,
        "invalid recovery store JSON",
      );
      return;
    }
    if (
      !isObjectNotArray(parsed) || parsed.version !== 1 ||
      !Array.isArray(parsed.records)
    ) {
      this.#recordMalformed(
        0n,
        this.#storagePath,
        "unsupported recovery store",
      );
      return;
    }
    for (const record of parsed.records) {
      if (!isRecoveryRecord(record)) continue;
      const cloned = cloneRecoveryRecord(record, false);
      this.#records.set(cloned.key, cloned);
      if (cloned.prepared) this.#prepared.set(cloned.key, cloned.prepared);
    }
  }

  #persist(): void {
    if (!this.#storagePath) return;
    const slash = this.#storagePath.lastIndexOf("/");
    if (slash > 0) {
      Deno.mkdirSync(this.#storagePath.slice(0, slash), { recursive: true });
    }
    Deno.writeTextFileSync(
      this.#storagePath,
      canonicalCfcJsonStringify({
        version: 1,
        records: [...this.#records.values()],
      }),
    );
  }
}

function parsePreparedWriteback(value: string): CfcPreparedWriteback | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isObjectNotArray(parsed)) return null;
  if (parsed.version !== 1) return null;
  if (!isOperation(parsed.operation)) return null;
  if (typeof parsed.expectedGeneration !== "string") return null;
  if (!isObjectNotArray(parsed.target)) return null;
  if (!isObjectNotArray(parsed.labels)) return null;
  return parsed as CfcPreparedWriteback;
}

function parseFinalizedWriteback(value: string): CfcFinalizedWriteback | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isObjectNotArray(parsed)) return null;
  if (parsed.version !== 1) return null;
  if (!isOperation(parsed.operation)) return null;
  if (typeof parsed.committedGeneration !== "string") return null;
  return parsed as CfcFinalizedWriteback;
}

function preparedKeyName(
  prepared: CfcPreparedWriteback,
): string | undefined {
  if (prepared.operation === "rename-source") {
    return prepared.target.sourceName ?? prepared.target.name;
  }
  if (prepared.operation === "rename-destination") {
    return prepared.target.destinationName ?? prepared.target.name;
  }
  return prepared.target.name;
}

function primaryPreparedRef(
  prepared: CfcPreparedWriteback,
): CfcProjectionRef | undefined {
  if (prepared.operation === "rename-source") {
    return prepared.target.sourceParentRef ?? prepared.target.parentRef ??
      prepared.target.ref;
  }
  if (prepared.operation === "rename-destination") {
    return prepared.target.destinationParentRef ?? prepared.target.parentRef ??
      prepared.target.ref;
  }
  if (
    prepared.operation === "create" ||
    prepared.operation === "mkdir" ||
    prepared.operation === "unlink" ||
    prepared.operation === "rmdir" ||
    prepared.operation === "symlink"
  ) {
    return prepared.target.parentRef ?? prepared.target.ref;
  }
  return prepared.target.ref;
}

function preparedRefs(
  prepared: CfcPreparedWriteback,
): CfcProjectionRef[] {
  const refs = [
    primaryPreparedRef(prepared),
    prepared.target.ref,
    prepared.target.parentRef,
    prepared.target.sourceParentRef,
    prepared.target.destinationParentRef,
  ].filter((ref): ref is CfcProjectionRef => ref !== undefined);
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = projectionIdentityKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function projectionIdentityKey(ref: CfcProjectionRef): string {
  return canonicalCfcJsonStringify({ ...ref, generation: "" });
}

function sameProjectionIdentity(
  left: CfcProjectionRef,
  right: CfcProjectionRef,
): boolean {
  return projectionIdentityKey(left) === projectionIdentityKey(right);
}

function findPreparedNode(
  tree: FsTree,
  prepared: CfcPreparedWriteback,
): { ino: bigint; annotation: CfcNodeAnnotation } | undefined {
  const refs = preparedRefs(prepared);
  for (const [ino, node] of tree.inodes) {
    if (!node.cfc) continue;
    if (refs.some((ref) => sameProjectionIdentity(node.cfc!.ref, ref))) {
      return { ino, annotation: node.cfc };
    }
  }
  return undefined;
}

function isPreparedGeneration(generation: string): boolean {
  return generation.startsWith("prepared:sha256:");
}

function isCoherentExactAnnotation(annotation: CfcNodeAnnotation): boolean {
  return !isPreparedGeneration(annotation.generation) &&
    annotation.ref.generation === annotation.generation &&
    annotation.incomplete === undefined;
}

function applyPreparedForRecovery(
  tree: FsTree,
  ino: bigint,
  record: CfcWritebackRecoveryRecord,
): void {
  const prepared = record.prepared;
  if (!prepared) return;
  if (prepared.operation === "write" || prepared.operation === "truncate") {
    applyPreparedExistingWrite(tree, ino, prepared);
    return;
  }
  if (prepared.operation === "setattr-metadata") {
    applyPreparedMetadataMutation(
      tree,
      ino,
      prepared,
      record.requestedFields ?? prepared.target.metadataFields ??
        allMetadataLabelKeys,
    );
    return;
  }
  applyPreparedParent(tree, ino, prepared);
}

function cloneRecoveryRecord(
  record: CfcWritebackRecoveryRecord,
  frozen: boolean,
): CfcWritebackRecoveryRecord {
  return cloneIfNecessary(record as FabricValue, {
    frozen,
  }) as CfcWritebackRecoveryRecord;
}

function isRecoveryRecord(
  value: unknown,
): value is CfcWritebackRecoveryRecord {
  if (!isObjectNotArray(value)) return false;
  if (value.version !== 1) return false;
  if (typeof value.key !== "string") return false;
  if (!RECOVERY_STATUSES.includes(value.status as CfcPreparedWritebackStatus)) {
    return false;
  }
  if (!Array.isArray(value.diagnostics)) return false;
  if (typeof value.createdAt !== "string") return false;
  if (typeof value.updatedAt !== "string") return false;
  if (
    value.prepared !== undefined &&
    !parsePreparedWriteback(canonicalCfcJsonStringify(value.prepared))
  ) {
    return false;
  }
  return true;
}

function isOperation(value: unknown): value is CfcWritebackOperation {
  return value === "write" || value === "truncate" ||
    value === "create" || value === "mkdir" ||
    value === "unlink" || value === "rmdir" ||
    value === "rename-source" || value === "rename-destination" ||
    value === "symlink" || value === "setattr-metadata";
}

function preparedGeneration(prepared: CfcPreparedWriteback): string {
  return `prepared:sha256:${
    encodeHex(
      sha256(new TextEncoder().encode(canonicalCfcJsonStringify(prepared))),
    )
  }`;
}

function labelOrFail(label: CfcLabel | undefined): CfcLabel {
  return label ?? cfcFailClosedLabel();
}

function entryKindForNode(
  node: NonNullable<ReturnType<FsTree["getNode"]>>,
): CfcDirectoryEntryAnnotation["kind"] {
  if (node.kind === "dir") return "dir";
  if (node.kind === "symlink") return "symlink";
  if (node.kind === "callable") return "callable";
  return "file";
}

function entryNameForPrepared(
  prepared: CfcPreparedWriteback,
): string | undefined {
  if (prepared.operation === "rename-source") {
    return prepared.target.sourceName ?? prepared.target.name;
  }
  if (prepared.operation === "rename-destination") {
    return prepared.target.destinationName ?? prepared.target.name;
  }
  return prepared.target.name;
}

function applyPreparedEntryLabel(
  tree: FsTree,
  parentIno: bigint,
  prepared: CfcPreparedWriteback,
): void {
  const name = entryNameForPrepared(prepared);
  if (name === undefined) return;
  const childIno = tree.lookup(parentIno, name);
  if (childIno === undefined) return;
  const child = tree.getNode(childIno);
  const parent = tree.getCfcAnnotation(parentIno);
  const childAnnotation = tree.getCfcAnnotation(childIno);
  if (!child || !parent || !childAnnotation) return;
  tree.setCfcEntryAnnotation(parentIno, name, {
    name,
    nameDigest: `pending:${name}`,
    childRef: childAnnotation.ref,
    kind: entryKindForNode(child),
    nameLabel: labelOrFail(prepared.labels.nameLabel),
    existenceLabel: labelOrFail(prepared.labels.existenceLabel),
    metadataLabels: childAnnotation.metadataLabels,
  });
}

function metadataLabelsFor(
  prepared: CfcPreparedWriteback,
  primaryLabel: CfcLabel,
): CfcMetadataLabels {
  const preparedMetadata = prepared.labels.metadataLabels ?? {};
  const fallback = labelOrFail(primaryLabel);
  return {
    type: labelOrFail(preparedMetadata.type ?? fallback),
    mode: labelOrFail(preparedMetadata.mode ?? fallback),
    size: labelOrFail(preparedMetadata.size ?? fallback),
    mtime: labelOrFail(preparedMetadata.mtime ?? fallback),
    ctime: labelOrFail(preparedMetadata.ctime ?? fallback),
    generation: labelOrFail(preparedMetadata.generation ?? fallback),
    uid: labelOrFail(preparedMetadata.uid ?? fallback),
    gid: labelOrFail(preparedMetadata.gid ?? fallback),
    nlink: labelOrFail(preparedMetadata.nlink ?? fallback),
    inode: labelOrFail(preparedMetadata.inode ?? fallback),
  };
}

const allMetadataLabelKeys: CfcMetadataLabelKey[] = [
  "type",
  "mode",
  "size",
  "mtime",
  "ctime",
  "generation",
  "uid",
  "gid",
  "nlink",
  "inode",
];

function preparedMetadataLabelsForRequested(
  prepared: CfcPreparedWriteback,
  requestedFields: readonly CfcMetadataLabelKey[],
): CfcMetadataLabels {
  const preparedMetadata = prepared.labels.metadataLabels ?? {};
  const requested = new Set(requestedFields);
  const failClosed = cfcFailClosedLabel();
  const labels = {} as CfcMetadataLabels;
  for (const key of allMetadataLabelKeys) {
    labels[key] = requested.has(key)
      ? labelOrFail(preparedMetadata[key])
      : failClosed;
  }
  return labels;
}

const emptyDerivedSlots = (): CfcDerivedSlotsAnnotation => ({
  version: 1 as const,
  slots: [],
  status: "no-trusted-derived-slots" as const,
});

function preparedRef(
  ref: CfcProjectionRef,
  generation: string,
): CfcProjectionRef {
  return { ...ref, generation };
}

export function applyPreparedExistingWrite(
  tree: FsTree,
  ino: bigint,
  prepared: CfcPreparedWriteback,
): void {
  const existing = tree.getCfcAnnotation(ino);
  if (!existing) return;
  const generation = preparedGeneration(prepared);
  const contentLabel = labelOrFail(prepared.labels.contentLabel);
  tree.setCfcAnnotation(ino, {
    version: 1,
    ref: preparedRef(existing.ref, generation),
    generation,
    contentLabel,
    metadataLabels: metadataLabelsFor(prepared, contentLabel),
    namespaceLabel: existing.namespaceLabel,
    entries: existing.entries,
    derivedSlots: emptyDerivedSlots(),
    callable: existing.callable,
    symlink: existing.symlink,
    incomplete: {
      reason: "cfc writeback prepared but not finalized",
      paths: ["/" + existing.ref.path.map(String).join("/")],
    },
  });
}

export function applyPreparedMetadataMutation(
  tree: FsTree,
  ino: bigint,
  prepared: CfcPreparedWriteback,
  requestedFields: readonly CfcMetadataLabelKey[],
): void {
  const existing = tree.getCfcAnnotation(ino);
  if (!existing) return;
  const generation = preparedGeneration(prepared);
  tree.setCfcAnnotation(ino, {
    version: 1,
    ref: preparedRef(existing.ref, generation),
    generation,
    contentLabel: existing.contentLabel,
    metadataLabels: preparedMetadataLabelsForRequested(
      prepared,
      requestedFields,
    ),
    namespaceLabel: existing.namespaceLabel,
    entries: existing.entries,
    derivedSlots: emptyDerivedSlots(),
    callable: existing.callable,
    symlink: existing.symlink,
    incomplete: {
      reason: "cfc writeback prepared but not finalized",
      paths: ["/" + existing.ref.path.map(String).join("/")],
    },
  });
}

export function applyPreparedParent(
  tree: FsTree,
  parentIno: bigint,
  prepared: CfcPreparedWriteback,
): void {
  const existing = tree.getCfcAnnotation(parentIno);
  if (!existing) return;
  const generation = preparedGeneration(prepared);
  const namespaceLabel = labelOrFail(prepared.labels.namespaceLabel);
  tree.setCfcAnnotation(parentIno, {
    ...existing,
    ref: preparedRef(existing.ref, generation),
    generation,
    namespaceLabel,
    metadataLabels: metadataLabelsFor(prepared, namespaceLabel),
    incomplete: {
      reason: "cfc writeback prepared but not finalized",
      paths: ["/" + existing.ref.path.map(String).join("/")],
    },
  });
  applyPreparedEntryLabel(tree, parentIno, prepared);
}

export function applyPreparedCreate(
  tree: FsTree,
  parentIno: bigint,
  name: string,
  kind: "file" | "dir",
  prepared: CfcPreparedWriteback,
): bigint {
  applyPreparedParent(tree, parentIno, prepared);
  const childIno = kind === "dir"
    ? tree.addDir(parentIno, name, "object")
    : tree.addFile(parentIno, name, "", "string");
  const parent = tree.getCfcAnnotation(parentIno);
  if (!parent) return childIno;

  const generation = parent.generation;
  const projection: CfcProjectionKind = kind === "dir" ? "dir" : "value";
  const childRef: CfcProjectionRef = {
    ...parent.ref,
    path: [...parent.ref.path, name],
    projection,
    generation,
  };
  const contentLabel = kind === "dir"
    ? undefined
    : labelOrFail(prepared.labels.contentLabel);
  const namespaceLabel = kind === "dir"
    ? labelOrFail(prepared.labels.namespaceLabel)
    : undefined;
  const primaryLabel = contentLabel ?? namespaceLabel ?? cfcFailClosedLabel();
  const childAnnotation: CfcNodeAnnotation = {
    version: 1,
    ref: childRef,
    generation,
    contentLabel,
    namespaceLabel,
    entries: kind === "dir" ? { version: 1, entries: [] } : undefined,
    metadataLabels: metadataLabelsFor(prepared, primaryLabel),
    derivedSlots: emptyDerivedSlots(),
    incomplete: {
      reason: "cfc writeback prepared but not finalized",
      paths: ["/" + childRef.path.map(String).join("/")],
    },
  };
  tree.setCfcAnnotation(childIno, childAnnotation);
  tree.setCfcEntryAnnotation(
    parentIno,
    name,
    {
      name,
      nameDigest: `pending:${name}`,
      childRef,
      kind,
      nameLabel: labelOrFail(prepared.labels.nameLabel),
      existenceLabel: labelOrFail(prepared.labels.existenceLabel),
      metadataLabels: childAnnotation.metadataLabels,
    } satisfies CfcDirectoryEntryAnnotation,
  );
  return childIno;
}

export function applyPreparedSymlink(
  tree: FsTree,
  parentIno: bigint,
  name: string,
  target: string,
  prepared: CfcPreparedWriteback,
): bigint {
  applyPreparedParent(tree, parentIno, prepared);
  const childIno = tree.addSymlink(parentIno, name, target);
  const parent = tree.getCfcAnnotation(parentIno);
  if (!parent) return childIno;

  const generation = parent.generation;
  const childRef: CfcProjectionRef = {
    ...parent.ref,
    path: [...parent.ref.path, name],
    projection: "symlink",
    generation,
  };
  const contentLabel = labelOrFail(prepared.labels.contentLabel);
  const childAnnotation: CfcNodeAnnotation = {
    version: 1,
    ref: childRef,
    generation,
    contentLabel,
    metadataLabels: metadataLabelsFor(prepared, contentLabel),
    derivedSlots: emptyDerivedSlots(),
    symlink: {
      version: 1,
      target,
      linkTextLabel: labelOrFail(prepared.labels.linkTextLabel),
      targetIdentityLabel: labelOrFail(prepared.labels.targetIdentityLabel),
    },
    incomplete: {
      reason: "cfc writeback prepared but not finalized",
      paths: ["/" + childRef.path.map(String).join("/")],
    },
  };
  tree.setCfcAnnotation(childIno, childAnnotation);
  tree.setCfcEntryAnnotation(
    parentIno,
    name,
    {
      name,
      nameDigest: `pending:${name}`,
      childRef,
      kind: "symlink",
      nameLabel: labelOrFail(prepared.labels.nameLabel),
      existenceLabel: labelOrFail(prepared.labels.existenceLabel),
      metadataLabels: childAnnotation.metadataLabels,
    } satisfies CfcDirectoryEntryAnnotation,
  );
  return childIno;
}

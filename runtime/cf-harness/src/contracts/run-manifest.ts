import {
  buildCfcReadCeiling,
  type CfcConfClause,
  type CfcEnforcementMode,
  type CfcReadCeiling,
  type CfcReadOnExceed,
  isCfcEnforcementMode,
} from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  normalizePromptSlotBinding,
  type PromptSlotBinding,
} from "./prompt-slot.ts";

export const LOOM_RUN_MANIFEST_TYPE = "cf-harness.loom-run-manifest" as const;

export interface LoomRunManifestWorkspace {
  hostPath?: string;
  sandboxPath?: string;
  cwd?: string;
}

export interface LoomRunManifestCfc {
  enforcementMode?: CfcEnforcementMode;
  labelSource?: "loom-run-manifest";

  /**
   * The read ceiling this run's fabric session applies to every
   * `sqliteQuery` the run issues: a flat list of confidentiality clauses,
   * the shape the builtin's own `maxConfidentiality` option takes. A query
   * declaring its own ceiling is bounded by both. Absent is no ceiling —
   * the owner's whole view; an empty list is refused at normalization
   * rather than read either way.
   *
   * A v0 carrier: the ceiling is an assertion the dispatcher writes, fixed
   * at prepare time the way spec §19.6.1 has a context read bounded, and not
   * yet a posture the runtime mints from a delegation record (§19.5). The
   * field is what a delegation-record integration replaces.
   */
  maxConfidentiality?: readonly CfcConfClause[];

  /**
   * What a bounded read does with a row the ceiling does not admit when the
   * query says nothing itself: `fail` refuses the query, `skip` withholds
   * the row. Needs `maxConfidentiality` beside it.
   */
  onExceed?: CfcReadOnExceed;
}

/**
 * Validates a read ceiling written by a caller — a manifest field, a command
 * line flag — through the runner's own `buildCfcReadCeiling`, so what the
 * harness accepts is exactly what the runtime accepts, and returns the
 * frozen form. A refusal names the caller's fields, since the reader fixing
 * it is looking at those rather than at the runtime option behind them.
 *
 * @throws Error when the ceiling or its `onExceed` is malformed, or when
 * `onExceed` is given without a ceiling.
 */
export const readCeilingFromInput = (
  maxConfidentiality: unknown,
  onExceed: unknown,
  labels: { ceiling: string; onExceed: string },
): CfcReadCeiling =>
  buildCfcReadCeiling({
    cfcReadMaxConfidentiality: maxConfidentiality as
      | readonly CfcConfClause[]
      | undefined,
    cfcReadOnExceed: onExceed as CfcReadOnExceed | undefined,
  }, labels);

export const HARNESS_CREDENTIAL_OWNER_REF_TYPE =
  "cf-harness.credential-owner-ref" as const;

export interface HarnessCredentialOwnerRef {
  type: typeof HARNESS_CREDENTIAL_OWNER_REF_TYPE;
  version: 1;
  ownerKey: string;
  tenantKey?: string;
}

export const harnessCredentialOwnersEqual = (
  left: HarnessCredentialOwnerRef,
  right: HarnessCredentialOwnerRef,
): boolean =>
  left.type === right.type && left.version === right.version &&
  left.ownerKey === right.ownerKey && left.tenantKey === right.tenantKey;

export interface LoomRunManifest {
  type: typeof LOOM_RUN_MANIFEST_TYPE;
  version: 1;
  source: "loom";
  instanceId?: string;
  wishId?: string;
  parentWishId?: string;
  dispatchClass?: string;
  capabilityProfile?: string;
  model?: string;
  modelProvider?: "openai-compatible-gateway" | "openai-codex";
  modelAuthSource?:
    | "api-key"
    | "none"
    | "owner-bound-oauth"
    | "cf-harness-local-store";
  credentialOwner?: HarnessCredentialOwnerRef;

  /** Opaque digest identifying the canonical host-owned credential home. */
  harnessHomeIdentity?: string;

  workspace?: LoomRunManifestWorkspace;
  promptSlot?: PromptSlotBinding;
  cfc?: LoomRunManifestCfc;
  extra?: Record<string, unknown>;
}

export type HarnessRunManifest = LoomRunManifest;

export interface LoomLocalHostBinding {
  source: "loom";
  modelProvider: "openai-compatible-gateway" | "openai-codex";
  modelAuthSource:
    | "api-key"
    | "none"
    | "cf-harness-local-store";
  credentialOwner: HarnessCredentialOwnerRef;
  harnessHomeIdentity: string;
}

const assertOptionalBindingField = <T>(
  label: string,
  current: T | undefined,
  expected: T,
  equal: (left: T, right: T) => boolean = Object.is,
): void => {
  if (current !== undefined && !equal(current, expected)) {
    throw new Error(`Loom-local ${label} does not match the host binding`);
  }
};

/** Adds the trusted local host binding without overwriting caller metadata. */
export const bindLoomLocalRunManifest = (
  input: HarnessRunManifest | undefined,
  binding: LoomLocalHostBinding,
  model?: string,
): HarnessRunManifest => {
  assertOptionalBindingField(
    "provider",
    input?.modelProvider,
    binding.modelProvider,
  );
  assertOptionalBindingField(
    "auth source",
    input?.modelAuthSource,
    binding.modelAuthSource,
  );
  assertOptionalBindingField(
    "credential owner",
    input?.credentialOwner,
    binding.credentialOwner,
    harnessCredentialOwnersEqual,
  );
  assertOptionalBindingField(
    "harness home",
    input?.harnessHomeIdentity,
    binding.harnessHomeIdentity,
  );
  if (model !== undefined) {
    assertOptionalBindingField("model", input?.model, model);
  }
  return {
    ...(input ?? {}),
    type: LOOM_RUN_MANIFEST_TYPE,
    version: 1,
    source: "loom",
    modelProvider: binding.modelProvider,
    modelAuthSource: binding.modelAuthSource,
    credentialOwner: structuredClone(binding.credentialOwner),
    harnessHomeIdentity: binding.harnessHomeIdentity,
    ...(model !== undefined ? { model } : {}),
  };
};

const isLoomRunManifestType = (input: unknown): boolean =>
  input === undefined || input === LOOM_RUN_MANIFEST_TYPE;

const normalizeLoomRunManifestCfc = (
  input: unknown,
): LoomRunManifestCfc | undefined => {
  if (input === undefined) {
    return undefined;
  }
  if (!isObjectNotArray(input)) {
    throw new Error("run manifest cfc must be a JSON object");
  }
  if (
    input.enforcementMode !== undefined &&
    !isCfcEnforcementMode(input.enforcementMode)
  ) {
    throw new Error(
      `unsupported run manifest cfc.enforcementMode: ${
        String(input.enforcementMode)
      }`,
    );
  }
  if (
    input.labelSource !== undefined &&
    input.labelSource !== "loom-run-manifest"
  ) {
    throw new Error(
      `unsupported run manifest cfc.labelSource: ${String(input.labelSource)}`,
    );
  }
  // Validated rather than projected: a ceiling this projection dropped would
  // read as no ceiling, the widest posture there is.
  const { maxConfidentiality, onExceed } = readCeilingFromInput(
    input.maxConfidentiality,
    input.onExceed,
    {
      ceiling: "run manifest cfc.maxConfidentiality",
      onExceed: "run manifest cfc.onExceed",
    },
  );
  return {
    ...(input.enforcementMode !== undefined
      ? { enforcementMode: input.enforcementMode }
      : {}),
    ...(input.labelSource !== undefined
      ? { labelSource: input.labelSource }
      : {}),
    ...(maxConfidentiality !== undefined ? { maxConfidentiality } : {}),
    ...(onExceed !== undefined ? { onExceed } : {}),
  };
};

const normalizeCredentialOwnerRef = (
  input: unknown,
): HarnessCredentialOwnerRef | undefined => {
  if (input === undefined) return undefined;
  if (!isObjectNotArray(input)) {
    throw new Error("run manifest credentialOwner must be a JSON object");
  }
  if (
    input.type !== HARNESS_CREDENTIAL_OWNER_REF_TYPE || input.version !== 1 ||
    typeof input.ownerKey !== "string" || input.ownerKey.trim() === "" ||
    input.ownerKey.trim() !== input.ownerKey ||
    (input.tenantKey !== undefined &&
      (typeof input.tenantKey !== "string" || input.tenantKey.trim() === "" ||
        input.tenantKey.trim() !== input.tenantKey))
  ) {
    throw new Error("invalid run manifest credentialOwner reference");
  }
  return {
    type: HARNESS_CREDENTIAL_OWNER_REF_TYPE,
    version: 1,
    ownerKey: input.ownerKey,
    ...(input.tenantKey !== undefined ? { tenantKey: input.tenantKey } : {}),
  };
};

export const normalizeLoomRunManifest = (
  input: unknown,
): LoomRunManifest => {
  if (!isObjectNotArray(input)) {
    throw new Error("run manifest must be a JSON object");
  }
  if (!isLoomRunManifestType(input.type)) {
    throw new Error(
      `unsupported run manifest type: ${String(input.type)}`,
    );
  }
  if (input.version !== undefined && input.version !== 1) {
    throw new Error(
      `unsupported run manifest version: ${String(input.version)}`,
    );
  }
  if (input.source !== undefined && input.source !== "loom") {
    throw new Error(
      `unsupported run manifest source: ${String(input.source)}`,
    );
  }
  const promptSlot = input.promptSlot === undefined
    ? undefined
    : normalizePromptSlotBinding(input.promptSlot);
  const cfc = normalizeLoomRunManifestCfc(input.cfc);
  if (
    input.modelProvider !== undefined &&
    input.modelProvider !== "openai-compatible-gateway" &&
    input.modelProvider !== "openai-codex"
  ) {
    throw new Error(
      `unsupported run manifest modelProvider: ${String(input.modelProvider)}`,
    );
  }
  if (
    input.modelAuthSource !== undefined &&
    input.modelAuthSource !== "api-key" && input.modelAuthSource !== "none" &&
    input.modelAuthSource !== "owner-bound-oauth" &&
    input.modelAuthSource !== "cf-harness-local-store"
  ) {
    throw new Error(
      `unsupported run manifest modelAuthSource: ${
        String(input.modelAuthSource)
      }`,
    );
  }
  if (
    input.harnessHomeIdentity !== undefined &&
    (typeof input.harnessHomeIdentity !== "string" ||
      !/^sha256:[A-Za-z0-9._-]+$/.test(input.harnessHomeIdentity))
  ) {
    throw new Error("invalid run manifest harnessHomeIdentity");
  }
  const credentialOwner = normalizeCredentialOwnerRef(input.credentialOwner);
  return {
    ...input,
    type: LOOM_RUN_MANIFEST_TYPE,
    version: 1,
    source: "loom",
    ...(promptSlot !== undefined ? { promptSlot } : {}),
    ...(cfc !== undefined ? { cfc } : {}),
    ...(credentialOwner !== undefined ? { credentialOwner } : {}),
  } as LoomRunManifest;
};

export const parseLoomRunManifestJson = (
  text: string,
): LoomRunManifest => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `failed to parse run manifest JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return normalizeLoomRunManifest(parsed);
};

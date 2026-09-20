import {
  type HarnessLoomAuthoringConfig,
  validateLoomAuthoringConfig,
} from "./loom-authoring.ts";
import {
  type HarnessLoomRetrievalConfig,
  validateLoomRetrievalConfig,
} from "./loom-retrieval.ts";
import {
  type CfcConfClause,
  type CfcEnforcementMode,
  cfcEnforcementStrictness,
  type CfcFlowLabelsMode,
  type CfcReadOnExceed,
  clausesEqual,
  isCfcEnforcementMode,
  meetCfcObservationCeilings,
  resolveCfcDials,
} from "@commonfabric/runner/cfc";
import {
  type CfcPosture,
  MAX_ENFORCEMENT_CFC_OPTIONS,
  presetCfcOptions,
} from "@commonfabric/runner";
import type { HarnessCfcEnforcementModeSource } from "./contracts/cfc-policy-snapshot.ts";
import {
  type HarnessCredentialOwnerRef,
  harnessCredentialOwnersEqual,
  type HarnessRunManifest,
} from "./contracts/run-manifest.ts";
import type {
  HarnessAllowedSkillScript,
  HarnessSkillScriptExecutionTarget,
  HarnessSkillsRootRecord,
} from "./contracts/skill.ts";
import type { HarnessBrowserAccessLease } from "./contracts/browser-access.ts";
import type { HarnessDocsCorpusRecord } from "./contracts/docs-corpus.ts";
import { resolveHarnessDocsCorpus } from "./docs-corpus/corpus.ts";
import { resolveHarnessSkillsRoot } from "./skills/root.ts";
import type { DockerRunscSandboxConfig } from "./sandbox/types.ts";

export const DEFAULT_GATEWAY_BASE_URL = "https://llm.stage.commontools.dev/";
export const DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE =
  "enforce-strict" as const satisfies CfcEnforcementMode;
export type HarnessGatewayAuthMode = "bearer" | "none";

/**
 * The fabric session's enforcement dial names an enforcing rung: the
 * remoteClient preset already pins `enforce-strict`, so stating this dial
 * either restates that rung or lowers the session to `enforce-explicit`.
 * This is a different dial from the harness's own
 * `cfcEnforcementMode`, which governs tool policy and the sandbox — this one
 * governs the runtime the `run_pattern` tool deploys patterns into.
 */
export type HarnessFabricCfcEnforcementMode =
  | "enforce-explicit"
  | "enforce-strict";

export type HarnessFabricCfcFlowLabelsMode = CfcFlowLabelsMode;

/** Where a fabric session's flow-label rung came from. */
export type HarnessFabricCfcFlowLabelsSource =
  | "configured"
  | "posture"
  | "default";

/**
 * Connection settings for the trusted Fabric session behind the
 * `run_pattern` tool: the deployed API URL, a PKCS#8 identity keyfile path
 * on the host, and the target space (a name or a `did:key`). When present,
 * the run offers `run_pattern` in the parent tool surface; when absent, the
 * tool is unavailable. The optional CFC dials reach the session's Runtime;
 * unset means the remoteClient preset's first-party posture
 * (`enforce-strict`, flow labels persisted). `cfcPosture` opts the runtime
 * into
 * a named bundle (`MAX_ENFORCEMENT_CFC_OPTIONS` in the runner's presets);
 * the two dials still apply over it.
 */
export interface HarnessFabricSessionConfig {
  apiUrl: string;
  identityKeyPath: string;
  space: string;
  cfcEnforcementMode?: HarnessFabricCfcEnforcementMode;
  cfcFlowLabels?: HarnessFabricCfcFlowLabelsMode;
  cfcPosture?: CfcPosture;

  /**
   * The read ceiling the session's runtime bounds cell payload reads and every
   * `sqliteQuery` by
   * (`RuntimeOptions.cfcReadMaxConfidentiality`). Absent is no ceiling.
   */
  cfcReadMaxConfidentiality?: readonly CfcConfClause[];

  /** Its `onExceed` default (`RuntimeOptions.cfcReadOnExceed`). */
  cfcReadOnExceed?: CfcReadOnExceed;
}

/** Where a resolved session's read ceiling came from. */
export type HarnessFabricReadCeilingSource =
  | "none"
  | "session"
  | "run-manifest"
  | "both";

/**
 * A session config whose read ceiling has been resolved: the run manifest's
 * ceiling folded in once, by `resolveFabricSessionConfig`. The source marks
 * it as resolved, so a config handed onward — a delegating parent's, to the
 * child that shares its session — is never folded a second time, which
 * would record a ceiling the runtime does not hold.
 */
export interface ResolvedHarnessFabricSessionConfig
  extends HarnessFabricSessionConfig {
  readCeilingSource: HarnessFabricReadCeilingSource;

  /**
   * The run manifest's ceiling this config folded, when it folded one. What
   * a second resolution checks the manifest beside it against: a resolved
   * config passes through only beside the manifest it was resolved under.
   */
  manifestReadMaxConfidentiality?: readonly CfcConfClause[];

  /** The manifest's `onExceed` that was folded, when it declared one. */
  manifestReadOnExceed?: CfcReadOnExceed;
}

/**
 * Connection settings for the deployed pattern index: the base URL its
 * functions are served under. When present, the run offers `search_patterns`
 * in the tool surface and `run_pattern` accepts a `patternId` in place of
 * inline source; when absent, both are unavailable.
 *
 * Requests carry the fabric session's identity, so this configuration goes
 * with a fabric session and is refused without one.
 */
/**
 * Two read ceilings say the same thing: the same clauses, each compared
 * with the runner's structural equality, which is insensitive to the order
 * of an `anyOf`'s alternatives. Clause order is not significant either — a
 * ceiling is a conjunction — so the comparison is a multiset match, never a
 * `JSON.stringify` of the two, which would call `[A ∨ B]` and `[B ∨ A]`
 * different ceilings and refuse a resume or a session over spelling. Absent
 * equals absent only.
 */
export const readCeilingsEqual = (
  left: readonly CfcConfClause[] | undefined,
  right: readonly CfcConfClause[] | undefined,
): boolean => {
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length) return false;
  const used = new Array<boolean>(right.length).fill(false);
  for (const clause of left) {
    const at = right.findIndex((candidate, i) =>
      !used[i] && clausesEqual(clause, candidate)
    );
    if (at === -1) return false;
    used[at] = true;
  }
  return true;
};

export interface HarnessPatternIndexConfig {
  baseUrl: string;

  /**
   * Whether a pattern the model authored and ran successfully is published
   * back to the index. Absent means published as a recorded entry. `false`
   * makes the run a reader only.
   */
  publish?: boolean;

  /**
   * Whether successful authored patterns that pass the render gate are
   * offered to search immediately. Absent means recorded only:
   * discoverability is earned from later evidence. `true` is for deliberate
   * corpus seeding.
   */
  publishDiscoverable?: boolean;
}

/**
 * Connection settings for skills.sh metadata discovery and external
 * acquisition. When present, the run offers `search_skills`; a run that also
 * has a Fabric session offers `acquire_skill`.
 */
export interface HarnessSkillsShConfig {
  /** Registry origin serving the public `/api/search` route. */
  baseUrl: string;
}

export type HarnessModelProviderId =
  | "openai-compatible-gateway"
  | "openai-codex";
export type HarnessModelAuthSource =
  | "api-key"
  | "none"
  | "owner-bound-oauth"
  | "cf-harness-local-store";

interface HarnessCommonConfig {
  cwd?: string;
  model?: string;
  modelAuthSource?: HarnessModelAuthSource;
  credentialOwner?: HarnessCredentialOwnerRef;
  harnessHomeIdentity?: string;
  skillsRoot?: string;

  /** The skills tree {@link skillsRoot} names, and where it came from. */
  skillsRootRecord?: HarnessSkillsRootRecord;

  /**
   * Host directories of operator-provisioned reference material `research`
   * answers out of, and where they came from. Read-only by use: the harness
   * reads them and never writes to them, and no other path admits a document
   * into the corpus. Research can consult a configured pattern index without
   * a documentation corpus.
   */
  docsCorpus?: HarnessDocsCorpusRecord;

  /**
   * Whether a skill this run holds may have its scripts run in the sandbox.
   *
   * The operator's one decision about skill scripts, and it covers a registry
   * skill and an acquired one alike: what a script is trusted with is the
   * sandbox it runs in, which does not vary with where the skill came from.
   * Off unless set, so a run that says nothing runs none.
   *
   * {@link allowedSkillScripts} names individual scripts and remains for a
   * caller that wrote entries; a run with this set needs none.
   */
  allowSkillScripts?: boolean;

  allowedSkillScripts?: readonly HarnessAllowedSkillScript[];
  skillScriptExecutionTarget: HarnessSkillScriptExecutionTarget;
  browserAccess?: HarnessBrowserAccessLease;

  /**
   * Origins where a value materialized from a handle may be sent. Operator
   * configuration, empty or absent by default: a run that names no origin
   * cannot materialize a handle at all. The check is on the destination
   * rather than on the value because a handle's whole point is that the run
   * using it cannot see what it holds — only where it is going is knowable,
   * so that is what an operator gets to decide.
   */
  handleValueOrigins?: readonly string[];

  artifactRoot?: string;
  cfcEnforcementMode: CfcEnforcementMode;
  cfcEnforcementModeSource: HarnessCfcEnforcementModeSource;
  fabricSession?: HarnessFabricSessionConfig;
  /** Explicit host command backing; never inferred from a model input. */
  loomAuthoring?: HarnessLoomAuthoringConfig;

  /** Explicit host retrieval backing; never inferred from a model input. */
  loomRetrieval?: HarnessLoomRetrievalConfig;

  patternIndex?: HarnessPatternIndexConfig;
  skillsSh?: HarnessSkillsShConfig;
  sandbox?: DockerRunscSandboxConfig;
  runManifest?: HarnessRunManifest;
  runManifestPath?: string;
}

/** Public configuration shape retained for pre-provider gateway callers. */
export interface HarnessConfig extends HarnessCommonConfig {
  modelProvider?: HarnessModelProviderId;
  gatewayBaseUrl: string;
  gatewayAuthMode: HarnessGatewayAuthMode;
  credentialOwnerKey?: string;
}

/** Fully resolved configuration used by the engine. The fabric session is
 *  the resolved shape here and the raw one on `HarnessConfig`: the resolver's
 *  fold-once brand is its own, never a field a caller supplies. */
type ResolvedHarnessCommonConfig =
  & Omit<HarnessCommonConfig, "fabricSession">
  & { fabricSession?: ResolvedHarnessFabricSessionConfig };

export type ResolvedHarnessConfig =
  & ResolvedHarnessCommonConfig
  & (
    | {
      modelProvider: "openai-compatible-gateway";
      gatewayBaseUrl: string;
      gatewayAuthMode: HarnessGatewayAuthMode;
      credentialOwnerKey?: never;
    }
    | {
      modelProvider: "openai-codex";
      credentialOwnerKey: string;
      // Kept as inactive metadata for public API compatibility.
      gatewayBaseUrl: string;
      gatewayAuthMode: HarnessGatewayAuthMode;
    }
  );

export interface ResolveHarnessConfigOptions {
  modelProvider?: HarnessModelProviderId;
  credentialOwnerKey?: string;
  credentialOwner?: HarnessCredentialOwnerRef;
  modelAuthSource?: HarnessModelAuthSource;
  harnessHomeIdentity?: string;
  gatewayBaseUrl?: string;
  gatewayAuthMode?: HarnessGatewayAuthMode;
  gatewayAuthModeOverride?: string | HarnessGatewayAuthMode;
  cwd?: string;
  model?: string;
  skillsRoot?: string;
  skillsRootRecord?: HarnessSkillsRootRecord;
  docsCorpus?: HarnessDocsCorpusRecord;
  allowSkillScripts?: boolean;
  allowedSkillScripts?: readonly HarnessAllowedSkillScript[];
  skillScriptExecutionTarget?: HarnessSkillScriptExecutionTarget;
  browserAccess?: HarnessBrowserAccessLease;
  handleValueOrigins?: readonly string[];
  artifactRoot?: string;
  cfcEnforcementMode?: CfcEnforcementMode;

  /**
   * The mode a run this configuration continues was already at. A resume
   * passes the mode its run state recorded, which is the mode it goes on
   * executing at. It outranks a run manifest and the harness default, and
   * is outranked by anything an operator stated.
   */
  inheritedCfcEnforcementMode?: CfcEnforcementMode;
  cfcEnforcementModeOverride?: string | CfcEnforcementMode;
  fabricSession?:
    | HarnessFabricSessionConfig
    | ResolvedHarnessFabricSessionConfig;
  /** Explicit host command backing; never inferred from a model input. */
  loomAuthoring?: HarnessLoomAuthoringConfig;

  /** Explicit host retrieval backing; never inferred from a model input. */
  loomRetrieval?: HarnessLoomRetrievalConfig;

  patternIndex?: HarnessPatternIndexConfig;
  skillsSh?: HarnessSkillsShConfig;
  sandbox?: DockerRunscSandboxConfig;
  runManifest?: HarnessRunManifest;
  runManifestPath?: string;
}

const GATEWAY_AUTH_MODES: readonly HarnessGatewayAuthMode[] = [
  "bearer",
  "none",
];

export const parseCfcEnforcementMode = (
  input: string | null | undefined,
): CfcEnforcementMode | undefined =>
  isCfcEnforcementMode(input) ? input : undefined;

export const isHarnessGatewayAuthMode = (
  input: unknown,
): input is HarnessGatewayAuthMode =>
  typeof input === "string" &&
  GATEWAY_AUTH_MODES.includes(input as HarnessGatewayAuthMode);

export const isHarnessModelProviderId = (
  input: unknown,
): input is HarnessModelProviderId =>
  input === "openai-compatible-gateway" || input === "openai-codex";

export const parseHarnessGatewayAuthMode = (
  input: string | null | undefined,
): HarnessGatewayAuthMode | undefined =>
  isHarnessGatewayAuthMode(input) ? input : undefined;

/**
 * The CFC dials a fabric session config states that the session's runtime
 * preset takes. The read ceiling reaches the controller by another route.
 */
export type HarnessFabricSessionPresetCfcDials = Pick<
  HarnessFabricSessionConfig,
  "cfcEnforcementMode" | "cfcFlowLabels" | "cfcPosture"
>;

/**
 * The dials this config states, in the shape the session's runtime preset
 * takes them. A dial the config does not carry is absent here, and the preset
 * decides it.
 */
export const fabricSessionPresetCfcDials = (
  fabricSession: HarnessFabricSessionConfig,
): HarnessFabricSessionPresetCfcDials => ({
  ...(fabricSession.cfcPosture !== undefined
    ? { cfcPosture: fabricSession.cfcPosture }
    : {}),
  ...(fabricSession.cfcEnforcementMode !== undefined
    ? { cfcEnforcementMode: fabricSession.cfcEnforcementMode }
    : {}),
  ...(fabricSession.cfcFlowLabels !== undefined
    ? { cfcFlowLabels: fabricSession.cfcFlowLabels }
    : {}),
});

/**
 * The mode a fabric session enforces at, whether or not it named one.
 *
 * `presetCfcOptions` resolves the dials the config states, and the runtime's
 * own dial defaults resolve whatever the preset leaves unset. A session's
 * runtime is constructed through those same two steps over the same dials, so
 * the rung this returns is the rung it runs at. That is a rung of the whole
 * enforcement ladder, wider than the {@link HarnessFabricCfcEnforcementMode}
 * an operator may state.
 */
export const fabricSessionCfcEnforcementMode = (
  fabricSession: HarnessFabricSessionConfig,
): CfcEnforcementMode =>
  resolveCfcDials(presetCfcOptions(fabricSessionPresetCfcDials(fabricSession)))
    .cfcEnforcementMode;

/**
 * The flow-label rung a fabric session propagates at, whether or not it
 * stated one.
 *
 * `presetCfcOptions` resolves the dials the config states — the named posture
 * bundle where one is selected, then the host dial over it — and the
 * runtime's own dial defaults resolve whatever the preset leaves unset. A
 * session's runtime is constructed through those same two steps over the same
 * dials, so this is the rung it propagates at.
 */
export const fabricSessionCfcFlowLabels = (
  fabricSession: HarnessFabricSessionConfig,
): CfcFlowLabelsMode =>
  resolveCfcDials(presetCfcOptions(fabricSessionPresetCfcDials(fabricSession)))
    .cfcFlowLabels;

/**
 * Where that rung came from: `configured` when the config states the dial,
 * `posture` when the named bundle the config selected carries the dial, and
 * `default` when nothing the config states reaches this dial at all.
 *
 * The bundle is asked whether it carries the dial rather than whether it moved
 * the resolved value. A bundle naming the rung the core pin already holds
 * still supplied it, and an operator who selected that bundle is owed a record
 * saying so; comparing values instead makes the answer flip whenever the pin
 * and the bundle happen to agree, which is a fact about the pins rather than
 * about what the operator asked for.
 */
export const fabricSessionCfcFlowLabelsSource = (
  fabricSession: HarnessFabricSessionConfig,
): HarnessFabricCfcFlowLabelsSource =>
  fabricSession.cfcFlowLabels !== undefined
    ? "configured"
    : fabricSession.cfcPosture !== undefined &&
        "cfcFlowLabels" in MAX_ENFORCEMENT_CFC_OPTIONS
    ? "posture"
    : "default";

/** What the operator stated the harness's own dial to be, if anything. */
const statedCfcEnforcementMode = (
  options: Pick<
    ResolveHarnessConfigOptions,
    "cfcEnforcementModeOverride" | "cfcEnforcementMode"
  >,
): CfcEnforcementMode | undefined =>
  (typeof options.cfcEnforcementModeOverride === "string"
    ? parseCfcEnforcementMode(options.cfcEnforcementModeOverride)
    : options.cfcEnforcementModeOverride) ?? options.cfcEnforcementMode;

/**
 * Whether the session's dial decides this run's harness dial.
 *
 * Only an operator naming `enforce-strict` on the session does. The session's
 * preset pins a rung whether an operator asked for it or not, and a harness
 * loop deliberately run weaker than the pin is an ordinary configuration; a
 * loop left weaker than a session an operator raised to strict is the pair
 * nobody stated, and the one an audit reads as an enforcing run that did not
 * enforce.
 */
const fabricSessionRaisesCfcEnforcement = (
  options: Pick<
    ResolveHarnessConfigOptions,
    | "cfcEnforcementModeOverride"
    | "cfcEnforcementMode"
    | "inheritedCfcEnforcementMode"
    | "runManifest"
    | "fabricSession"
  >,
): CfcEnforcementMode | undefined => {
  if (options.fabricSession === undefined) {
    return undefined;
  }
  const session = options.fabricSession.cfcEnforcementMode;
  if (session !== "enforce-strict") {
    return undefined;
  }
  const stated = statedCfcEnforcementMode(options);
  if (
    stated !== undefined &&
    cfcEnforcementStrictness(stated) < cfcEnforcementStrictness(session)
  ) {
    // Two flags, one of them weaker, and no reading of the pair is safe: the
    // operator either meant the loop to enforce as the session does or meant
    // the session not to. Refusing names both rather than picking one.
    throw new Error(
      `--cfc-enforcement-mode ${stated} is weaker than the ${session} this run's fabric session enforces; raise it to ${session} or lower --fabric-cfc-enforcement-mode`,
    );
  }
  const otherwise = stated ??
    options.inheritedCfcEnforcementMode ??
    parseCfcEnforcementMode(options.runManifest?.cfc?.enforcementMode) ??
    DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE;
  return cfcEnforcementStrictness(session) > cfcEnforcementStrictness(otherwise)
    ? session
    : undefined;
};

/**
 * This run's harness enforcement dial. The harness loop and the session's
 * Runtime are two dial families over one run, and a harness dial that would
 * resolve below the `enforce-strict` its session enforces follows the session
 * instead: a loop weaker than the session it writes through enforces less than
 * the run claims, and says nothing about it. Both families default to
 * `enforce-strict`, so the case arises where something weaker reaches the
 * harness dial rather than on every run under a session.
 *
 * @throws Error when the operator stated a harness dial weaker than the
 * `enforce-strict` its session enforces.
 */
export const resolveCfcEnforcementMode = (
  options: Pick<
    ResolveHarnessConfigOptions,
    | "cfcEnforcementModeOverride"
    | "cfcEnforcementMode"
    | "inheritedCfcEnforcementMode"
    | "runManifest"
    | "fabricSession"
  >,
): CfcEnforcementMode => {
  const raised = fabricSessionRaisesCfcEnforcement(options);
  if (raised !== undefined) {
    return raised;
  }
  const parsedRunManifestMode = parseCfcEnforcementMode(
    options.runManifest?.cfc?.enforcementMode,
  );
  return statedCfcEnforcementMode(options) ??
    options.inheritedCfcEnforcementMode ??
    parsedRunManifestMode ??
    DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE;
};

export const resolveCfcEnforcementModeSource = (
  options: Pick<
    ResolveHarnessConfigOptions,
    | "cfcEnforcementModeOverride"
    | "cfcEnforcementMode"
    | "inheritedCfcEnforcementMode"
    | "runManifest"
    | "fabricSession"
  >,
): HarnessCfcEnforcementModeSource => {
  if (fabricSessionRaisesCfcEnforcement(options) !== undefined) {
    return "fabric-session";
  }
  const parsedOverride = typeof options.cfcEnforcementModeOverride === "string"
    ? parseCfcEnforcementMode(options.cfcEnforcementModeOverride)
    : options.cfcEnforcementModeOverride;
  if (parsedOverride != null) {
    return "override";
  }
  if (options.cfcEnforcementMode != null) {
    return "explicit-config";
  }
  if (options.inheritedCfcEnforcementMode != null) {
    return "inherited";
  }
  if (parseCfcEnforcementMode(options.runManifest?.cfc?.enforcementMode)) {
    return "run-manifest";
  }
  return "default";
};

export const normalizeGatewayBaseUrl = (input: string): string =>
  new URL(input).toString();

export const resolveGatewayAuthMode = (
  options: Pick<
    ResolveHarnessConfigOptions,
    "gatewayAuthMode" | "gatewayAuthModeOverride"
  >,
): HarnessGatewayAuthMode => {
  const parsedOverride = typeof options.gatewayAuthModeOverride === "string"
    ? parseHarnessGatewayAuthMode(options.gatewayAuthModeOverride)
    : options.gatewayAuthModeOverride;
  return parsedOverride ??
    options.gatewayAuthMode ??
    "bearer";
};

const isResolvedFabricSessionConfig = (
  config: HarnessFabricSessionConfig | ResolvedHarnessFabricSessionConfig,
): config is ResolvedHarnessFabricSessionConfig =>
  "readCeilingSource" in config;

/**
 * The stricter of two `onExceed` modes: `fail` refuses the whole query where
 * `skip` releases the fact that rows were withheld, so `fail` wins whenever
 * either side says it. Absent on both sides is absent.
 */
const meetReadOnExceed = (
  a: CfcReadOnExceed | undefined,
  b: CfcReadOnExceed | undefined,
): CfcReadOnExceed | undefined =>
  a === "fail" || b === "fail" ? "fail" : (a ?? b);

/**
 * The fabric session the run executes under, bounded by the run manifest's
 * read ceiling. A ceiling the session config carries and one the manifest
 * carries are met, so a query fits the result only if it fits both: neither
 * the operator's session nor Loom's dispatch can widen what the other
 * declared, and `onExceed` meets toward `fail` on the same terms. The fold
 * happens once: a config already resolved passes through unchanged, so a
 * child built from its parent's resolved config and the same manifest records
 * the ceiling its parent's runtime holds.
 *
 * @throws Error when the manifest declares a ceiling and the run has no
 * fabric session to apply it to — a ceiling accepted with nothing bounding
 * reads would read as working while doing nothing.
 */
export const resolveFabricSessionConfig = (
  options: Pick<ResolveHarnessConfigOptions, "fabricSession" | "runManifest">,
): ResolvedHarnessFabricSessionConfig | undefined => {
  const manifestCeiling = options.runManifest?.cfc?.maxConfidentiality;
  if (
    options.fabricSession !== undefined &&
    isResolvedFabricSessionConfig(options.fabricSession)
  ) {
    // Resolved once, and only ever beside the manifest it was resolved
    // under: a resolved config beside a manifest ceiling it never folded
    // would either run unbounded under a manifest that asked for a bound or
    // attest a ceiling that manifest never declared.
    // Compared whenever EITHER side declares one: a config folded under a
    // manifest ceiling arriving beside a manifest that now declares none
    // would attest a ceiling that manifest never carried.
    if (
      (manifestCeiling !== undefined ||
        options.fabricSession.manifestReadMaxConfidentiality !== undefined) &&
      (!readCeilingsEqual(
        options.fabricSession.manifestReadMaxConfidentiality,
        manifestCeiling,
      ) ||
        options.fabricSession.manifestReadOnExceed !==
          options.runManifest?.cfc?.onExceed)
    ) {
      throw new Error(
        "resolved fabric session did not fold the run manifest's read " +
          "ceiling beside it; resolve the session under this manifest",
      );
    }
    return options.fabricSession;
  }
  if (manifestCeiling === undefined) {
    return options.fabricSession === undefined ? undefined : {
      ...options.fabricSession,
      readCeilingSource:
        options.fabricSession.cfcReadMaxConfidentiality !== undefined
          ? "session"
          : "none",
    };
  }
  if (options.fabricSession === undefined) {
    throw new Error(
      "run manifest cfc.maxConfidentiality names a read ceiling for the " +
        "fabric session's runtime, and the run has no fabric session",
    );
  }
  const onExceed = meetReadOnExceed(
    options.fabricSession.cfcReadOnExceed,
    options.runManifest?.cfc?.onExceed,
  );
  return {
    ...options.fabricSession,
    // Snapshots, not references: the session is built lazily on the first
    // tool call, and a manifest array mutated in between must not widen
    // what that session is built under.
    cfcReadMaxConfidentiality: structuredClone(meetCfcObservationCeilings(
      options.fabricSession.cfcReadMaxConfidentiality,
      manifestCeiling,
    )) as readonly CfcConfClause[],
    ...(onExceed !== undefined ? { cfcReadOnExceed: onExceed } : {}),
    readCeilingSource:
      options.fabricSession.cfcReadMaxConfidentiality !== undefined
        ? "both"
        : "run-manifest",
    manifestReadMaxConfidentiality: structuredClone(manifestCeiling),
    ...(options.runManifest?.cfc?.onExceed !== undefined
      ? { manifestReadOnExceed: options.runManifest.cfc.onExceed }
      : {}),
  };
};

export const resolveHarnessConfig = (
  options: ResolveHarnessConfigOptions = {},
): ResolvedHarnessConfig => {
  if (options.loomAuthoring !== undefined) {
    validateLoomAuthoringConfig(options.loomAuthoring);
  }
  if (options.loomRetrieval !== undefined) {
    validateLoomRetrievalConfig(options.loomRetrieval);
  }
  const modelProvider = options.modelProvider ?? "openai-compatible-gateway";
  if (
    options.credentialOwner !== undefined &&
    options.runManifest?.credentialOwner !== undefined &&
    !harnessCredentialOwnersEqual(
      options.credentialOwner,
      options.runManifest.credentialOwner,
    )
  ) {
    throw new Error(
      "configured credential owner does not match run manifest credential owner",
    );
  }
  const credentialOwner = options.credentialOwner ??
    options.runManifest?.credentialOwner;
  const harnessHomeIdentity = options.harnessHomeIdentity ??
    options.runManifest?.harnessHomeIdentity;
  const modelAuthSource = options.modelAuthSource ??
    options.runManifest?.modelAuthSource;
  if (
    credentialOwner !== undefined && options.credentialOwnerKey !== undefined &&
    credentialOwner.ownerKey !== options.credentialOwnerKey
  ) {
    throw new Error(
      "credential owner reference does not match configured credential owner key",
    );
  }
  if (
    options.patternIndex !== undefined && options.fabricSession === undefined
  ) {
    // Index requests are signed with the fabric session's identity, and a
    // pattern taken from the index is compiled into the session's space. With
    // no session there is neither a signer nor anywhere to run what the index
    // returns, so the combination is refused rather than yielding a tool that
    // fails on its first call.
    throw new Error(
      "pattern index configuration requires a fabric session",
    );
  }
  if (
    modelProvider === "openai-codex" &&
    (options.gatewayBaseUrl !== undefined ||
      options.gatewayAuthMode !== undefined ||
      options.gatewayAuthModeOverride !== undefined)
  ) {
    throw new Error(
      "gateway URL/auth configuration cannot be combined with openai-codex",
    );
  }
  // Naming no corpus root is not the same as wanting no corpus: the default
  // is the checkout the harness runs out of, resolved here so that every
  // surface — the CLI, the console, a child engine — reaches the same answer.
  const docsCorpus = resolveHarnessDocsCorpus(options.docsCorpus);
  // The same reading for the skills tree, and for the same reason. Resolved
  // here rather than at each surface so an engine a caller constructs directly
  // — a delegated child's among them — reaches the answer the CLI and the
  // console reach. A caller that already resolved the tree hands the record
  // over, which is how a child keeps its parent's provenance instead of
  // relabelling an inherited default as something the operator configured.
  const skillsRootRecord = options.skillsRootRecord ??
    resolveHarnessSkillsRoot(options.skillsRoot);
  const fabricSession = resolveFabricSessionConfig(options);
  const common: ResolvedHarnessCommonConfig = {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(modelAuthSource !== undefined ? { modelAuthSource } : {}),
    ...(credentialOwner !== undefined ? { credentialOwner } : {}),
    ...(harnessHomeIdentity !== undefined ? { harnessHomeIdentity } : {}),
    ...(skillsRootRecord !== undefined
      ? { skillsRoot: skillsRootRecord.hostPath, skillsRootRecord }
      : {}),
    ...(docsCorpus !== undefined ? { docsCorpus } : {}),
    ...(options.allowSkillScripts === true ? { allowSkillScripts: true } : {}),
    ...(options.allowedSkillScripts !== undefined
      ? { allowedSkillScripts: options.allowedSkillScripts }
      : {}),
    skillScriptExecutionTarget: options.skillScriptExecutionTarget ?? "sandbox",
    ...(options.browserAccess !== undefined
      ? { browserAccess: options.browserAccess }
      : {}),
    ...(options.handleValueOrigins !== undefined
      ? { handleValueOrigins: options.handleValueOrigins }
      : {}),
    ...(options.artifactRoot !== undefined
      ? { artifactRoot: options.artifactRoot }
      : {}),
    ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {}),
    ...(options.runManifest !== undefined
      ? { runManifest: options.runManifest }
      : {}),
    ...(options.runManifestPath !== undefined
      ? { runManifestPath: options.runManifestPath }
      : {}),
    cfcEnforcementMode: resolveCfcEnforcementMode(options),
    cfcEnforcementModeSource: resolveCfcEnforcementModeSource(options),
    ...(fabricSession !== undefined ? { fabricSession } : {}),
    ...(options.loomAuthoring !== undefined
      ? { loomAuthoring: structuredClone(options.loomAuthoring) }
      : {}),
    ...(options.loomRetrieval !== undefined
      ? { loomRetrieval: structuredClone(options.loomRetrieval) }
      : {}),
    ...(options.patternIndex !== undefined
      ? { patternIndex: options.patternIndex }
      : {}),
    ...(options.skillsSh !== undefined ? { skillsSh: options.skillsSh } : {}),
  };
  if (modelProvider === "openai-codex") {
    return {
      ...common,
      modelProvider,
      credentialOwnerKey: options.credentialOwnerKey ??
        credentialOwner?.ownerKey ?? "local",
      gatewayBaseUrl: normalizeGatewayBaseUrl(DEFAULT_GATEWAY_BASE_URL),
      gatewayAuthMode: "bearer",
    };
  }
  return {
    ...common,
    modelProvider,
    gatewayBaseUrl: normalizeGatewayBaseUrl(
      options.gatewayBaseUrl ?? DEFAULT_GATEWAY_BASE_URL,
    ),
    gatewayAuthMode: resolveGatewayAuthMode(options),
  };
};

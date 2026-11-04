export const HARNESS_SKILL_REGISTRY_TYPE = "cf-harness.skill-registry";
export const HARNESS_SKILL_ACTIVATIONS_TYPE = "cf-harness.skill-activations";
export const HARNESS_SKILL_RESOURCE_READS_TYPE =
  "cf-harness.skill-resource-reads";
export const HARNESS_SKILL_SCRIPT_EXECUTIONS_TYPE =
  "cf-harness.skill-script-executions";

export type HarnessSkillDiagnosticSeverity = "warning" | "error";

export interface HarnessSkillDiagnostic {
  severity: HarnessSkillDiagnosticSeverity;
  code: string;
  detail: string;
  path?: string;
}

export type HarnessSkillFrontmatterValue =
  | string
  | boolean
  | readonly string[];

export type HarnessSkillResourceKind =
  | "reference"
  | "asset"
  | "template"
  | "script"
  | "other";

export type HarnessSkillResourceContentKind = "text" | "binary";

export type HarnessSkillCfcPromptRole = "context";

export type HarnessSkillScriptRuntime = "deno" | "shebang" | "unknown";
export type HarnessSkillScriptExecutionTarget = "sandbox" | "host";

export interface HarnessSkillScriptMetadata {
  executable: boolean;
  shebang?: string;
  runtime: HarnessSkillScriptRuntime;
}

export interface HarnessSkillResourceRecord {
  path: string;
  kind: HarnessSkillResourceKind;
  resourcePath: string;
  sandboxResourcePath: string;
  sizeBytes: number;
  digest: string;
  contentKind: HarnessSkillResourceContentKind;
  script?: HarnessSkillScriptMetadata;
  diagnostics: HarnessSkillDiagnostic[];
}

export interface HarnessAllowedSkillScript {
  skill: string;
  path: string;
}

export type HarnessSkillResourceReadStatus = "read" | "binary" | "error";

export type HarnessSkillResourceReadErrorCode =
  | "skill_registry_missing"
  | "skill_not_found"
  | "resource_path_invalid"
  | "resource_not_indexed"
  | "resource_not_found"
  | "resource_not_file"
  | "resource_outside_root"
  | "permission_denied"
  | "unknown";

export interface HarnessSkillResourceReadError {
  code: HarnessSkillResourceReadErrorCode;
  message: string;
}

export interface HarnessSkillResourceRead {
  type: "cf-harness.skill-resource-read";
  outputId: string;
  runId: string;
  skillName: string;
  path: string;
  status: HarnessSkillResourceReadStatus;
  readAt: string;
  cfcPromptRole: HarnessSkillCfcPromptRole;
  kind?: HarnessSkillResourceKind;
  resourcePath?: string;
  sandboxResourcePath?: string;
  registryDigest?: string;
  observedDigest?: string;
  digestMatchesRegistry?: boolean;
  registrySizeBytes?: number;
  observedSizeBytes?: number;
  contentKind?: HarnessSkillResourceContentKind;
  maxBytes?: number;
  truncated?: boolean;
  diagnostics: HarnessSkillDiagnostic[];
  error?: HarnessSkillResourceReadError;
}

export interface HarnessSkillResourceReads {
  type: typeof HARNESS_SKILL_RESOURCE_READS_TYPE;
  version: 1;
  generatedAt: string;
  reads: HarnessSkillResourceRead[];
}

export type HarnessSkillScriptExecutionStatus = "executed" | "error";

export type HarnessSkillScriptExecutionErrorCode =
  | "skill_registry_missing"
  | "skill_activations_missing"
  | "skill_not_found"
  | "skill_not_activated"
  | "script_not_mounted"
  | "script_path_invalid"
  | "script_not_allowlisted"
  | "script_not_indexed"
  | "resource_not_script"
  | "script_not_found"
  | "script_not_file"
  | "script_outside_root"
  | "script_snapshot_mismatch"
  | "unsupported_runtime"
  | "permission_denied"
  | "unknown";

export interface HarnessSkillScriptExecutionError {
  code: HarnessSkillScriptExecutionErrorCode;
  message: string;
}

export interface HarnessSkillScriptExecution {
  type: "cf-harness.skill-script-execution";
  outputId: string;
  runId: string;
  skillName: string;
  path: string;
  status: HarnessSkillScriptExecutionStatus;
  executedAt: string;
  executionTarget?: HarnessSkillScriptExecutionTarget;
  runtime?: HarnessSkillScriptRuntime;
  argv?: readonly string[];
  args?: readonly string[];
  cwd?: string;
  resourcePath?: string;
  sandboxResourcePath?: string;
  registryDigest?: string;
  observedDigest?: string;
  digestMatchesRegistry?: boolean;
  registrySizeBytes?: number;
  observedSizeBytes?: number;

  /**
   * Where an acquired script came from, absent for a registry skill's.
   *
   * An acquired script is executed through the same machinery a registry
   * script is, so the record has to say which it was: the registry fields
   * above name a run-start snapshot this script was never in, and a reader
   * that found them set would take an acquisition for a skill the operator
   * had installed. Never set beside them.
   *
   * Present once the run has resolved which acquisition the pin names, which
   * every executed script and every refusal after that point carries. A
   * refusal that could not get that far — a pin this run acquired nothing at,
   * or one it holds no handle to — has the pin in `skillName` and no
   * acquisition, because there is none to name.
   */
  acquisition?: HarnessSkillAcquisition;

  exitCode?: number;
  diagnostics: HarnessSkillDiagnostic[];
  error?: HarnessSkillScriptExecutionError;
}

export interface HarnessSkillScriptExecutions {
  type: typeof HARNESS_SKILL_SCRIPT_EXECUTIONS_TYPE;
  version: 1;
  generatedAt: string;
  executions: HarnessSkillScriptExecution[];
}

export interface HarnessSkillRecord {
  name: string;
  description: string;
  skillPath: string;
  skillDir: string;
  sandboxSkillPath: string;
  sandboxSkillDir: string;
  digest: string;
  resources: HarnessSkillResourceRecord[];
  frontmatter: Record<string, HarnessSkillFrontmatterValue>;
  diagnostics: HarnessSkillDiagnostic[];
}

/** Where the skills tree a run scanned came from. */
export type HarnessSkillsRootSource = "configured" | "checkout-default";

/**
 * The skills tree a run scanned, and how it was arrived at. A run that names
 * no tree still gets one, so which tree a child's skills came from is a fact
 * about the run rather than a restatement of the operator's flags.
 */
export interface HarnessSkillsRootRecord {
  type: "cf-harness.skills-root-record";
  source: HarnessSkillsRootSource;
  hostPath: string;
}

/** A skills-root record as an operator message names it. */
export const describeHarnessSkillsRoot = (
  record: HarnessSkillsRootRecord,
): string => `${record.source} ${record.hostPath}`;

export interface HarnessSkillRegistry {
  type: typeof HARNESS_SKILL_REGISTRY_TYPE;
  version: 1;
  skillsRoot: string;
  sandboxSkillsRoot: string;
  generatedAt: string;
  skills: HarnessSkillRecord[];
  diagnostics: HarnessSkillDiagnostic[];
}

export type HarnessSkillActivationSource =
  | "cli-preload"
  | "model-tool"
  | "user-explicit"
  | "subagent-inherit"
  | "skill-handle";

/**
 * Where a handle-delivered skill's text was fetched from, as the trusted host
 * recorded it at acquisition. Every field is host-computed or host-observed:
 * none is read out of the fetched bytes, which is what lets a reader treat
 * this as provenance rather than as a claim the skill makes about itself.
 *
 * It grants nothing. Its job is to make acting under an externally acquired
 * skill's influence a legible event, so a reader of the activation record can
 * name the commit whose bytes shaped the run.
 */
export interface HarnessSkillAcquisition {
  /** Discovery id the pin was resolved from, in `owner/repo/slug` form. */
  registryId: string;

  /** Full commit SHA of the immutable tree the bytes were read from. */
  commitSha: string;

  /** The exact pinned URL fetched. */
  sourceUrl: string;

  /** How the address was pinned. */
  verification: "git-commit-sha";

  /** Digest the host computed over the fetched bytes. */
  valueDigest: string;

  /** Host wall-clock time the bytes were received (ISO 8601). */
  receivedAt: string;
}

export interface HarnessSkillActivation {
  name: string;
  source: HarnessSkillActivationSource;
  runId: string;

  /**
   * The registry path of a directory-backed skill. This and the three paths
   * below it are absent for a `skill-handle` activation, whose text came from
   * a cell rather than a registry directory — {@link
   * HarnessSkillActivation.handleToken} carries its provenance instead.
   */
  skillPath?: string;

  /** The registry directory that path sits in. */
  skillDir?: string;

  /** The same path, as the sandbox sees it. */
  sandboxSkillPath?: string;

  /** The same directory, as the sandbox sees it. */
  sandboxSkillDir?: string;

  digest: string;
  activatedAt: string;
  cfcPromptRole: HarnessSkillCfcPromptRole;

  /**
   * The parent-held handle token a `skill-handle` activation's text was
   * materialized through. With {@link digest} it says which reference
   * supplied the skill and the exact text it resolved to at activation time —
   * the whole provenance for a handle the harness did not fetch. Where the
   * handle came from an acquisition, {@link HarnessSkillActivation.acquisition}
   * carries the rest of it, and a reader after the external source wants that
   * field rather than this one.
   */
  handleToken?: string;

  /**
   * Where the skill text came from, for a `skill-handle` activation whose
   * handle was minted by an external acquisition. Absent when the handle
   * names a cell this harness did not fetch — an operator-seeded skill cell,
   * say — where there is no external source to name.
   */
  acquisition?: HarnessSkillAcquisition;
}

export const HARNESS_ACQUIRED_SKILLS_TYPE = "cf-harness.acquired-skills";

/**
 * One script of an acquired skill, materialized on the host so a run can
 * execute it.
 *
 * `valueDigest` is taken at acquisition, over the bytes the pinned commit
 * served, and it is what an execution re-checks the file against — the same
 * pin a registry script gets from the run-start registry snapshot. A file
 * changed on the host between acquisition and execution refuses.
 */
export interface HarnessAcquiredSkillScript {
  /** Path relative to the skill root, as an allowlist entry names it. */
  path: string;

  /** Where the host holds the bytes. */
  hostPath: string;

  /** The same file, as the sandbox that may run it sees it. */
  sandboxPath: string;

  valueDigest: string;
  sizeBytes: number;
}

/**
 * The scripts one acquisition materialized, under the pin they came from.
 *
 * The pin is the allowlist key's skill field, so what an operator allowlisted
 * and what a run resolves are the same string. The host root is mounted
 * read-only, and only into the sandbox of a run that holds the skill's handle:
 * the parent that planned the acquisition never holds the skill's bytes, and
 * that is the property the demo rests on.
 */
export interface HarnessAcquiredSkill {
  /** Discovery id, in `owner/repo/slug` form. */
  registryId: string;

  commitSha: string;

  /** `registryId@commitSha`, which is what an allowlist entry names. */
  pin: string;

  /** The host directory holding this acquisition's `scripts/`. */
  hostRoot: string;

  /** The same directory, as a run that mounts it sees it. */
  sandboxRoot: string;

  scripts: HarnessAcquiredSkillScript[];
}

/** Every skill this run acquired scripts for. */
export interface HarnessAcquiredSkills {
  type: typeof HARNESS_ACQUIRED_SKILLS_TYPE;
  version: 1;
  generatedAt: string;
  skills: HarnessAcquiredSkill[];
}

export interface HarnessSkillActivations {
  type: typeof HARNESS_SKILL_ACTIVATIONS_TYPE;
  version: 1;
  generatedAt: string;
  activations: HarnessSkillActivation[];
}

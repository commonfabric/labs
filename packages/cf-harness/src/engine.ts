import type {
  LoomAuthoringToolOutput,
  LoomComposeToolInput,
  LoomReadToolInput,
} from "./tools/loom-authoring.ts";
import type {
  LoomCalendarListInput,
  LoomContextInput,
  LoomPageDiscoverInput,
  LoomPageTargetInput,
  LoomPeopleInput,
  LoomProfileInput,
  LoomSearchInput,
} from "./loom-retrieval.ts";
import type { JSONSchema } from "@commonfabric/api";
import type { LoomRetrievalToolOutput } from "./tools/loom-retrieval.ts";
import type {
  SubmitResultInput,
  SubmitResultOutput,
} from "./tools/submit-result.ts";
import {
  dirname,
  join as joinHostPath,
  normalize as normalizeHostPath,
  relative as relativeHostPath,
} from "@std/path";
import { normalize as normalizeSandboxPath } from "@std/path/posix";

import {
  type CfcConfClause,
  type CfcLabelView,
  type CfcPostureReport,
  type IFCLabel,
  inheritedCfcPostureReport,
  mergeCfcLabelViews,
} from "@commonfabric/runner/cfc";
import { mergeLabel } from "@commonfabric/runner/cfc/label-view-core";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectOrArray } from "@commonfabric/utils/types";

import {
  createFileSystemHarnessArtifactStore,
  type HarnessArtifactStore,
} from "./artifacts.ts";
import {
  fabricSessionCfcEnforcementMode,
  fabricSessionCfcFlowLabels,
  fabricSessionCfcFlowLabelsSource,
  type HarnessConfig,
  type ResolvedHarnessConfig,
  resolveHarnessConfig,
  type ResolveHarnessConfigOptions,
} from "./config.ts";
import { harnessFabricSessionPosture } from "./cfc-posture.ts";
import {
  type HarnessDocsCorpus,
  loadHarnessDocsCorpus,
} from "./docs-corpus/corpus.ts";
import type { HarnessResearchRunner } from "./research/runner.ts";
import type { HarnessToolContext } from "./tools/types.ts";
import type { HarnessDocsCorpusRecord } from "./contracts/docs-corpus.ts";
import type { HarnessResearchRunSummary } from "./contracts/research.ts";
import {
  createHarnessCfcInvocationContext,
  createHarnessPromptSlotInfluenceLabels,
  type HarnessCfcInvocationContext,
  type HarnessCfcInvocationInputLabelPath,
  type HarnessCfcInvocationOperation,
  summarizeCfcInvocationRunManifest,
} from "./contracts/cfc-invocation-context.ts";
import {
  createHarnessCfcModelContextInputLabels,
  type HarnessCfcModelContext,
  type HarnessCfcModelContextObservationInput,
} from "./contracts/cfc-model-context.ts";
import type { HarnessCfcPolicySnapshot } from "./contracts/cfc-policy-snapshot.ts";
import type {
  HarnessHandleReferent,
  HarnessHandleTable,
} from "./contracts/handle-table.ts";
import {
  createHarnessPolicyDecisionRecord,
  type HarnessPolicyDecisionRecord,
  type HarnessPolicyTrace,
} from "./contracts/policy-trace.ts";
import {
  createHarnessPolicyEvent,
  type HarnessPolicyEvent,
} from "./contracts/policy.ts";
import type { PromptSlotBinding } from "./contracts/prompt-slot.ts";
import { harnessCredentialOwnersEqual } from "./contracts/run-manifest.ts";
import type { HarnessRunReport } from "./contracts/run-report.ts";
import { HARNESS_ACQUIRED_SKILLS_TYPE } from "./contracts/skill.ts";
import type {
  HarnessAcquiredSkill,
  HarnessAcquiredSkills,
  HarnessAcquiredSkillScript,
  HarnessSkillAcquisition,
  HarnessSkillActivations,
  HarnessSkillRegistry,
  HarnessSkillResourceRead,
  HarnessSkillScriptExecution,
} from "./contracts/skill.ts";
import type {
  HarnessSubagentLineage,
  HarnessSubagentResumeContext,
  HarnessSubagentRunRef,
} from "./contracts/subagent.ts";
import {
  type DelegateTaskToolInput,
  type DelegateTaskToolOutput,
} from "./contracts/subagent.ts";
import type { BuiltinToolId } from "./contracts/tool-descriptor.ts";
import {
  createToolResultRef,
  type ToolOutputId,
  type ToolResultRef,
} from "./contracts/tool-result.ts";
import type { HarnessTranscriptMessage } from "./contracts/transcript.ts";
import { harnessResumeRefusal } from "./control-errors.ts";
import {
  classifyBuiltinToolFailure,
  classifyHarnessPolicyEventFailure,
  classifyHarnessRunError,
  type ClassifyHarnessRunErrorOptions,
  collectHarnessCapabilitySnapshot,
  createHarnessFailureRecord,
  type HarnessFailureRecord,
} from "./diagnostics.ts";
import {
  cacheHarnessFabricSessionFactory,
  createHarnessFabricSessionFactory,
  type HarnessFabricSessionFactory,
} from "./fabric-session.ts";
import {
  assertValidHarnessHandleTable,
  createHarnessHandleTable,
  mintAddressHandle,
  mintReferentHandle,
} from "./handle-table.ts";
import {
  cacheHarnessPatternIndexClientFactory,
  createHarnessPatternIndexClientFactory,
  type HarnessPatternIndexClientFactory,
} from "./pattern-index/client.ts";
import {
  createPatternIndexLedger,
  type PatternIndexLedger,
} from "./pattern-index/ledger.ts";
import {
  cacheHarnessSkillsShAcquisitionClientFactory,
  createHarnessSkillsShAcquisitionClientFactory,
  type HarnessSkillsShAcquisitionClientFactory,
} from "./skills-sh/acquisition.ts";
import {
  cacheHarnessSkillsShSearchClientFactory,
  createHarnessSkillsShSearchClientFactory,
  type HarnessSkillsShSearchClientFactory,
} from "./skills-sh/search-client.ts";
import type { HandleValueResolutionContext } from "./tools/handle-values.ts";
import type {
  ResolvePieceToolInput,
  ResolvePieceToolOutput,
} from "./tools/resolve-piece.ts";
import type {
  HarnessConnectorGrantSpec,
  HarnessWellKnownGrant,
} from "./contracts/well-known-grants.ts";
import {
  checkRecordedWellKnownGrant,
  mintWellKnownGrants,
  resolveWellKnownGrantRefs,
} from "./well-known-grants.ts";
import type {
  HarnessInputCell,
  HarnessInputCellSpec,
} from "./contracts/input-cells.ts";
import { mintInputCellHandles } from "./input-cells.ts";
import type { HarnessAssignedPiece } from "./contracts/assigned-piece.ts";
import { resolvePieceAddress } from "@commonfabric/piece";
import type {
  HarnessPatternRef,
  HarnessPatternRefSpec,
} from "./contracts/pattern-refs.ts";
import { resolvePatternRefs } from "./pattern-refs.ts";
import {
  addHarnessDocsQueryFailures,
  addHarnessResearchFailures,
  appendHarnessCfcModelContextObservations,
  appendHarnessFailureRecord,
  appendHarnessResearchRun,
  appendToHarnessRunState,
  createHarnessRunState,
  type HarnessOpeningResearch,
  type HarnessRunState,
  type HarnessRunTerminalReason,
  isTerminalHarnessRunStatus,
  patchHarnessRunState,
  setHarnessOpeningResearch,
  setHarnessRunStatus,
  setHarnessSubagentRun,
} from "./run-state.ts";
import {
  assertDockerRunscCfcTransportForMode,
  DockerRunscSandboxRuntime,
  resolveDockerRunscSandboxConfig,
} from "./sandbox/docker-runsc.ts";
import {
  DenoProcessRunner,
  type ProcessRunner,
} from "./sandbox/process-runner.ts";
import type {
  DockerRunscAdditionalMountConfig,
  DockerRunscSandboxConfig,
  SandboxRuntime,
  SandboxRuntimeMountDescription,
} from "./sandbox/types.ts";
import {
  ACQUIRED_SKILL_MOUNT_PATH,
  AcquiredSkillDirectoryReadableError,
} from "./skills/acquired-skill-mount.ts";
import { type BashToolInput, type BashToolOutput } from "./tools/bash.ts";
import type {
  AcquireSkillToolInput,
  AcquireSkillToolOutput,
} from "./tools/acquire-skill.ts";
import {
  type BrowserToolInput,
  type BrowserToolOutput,
} from "./tools/browser.ts";
import {
  type DescribeHandleToolInput,
  type DescribeHandleToolOutput,
} from "./tools/describe-handle.ts";
import {
  type EditFileToolInput,
  type EditFileToolOutput,
} from "./tools/edit-file.ts";
import type { FinishTaskInput, FinishTaskOutput } from "./tools/finish-task.ts";
import {
  type ReadFileToolInput,
  type ReadFileToolOutput,
} from "./tools/read-file.ts";
import {
  type ReadSkillResourceToolInput,
  type ReadSkillResourceToolOutput,
} from "./tools/read-skill-resource.ts";
import type {
  RecordFeedbackToolInput,
  RecordFeedbackToolOutput,
} from "./tools/record-feedback.ts";
import { getBuiltinTool } from "./tools/registry.ts";
import type {
  ReadPieceSourceToolInput,
  ReadPieceSourceToolOutput,
  RevisePieceToolInput,
  RevisePieceToolOutput,
} from "./tools/piece-source.ts";
import {
  type RunPatternToolInput,
  type RunPatternToolOutput,
} from "./tools/run-pattern.ts";
import type {
  AssignSlugToolInput,
  AssignSlugToolOutput,
} from "./tools/assign-slug.ts";
import {
  type RunSkillScriptToolInput,
  type RunSkillScriptToolOutput,
} from "./tools/run-skill-script.ts";
import type {
  SearchPatternsToolInput,
  SearchPatternsToolOutput,
} from "./tools/search-patterns.ts";
import type {
  SearchSkillsToolInput,
  SearchSkillsToolOutput,
} from "./tools/search-skills.ts";
import {
  type ResearchToolInput,
  type ResearchToolOutput,
} from "./tools/research.ts";
import {
  type ViewImageToolInput,
  type ViewImageToolOutput,
} from "./tools/view-image.ts";
import {
  type WebFetchToolInput,
  type WebFetchToolOutput,
} from "./tools/web-fetch.ts";
import {
  type WriteFileToolInput,
  type WriteFileToolOutput,
} from "./tools/write-file.ts";

export interface BuiltinToolInputMap {
  bash: BashToolInput;
  browser: BrowserToolInput;
  read_file: ReadFileToolInput;
  view_image: ViewImageToolInput;
  web_fetch: WebFetchToolInput;
  read_skill_resource: ReadSkillResourceToolInput;
  run_skill_script: RunSkillScriptToolInput;
  edit_file: EditFileToolInput;
  write_file: WriteFileToolInput;
  delegate_task: DelegateTaskToolInput;
  run_pattern: RunPatternToolInput;
  read_piece_source: ReadPieceSourceToolInput;
  revise_piece: RevisePieceToolInput;
  assign_slug: AssignSlugToolInput;
  resolve_piece: ResolvePieceToolInput;
  describe_handle: DescribeHandleToolInput;
  finish_task: FinishTaskInput;
  search_patterns: SearchPatternsToolInput;
  record_feedback: RecordFeedbackToolInput;
  search_skills: SearchSkillsToolInput;
  acquire_skill: AcquireSkillToolInput;
  research: ResearchToolInput;
  loom_compose: LoomComposeToolInput;
  loom_inspect: LoomReadToolInput;
  loom_authoring_context: LoomReadToolInput;
  loom_search: LoomSearchInput;
  loom_page_discover: LoomPageDiscoverInput;
  loom_page_inspect: LoomPageTargetInput;
  loom_page_read: LoomPageTargetInput;
  loom_people: LoomPeopleInput;
  loom_calendar_list: LoomCalendarListInput;
  loom_context: LoomContextInput;
  loom_profile: LoomProfileInput;
  submit_result: SubmitResultInput;
}

export interface BuiltinToolOutputMap {
  bash: BashToolOutput;
  browser: BrowserToolOutput;
  read_file: ReadFileToolOutput;
  view_image: ViewImageToolOutput;
  web_fetch: WebFetchToolOutput;
  read_skill_resource: ReadSkillResourceToolOutput;
  run_skill_script: RunSkillScriptToolOutput;
  edit_file: EditFileToolOutput;
  write_file: WriteFileToolOutput;
  delegate_task: DelegateTaskToolOutput;
  run_pattern: RunPatternToolOutput;
  read_piece_source: ReadPieceSourceToolOutput;
  revise_piece: RevisePieceToolOutput;
  assign_slug: AssignSlugToolOutput;
  resolve_piece: ResolvePieceToolOutput;
  describe_handle: DescribeHandleToolOutput;
  finish_task: FinishTaskOutput;
  search_patterns: SearchPatternsToolOutput;
  record_feedback: RecordFeedbackToolOutput;
  search_skills: SearchSkillsToolOutput;
  acquire_skill: AcquireSkillToolOutput;
  research: ResearchToolOutput;
  loom_compose: LoomAuthoringToolOutput;
  loom_inspect: LoomAuthoringToolOutput;
  loom_authoring_context: LoomAuthoringToolOutput;
  loom_search: LoomRetrievalToolOutput;
  loom_page_discover: LoomRetrievalToolOutput;
  loom_page_inspect: LoomRetrievalToolOutput;
  loom_page_read: LoomRetrievalToolOutput;
  loom_people: LoomRetrievalToolOutput;
  loom_calendar_list: LoomRetrievalToolOutput;
  loom_context: LoomRetrievalToolOutput;
  loom_profile: LoomRetrievalToolOutput;
  submit_result: SubmitResultOutput;
}

interface ToolOutputWithId {
  outputId: string;
}

/** A structured-result schema and the host path its JSON file is kept at. */
export interface HarnessStructuredResultTarget {
  schema: JSONSchema;
  path: string;
}

export interface CreateHarnessEngineOptions
  extends ResolveHarnessConfigOptions {
  runId?: string;
  runState?: HarnessRunState;

  /**
   * The acquired skills this run may execute scripts of, handed to a child by
   * its delegating parent. A child receives the one its `skillHandle` names
   * and no other: a run holds the scripts of the skill it was given.
   */
  acquiredSkills?: HarnessAcquiredSkills;

  lineage?: HarnessSubagentLineage;
  subagentResumeContext?: HarnessSubagentResumeContext;
  workspaceHostPath?: string;
  sandboxImage?: string;
  sandboxDockerRuntime?: string;
  additionalMounts?: readonly DockerRunscAdditionalMountConfig[];
  cfcResultDir?: string;
  cfcInvocationContextDir?: string;
  sandboxRuntime?: SandboxRuntime;
  artifactStore?: HarnessArtifactStore;
  processRunner?: ProcessRunner;

  /**
   * Injection seam for the `run_pattern` fabric session, mirroring how
   * `sandboxRuntime` replaces the engine-built sandbox. When absent, a
   * factory is built from `fabricSession` in the resolved config; when both
   * are absent, `run_pattern` and `acquire_skill` have no session and stay out
   * of the parent tool surface.
   */
  fabricSessionFactory?: HarnessFabricSessionFactory;

  /**
   * The posture record of the run whose fabric session `fabricSessionFactory`
   * hands this one — a delegating parent's, for the child that shares it.
   *
   * Only a caller that knows the injected factory returns a session it
   * already published a record for can supply this; a host injecting a
   * session this engine knows nothing about has no record to pass and its run
   * publishes none. Ignored when no factory is injected, because the config
   * then describes the session this engine builds and the record comes from
   * it.
   */
  inheritedFabricSessionPosture?: CfcPostureReport;

  /**
   * Parent research retained verbatim for a delegated child. These are
   * admitted kits and host-confirmed records, not the private read transcript.
   */
  inheritedResearchRuns?: readonly HarnessResearchRunSummary[];

  /** Root user goal retained across follow-up questions and delegated tasks. */
  researchGoal?: string;

  /** Parent model-context labels retained by a newly delegated child. */
  inheritedCfcModelContext?: HarnessCfcModelContext;

  /**
   * Injection seam for the render gate's probe runtime, mirroring
   * `fabricSessionFactory`: a test supplies one to see what the gate opens
   * the probe under. When absent, the gate opens a real isolated runtime.
   */
  openProbeRuntime?: HarnessToolContext["openProbeRuntime"];

  /**
   * Injection seam for the pattern-index client, mirroring
   * `fabricSessionFactory`. When absent, a factory is built from
   * `patternIndex` in the resolved config; when both are absent, the run has
   * no index — `search_patterns` stays out of the tool surface and
   * `run_pattern` refuses a `patternId`.
   */
  patternIndexClientFactory?: HarnessPatternIndexClientFactory;

  /**
   * Injection seam for skills.sh discovery. When absent, a factory is built
   * from `skillsSh` in the resolved config; when both are absent,
   * `search_skills` stays out of the tool surface. Pinned acquisition has its
   * own fetch seam below because it is a separate effect.
   */
  skillsShSearchClientFactory?: HarnessSkillsShSearchClientFactory;

  /**
   * Injection seam for pinned external-skill acquisition. Production builds
   * it whenever `skillsSh` is configured; tests may replace the host fetch.
   */
  skillsShAcquisitionClientFactory?: HarnessSkillsShAcquisitionClientFactory;

  /**
   * What this run was asked to do, in the words it was asked in — the CLI
   * prompt for a parent run, the delegated goal for a subagent. A pattern
   * published from this run carries it as the request the pattern answers,
   * which is what the index ranks a search against. Absent when the run has
   * no single such text, and nothing invents one.
   */
  taskText?: string;

  /**
   * The structured result this run ends on: the schema it is validated
   * against and the host path of the JSON file that holds it. Configured, the
   * run offers `submit_result`, which writes that file host-side; the model
   * writing the file itself stays a second way to the same place. A subagent
   * run takes none: the result is the root run's to return.
   */
  structuredResult?: HarnessStructuredResultTarget;

  /**
   * Host-supplied attachments or session-retained targets to mint handles for
   * at run start; see `establishInputCells`. Requires a fabric session — the
   * cells live in its space.
   */
  inputCells?: readonly HarnessInputCellSpec[];

  /**
   * Connector handles to grant at run start, beside the fixed well-known
   * grants; see `establishWellKnownGrants`. The console resolves these off
   * the loom instance it was launched against, so every run on that console
   * holds them without a caller attaching anything.
   */
  connectorGrants?: readonly HarnessConnectorGrantSpec[];

  /**
   * Published patterns to resolve against the index at run start; see
   * `establishPatternRefs`. Requires a pattern index — the ids name entries
   * it holds.
   */
  patternRefs?: readonly HarnessPatternRefSpec[];

  /**
   * The space database the run's cell-label snapshot reads as it ends, for a
   * host where the store is not where the discovery walk looks. Absent, the
   * space named by the fabric session is resolved against the caches on this
   * host.
   */
  spaceDbPath?: string;

  now?: () => string;
}

export interface BuiltinToolInvocationResult<
  TToolId extends BuiltinToolId,
> {
  output: BuiltinToolOutputMap[TToolId];
  resultRef: ToolResultRef;
  runState: HarnessRunState;
}

const isToolOutputWithId = (value: unknown): value is ToolOutputWithId =>
  isObjectOrArray(value) &&
  "outputId" in value &&
  typeof value.outputId === "string";

interface ResolveSandboxConfigOptions {
  workspaceHostPath?: string;
  sandboxImage?: string;
  sandboxDockerRuntime?: string;
  additionalMounts?: readonly DockerRunscAdditionalMountConfig[];
  cfcResultDir?: string;
  cfcInvocationContextDir?: string;
}

const resolveSandboxConfig = (
  config: HarnessConfig,
  options: ResolveSandboxConfigOptions,
): DockerRunscSandboxConfig => {
  if (config.sandbox !== undefined) {
    return config.sandbox;
  }
  if (options.workspaceHostPath === undefined) {
    throw new Error(
      "sandbox config is required when no workspaceHostPath default is provided",
    );
  }
  return resolveDockerRunscSandboxConfig({
    workspaceHostPath: options.workspaceHostPath,
    ...(options.sandboxImage !== undefined
      ? { image: options.sandboxImage }
      : {}),
    ...(options.sandboxDockerRuntime !== undefined
      ? { runtimeName: options.sandboxDockerRuntime }
      : {}),
    ...(options.additionalMounts !== undefined &&
        options.additionalMounts.length > 0
      ? { additionalMounts: options.additionalMounts }
      : {}),
    ...(options.cfcResultDir !== undefined
      ? { cfcResultDir: options.cfcResultDir }
      : {}),
    ...(options.cfcInvocationContextDir !== undefined
      ? { cfcInvocationContextDir: options.cfcInvocationContextDir }
      : {}),
  });
};

const resolveInitialCurrentDir = (
  sandbox: SandboxRuntime,
  config: HarnessConfig,
  runState?: HarnessRunState,
): string => {
  if (runState !== undefined) {
    if (runState.currentDir === undefined) {
      throw harnessResumeRefusal(
        "run state is missing currentDir; older cf-harness runs cannot be resumed",
      );
    }
    return runState.currentDir;
  }
  if (config.cwd !== undefined) {
    return sandbox.resolvePath(config.cwd);
  }
  return sandbox.defaultWorkingDirectory();
};

const normalizeSandboxRoot = (path: string): string => {
  const normalized = normalizeSandboxPath(path);
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
};

const isHostPathWithinRoot = (root: string, path: string): boolean => {
  const relativePath = relativeHostPath(
    normalizeHostPath(root),
    normalizeHostPath(path),
  );
  return relativePath === "" ||
    (!relativePath.startsWith("..") && !relativePath.startsWith("/"));
};

const isSandboxPathWithinRoot = (root: string, path: string): boolean => {
  const normalizedRoot = normalizeSandboxRoot(root);
  const normalizedPath = normalizeSandboxRoot(path);
  return normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`);
};

type HostSandboxMount = {
  kind: string;
  name?: string;
  hostPath: string;
  sandboxPath: string;
  readOnly?: boolean;
};

export class CfHarnessEngine {
  readonly config: ResolvedHarnessConfig;
  readonly sandbox: SandboxRuntime;
  readonly artifactStore?: HarnessArtifactStore;
  readonly hostProcessRunner: ProcessRunner;
  readonly workspaceHostPath?: string;
  readonly workspaceMountPath: string;

  #runState: HarnessRunState;
  #outputSequence: number;
  readonly #now: () => string;
  readonly #fabricSessionFactory?: HarnessFabricSessionFactory;
  readonly #openProbeRuntime?: HarnessToolContext["openProbeRuntime"];
  readonly #patternIndexClientFactory?: HarnessPatternIndexClientFactory;
  readonly #skillsShSearchClientFactory?: HarnessSkillsShSearchClientFactory;
  readonly #skillsShAcquisitionClientFactory?:
    HarnessSkillsShAcquisitionClientFactory;
  #docsCorpus?: Promise<HarnessDocsCorpus>;
  #researchRunner?: HarnessResearchRunner;
  #patternIndexLedger?: PatternIndexLedger;
  readonly #taskText?: string;
  readonly #structuredResult?: HarnessStructuredResultTarget;
  #structuredResultRecorded = false;
  readonly #inputCells: readonly HarnessInputCellSpec[];
  readonly #connectorGrants: readonly HarnessConnectorGrantSpec[];
  readonly #patternRefs: readonly HarnessPatternRefSpec[];
  readonly #spaceDbPath?: string;
  readonly #hostMounts: readonly HostSandboxMount[];
  readonly #ownedRunscConfig?: DockerRunscSandboxConfig;
  readonly #resumedRun: boolean;
  #runModelBound: boolean;
  #cfcTransportChecked = false;

  constructor(options: CreateHarnessEngineOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#resumedRun = options.runState !== undefined;
    this.#runModelBound = this.#resumedRun;
    const resumedLineage = options.runState?.lineage;
    if (resumedLineage !== undefined) {
      const resumeContext = options.subagentResumeContext;
      if (resumeContext === undefined) {
        throw harnessResumeRefusal(
          `resumed subagent run ${
            options.runState!.runId
          } requires trusted parent resume context`,
        );
      }
      if (
        resumeContext.type !== "cf-harness.subagent-resume-context" ||
        resumeContext.version !== 1 ||
        resumeContext.rootRunId !== resumedLineage.rootRunId ||
        resumeContext.parentRunId !== resumedLineage.parentRunId ||
        resumeContext.parentToolCallId !== resumedLineage.parentToolCallId
      ) {
        throw harnessResumeRefusal(
          `resumed subagent run ${
            options.runState!.runId
          } does not match trusted parent resume context`,
        );
      }
    }
    const recordedProvider = options.runState?.modelProvider ??
      "openai-compatible-gateway";
    if (
      options.runState !== undefined && options.modelProvider !== undefined &&
      options.modelProvider !== recordedProvider
    ) {
      throw harnessResumeRefusal(
        `resumed run provider ${recordedProvider} does not match requested provider ${options.modelProvider}`,
      );
    }
    if (
      options.runState !== undefined && recordedProvider === "openai-codex" &&
      options.model !== undefined && options.runState.model !== undefined &&
      options.model !== options.runState.model
    ) {
      throw harnessResumeRefusal(
        `resumed openai-codex run model ${options.runState.model} does not match requested model ${options.model}`,
      );
    }
    const recordedOwner = options.runState?.credentialOwner ??
      options.runState?.runManifest?.credentialOwner;
    const requestedOwner = options.credentialOwner ??
      options.runManifest?.credentialOwner;
    if (
      options.runState !== undefined && recordedOwner !== undefined &&
      requestedOwner !== undefined &&
      !harnessCredentialOwnersEqual(recordedOwner, requestedOwner)
    ) {
      throw harnessResumeRefusal(
        "resumed run credential owner does not match requested credential owner",
      );
    }
    const recordedHomeIdentity = options.runState?.harnessHomeIdentity ??
      options.runState?.runManifest?.harnessHomeIdentity;
    const requestedHomeIdentity = options.harnessHomeIdentity ??
      options.runManifest?.harnessHomeIdentity;
    if (
      options.runState !== undefined && recordedHomeIdentity !== undefined &&
      requestedHomeIdentity !== undefined &&
      recordedHomeIdentity !== requestedHomeIdentity
    ) {
      throw harnessResumeRefusal(
        "resumed run harness home does not match requested harness home",
      );
    }
    const recordedAuthSource = options.runState?.modelAuthSource ??
      options.runState?.runManifest?.modelAuthSource;
    const requestedAuthSource = options.modelAuthSource ??
      options.runManifest?.modelAuthSource;
    if (
      options.runState !== undefined && recordedAuthSource !== undefined &&
      requestedAuthSource !== undefined &&
      recordedAuthSource !== requestedAuthSource
    ) {
      throw harnessResumeRefusal(
        "resumed run model auth source does not match requested model auth source",
      );
    }
    if (
      options.runState !== undefined && recordedProvider === "openai-codex" &&
      options.runState.credentialOwnerKey !== undefined &&
      options.credentialOwnerKey !== undefined &&
      options.credentialOwnerKey !== options.runState.credentialOwnerKey
    ) {
      throw harnessResumeRefusal(
        "resumed openai-codex run credential owner key does not match requested credential owner key",
      );
    }
    if (
      options.runState !== undefined &&
      options.runState.cfcEnforcementMode === undefined
    ) {
      throw harnessResumeRefusal(
        "run state is missing cfcEnforcementMode; older cf-harness runs cannot be resumed",
      );
    }
    if (options.runState?.handleTable !== undefined) {
      assertValidHarnessHandleTable(options.runState.handleTable);
    }
    this.config = resolveHarnessConfig({
      ...options,
      modelProvider: options.runState === undefined
        ? options.modelProvider
        : recordedProvider,
      ...(options.runState !== undefined && recordedProvider === "openai-codex"
        ? {
          credentialOwnerKey: options.runState.credentialOwnerKey ??
            options.credentialOwnerKey,
        }
        : {}),
      // A resumed run goes on executing at the mode it recorded, so that
      // mode is what this resolution inherits.
      ...(options.runState !== undefined
        ? { inheritedCfcEnforcementMode: options.runState.cfcEnforcementMode }
        : {}),
      ...(options.runState !== undefined && recordedOwner !== undefined
        ? { credentialOwner: recordedOwner }
        : {}),
      ...(options.runState !== undefined && recordedHomeIdentity !== undefined
        ? { harnessHomeIdentity: recordedHomeIdentity }
        : {}),
      ...(options.runState !== undefined && recordedAuthSource !== undefined
        ? { modelAuthSource: recordedAuthSource }
        : {}),
    });
    // A resume that states its own enforcement dials, or that introduces a
    // fabric session whose raise outranks the recorded mode, resolves a mode
    // the run cannot move to: the recorded mode is what the rest of the run
    // enforces at. Refusing names both, rather than running at one and
    // labelling the artifacts with the other. A resume that resolves the
    // recorded mode passes silently, whether it restated it or inherited it.
    if (
      options.runState !== undefined &&
      this.config.cfcEnforcementMode !== options.runState.cfcEnforcementMode
    ) {
      throw harnessResumeRefusal(
        this.config.cfcEnforcementModeSource === "fabric-session"
          ? `resumed run CFC enforcement mode ${options.runState.cfcEnforcementMode} does not match the ${this.config.cfcEnforcementMode} its fabric session raises the harness dial to; lower --fabric-cfc-enforcement-mode to resume this run`
          : `resumed run CFC enforcement mode ${options.runState.cfcEnforcementMode} does not match requested CFC enforcement mode ${this.config.cfcEnforcementMode}`,
      );
    }
    const runId = options.runState?.runId ?? options.runId ??
      crypto.randomUUID();
    // The session behind `run_pattern` is expensive and remote, so it is
    // built lazily on the tool's first invocation and cached for the run
    // while healthy; a failed construction is retried on the next call.
    const fabricSessionFactory = options.fabricSessionFactory ??
      (this.config.fabricSession !== undefined
        ? createHarnessFabricSessionFactory(this.config.fabricSession)
        : undefined);
    this.#fabricSessionFactory = fabricSessionFactory === undefined
      ? undefined
      : cacheHarnessFabricSessionFactory(fabricSessionFactory);
    // The index client loads the fabric identity from disk to sign with, so
    // it is built lazily and cached for the run on the same terms.
    const patternIndexClientFactory = options.patternIndexClientFactory ??
      (this.config.patternIndex !== undefined &&
          this.config.fabricSession !== undefined
        ? createHarnessPatternIndexClientFactory(
          this.config.patternIndex,
          this.config.fabricSession.identityKeyPath,
        )
        : undefined);
    this.#openProbeRuntime = options.openProbeRuntime;
    this.#patternIndexClientFactory = patternIndexClientFactory === undefined
      ? undefined
      : cacheHarnessPatternIndexClientFactory(patternIndexClientFactory);
    const skillsShSearchClientFactory = options.skillsShSearchClientFactory ??
      (this.config.skillsSh !== undefined
        ? createHarnessSkillsShSearchClientFactory(
          this.config.skillsSh.baseUrl,
        )
        : undefined);
    this.#skillsShSearchClientFactory =
      skillsShSearchClientFactory === undefined
        ? undefined
        : cacheHarnessSkillsShSearchClientFactory(skillsShSearchClientFactory);
    const skillsShAcquisitionClientFactory =
      options.skillsShAcquisitionClientFactory ??
        (this.config.skillsSh !== undefined
          ? createHarnessSkillsShAcquisitionClientFactory()
          : undefined);
    this.#skillsShAcquisitionClientFactory =
      skillsShAcquisitionClientFactory === undefined
        ? undefined
        : cacheHarnessSkillsShAcquisitionClientFactory(
          skillsShAcquisitionClientFactory,
        );
    this.#taskText = options.taskText;
    const recordedStructuredResult = options.runState?.structuredResult;
    if (
      recordedStructuredResult !== undefined &&
      options.structuredResult !== undefined &&
      !deepEqual(recordedStructuredResult, options.structuredResult)
    ) {
      throw harnessResumeRefusal(
        "resumed run structured-result configuration does not match the recorded configuration",
      );
    }
    this.#structuredResult = options.lineage === undefined &&
        options.runState?.lineage === undefined
      ? structuredClone(recordedStructuredResult ?? options.structuredResult)
      : undefined;
    this.#inputCells = options.inputCells ?? [];
    this.#connectorGrants = options.connectorGrants ?? [];
    this.#patternRefs = options.patternRefs ?? [];
    this.#spaceDbPath = options.spaceDbPath;
    const sandboxConfig = options.sandboxRuntime === undefined
      ? resolveSandboxConfig(this.config, {
        workspaceHostPath: options.workspaceHostPath,
        sandboxImage: options.sandboxImage,
        sandboxDockerRuntime: options.sandboxDockerRuntime,
        additionalMounts: options.additionalMounts,
        cfcResultDir: options.cfcResultDir,
        cfcInvocationContextDir: options.cfcInvocationContextDir,
      })
      : this.config.sandbox;
    // Capture the engine-owned docker-runsc config so we can refuse to *run*
    // enforce-mode sandbox work — capability probes or tools — whose sandbox
    // lacks the CFC sidecar transports (the check fires at run start, not
    // construction — see #assertCfcTransportReady).
    // Only when the engine constructs the runtime itself: an injected
    // sandboxRuntime is the thing that actually executes and carries its own
    // enforcement guarantees, while `sandboxConfig` in that branch is the
    // unused resolved config and may describe a different sandbox entirely.
    this.#ownedRunscConfig = options.sandboxRuntime === undefined
      ? sandboxConfig
      : undefined;
    this.hostProcessRunner = options.processRunner ?? new DenoProcessRunner();
    this.sandbox = options.sandboxRuntime ??
      new DockerRunscSandboxRuntime(sandboxConfig!, options.processRunner);
    this.workspaceHostPath = sandboxConfig?.workspaceHostPath ??
      options.workspaceHostPath;
    this.workspaceMountPath = normalizeSandboxRoot(
      sandboxConfig?.workspaceMountPath ??
        this.sandbox.defaultWorkingDirectory(),
    );
    this.#hostMounts = sandboxConfig !== undefined
      ? [
        {
          kind: "workspace",
          hostPath: sandboxConfig.workspaceHostPath,
          sandboxPath: sandboxConfig.workspaceMountPath,
          readOnly: false,
        },
        ...sandboxConfig.additionalMounts.map((mount) => ({
          kind: mount.kind,
          ...(mount.kind === "host-bind" ? { name: mount.name } : {}),
          hostPath: mount.hostPath,
          sandboxPath: mount.sandboxPath,
          readOnly: mount.readOnly,
        })),
      ]
      : this.workspaceHostPath !== undefined
      ? [{
        kind: "workspace",
        hostPath: this.workspaceHostPath,
        sandboxPath: this.workspaceMountPath,
        readOnly: false,
      }]
      : [];
    this.artifactStore = options.artifactStore ??
      ((this.config.artifactRoot ?? options.runState?.artifactRoot) !==
          undefined
        ? createFileSystemHarnessArtifactStore({
          artifactRoot: this.config.artifactRoot ??
            dirname(options.runState!.artifactRoot!),
          runId,
        })
        : undefined);
    const currentDir = resolveInitialCurrentDir(
      this.sandbox,
      this.config,
      options.runState,
    );
    // The posture the fabric session's runtime will actually run at, resolved
    // from the same config the session factory reads. The enforcement pin
    // restates what `runtimePresets.remoteClient` and the Runtime constructor
    // supply when the dial is unset (`coreOptions` in
    // `packages/runner/src/runtime-presets.ts`).
    // A host that supplies its own session factory overrides the config the
    // projection is computed from, so `config.fabricSession` no longer
    // describes the runtime that will execute. Publishing a record from it
    // would assert a posture nothing honors — the very shape this record
    // exists to make visible — so the record is omitted and the two itemized
    // dials stand alone, which is what the config still truthfully says was
    // asked for.
    // Unless the caller says whose runtime it handed over. A delegating
    // parent passes the record it published for the session it shares, and
    // the child republishes it as `inherited`: the posture of a run executing
    // on a runtime someone else built is not unknown, it is that runtime's,
    // and a child recording nothing is what leaves the run that actually
    // exercises the sinks unauditable (CT-2205).
    const sessionFactoryOverridesConfig = options.fabricSessionFactory !==
      undefined;
    const sessionRecord = sessionFactoryOverridesConfig
      ? (options.inheritedFabricSessionPosture === undefined
        ? undefined
        : inheritedCfcPostureReport(options.inheritedFabricSessionPosture))
      : this.config.fabricSession === undefined
      ? undefined
      : harnessFabricSessionPosture(this.config.fabricSession);
    const fabricSessionCfc = this.config.fabricSession !== undefined
      ? {
        enforcementMode: fabricSessionCfcEnforcementMode(
          this.config.fabricSession,
        ),
        enforcementModeSource:
          this.config.fabricSession.cfcEnforcementMode !== undefined
            ? "configured" as const
            : "preset-pin" as const,
        flowLabels: fabricSessionCfcFlowLabels(this.config.fabricSession),
        flowLabelsSource: fabricSessionCfcFlowLabelsSource(
          this.config.fabricSession,
        ),
        ...(this.config.fabricSession.cfcPosture !== undefined
          ? { posture: this.config.fabricSession.cfcPosture }
          : {}),
        ...(this.config.fabricSession.cfcReadMaxConfidentiality !== undefined
          ? {
            readMaxConfidentiality:
              this.config.fabricSession.cfcReadMaxConfidentiality,
          }
          : {}),
        ...(this.config.fabricSession.cfcReadOnExceed !== undefined
          ? { readOnExceed: this.config.fabricSession.cfcReadOnExceed }
          : {}),
        ...(this.config.fabricSession.readCeilingSource !== "none"
          ? {
            readMaxConfidentialitySource:
              this.config.fabricSession.readCeilingSource,
          }
          : {}),
        ...(sessionRecord !== undefined ? { record: sessionRecord } : {}),
      }
      : undefined;
    // A resumed run keeps its recorded fabric-session posture, so a session
    // config that resolves to a DIFFERENT posture would put the artifacts in
    // contradiction with the Runtime that executes: refuse rather than let
    // either record win silently. A run resumed without a session keeps its
    // record as history (no runtime exists for it to contradict). A LEGACY
    // record — one that never captured a posture — stays absent rather than
    // being backfilled. Resuming one under the named posture bundle is
    // refused, because no legacy run can have run the bundle and that resume
    // would execute enforcement the artifacts cannot attest. Resuming one
    // under a session that names no bundle proceeds.
    if (options.runState !== undefined && fabricSessionCfc !== undefined) {
      const recorded = options.runState.fabricSessionCfc;
      if (recorded === undefined) {
        if (fabricSessionCfc.posture !== undefined) {
          throw harnessResumeRefusal(
            `fabric session CFC posture mismatch on resume: run state ` +
              `records no fabric-session posture, so it cannot attest the ` +
              `${fabricSessionCfc.posture} bundle the session ` +
              `configuration resolves`,
          );
        }
      } else {
        // A ceiling is compared by its clauses and stated by their count: a
        // clause is a confidentiality label atom, which names spaces and
        // carries field commitments, and this message leaves the harness.
        const clauseCount = (clauses?: readonly CfcConfClause[]) =>
          clauses === undefined
            ? "none"
            : `${clauses.length} clause${clauses.length === 1 ? "" : "s"}`;
        const differences = [
          ...([
            [
              "enforcement mode",
              recorded.enforcementMode,
              fabricSessionCfc.enforcementMode,
            ],
            ["flow labels", recorded.flowLabels, fabricSessionCfc.flowLabels],
            [
              "posture bundle",
              recorded.posture ?? "none",
              fabricSessionCfc.posture ?? "none",
            ],
            [
              "read ceiling overflow",
              recorded.readOnExceed ?? "none",
              fabricSessionCfc.readOnExceed ?? "none",
            ],
          ] as const)
            .filter(([, recordedDial, resolved]) => recordedDial !== resolved)
            .map(([dial, recordedDial, resolved]) =>
              `${dial} (${recordedDial} against ${resolved})`
            ),
          // The read ceiling too: a resume that would read wider (or under
          // another ceiling) than the artifacts attest is the same
          // contradiction as a moved dial.
          ...(JSON.stringify(recorded.readMaxConfidentiality) !==
              JSON.stringify(fabricSessionCfc.readMaxConfidentiality)
            ? [
              `read ceiling (${
                clauseCount(recorded.readMaxConfidentiality)
              } against ${
                clauseCount(fabricSessionCfc.readMaxConfidentiality)
              })`,
            ]
            : []),
        ];
        // The whole record too, where the run recorded one. The two dials
        // above can agree while a dial neither of them names has moved under
        // the run — a changed runtime default, a changed posture bundle — and
        // a resume that kept the recorded record would attest a posture the
        // executing runtime is not at. A run that recorded no record predates
        // one and is compared on the dials alone. This is also what refuses a
        // resume that drops the session the record came from: a run that
        // recorded an inherited record and is resumed without the parent
        // session behind it resolves a different record, or none, and either
        // way the artifacts would stop describing what executes. The record
        // is named rather than printed: it lists every sink the runtime
        // governs and every deviation it publishes, which is a security
        // posture rather than a dial an operator moves, and this message
        // leaves the harness.
        if (
          recorded.record !== undefined &&
          JSON.stringify(recorded.record) !==
            JSON.stringify(fabricSessionCfc.record)
        ) {
          differences.push("the runtime posture record the dials resolve to");
        }
        if (differences.length > 0) {
          throw harnessResumeRefusal(
            `fabric session CFC posture mismatch on resume: the run and the ` +
              `session configuration differ on ${differences.join(", ")}`,
          );
        }
      }
    }
    this.#runState = options.runState ??
      createHarnessRunState({
        runId,
        cfcEnforcementMode: this.config.cfcEnforcementMode,
        ...(fabricSessionCfc !== undefined ? { fabricSessionCfc } : {}),
        currentDir,
        model: this.config.model,
        modelProvider: this.config.modelProvider,
        modelAuthSource: this.config.modelAuthSource ??
          (this.config.modelProvider === "openai-codex"
            ? "owner-bound-oauth"
            : this.config.gatewayAuthMode === "none"
            ? "none"
            : "api-key"),
        credentialOwnerKey: this.config.credentialOwnerKey,
        credentialOwner: this.config.credentialOwner,
        harnessHomeIdentity: this.config.harnessHomeIdentity,
        artifactRoot: this.artifactStore?.runRoot,
        ...(this.#structuredResult !== undefined
          ? { structuredResult: this.#structuredResult }
          : {}),
        runManifest: this.config.runManifest,
        runManifestPath: this.config.runManifestPath,
        docsCorpus: this.config.docsCorpus,
        researchGoal: options.researchGoal ?? options.taskText,
        ...(options.inheritedResearchRuns !== undefined
          ? { researchRuns: [...options.inheritedResearchRuns] }
          : {}),
        ...(options.inheritedCfcModelContext !== undefined
          ? { cfcModelContext: options.inheritedCfcModelContext }
          : {}),
        skillsRoot: this.config.skillsRootRecord,
        ...(options.acquiredSkills !== undefined
          ? { acquiredSkills: options.acquiredSkills }
          : {}),
        lineage: options.lineage,
        now: this.#now(),
      });
    this.#outputSequence = this.#runState.toolOutputs.length;
  }

  getRunState(): HarnessRunState {
    return structuredClone(this.#runState);
  }

  /**
   * Whether the run can build a fabric session for `run_pattern` — either
   * an injected factory or `fabricSession` connection config. The prompt
   * loop offers `run_pattern` in the default parent tool surface exactly
   * when this holds.
   */
  get fabricSessionAvailable(): boolean {
    return this.#fabricSessionFactory !== undefined;
  }

  /**
   * The run's cached fabric-session factory, or `undefined` when the run has
   * none. A delegating parent hands its factory to the child engine, so a
   * subagent's `run_pattern` shares the one session the parent built rather
   * than opening a second one against the same space.
   */
  get fabricSessionFactory(): HarnessFabricSessionFactory | undefined {
    return this.#fabricSessionFactory;
  }

  /**
   * The space database the run's cell-label snapshot reads, or `undefined`
   * when the space is found by discovery. A delegating parent hands it to
   * the child engine, so a subagent that ends in the same space reads the
   * same store.
   */
  get spaceDbPath(): string | undefined {
    return this.#spaceDbPath;
  }

  /**
   * The sandbox configuration this engine built its own runtime from, absent
   * when the runtime was handed in.
   *
   * A caller that wants a sandbox differing from this run's — a child that
   * mounts something its parent does not — needs the configuration rather than
   * the runtime, and needs to know it may build one at all: where the runtime
   * was injected, that object is the thing that executes and a configuration
   * beside it describes something else.
   */
  get ownedSandboxConfig(): DockerRunscSandboxConfig | undefined {
    return this.#ownedRunscConfig;
  }

  /**
   * The connector handles this run's console was launched against. A
   * delegating parent hands them to the child engine, so a child's grants
   * resolve from the configuration the parent's resolved from rather than
   * from a second reading of the records behind it.
   */
  get connectorGrants(): readonly HarnessConnectorGrantSpec[] {
    return this.#connectorGrants;
  }

  /**
   * Whether the run can reach the pattern index — either an injected factory
   * or `patternIndex` connection config. The prompt loop offers
   * `search_patterns` and `record_feedback` exactly when this holds.
   */
  get patternIndexAvailable(): boolean {
    return this.#patternIndexClientFactory !== undefined;
  }

  /**
   * Whether a pattern this run authored and ran is published back to the
   * index. A run that can reach an index records to it unless the operator
   * said otherwise, so an injected factory with no connection config — a test
   * harness, a delegating parent — publishes like a configured one.
   */
  get patternIndexPublishEnabled(): boolean {
    return this.patternIndexAvailable &&
      this.config.patternIndex?.publish !== false;
  }

  /**
   * Whether a successful authored pattern is offered to search immediately.
   * The default publication records it without making it discoverable.
   */
  get patternIndexPublishDiscoverable(): boolean {
    return this.config.patternIndex?.publishDiscoverable === true;
  }

  /**
   * Where this run's authored patterns wait to be published. One ledger per
   * engine, and therefore one per session: a delegating parent and its child
   * each publish once per capability of their own, which is the grain the
   * duplicates were being produced at. Created on first use and only when the
   * run can reach an index at all.
   */
  get patternIndexLedger(): PatternIndexLedger | undefined {
    const factory = this.#patternIndexClientFactory;
    if (factory === undefined) return undefined;
    this.#patternIndexLedger ??= createPatternIndexLedger(
      factory,
    );
    return this.#patternIndexLedger;
  }

  /**
   * Sends everything this session's ledger still holds and waits for every
   * write it has made. Called once, when the session's prompt loop finishes.
   * A session that never reaches it keeps whatever the ledger already sent —
   * a displaced iteration, a dependency, a report — and loses the entries
   * still held, which `ledger.ts` states as the cost it is, along with
   * whichever writes were in flight.
   */
  async flushPatternIndexLedger(): Promise<void> {
    await this.#patternIndexLedger?.flush();
  }

  /**
   * The run's cached pattern-index factory, or `undefined` when the run has
   * none. A delegating parent hands its factory to the child engine, so a
   * subagent searches and runs indexed patterns through the one client the
   * parent built.
   */
  get patternIndexClientFactory():
    | HarnessPatternIndexClientFactory
    | undefined {
    return this.#patternIndexClientFactory;
  }

  /** Whether this run can search the configured skills.sh registry. */
  get skillsShSearchAvailable(): boolean {
    return this.#skillsShSearchClientFactory !== undefined;
  }

  /** The run's cached skills.sh search-client factory, when configured. */
  get skillsShSearchClientFactory():
    | HarnessSkillsShSearchClientFactory
    | undefined {
    return this.#skillsShSearchClientFactory;
  }

  /** Whether this run configures a documentation corpus for research. */
  get docsCorpusAvailable(): boolean {
    return (this.docsCorpus?.roots ?? []).length > 0;
  }

  /**
   * The corpus this run answers out of. A resumed run keeps the corpus it was
   * created with, whatever this process was configured with: the run recorded
   * which documentation shaped it, and answering later questions out of a
   * different tree — or offering the tool on a run that disabled it — would
   * make that record a lie. Configuration answers only for a state that
   * carries no record of its own.
   */
  get docsCorpus(): HarnessDocsCorpusRecord | undefined {
    return this.#runState.docsCorpus ?? this.config.docsCorpus;
  }

  /**
   * The run's documentation corpus, loaded once. The load walks the operator's
   * roots on the host, so it is held for the run rather than repeated per
   * question: the roots are read-only reference material, and a query that
   * reloaded them would pay a filesystem walk to learn the same thing.
   */
  getDocsCorpus(): Promise<HarnessDocsCorpus> {
    this.#docsCorpus ??= loadHarnessDocsCorpus(this.docsCorpus?.roots ?? []);
    return this.#docsCorpus;
  }

  /**
   * Gives this run a bounded Common Fabric research loop. The model belongs to
   * the prompt loop, so the loop supplies the runner and the engine carries it
   * to the tool.
   */
  setResearchRunner(runner: HarnessResearchRunner): void {
    this.#researchRunner = runner;
  }

  /** Whether this engine was restored from an existing run-state artifact. */
  get resumedRun(): boolean {
    return this.#resumedRun;
  }

  /** Persists the root driver's opening-research checkpoint. */
  async recordOpeningResearch(
    openingResearch: HarnessOpeningResearch,
  ): Promise<HarnessRunState> {
    this.#runState = setHarnessOpeningResearch(
      this.#runState,
      openingResearch,
      this.#now(),
    );
    await this.persistRunState();
    return this.getRunState();
  }

  /** Whether this run can acquire a pinned external skill. */
  get skillsShAcquisitionAvailable(): boolean {
    return this.#skillsShAcquisitionClientFactory !== undefined;
  }

  /** The run's cached pinned-acquisition factory, when configured. */
  get skillsShAcquisitionClientFactory():
    | HarnessSkillsShAcquisitionClientFactory
    | undefined {
    return this.#skillsShAcquisitionClientFactory;
  }

  bindRunModel(model: string): HarnessRunState {
    const recordedModel = this.#runState.model;
    if (
      this.#runState.modelProvider === "openai-codex" &&
      this.#runModelBound &&
      recordedModel !== undefined && recordedModel !== model
    ) {
      throw new Error(
        `${
          this.#resumedRun ? "resumed " : ""
        }openai-codex run model ${recordedModel} does not match requested model ${model}`,
      );
    }
    if (recordedModel !== model) {
      this.#runState = patchHarnessRunState(
        this.#runState,
        { model },
        this.#now(),
      );
    }
    this.#runModelBound = true;
    return this.getRunState();
  }

  /**
   * Counts legacy documentation-query failures retained by resumed run state.
   * New calls use {@link recordResearchFailures}; this method remains so a
   * parent can roll up an older child's durable count without rewriting it.
   */
  recordDocsQueryFailures(count: number): HarnessRunState {
    this.#runState = addHarnessDocsQueryFailures(
      this.#runState,
      count,
      this.#now(),
    );
    return this.getRunState();
  }

  /** Retains one admitted implementation kit for resume and delegation. */
  recordResearchRun(run: HarnessResearchRunSummary): HarnessRunState {
    this.#runState = appendHarnessResearchRun(
      this.#runState,
      run,
      this.#now(),
    );
    return this.getRunState();
  }

  /** Counts bounded research calls that returned no kit. */
  recordResearchFailures(count: number): HarnessRunState {
    this.#runState = addHarnessResearchFailures(
      this.#runState,
      count,
      this.#now(),
    );
    return this.getRunState();
  }

  appendFailureRecord(failure: HarnessFailureRecord): HarnessRunState {
    this.#runState = appendHarnessFailureRecord(
      this.#runState,
      failure,
      this.#now(),
    );
    return this.getRunState();
  }

  /**
   * Takes the run: `running`, with any earlier outcome cleared. The run's
   * driver calls this when it begins bringing the run up, and again on
   * resume, when a run re-enters its loop from a terminal record. The
   * driver's next persist carries it to disk; a run that ends before one is
   * persisted by the transition that ends it.
   */
  startRun(): HarnessRunState {
    this.#runState = setHarnessRunStatus(
      this.#runState,
      "running",
      this.#now(),
    );
    return this.getRunState();
  }

  /**
   * Ends the run as `completed` for `terminalReason`, persisted. A run has
   * one outcome and its driver writes it once, and the labels its space
   * holds for the cells it touched land in that same write; see
   * `#withCellLabels()`.
   *
   * @throws Error when the run already has its outcome.
   */
  async completeRun(
    terminalReason: HarnessRunTerminalReason,
  ): Promise<HarnessRunState> {
    const now = this.#now();
    this.#runState = await this.#withCellLabels(
      setHarnessRunStatus(this.#runState, "completed", now, terminalReason),
      now,
    );
    await this.persistRunState();
    return this.getRunState();
  }

  /**
   * Ends the run as `failed` for `terminalReason`, persisted, recording
   * `error` as the failure when one is given. A run has one outcome and its
   * driver writes it once, and the labels its space holds for the cells it
   * touched land in that same write; see `#withCellLabels()`.
   *
   * @throws Error when the run already has its outcome.
   */
  async failRun(
    terminalReason: HarnessRunTerminalReason,
    error?: unknown,
    options: Omit<ClassifyHarnessRunErrorOptions, "at"> = {},
  ): Promise<HarnessRunState> {
    const now = this.#now();
    if (error !== undefined) {
      this.#runState = appendHarnessFailureRecord(
        this.#runState,
        classifyHarnessRunError(error, { ...options, at: now }),
        now,
      );
    }
    this.#runState = await this.#withCellLabels(
      setHarnessRunStatus(this.#runState, "failed", now, terminalReason),
      now,
    );
    await this.persistRunState();
    return this.getRunState();
  }

  /**
   * Ends the run as `canceled`, retaining the driver's reason and the labels
   * of the cells it touched. Cancellation adds no failure record.
   *
   * @throws Error when the run already has its outcome.
   */
  async cancelRun(reason: string): Promise<HarnessRunState> {
    const now = this.#now();
    this.#runState = await this.#withCellLabels(
      patchHarnessRunState(
        setHarnessRunStatus(this.#runState, "canceled", now, "canceled"),
        { cancelReason: reason },
        now,
      ),
      now,
    );
    await this.persistRunState();
    return this.getRunState();
  }

  setPromptSlotBinding(
    promptSlotBinding: PromptSlotBinding,
  ): HarnessRunState {
    this.#runState = patchHarnessRunState(
      this.#runState,
      { promptSlotBinding },
      this.#now(),
    );
    return this.getRunState();
  }

  async recordPolicyEvent(
    event: Omit<HarnessPolicyEvent, "type" | "at">,
  ): Promise<HarnessRunState> {
    const now = this.#now();
    const policyEvent = createHarnessPolicyEvent({ ...event, at: now });
    this.#runState = appendToHarnessRunState(
      this.#runState,
      "policyEvents",
      policyEvent,
      now,
    );
    const failure = classifyHarnessPolicyEventFailure(policyEvent);
    if (failure !== undefined) {
      this.#runState = appendHarnessFailureRecord(this.#runState, failure, now);
    }
    await this.persistRunState();
    return this.getRunState();
  }

  async recordPolicyDecision(
    decision: Omit<
      HarnessPolicyDecisionRecord,
      "type" | "sequence" | "runId" | "at"
    >,
  ): Promise<HarnessRunState> {
    const now = this.#now();
    const policyDecision = createHarnessPolicyDecisionRecord({
      ...decision,
      runId: this.#runState.runId,
      sequence: (this.#runState.policyDecisions ?? []).length + 1,
      at: now,
    });
    this.#runState = appendToHarnessRunState(
      this.#runState,
      "policyDecisions",
      policyDecision,
      now,
    );
    await this.persistRunState();
    return this.getRunState();
  }

  async recordCfcModelContextObservations(
    observations: readonly HarnessCfcModelContextObservationInput[],
  ): Promise<HarnessRunState> {
    this.#runState = appendHarnessCfcModelContextObservations(
      this.#runState,
      observations,
      this.#now(),
    );
    await this.persistRunState();
    return this.getRunState();
  }

  /**
   * The run's session-local handle table, or `undefined` while none has been
   * recorded. A defensive copy, like `getRunState()`.
   */
  get handleTable(): HarnessHandleTable | undefined {
    return this.#runState.handleTable === undefined
      ? undefined
      : structuredClone(this.#runState.handleTable);
  }

  /**
   * What `resolveHandleValue` needs from this run: the handle table and the
   * fabric session, when the run has one. For trusted-side resolutions the
   * prompt loop performs itself (a `delegate_task` skillHandle), where no
   * tool context exists to carry them.
   */
  get handleValueResolutionContext(): HandleValueResolutionContext {
    return {
      handleTable: this.handleTable,
      ...(this.#fabricSessionFactory !== undefined
        ? { getFabricSession: this.#fabricSessionFactory }
        : {}),
    };
  }

  /**
   * Records `table` as the run's handle table and persists the run state.
   *
   * @throws Error when `table` is not a well-formed version-1 handle table.
   */
  async recordHandleTable(table: HarnessHandleTable): Promise<void> {
    assertValidHarnessHandleTable(table);
    this.#runState = patchHarnessRunState(
      this.#runState,
      { handleTable: structuredClone(table) },
      this.#now(),
    );
    await this.persistRunState();
  }

  /**
   * Mints and records a handle consumable only as delegated skill context,
   * carrying `acquisition` as the entry's record of where the value came
   * from. Only a host step that performed the fetch can supply that record,
   * and it is what a later delegation's activation names.
   */
  async mintSkillContextHandle(
    ref: string,
    acquisition: HarnessSkillAcquisition,
  ): Promise<string> {
    const minted = await mintAddressHandle(
      this.handleTable ?? createHarnessHandleTable(this.#runState.runId),
      ref,
      { capability: "skill-context", acquisition },
    );
    await this.recordHandleTable(minted.table);
    return minted.token;
  }

  /** Whether this run was configured with a structured-result schema. */
  get structuredResultAvailable(): boolean {
    return this.#structuredResult !== undefined;
  }

  /**
   * Helper for `submit_result`, which writes a validated result to the
   * configured file, replacing whatever an earlier submission left.
   */
  async #recordStructuredResult(
    value: unknown,
  ): Promise<{ replaced: boolean }> {
    const { path } = this.#structuredResult!;
    let replaced = this.#structuredResultRecorded;
    if (!replaced) {
      try {
        await Deno.stat(path);
        replaced = true;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
    this.#structuredResultRecorded = true;
    return { replaced };
  }

  /**
   * Mints and records a handle for content a tool observed that is not a
   * cell, so a result naming the token can link a document minted from it.
   */
  async mintReferentHandle(
    referent: Omit<HarnessHandleReferent, "token" | "kind">,
  ): Promise<string> {
    const minted = await mintReferentHandle(
      this.handleTable ?? createHarnessHandleTable(this.#runState.runId),
      referent,
    );
    await this.recordHandleTable(minted.table);
    return minted.token;
  }

  async persistRunState(): Promise<string | undefined> {
    return await this.artifactStore?.persistRunState(this.#runState);
  }

  /**
   * Establishes the run's well-known grants: seeds the handle table with a
   * token for each reference every run on this console is entitled to hold —
   * the space's piece registry, and the connector handles the run was
   * configured with — records the grants in run state, and returns them.
   * Establishing the Fabric session is the cost of resolving the references,
   * so this connects eagerly — callers invoke it only on runs configured for
   * a session. Idempotent across resume: grants already recorded are returned
   * as they stand, without connecting again.
   *
   * Called for a session's own run and never for a delegated child, which
   * receives only the handles its brief names (spec §5, `AH-CFC-12`): a child
   * engine carries `connectorGrants` so its configuration matches its
   * parent's, and calling this there would hand every child references no
   * brief asked for.
   *
   * A run without a session factory has nothing to grant and answers `[]`.
   * A session that cannot be established propagates its failure — the caller
   * decides whether a run proceeds without its grants, and says so.
   */
  async establishWellKnownGrants(): Promise<HarnessWellKnownGrant[]> {
    if (this.#runState.wellKnownGrants !== undefined) {
      // Checked on the way out of the record, not only on the way in: a
      // resumed run reads these from a file this process did not write, and a
      // connector grant's name reaches model-facing text.
      const recorded = structuredClone(this.#runState.wellKnownGrants);
      for (const grant of recorded) {
        checkRecordedWellKnownGrant(grant);
      }
      return recorded;
    }
    if (this.#fabricSessionFactory === undefined) {
      return [];
    }
    const session = await this.#fabricSessionFactory();
    const refs = await resolveWellKnownGrantRefs(
      session,
      this.#connectorGrants,
    );
    const minted = await mintWellKnownGrants(
      this.handleTable,
      this.#runState.runId,
      refs,
    );
    await this.recordHandleTable(minted.table);
    this.#runState = patchHarnessRunState(
      this.#runState,
      { wellKnownGrants: structuredClone(minted.grants) },
      this.#now(),
    );
    await this.persistRunState();
    return minted.grants;
  }

  /**
   * Establishes the run's input cells: mints tokens for host-supplied attachments
   * or session-retained targets, records them in run state, and returns them.
   * Idempotent across resume, like the well-known grants: cells already recorded
   * are returned as they stand.
   *
   * An input cell names a task target, so failure is closed and loud rather
   * than tolerated: cells configured on a
   * run with no fabric session, a reference that does not parse, a reference
   * targeting another space, and a named piece address whose slug this space
   * does not hold all throw before anything is recorded.
   */
  async establishInputCells(): Promise<HarnessInputCell[]> {
    if (this.#runState.inputCells !== undefined) {
      return structuredClone(this.#runState.inputCells);
    }
    if (this.#inputCells.length === 0) {
      return [];
    }
    if (this.#fabricSessionFactory === undefined) {
      throw new Error(
        "--input-cell requires a fabric session; configure --fabric-space",
      );
    }
    const session = await this.#fabricSessionFactory();
    const minted = await mintInputCellHandles(
      this.handleTable,
      this.#runState.runId,
      this.#inputCells,
      session.pieces.getSpace(),
      {
        // The space by NAME, which is the vocabulary a named address speaks;
        // the mint checks references against the DID beside it. A space
        // configured by `did:key` has no name, and an address naming a space
        // is then refused rather than assumed to mean this one.
        ...(session.pieces.getSpaceName() !== undefined
          ? { spaceName: session.pieces.getSpaceName() }
          : {}),
        resolvePiece: (slug) => resolvePieceAddress(session.pieces, slug),
      },
    );
    await this.recordHandleTable(minted.table);
    this.#runState = patchHarnessRunState(
      this.#runState,
      { inputCells: structuredClone(minted.inputCells) },
      this.#now(),
    );
    await this.persistRunState();
    return minted.inputCells;
  }

  /**
   * Establishes the run's task pattern references: resolves each id against
   * the pattern index, records the results in run state, and returns them.
   * Idempotent across resume, like the input cells: references already
   * recorded are returned as they stand.
   *
   * Failure is closed and loud for the same reason an input cell's is —
   * references are explicit caller configuration — so a run configured with
   * them and no index, an id outside the index's grammar, and an id the index
   * does not hold all throw before anything is recorded.
   */
  async establishPatternRefs(): Promise<HarnessPatternRef[]> {
    if (this.#runState.patternRefs !== undefined) {
      return structuredClone(this.#runState.patternRefs);
    }
    if (this.#patternRefs.length === 0) {
      return [];
    }
    if (this.#patternIndexClientFactory === undefined) {
      throw new Error(
        "patternRefs requires a pattern index; configure --pattern-index-url",
      );
    }
    const client = await this.#patternIndexClientFactory();
    const resolved = await resolvePatternRefs(client, this.#patternRefs);
    this.#runState = patchHarnessRunState(
      this.#runState,
      { patternRefs: structuredClone(resolved) },
      this.#now(),
    );
    await this.persistRunState();
    return resolved;
  }

  async ensureRunManifestPersisted(): Promise<string | undefined> {
    if (this.#runState.runManifest === undefined) {
      return this.#runState.runManifestPath;
    }
    const manifestPath = await this.artifactStore?.persistRunManifest?.(
      this.#runState.runManifest,
    );
    if (manifestPath !== undefined) {
      this.#runState = patchHarnessRunState(
        this.#runState,
        { runManifestPath: manifestPath },
        this.#now(),
      );
      await this.persistRunState();
    }
    return manifestPath ?? this.#runState.runManifestPath;
  }

  async persistSkillRegistry(
    registry: HarnessSkillRegistry,
  ): Promise<string | undefined> {
    const skillRegistryPath = await this.artifactStore
      ?.persistSkillRegistry?.(registry);
    this.#runState = patchHarnessRunState(
      this.#runState,
      { skillRegistry: registry, skillRegistryPath },
      this.#now(),
    );
    await this.persistRunState();
    return skillRegistryPath;
  }

  async persistSkillActivations(
    activations: HarnessSkillActivations,
  ): Promise<string | undefined> {
    const skillActivationsPath = await this.artifactStore
      ?.persistSkillActivations?.(activations);
    this.#runState = patchHarnessRunState(
      this.#runState,
      { skillActivations: activations, skillActivationsPath },
      this.#now(),
    );
    await this.persistRunState();
    return skillActivationsPath;
  }

  async recordSkillResourceRead(
    read: HarnessSkillResourceRead,
  ): Promise<string | undefined> {
    const generatedAt = this.#now();
    const skillResourceReads = {
      type: "cf-harness.skill-resource-reads" as const,
      version: 1 as const,
      generatedAt,
      reads: [...(this.#runState.skillResourceReads?.reads ?? []), read],
    };
    const skillResourceReadsPath = await this.artifactStore
      ?.persistSkillResourceReads?.(skillResourceReads);
    this.#runState = patchHarnessRunState(
      this.#runState,
      { skillResourceReads, skillResourceReadsPath },
      generatedAt,
    );
    await this.persistRunState();
    return skillResourceReadsPath;
  }

  async recordSkillScriptExecution(
    execution: HarnessSkillScriptExecution,
  ): Promise<string | undefined> {
    const generatedAt = this.#now();
    const skillScriptExecutions = {
      type: "cf-harness.skill-script-executions" as const,
      version: 1 as const,
      generatedAt,
      executions: [
        ...(this.#runState.skillScriptExecutions?.executions ?? []),
        execution,
      ],
    };
    const skillScriptExecutionsPath = await this.artifactStore
      ?.persistSkillScriptExecutions?.(skillScriptExecutions);
    this.#runState = patchHarnessRunState(
      this.#runState,
      { skillScriptExecutions, skillScriptExecutionsPath },
      generatedAt,
    );
    await this.persistRunState();
    return skillScriptExecutionsPath;
  }

  /**
   * Writes one acquired skill's scripts where a run that holds its handle can
   * execute them, and records where they went.
   *
   * The bytes land at `<artifactRoot>/.acquired-skills/<runId>/<commitSha>/
   * <slug>` — under the artifact root's one non-run directory, inside no run
   * root — and the check here is what makes that mean something:
   * `acquire_skill` runs in the PARENT, so a script the parent's sandbox can
   * reach is a script the planner can read — the one property the
   * hostile-skill receipt rests on.
   * Every mount is asked, the workspace and each `--host-mount` alike, because
   * an operator mount over the artifact tree is the same hole as an artifact
   * root inside the workspace. A covering mount refuses, named.
   *
   * The digest recorded here is the one taken at acquisition, over the bytes
   * the pinned commit served, and it is what an execution re-checks the file
   * against — the pin a registry script gets from the run-start snapshot.
   *
   * @throws AcquiredSkillDirectoryReadableError when a mount of this run's
   * sandbox covers the directory.
   * @throws Error when the run can write nowhere, or the write fails.
   */
  async materializeAcquiredSkill(
    options: {
      registryId: string;
      commitSha: string;
      scripts: readonly {
        path: string;
        bytes: Uint8Array;
        valueDigest: string;
      }[];
    },
  ): Promise<HarnessAcquiredSkill> {
    const store = this.artifactStore;
    if (
      store?.acquiredSkillsDir === undefined ||
      store.writeAcquiredSkillScript === undefined
    ) {
      throw new Error(
        "acquiring a skill's scripts requires a run that can write artifacts",
      );
    }
    const covering = this.#hostMountCovering(store.acquiredSkillsDir);
    if (covering !== undefined) {
      throw new AcquiredSkillDirectoryReadableError(
        `the acquired-skills directory is inside this run's ${
          covering.name ?? covering.kind
        } mount (${covering.hostPath} at ${covering.sandboxPath}), so a script written there would be readable by the run that acquires it`,
      );
    }
    const slug = options.registryId.split("/").at(-1) ?? options.registryId;
    // Keyed by the commit first: one commit is one tree, and the slug beneath
    // it separates two skills acquired from the same one.
    const relativeDir = `${options.commitSha}/${slug}`;
    const scripts: HarnessAcquiredSkillScript[] = [];
    for (const script of options.scripts) {
      const hostPath = await store.writeAcquiredSkillScript(
        relativeDir,
        script.path,
        script.bytes,
      );
      scripts.push({
        path: script.path,
        hostPath,
        sandboxPath: `${ACQUIRED_SKILL_MOUNT_PATH}/${script.path}`,
        valueDigest: script.valueDigest,
        sizeBytes: script.bytes.byteLength,
      });
    }
    const acquired: HarnessAcquiredSkill = {
      registryId: options.registryId,
      commitSha: options.commitSha,
      pin: `${options.registryId}@${options.commitSha}`,
      hostRoot: joinHostPath(store.acquiredSkillsDir, relativeDir),
      sandboxRoot: ACQUIRED_SKILL_MOUNT_PATH,
      scripts,
    };
    const generatedAt = this.#now();
    const acquiredSkills: HarnessAcquiredSkills = {
      type: HARNESS_ACQUIRED_SKILLS_TYPE,
      version: 1,
      generatedAt,
      skills: [
        ...(this.#runState.acquiredSkills?.skills ?? []).filter((skill) =>
          skill.pin !== acquired.pin
        ),
        acquired,
      ],
    };
    const acquiredSkillsPath = await this.artifactStore
      ?.persistAcquiredSkills?.(acquiredSkills);
    this.#runState = patchHarnessRunState(
      this.#runState,
      { acquiredSkills, acquiredSkillsPath },
      generatedAt,
    );
    await this.persistRunState();
    return acquired;
  }

  nextToolOutputId(toolId: string): ToolOutputId {
    this.#outputSequence += 1;
    return `${this.#runState.runId}:${toolId}:${this.#outputSequence}` as ToolOutputId;
  }

  async recordSubagentRun(
    subagentRun: HarnessSubagentRunRef,
  ): Promise<HarnessRunState> {
    this.#runState = setHarnessSubagentRun(
      this.#runState,
      subagentRun,
      this.#now(),
    );
    await this.persistRunState();
    return this.getRunState();
  }

  /**
   * Fails the run as `process_interrupted` when the process is going down
   * before its loop ended. A run that already has its outcome keeps it: the
   * signal raced the loop's own end, and the record stands as written.
   */
  async terminalizeInterruptedRun(
    signalName: string,
  ): Promise<HarnessRunState> {
    if (isTerminalHarnessRunStatus(this.#runState.status)) {
      return this.getRunState();
    }
    const now = this.#now();
    this.#runState = appendHarnessFailureRecord(
      this.#runState,
      createHarnessFailureRecord({
        kind: "harness_error",
        source: "run_error",
        detail:
          `process received ${signalName} before the prompt loop completed`,
        at: now,
      }),
      now,
    );
    return await this.failRun("process_interrupted");
  }

  async persistTranscript(
    transcript: readonly HarnessTranscriptMessage[],
  ): Promise<string | undefined> {
    const transcriptPath = await this.artifactStore?.persistTranscript(
      transcript,
    );
    if (transcriptPath !== undefined) {
      this.#runState = patchHarnessRunState(
        this.#runState,
        { transcriptPath },
        this.#now(),
      );
      await this.persistRunState();
    }
    return transcriptPath;
  }

  async persistRunReport(
    report: HarnessRunReport,
  ): Promise<string | undefined> {
    const runReportPath = await this.artifactStore?.persistRunReport(report);
    if (runReportPath !== undefined) {
      this.#runState = patchHarnessRunState(
        this.#runState,
        { runReportPath },
        this.#now(),
      );
      await this.persistRunState();
    }
    return runReportPath;
  }

  async persistCfcPolicySnapshot(
    snapshot: HarnessCfcPolicySnapshot,
  ): Promise<string | undefined> {
    let cfcPolicySnapshotPath: string | undefined;
    try {
      cfcPolicySnapshotPath = await this.artifactStore
        ?.persistCfcPolicySnapshot(
          snapshot,
        );
    } catch (error) {
      const now = this.#now();
      this.#runState = appendHarnessFailureRecord(
        this.#runState,
        classifyHarnessRunError(error, {
          at: now,
          source: "policy_snapshot",
        }),
        now,
      );
    }
    this.#runState = patchHarnessRunState(
      this.#runState,
      { cfcPolicySnapshot: snapshot, cfcPolicySnapshotPath },
      this.#now(),
    );
    await this.persistRunState();
    return cfcPolicySnapshotPath;
  }

  async persistPolicyTrace(
    trace: HarnessPolicyTrace,
  ): Promise<string | undefined> {
    let policyTracePath: string | undefined;
    try {
      policyTracePath = await this.artifactStore?.persistPolicyTrace?.(trace);
    } catch (error) {
      const now = this.#now();
      this.#runState = appendHarnessFailureRecord(
        this.#runState,
        classifyHarnessRunError(error, {
          at: now,
          source: "policy_trace",
        }),
        now,
      );
    }
    this.#runState = patchHarnessRunState(
      this.#runState,
      { policyTrace: trace, policyTracePath },
      this.#now(),
    );
    await this.persistRunState();
    return policyTracePath;
  }

  /**
   * Helper for the terminal run transitions, which reads the run's space
   * for what it holds about the cells the run touched and returns `state`
   * with the answer recorded on it and written beside the run.
   *
   * The run's own artifacts say which cells it made and read and what the
   * sandbox decided about each call; the space says what each of those cells
   * is labelled. Nothing else joins the two, so a reader working from the
   * tree alone sees an unlabelled cell whatever the run was enforcing. The
   * snapshot is that join, taken at the run's own space, over every cell the
   * handle table names — and taken as the run ends, once its cells are
   * settled, so the outcome and the labels reach the disk in one write and
   * whoever waits on the outcome finds the labels beside it.
   *
   * Read-only and best-effort by construction: the space database is opened
   * read-only, and a host that holds no copy of it yields an unavailable
   * snapshot rather than a failed run. What it must never do is yield a bare
   * one — "the space holds no label for this cell" and "nobody asked" are
   * different findings, and the snapshot's `status` is what keeps them apart.
   * A snapshot that could not be taken or written at all is a third finding,
   * recorded as a failure record on the run so a reader can tell it from a
   * run nobody asked about; the run's outcome stands either way.
   *
   * A run with no fabric session names no space and touches no cell, so it
   * takes no snapshot at all.
   */
  async #withCellLabels(
    state: HarnessRunState,
    now: string,
  ): Promise<HarnessRunState> {
    const space = this.config.fabricSession?.space;
    const refs = (state.handleTable?.entries ?? []).map((entry) => entry.ref);
    if (space === undefined || refs.length === 0) {
      return state;
    }
    try {
      // deno-lint-ignore cf-imports/no-inline-module-import -- costs at import time: reading a space database is the one thing the engine does through a native library, and a process that never takes a snapshot must not load one to run
      const { readSpaceCellLabels } = await import("./space-labels.ts");
      const cellLabels = await readSpaceCellLabels({
        space,
        ...(this.#spaceDbPath !== undefined
          ? { dbPath: this.#spaceDbPath }
          : {}),
        refs,
        generatedAt: now,
      });
      const cellLabelsPath = await this.artifactStore?.persistCellLabels?.(
        cellLabels,
      );
      return patchHarnessRunState(state, { cellLabels, cellLabelsPath }, now);
    } catch (error) {
      return appendHarnessFailureRecord(
        state,
        createHarnessFailureRecord({
          kind: "harness_error",
          source: "cell_labels",
          detail: `cell label snapshot failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          at: now,
        }),
        now,
      );
    }
  }

  /**
   * Fails fast before any sandbox execution under enforcement on a sandbox
   * that lacks the CFC sidecar transports — capability probes included, since
   * they run scripts inside the same sandbox (not just builtin tools). Checked
   * at run start rather than construction so an engine can be built and
   * inspected (config threading, `--describe-capabilities`) without a live CFC
   * wiring. Idempotent so the cost is paid once per run.
   */
  #assertCfcTransportReady(): void {
    if (this.#cfcTransportChecked || this.#ownedRunscConfig === undefined) {
      return;
    }
    assertDockerRunscCfcTransportForMode(
      this.#runState.cfcEnforcementMode,
      this.#ownedRunscConfig,
    );
    this.#cfcTransportChecked = true;
  }

  async ensureDiagnosticsInitialized(): Promise<HarnessRunState> {
    // The capability probes below execute scripts inside the sandbox, so the
    // enforce-mode transport floor applies here too — and must throw before
    // the try block below, which records probe errors instead of propagating.
    this.#assertCfcTransportReady();
    if (this.#runState.capabilitySnapshot !== undefined) {
      return this.getRunState();
    }
    await this.ensureRunManifestPersisted();
    const now = this.#now();
    try {
      const capabilitySnapshot = await collectHarnessCapabilitySnapshot(
        this.sandbox,
        this.#runState.currentDir,
        now,
        {
          cfcEnforcementMode: this.#runState.cfcEnforcementMode,
          runManifest: this.#runState.runManifest,
          runManifestPath: this.#runState.runManifestPath,
          modelProvider: this.config.modelProvider,
          ...(this.config.modelProvider === "openai-compatible-gateway"
            ? { gatewayAuthMode: this.config.gatewayAuthMode }
            : {}),
        },
      );
      let capabilitiesPath: string | undefined;
      try {
        capabilitiesPath = await this.artifactStore?.persistCapabilitySnapshot(
          capabilitySnapshot,
        );
      } catch (error) {
        this.#runState = appendHarnessFailureRecord(
          this.#runState,
          classifyHarnessRunError(error, {
            at: this.#now(),
            source: "capability_snapshot",
          }),
          this.#now(),
        );
      }
      this.#runState = patchHarnessRunState(
        this.#runState,
        { capabilitySnapshot, capabilitiesPath },
        this.#now(),
      );
    } catch (error) {
      this.#runState = appendHarnessFailureRecord(
        this.#runState,
        classifyHarnessRunError(error, {
          at: now,
          source: "capability_snapshot",
        }),
        now,
      );
    }
    return this.getRunState();
  }

  /**
   * Runs one builtin tool and records its output on the run. A tool call is
   * one step of a run, not the run: the run's status is the driver's to
   * write, and this touches neither it nor `endedAt`. A tool that throws is
   * recorded as a failure and rethrown for the driver to end the run on, unless
   * the owning run was aborted. Cancellation retains any returned output but
   * adds no failure record.
   *
   * @throws Error from the tool.
   */
  async invokeBuiltinTool<TToolId extends BuiltinToolId>(
    toolId: TToolId,
    input: BuiltinToolInputMap[TToolId],
    options: { signal?: AbortSignal } = {},
  ): Promise<BuiltinToolInvocationResult<TToolId>> {
    const tool = getBuiltinTool(toolId);
    if (tool === undefined) {
      throw new Error(`unknown builtin tool: ${toolId}`);
    }
    this.#assertCfcTransportReady();
    await this.ensureDiagnosticsInitialized();
    try {
      const output = await tool.invoke(
        this.#createToolContext(options.signal),
        input,
      ) as BuiltinToolOutputMap[TToolId];
      return await this.recordBuiltinToolOutput(toolId, input, output, options);
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      const failureTime = this.#now();
      this.#runState = appendHarnessFailureRecord(
        this.#runState,
        classifyHarnessRunError(error, {
          at: failureTime,
          toolId,
          source: "run_error",
        }),
        failureTime,
      );
      await this.persistRunState();
      throw error;
    }
  }

  async recordBuiltinToolOutput<TToolId extends BuiltinToolId>(
    toolId: TToolId,
    input: BuiltinToolInputMap[TToolId],
    output: BuiltinToolOutputMap[TToolId],
    options: { signal?: AbortSignal } = {},
  ): Promise<BuiltinToolInvocationResult<TToolId>> {
    if (!isToolOutputWithId(output)) {
      throw new Error(`builtin tool did not return an outputId: ${toolId}`);
    }
    const artifactPath = await this.artifactStore?.persistToolOutput(
      toolId,
      output.outputId as ToolOutputId,
      output,
    );
    const resultRef = createToolResultRef(
      output.outputId as ToolOutputId,
      toolId,
      this.#runState.runId,
      artifactPath,
    );
    const completionTime = this.#now();
    this.#runState = appendToHarnessRunState(
      this.#runState,
      "toolOutputs",
      resultRef,
      completionTime,
    );
    const failure = options.signal?.aborted
      ? undefined
      : classifyBuiltinToolFailure(
        toolId,
        input,
        output,
        completionTime,
        this.#runState.capabilitySnapshot,
      );
    if (failure !== undefined) {
      this.#runState = appendHarnessFailureRecord(
        this.#runState,
        failure,
        completionTime,
      );
    }
    await this.persistRunState();
    return {
      output,
      resultRef,
      runState: this.getRunState(),
    };
  }

  #resolveHostMount(path: string): {
    hostPath: string;
    mount: HostSandboxMount;
  } {
    if (this.#hostMounts.length === 0) {
      throw new Error(
        "host execution requires a host mount path to map sandbox paths",
      );
    }
    const sandboxPath = this.sandbox.resolvePath(
      path,
      this.#runState.currentDir,
    );
    const mount = this.#hostMounts.find((candidate) =>
      isSandboxPathWithinRoot(candidate.sandboxPath, sandboxPath)
    );
    if (mount === undefined) {
      throw new Error(`path escapes host-backed sandbox roots: ${path}`);
    }
    const sandboxRoot = normalizeSandboxRoot(mount.sandboxPath);
    if (sandboxPath === sandboxRoot) {
      return { hostPath: normalizeHostPath(mount.hostPath), mount };
    }
    return {
      hostPath: normalizeHostPath(
        joinHostPath(
          mount.hostPath,
          sandboxPath.slice(sandboxRoot.length + 1),
        ),
      ),
      mount,
    };
  }

  #resolveHostPath(path: string): string {
    return this.#resolveHostMount(path).hostPath;
  }

  #resolveHostRootPath(path: string): string {
    return normalizeHostPath(this.#resolveHostMount(path).mount.hostPath);
  }

  /**
   * The sandbox mount covering `path`, or `undefined` when no mount of this
   * run's sandbox does.
   *
   * What a run can read is what it mounts, so this is the question "could this
   * run see a file here?" asked of a host path. `acquire_skill` asks it of the
   * directory it is about to write a skill's scripts into: the parent that
   * plans an acquisition must not be able to read the bytes, and a mount over
   * that directory is the one way it could.
   *
   * Asked of the sandbox that would do the reading, through its own
   * `describe()`, rather than of `#hostMounts`. The two are the same list for
   * a run whose sandbox this engine built, and they are not for a run handed a
   * runtime: there `#hostMounts` comes from a configuration that "may describe
   * a different sandbox entirely" — empty, when none was given at all — and a
   * question about what a container can read, answered from a configuration
   * that container was not built from, fails open. It is also the source
   * `resolveAcquiredSkillScript` asks at execution, so the boundary is one
   * predicate over one list rather than two that agree while the runtime is
   * the one the config describes.
   *
   * A mount with no host path covers nothing: it is backed by something other
   * than a directory of this filesystem, so no path of ours is inside it.
   */
  #hostMountCovering(path: string): SandboxRuntimeMountDescription | undefined {
    const hostPath = normalizeHostPath(path);
    return this.sandbox.describe().cfc?.mounts?.find((mount) =>
      mount.hostPath !== undefined &&
      isHostPathWithinRoot(normalizeHostPath(mount.hostPath), hostPath)
    );
  }

  #hostPathToWorkspacePath(path: string): string | undefined {
    const hostPath = normalizeHostPath(path);
    for (const mount of this.#hostMounts) {
      const hostRoot = normalizeHostPath(mount.hostPath);
      if (!isHostPathWithinRoot(hostRoot, hostPath)) {
        continue;
      }
      const relativePath = relativeHostPath(hostRoot, hostPath);
      if (relativePath === "") {
        return normalizeSandboxRoot(mount.sandboxPath);
      }
      return normalizeSandboxPath(
        `${normalizeSandboxRoot(mount.sandboxPath)}/${
          relativePath.replaceAll("\\", "/")
        }`,
      );
    }
    return undefined;
  }

  async #isHostPathWithinWorkspace(
    path: string,
    options: { allowMissing?: boolean } = {},
  ): Promise<boolean> {
    if (this.workspaceHostPath === undefined) {
      return false;
    }
    const normalizedPath = normalizeHostPath(path);
    try {
      const hostRoot = await Deno.realPath(this.workspaceHostPath);
      const hostPath = await Deno.realPath(normalizedPath);
      return isHostPathWithinRoot(hostRoot, hostPath);
    } catch (error) {
      if (!options.allowMissing || !(error instanceof Deno.errors.NotFound)) {
        return false;
      }
      return await this.#missingHostPathCanResolveWithinWorkspace(
        normalizedPath,
      );
    }
  }

  async #missingHostPathCanResolveWithinWorkspace(path: string): Promise<
    boolean
  > {
    if (this.workspaceHostPath === undefined) {
      return false;
    }
    const lexicalRoot = normalizeHostPath(this.workspaceHostPath);
    let realRoot: string;
    try {
      realRoot = await Deno.realPath(this.workspaceHostPath);
    } catch {
      return false;
    }
    let candidate = normalizeHostPath(path);
    while (isHostPathWithinRoot(lexicalRoot, candidate)) {
      try {
        const realCandidate = await Deno.realPath(candidate);
        return isHostPathWithinRoot(realRoot, realCandidate);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          return false;
        }
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        return false;
      }
      candidate = parent;
    }
    return false;
  }

  async #realHostPath(path: string): Promise<string | undefined> {
    try {
      return normalizeHostPath(await Deno.realPath(path));
    } catch {
      return undefined;
    }
  }

  async #nearestExistingRealHostPath(
    path: string,
  ): Promise<string | undefined> {
    let candidate = normalizeHostPath(path);
    while (true) {
      const realPath = await this.#realHostPath(candidate);
      if (realPath !== undefined) {
        return realPath;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        return undefined;
      }
      candidate = parent;
    }
  }

  async #isHostPathWithinArtifactRoot(
    path: string,
    options: { allowMissing?: boolean } = {},
  ): Promise<boolean> {
    const root = this.artifactStore?.artifactRoot;
    if (root === undefined) {
      return false;
    }
    const normalizedRoot = normalizeHostPath(root);
    const normalizedPath = normalizeHostPath(path);
    if (isHostPathWithinRoot(normalizedRoot, normalizedPath)) {
      return true;
    }
    const realRoot = await this.#realHostPath(normalizedRoot);
    if (realRoot === undefined) {
      return false;
    }
    const realPath = options.allowMissing === true
      ? await this.#nearestExistingRealHostPath(normalizedPath)
      : await this.#realHostPath(normalizedPath);
    return realPath !== undefined && isHostPathWithinRoot(realRoot, realPath);
  }

  async #doesHostPathIntersectArtifactRoot(
    path: string,
    options: { allowMissing?: boolean } = {},
  ): Promise<boolean> {
    const root = this.artifactStore?.artifactRoot;
    if (root === undefined) {
      return false;
    }
    const normalizedRoot = normalizeHostPath(root);
    const normalizedPath = normalizeHostPath(path);
    if (
      isHostPathWithinRoot(normalizedRoot, normalizedPath) ||
      isHostPathWithinRoot(normalizedPath, normalizedRoot)
    ) {
      return true;
    }
    const realRoot = await this.#realHostPath(normalizedRoot);
    if (realRoot === undefined) {
      return false;
    }
    const realPath = options.allowMissing === true
      ? await this.#nearestExistingRealHostPath(normalizedPath)
      : await this.#realHostPath(normalizedPath);
    return realPath !== undefined &&
      (isHostPathWithinRoot(realRoot, realPath) ||
        isHostPathWithinRoot(realPath, realRoot));
  }

  async #createCfcInvocationContext(options: {
    toolId: string;
    toolOutputId?: ToolOutputId;
    operation: HarnessCfcInvocationOperation;
    cwd: string;
    command?: string;
    argv?: readonly string[];
    args?: readonly string[];
    stdinText?: string;
    env?: Record<string, string>;
    cfcInputLabels?: CfcLabelView;
    cfcInputLabelPaths?: readonly HarnessCfcInvocationInputLabelPath[];
    cfcPromptSlotInputLabelPaths?:
      readonly HarnessCfcInvocationInputLabelPath[];
    cfcModelContextInputLabelPaths?:
      readonly HarnessCfcInvocationInputLabelPath[];
  }): Promise<HarnessCfcInvocationContext> {
    const now = this.#now();
    const invocation = await createHarnessCfcInvocationContext({
      sequence: (this.#runState.cfcInvocationContexts ?? []).length + 1,
      runId: this.#runState.runId,
      createdAt: now,
      toolId: options.toolId,
      ...(options.toolOutputId !== undefined
        ? { toolOutputId: options.toolOutputId }
        : {}),
      operation: options.operation,
      cfcEnforcementMode: this.#runState.cfcEnforcementMode,
      cwd: options.cwd,
      ...(this.#runState.promptSlotBinding !== undefined
        ? { promptSlot: this.#runState.promptSlotBinding }
        : {}),
      runManifest: summarizeCfcInvocationRunManifest(
        this.#runState.runManifest,
        this.#runState.runManifestPath,
      ),
      ...(options.command !== undefined ? { command: options.command } : {}),
      ...(options.argv !== undefined ? { argv: options.argv } : {}),
      ...(options.args !== undefined ? { args: options.args } : {}),
      ...(options.stdinText !== undefined
        ? { stdinText: options.stdinText }
        : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.cfcInputLabels !== undefined
        ? { cfcInputLabels: options.cfcInputLabels }
        : {}),
      ...(options.cfcInputLabelPaths !== undefined
        ? { cfcInputLabelPaths: options.cfcInputLabelPaths }
        : {}),
      ...(options.cfcPromptSlotInputLabelPaths !== undefined
        ? { cfcPromptSlotInputLabelPaths: options.cfcPromptSlotInputLabelPaths }
        : {}),
      ...(options.cfcModelContextInputLabelPaths !== undefined
        ? {
          cfcModelContextInputLabelPaths:
            options.cfcModelContextInputLabelPaths,
        }
        : {}),
      ...(this.#runState.cfcModelContext !== undefined
        ? { cfcModelContext: this.#runState.cfcModelContext }
        : {}),
    });
    this.#runState = appendToHarnessRunState(
      this.#runState,
      "cfcInvocationContexts",
      invocation,
      now,
    );
    await this.persistRunState();
    return invocation;
  }

  #researchTaskCfcLabel(): IFCLabel | undefined {
    const paths: readonly HarnessCfcInvocationInputLabelPath[] = [[
      "args",
      "task",
    ]];
    const view = mergeCfcLabelViews([
      createHarnessPromptSlotInfluenceLabels({
        promptSlot: this.#runState.promptSlotBinding,
        runManifest: summarizeCfcInvocationRunManifest(
          this.#runState.runManifest,
          this.#runState.runManifestPath,
        ),
        paths,
      }),
      createHarnessCfcModelContextInputLabels({
        modelContext: this.#runState.cfcModelContext,
        paths,
      }),
    ]);
    return view?.entries.reduce<IFCLabel | undefined>(
      (label, entry) => mergeLabel(label, entry.label),
      undefined,
    );
  }

  #createToolContext(signal?: AbortSignal) {
    const researchTaskCfcLabel = this.#researchTaskCfcLabel();
    return {
      runId: this.#runState.runId,
      cfcEnforcementMode: this.#runState.cfcEnforcementMode,
      currentDir: this.#runState.currentDir,
      workspaceHostPath: this.workspaceHostPath,
      ...(signal !== undefined ? { signal } : {}),
      skillRegistry: this.#runState.skillRegistry,
      skillActivations: this.#runState.skillActivations,
      allowSkillScripts: this.config.allowSkillScripts,
      allowedSkillScripts: this.config.allowedSkillScripts,
      skillScriptExecutionTarget: this.config.skillScriptExecutionTarget,
      browserAccess: this.config.browserAccess,
      handleValueOrigins: this.config.handleValueOrigins,
      handleTable: this.handleTable,
      ...(this.#fabricSessionFactory !== undefined
        ? { getFabricSession: this.#fabricSessionFactory }
        : {}),
      ...(this.config.fabricSession !== undefined
        ? {
          fabricSessionTarget: {
            apiUrl: this.config.fabricSession.apiUrl,
            space: this.config.fabricSession.space,
          },
        }
        : {}),
      ...(this.#openProbeRuntime !== undefined
        ? { openProbeRuntime: this.#openProbeRuntime }
        : {}),
      ...(this.#patternIndexClientFactory !== undefined
        ? {
          getPatternIndexClient: this.#patternIndexClientFactory,
          patternIndexPublishEnabled: this.patternIndexPublishEnabled,
          patternIndexPublishDiscoverable: this.patternIndexPublishDiscoverable,
          patternIndexLedger: this.patternIndexLedger,
        }
        : {}),
      ...(this.docsCorpusAvailable
        ? { getDocsCorpus: () => this.getDocsCorpus() }
        : {}),
      ...(this.#researchRunner !== undefined
        ? { runResearch: this.#researchRunner }
        : {}),
      researchRuns: this.#runState.researchRuns ?? [],
      researchGoal: this.#runState.researchGoal,
      ...(researchTaskCfcLabel !== undefined
        ? {
          researchTaskCfcLabel,
          // A research task and any other model-authored argument have the
          // same provenance, so they carry the same label.
          toolInputCfcLabel: researchTaskCfcLabel,
        }
        : {}),
      patternRefs: this.#runState.patternRefs ?? [],
      inputCells: this.#runState.inputCells ?? [],
      recordAssignedPiece: (piece: HarnessAssignedPiece) => {
        this.#runState = patchHarnessRunState(this.#runState, {
          assignedPieces: [
            ...(this.#runState.assignedPieces ?? []).filter((existing) =>
              existing.ref !== piece.ref
            ),
            structuredClone(piece),
          ],
        }, this.#now());
      },
      recordResearchRun: (run: HarnessResearchRunSummary) => {
        this.recordResearchRun(run);
      },
      recordResearchFailure: () => {
        this.recordResearchFailures(1);
      },
      ...(this.#skillsShSearchClientFactory !== undefined
        ? { getSkillsShSearchClient: this.#skillsShSearchClientFactory }
        : {}),
      ...(this.#skillsShAcquisitionClientFactory !== undefined
        ? {
          getSkillsShAcquisitionClient: this.#skillsShAcquisitionClientFactory,
        }
        : {}),
      mintSkillContextHandle: (
        ref: string,
        acquisition: HarnessSkillAcquisition,
      ) => this.mintSkillContextHandle(ref, acquisition),
      ...(this.#taskText !== undefined ? { taskText: this.#taskText } : {}),
      sandbox: this.sandbox,
      hostProcessRunner: this.hostProcessRunner,
      loomAuthoring: this.config.loomAuthoring,
      loomRetrieval: this.config.loomRetrieval,
      mintReferentHandle: (
        referent: Omit<HarnessHandleReferent, "token" | "kind">,
      ) => this.mintReferentHandle(referent),
      ...(this.#structuredResult !== undefined
        ? {
          structuredResult: {
            schema: this.#structuredResult.schema,
            record: (value: unknown) => this.#recordStructuredResult(value),
          },
        }
        : {}),
      ...(this.config.fabricSession?.cfcReadMaxConfidentiality !== undefined
        ? {
          cfcReadMaxConfidentiality:
            this.config.fabricSession.cfcReadMaxConfidentiality,
        }
        : {}),
      resolvePath: (path: string) =>
        this.sandbox.resolvePath(path, this.#runState.currentDir),
      resolveHostPath: (path: string) => this.#resolveHostPath(path),
      resolveHostRootPath: (path: string) => this.#resolveHostRootPath(path),
      hostPathToWorkspacePath: (path: string) =>
        this.#hostPathToWorkspacePath(path),
      isHostPathWithinWorkspace: (
        path: string,
        options?: { allowMissing?: boolean },
      ) => this.#isHostPathWithinWorkspace(path, options),
      isHostPathWithinArtifactRoot: (
        path: string,
        options?: { allowMissing?: boolean },
      ) => this.#isHostPathWithinArtifactRoot(path, options),
      imageAttachmentSnapshotDir: this.artifactStore
        ?.imageAttachmentSnapshotDir,
      doesHostPathIntersectArtifactRoot: (
        path: string,
        options?: { allowMissing?: boolean },
      ) => this.#doesHostPathIntersectArtifactRoot(path, options),
      setCurrentDir: (path: string) => {
        const resolved = this.sandbox.resolvePath(
          path,
          this.#runState.currentDir,
        );
        this.#runState = patchHarnessRunState(
          this.#runState,
          { currentDir: resolved },
          this.#now(),
        );
      },
      nextOutputId: (toolId: string) => {
        return this.nextToolOutputId(toolId);
      },
      now: () => this.#now(),
      recordSkillResourceRead: async (read: HarnessSkillResourceRead) => {
        await this.recordSkillResourceRead(read);
      },
      recordSkillScriptExecution: async (
        execution: HarnessSkillScriptExecution,
      ) => {
        await this.recordSkillScriptExecution(execution);
      },
      ...(this.artifactStore?.writeAcquiredSkillScript !== undefined
        ? {
          materializeAcquiredSkill: (
            options: Parameters<
              CfHarnessEngine["materializeAcquiredSkill"]
            >[0],
          ) => this.materializeAcquiredSkill(options),
        }
        : {}),
      ...(this.#runState.acquiredSkills !== undefined
        ? { acquiredSkills: this.#runState.acquiredSkills.skills }
        : {}),
      createCfcInvocationContext: (options: {
        toolId: string;
        toolOutputId?: ToolOutputId;
        operation: HarnessCfcInvocationOperation;
        cwd: string;
        command?: string;
        argv?: readonly string[];
        args?: readonly string[];
        stdinText?: string;
        env?: Record<string, string>;
        cfcInputLabels?: CfcLabelView;
        cfcInputLabelPaths?: readonly HarnessCfcInvocationInputLabelPath[];
        cfcPromptSlotInputLabelPaths?:
          readonly HarnessCfcInvocationInputLabelPath[];
        cfcModelContextInputLabelPaths?:
          readonly HarnessCfcInvocationInputLabelPath[];
      }) => this.#createCfcInvocationContext(options),
    };
  }
}

export const createHarnessEngine = (
  options: CreateHarnessEngineOptions = {},
): CfHarnessEngine => new CfHarnessEngine(options);

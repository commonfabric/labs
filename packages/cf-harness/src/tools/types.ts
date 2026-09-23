import type { JSONSchema } from "@commonfabric/api";
import type {
  CfcConfClause,
  CfcEnforcementMode,
  CfcLabelView,
  IFCLabel,
} from "@commonfabric/runner/cfc";
import type {
  HarnessCfcInvocationContext,
  HarnessCfcInvocationInputLabelPath,
  HarnessCfcInvocationOperation,
} from "../contracts/cfc-invocation-context.ts";
import type {
  HarnessAcquiredSkill,
  HarnessAllowedSkillScript,
  HarnessSkillAcquisition,
  HarnessSkillActivations,
  HarnessSkillRegistry,
  HarnessSkillResourceRead,
  HarnessSkillScriptExecution,
  HarnessSkillScriptExecutionTarget,
} from "../contracts/skill.ts";
import type { HarnessBrowserAccessLease } from "../contracts/browser-access.ts";
import type { HarnessAssignedPiece } from "../contracts/assigned-piece.ts";
import type { HarnessDocsCorpus } from "../docs-corpus/corpus.ts";
import type {
  HarnessResearchHandleValue,
  HarnessResearchRunSummary,
} from "../contracts/research.ts";
import type { HarnessPatternRef } from "../contracts/pattern-refs.ts";
import type { HarnessInputCell } from "../contracts/input-cells.ts";
import type { HarnessWellKnownGrant } from "../contracts/well-known-grants.ts";
import type { HarnessResearchRunner } from "../research/runner.ts";
import type {
  HarnessDocumentReferentDraft,
  HarnessHandleTable,
} from "../contracts/handle-table.ts";
import type { HarnessFabricSession } from "../fabric-session.ts";
import type { openProbeRuntime } from "../pattern-index/probe-runtime.ts";
import type { PatternIndexClient } from "../pattern-index/client.ts";
import type { PatternIndexLedger } from "../pattern-index/ledger.ts";
import type { SkillsShAcquisitionClient } from "../skills-sh/acquisition.ts";
import type { SkillsShSearchClient } from "../skills-sh/search-client.ts";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { ToolOutputId } from "../contracts/tool-result.ts";
import type { HarnessLoomAuthoringConfig } from "../loom-authoring.ts";
import type { HarnessLoomRetrievalConfig } from "../loom-retrieval.ts";
import type { ProcessRunner } from "../sandbox/process-runner.ts";
import type { SandboxRuntime } from "../sandbox/types.ts";

export interface HarnessToolContext {
  runId: string;
  cfcEnforcementMode: CfcEnforcementMode;
  skillRegistry?: HarnessSkillRegistry;
  skillActivations?: HarnessSkillActivations;
  allowSkillScripts?: boolean;
  allowedSkillScripts?: readonly HarnessAllowedSkillScript[];
  skillScriptExecutionTarget: HarnessSkillScriptExecutionTarget;
  browserAccess?: HarnessBrowserAccessLease;

  /**
   * Origins a value materialized from a handle may be sent to. Absent or
   * empty means none: materialization is default-deny by destination, and a
   * tool that would send a handle's value somewhere refuses rather than
   * asking the model where it meant.
   */
  handleValueOrigins?: readonly string[];

  /**
   * The run's handle table, as it stands at the invocation. Undefined until
   * the run mints its first handle. `describe_handle` reads it directly, and
   * value-handle consumers use it to prove membership and enforce entry
   * capabilities. Ordinary tool inputs see general tokens resolved to
   * addresses by the prompt loop; restricted tokens remain opaque.
   */
  handleTable?: HarnessHandleTable;

  /**
   * The references granted to the run, each already a general handle in
   * {@link handleTable}. A grant pairs its token with a name a model may be
   * handed, which is what lets a tool say which handle is which without
   * describing every one.
   */
  wellKnownGrants?: readonly HarnessWellKnownGrant[];

  /**
   * The run's trusted Fabric session, lazy and cached by the engine.
   * Undefined when the run has no fabric session configured, which also
   * keeps `run_pattern` and `acquire_skill` out of the tool surface.
   */
  getFabricSession?: () => Promise<HarnessFabricSession>;

  /** Host-configured deployment target, without its identity key path. */
  fabricSessionTarget?: {
    /** Toolshed API base URL for the run. */
    apiUrl: string;

    /** Configured space name or DID for the run. */
    space: string;
  };

  /**
   * Opens the render gate's probe runtime; `openProbeRuntime` by default. A
   * test replaces it to see what the gate opens the probe under.
   */
  openProbeRuntime?: typeof openProbeRuntime;

  /**
   * The run's pattern-index client, lazy and cached by the engine.
   * Undefined when the run has no pattern index configured, which also keeps
   * `search_patterns` and `record_feedback` out of the tool surface and
   * `run_pattern`'s `patternId` argument unusable.
   */
  getPatternIndexClient?: () => Promise<PatternIndexClient>;

  /**
   * The run's documentation corpus, lazy and cached by the engine. Undefined
   * when the run configures no corpus root.
   */
  getDocsCorpus?: () => Promise<HarnessDocsCorpus>;

  /**
   * Runs one bounded Common Fabric research loop on the trusted host side.
   * Undefined for an invocation outside a prompt loop, which has no model to
   * spend.
   */
  runResearch?: HarnessResearchRunner;

  /** Prior admitted kits retained by this run for follow-up and delegation. */
  researchRuns?: readonly HarnessResearchRunSummary[];

  /** Current user goal supplied by the host, independent of the research question. */
  researchGoal?: string;

  /** Existing CFC label on a research task and its accumulated model context. */
  researchTaskCfcLabel?: IFCLabel;

  /**
   * The label of this tool call's input: the prompt slot's influence joined
   * with everything the run's model context has observed, which is what a
   * model-authored argument can carry. Absent when neither carries a label.
   */
  toolInputCfcLabel?: IFCLabel;

  /** Pattern attachments resolved by the host before the first model turn. */
  patternRefs?: readonly HarnessPatternRef[];

  /** Explicit input-cell attachments established for the calling run. */
  inputCells?: readonly HarnessInputCell[];

  /** Retains a successful naming receipt for the next session turn. */
  recordAssignedPiece?(piece: HarnessAssignedPiece): void;

  /** Adds one admitted kit and its trusted records to durable run state. */
  recordResearchRun?(run: HarnessResearchRunSummary): void | Promise<void>;

  /** Counts a bounded research call that returned no implementation kit. */
  recordResearchFailure?(): void | Promise<void>;

  /**
   * The run's skills.sh discovery client, lazy and cached by the engine.
   * Undefined when no remote skill registry is configured, which also keeps
   * `search_skills` out of the tool surface.
   */
  getSkillsShSearchClient?: () => Promise<SkillsShSearchClient>;

  /**
   * The run's host-side pinned acquisition client. Undefined when external
   * skill acquisition is not configured, which keeps `acquire_skill` absent.
   */
  getSkillsShAcquisitionClient?: () => Promise<SkillsShAcquisitionClient>;

  /**
   * Mints the sole capability that may enter delegate_task.skillHandle,
   * recording where the caller fetched the value from. The provenance is
   * mandatory because the mint is reachable only from the acquisition step,
   * which always knows it, and an entry without it could name no commit when
   * the handle is later delegated.
   */
  mintSkillContextHandle?(
    ref: string,
    acquisition: HarnessSkillAcquisition,
  ): Promise<string>;

  /**
   * Whether a pattern the model authored and ran successfully is published
   * back to the index. Absent or `false` makes the run a reader of the index
   * only; the client is still there, since a run that does not publish still
   * searches, runs, and votes.
   */
  patternIndexPublishEnabled?: boolean;

  /**
   * Whether a successful authored pattern is offered to search immediately.
   * Absent or `false` records it without making it discoverable.
   */
  patternIndexPublishDiscoverable?: boolean;

  /**
   * Where this run's writes to the pattern index go: a pattern it authored is
   * held there until the session ends, so search is offered one candidate per
   * capability while the index still records every iteration, and a report
   * about an indexed pattern it ran is sent from there — see
   * `pattern-index/ledger.ts`. Absent when the run has no index, and absent
   * for a tool invoked outside the engine, which neither publishes nor
   * reports.
   */
  patternIndexLedger?: PatternIndexLedger;

  /**
   * What this run was asked to do, in the words it was asked in. A published
   * pattern carries it as the request it answers, which is what the index
   * ranks a later search against. Absent when the run has no such text.
   */
  taskText?: string;

  /**
   * The prompt loop's run-level abort signal, when the invocation came
   * through the loop. The only cancellation source a tool may honor — no
   * tool-side timeout supplements it. Tools are free to ignore it.
   */
  signal?: AbortSignal;

  sandbox: SandboxRuntime;
  hostProcessRunner: ProcessRunner;

  /** Host-owned Loom command routing, absent when the run has no grant. */
  loomAuthoring?: HarnessLoomAuthoringConfig;

  /** Host-owned Loom retrieval routing, absent when the run has no grant. */
  loomRetrieval?: HarnessLoomRetrievalConfig;

  /**
   * Registers content a tool observed as a referent the run holds, and
   * returns its token. Absent outside a run that keeps a handle table.
   */
  mintReferentHandle?(referent: HarnessDocumentReferentDraft): Promise<string>;

  /**
   * Registers an admitted research kit's content as the research referent
   * the run holds, under the kit's label, and returns its token. The research
   * tool's admission is its caller. Absent outside a run that keeps a handle
   * table.
   */
  mintResearchHandle?(
    value: HarnessResearchHandleValue,
    label: IFCLabel,
  ): Promise<string>;

  /**
   * Where the run's structured result goes, absent when the run was
   * configured with no schema. `record` writes a validated value where the
   * file-based path leaves one, and reports whether it replaced an earlier
   * one.
   */
  structuredResult?: {
    schema: JSONSchema;
    record(value: unknown): Promise<{ replaced: boolean }>;
  };

  /**
   * The run's observation ceiling: the fabric session's read ceiling, met
   * with the run manifest's where one names any. A tool that admits values
   * from outside the fabric — Loom rows — measures their labels against it
   * before they enter model context. Absent is no ceiling, which admits
   * every readable label.
   */
  cfcReadMaxConfidentiality?: readonly CfcConfClause[];
  currentDir: string;
  workspaceHostPath?: string;
  resolvePath(path: string): string;
  resolveHostPath(path: string): string;
  resolveHostRootPath(path: string): string;
  hostPathToWorkspacePath(path: string): string | undefined;
  isHostPathWithinWorkspace(
    path: string,
    options?: { allowMissing?: boolean },
  ): Promise<boolean>;
  isHostPathWithinArtifactRoot(
    path: string,
    options?: { allowMissing?: boolean },
  ): Promise<boolean>;

  /**
   * Host directory for image-attachment snapshots (under the artifact
   * root). Undefined when the run has no artifact store; attachments then
   * stay locked to their source file's bytes.
   */
  imageAttachmentSnapshotDir?: string;

  doesHostPathIntersectArtifactRoot(
    path: string,
    options?: { allowMissing?: boolean },
  ): Promise<boolean>;
  setCurrentDir(path: string): void;
  nextOutputId(toolId: string): ToolOutputId;
  now(): string;
  recordSkillResourceRead(read: HarnessSkillResourceRead): Promise<void>;
  recordSkillScriptExecution(
    execution: HarnessSkillScriptExecution,
  ): Promise<void>;

  /**
   * Writes one acquired skill's scripts where a run holding its handle can
   * execute them, and records where they went. Absent for a run that can
   * write no artifacts, which acquires instructions and no script.
   *
   * @throws Error when a mount of this run's sandbox covers the directory,
   * since a script the acquiring run can read is one its planner can read.
   */
  materializeAcquiredSkill?(options: {
    registryId: string;
    commitSha: string;
    scripts: readonly {
      path: string;
      bytes: Uint8Array;
      valueDigest: string;
    }[];
  }): Promise<HarnessAcquiredSkill>;

  /** The skills this run has acquired scripts for, as it stands. */
  acquiredSkills?: readonly HarnessAcquiredSkill[];

  createCfcInvocationContext(options: {
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
  }): Promise<HarnessCfcInvocationContext>;
}

export interface HarnessToolDefinition<Input = unknown, Output = unknown> {
  descriptor: HarnessToolDescriptor;
  invoke(context: HarnessToolContext, input: Input): Promise<Output>;
}

export const createUnimplementedToolError = (toolId: string): Error =>
  new Error(`${toolId} is not implemented yet`);

/**
 * How one cf-harness session is assembled, for every surface that starts one.
 *
 * A session is described by {@link HarnessSessionConfig} — identity and space,
 * index and publish posture, skills root and registry, host mounts, input
 * cells, CFC dials, tool and subagent allowances, model settings — and this
 * module turns that description into the three things a surface needs: the
 * engine and prompt-loop options it constructs a run from
 * ({@link harnessSessionEngineOptions}), the tool policy the run offers
 * ({@link harnessSessionChatPolicy}), and the context messages the run opens
 * with ({@link establishHarnessSessionContext}).
 *
 * A surface's own job is to produce the config: the batch CLI parses argv and
 * the environment into one, the console server reads flags, environment and
 * the request body into one. Neither assembles a session itself. A surface
 * that did would drift from the other the moment a capability was added, and
 * every capability added since the console shipped had drifted exactly that
 * way — external skill acquisition, host mounts, discoverable publishing,
 * well-known grants and input cells were all reachable from argv and from
 * nowhere else.
 */

import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type { HarnessLoomAuthoringConfig } from "./loom-authoring.ts";
import type { HarnessLoomRetrievalConfig } from "./loom-retrieval.ts";
import type { CfHarnessEngine } from "./engine.ts";
import type {
  HarnessFabricSessionConfig,
  HarnessPatternIndexConfig,
  HarnessSkillsShConfig,
} from "./config.ts";
import type { HarnessBrowserAccessLease } from "./contracts/browser-access.ts";
import type { HarnessChatPolicy } from "./contracts/interactive-chat.ts";
import type { PromptSlotBinding } from "./contracts/prompt-slot.ts";
import type { HarnessInputCellSpec } from "./contracts/input-cells.ts";
import type { HarnessPatternRefSpec } from "./contracts/pattern-refs.ts";
import type { HarnessConnectorGrantSpec } from "./contracts/well-known-grants.ts";
import type {
  HarnessAllowedSkillScript,
  HarnessSkillScriptExecutionTarget,
  HarnessSkillsRootRecord,
} from "./contracts/skill.ts";
import type { HarnessDocsCorpusRecord } from "./contracts/docs-corpus.ts";
import { resolveHarnessDocsCorpus } from "./docs-corpus/corpus.ts";
import type { HarnessSubagentProfile } from "./contracts/subagent.ts";
import {
  type BuiltinToolId,
  type HarnessToolBackingAvailability,
  parentToolIdsForBacking,
} from "./contracts/tool-descriptor.ts";
import {
  type CfHarnessHostMountConfig,
  hostMountsToAdditionalMounts,
} from "./host-mounts.ts";
import { patternRefsContextMessage } from "./pattern-refs.ts";
import { pieceTargetingContextMessages } from "./piece-targeting.ts";
import { REVISION_VERIFICATION_GUIDANCE } from "./revision-verification.ts";
import type { CreateHarnessPromptLoopOptions } from "./prompt-loop.ts";
import type { DockerRunscAdditionalMountConfig } from "./sandbox/types.ts";
import { loadHarnessSkillContext } from "./skills/registry.ts";
import { persistHarnessRunSkillRegistry } from "./skills/run-registry.ts";
import { wellKnownGrantsContextMessage } from "./well-known-grants.ts";

/**
 * Everything one harness session runs under, resolved. Surface-specific
 * concerns are deliberately absent: how a prompt arrived, where a transcript
 * is written, which port a server binds, whether a result is printed as JSON.
 * What is here is what changes the run.
 */
export interface HarnessSessionConfig {
  /** The host directory the run's workspace is mounted from. */
  workspace: string;

  /** The sandbox directory the run starts in, when it is not the workspace. */
  cwd?: string;

  artifactRoot: string;
  model?: string;
  maxModelTurns: number;

  /** The harness's own enforcement dial, over tool policy and the sandbox. */
  cfcEnforcementModeOverride?: CfcEnforcementMode;

  /** The sandbox's two CFC sidecar transports. */
  cfcResultDir?: string;
  cfcInvocationContextDir?: string;

  sandboxImage?: string;
  sandboxDockerRuntime?: string;

  /** The skills tree scanned into the run's registry, on the host. */
  skillsRoot?: string;

  /** Where {@link skillsRoot} came from, as the run records it. */
  skillsRootRecord?: HarnessSkillsRootRecord;

  /** The same tree as the sandbox addresses it, when the two differ. */
  skillsRootSandboxPath?: string;

  /** Skills preloaded into the run's opening context, by name. */
  skillNames: readonly string[];

  /** Reference trees `research` may inspect, and where they came from. */
  docsCorpus?: HarnessDocsCorpusRecord;

  /** Whether a skill this run holds may have its scripts run in the sandbox. */
  allowSkillScripts?: boolean;

  allowedSkillScripts: readonly HarnessAllowedSkillScript[];
  skillScriptExecutionTarget: HarnessSkillScriptExecutionTarget;

  fabricSession?: HarnessFabricSessionConfig;

  /**
   * The space database the run's per-cell label snapshot reads. The labels a
   * session writes land in the serving toolshed's own store, and the snapshot
   * reads that file rather than asking over the wire; absent, the file is
   * found by searching this host's caches for the space the fabric session
   * names, which finds only a toolshed serving from the same checkout.
   */
  spaceDbPath?: string;

  /** Explicit host-owned backing for durable Loom authoring. */
  loomAuthoring?: HarnessLoomAuthoringConfig;

  /** Explicit host-owned backing for read-only Loom retrieval. */
  loomRetrieval?: HarnessLoomRetrievalConfig;

  patternIndex?: HarnessPatternIndexConfig;
  skillsSh?: HarnessSkillsShConfig;

  /** A FUSE mount of the session's fabric, provisioned into the sandbox. */
  fabricMount?: string;

  hostMounts: readonly CfHarnessHostMountConfig[];

  /** Cells the operator passes in by reference, named for the model. */
  inputCells: readonly HarnessInputCellSpec[];

  /**
   * Connector handles every session on this console is granted, named by the
   * CFC class the loom instance behind it declares for each.
   */
  connectorGrants: readonly HarnessConnectorGrantSpec[];

  /** Published patterns the caller attaches to the task by index id. */
  patternRefs: readonly HarnessPatternRefSpec[];

  handleValueOrigins: readonly string[];

  /**
   * The parent tool surface, narrowed. Absent means the whole surface this
   * run's backing supports — see {@link parentToolIdsForBacking}.
   */
  allowedToolIds?: readonly BuiltinToolId[];

  allowedSubagentProfiles: readonly HarnessSubagentProfile[];
  browserAccess?: HarnessBrowserAccessLease;
  reasoningEffort?: string;
  compactThreshold?: number;
  promptCacheMode?: "implicit" | "explicit";

  /** Whether a `pattern-author` child keeps its composition guidance. */
  subagentCompositionGuidance?: boolean;
}

/**
 * What this configuration can back the gated tools with, before any run
 * exists. The engine answers the same question from the client factories it
 * built; this answers it from the configuration those factories are built
 * out of, so a surface can state its tool policy at startup.
 */
export const harnessSessionToolBacking = (
  config: HarnessSessionConfig,
): HarnessToolBackingAvailability => ({
  fabricSessionAvailable: config.fabricSession !== undefined,
  loomAuthoringAvailable: config.loomAuthoring !== undefined,
  loomRetrievalAvailable: config.loomRetrieval !== undefined,
  patternIndexAvailable: config.patternIndex !== undefined,
  skillsShSearchAvailable: config.skillsSh !== undefined,
  skillsShAcquisitionAvailable: config.skillsSh !== undefined,
  skillRegistryAvailable: config.skillsRoot !== undefined,
  docsCorpusAvailable:
    (resolveHarnessDocsCorpus(config.docsCorpus)?.roots ?? []).length > 0,
});

/**
 * The chat policy a session runs under: the tools it may call, the subagent
 * profiles it may delegate to, its enforcement dial, and the standing of the
 * prompt that starts each turn.
 *
 * The tool list is derived rather than listed, so a tool added to the harness
 * reaches every surface at once — and a tool whose backing this session lacks
 * is absent rather than offered and failing.
 */
export const harnessSessionChatPolicy = (
  config: HarnessSessionConfig,
  promptSlot?: PromptSlotBinding,
): HarnessChatPolicy => ({
  type: "cf-harness.chat-policy",
  toolMode: "workspace-write",
  allowedToolIds: config.allowedToolIds ?? sessionParentToolIds(config),
  allowedSubagentProfiles: config.allowedSubagentProfiles,
  ...(config.cfcEnforcementModeOverride !== undefined
    ? { cfcEnforcementMode: config.cfcEnforcementModeOverride }
    : {}),
  ...(promptSlot !== undefined ? { promptSlot } : {}),
});

/**
 * The parent tool surface a session offers when nothing narrows it: what its
 * backings support, plus `run_skill_script` where the operator allows a skill
 * script and a registry backs one.
 *
 * Backing and authorization are different questions, and
 * {@link parentToolIdsForBacking} answers only the first: `run_skill_script`
 * appears in its withheld set and never in the list it builds, so a backing
 * alone never offers the tool. What offers it is the operator allowing a
 * script to run — the run-wide switch, or an exact entry — and offering it
 * here is what makes that decision reach the run holding the registry, rather
 * than only a child holding an acquisition, which gets it from its own
 * surface. The gate at the call still decides which script, and whether a
 * host target needs an exact name.
 */
const sessionParentToolIds = (
  config: HarnessSessionConfig,
): readonly BuiltinToolId[] => {
  const backing = harnessSessionToolBacking(config);
  const backed = parentToolIdsForBacking(backing);
  const allowsAScript = config.allowSkillScripts === true ||
    (config.allowedSkillScripts?.length ?? 0) > 0;
  return allowsAScript && backing.skillRegistryAvailable &&
      !backed.includes("run_skill_script")
    ? [...backed, "run_skill_script"]
    : backed;
};

/** The sandbox bind mounts this session provisions, in one list. */
export const harnessSessionAdditionalMounts = (
  config: HarnessSessionConfig,
): readonly DockerRunscAdditionalMountConfig[] => [
  ...(config.fabricMount !== undefined
    ? [{ kind: "fabric-fuse" as const, hostPath: config.fabricMount }]
    : []),
  ...hostMountsToAdditionalMounts(config.hostMounts),
];

/**
 * The engine and prompt-loop options one session is built from.
 *
 * `CreateHarnessPromptLoopOptions` extends the engine's own options, so one
 * object serves both constructions and a surface cannot hand the engine and
 * the loop two different sessions. What is left to the caller is everything
 * this configuration does not decide: the model binding it resolved, the run
 * manifest it read, the transcript or run state it is resuming, and the test
 * seams it injects.
 */
export const harnessSessionEngineOptions = (
  config: HarnessSessionConfig,
): CreateHarnessPromptLoopOptions => {
  const additionalMounts = harnessSessionAdditionalMounts(config);
  return {
    workspaceHostPath: config.workspace,
    artifactRoot: config.artifactRoot,
    maxModelTurns: config.maxModelTurns,
    skillScriptExecutionTarget: config.skillScriptExecutionTarget,
    allowedSubagentProfiles: config.allowedSubagentProfiles,
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    ...(config.sandboxImage !== undefined
      ? { sandboxImage: config.sandboxImage }
      : {}),
    ...(config.sandboxDockerRuntime !== undefined
      ? { sandboxDockerRuntime: config.sandboxDockerRuntime }
      : {}),
    ...(config.cfcResultDir !== undefined
      ? { cfcResultDir: config.cfcResultDir }
      : {}),
    ...(config.cfcInvocationContextDir !== undefined
      ? { cfcInvocationContextDir: config.cfcInvocationContextDir }
      : {}),
    ...(config.cfcEnforcementModeOverride !== undefined
      ? { cfcEnforcementModeOverride: config.cfcEnforcementModeOverride }
      : {}),
    ...(config.skillsRoot !== undefined
      ? { skillsRoot: config.skillsRoot }
      : {}),
    ...(config.skillsRootRecord !== undefined
      ? { skillsRootRecord: config.skillsRootRecord }
      : {}),
    ...(config.docsCorpus !== undefined
      ? { docsCorpus: config.docsCorpus }
      : {}),
    ...(config.allowSkillScripts === true ? { allowSkillScripts: true } : {}),
    ...(config.allowedSkillScripts.length > 0
      ? { allowedSkillScripts: config.allowedSkillScripts }
      : {}),
    ...(config.browserAccess !== undefined
      ? { browserAccess: config.browserAccess }
      : {}),
    ...(config.handleValueOrigins.length > 0
      ? { handleValueOrigins: config.handleValueOrigins }
      : {}),
    ...(config.fabricSession !== undefined
      ? { fabricSession: config.fabricSession }
      : {}),
    ...(config.spaceDbPath !== undefined
      ? { spaceDbPath: config.spaceDbPath }
      : {}),
    ...(config.loomAuthoring !== undefined
      ? { loomAuthoring: config.loomAuthoring }
      : {}),
    ...(config.loomRetrieval !== undefined
      ? { loomRetrieval: config.loomRetrieval }
      : {}),
    ...(config.patternIndex !== undefined
      ? { patternIndex: config.patternIndex }
      : {}),
    ...(config.skillsSh !== undefined ? { skillsSh: config.skillsSh } : {}),
    ...(additionalMounts.length > 0 ? { additionalMounts } : {}),
    ...(config.inputCells.length > 0 ? { inputCells: config.inputCells } : {}),
    ...(config.connectorGrants.length > 0
      ? { connectorGrants: config.connectorGrants }
      : {}),
    ...(config.patternRefs.length > 0
      ? { patternRefs: config.patternRefs }
      : {}),
    ...(config.allowedToolIds !== undefined
      ? { allowedToolIds: config.allowedToolIds }
      : {}),
    ...(config.reasoningEffort !== undefined
      ? { reasoningEffort: config.reasoningEffort }
      : {}),
    ...(config.compactThreshold !== undefined
      ? { compactThreshold: config.compactThreshold }
      : {}),
    ...(config.promptCacheMode !== undefined
      ? { promptCacheMode: config.promptCacheMode }
      : {}),
    ...(config.subagentCompositionGuidance !== undefined
      ? { subagentCompositionGuidance: config.subagentCompositionGuidance }
      : {}),
  };
};

/** What {@link establishHarnessSessionContext} is given beyond the engine. */
export interface EstablishHarnessSessionContextOptions {
  engine: CfHarnessEngine;

  config: Pick<
    HarnessSessionConfig,
    "skillsRoot" | "skillsRootSandboxPath" | "skillNames"
  >;

  /**
   * Where a session that could not connect its fabric is reported. The run
   * proceeds without its grants — its tools surface the same failure when
   * called — but the absence is said out loud rather than left to be noticed.
   */
  onGrantsUnavailable?: (error: unknown) => void;
}

/**
 * Brings up everything a run holds before its first model turn, and returns
 * the context messages announcing it: the skill registry and any preloaded
 * skills, the well-known grants of the session's space, host-supplied input
 * cells, and the guidance for selecting a piece target.
 *
 * The three differ in how they fail, and deliberately. A missing skills root
 * simply yields no messages. Grants are best-effort: a session that will not
 * connect is reported and the run continues, because a grant is an
 * entitlement the run did not ask for. Input cells name task targets, whether
 * attached by the operator or retained by the session, so one that cannot be
 * minted fails the run rather than starting it without that target.
 *
 * This is the first thing the run's driver does, so it takes the run
 * (`running`) before anything else and, when a step throws, fails it as
 * `setup_error` before rethrowing: a run that dies here is as terminal on
 * disk as one that dies in its loop.
 *
 * @throws Error from the step that failed, after the run is recorded failed.
 */
export const establishHarnessSessionContext = async (
  options: EstablishHarnessSessionContextOptions,
): Promise<string[]> => {
  const { engine } = options;
  engine.startRun();
  try {
    return await establishContextMessages(options);
  } catch (error) {
    try {
      await engine.failRun("setup_error", error);
    } catch {
      // The setup failure is the outcome to report; a failure to record it
      // does not replace it.
    }
    throw error;
  }
};

/** Helper for `establishHarnessSessionContext()`, which does its steps. */
const establishContextMessages = async (
  options: EstablishHarnessSessionContextOptions,
): Promise<string[]> => {
  const { engine, config } = options;
  const messages: string[] = [];
  if (config.skillsRoot !== undefined) {
    const registry = await persistHarnessRunSkillRegistry(engine, {
      skillsRoot: config.skillsRoot,
      ...(config.skillsRootSandboxPath !== undefined
        ? { sandboxSkillsRoot: config.skillsRootSandboxPath }
        : {}),
    });
    if (config.skillNames.length > 0) {
      const context = await loadHarnessSkillContext({
        registry,
        skillNames: config.skillNames,
        source: "cli-preload",
        runId: engine.getRunState().runId,
        activatedAt: engine.getRunState().updatedAt,
      });
      await engine.persistSkillActivations(context.activations);
      messages.push(context.contextText);
    }
  }
  if (engine.fabricSessionAvailable) {
    try {
      const grantMessage = wellKnownGrantsContextMessage(
        await engine.establishWellKnownGrants(),
      );
      if (grantMessage !== undefined) {
        messages.push(grantMessage);
      }
    } catch (error) {
      options.onGrantsUnavailable?.(error);
    }
  }
  messages.push(
    ...pieceTargetingContextMessages(await engine.establishInputCells()),
  );
  const patternRefsMessage = patternRefsContextMessage(
    await engine.establishPatternRefs(),
  );
  if (patternRefsMessage !== undefined) {
    messages.push(patternRefsMessage);
  }
  messages.push(REVISION_VERIFICATION_GUIDANCE);
  return messages;
};

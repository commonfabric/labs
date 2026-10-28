/**
 * Runs one `cf-harness` job from plain inputs to its final answer.
 *
 * A job is a task, the prompt-slot role that task binds as, an optional result
 * schema, and the tools it may use. Everything a job does in the
 * fabric — a fabric session, its read ceiling, the cells it holds as handles —
 * is the optional `fabric` part of its spec, so a job with none runs with no
 * fabric at all. The caller decides what the result becomes: an agent run's
 * executor writes it into the fabric (`agent-run-harness.ts`).
 *
 * The run goes through the harness's own batch entry point,
 * `runCfHarnessCli`, so the session is assembled the way every harness run
 * is. The arguments that entry point takes are built here and nowhere else,
 * so a caller never depends on them.
 */

import { basename, join } from "@std/path";

import type { JSONSchema } from "@commonfabric/api";
import { readHarnessRunArtifacts } from "@commonfabric/cf-harness/artifacts";
import {
  type CfHarnessStructuredResultValidation,
  processCfHarnessCliEnv,
  runCfHarnessCli,
  type RunCfHarnessCliDependencies,
  selectCfHarnessCliSandboxRuntime,
} from "@commonfabric/cf-harness/cli";
import type { HarnessBrowserHost } from "@commonfabric/cf-harness/contracts/browser-host";
import type { HarnessInlineImageAttachment } from "@commonfabric/cf-harness/contracts/image";
import type { PromptSlotRole } from "@commonfabric/cf-harness/contracts/prompt-slot";
import type { HarnessRunDepth } from "@commonfabric/cf-harness/contracts/run-depth";
import type { HarnessTranscriptEvent } from "@commonfabric/cf-harness/contracts/transcript";
import { createHarnessHandleTable } from "@commonfabric/cf-harness/handle-table";
import { createHarnessImageAttachmentFromBase64 } from "@commonfabric/cf-harness/image-attachments";
import type {
  HarnessModelLimits,
  HarnessModelUsage,
} from "@commonfabric/cf-harness/model/client";
import {
  CfHarnessPromptLoop,
  type CreateHarnessPromptLoopOptions,
  type HarnessModelUsageUpdate,
  type HarnessPromptLoopResult,
  promptLoopModelTurnsFromError,
  type RunHarnessPromptOptions,
  type RunHarnessTranscriptOptions,
} from "@commonfabric/cf-harness/prompt-loop";
import { sumHarnessModelUsage } from "@commonfabric/cf-harness/model/usage";
import { canContinueHarnessRun } from "@commonfabric/cf-harness/run-continuation";
import type {
  HarnessTaskDomain,
  HarnessTaskTag,
} from "@commonfabric/cf-harness/task-classification";
import {
  type AgentRunErrorCode,
  INVALID_RESULT,
  LIMIT_REACHED,
  PROVIDER_FAILURE,
} from "@commonfabric/runner/agent-run";
import type { CfcObservationMaxConfidentiality } from "@commonfabric/runner/cfc";

import type { AgentRunReport } from "./agent-runner.ts";

/** What a job does in the fabric, when it does anything there. */
export interface HarnessJobFabric {
  /** The origin of the toolshed serving the job's space. */
  host: string;

  /** The space the job's fabric session opens. */
  space: string;

  /** The PKCS#8 key file of the identity the job reads and writes as. */
  identityKeyPath: string;

  /** The fabric session's read ceiling. */
  maxConfidentiality: CfcObservationMaxConfidentiality;

  /** Input cells the model holds as handles: name to rendered reference. */
  inputs: Readonly<Record<string, string>>;

  /**
   * Other spaces the session may reach, each a DID mapped to the host serving
   * it: where a piece handed in as an input lives outside the job's space.
   */
  foreignSpaces?: Readonly<Record<string, string>>;
}

/** One job, as plain data. */
export interface HarnessJobSpec extends HarnessModelLimits {
  /** The task text, given to the model as the prompt. */
  task: string;

  /** The predecessor's run root, whose checkpoint seeds this follow-up. */
  continueFrom?: { runRoot: string };

  /** Inline host-owned images, snapshotted into this job workspace. */
  imageAttachments?: readonly HarnessInlineImageAttachment[];

  /**
   * The prompt-slot role the task binds as. It is the job's authority: a
   * `direct-command` task may use write-class tools under the enforcing CFC
   * modes, and a `context` task may not. Only the spec sets it; nothing in
   * the task text can.
   */
  taskRole: PromptSlotRole;

  /** The submitted result schema; absent when the answer is final assistant text. */
  resultSchema?: JSONSchema;

  /** The tools the job may use; a schema adds `submit_result`. */
  tools: readonly string[];

  /**
   * The subagent profiles `delegate_task` may spawn; none when absent. A job
   * that browses through a host names `browser` here and `delegate_task` in
   * its tools.
   */
  subagentProfiles?: readonly string[];

  /** Model name passed to `cf-harness`. */
  model?: string;

  /** The job's system prompt: framing the task's author supplies. */
  instructions?: string;

  /** The most model turns the job may take; the harness's own when absent. */
  maxModelTurns?: number;

  /** How far to take the task; the harness's default when absent. */
  depth?: HarnessRunDepth;

  /**
   * The task's kinds of work, in place of the harness's classification; an
   * empty list states none and leaves them to the harness.
   */
  taskTags?: readonly HarnessTaskTag[];

  /** Where the task's work happens, in place of the harness's; `[]` is none. */
  taskDomains?: readonly HarnessTaskDomain[];

  /** The provider reasoning effort; the provider's default when absent. */
  reasoningEffort?: string;

  /** The host-owned file backing the read-only Loom tools. */
  loomRetrievalConfigPath?: string;

  /**
   * The host-owned file naming the command broker behind `list_commands`,
   * `run_command`, and `run_read_command`.
   */
  loomCommandsConfigPath?: string;

  /** Host job identity attributed to this job's brokered commands. */
  commandJobId?: string;

  /** The job's fabric session and input cells; absent for a job with none. */
  fabric?: HarnessJobFabric;

  /**
   * The pattern index `search_patterns`, `record_feedback` and a
   * `pattern-author` child search. The harness signs its requests with the
   * fabric identity, so a spec naming one has a fabric part.
   */
  patternIndexUrl?: string;

  /**
   * Whether the job contributes what it authors to the pattern index; the
   * harness publishes unless this is `false`.
   */
  patternIndexPublish?: boolean;
}

/**
 * The harness settings a job never takes from its environment: each grants
 * a run a fabric session or a setting of one, a Loom transport, a pattern
 * index, or a CFC enforcement mode. A job's authority is its spec, and the
 * runner's environment is not a grant, so these are removed from whatever
 * environment the harness is handed; the enforcement mode is then the one
 * `argvOf` pins.
 */
export const HARNESS_JOB_GRANT_ENV_KEYS = [
  "CF_HARNESS_FABRIC_API_URL",
  "CF_HARNESS_FABRIC_IDENTITY",
  "CF_HARNESS_FABRIC_SPACE",
  "CF_HARNESS_FABRIC_FOREIGN_SPACES",
  "CF_HARNESS_FABRIC_CFC_ENFORCEMENT_MODE",
  "CF_HARNESS_FABRIC_CFC_FLOW_LABELS",
  "CF_HARNESS_FABRIC_CFC_POSTURE",
  // `CF_CFC_MODE`, the fabric runtime's own dial, which the CLI reads as a
  // fallback for this one, stays: the mode `argvOf` pins outranks both.
  "CF_HARNESS_CFC_ENFORCEMENT_MODE",
  "CF_HARNESS_SPACE_DB",
  "CF_HARNESS_LOOM_AUTHORING_CONFIG",
  "CF_HARNESS_LOOM_RETRIEVAL_CONFIG",
  "CF_HARNESS_LOOM_COMMANDS_CONFIG",
  "CF_HARNESS_PATTERN_INDEX_URL",
  "CF_HARNESS_PATTERN_INDEX_PUBLISH",
  "CF_HARNESS_PATTERN_INDEX_PUBLISH_DISCOVERABLE",
] as const;

/**
 * The CFC enforcement mode every job runs at. The spec's `taskRole` decides
 * which tools a job may use only under an enforcing mode, so the mode is
 * the job's own, pinned here, never a dial inherited from the process.
 */
export const HARNESS_JOB_CFC_ENFORCEMENT_MODE = "enforce-explicit";

/** What a job runs with besides its spec. */
export interface HarnessJobOptions {
  /**
   * The job's artifact parent and default workspace parent. Its basename
   * identifies the job and names its result file inside `.job-results`.
   */
  runRoot: string;

  /** The conversation's workspace; a new workspace under `runRoot` by default. */
  workspace?: string;

  /**
   * Takes caller messages for the next model turn, in acceptance order.
   * Each returned string becomes a user message at that turn's boundary.
   */
  takeMessages?: (
    turn: number,
  ) => readonly string[] | Promise<readonly string[]>;

  /** Aborts the job. */
  signal: AbortSignal;

  /** Called on each transcript event the harness persists, before it is passed on. */
  onEvent?: (event: HarnessTranscriptEvent) => Promise<void> | void;

  /** Records the artifact root before this job starts its model loop. */
  onStart?: (runRoot: string) => void;

  /** Cumulative usage after a completed model call, with its accounting scope. */
  onUsage?: (update: {
    usage?: HarnessModelUsage;
    coverage: NonNullable<AgentRunReport["usageCoverage"]>;
  }) => Promise<void> | void;

  /** The harness's own seams; `createPromptLoop` replaces the model loop. */
  harnessDeps?: RunCfHarnessCliDependencies;

  /** The client hosting the job's browser, for a job that declared one. */
  browserHost?: HarnessBrowserHost;

  /** Operator-facing lines the harness prints. */
  report?: (message: string) => void;
}

/** How a job ended. */
export type HarnessJobResult =
  & {
    report?: AgentRunReport;

    /** Whether the run left a complete checkpoint a follow-up can use. */
    recordedRun?: boolean;
  }
  & (
    | {
      outcome: "completed";

      /** Validated JSON for a schema, or the final assistant text without one. */
      structuredResult: unknown;

      /** The handles the job held, for resolving those the result names. */
      handleTable: ReturnType<typeof createHarnessHandleTable>;
    }
    | {
      outcome: "failed";
      errorCode: AgentRunErrorCode;

      /**
       * Why, where the harness said: for `INVALID_RESULT`, that no result
       * was submitted, or the field the schema refused and the reason.
       */
      errorDetail?: string;
    }
    | { outcome: "cancelled" }
  );

/** Helper for the job, which turns a loop result into a report. */
const reportOf = (result: HarnessPromptLoopResult): AgentRunReport => {
  const usage = result.totalUsage ?? result.usage;
  return {
    ...(usage !== undefined
      ? {
        usage: { ...usage },
        usageCoverage: result.totalUsage !== undefined
          ? "including-descendants"
          : "direct",
      }
      : {}),
    modelTurns: result.modelTurns,
    ...(result.modelResponses !== undefined
      ? {
        modelResponses: result.modelResponses,
        actualModels: result.actualModels,
        modelAttributionComplete: result.modelAttributionComplete,
      }
      : {}),
    toolCalls: result.runState.toolOutputs.length,
    ...(result.runState.artifactRoot !== undefined
      ? { runRef: result.runState.artifactRoot }
      : {}),
  };
};

/**
 * Helper for the job, which builds the harness's arguments from the spec.
 * The `--fabric-*` and `--input-cell` arguments appear exactly when the spec
 * has a fabric part, and `--pattern-index-url` when it names an index.
 */
const argvOf = (
  spec: HarnessJobSpec,
  workspace: string,
  artifactRoot: string,
  resultPath: string,
): string[] => [
  "--output-mode",
  "batch",
  "--cfc-enforcement-mode",
  HARNESS_JOB_CFC_ENFORCEMENT_MODE,
  "--workspace",
  workspace,
  "--artifact-root",
  artifactRoot,
  // One word, so that a task starting with `-` still reads as the value
  // rather than as flags of its own.
  `--prompt=${spec.task}`,
  ...(spec.continueFrom !== undefined
    ? ["--continue-run", spec.continueFrom.runRoot]
    : []),
  "--prompt-slot-role",
  spec.taskRole,
  ...(spec.resultSchema === undefined ? [] : [
    "--structured-result-path",
    resultPath,
    "--structured-result-schema",
    JSON.stringify(spec.resultSchema),
  ]),
  ...(spec.fabric !== undefined
    ? [
      "--fabric-api-url",
      spec.fabric.host,
      "--fabric-identity",
      spec.fabric.identityKeyPath,
      "--fabric-space",
      spec.fabric.space,
      "--max-confidentiality",
      JSON.stringify(spec.fabric.maxConfidentiality),
      ...(Object.keys(spec.fabric.foreignSpaces ?? {}).length > 0
        ? [
          "--fabric-foreign-spaces",
          JSON.stringify(spec.fabric.foreignSpaces),
        ]
        : []),
    ]
    : []),
  ...(spec.patternIndexUrl !== undefined
    ? ["--pattern-index-url", spec.patternIndexUrl]
    : []),
  ...(spec.patternIndexPublish === false ? ["--no-pattern-index-publish"] : []),
  ...(spec.loomRetrievalConfigPath !== undefined
    ? ["--loom-retrieval-config", spec.loomRetrievalConfigPath]
    : []),
  ...(spec.loomCommandsConfigPath !== undefined
    ? ["--loom-commands-config", spec.loomCommandsConfigPath]
    : []),
  // One word each, for the reason the prompt is.
  ...(spec.instructions !== undefined
    ? [`--system-prompt=${spec.instructions}`]
    : []),
  ...(spec.maxModelTurns !== undefined
    ? ["--max-model-turns", String(spec.maxModelTurns)]
    : []),
  ...(spec.depth !== undefined ? ["--depth", spec.depth] : []),
  ...(spec.continueFrom === undefined && spec.taskTags !== undefined &&
      spec.taskTags.length > 0
    ? ["--task-tags", spec.taskTags.join(",")]
    : []),
  ...(spec.continueFrom === undefined && spec.taskDomains !== undefined
    ? ["--task-domains", spec.taskDomains.join(",") || "none"]
    : []),
  ...(spec.reasoningEffort !== undefined
    ? ["--reasoning-effort", spec.reasoningEffort]
    : []),
  ...Object.entries(spec.fabric?.inputs ?? {}).flatMap(([name, ref]) => [
    "--input-cell",
    `${name}=${ref}`,
  ]),
  // The job's tools, and the tool it returns its result through.
  ...[
    ...spec.tools.filter((tool) => tool !== "submit_result"),
    ...(spec.resultSchema === undefined ? [] : ["submit_result"]),
  ].flatMap(
    (tool) => ["--allow-tool", tool],
  ),
  ...(spec.subagentProfiles ?? []).flatMap(
    (profile) => ["--allow-subagent-profile", profile],
  ),
  ...(spec.model !== undefined ? ["--model", spec.model] : []),
];

/**
 * What every job is started with that decides its sandbox runtime. The
 * argument list is written here, so whoever runs a job selects the runtime
 * through the environment and never by a flag.
 */
const SANDBOX_SELECTION = { sandboxSelectionFlags: false };

/**
 * Derives the sandbox runtime the harness would give a job run with
 * `harnessDeps`, without starting one. A runner calls this as it starts, so
 * that a selection the harness would refuse every job for refuses the runner
 * instead.
 *
 * @throws HarnessControlError where the harness would refuse the job.
 */
export const selectHarnessJobSandboxRuntime = (
  harnessDeps: RunCfHarnessCliDependencies = {},
) => selectCfHarnessCliSandboxRuntime({ ...harnessDeps, ...SANDBOX_SELECTION });

/**
 * Runs one job. It ends `completed` with the submitted value or final text and
 * the handles the job held; `cancelled` when its signal aborted; `failed` as
 * `LIMIT_REACHED` when the model-turn limit ended it, as `INVALID_RESULT`,
 * with the validator's reason, when the loop completed without a result
 * satisfying its schema, and as
 * `PROVIDER_FAILURE` when the model or a tool failed, or when a validated
 * result could not be read back.
 *
 * Follow-ups seed a new run from the predecessor's recorded checkpoint.
 */
export const runHarnessJob = async (
  spec: HarnessJobSpec,
  options: HarnessJobOptions,
): Promise<HarnessJobResult> => {
  const workspace = options.workspace ?? join(options.runRoot, "workspace");
  await Deno.mkdir(workspace, { recursive: true });
  const resultDir = join(workspace, ".job-results");
  const resultPath = join(resultDir, `${basename(options.runRoot)}.json`);
  if (spec.resultSchema !== undefined) {
    await Deno.mkdir(resultDir, { recursive: true });
    try {
      await Deno.remove(resultPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  const argv = argvOf(
    spec,
    workspace,
    join(options.runRoot, "artifacts"),
    resultPath,
  );

  for (const image of spec.imageAttachments ?? []) {
    const snapshot = await createHarnessImageAttachmentFromBase64({
      ...image,
      snapshotDir: join(workspace, ".job-images"),
    });
    argv.push("--image", snapshot.hostPath);
  }

  // The harness builds its loop through this seam, so wrapping it is how the
  // job takes its abort signal, tells the caller of each transcript event the
  // harness persists, and hands back the loop's full result.
  let loopResult: HarnessPromptLoopResult | undefined;
  let loopError: unknown;
  let reportedUsage: HarnessModelUsage | undefined;
  let reportedUsageCoverage: NonNullable<AgentRunReport["usageCoverage"]> =
    "direct";
  const directUsage: (HarnessModelUsage | undefined)[] = [];
  const onModelUsage = async (update: HarnessModelUsageUpdate) => {
    directUsage.push(update.usage);
    reportedUsage = update.totalUsage ??
      (directUsage.some((usage) => usage !== undefined)
        ? sumHarnessModelUsage(directUsage)
        : undefined);
    reportedUsageCoverage = update.totalUsage === undefined
      ? "direct"
      : "including-descendants";
    await options.onUsage?.({
      usage: reportedUsage,
      coverage: reportedUsageCoverage,
    });
  };
  let readRunState:
    | (() => HarnessPromptLoopResult["runState"] | undefined)
    | undefined;
  let resultValidation: CfHarnessStructuredResultValidation | undefined;
  let refusalDetail: string | undefined;
  const createInnerLoop = options.harnessDeps?.createPromptLoop ??
    ((loopOptions: CreateHarnessPromptLoopOptions) =>
      new CfHarnessPromptLoop(loopOptions));
  const env = { ...(options.harnessDeps?.env ?? processCfHarnessCliEnv()) };
  for (const key of HARNESS_JOB_GRANT_ENV_KEYS) delete env[key];
  const deps: RunCfHarnessCliDependencies = {
    ...options.harnessDeps,
    ...SANDBOX_SELECTION,
    env,
    ...(spec.commandJobId !== undefined
      ? { commandJobId: spec.commandJobId }
      : {}),
    ...(options.browserHost !== undefined
      ? { browserHost: options.browserHost }
      : {}),
    io: {
      stdout: (text) => options.report?.(text.trimEnd()),
      stderr: (text) => {
        refusalDetail = text.trimEnd();
        options.report?.(refusalDetail);
      },
    },
    // The caller owns the process's signals and its exit.
    registerSignalHandler: () => () => {},
    exit: () => {},
    onStructuredResultValidation: (validation) => {
      resultValidation = validation;
      options.harnessDeps?.onStructuredResultValidation?.(validation);
    },
    createPromptLoop: (loopOptions) => {
      readRunState = () => loopOptions.engine?.getRunState();
      const runRoot = readRunState()?.artifactRoot;
      if (runRoot !== undefined) options.onStart?.(runRoot);
      const loop = createInnerLoop({
        ...loopOptions,
        stopOnStructuredResult: true,
        ...(spec.maxInputBytes !== undefined
          ? { maxInputBytes: spec.maxInputBytes }
          : {}),
        ...(spec.maxOutputTokens !== undefined
          ? { maxOutputTokens: spec.maxOutputTokens }
          : {}),
      });
      const run = async <
        T extends RunHarnessPromptOptions | RunHarnessTranscriptOptions,
      >(
        runOptions: T,
        invoke: (runOptions: T) => Promise<HarnessPromptLoopResult>,
      ) => {
        const replaying = "transcript" in runOptions;
        let seedEnd = 0;
        try {
          loopResult = await invoke({
            ...runOptions,
            signal: options.signal,
            takeMessages: options.takeMessages,
            onModelUsage: async (update) => {
              await onModelUsage(update);
              await runOptions.onModelUsage?.(update);
            },
            onTranscriptEvent: async (event) => {
              if (!replaying || event.subagent !== undefined) {
                await options.onEvent?.(event);
              } else if (event.seed === true) {
                seedEnd = event.transcript.length;
              } else {
                await options.onEvent?.({
                  ...event,
                  transcript: event.transcript.slice(seedEnd),
                });
              }
              await runOptions.onTranscriptEvent?.(event);
            },
          });
          return loopResult;
        } catch (error) {
          loopError = error;
          throw error;
        }
      };
      return {
        runPrompt: (promptOptions) =>
          run(promptOptions, (wrapped) => loop.runPrompt(wrapped)),
        runTranscript: (transcriptOptions) =>
          run(transcriptOptions, (wrapped) => loop.runTranscript(wrapped)),
        // The harness classifies the task before it assembles the prompt; a
        // wrapper without this seam runs every job with full orientation.
        ...(loop.classifyTask !== undefined
          ? {
            classifyTask: (task: string) => loop.classifyTask!(task),
          }
          : {}),
      };
    },
  };

  const exitCode = await runCfHarnessCli(argv, deps);
  const failedTurns = promptLoopModelTurnsFromError(loopError);
  const failedState = readRunState?.();
  // These are partial measurements, not a completeness claim. A failed
  // provider call may have spent tokens it never reported.
  const failedReport: AgentRunReport | undefined =
    failedTurns !== undefined || reportedUsage !== undefined
      ? {
        ...(reportedUsage !== undefined
          ? {
            usage: { ...reportedUsage },
            usageCoverage: reportedUsageCoverage,
          }
          : {}),
        ...(failedTurns !== undefined ? { modelTurns: failedTurns } : {}),
        ...(failedState !== undefined
          ? { toolCalls: failedState.toolOutputs.length }
          : {}),
        ...(failedState?.artifactRoot !== undefined
          ? { runRef: failedState.artifactRoot }
          : {}),
      }
      : undefined;
  const runRef = loopResult?.runState.artifactRoot ?? failedState?.artifactRoot;
  let recordedRun = false;
  if (runRef !== undefined) {
    try {
      recordedRun = canContinueHarnessRun(
        await readHarnessRunArtifacts(runRef),
      );
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  const report = loopResult !== undefined
    ? reportOf(loopResult)
    : failedReport ??
      (recordedRun ? { runRef } : undefined);
  if (options.signal.aborted) {
    return {
      outcome: "cancelled",
      recordedRun,
      ...(report !== undefined ? { report } : {}),
    };
  }
  if (loopResult === undefined) {
    const limit = loopError instanceof Error &&
      loopError.message.includes("exceeded max model turns");
    return {
      outcome: "failed",
      recordedRun,
      errorCode: limit ? LIMIT_REACHED : PROVIDER_FAILURE,
      ...(loopError === undefined && refusalDetail !== undefined
        ? { errorDetail: refusalDetail }
        : {}),
      ...(report !== undefined ? { report } : {}),
    };
  }
  if (exitCode !== 0) {
    return resultValidation?.status === "invalid"
      ? {
        outcome: "failed",
        recordedRun,
        errorCode: INVALID_RESULT,
        ...(resultValidation.validation_error !== undefined
          ? { errorDetail: resultValidation.validation_error }
          : {}),
        report,
      }
      : { outcome: "failed", errorCode: PROVIDER_FAILURE, report, recordedRun };
  }

  let structuredResult: unknown = loopResult.finalAssistantText;
  try {
    if (spec.resultSchema !== undefined) {
      structuredResult = JSON.parse(await Deno.readTextFile(resultPath));
    }
  } catch {
    // A result the harness validated became unreadable before it was read.
    return {
      outcome: "failed",
      errorCode: PROVIDER_FAILURE,
      report,
      recordedRun,
    };
  }
  return {
    outcome: "completed",
    recordedRun,
    structuredResult,
    handleTable: loopResult.runState.handleTable ??
      createHarnessHandleTable(loopResult.runState.runId),
    report,
  };
};

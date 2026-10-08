/**
 * Runs one `cf-harness` job from plain inputs to a structured result.
 *
 * A job is a task, the prompt-slot role that task binds as, the schema its
 * result must satisfy, and the tools it may use. Everything a job does in the
 * fabric — a fabric session, its read ceiling, the cells it holds as handles —
 * is the optional `fabric` part of its spec, so a job with none runs with no
 * fabric at all. The caller decides what the result becomes: an agent run's
 * executor writes it into the fabric (`agent-run-harness.ts`).
 *
 * The run goes through the harness's own batch entry point,
 * `runCfHarnessCli`, so the session is assembled the way every harness run
 * is. The arguments that entry point takes are built here and nowhere else,
 * so a caller never depends on them, and so is where under its run root a
 * job's run leaves its artifacts, which `readHarnessJobTranscript` reads
 * back for a later job to continue from.
 */

import { join } from "@std/path";

import { readHarnessTranscript } from "@commonfabric/cf-harness/artifacts";
import {
  type CfHarnessStructuredResultValidation,
  runCfHarnessCli,
  type RunCfHarnessCliDependencies,
  selectCfHarnessCliSandboxRuntime,
} from "@commonfabric/cf-harness/cli";
import type { HarnessBrowserHost } from "@commonfabric/cf-harness/contracts/browser-host";
import type { PromptSlotRole } from "@commonfabric/cf-harness/contracts/prompt-slot";
import type {
  HarnessTranscriptEvent,
  HarnessTranscriptMessage,
} from "@commonfabric/cf-harness/contracts/transcript";
import {
  isHarnessTranscriptOmissions,
  restoreHarnessTranscriptOmissions,
} from "@commonfabric/cf-harness/contracts/transcript-omissions";
import { createHarnessHandleTable } from "@commonfabric/cf-harness/handle-table";
import {
  CfHarnessPromptLoop,
  type CreateHarnessPromptLoopOptions,
  type HarnessPromptLoopResult,
  type RunHarnessPromptOptions,
} from "@commonfabric/cf-harness/prompt-loop";
import type { JSONSchema } from "@commonfabric/api";
import {
  type AgentRunErrorCode,
  INVALID_RESULT,
  LIMIT_REACHED,
  PROVIDER_FAILURE,
} from "@commonfabric/runner/agent-run";
import type { CfcObservationMaxConfidentiality } from "@commonfabric/runner/cfc";

import type { AgentRunReport } from "./agent-runner.ts";

/** The workspace file the host writes when the model calls `submit_result`. */
const RESULT_FILE = "agent-result.json";

/** The directory under a job's run root the harness keeps its runs in. */
const ARTIFACTS_DIR = "artifacts";

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
}

/** One job, as plain data. */
export interface HarnessJobSpec {
  /** The task text, given to the model as the prompt. */
  task: string;

  /**
   * The prompt-slot role the task binds as. It is the job's authority: a
   * `direct-command` task may use write-class tools under the enforcing CFC
   * modes, and a `context` task may not. Only the spec sets it; nothing in
   * the task text can.
   */
  taskRole: PromptSlotRole;

  /** The schema the result the model submits is validated against. */
  resultSchema: JSONSchema;

  /** The tools the job may use; `submit_result` is always added. */
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

  /**
   * History the job continues: an earlier run's messages, without its system
   * prompt, which the model reads after this job's system prompt and before
   * this job's context and task. Absent for a job that starts afresh.
   */
  priorTranscript?: readonly HarnessTranscriptMessage[];

  /** The most model turns the job may take; the harness's own when absent. */
  maxModelTurns?: number;

  /** The host-owned file backing the read-only Loom tools. */
  loomRetrievalConfigPath?: string;

  /**
   * The host-owned file naming the command broker behind `list_commands`
   * and `run_command`. Those tools, and the harness flag this becomes, come
   * with labs#8467; a harness without them refuses the flag and the job
   * fails.
   */
  loomCommandsConfigPath?: string;

  /** Host job identity attributed to this job's brokered commands. */
  commandJobId?: string;

  /** The job's fabric session and input cells; absent for a job with none. */
  fabric?: HarnessJobFabric;
}

/** What a job runs with besides its spec. */
export interface HarnessJobOptions {
  /** The directory the job's workspace and artifacts are created under. */
  runRoot: string;

  /** Aborts the job. */
  signal: AbortSignal;

  /** Called on each transcript event the harness persists, before it is passed on. */
  onEvent?: (event: HarnessTranscriptEvent) => Promise<void> | void;

  /** The harness's own seams; `createPromptLoop` replaces the model loop. */
  harnessDeps?: RunCfHarnessCliDependencies;

  /** The client hosting the job's browser, for a job that declared one. */
  browserHost?: HarnessBrowserHost;

  /** Operator-facing lines the harness prints. */
  report?: (message: string) => void;
}

/** How a job ended. */
export type HarnessJobResult =
  & { report?: AgentRunReport }
  & (
    | {
      outcome: "completed";

      /** The value the model submitted, read back from the result file. */
      structuredResult: unknown;

      /** The handles the job held, for resolving those the result names. */
      handleTable: ReturnType<typeof createHarnessHandleTable>;
    }
    | { outcome: "failed"; errorCode: AgentRunErrorCode }
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
    toolCalls: result.runState.toolOutputs.length,
    ...(result.runState.artifactRoot !== undefined
      ? { runRef: result.runState.artifactRoot }
      : {}),
  };
};

/**
 * Helper for the job, which builds the harness's arguments from the spec.
 * The `--fabric-*` and `--input-cell` arguments appear exactly when the spec
 * has a fabric part.
 */
const argvOf = (
  spec: HarnessJobSpec,
  workspace: string,
  artifactRoot: string,
  resultPath: string,
): string[] => [
  "--output-mode",
  "batch",
  "--workspace",
  workspace,
  "--artifact-root",
  artifactRoot,
  // One word, so that a task starting with `-` still reads as the value
  // rather than as flags of its own.
  `--prompt=${spec.task}`,
  "--prompt-slot-role",
  spec.taskRole,
  "--structured-result-path",
  resultPath,
  "--structured-result-schema",
  JSON.stringify(spec.resultSchema),
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
    ]
    : []),
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
  ...Object.entries(spec.fabric?.inputs ?? {}).flatMap(([name, ref]) => [
    "--input-cell",
    `${name}=${ref}`,
  ]),
  // The job's tools, and the tool it returns its result through.
  ...[...spec.tools, "submit_result"].flatMap(
    (tool) => ["--allow-tool", tool],
  ),
  ...(spec.subagentProfiles ?? []).flatMap(
    (profile) => ["--allow-subagent-profile", profile],
  ),
  ...(spec.model !== undefined ? ["--model", spec.model] : []),
];

/**
 * Helper for the job, which lays out a continued job's transcript as the
 * harness lays out a fresh one — system prompt, context, task — with the
 * prior history after the system prompt, where interactive chat puts a
 * session's earlier turns.
 */
const continuedTranscriptOf = (
  prompt: RunHarnessPromptOptions,
  prior: readonly HarnessTranscriptMessage[],
): HarnessTranscriptMessage[] => [
  ...(prompt.systemPrompt !== undefined
    ? [{ role: "system", content: prompt.systemPrompt } as const]
    : []),
  ...prior,
  ...(prompt.contextMessages ?? []).map((content) =>
    ({ role: "user", content }) as const
  ),
  {
    role: "user",
    content: prompt.prompt,
    ...(prompt.imageAttachments !== undefined &&
        prompt.imageAttachments.length > 0
      ? { imageAttachments: prompt.imageAttachments }
      : {}),
  },
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
 * Runs one job. It ends `completed` with the value the model submitted and
 * the handles the job held; `cancelled` when its signal aborted; `failed` as
 * `LIMIT_REACHED` when the model-turn limit ended it, as `INVALID_RESULT`
 * when the loop completed without a result satisfying its schema, and as
 * `PROVIDER_FAILURE` when the model or a tool failed, or when a validated
 * result could not be read back.
 */
export const runHarnessJob = async (
  spec: HarnessJobSpec,
  options: HarnessJobOptions,
): Promise<HarnessJobResult> => {
  const workspace = join(options.runRoot, "workspace");
  await Deno.mkdir(workspace, { recursive: true });
  const resultPath = join(workspace, RESULT_FILE);
  try {
    await Deno.remove(resultPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const argv = argvOf(
    spec,
    workspace,
    join(options.runRoot, ARTIFACTS_DIR),
    resultPath,
  );

  // The harness builds its loop through this seam, so wrapping it is how the
  // job takes its abort signal, tells the caller of each transcript event the
  // harness persists, and hands back the loop's full result.
  let loopResult: HarnessPromptLoopResult | undefined;
  let loopError: unknown;
  let resultValidation: CfHarnessStructuredResultValidation | undefined;
  const createInnerLoop = options.harnessDeps?.createPromptLoop ??
    ((loopOptions: CreateHarnessPromptLoopOptions) =>
      new CfHarnessPromptLoop(loopOptions));
  const deps: RunCfHarnessCliDependencies = {
    ...options.harnessDeps,
    ...SANDBOX_SELECTION,
    ...(spec.commandJobId !== undefined
      ? { commandJobId: spec.commandJobId }
      : {}),
    ...(options.browserHost !== undefined
      ? { browserHost: options.browserHost }
      : {}),
    io: {
      stdout: (text) => options.report?.(text.trimEnd()),
      stderr: (text) => options.report?.(text.trimEnd()),
    },
    // The caller owns the process's signals and its exit.
    registerSignalHandler: () => () => {},
    exit: () => {},
    onStructuredResultValidation: (validation) => {
      resultValidation = validation;
      options.harnessDeps?.onStructuredResultValidation?.(validation);
    },
    createPromptLoop: (loopOptions) => {
      const loop = createInnerLoop(loopOptions);
      return {
        runPrompt: async (promptOptions) => {
          const prior = spec.priorTranscript;
          // The loop replays the transcript it starts from as events. The
          // prior history is an earlier job's activity, not this one's.
          const seeded = new Set<HarnessTranscriptMessage>(prior);
          const onTranscriptEvent = async (event: HarnessTranscriptEvent) => {
            if (!seeded.has(event.message)) await options.onEvent?.(event);
            await promptOptions.onTranscriptEvent?.(event);
          };
          try {
            loopResult = prior === undefined
              ? await loop.runPrompt({
                ...promptOptions,
                signal: options.signal,
                onTranscriptEvent,
              })
              : await loop.runTranscript({
                transcript: continuedTranscriptOf(promptOptions, prior),
                openingResearchTask: promptOptions.openingResearchTask,
                model: promptOptions.model,
                maxModelTurns: promptOptions.maxModelTurns,
                promptSlotBinding: promptOptions.promptSlotBinding,
                signal: options.signal,
                onModelUsage: promptOptions.onModelUsage,
                onTranscriptEvent,
              });
            return loopResult;
          } catch (error) {
            loopError = error;
            throw error;
          }
        },
        runTranscript: loop.runTranscript.bind(loop),
      };
    },
  };

  const exitCode = await runCfHarnessCli(argv, deps);
  if (options.signal.aborted) return { outcome: "cancelled" };
  if (loopResult === undefined) {
    const limit = loopError instanceof Error &&
      loopError.message.includes("exceeded max model turns");
    return {
      outcome: "failed",
      errorCode: limit ? LIMIT_REACHED : PROVIDER_FAILURE,
    };
  }
  const report = reportOf(loopResult);
  if (exitCode !== 0) {
    return {
      outcome: "failed",
      errorCode: resultValidation?.status === "invalid"
        ? INVALID_RESULT
        : PROVIDER_FAILURE,
      report,
    };
  }

  let structuredResult: unknown;
  try {
    structuredResult = JSON.parse(await Deno.readTextFile(resultPath));
  } catch {
    // A result the harness validated became unreadable before it was read.
    return { outcome: "failed", errorCode: PROVIDER_FAILURE, report };
  }
  return {
    outcome: "completed",
    structuredResult,
    handleTable: loopResult.runState.handleTable ??
      createHarnessHandleTable(loopResult.runState.runId),
    report,
  };
};

/**
 * Reads the transcript the harness persisted for the job run under
 * `runRoot` — the job's own run's, not a delegated child's — with the
 * omission records persisted beside it restored onto its messages, as
 * interactive chat restores a stored session's. The transcript is as the run
 * last persisted it, which for a run that was stopped or cut off can end
 * with a tool call nothing answered. `undefined` when the run persisted none.
 *
 * @throws when the transcript or its omission records cannot be read.
 */
export const readHarnessJobTranscript = async (
  runRoot: string,
): Promise<HarnessTranscriptMessage[] | undefined> => {
  const artifacts = join(runRoot, ARTIFACTS_DIR);
  // The harness names a delegated child's run after its parent's
  // (`<run>.subagent.<n>`), and keeps the artifact root's own records under
  // dot-named directories, so the job's run is the one other directory.
  const runs: string[] = [];
  try {
    for await (const entry of Deno.readDir(artifacts)) {
      if (
        entry.isDirectory && !entry.name.startsWith(".") &&
        !entry.name.includes(".subagent.")
      ) {
        runs.push(entry.name);
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  if (runs.length === 0) return undefined;
  if (runs.length > 1) {
    throw new Error(`${artifacts} holds ${runs.length} runs, not one`);
  }
  const run = join(artifacts, runs[0]);
  let transcript: HarnessTranscriptMessage[];
  try {
    transcript = await readHarnessTranscript(join(run, "transcript.json"));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  if (!Array.isArray(transcript)) {
    throw new TypeError(`${run}/transcript.json holds no transcript`);
  }
  let omissions: unknown;
  try {
    omissions = JSON.parse(
      await Deno.readTextFile(join(run, "transcript-omissions.json")),
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return transcript;
    throw error;
  }
  if (!isHarnessTranscriptOmissions(omissions)) {
    throw new TypeError(`${run}/transcript-omissions.json is not readable`);
  }
  restoreHarnessTranscriptOmissions(transcript, omissions);
  return transcript;
};

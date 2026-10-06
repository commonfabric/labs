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
 * so a caller never depends on them.
 */

import { join } from "@std/path";

import {
  type CfHarnessStructuredResultValidation,
  runCfHarnessCli,
  type RunCfHarnessCliDependencies,
} from "@commonfabric/cf-harness/cli";
import type { PromptSlotRole } from "@commonfabric/cf-harness/contracts/prompt-slot";
import type { HarnessTranscriptEvent } from "@commonfabric/cf-harness/contracts/transcript";
import { createHarnessHandleTable } from "@commonfabric/cf-harness/handle-table";
import {
  CfHarnessPromptLoop,
  type CreateHarnessPromptLoopOptions,
  type HarnessPromptLoopResult,
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

  /** Model name passed to `cf-harness`. */
  model?: string;

  /** The job's system prompt: framing the task's author supplies. */
  instructions?: string;

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
  ...(spec.model !== undefined ? ["--model", spec.model] : []),
];

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
    join(options.runRoot, "artifacts"),
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
    ...(spec.commandJobId !== undefined
      ? { commandJobId: spec.commandJobId }
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
          try {
            loopResult = await loop.runPrompt({
              ...promptOptions,
              signal: options.signal,
              onTranscriptEvent: async (event) => {
                await options.onEvent?.(event);
                await promptOptions.onTranscriptEvent?.(event);
              },
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

/**
 * Runs one claimed agent request with `cf-harness`, and writes its result.
 *
 * The run goes through the harness's own batch entry point, `runCfHarnessCli`,
 * so the session is assembled the way every harness run is: the arguments
 * below resolve to a `HarnessSessionConfig`, the provider comes from the
 * settings under `CF_HARNESS_HOME`, and the prompt loop runs through
 * `harnessSessionEngineOptions`. The request's inputs enter as input cells,
 * which the model holds as handles; its `maxConfidentiality` is the fabric
 * session's read ceiling; its task text is bound to the prompt-slot role
 * `context`, since a pattern's text is not an operator's command. The
 * model's structured result is then handed to `writeAgentResult`, which
 * writes the result document under the `agent` builtin's identity.
 */

import { join } from "@std/path";

import {
  runCfHarnessCli,
  type RunCfHarnessCliDependencies,
} from "@commonfabric/cf-harness/cli";
import {
  CfHarnessPromptLoop,
  type CreateHarnessPromptLoopOptions,
  type HarnessPromptLoopResult,
} from "@commonfabric/cf-harness/prompt-loop";
import {
  createHarnessFabricSessionFactory,
  type HarnessFabricSession,
} from "@commonfabric/cf-harness/fabric-session";
import { createHarnessHandleTable } from "@commonfabric/cf-harness/handle-table";
import {
  type AgentObservedHandle,
  AgentResultWriteError,
  relaxAsCellPositions,
  writeAgentResult,
} from "@commonfabric/cf-harness/result-writer";
import type { JSONSchema } from "@commonfabric/api";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import {
  LIMIT_REACHED,
  PROVIDER_FAILURE,
} from "@commonfabric/runner/agent-run";
import { renderCellReference } from "@commonfabric/runner/shared";
import type { Cell } from "@commonfabric/runner";

import type {
  AgentRunExecution,
  AgentRunReport,
  ClaimedAgentRun,
} from "./agent-runner.ts";

/** The file, in the run's workspace, the model writes its result to. */
const RESULT_FILE = "agent-result.json";

export interface HarnessAgentRunExecutorOptions {
  /** The PKCS#8 key file of the identity the run reads and writes as. */
  identityKeyPath: string;

  /** That identity's DID: the requester every run here acts as. */
  requester: string;

  /** The directory each run's workspace and artifacts are created under. */
  workRoot: string;

  /** The host-owned file backing the read-only Loom tools. */
  loomRetrievalConfigPath?: string;

  /** Further `cf-harness` arguments, such as `--model`. */
  harnessArgs?: readonly string[];

  /**
   * The harness's own seams. `createPromptLoop` replaces the model loop and
   * `fabricSessionFactory` the fabric session, for the run and for the result
   * write alike.
   */
  harnessDeps?: RunCfHarnessCliDependencies;

  /** Operator-facing lines the harness prints. */
  report?: (message: string) => void;
}

/** Helper for the executor, which turns a run's loop result into a report. */
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
 * Builds the executor `AgentRunner` hands each claimed run to.
 *
 * A run ends `completed` with a link to the result document; `cancelled`
 * when its signal aborted; `refused` when the space's policy refused the
 * result write; `failed` as `LIMIT_REACHED` when the model-turn limit ended
 * it, and as `PROVIDER_FAILURE` when the model, a tool, or the result it
 * produced failed any other way.
 */
export const createHarnessAgentRunExecutor = (
  options: HarnessAgentRunExecutorOptions,
) =>
async (run: ClaimedAgentRun): Promise<AgentRunExecution> => {
  const { record } = run;
  const runRoot = join(options.workRoot, record.requestHash);
  const workspace = join(runRoot, "workspace");
  await Deno.mkdir(workspace, { recursive: true });
  const resultPath = join(workspace, RESULT_FILE);

  // The record reads as live proxies; the harness and the writer take plain
  // values.
  const resultSchema = JSON.parse(
    JSON.stringify(record.resultSchema),
  ) as JSONSchema;
  const maxConfidentiality = record.maxConfidentiality === undefined
    ? undefined
    : JSON.parse(JSON.stringify(record.maxConfidentiality)) as unknown[];
  const inputs = record.inputs as Record<string, Cell<unknown>>;
  // A request naming no tools runs with the surface its session backs.
  const tools = record.tools ?? [];
  const argv = [
    "--output-mode",
    "batch",
    "--workspace",
    workspace,
    "--artifact-root",
    join(runRoot, "artifacts"),
    "--prompt",
    record.task,
    "--prompt-slot-role",
    "context",
    "--structured-result-path",
    resultPath,
    "--structured-result-schema",
    // The run validates everything but the `asCell` positions, where the
    // model writes a handle token and the writer places a link.
    JSON.stringify(relaxAsCellPositions(resultSchema)),
    "--fabric-api-url",
    run.host,
    "--fabric-identity",
    options.identityKeyPath,
    "--fabric-space",
    run.link.space,
    ...(maxConfidentiality !== undefined
      ? ["--max-confidentiality", JSON.stringify(maxConfidentiality)]
      : []),
    ...(options.loomRetrievalConfigPath !== undefined
      ? ["--loom-retrieval-config", options.loomRetrievalConfigPath]
      : []),
    ...Object.entries(inputs).flatMap(([name, cell]) => [
      "--input-cell",
      `${name}=${renderCellReference(cell.getAsNormalizedFullLink())}`,
    ]),
    // A request naming its tools narrows the run to them, and to the tool
    // the run returns its result through.
    ...(tools.length > 0 ? [...tools, "submit_result"] : []).flatMap((
      tool,
    ) => ["--allow-tool", tool]),
    ...(options.harnessArgs ?? []),
  ];

  // The harness builds its loop through this seam, so wrapping it is how the
  // run takes the runner's abort signal, renews the lease on each transcript
  // event the harness persists, and hands back the loop's full result.
  let loopResult: HarnessPromptLoopResult | undefined;
  let loopError: unknown;
  const createInnerLoop = options.harnessDeps?.createPromptLoop ??
    ((loopOptions: CreateHarnessPromptLoopOptions) =>
      new CfHarnessPromptLoop(loopOptions));
  const deps: RunCfHarnessCliDependencies = {
    ...options.harnessDeps,
    io: {
      stdout: (text) => options.report?.(text.trimEnd()),
      stderr: (text) => options.report?.(text.trimEnd()),
    },
    // The runner owns the process's signals and its exit.
    registerSignalHandler: () => () => {},
    exit: () => {},
    createPromptLoop: (loopOptions) => {
      const loop = createInnerLoop(loopOptions);
      return {
        runPrompt: async (promptOptions) => {
          try {
            loopResult = await loop.runPrompt({
              ...promptOptions,
              signal: run.signal,
              onTranscriptEvent: async (event) => {
                await run.renewLease();
                await promptOptions.onTranscriptEvent?.(event);
              },
            });
            return loopResult;
          } catch (error) {
            loopError = error;
            throw error;
          }
        },
        runTranscript: (transcriptOptions) =>
          loop.runTranscript(transcriptOptions),
      };
    },
  };

  const exitCode = await runCfHarnessCli(argv, deps);
  if (run.signal.aborted) return { outcome: "cancelled" };
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
    return { outcome: "failed", errorCode: PROVIDER_FAILURE, report };
  }

  let structuredResult: unknown;
  try {
    structuredResult = JSON.parse(await Deno.readTextFile(resultPath));
  } catch {
    // The run finished without the result file it was asked for.
    return { outcome: "failed", errorCode: PROVIDER_FAILURE, report };
  }

  const handleTable = loopResult.runState.handleTable ??
    createHarnessHandleTable(loopResult.runState.runId);
  const observedHandles: AgentObservedHandle[] = handleTable.entries
    .filter((entry) => entry.capability === undefined)
    .map((entry) => ({ kind: "cell", token: entry.token }));
  let session: HarnessFabricSession | undefined;
  const ownsSession = options.harnessDeps?.fabricSessionFactory === undefined;
  try {
    session = await (options.harnessDeps?.fabricSessionFactory ??
      createHarnessFabricSessionFactory({
        apiUrl: run.host,
        identityKeyPath: options.identityKeyPath,
        space: run.link.space,
      }))();
    const written = await writeAgentResult({
      session,
      handleTable,
      structuredResult,
      resultSchema,
      observedHandles,
      // A request naming no ceiling gets the requester's own view, which
      // the first take states as the requester's `User` atom.
      maxConfidentiality: (maxConfidentiality ??
        [{ type: CFC_ATOM_TYPE.User, subject: options.requester }]) as never,
      cause: { agentRunResult: record.requestHash },
    });
    return { outcome: "completed", result: written.link, report };
  } catch (error) {
    if (
      error instanceof AgentResultWriteError &&
      error.code === "cfc_commit_refused"
    ) {
      // The reason faces the operator and never the record.
      options.report?.(
        `agent runner: the space's policy refused the result: ${
          JSON.stringify(error.refusals ?? [])
        } ${error.rawCauseMessage ?? ""}`,
      );
      return { outcome: "refused", report };
    }
    // The storage error's own text faces the operator; the record carries
    // the code alone.
    const detail = error instanceof AgentResultWriteError &&
        error.rawCauseMessage !== undefined
      ? ` (${error.rawCauseMessage})`
      : "";
    options.report?.(
      `agent runner: writing the result failed: ${
        error instanceof Error ? error.message : String(error)
      }${detail}`,
    );
    return { outcome: "failed", errorCode: PROVIDER_FAILURE, report };
  } finally {
    if (ownsSession) await session?.pieces.runtime.dispose().catch(() => {});
  }
};

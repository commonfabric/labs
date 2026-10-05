/**
 * Runs one claimed agent request with `cf-harness`, and writes its result.
 *
 * The executor is the Fabric adapter over `runHarnessJob` (`harness-job.ts`):
 * it turns the record into a job spec — the request's inputs as input cells,
 * which the model holds as handles; its `maxConfidentiality`, met with the
 * host's, as the fabric session's read ceiling; its task text bound to the
 * prompt-slot role `context`, since a pattern's text is not an operator's
 * command — and hands the model's structured result to `writeAgentResult`,
 * which writes the result document under the `agent` builtin's identity.
 */

import { join } from "@std/path";

import type { RunCfHarnessCliDependencies } from "@commonfabric/cf-harness/cli";
import {
  createHarnessFabricSessionFactory,
  type HarnessFabricSession,
} from "@commonfabric/cf-harness/fabric-session";
import {
  agentObservedHandlesOfTable,
  AgentResultWriteError,
  relaxAsCellPositions,
  writeAgentResult,
} from "@commonfabric/cf-harness/result-writer";
import type { JSONSchema } from "@commonfabric/api";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { cloneIfNecessary, hashStringOf } from "@commonfabric/data-model";
import type { ACL } from "@commonfabric/memory/acl";
import { cloneSchemaMutable } from "@commonfabric/data-model-schema";
import { PROVIDER_FAILURE } from "@commonfabric/runner/agent-run";
import { addressKey, renderCellReference } from "@commonfabric/runner/shared";
import type { Cell } from "@commonfabric/runner";
import {
  type CfcObservationMaxConfidentiality,
  meetCfcObservationCeilings,
  spaceReaderRole,
} from "@commonfabric/runner/cfc";

import { getAcl } from "./acl.ts";
import { runHarnessJob } from "./harness-job.ts";

import type { AgentRunExecution, ClaimedAgentRun } from "./agent-runner.ts";

export interface HarnessAgentRunExecutorOptions {
  /** The PKCS#8 key file of the identity the run reads and writes as. */
  identityKeyPath: string;

  /** That identity's DID: the requester every run here acts as. */
  requester: string;

  /** The directory each run's workspace and artifacts are created under. */
  workRoot: string;

  /** The tools this runner advertises and permits when a request omits them. */
  allowedTools: readonly string[];

  /** The host-owned file backing the read-only Loom tools. */
  loomRetrievalConfigPath?: string;

  /** Model name passed to `cf-harness`. */
  model?: string;

  /**
   * The harness's own seams. `createPromptLoop` replaces the model loop and
   * `fabricSessionFactory` the fabric session, for the run and for the result
   * write alike.
   */
  harnessDeps?: RunCfHarnessCliDependencies;

  /** Reads the request space's current ACL as the runner identity. */
  readSpaceAcl?: (host: string, space: string) => Promise<ACL | null>;

  /** Operator-facing lines the harness prints. */
  report?: (message: string) => void;
}

/** Resolves the run's ceiling from a fresh host ACL and the authored bound. */
export async function agentRunObservationCeiling(
  options: Pick<
    HarnessAgentRunExecutorOptions,
    "identityKeyPath" | "requester" | "readSpaceAcl" | "report"
  >,
  host: string,
  space: string,
  requested: CfcObservationMaxConfidentiality,
): Promise<CfcObservationMaxConfidentiality> {
  let acl: ACL | null = null;
  if (space !== options.requester) {
    try {
      acl = await (options.readSpaceAcl ?? ((host, space) =>
        getAcl({
          apiUrl: host,
          space,
          identity: options.identityKeyPath,
        })))(host, space);
    } catch (error) {
      options.report?.(
        `agent runner: could not verify space membership: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const personal = { type: CFC_ATOM_TYPE.User, subject: options.requester };
  const member = space !== options.requester &&
    spaceReaderRole(acl ?? undefined, options.requester) !== null;
  const hostCeiling: CfcObservationMaxConfidentiality = member
    ? [personal, { type: CFC_ATOM_TYPE.Space, id: space }]
    : [personal];
  return meetCfcObservationCeilings(requested, hostCeiling);
}

/**
 * Builds the executor `AgentRunner` hands each claimed run to: the Fabric
 * adapter over `runHarnessJob`.
 *
 * The record becomes a job spec whose task binds as `context`, since a
 * pattern's text is not an operator's command, with the request's inputs as
 * input cells and its ceiling met with the host's as the fabric session's
 * read ceiling. A completed job's result is then written into the record's
 * space by `writeAgentResult`.
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
  const runRoot = join(
    options.workRoot,
    hashStringOf([run.host, addressKey(run.link)]),
  );

  // The record reads as live proxies; the harness and the writer take plain
  // values.
  const requestedSchema = record.resultSchema as JSONSchema;
  const resultSchema = typeof requestedSchema === "boolean"
    ? requestedSchema
    : cloneSchemaMutable(requestedSchema, true);
  // A request may narrow this host ceiling, but cannot grant itself a Space.
  // The request record resides in the invitation space whose ACL is checked.
  const requestedCeiling = record.maxConfidentiality === undefined
    ? undefined
    : cloneIfNecessary(record.maxConfidentiality, { frozen: false });
  const maxConfidentiality = (await agentRunObservationCeiling(
    options,
    run.host,
    run.link.space,
    requestedCeiling as CfcObservationMaxConfidentiality,
  ))!;
  const inputs = record.inputs as Record<string, Cell<unknown>>;

  const job = await runHarnessJob({
    task: record.task,
    taskRole: "context",
    // The run validates everything but the `asCell` positions, where the
    // model writes a handle token and the writer places a link.
    resultSchema: relaxAsCellPositions(resultSchema),
    // A request naming its tools narrows the run to them.
    tools: record.tools ?? options.allowedTools,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.loomRetrievalConfigPath !== undefined
      ? { loomRetrievalConfigPath: options.loomRetrievalConfigPath }
      : {}),
    fabric: {
      host: run.host,
      space: run.link.space,
      identityKeyPath: options.identityKeyPath,
      maxConfidentiality,
      inputs: Object.fromEntries(
        Object.entries(inputs).map(([name, cell]) => [
          name,
          renderCellReference(cell.getAsNormalizedFullLink()),
        ]),
      ),
    },
  }, {
    runRoot,
    signal: run.signal,
    // Each transcript event the harness persists is a durable write, so it
    // renews the lease.
    onEvent: () => run.renewLease(),
    ...(options.harnessDeps !== undefined
      ? { harnessDeps: options.harnessDeps }
      : {}),
    ...(options.report !== undefined ? { report: options.report } : {}),
  });
  if (job.outcome !== "completed") return job;
  const { structuredResult, handleTable, report } = job;

  // Every cell the run holds a handle to, and every Loom row it was shown.
  const observedHandles = agentObservedHandlesOfTable(handleTable);
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
      maxConfidentiality: maxConfidentiality as never,
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

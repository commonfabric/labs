/** Builds a new root run from explicitly retained checkpoint state. */
import { join, relative } from "@std/path";
import { deepEqual } from "@commonfabric/utils/deep-equal";

import type { CfHarnessStructuredResultConfig } from "./cli.ts";
import {
  type HarnessTranscriptMessage,
  inspectHarnessTranscriptPairing,
} from "./contracts/transcript.ts";
import { assertValidHarnessHandleTable } from "./handle-table.ts";
import { recordedSandboxRuntime } from "./sandbox/runtime-selection.ts";
import { createHarnessRunState, type HarnessRunState } from "./run-state.ts";
import {
  HARNESS_CHAT_INTERRUPTED_TURN_NOTICE,
  tableForNextTurn,
} from "./turn-history.ts";

/**
 * Preserves model history and its authority record while giving every output
 * and lifecycle record a new run id. The source object is never modified.
 */
export const prepareHarnessContinuation = (options: {
  runState: HarnessRunState;
  transcript?: readonly HarnessTranscriptMessage[];
  prompt: string;
  artifactRoot: string;
  workspace: string;
  structuredResult?: CfHarnessStructuredResultConfig;
  schemaExplicit: boolean;
}): {
  runState: HarnessRunState;
  transcript: HarnessTranscriptMessage[];
  structuredResult?: CfHarnessStructuredResultConfig;
} => {
  const prior = options.runState;
  const binding = prior.promptSlotBinding;
  if (
    binding?.valueDigest !== undefined || binding?.slotDigest !== undefined ||
    binding?.snapshotDigest !== undefined
  ) {
    throw new Error(
      "`--continue-run` cannot continue a digest-bound prompt-slot binding: " +
        "`valueDigest`, `slotDigest`, and `snapshotDigest` bind one exact prompt value.",
    );
  }
  if (prior.handleTable !== undefined) {
    assertValidHarnessHandleTable(prior.handleTable);
  }
  const source = options.transcript ?? [];
  const boundary = inspectHarnessTranscriptPairing(source).safeBoundary;
  const checkpoint = source.slice(0, boundary);
  // Opening instructions alone do not attest a completed model turn or tool
  // batch. A first unpaired call therefore leaves nothing to continue.
  if (
    !checkpoint.some((message) =>
      message.role === "assistant" || message.role === "tool"
    )
  ) {
    throw new Error(`continue run ${prior.runId} has no complete checkpoint`);
  }
  const transcript = checkpoint.filter((message) =>
    message.role !== "user" || !message.turnLocal
  );
  if (boundary < source.length) {
    transcript.push({
      role: "user",
      content: HARNESS_CHAT_INTERRUPTED_TURN_NOTICE,
    });
  }
  transcript.push({ role: "user", content: options.prompt });
  const runId = crypto.randomUUID();
  const runRoot = join(options.artifactRoot, runId);
  const schema = options.schemaExplicit
    ? options.structuredResult?.schema
    : prior.structuredResult?.schema;
  if (
    prior.structuredResult !== undefined && options.schemaExplicit &&
    !deepEqual(prior.structuredResult.schema, schema)
  ) {
    throw new Error(
      "continued run structured-result schema does not match the recorded schema",
    );
  }
  let structuredResult: CfHarnessStructuredResultConfig | undefined;
  if (schema !== undefined) {
    const path = options.structuredResult?.path ?? join(runRoot, "result.json");
    structuredResult = {
      schema,
      path,
      sandboxPath: options.structuredResult?.sandboxPath ??
        join("/workspace", relative(options.workspace, path)),
    };
  } else if (options.structuredResult !== undefined) {
    throw new Error(
      "--structured-result-path requires a recorded or explicit schema",
    );
  }
  let handleTable = prior.handleTable === undefined
    ? undefined
    : tableForNextTurn(prior.handleTable);
  if (handleTable !== undefined && boundary < source.length) {
    // A truncated batch may have described handles whose descriptions are no
    // longer in the model's history. The final table cannot attest which
    // descriptions survived the checkpoint, so every handle needs a new one.
    handleTable = {
      ...handleTable,
      entries: handleTable.entries.map(({ described: _, ...entry }) => entry),
    };
  }
  const runState = createHarnessRunState({
    runId,
    currentDir: prior.currentDir,
    artifactRoot: runRoot,
    lineage: {
      role: "continuation",
      rootRunId: prior.lineage?.rootRunId ?? prior.runId,
      parentRunId: prior.runId,
    },
    model: prior.model,
    modelProvider: prior.modelProvider,
    modelAuthSource: prior.modelAuthSource,
    credentialOwner: prior.credentialOwner,
    credentialOwnerKey: prior.credentialOwnerKey,
    harnessHomeIdentity: prior.harnessHomeIdentity,
    runManifest: prior.runManifest,
    promptSlotBinding: prior.promptSlotBinding,
    cfcEnforcementMode: prior.cfcEnforcementMode,
    sandboxRuntime: recordedSandboxRuntime(prior),
    fabricSessionCfc: prior.fabricSessionCfc,
    cfcModelContext: prior.cfcModelContext,
    cfcPolicySnapshot: prior.cfcPolicySnapshot,
    cellLabels: prior.cellLabels,
    cfcInvocationContexts: prior.cfcInvocationContexts,
    handleTable,
    docsCorpus: prior.docsCorpus,
    researchGoal: prior.researchGoal,
    researchRuns: prior.researchRuns?.map((run) => ({
      ...run,
      historical: true,
    })),
    structuredResult: structuredResult === undefined ? undefined : {
      schema: structuredResult.schema,
      path: structuredResult.path,
    },
  });
  return { runState, transcript, structuredResult };
};

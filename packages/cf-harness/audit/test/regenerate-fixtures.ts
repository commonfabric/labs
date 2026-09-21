/**
 * Writes `audit/test/fixtures/`: one clean artifact tree for the audit suites
 * to read.
 *
 * The tree is produced by the harness itself — a real `CfHarnessPromptLoop`
 * against a scripted model and a fake sandbox, writing through the real
 * `FileSystemHarnessArtifactStore`. Hand-written JSON would drift from the
 * shapes the harness actually persists, and a checker tested only against
 * hand-written JSON tests the fixture rather than the harness.
 *
 * The run is arranged so that every check has something to look at: an
 * enforcing posture, a mediated observation carrying a confidentiality label,
 * an observation the sandbox could not attest and the harness therefore
 * denied, an input cell whose handle the model spends, and a delegation whose
 * child is written beside it.
 *
 * `deno task cfc-audit-fixtures` runs this. It is not run by the suites: the
 * tree is committed, and regenerating it is a deliberate act whose diff is
 * part of the review. Timestamps and model-attempt durations are the run's
 * own, so a regeneration is expected to move them.
 */

import { emptyDir } from "@std/fs";
import { dirname, fromFileUrl, join } from "@std/path";
import { normalize } from "@std/path/posix";

import type { CfcSandboxResult } from "@commonfabric/runner/cfc";

import {
  createFileSystemHarnessArtifactStore,
  readHarnessRunState,
} from "../../src/artifacts.ts";
import type { HarnessCellLabels } from "../../src/contracts/cell-labels.ts";
import { CfHarnessEngine } from "../../src/engine.ts";
import {
  createHarnessHandleTable,
  mintAddressHandle,
} from "../../src/handle-table.ts";
import {
  CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  type PromptSlotBinding,
} from "../../src/contracts/prompt-slot.ts";
import { CfHarnessPromptLoop } from "../../src/prompt-loop.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../../src/diagnostics.ts";
import { patchHarnessRunState } from "../../src/run-state.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../../src/sandbox/types.ts";
import { responsesBodyFromChatFixture } from "../../test/support/responses-fixture.ts";

/** The run this tree is of. Fixed, so the fixture's paths are stable. */
export const FIXTURE_RUN_ID = "cfc-audit-fixture";

/** Where the committed tree lives, relative to this file. */
export const FIXTURE_RUNS_DIR = join(
  dirname(fromFileUrl(import.meta.url)),
  "fixtures",
  "runs",
);

/**
 * The operator's own authority for this run.
 *
 * Under `enforce-explicit` a side effect needs direct-command evidence, so a
 * fixture without one records nothing but denials and gives the checks about
 * mediation and influence nothing to read.
 */
const OPERATOR_PROMPT_SLOT: PromptSlotBinding = {
  type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  source: { type: "cf-harness.cli-input", surface: "cfc-audit-fixture" },
  role: "direct-command",
  kernelName: "cf-harness",
  surface: "cfc-audit-fixture",
  subject: "cfc-audit-fixture",
  eventId: "cfc-audit-fixture-prompt",
};

/** The cell the operator hands the run, as a handle rather than as a value. */
const SEEDED_CELL_REF = `/of:fid1:${"A".repeat(43)}`;

class FixtureSandboxRuntime implements SandboxRuntime {
  readonly #shellResults: SandboxCommandResult[];

  constructor(shellResults: readonly SandboxCommandResult[]) {
    this.#shellResults = [...shellResults];
  }

  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
    return normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
  }

  isPathWithinWorkspace(path: string): boolean {
    return path === "/workspace" || path.startsWith("/workspace/");
  }

  isPathWithinAllowedRoots(path: string): boolean {
    return this.isPathWithinWorkspace(path);
  }

  defaultWorkingDirectory(): string {
    return "/workspace";
  }

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    if (request.command.includes(CAPABILITY_PROBE_SENTINEL)) {
      return Promise.resolve({
        stdout: [
          "bash\tpresent\t/bin/bash\tGNU bash, version 5.2.26(1)-release",
          "sh\tpresent\t/bin/sh\tBusyBox v1.36.1",
          "node\tmissing\t\t",
          "deno\tpresent\t/usr/local/bin/deno\tdeno 2.2.0",
          "python\tmissing\t\t",
          "python3\tpresent\t/usr/bin/python3\tPython 3.11.9",
          "git\tpresent\t/usr/bin/git\tgit version 2.45.1",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.resolve(
      this.#shellResults.shift() ?? { stdout: "", stderr: "", exitCode: 0 },
    );
  }
}

/** A sandbox result the substrate attested, with a labelled stdout. */
const mediatedResult = (stdout: string): CfcSandboxResult => ({
  version: 1,
  stdout: {
    channel: "stdout",
    policy: "observed",
    label: { confidentiality: ["fixture-source"] },
    segments: [{
      text: stdout,
      label: { confidentiality: ["fixture-source"] },
    }],
  },
  stderr: {
    channel: "stderr",
    policy: "observed",
    label: {},
    segments: [{ text: "", label: {} }],
  },
  exitCode: { policy: "observed", label: {}, value: 0 },
});

const bashTurn = (id: string, command: string) => ({
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        id,
        type: "function",
        function: { name: "bash", arguments: JSON.stringify({ command }) },
      }],
    },
  }],
});

const delegateTurn = (id: string, goal: string) => ({
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        id,
        type: "function",
        function: {
          name: "delegate_task",
          arguments: JSON.stringify({ goal }),
        },
      }],
    },
  }],
});

const finalTurn = (content: string) => ({
  choices: [{ index: 0, message: { role: "assistant", content } }],
});

/**
 * The scripted model: one payload per turn, in the order the loop asks.
 *
 * A turn is answered in whichever wire format it was asked in — the gateway
 * sends Chat Completions for a model it does not route to the Responses API —
 * so the payloads are written once in the chat shape and projected where the
 * request calls for it.
 */
const scriptedFetch = (payloads: readonly unknown[]): typeof fetch => {
  let turn = 0;
  return (_input, init) => {
    const payload = payloads[turn];
    turn += 1;
    if (payload === undefined) {
      throw new Error("the scripted model ran out of turns");
    }
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const body = Array.isArray(request.messages)
      ? payload
      : responsesBodyFromChatFixture(payload);
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200 }),
    );
  };
};

/**
 * The cell-labels snapshot a host holding no copy of the run's space writes.
 *
 * A run ending reads a space database, which a unit fixture has none of.
 * The `unavailable` snapshot is the same artifact that reader
 * produces on such a host, written through the same store, so the tree
 * records that the labels were asked for and were not there — which is the
 * distinction AUD-9 turns on.
 */
const unavailableCellLabels = (generatedAt: string): HarnessCellLabels => ({
  type: "cf-harness.cell-labels",
  version: 1,
  generatedAt,
  status: "unavailable",
  unavailableReason: "space-not-found",
  unavailableDetail:
    "the fixture run has no fabric session, so no space database was opened",
  cells: [],
});

/** Writes the fixture tree, replacing whatever was there. */
export const regenerateFixtures = async (
  runsDir: string = FIXTURE_RUNS_DIR,
): Promise<string> => {
  await emptyDir(runsDir);
  const engine = new CfHarnessEngine({
    artifactRoot: runsDir,
    runId: FIXTURE_RUN_ID,
    model: "fixture-model",
    cfcEnforcementMode: "enforce-explicit",
    sandboxRuntime: new FixtureSandboxRuntime([
      {
        stdout: "attested\n",
        stderr: "",
        exitCode: 0,
        cfcResult: mediatedResult("attested\n"),
      },
      { stdout: "unattested\n", stderr: "", exitCode: 0 },
    ]),
  });
  // A run's own handles are minted by the tools that produce them, and every
  // such tool here needs a fabric session the fixture has none of. The table
  // is therefore seeded the way an operator's input cell reaches a run — a
  // minted entry and a context message naming its token — which is the same
  // shape on the model's side of the boundary.
  const minted = await mintAddressHandle(
    createHarnessHandleTable(FIXTURE_RUN_ID),
    SEEDED_CELL_REF,
  );
  await engine.recordHandleTable(minted.table);
  const token = minted.token;
  const loop = new CfHarnessPromptLoop({
    apiKey: "fixture-key",
    engine,
    fetchFn: scriptedFetch([
      bashTurn("call-attested", "echo attested"),
      bashTurn("call-unattested", `echo ${token}`),
      delegateTurn("call-delegate", `Summarize ${token} for the operator.`),
      finalTurn("The child summarized the notes."),
      finalTurn("Done."),
    ]),
  });
  await loop.runPrompt({
    prompt: "Read the notes and summarize them.",
    promptSlotBinding: OPERATOR_PROMPT_SLOT,
    contextMessages: [
      `Input cells for this run:\n- ${token} — the operator's notes`,
    ],
  });

  // Every run of the family gets the snapshot, the child included: a
  // delegation's artifacts are audited on the same terms as its parent's.
  for await (const entry of Deno.readDir(runsDir)) {
    if (!entry.isDirectory) continue;
    const store = createFileSystemHarnessArtifactStore({
      artifactRoot: runsDir,
      runId: entry.name,
    });
    const state = await readHarnessRunState(
      join(runsDir, entry.name, "run-state.json"),
    );
    const cellLabels = unavailableCellLabels(state.updatedAt);
    const cellLabelsPath = await store.persistCellLabels(cellLabels);
    await store.persistRunState(
      patchHarnessRunState(
        state,
        { cellLabels, cellLabelsPath },
        state.updatedAt,
      ),
    );
  }
  return join(runsDir, FIXTURE_RUN_ID);
};

if (import.meta.main) {
  console.log(`wrote ${await regenerateFixtures()}`);
}

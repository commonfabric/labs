/**
 * The machinery a CFC property test drives, and the checker it asserts with.
 *
 * A property here is one scripted adversarial episode run against the real
 * engine and prompt loop, writing artifacts into a fresh root, followed by the
 * audit reading those artifacts back. The audit is the assertion library: a
 * property that hand-rolls its own artifact assertions proves that this file
 * can write a JSON file, not that a check can see what the run did.
 *
 * Nothing here reaches a live model or a network. The fabric is an emulated
 * storage manager and the model is a fixture that replies from a script.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";

import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type {
  CfcEnforcementMode,
  CfcSandboxResult,
} from "@commonfabric/runner/cfc";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../../../runner/test/cfc-seed-envelope.ts";

import { auditDeployment } from "../../../audit/checks/deployment.ts";
import { RUN_CHECKS } from "../../../audit/checks/registry.ts";
import { auditRunFamily } from "../../../audit/checks/structural.ts";
import { discoverRunFamilies } from "../../../audit/evidence.ts";
import type { CheckResult, CheckVerdict } from "../../../audit/report.ts";
import { type PromptSlotBinding } from "../../../src/contracts/prompt-slot.ts";

import { CAPABILITY_PROBE_SENTINEL } from "../../../src/diagnostics.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../../../src/sandbox/types.ts";
import { responsesBodyFromChatFixture } from "../../support/responses-fixture.ts";
import { directPromptSlotBindingFor } from "../../support/prompt-slot-binding.ts";

const signer = await Identity.fromPassphrase("cf-harness cfc properties");

/**
 * Authority for every episode's tool calls.
 *
 * The properties here are about labels deciding an outcome. Without a direct
 * command the enforcing modes refuse on authority instead (AH-CFC-9), and an
 * episode that stops there establishes nothing about a label.
 */
export const directPromptSlotBinding: PromptSlotBinding =
  directPromptSlotBindingFor("cfc-property");

/**
 * A sandbox that runs nothing.
 *
 * The engine requires one, and these episodes call `run_pattern` only, so
 * every method here answers the shape rather than doing the work.
 */
export class InertSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
    return path.startsWith("/") ? path : `${cwd}/${path}`;
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

  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

/**
 * A sandbox that answers the capability probe and then replays `results`.
 *
 * A result carrying a `cfcResult` is a mediated observation: the boundary
 * spoke, and what it said about each channel is what the model-facing path
 * and the influence ledger act on.
 */
export class ScriptedSandboxRuntime extends InertSandboxRuntime {
  /** Every shell request dispatched, so a test can read what the child ran. */
  readonly shellRequests: SandboxShellRequest[] = [];

  readonly #results: SandboxCommandResult[];

  constructor(results: readonly SandboxCommandResult[] = []) {
    super();
    this.#results = [...results];
  }

  override runShell(
    request: SandboxShellRequest,
  ): Promise<SandboxCommandResult> {
    this.shellRequests.push(request);
    if (request.command.includes(CAPABILITY_PROBE_SENTINEL)) {
      return Promise.resolve({
        stdout: "bash\tpresent\t/bin/bash\tGNU bash, version 5.2.26(1)-release",
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.resolve(
      this.#results.shift() ?? { stdout: "", stderr: "", exitCode: 0 },
    );
  }
}

/**
 * A mediated bash result: `stdout` observed under `stdoutLabel`, and `stderr`
 * either observed or refused.
 *
 * The two channels of one call are what let a property assert both directions
 * of AH-CFC-7 at once — a labeled channel the model read must accumulate as
 * influence, and a refused one must not.
 */
export const mediatedBashResult = (
  stdout: string,
  options: {
    stdoutLabel?: CfcSandboxResult["stdout"]["label"];
    stderrPolicy?: "observed" | "denied";
  } = {},
): SandboxCommandResult => {
  const stdoutLabel = options.stdoutLabel ?? { confidentiality: ["secret"] };
  return {
    stdout,
    stderr: "",
    exitCode: 0,
    cfcResult: {
      version: 1,
      stdout: {
        channel: "stdout",
        policy: "observed",
        label: stdoutLabel,
        segments: [{ text: stdout, label: stdoutLabel }],
      },
      stderr: options.stderrPolicy === "observed"
        ? {
          channel: "stderr",
          policy: "observed",
          label: { confidentiality: ["public"] },
          segments: [{ text: "", label: { confidentiality: ["public"] } }],
        }
        : {
          channel: "stderr",
          policy: "denied",
          label: { confidentiality: ["secret"] },
          reason: "stderr release denied",
        },
      exitCode: {
        policy: "observed",
        label: { confidentiality: ["public"] },
        value: 0,
      },
    },
  };
};

export interface LabeledFabric {
  runtime: Runtime;
  pieces: PiecesController;
  space: ReturnType<PiecesController["getSpace"]>;
  dispose: () => Promise<void>;
}

/**
 * A fabric with flow labels persisted, at the enforcement posture named.
 *
 * `cfcFlowLabels: "persist"` is what makes a label survive into the store and
 * so what makes a release measurement have anything to measure; at the default
 * rung the properties below would pass by finding nothing rather than by the
 * gate admitting the flow.
 */
export const createLabeledFabric = async (
  cfcEnforcementMode: CfcEnforcementMode = "enforce-explicit",
): Promise<LabeledFabric> => {
  const storage = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("http://toolshed.test"),
    storageManager: storage,
    cfcEnforcementMode,
    cfcFlowLabels: "persist",
  });
  const pieces = new PiecesController(
    await createSession({
      identity: signer,
      spaceName: `cfc-property-${cfcEnforcementMode}-${crypto.randomUUID()}`,
    }),
    runtime,
  );
  await pieces.synced();
  return {
    runtime,
    pieces,
    space: pieces.getSpace(),
    dispose: async () => {
      // The storage closes whatever the runtime does on the way down. A
      // dispose that throws would otherwise leave the emulated storage open
      // for the rest of the process.
      try {
        await runtime.dispose();
      } finally {
        await storage.close();
      }
    },
  };
};

/**
 * Seeds a document whose `secret` field carries confidentiality, and answers
 * the link an agent would pass as an input naming it.
 */
export const seedLabeledSecret = async (
  runtime: Runtime,
  space: ReturnType<PiecesController["getSpace"]>,
  cause: string,
): Promise<string> => {
  const seed = runtime.edit();
  const sourceCell = runtime.getCell(
    space,
    cause,
    { type: "object", properties: { secret: { type: "string" } } },
    seed,
  );
  const sourceId = sourceCell.getAsNormalizedFullLink().id;
  writeSeedEnvelopeDoc(seed, space);
  seedStoredEnvelope(seed, { space, scope: "space", id: sourceId, path: [] }, {
    value: { secret: "s3cr3t" },
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [{ path: ["secret"], label: { confidentiality: ["secret"] } }],
      },
    },
  });
  expect((await seed.commit()).ok).toBeDefined();
  return createLLMFriendlyLink(sourceCell.getAsNormalizedFullLink(), space);
};

/**
 * A pattern over one plain input and one optional referenced input, where the
 * referenced one only widens the answer.
 *
 * Run with the reference derived from labeled data, its answer carries the
 * label and the ceiling refuses it. Run without, it still computes — which is
 * what lets one pattern serve both the refused and the permitted property.
 */
export const OPTIONAL_SECRET_PATTERN_SOURCE = [
  "import { computed, pattern, Reactive } from 'commonfabric';",
  "interface Source { secret: string; }",
  "interface Input { amount: number; source?: Reactive<Source>; }",
  "interface Output { total: number; }",
  "export default pattern<Input, Output>(({ amount, source }) => ({",
  "  total: computed(() => {",
  "    const secret = source?.secret;",
  "    return amount + (typeof secret === 'string' ? secret.length : 0);",
  "  }),",
  "}));",
  "",
].join("\n");

export const TOTAL_RESULT_SCHEMA = {
  type: "object",
  properties: { total: { type: "number" } },
  required: ["total"],
} as const;

/** One assistant turn of a scripted episode. */
export type ScriptedTurn =
  | { toolName: string; arguments: Record<string, unknown> }
  | { content: string };

/**
 * A model that replays `turns` and then stops.
 *
 * Deterministic and free, per the suite's constraint: no live model call, and
 * the same episode every run.
 */
export const scriptedModel = (turns: readonly ScriptedTurn[]): typeof fetch => {
  let callCount = 0;
  return () => {
    const turn = turns[callCount];
    callCount += 1;
    const message = turn === undefined
      ? { role: "assistant", content: "Done." }
      : "content" in turn
      ? { role: "assistant", content: turn.content }
      : {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: `call-${callCount}`,
          type: "function",
          function: {
            name: turn.toolName,
            arguments: JSON.stringify(turn.arguments),
          },
        }],
      };
    return Promise.resolve(
      new Response(
        JSON.stringify(
          responsesBodyFromChatFixture({
            choices: [{ index: 0, message }],
          }),
        ),
        { status: 200 },
      ),
    );
  };
};

/**
 * Where one property's episode writes its artifacts.
 *
 * A temp directory by default, so a local run leaves nothing behind. The
 * nightly job sets `CF_HARNESS_PROPERTY_ARTIFACT_ROOT` and then audits what
 * the whole suite wrote, which needs the runs to land somewhere it can name;
 * each run keeps its own subdirectory there so two properties cannot collide.
 */
export const propertyArtifactRoot = async (runId: string): Promise<string> => {
  const configured = Deno.env.get("CF_HARNESS_PROPERTY_ARTIFACT_ROOT");
  if (configured === undefined || configured.trim() === "") {
    return await Deno.makeTempDir({ prefix: `cfc-property-${runId}-` });
  }
  await Deno.mkdir(configured, { recursive: true });
  return configured;
};

/**
 * A root outside the shared one, for an episode that violates on purpose.
 *
 * A property that proves a check fires has to produce the shape the check
 * catches, and that run is a fixture for the check rather than evidence about
 * the system. Letting it into the corpus the nightly audits would report a
 * deliberate violation as a conformance gap, so it always gets its own
 * directory even when a shared root is configured.
 */
export const adversarialArtifactRoot = (runId: string): Promise<string> =>
  Deno.makeTempDir({ prefix: `cfc-adversarial-${runId}-` });

/**
 * The one run directory an episode wrote, which is what its own assertions
 * read.
 *
 * A property asserts about its own episode, so it audits its run rather than
 * the root: under the nightly's shared root every property's runs sit side by
 * side, and auditing the root there would fold the whole suite into each
 * property's verdict.
 */
export const propertyRunDir = (artifactRoot: string, runId: string): string =>
  join(artifactRoot, runId);

/** What the audit said about one artifact root. */
export interface AuditOfArtifacts {
  results: readonly CheckResult[];

  /** Every verdict a check reached, over every run of the root. */
  verdicts: (checkId: string) => readonly CheckVerdict[];

  /** The findings a check reached, for a message a failure can quote. */
  findings: (checkId: string) => readonly CheckResult[];
}

/**
 * Runs the audit over an artifact root and answers what it found.
 *
 * Both check groups run: the per-run checks that read what a run did, and the
 * deployment checks that read the root as a corpus, which is where AUD-16's
 * refusal count lives.
 */
export const auditArtifacts = async (
  artifactRoot: string,
  options: { expectRefusals?: boolean } = {},
): Promise<AuditOfArtifacts> => {
  const families = await discoverRunFamilies(artifactRoot);
  const results = [
    ...families.flatMap((family) => auditRunFamily(family, RUN_CHECKS)),
    ...auditDeployment({
      families,
      paths: [artifactRoot],
      expectRefusals: options.expectRefusals ?? false,
    }),
  ];
  return {
    results,
    verdicts: (checkId) =>
      results.filter((result) => result.checkId === checkId).map((result) =>
        result.verdict
      ),
    findings: (checkId) =>
      results.filter((result) => result.checkId === checkId),
  };
};

/**
 * The findings of one check, having established that the check ran at all.
 *
 * A property that filtered a check's findings for failures and asserted the
 * list was empty would pass just as well on a check that never ran — a wrong
 * run directory, a renamed id, a check dropped from the registry. Asking for
 * the findings through here makes that a failure rather than a green run.
 */
export const checkThatRan = (
  audit: AuditOfArtifacts,
  checkId: string,
): readonly CheckResult[] => {
  const findings = audit.findings(checkId);
  if (findings.length === 0) {
    throw new Error(
      `${checkId} reported nothing over these artifacts, so an assertion about its findings would hold vacuously`,
    );
  }
  return findings;
};

/** Every message a check wrote, for quoting into an assertion failure. */
export const messagesOf = (findings: readonly CheckResult[]): string =>
  findings.map((finding) =>
    [
      `${finding.checkId} ${finding.verdict}: ${finding.message}`,
      ...finding.evidence.map((item) =>
        `    ${item.artifact ?? ""} ${item.pointer ?? ""} ${item.detail}`
      ),
    ].join("\n")
  ).join("\n");

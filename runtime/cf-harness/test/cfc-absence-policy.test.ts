/**
 * That the absence policy a mode publishes is the absence policy it enacts.
 *
 * `cfcAbsenceBehaviorForMode` is the one derivation of what a mode does with
 * an observation whose trusted mediation metadata is absent. Two readers act
 * on it: the capability snapshot publishes it, so a reader of a run's
 * artifacts learns what the run would do, and the model-facing output path
 * decides whether such an observation reaches the model. This file drives the
 * second and compares it against the first.
 *
 * The comparison is written as a table keyed by the published behavior rather
 * than by the mode. A test that hard-codes an outcome per mode passes whether
 * or not the two agree; keying on the descriptor means an edit that changes
 * one without the other fails here, which is the drift this file exists to
 * make impossible.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";

import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";

import {
  CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  type PromptSlotBinding,
} from "../src/contracts/prompt-slot.ts";
import {
  CAPABILITY_PROBE_SENTINEL,
  cfcAbsenceBehaviorForMode,
  type HarnessCfcAbsenceBehavior,
} from "../src/diagnostics.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import { responsesBodyFromChatFixture } from "./support/responses-fixture.ts";

/** The secret the sandbox returns, which a denied observation must not carry. */
const FILE_CONTENT = "absence-policy-secret";

/** A path whose very existence the status-error path must not disclose. */
const SENSITIVE_PATH = "/workspace/personal/health/absence-policy-condition.md";

/**
 * Authority for the read, so that absence is the only thing under test.
 *
 * `enforce-strict` refuses every tool call that carries no direct command
 * (AH-CFC-9), which would deny the read before the observation path ever ran.
 * That denial is a different clause answering a different question, and a run
 * that stops there establishes nothing about what absent mediation metadata
 * does.
 */
const directPromptSlotBinding: PromptSlotBinding = {
  type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  source: { type: "test.prompt-slot", subject: "absence-policy" },
  role: "direct-command",
  kernelName: "cf-harness",
  surface: "test",
  subject: "absence-policy",
  eventId: "event-absence-policy",
};

/**
 * A sandbox that answers the capability probe and then returns plain bytes.
 *
 * Plain bytes are the point: nothing here attaches a `CfcSandboxResult`, so
 * every read through this runtime is an observation whose trusted mediation
 * metadata is absent.
 */
class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "runsc-cfc",
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
        stdout: "bash\tpresent\t/bin/bash\tGNU bash, version 5.2.26(1)-release",
        stderr: "",
        exitCode: 0,
      });
    }
    if (this.failing) {
      return Promise.resolve({
        stdout: "",
        stderr: `file not found: ${SENSITIVE_PATH}`,
        exitCode: 10,
      });
    }
    return Promise.resolve({
      stdout: `${FILE_CONTENT}\n`,
      stderr: "",
      exitCode: 0,
    });
  }

  /** Whether the read fails, which is what produces a status observation. */
  failing = false;
}

/** A model that reads one file and then stops. */
const readFileThenStop = (
  tool: { name: string; arguments: Record<string, unknown> } = {
    name: "read_file",
    arguments: { path: "secret.txt" },
  },
): typeof fetch => {
  let callCount = 0;
  return () => {
    callCount += 1;
    const payload = callCount === 1
      ? {
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call-absence-policy",
              type: "function",
              function: {
                name: tool.name,
                arguments: JSON.stringify(tool.arguments),
              },
            }],
          },
        }],
      }
      : {
        choices: [{
          index: 0,
          message: { role: "assistant", content: "Done." },
        }],
      };
    return Promise.resolve(
      new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
        status: 200,
      }),
    );
  };
};

/**
 * What the model-facing path did with the unmediated observation.
 *
 * `denied-elsewhere` is the outcome no published behavior claims: a denial
 * that some other clause raised before the absence policy was consulted. It
 * exists so that such a run fails this file rather than passing it as though
 * the absence policy had done the denying.
 */
type AbsenceOutcome =
  | "exposed"
  | "exposed-with-warning"
  | "denied"
  | "denied-elsewhere";

/**
 * What each published behavior claims the run will do.
 *
 * Total over `HarnessCfcAbsenceBehavior`, so a new value in that union stops
 * compiling here rather than silently going unchecked.
 */
const OUTCOME_FOR_BEHAVIOR: Record<
  HarnessCfcAbsenceBehavior,
  AbsenceOutcome
> = {
  "not-required": "exposed",
  "permissive-if-absent": "exposed",
  "observe-only": "exposed-with-warning",
  "fail-closed-if-absent": "denied",
};

const MODES: readonly CfcEnforcementMode[] = [
  "disabled",
  "observe",
  "enforce-explicit",
  "enforce-strict",
];

interface ObservedAbsence {
  outcome: AbsenceOutcome;
  /** Whether the model-facing message carried the sandbox's bytes. */
  disclosedContent: boolean;
  /** Set when the observation came back as a typed denial. */
  denial?: { reason: unknown; handleType: unknown };
}

const runUnmediatedRead = async (
  mode: CfcEnforcementMode,
): Promise<ObservedAbsence> => {
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine: new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `run-absence-${mode}`,
      model: "gpt-5.4",
      cfcEnforcementMode: mode,
    }),
    fetchFn: readFileThenStop(),
  });

  const result = await loop.runPrompt({
    prompt: "Touch a file.",
    promptSlotBinding: directPromptSlotBinding,
  });

  const toolMessage = result.transcript.find((message) =>
    message.role === "tool" && message.toolName === "read_file"
  );
  expect(toolMessage).toBeDefined();
  const content = JSON.parse(toolMessage!.content) as Record<string, unknown>;
  const disclosedContent = toolMessage!.content.includes(FILE_CONTENT);

  const mediationEvents = result.runState.policyEvents.filter((event) =>
    (event.detail ?? "").includes(
      "did not include trusted CFC mediation metadata",
    )
  );

  if (content.type === "cf-harness.observation-denied") {
    // Only a denial the absence policy raised counts as one: the run must
    // also have recorded absent mediation metadata as the cause.
    const deniedForAbsence = mediationEvents.some((event) =>
      event.severity === "denied"
    );
    return {
      outcome: deniedForAbsence ? "denied" : "denied-elsewhere",
      disclosedContent,
      denial: {
        reason: content.reason,
        handleType: (content.handle as Record<string, unknown> | undefined)
          ?.type,
      },
    };
  }
  return {
    outcome: mediationEvents.some((event) => event.severity === "warning")
      ? "exposed-with-warning"
      : "exposed",
    disclosedContent,
  };
};

/**
 * Runs one failing `read_file` and answers what the status observation became.
 *
 * The same three-way answer as an absent-metadata observation, reached by a
 * different route: the error text names a path whose existence is itself the
 * disclosure, so the boundary will not release it.
 */
const STATUS_TOOLS = [
  { name: "read_file", arguments: { path: SENSITIVE_PATH } },
  {
    name: "edit_file",
    arguments: {
      path: SENSITIVE_PATH,
      oldText: "before",
      newText: "after",
    },
  },
] as const;

const runStatusObservation = async (
  mode: CfcEnforcementMode,
  tool: { name: string; arguments: Record<string, unknown> } = STATUS_TOOLS[0],
): Promise<ObservedAbsence> => {
  const sandbox = new FakeSandboxRuntime();
  sandbox.failing = true;
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine: new CfHarnessEngine({
      sandboxRuntime: sandbox,
      runId: `run-status-${tool.name}-${mode}`,
      model: "gpt-5.4",
      cfcEnforcementMode: mode,
    }),
    fetchFn: readFileThenStop(tool),
  });

  const result = await loop.runPrompt({
    prompt: "Touch a file.",
    promptSlotBinding: directPromptSlotBinding,
  });

  const toolMessage = result.transcript.find((message) =>
    message.role === "tool" && message.toolName === tool.name
  );
  expect(toolMessage).toBeDefined();
  const disclosedContent = toolMessage!.content.includes(SENSITIVE_PATH);
  // Both tools name their own shape of disclosure — `read_file` a filesystem
  // path/status, `edit_file` content, digest, path or status — so the event
  // is found by the tool that wrote it rather than by wording.
  const statusEvents = result.runState.policyEvents.filter((event) =>
    event.toolId === tool.name &&
    (event.detail ?? "").includes("may reveal")
  );

  // A redacted status error is this path's form of denial: the run answered
  // with a shape that carries no path rather than with a typed refusal.
  const redacted = toolMessage!.content.includes("[redacted]");
  if (redacted) {
    return { outcome: "denied", disclosedContent };
  }
  return {
    outcome: statusEvents.some((event) => event.severity === "warning")
      ? "exposed-with-warning"
      : "exposed",
    disclosedContent,
  };
};

describe("cfc absence policy", () => {
  describe("cfcAbsenceBehaviorForMode()", () => {
    it("answers every enforcement mode", () => {
      for (const mode of MODES) {
        expect(OUTCOME_FOR_BEHAVIOR[cfcAbsenceBehaviorForMode(mode)])
          .toBeDefined();
      }
    });

    it("fails closed for a mode this build does not recognize", () => {
      // The type says this cannot happen and a resumed or injected run state
      // can carry it anyway. An enforcement mode nobody here recognizes is
      // not a licence to expose: the unknown answer is the closed one, and
      // the disposition derived from it denies.
      const unknown = "enforce-from-the-future" as CfcEnforcementMode;

      expect(cfcAbsenceBehaviorForMode(unknown)).toBe("fail-closed-if-absent");
      expect(OUTCOME_FOR_BEHAVIOR[cfcAbsenceBehaviorForMode(unknown)]).toBe(
        "denied",
      );
    });

    it("fails closed in both enforcing modes", () => {
      // AH-CFC-6 admits no weaker answer, and `enforce-explicit` names a rule
      // about invocation authority rather than about observation mediation.
      expect(cfcAbsenceBehaviorForMode("enforce-explicit")).toBe(
        "fail-closed-if-absent",
      );
      expect(cfcAbsenceBehaviorForMode("enforce-strict")).toBe(
        "fail-closed-if-absent",
      );
    });
  });

  describe("an observation whose mediation metadata is absent", () => {
    for (const mode of MODES) {
      it(`does in ${mode} what ${mode} publishes it will do`, async () => {
        const observed = await runUnmediatedRead(mode);
        const published = cfcAbsenceBehaviorForMode(mode);

        expect(observed.outcome).toBe(OUTCOME_FOR_BEHAVIOR[published]);
      });
    }

    it("returns a typed denial carrying an opaque handle in enforcing modes", async () => {
      // AH-CFC-6: the observation is refused as a named kind of refusal with a
      // handle standing in for what was withheld, not dropped or emptied.
      for (const mode of ["enforce-explicit", "enforce-strict"] as const) {
        const observed = await runUnmediatedRead(mode);
        expect(observed.denial).toEqual({
          reason: "not-observable",
          handleType: "cf-harness.opaque-handle",
        });
        expect(observed.disclosedContent).toBe(false);
      }
    });

    it("answers a filesystem-status observation the same way in every mode", async () => {
      // The disposition is shared by three call sites, and only one of them is
      // about absent metadata. This pins the other two: a `read_file` status
      // error takes the same three-way answer, so a change to the dial cannot
      // move one site without moving all of them — and cannot move any of them
      // without this failing.
      for (const tool of STATUS_TOOLS) {
        for (const mode of MODES) {
          const observed = await runStatusObservation(mode, tool);
          const published = cfcAbsenceBehaviorForMode(mode);

          expect(observed.outcome).toBe(OUTCOME_FOR_BEHAVIOR[published]);
        }
      }
    });

    it("discloses the path in the modes that publish they will", async () => {
      // The positive direction of the redaction. Without it a regression that
      // stripped the path in every mode would pass: the enforcing assertion
      // below would still hold, and nothing would notice observe had stopped
      // disclosing what it is meant to.
      for (const tool of STATUS_TOOLS) {
        for (const mode of ["disabled", "observe"] as const) {
          const observed = await runStatusObservation(mode, tool);

          expect(observed.disclosedContent).toBe(true);
        }
      }
    });

    it("withholds the path from a status observation in enforcing modes", async () => {
      // The disclosure the redaction exists for: whether the file is there is
      // the fact being withheld, so the path must not survive into the reply.
      for (const tool of STATUS_TOOLS) {
        for (const mode of ["enforce-explicit", "enforce-strict"] as const) {
          const observed = await runStatusObservation(mode, tool);

          expect(observed.disclosedContent).toBe(false);
        }
      }
    });

    it("discloses the observation in the modes that publish that it will", async () => {
      // The other direction, so the suite cannot pass by denying everything.
      for (const mode of ["disabled", "observe"] as const) {
        const observed = await runUnmediatedRead(mode);
        expect(observed.disclosedContent).toBe(true);
      }
    });
  });
});

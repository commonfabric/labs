/**
 * A delegated child's model-context label reaches its parent's when the child
 * returns, whatever the child's profile: whatever crosses was derived from
 * what the child observed. The parent's later tool inputs then carry that
 * label, and its run under `enforce-strict` completes.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cfcAtom } from "@commonfabric/api/cfc";
import type { IFCLabel } from "@commonfabric/runner/cfc";
import { normalize } from "@std/path/posix";
import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import {
  type DelegateTaskToolOutput,
  HARNESS_SUBAGENT_PROFILES,
  type HarnessDelegableSubagentProfile,
} from "../src/contracts/subagent.ts";
import type { HarnessRunState } from "../src/run-state.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import type {
  HarnessModelClient,
  HarnessModelTurnResult,
} from "../src/model/client.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import { directPromptSlotBindingFor } from "./support/prompt-slot-binding.ts";

const directPromptSlotBinding = directPromptSlotBindingFor(
  "subagent-label-crossing",
);

const SECRET = cfcAtom.resource("ChildFinding", "child");
const PARENT_SECRET = cfcAtom.resource("ParentFinding", "parent");
const SECRET_LABEL: IFCLabel = { confidentiality: [SECRET] };
const PARENT_LABEL: IFCLabel = { confidentiality: [PARENT_SECRET] };
const PUBLIC_LABEL: IFCLabel = { confidentiality: ["public"] };

/** A shell command's stdout, and the label the CFC sandbox reports for it. */
interface LabeledOutput {
  stdout: string;
  label: IFCLabel;
}

/**
 * A CFC sandbox that answers each shell command, in order, with the next
 * labeled output, reporting stderr and the exit code with no confidentiality.
 */
class LabeledSandboxRuntime implements SandboxRuntime {
  readonly #outputs: LabeledOutput[];

  constructor(outputs: LabeledOutput[]) {
    this.#outputs = [...outputs];
  }

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
    return Promise.resolve(mediated({ stdout: "", label: {} }));
  }

  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    if (request.command.includes(CAPABILITY_PROBE_SENTINEL)) {
      return Promise.resolve(mediated({
        stdout: "bash\tpresent\t/bin/bash\tGNU bash, version 5.2.26(1)-release",
        label: {},
      }));
    }
    const output = this.#outputs.shift();
    if (output === undefined) {
      throw new Error(`unexpected shell command: ${request.command}`);
    }
    return Promise.resolve(mediated(output));
  }
}

/**
 * A CFC sandbox that answers each shell command with the labeled output named
 * for the command it runs, whatever order the commands arrive in.
 */
class CommandLabeledSandboxRuntime extends LabeledSandboxRuntime {
  readonly #outputs: ReadonlyMap<string, LabeledOutput>;

  constructor(outputs: ReadonlyMap<string, LabeledOutput>) {
    super([]);
    this.#outputs = outputs;
  }

  override runShell(
    request: SandboxShellRequest,
  ): Promise<SandboxCommandResult> {
    const output = [...this.#outputs].find(([command]) =>
      request.command.includes(command)
    )?.[1];
    return output === undefined
      ? super.runShell(request)
      : Promise.resolve(mediated(output));
  }
}

const mediated = ({ stdout, label }: LabeledOutput): SandboxCommandResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
  cfcResult: {
    version: 1,
    stdout: {
      channel: "stdout",
      policy: "observed",
      label,
      segments: [{ text: stdout, label }],
    },
    stderr: {
      channel: "stderr",
      policy: "observed",
      label: {},
      segments: [{ text: "", label: {} }],
    },
    exitCode: { policy: "observed", label: {}, value: 0 },
  },
});

const toolCallTurn = (
  id: string,
  name: string,
  input: unknown,
): HarnessModelTurnResult => ({
  assistant: {
    role: "assistant",
    content: "",
    toolCalls: [{
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(input) },
    }],
  },
});

const bashTurn = (id: string, command: string) =>
  toolCallTurn(id, "bash", { command });

const finalTurn = (content: string): HarnessModelTurnResult => ({
  assistant: { role: "assistant", content },
});

/**
 * A model client that answers each turn, parent's and child's alike, with the
 * next scripted result, recording the tools each turn offered.
 */
const scriptedModelClient = (
  turns: readonly HarnessModelTurnResult[],
  offeredTools: string[][],
): HarnessModelClient => ({
  providerId: "test-provider",
  complete: (request) => {
    offeredTools.push(request.tools.map((tool) => tool.toolId));
    const turn = turns[offeredTools.length - 1];
    if (turn === undefined) {
      throw new Error("scripted model client ran out of turns");
    }
    return Promise.resolve(turn);
  },
});

/**
 * What a child of each profile answers with: the profile's own return
 * contract where it has one, or plain text.
 */
const childAnswer = (profile: HarnessDelegableSubagentProfile): string =>
  profile === "pattern-author"
    ? JSON.stringify({ ok: false, code: "other" })
    : "Child done.";

interface DelegationScenario {
  profile: HarnessDelegableSubagentProfile;
  /** Labeled outputs of the parent's shell commands before it delegates. */
  parentBefore?: LabeledOutput[];
  /** Labeled outputs of the child's shell commands. */
  child?: LabeledOutput[];
  /** Overrides the child's final answer. */
  childFinal?: string;
  returnSchema?: unknown;
}

interface DelegationOutcome {
  runState: HarnessRunState;
  transcriptText: string;
  delegateOutput: DelegateTaskToolOutput;
  /** The parent's `bash` invocation after the child returned. */
  bashAfter: NonNullable<HarnessRunState["cfcInvocationContexts"]>[number];
}

/**
 * Runs a parent under `enforce-strict` that runs each `parentBefore` command,
 * delegates to a child of `profile` that runs each `child` command and
 * answers, and then runs one more command of its own before it finishes.
 */
const runDelegation = async (
  scenario: DelegationScenario,
): Promise<DelegationOutcome> => {
  const parentBefore = scenario.parentBefore ?? [];
  const child = scenario.child ?? [];
  const offeredTools: string[][] = [];
  const loop = new CfHarnessPromptLoop({
    engine: new CfHarnessEngine({
      sandboxRuntime: new LabeledSandboxRuntime([
        ...parentBefore,
        ...child,
        { stdout: "parent after", label: {} },
      ]),
      runId: `run-label-crossing-${scenario.profile}`,
      model: "gpt-5.4",
      cfcEnforcementMode: "enforce-strict",
    }),
    allowedToolIds: ["bash", "delegate_task"],
    allowedSubagentProfiles: [scenario.profile],
    modelClient: scriptedModelClient([
      ...parentBefore.map((_, index) =>
        bashTurn(`call-parent-before-${index}`, `parent before ${index}`)
      ),
      toolCallTurn("call-delegate", "delegate_task", {
        profile: scenario.profile,
        goal: "Look into it.",
        ...(scenario.returnSchema !== undefined
          ? { returnSchema: scenario.returnSchema }
          : {}),
      }),
      ...child.map((_, index) =>
        bashTurn(`call-child-${index}`, `child ${index}`)
      ),
      finalTurn(scenario.childFinal ?? childAnswer(scenario.profile)),
      bashTurn("call-parent-after", "parent after"),
      finalTurn("Parent done."),
    ], offeredTools),
  });

  const result = await loop.runPrompt({
    prompt: "Delegate it, then check.",
    promptSlotBinding: directPromptSlotBinding,
  });

  if (child.length > 0) {
    expect(offeredTools[parentBefore.length + 1]).toContain("bash");
  }
  expect(result.runState.status).toBe("completed");
  expect(result.finalAssistantText).toBe("Parent done.");
  const delegateMessage = result.transcript.find((message) =>
    message.role === "tool" && message.toolName === "delegate_task"
  );
  const bashAfter = result.runState.cfcInvocationContexts?.filter((context) =>
    context.toolId === "bash"
  ).at(-1);
  if (delegateMessage === undefined || bashAfter === undefined) {
    throw new Error("expected a delegation and a later bash call");
  }
  return {
    runState: result.runState,
    transcriptText: JSON.stringify(result.transcript),
    delegateOutput: JSON.parse(delegateMessage.content),
    bashAfter,
  };
};

const confidentialityOf = (label: IFCLabel | undefined) =>
  label?.confidentiality ?? [];

const delegateObservations = (runState: HarnessRunState) =>
  runState.cfcModelContext?.observations.filter((observation) =>
    observation.toolId === "delegate_task"
  ) ?? [];

const bashInputConfidentiality = (
  context: DelegationOutcome["bashAfter"],
) =>
  context.cfcInputLabels?.entries.flatMap((entry) =>
    confidentialityOf(entry.label)
  ) ?? [];

/**
 * How this file delegates to each profile. A `shell` child holds `bash`, so a
 * test can hand it a labeled output to observe; a `web` child holds no `bash`.
 * A `browser` child needs a browser host, which this file does not set up.
 */
const PROFILE_KINDS = {
  default: "shell",
  "pattern-author": "shell",
  web_fetch: "web",
  web_search: "web",
  browser: "browser",
} as const satisfies Record<
  HarnessDelegableSubagentProfile,
  "shell" | "web" | "browser"
>;

const profilesOfKind = (
  ...kinds: readonly string[]
): HarnessDelegableSubagentProfile[] =>
  HARNESS_SUBAGENT_PROFILES.filter((profile) =>
    kinds.includes(PROFILE_KINDS[profile])
  );

/** A position a structured return sealed rather than released. */
const SEALED = { "@link": expect.stringMatching(/^opaque:/) };

describe("prompt-loop", () => {
  describe("a delegated child's model-context label", () => {
    for (const profile of profilesOfKind("shell")) {
      it(`brings what a \`${profile}\` child observed into the parent's label, and into the parent's later tool inputs`, async () => {
        const outcome = await runDelegation({
          profile,
          child: [{ stdout: "child secret", label: SECRET_LABEL }],
        });

        expect(confidentialityOf(outcome.runState.cfcModelContext?.label))
          .toContainEqual(SECRET);
        const crossed = delegateObservations(outcome.runState);
        expect(crossed).toHaveLength(1);
        expect(crossed[0]).toMatchObject({
          toolCallId: "call-delegate",
          channels: ["output"],
        });
        expect(confidentialityOf(crossed[0].label)).toContainEqual(SECRET);
        expect(bashInputConfidentiality(outcome.bashAfter)).toContainEqual(
          SECRET,
        );
      });

      it(`brings only \`public\` into the parent's label when a \`${profile}\` child observed only public output`, async () => {
        const outcome = await runDelegation({
          profile,
          child: [{ stdout: "child public", label: PUBLIC_LABEL }],
        });

        expect(confidentialityOf(outcome.runState.cfcModelContext?.label))
          .toEqual(["public"]);
        expect(
          confidentialityOf(delegateObservations(outcome.runState)[0]?.label),
        ).toEqual(["public"]);
        expect(bashInputConfidentiality(outcome.bashAfter)).toEqual([
          "public",
        ]);
      });

      it(`adds nothing to the parent's model context when a \`${profile}\` child observes nothing`, async () => {
        const outcome = await runDelegation({ profile });

        expect(outcome.delegateOutput.subagent.status).toBe("completed");
        expect(outcome.runState.cfcModelContext).toBeUndefined();
        expect(outcome.bashAfter.cfcInputLabels).toBeUndefined();
      });

      it(`returns exactly the parent's label from a \`${profile}\` child that observes nothing`, async () => {
        const outcome = await runDelegation({
          profile,
          parentBefore: [{ stdout: "parent secret", label: PARENT_LABEL }],
        });

        const crossed = delegateObservations(outcome.runState);
        expect(crossed).toHaveLength(1);
        expect(confidentialityOf(crossed[0].label)).toEqual([PARENT_SECRET]);
        expect(confidentialityOf(outcome.runState.cfcModelContext?.label))
          .toEqual([PARENT_SECRET]);
      });
    }

    for (const profile of profilesOfKind("shell", "web")) {
      it(`hands a \`${profile}\` child its parent's label and keeps it in the parent's later tool inputs`, async () => {
        const outcome = await runDelegation({
          profile,
          parentBefore: [{ stdout: "parent secret", label: PARENT_LABEL }],
        });

        const crossed = delegateObservations(outcome.runState);
        expect(crossed).toHaveLength(1);
        expect(confidentialityOf(crossed[0].label)).toContainEqual(
          PARENT_SECRET,
        );
        expect(confidentialityOf(outcome.runState.cfcModelContext?.label))
          .toContainEqual(PARENT_SECRET);
        expect(bashInputConfidentiality(outcome.bashAfter)).toContainEqual(
          PARENT_SECRET,
        );
      });
    }

    it("carries the label of a child whose return reaches the parent only as a sealed link", async () => {
      const returnSchema = {
        type: "object",
        properties: { note: { type: "string" } },
        required: ["note"],
        additionalProperties: false,
      };
      const childFinal = JSON.stringify({ note: "the secret is 4471" });
      const secret = await runDelegation({
        profile: "default",
        child: [{ stdout: "the secret is 4471", label: SECRET_LABEL }],
        childFinal,
        returnSchema,
      });
      const publicOnly = await runDelegation({
        profile: "default",
        child: [{ stdout: "nothing secret", label: PUBLIC_LABEL }],
        childFinal,
        returnSchema,
      });

      // Nothing the child wrote is readable in the parent: the only thing
      // that crosses with the sealed link is the child's label.
      for (const outcome of [secret, publicOnly]) {
        expect(outcome.delegateOutput.subagent.structuredReturn?.value)
          .toEqual({ note: SEALED });
      }
      expect(secret.transcriptText).not.toContain("4471");
      expect(confidentialityOf(secret.runState.cfcModelContext?.label))
        .toContainEqual(SECRET);
      expect(bashInputConfidentiality(secret.bashAfter)).toContainEqual(SECRET);
      expect(confidentialityOf(publicOnly.runState.cfcModelContext?.label))
        .toEqual(["public"]);
      expect(bashInputConfidentiality(publicOnly.bashAfter)).toEqual([
        "public",
      ]);
    });

    it("carries the label of a `pattern-author` child whose successful return reaches the parent as `ok` and sealed links", async () => {
      const childFinal = JSON.stringify({
        ok: true,
        resultRef: "the working piece",
        describes: "Built the piece.",
      });
      const secret = await runDelegation({
        profile: "pattern-author",
        child: [{ stdout: "child secret", label: SECRET_LABEL }],
        childFinal,
      });
      const publicOnly = await runDelegation({
        profile: "pattern-author",
        child: [{ stdout: "child public", label: PUBLIC_LABEL }],
        childFinal,
      });

      for (const outcome of [secret, publicOnly]) {
        expect(outcome.delegateOutput.subagent.structuredReturn?.value)
          .toEqual({ ok: true, resultRef: SEALED, describes: SEALED });
      }
      expect(confidentialityOf(secret.runState.cfcModelContext?.label))
        .toContainEqual(SECRET);
      expect(confidentialityOf(publicOnly.runState.cfcModelContext?.label))
        .toEqual(["public"]);
    });

    it("brings each child started in one turn only its own label, and the parent both", async () => {
      // The parent observes its children's labels once every call of the
      // turn has returned, so neither child inherits the other's.
      const runId = "run-label-crossing-siblings";
      const loop = new CfHarnessPromptLoop({
        engine: new CfHarnessEngine({
          sandboxRuntime: new CommandLabeledSandboxRuntime(
            new Map([
              ["child secret", { stdout: "secret", label: SECRET_LABEL }],
              ["child public", { stdout: "public", label: PUBLIC_LABEL }],
              ["parent after", { stdout: "parent after", label: {} }],
            ]),
          ),
          runId,
          model: "gpt-5.4",
          cfcEnforcementMode: "enforce-strict",
        }),
        allowedToolIds: ["bash", "delegate_task"],
        allowedSubagentProfiles: ["default"],
        modelClient: {
          providerId: "test-provider",
          complete: (request) => {
            const answered = request.transcript.some((message) =>
              message.role === "tool"
            );
            if (request.runId !== runId) {
              const command = JSON.stringify(request.transcript).includes(
                  "Read the secret.",
                )
                ? "child secret"
                : "child public";
              return Promise.resolve(
                answered ? finalTurn("Child done.") : bashTurn("call", command),
              );
            }
            const delegated = request.transcript.filter((message) =>
              message.role === "tool" && message.toolName === "delegate_task"
            ).length;
            if (delegated === 0) {
              return Promise.resolve({
                assistant: {
                  role: "assistant",
                  content: "",
                  toolCalls: ["Read the secret.", "Read the public note."].map((
                    goal,
                    index,
                  ) => ({
                    id: `call-delegate-${index}`,
                    type: "function" as const,
                    function: {
                      name: "delegate_task",
                      arguments: JSON.stringify({ profile: "default", goal }),
                    },
                  })),
                },
              });
            }
            return Promise.resolve(
              request.transcript.some((message) =>
                  message.role === "tool" && message.toolName === "bash"
                )
                ? finalTurn("Parent done.")
                : bashTurn("call-parent-after", "parent after"),
            );
          },
        },
      });

      const result = await loop.runPrompt({
        prompt: "Delegate both, then check.",
        promptSlotBinding: directPromptSlotBinding,
      });

      expect(result.runState.status).toBe("completed");
      const crossed = delegateObservations(result.runState);
      expect(crossed).toHaveLength(2);
      expect(
        crossed.find((observation) =>
          observation.toolCallId === "call-delegate-0"
        )?.label.confidentiality,
      ).toEqual([SECRET]);
      expect(
        crossed.find((observation) =>
          observation.toolCallId === "call-delegate-1"
        )?.label.confidentiality,
      ).toEqual(["public"]);
      expect(confidentialityOf(result.runState.cfcModelContext?.label))
        .toEqual(expect.arrayContaining([SECRET, "public"]));
    });
  });
});

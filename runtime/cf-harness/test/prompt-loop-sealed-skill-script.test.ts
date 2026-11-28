import { expect } from "@std/expect";
import { join } from "@std/path";
import { normalize } from "@std/path/posix";

import { describe, it } from "@commonfabric/test-support/test";

import type { PromptSlotBinding } from "../src/contracts/prompt-slot.ts";
import type { HarnessSkillActivations } from "../src/contracts/skill.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import type {
  ProcessRunner,
  ProcessRunRequest,
  ProcessRunResult,
} from "../src/sandbox/process-runner.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import { discoverHarnessSkills } from "../src/skills/registry.ts";
import { directPromptSlotBindingFor } from "./support/prompt-slot-binding.ts";
import { responsesBodyFromChatFixture } from "./support/responses-fixture.ts";

const SKILL = "sealed-demo";
const SCRIPT = "scripts/count.sh";

/** A prompt slot whose text is quoted rather than commanded. */
const quoteBinding = (subject: string): PromptSlotBinding => ({
  ...directPromptSlotBindingFor(subject),
  role: "quote",
});

/** One `runsc run`: its arguments, and from its spec, command and mounts. */
interface RecordedStart {
  args: string[];
  argv: string[];
  mounts: Array<{ destination: string; type: string }>;
}

/**
 * Stands in for the host's process runner and runs nothing. For each `runsc
 * run` it keeps the arguments, and the command and mounts the container was
 * to have, read from the bundle's spec while the bundle still exists.
 */
class RecordingRunner implements ProcessRunner {
  readonly starts: RecordedStart[] = [];

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    const args = request.args ?? [];
    const bundleAt = args.indexOf("--bundle");
    if (request.command === "/bin/sh" && bundleAt !== -1) {
      const spec = JSON.parse(
        await Deno.readTextFile(`${args[bundleAt + 1]}/config.json`),
      ) as {
        process: { args: string[] };
        mounts: Array<{ destination: string; type: string }>;
      };
      this.starts.push({
        args: [...args],
        argv: spec.process.args,
        mounts: spec.mounts,
      });
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  /** The containers started to run the skill script, not the run's probes. */
  scriptStarts(): RecordedStart[] {
    return this.starts.filter((start) => start.argv[0] === "bash");
  }
}

/** A sandbox that describes itself as `describe`, and records its runs. */
class FakeSandboxRuntime implements SandboxRuntime {
  readonly runs: SandboxCommandRequest[] = [];
  closed = false;

  constructor(
    readonly cfc: SandboxRuntimeDescription["cfc"] = {
      runtimeRequested: true,
      workspaceMountPath: "/workspace",
    },
  ) {}

  describe(): SandboxRuntimeDescription {
    return {
      kind: "runsc-cfc",
      defaultWorkingDirectory: "/workspace",
      cfc: this.cfc,
    };
  }
  resolvePath(path: string, cwd = "/workspace"): string {
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
  run(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    this.runs.push(request);
    return Promise.resolve({ stdout: "3\n", stderr: "", exitCode: 0 });
  }
  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

/**
 * Runs one prompt under `binding` whose model calls `run_skill_script` on a
 * registry skill once with `callArgs` beside skill and path, over the engine
 * `engineFor` builds. Returns the tool message the model read back, parsed.
 */
const scriptCallOutcome = async (
  runId: string,
  binding: PromptSlotBinding,
  engineFor: (
    workspace: string,
  ) => ConstructorParameters<typeof CfHarnessEngine>[0],
  callArgs: Record<string, unknown> = {},
): Promise<Record<string, unknown>> => {
  const workspace = await Deno.makeTempDir({ prefix: "cf-harness-sealed-" });
  try {
    const skillDir = join(workspace, "skills", SKILL);
    await Deno.mkdir(join(skillDir, "scripts"), { recursive: true });
    await Deno.writeTextFile(
      join(skillDir, "SKILL.md"),
      ["---", `name: ${SKILL}`, "description: Count things", "---"].join("\n"),
    );
    await Deno.writeTextFile(
      join(skillDir, SCRIPT),
      "#!/usr/bin/env bash\nwc -l\n",
    );
    const registry = await discoverHarnessSkills({
      skillsRoot: join(workspace, "skills"),
      sandboxSkillsRoot: "/workspace/skills",
    });
    const skill = registry.skills[0];
    const activations: HarnessSkillActivations = {
      type: "cf-harness.skill-activations",
      version: 1,
      generatedAt: "2026-11-28T00:00:00.000Z",
      activations: [{
        name: skill.name,
        source: "cli-preload",
        runId,
        skillPath: skill.skillPath,
        skillDir: skill.skillDir,
        sandboxSkillPath: skill.sandboxSkillPath,
        sandboxSkillDir: skill.sandboxSkillDir,
        digest: skill.digest,
        activatedAt: "2026-11-28T00:00:00.000Z",
        cfcPromptRole: "context",
      }],
    };
    const engine = new CfHarnessEngine({
      ...engineFor(workspace),
      runId,
      model: "gpt-5.4",
      skillsRoot: join(workspace, "skills"),
      allowedSkillScripts: [{ skill: SKILL, path: SCRIPT }],
    });
    await engine.persistSkillRegistry(registry);
    await engine.persistSkillActivations(activations);
    const bodies: unknown[] = [];
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      allowedToolIds: ["run_skill_script"],
      engine,
      fetchFn: (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        const payload = bodies.length === 1
          ? {
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{
                  id: "call-script",
                  type: "function",
                  function: {
                    name: "run_skill_script",
                    arguments: JSON.stringify({
                      skill: SKILL,
                      path: SCRIPT,
                      ...callArgs,
                    }),
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
      },
    });
    const result = await loop.runPrompt({
      prompt: "Count the lines.",
      promptSlotBinding: binding,
    });
    const toolMessage = result.transcript.find((message) =>
      message.role === "tool"
    );
    expect(toolMessage).toBeDefined();
    return JSON.parse(String(toolMessage?.content));
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
};

const runscEngineOptions = (
  runner: ProcessRunner,
  cfcEnforcementMode: "observe" | "enforce-explicit" | "enforce-strict",
) =>
(workspace: string): ConstructorParameters<typeof CfHarnessEngine>[0] => ({
  workspaceHostPath: workspace,
  // Where the CLI puts it by default: inside the workspace.
  artifactRoot: join(workspace, ".cf-harness-artifacts"),
  sandboxRuntimeKind: "runsc",
  sandboxRunscBinary: "/opt/runsc",
  sandboxRootfs: "/images/kitchensink",
  sandboxCfcPolicy: "/policy.json",
  cfcEnforcementMode,
  processRunner: runner,
});

/** A sealed runtime's description: no network, nothing writable. */
const SEALED_CFC: SandboxRuntimeDescription["cfc"] = {
  runtimeRequested: true,
  workspaceMountPath: "/workspace",
  networkMode: "none",
  mounts: [{ kind: "workspace", sandboxPath: "/workspace", readOnly: true }],
};

describe("prompt-loop-sealed-skill-script", () => {
  describe("a runsc run", () => {
    it("runs a quoted call's script in a container with no network under enforce-explicit", async () => {
      const runner = new RecordingRunner();
      const result = await scriptCallOutcome(
        "run-sealed-explicit",
        quoteBinding("sealed-explicit"),
        runscEngineOptions(runner, "enforce-explicit"),
      );

      expect(result.status).toBe("executed");
      // The image's host path is the record's alone.
      expect(result.sealed).toEqual({ networkMode: "none" });
      const [start] = runner.scriptStarts();
      expect(start).toBeDefined();
      expect(start.args).toContain("--network=none");
      expect(start.args).not.toContain("--network=sandbox");
    });

    it("hides the run's artifact root from a sealed script", async () => {
      // No model-facing tool may read the artifact root, and the workspace
      // a sealed script reads holds it.

      const runner = new RecordingRunner();
      await scriptCallOutcome(
        "run-sealed-artifacts",
        quoteBinding("sealed-artifacts"),
        runscEngineOptions(runner, "enforce-explicit"),
      );
      const [start] = runner.scriptStarts();
      expect(start.mounts).toContainEqual(
        expect.objectContaining({
          destination: "/workspace/.cf-harness-artifacts",
          type: "tmpfs",
        }),
      );
    });

    it("refuses a quoted call's script under enforce-strict, starting no container", async () => {
      const runner = new RecordingRunner();
      const result = await scriptCallOutcome(
        "run-sealed-strict",
        quoteBinding("sealed-strict"),
        runscEngineOptions(runner, "enforce-strict"),
      );
      expect(result.reason).toBe("not-authorized");
      expect(runner.scriptStarts()).toEqual([]);
    });

    it("refuses a quoted call that names its own working directory, which is a side effect", async () => {
      const runner = new RecordingRunner();
      const result = await scriptCallOutcome(
        "run-sealed-cwd",
        quoteBinding("sealed-cwd"),
        runscEngineOptions(runner, "enforce-explicit"),
        { cwd: "/workspace" },
      );
      expect(result.reason).toBe("not-authorized");
      expect(result.detail).toBe(
        "run_skill_script requires direct-command authorization in enforce-explicit",
      );
      expect(runner.scriptStarts()).toEqual([]);
    });

    it("runs a direct command's script on the run's own network, with no cwd named", async () => {
      const runner = new RecordingRunner();
      const result = await scriptCallOutcome(
        "run-sealed-direct",
        directPromptSlotBindingFor("sealed-direct"),
        runscEngineOptions(runner, "enforce-explicit"),
      );
      const [start] = runner.scriptStarts();
      expect(start).toBeDefined();
      expect(start.args).toContain("--network=sandbox");
      expect(result.sealed).toBeUndefined();
    });

    it("runs a quoted call's script on the run's own network in observe mode, which admits it", async () => {
      const runner = new RecordingRunner();
      const result = await scriptCallOutcome(
        "run-sealed-observe",
        quoteBinding("sealed-observe"),
        runscEngineOptions(runner, "observe"),
      );
      const [start] = runner.scriptStarts();
      expect(start).toBeDefined();
      expect(start.args).toContain("--network=sandbox");
      expect(result.sealed).toBeUndefined();
    });

    it("refuses a quoted call whose cwd is null, as one that names a cwd", async () => {
      const runner = new RecordingRunner();
      const result = await scriptCallOutcome(
        "run-sealed-null-cwd",
        quoteBinding("sealed-null-cwd"),
        runscEngineOptions(runner, "enforce-explicit"),
        { cwd: null },
      );
      expect(result.reason).toBe("not-authorized");
      expect(runner.scriptStarts()).toEqual([]);
    });
  });

  describe("a run handed its sandbox runtime", () => {
    it("refuses a quoted call's script when it was given no sealed runtime", async () => {
      const sandbox = new FakeSandboxRuntime();
      const result = await scriptCallOutcome(
        "run-sealed-none",
        quoteBinding("sealed-none"),
        () => ({
          sandboxRuntime: sandbox,
          cfcEnforcementMode: "enforce-explicit",
        }),
      );
      expect(result.reason).toBe("not-authorized");
      expect(sandbox.runs).toEqual([]);
    });

    it("runs a quoted call's script on the sealed runtime, from its read-only workspace, and closes it", async () => {
      const sandbox = new FakeSandboxRuntime();
      const sealed = new FakeSandboxRuntime(SEALED_CFC);
      const result = await scriptCallOutcome(
        "run-sealed-given",
        quoteBinding("sealed-given"),
        () => ({
          sandboxRuntime: sandbox,
          sealedSandboxRuntime: () => sealed,
          cfcEnforcementMode: "enforce-explicit",
        }),
      );
      expect(result.reason).toBe("not-observable");
      expect(sandbox.runs).toEqual([]);
      expect(sealed.runs.map((run) => run.cwd)).toEqual(["/workspace"]);
      expect(sealed.closed).toBe(true);
      // The quoted slot influenced every input, the script on stdin included.
      const paths = sealed.runs[0].cfcInvocationContext
        ?.promptSlotInfluenceLabels
        ?.entries.map((entry) => entry.path);
      expect(paths).toContainEqual(["argv"]);
      expect(paths).toContainEqual(["stdin"]);
    });

    it("returns an error, running nothing, when the sealed runtime describes a network", async () => {
      const sealed = new FakeSandboxRuntime({
        ...SEALED_CFC,
        networkMode: "sandbox",
      });
      const result = await scriptCallOutcome(
        "run-sealed-leaky",
        quoteBinding("sealed-leaky"),
        () => ({
          sandboxRuntime: new FakeSandboxRuntime(),
          sealedSandboxRuntime: () => sealed,
          cfcEnforcementMode: "enforce-explicit",
        }),
      );
      expect(result.status).toBe("error");
      expect((result.error as { code?: string }).code).toBe(
        "permission_denied",
      );
      expect(sealed.runs).toEqual([]);
      expect(sealed.closed).toBe(true);
    });

    it("returns an error, running nothing, when the sealed runtime mounts something writable", async () => {
      const sealed = new FakeSandboxRuntime({
        ...SEALED_CFC,
        mounts: [{
          kind: "workspace",
          sandboxPath: "/workspace",
          readOnly: false,
        }],
      });
      const result = await scriptCallOutcome(
        "run-sealed-writable",
        quoteBinding("sealed-writable"),
        () => ({
          sandboxRuntime: new FakeSandboxRuntime(),
          sealedSandboxRuntime: () => sealed,
          cfcEnforcementMode: "enforce-explicit",
        }),
      );
      expect((result.error as { message?: string }).message).toBe(
        "a sealed skill-script run mounts nothing it can write, and its runtime mounts /workspace writable",
      );
      expect(sealed.runs).toEqual([]);
    });
  });
});

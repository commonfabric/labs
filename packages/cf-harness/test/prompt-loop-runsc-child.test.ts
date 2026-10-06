/**
 * What a prompt loop over the direct runsc runtime gives the runs it starts
 * and the tools it offers, checked through the loop itself.
 *
 * `childSandboxOptions` and `acquiredSkillScriptBacking` are each tested by
 * direct call. What those tests cannot show is that the loop hands them the
 * runsc configuration at all: a loop that did not would give a runsc child
 * its parent's runtime, sessions included, and would offer no skill script
 * tool to a run that mounts a skill.
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";

import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import {
  HARNESS_ACQUIRED_SKILLS_TYPE,
  type HarnessAcquiredSkill,
  type HarnessAcquiredSkills,
} from "../src/contracts/skill.ts";
import type {
  ProcessRunner,
  ProcessRunRequest,
  ProcessRunResult,
} from "../src/sandbox/process-runner.ts";
import { ACQUIRED_SKILL_MOUNT_NAME } from "../src/skills/acquired-skill-mount.ts";
import { directPromptSlotBindingFor } from "./support/prompt-slot-binding.ts";
import { responsesBodyFromChatFixture } from "./support/responses-fixture.ts";

/** One `runsc run`: where its bundle was, and what it was asked to run. */
interface RecordedRun {
  bundleDir: string;
  stateRoot: string;
  containerId: string;
  argv: string[];
}

/**
 * Stands in for the host's process runner. It runs nothing; for each
 * `runsc run` it notes the bundle the runtime wrote and reads, from that
 * bundle's spec, the command the container was to run. The bundle is gone
 * once the call returns, so it is read here.
 */
class RecordingRunner implements ProcessRunner {
  readonly runs: RecordedRun[] = [];

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    const args = request.args ?? [];
    const bundleAt = args.indexOf("--bundle");
    if (request.command === "/bin/sh" && bundleAt !== -1) {
      const bundleDir = args[bundleAt + 1];
      const spec = JSON.parse(
        await Deno.readTextFile(`${bundleDir}/config.json`),
      ) as { process: { args: string[] } };
      this.runs.push({
        bundleDir,
        stateRoot: args[args.indexOf("--root") + 1],
        containerId: args[bundleAt + 2],
        argv: spec.process.args,
      });
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  /** The runs whose command line mentions `text`. */
  running(text: string): RecordedRun[] {
    return this.runs.filter((run) =>
      run.argv.some((arg) => arg.includes(text))
    );
  }
}

const toolCallTurn = (
  id: string,
  name: string,
  args: Record<string, unknown>,
) => ({
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      }],
    },
  }],
});

const finalTurn = (content: string) => ({
  choices: [{ index: 0, message: { role: "assistant", content } }],
});

/** Serves `payloads` in order and keeps each request's body. */
const scriptedFetch = (
  payloads: readonly unknown[],
  bodies: Array<{ tools?: Array<{ name?: string }> }> = [],
): typeof fetch =>
(_input, init) => {
  const payload = payloads[bodies.length];
  bodies.push(JSON.parse(String(init?.body)));
  if (payload === undefined) {
    throw new Error("scripted fetch ran out of payloads");
  }
  return Promise.resolve(
    new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
      status: 200,
    }),
  );
};

const runscEngine = (
  runId: string,
  runner: ProcessRunner,
  extra: Partial<ConstructorParameters<typeof CfHarnessEngine>[0]> = {},
): CfHarnessEngine =>
  new CfHarnessEngine({
    runId,
    model: "gpt-5.4",
    workspaceHostPath: "/host/project",
    sandboxRuntimeKind: "runsc",
    sandboxRunscBinary: "/opt/runsc",
    sandboxRootfs: "/images/kitchensink",
    // No policy is configured, so the run is not an enforcing one.
    cfcEnforcementMode: "observe",
    processRunner: runner,
    ...extra,
  });

Deno.test("a child of a runsc run gets a sandbox of its own, not its parent's", async () => {
  const runner = new RecordingRunner();
  const engine = runscEngine("run-runsc-parent", runner);
  const parentConfig = engine.ownedRunscSandboxConfig;
  assert(parentConfig !== undefined);
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine,
    maxModelTurns: 6,
    // The child's turns are served between the parent's, the order the two
    // loops call the provider in.
    fetchFn: scriptedFetch([
      toolCallTurn("call-parent-before", "bash", {
        command: "echo from-parent-before",
      }),
      toolCallTurn("call-delegate", "delegate_task", {
        goal: "Inspect the workspace and report.",
        maxModelTurns: 4,
      }),
      toolCallTurn("call-child-bash", "bash", { command: "echo from-child" }),
      finalTurn("Child done."),
      toolCallTurn("call-parent-after", "bash", {
        command: "echo from-parent-after",
      }),
      finalTurn("Parent done."),
    ]),
  });

  const result = await loop.runPrompt({
    prompt: "Delegate the inspection.",
    promptSlotBinding: directPromptSlotBindingFor("runsc-child"),
  });

  assertEquals(result.finalAssistantText, "Parent done.");
  assertEquals(result.runState.status, "completed");
  assertEquals(
    result.runState.subagentRuns?.map((run) => [run.childRunId, run.status]),
    [["run-runsc-parent.subagent.1", "completed"]],
  );

  const [before] = runner.running("from-parent-before");
  const [child] = runner.running("from-child");
  const [after] = runner.running("from-parent-after");
  assert(before !== undefined, "the parent's first command never ran");
  assert(child !== undefined, "the child's command never ran");
  assert(after !== undefined, "the parent's second command never ran");

  // The parent's calls are the parent's runtime's: under its scratch
  // directory, against its state root.
  const parentScratch = `${parentConfig.scratchDir}/`;
  assert(before.bundleDir.startsWith(parentScratch), before.bundleDir);
  assert(after.bundleDir.startsWith(parentScratch), after.bundleDir);
  assertEquals(before.stateRoot, `${parentConfig.scratchDir}/state`);
  assertEquals(after.stateRoot, before.stateRoot);

  // The child's call is not. A runtime is one scratch directory and one
  // state root, so a different pair is a different runtime: the child's
  // sessions are kept in containers the parent's runtime does not know, and
  // the child ending closes a sandbox that is not the parent's.
  assert(!child.bundleDir.startsWith(parentScratch), child.bundleDir);
  assertNotEquals(child.stateRoot, before.stateRoot);
  // Container ids carry the run they belong to.
  const runTag = (id: string) => id.split("-").slice(1, -1).join("-");
  assertEquals(runTag(after.containerId), runTag(before.containerId));
  assertNotEquals(runTag(child.containerId), runTag(before.containerId));

  // And the parent's runtime was still open for its second command after
  // the child ended: a closed runtime refuses the call before it reaches the
  // runner.
  assert(runner.runs.indexOf(after) > runner.runs.indexOf(child));
});

const acquired: HarnessAcquiredSkill = {
  registryId: "example/skills/finance-budget",
  commitSha: "dd93980e2f9a1d4c4d50a6e1a3cbb6e2b7a91f3c",
  pin: "example/skills/finance-budget@dd93980e2f9a1d4c4d50a6e1a3cbb6e2b7a91f3c",
  hostRoot: "/artifacts/run.acquired-skills/dd93980e/finance-budget",
  sandboxRoot: "/acquired-skill",
  scripts: [],
};

/**
 * A runsc engine with no skills root, which is a harness running outside a
 * checkout. Inside one the checkout's own `skills/` is every run's default
 * root, the registry backs `run_skill_script` by itself, and the second
 * backing, the one under test, can never be what decides. No option turns
 * the default off, so the resolved configuration is edited after the fact;
 * the assertion is there so this fails loudly if that stops working.
 */
const runscEngineOutsideACheckout = (
  runId: string,
  extra: Partial<ConstructorParameters<typeof CfHarnessEngine>[0]>,
): CfHarnessEngine => {
  const engine = runscEngine(runId, new RecordingRunner(), extra);
  const config = engine.config as {
    skillsRoot?: string;
    skillsRootRecord?: unknown;
  };
  delete config.skillsRoot;
  delete config.skillsRootRecord;
  assertEquals(engine.config.skillsRoot, undefined);
  return engine;
};

/** The tool names a one-turn run over `engine` offers the model. */
const toolsOffered = async (engine: CfHarnessEngine): Promise<string[]> => {
  const bodies: Array<{ tools?: Array<{ name?: string }> }> = [];
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine,
    // Asked for by name: `run_skill_script` is never in the default surface,
    // and asking is not enough. A run offers it only when it can back it.
    allowedToolIds: ["bash", "run_skill_script"],
    fetchFn: scriptedFetch([finalTurn("done")], bodies),
  });
  const result = await loop.runPrompt({
    prompt: "Say done.",
    promptSlotBinding: directPromptSlotBindingFor("runsc-skill-backing"),
  });
  assertEquals(result.runState.status, "completed");
  assertEquals(bodies.length, 1);
  return (bodies[0].tools ?? []).map((tool) => String(tool.name));
};

Deno.test("a runsc run that mounts an acquired skill is offered the skill script tool", async () => {
  const acquiredSkills: HarnessAcquiredSkills = {
    type: HARNESS_ACQUIRED_SKILLS_TYPE,
    version: 1,
    generatedAt: "2026-09-14T00:00:00.000Z",
    skills: [acquired],
  };
  const mounted = runscEngineOutsideACheckout("run-runsc-skill", {
    acquiredSkills,
    additionalMounts: [{
      kind: "host-bind",
      name: ACQUIRED_SKILL_MOUNT_NAME,
      hostPath: acquired.hostRoot,
      sandboxPath: acquired.sandboxRoot,
      readOnly: true,
    }],
  });
  assertEquals(await toolsOffered(mounted), ["bash", "run_skill_script"]);

  // The same run holding the skill without mounting it has nothing to run a
  // script of, so the tool above was offered for the mount and not for the
  // asking.
  const unmounted = runscEngineOutsideACheckout("run-runsc-no-skill", {
    acquiredSkills,
  });
  assertEquals(await toolsOffered(unmounted), ["bash"]);
});

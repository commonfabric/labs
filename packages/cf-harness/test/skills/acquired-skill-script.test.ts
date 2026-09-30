import { join, normalize } from "@std/path";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { createHarnessCfcInvocationContext } from "../../src/contracts/cfc-invocation-context.ts";
import { skillsShValueDigest } from "../../src/skills-sh/acquisition.ts";
import {
  discoverHarnessSkills,
  loadHarnessSkillContext,
} from "../../src/skills/registry.ts";
import type {
  HarnessAcquiredSkill,
  HarnessSkillAcquisition,
  HarnessSkillActivations,
  HarnessSkillScriptExecution,
} from "../../src/contracts/skill.ts";
import type { ProcessRunner } from "../../src/sandbox/process-runner.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxRuntimeMountDescription,
  SandboxShellRequest,
} from "../../src/sandbox/types.ts";
import { runSkillScriptTool } from "../../src/tools/run-skill-script.ts";
import type { HarnessToolContext } from "../../src/tools/types.ts";
import { createToolOutputId } from "../../src/contracts/tool-result.ts";

const REGISTRY_ID = "zubair-trabzada/ai-finance-claude/finance-budget";
const COMMIT_SHA = "dd93980e2f9a1d4c4d50a6e1a3cbb6e2b7a91f3c";
const PIN = `${REGISTRY_ID}@${COMMIT_SHA}`;
const SCRIPT_PATH = "scripts/report.sh";
const SCRIPT_TEXT = "#!/usr/bin/env bash\necho acquired\n";
const SANDBOX_ROOT = "/acquired-skill";

// The digest as the ACQUISITION computes it, which is the only thing the
// execution's re-check may be compared against: the two sources encode a
// SHA-256 differently, and an encoding is part of a digest rather than a
// presentation of it.
const acquisitionDigest = (text: string): string =>
  skillsShValueDigest(new TextEncoder().encode(text));

class RecordingSandboxRuntime implements SandboxRuntime {
  readonly calls: SandboxCommandRequest[] = [];
  readonly #mounts: readonly SandboxRuntimeMountDescription[];

  constructor(mounts: readonly SandboxRuntimeMountDescription[] = []) {
    this.#mounts = mounts;
  }

  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: "/workspace",
      cfc: {
        runtimeRequested: true,
        workspaceMountPath: "/workspace",
        mounts: this.#mounts,
      },
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
    this.calls.push(request);
    return Promise.resolve({ stdout: "acquired\n", stderr: "", exitCode: 0 });
  }

  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    throw new Error("the acquired-script path does not use the sandbox shell");
  }
}

const unusedProcessRunner: ProcessRunner = {
  run() {
    throw new Error("the acquired-script path does not run host processes");
  },
};

const acquisition = (): HarnessSkillAcquisition => ({
  registryId: REGISTRY_ID,
  commitSha: COMMIT_SHA,
  sourceUrl: `https://skills.sh/${REGISTRY_ID}@${COMMIT_SHA}/SKILL.md`,
  verification: "git-commit-sha",
  valueDigest: "sha256:instructions",
  receivedAt: "2026-09-14T00:00:00.000Z",
});

const activationsHoldingTheAcquiredSkill = (): HarnessSkillActivations => ({
  type: "cf-harness.skill-activations",
  version: 1,
  generatedAt: "2026-09-14T00:00:00.000Z",
  activations: [{
    name: "handle:cfh:a:f4ecd",
    source: "skill-handle",
    runId: "run-1",
    digest: "sha256:instructions",
    activatedAt: "2026-09-14T00:00:00.000Z",
    cfcPromptRole: "context",
    handleToken: "cfh:a:f4ecd",
    acquisition: acquisition(),
  }],
});

interface ContextOptions {
  allowSkillScripts?: boolean;
  sandbox: SandboxRuntime;
  skillScriptExecutionTarget?: "sandbox" | "host";
  executions: HarnessSkillScriptExecution[];
  acquiredSkills?: readonly HarnessAcquiredSkill[];
  skillActivations?: HarnessSkillActivations;
  allowedSkillScripts?: readonly { skill: string; path: string }[];
}

const createContext = (options: ContextOptions): HarnessToolContext => {
  let sequence = 0;
  return {
    runId: "run-1",
    cfcEnforcementMode: "observe",
    workspaceHostPath: "/tmp/cf-harness-workspace",
    skillActivations: options.skillActivations,
    allowSkillScripts: options.allowSkillScripts,
    allowedSkillScripts: options.allowedSkillScripts,
    acquiredSkills: options.acquiredSkills,
    skillScriptExecutionTarget: options.skillScriptExecutionTarget ?? "sandbox",
    currentDir: "/workspace",
    sandbox: options.sandbox,
    hostProcessRunner: unusedProcessRunner,
    resolvePath: (path) => options.sandbox.resolvePath(path, "/workspace"),
    resolveHostPath: (path) => `/tmp/cf-harness-workspace${path}`,
    resolveHostRootPath: () => "/tmp/cf-harness-workspace",
    hostPathToWorkspacePath: () => undefined,
    isHostPathWithinWorkspace: () => Promise.resolve(true),
    isHostPathWithinArtifactRoot: () => Promise.resolve(false),
    doesHostPathIntersectArtifactRoot: () => Promise.resolve(false),
    setCurrentDir: () => {},
    nextOutputId(toolId) {
      sequence += 1;
      return createToolOutputId("run-1", toolId, sequence);
    },
    now: () => "2026-09-14T00:00:00.000Z",
    recordSkillResourceRead: () => Promise.resolve(),
    recordSkillScriptExecution(execution) {
      options.executions.push(execution);
      return Promise.resolve();
    },
    createCfcInvocationContext: (invocation) =>
      Promise.resolve(createHarnessCfcInvocationContext({
        sequence: 1,
        runId: "run-1",
        createdAt: "2026-09-14T00:00:00.000Z",
        cfcEnforcementMode: "observe",
        runManifest: { present: false },
        ...invocation,
      })),
  };
};

describe("run_skill_script on an acquired skill's script", () => {
  //
  // An acquired skill has no registry name, no registry directory and no
  // run-start snapshot. What it has is the pin its bytes were read at, and
  // every gate a registry script passes is asked of the pin instead: the
  // operator's allowlist keys on it, the activation is found by it, and the
  // digest the file is re-checked against is the one taken when those bytes
  // arrived.
  //

  let hostRoot: string;
  let scriptDigest: string;
  let executions: HarnessSkillScriptExecution[];
  let sandbox: RecordingSandboxRuntime;

  const acquiredSkill = (): HarnessAcquiredSkill => ({
    registryId: REGISTRY_ID,
    commitSha: COMMIT_SHA,
    pin: PIN,
    hostRoot,
    sandboxRoot: SANDBOX_ROOT,
    scripts: [{
      path: SCRIPT_PATH,
      hostPath: join(hostRoot, SCRIPT_PATH),
      sandboxPath: `${SANDBOX_ROOT}/${SCRIPT_PATH}`,
      valueDigest: scriptDigest,
      sizeBytes: new TextEncoder().encode(SCRIPT_TEXT).byteLength,
    }],
  });

  // The mount a `delegate_task` child is given for the skill its handle names.
  // The tool asks the sandbox it is about to run in whether it carries this,
  // so a fake without it is a run with nothing at `/acquired-skill` to run.
  const acquiredSkillMount = (): SandboxRuntimeMountDescription => ({
    kind: "host-bind",
    name: "acquired-skill",
    hostPath: hostRoot,
    sandboxPath: SANDBOX_ROOT,
    readOnly: true,
  });

  beforeEach(async () => {
    hostRoot = await Deno.makeTempDir({ prefix: "cf-harness-acquired-" });
    await Deno.mkdir(join(hostRoot, "scripts"), { recursive: true });
    await Deno.writeTextFile(join(hostRoot, SCRIPT_PATH), SCRIPT_TEXT);
    scriptDigest = acquisitionDigest(SCRIPT_TEXT);
    executions = [];
    sandbox = new RecordingSandboxRuntime([acquiredSkillMount()]);
  });

  afterEach(async () => {
    await Deno.remove(hostRoot, { recursive: true });
  });

  it("runs the script the pin names, from the mount the child holds", async () => {
    const output = await runSkillScriptTool.invoke(
      createContext({
        sandbox,
        executions,
        acquiredSkills: [acquiredSkill()],
        skillActivations: activationsHoldingTheAcquiredSkill(),
        allowedSkillScripts: [{ skill: PIN, path: SCRIPT_PATH }],
      }),
      { skill: PIN, path: SCRIPT_PATH },
    );

    expect(output.status).toBe("executed");
    expect(output.runtime).toBe("shebang");
    expect(output.argv).toEqual(["bash", "-s", "--"]);
    expect(output.stdout).toBe("acquired\n");
    expect(output.sandboxResourcePath).toBe(`${SANDBOX_ROOT}/${SCRIPT_PATH}`);
    expect(sandbox.calls.length).toBe(1);
    expect(sandbox.calls[0]?.stdinText).toBe(SCRIPT_TEXT);
    expect(sandbox.calls[0]?.env).toEqual({
      CF_HARNESS_RUN_ID: "run-1",
      SKILL_NAME: PIN,
      SKILL_DIR: SANDBOX_ROOT,
      SKILL_SCRIPT: `${SANDBOX_ROOT}/${SCRIPT_PATH}`,
      CF_HARNESS_SKILL_SCRIPT_EXECUTION_TARGET: "sandbox",
    });
  });

  for (const registryPresent of [false, true]) {
    for (
      const { description, skill } of [
        { description: "frontmatter name", skill: "finance-budget" },
        { description: "handle token", skill: "cfh:a:f4ecd" },
      ]
    ) {
      it(`explains the pin when a ${description} misses an ${registryPresent ? "empty" : "absent"} registry`, async () => {
        const output = await runSkillScriptTool.invoke(
          {
            ...createContext({
              sandbox,
              executions,
              acquiredSkills: [acquiredSkill()],
              skillActivations: activationsHoldingTheAcquiredSkill(),
              allowedSkillScripts: [{ skill: PIN, path: SCRIPT_PATH }],
            }),
            skillRegistry: registryPresent
              ? await discoverHarnessSkills({ skillsRoot: hostRoot })
              : undefined,
          },
          { skill, path: SCRIPT_PATH },
        );

        expect(output.status).toBe("error");
        expect(output.error?.code).toBe(
          registryPresent ? "skill_not_found" : "skill_registry_missing",
        );
        expect(output.error?.message).toContain("owner/repo/slug@<commit sha>");
        expect(output.error?.message).toContain("skill_context");
        expect(output.error?.message).not.toContain("--skills-root");
        expect(sandbox.calls).toHaveLength(0);
      });
    }
  }

  it("runs a configured skill by name while holding an acquired skill", async () => {
    const skillDir = join(hostRoot, "configured");
    await Deno.mkdir(join(skillDir, "scripts"), { recursive: true });
    await Deno.writeTextFile(
      join(skillDir, "SKILL.md"),
      "---\nname: finance-budget\ndescription: Report a budget\n---\n",
    );
    await Deno.writeTextFile(join(skillDir, SCRIPT_PATH), SCRIPT_TEXT);
    const registry = await discoverHarnessSkills({
      skillsRoot: hostRoot,
      sandboxSkillsRoot: "/workspace/skills",
    });
    const registeredContext = await loadHarnessSkillContext({
      registry,
      skillNames: ["finance-budget"],
      source: "cli-preload",
      runId: "run-1",
    });
    const output = await runSkillScriptTool.invoke(
      {
        ...createContext({
          sandbox,
          executions,
          acquiredSkills: [acquiredSkill()],
          skillActivations: {
            ...registeredContext.activations,
            activations: [
              ...registeredContext.activations.activations,
              ...activationsHoldingTheAcquiredSkill().activations,
            ],
          },
          allowedSkillScripts: [{ skill: "finance-budget", path: SCRIPT_PATH }],
        }),
        skillRegistry: registry,
      },
      { skill: "finance-budget", path: SCRIPT_PATH },
    );

    expect(output.status).toBe("executed");
    expect(output.skill).toBe("finance-budget");
    expect(output.acquisition).toBeUndefined();
    expect(output.digestMatchesRegistry).toBe(true);
    expect(sandbox.calls).toHaveLength(1);
  });

  it("refuses a pin this run acquired nothing at", async () => {
    const output = await runSkillScriptTool.invoke(
      createContext({
        sandbox,
        executions,
        acquiredSkills: [],
        skillActivations: activationsHoldingTheAcquiredSkill(),
        allowedSkillScripts: [{ skill: PIN, path: SCRIPT_PATH }],
      }),
      { skill: PIN, path: SCRIPT_PATH },
    );

    expect(output.status).toBe("error");
    expect(output.error?.code).toBe("skill_not_found");
    expect(sandbox.calls.length).toBe(0);
  });

  it("refuses a run that holds the skill but whose sandbox does not mount it", async () => {
    // The parent that acquired the skill, and a child sharing a handed-in
    // sandbox runtime, both reach this: the bytes exist and the run knows the
    // pin, but nothing put them at a path the sandbox can address. Without
    // this, such a run passes every other gate and records `executed` with the
    // acquisition's full provenance for a script that never ran.
    const mountless = new RecordingSandboxRuntime();
    const output = await runSkillScriptTool.invoke(
      createContext({
        sandbox: mountless,
        executions,
        acquiredSkills: [acquiredSkill()],
        skillActivations: activationsHoldingTheAcquiredSkill(),
        allowedSkillScripts: [{ skill: PIN, path: SCRIPT_PATH }],
      }),
      { skill: PIN, path: SCRIPT_PATH },
    );

    expect(output.status).toBe("error");
    expect(output.error?.code).toBe("script_not_mounted");
    expect(output.error?.message).toContain(SANDBOX_ROOT);
    expect(mountless.calls.length).toBe(0);
    expect(executions.at(-1)?.status).toBe("error");
  });

  it("refuses a mount that carries another skill's bytes under the same name", async () => {
    // The name alone is a coincidence rather than a backing: an operator
    // `--host-mount` called `acquired-skill` over some other directory would
    // otherwise stand in for the mount the acquisition made.
    const elsewhere = new RecordingSandboxRuntime([{
      kind: "host-bind",
      name: "acquired-skill",
      hostPath: `${hostRoot}-other`,
      sandboxPath: SANDBOX_ROOT,
      readOnly: true,
    }]);
    const output = await runSkillScriptTool.invoke(
      createContext({
        sandbox: elsewhere,
        executions,
        acquiredSkills: [acquiredSkill()],
        skillActivations: activationsHoldingTheAcquiredSkill(),
        allowedSkillScripts: [{ skill: PIN, path: SCRIPT_PATH }],
      }),
      { skill: PIN, path: SCRIPT_PATH },
    );

    expect(output.status).toBe("error");
    expect(output.error?.code).toBe("script_not_mounted");
    expect(elsewhere.calls.length).toBe(0);
  });

  it("refuses when no activation names the pin, however the allowlist reads", async () => {
    // Activation is what says this run was GIVEN the skill. A run that holds
    // the bytes on disk but was handed no handle to them has not been given
    // it, so a registry-shaped activation of some other name does not count.
    const output = await runSkillScriptTool.invoke(
      createContext({
        sandbox,
        executions,
        acquiredSkills: [acquiredSkill()],
        skillActivations: {
          type: "cf-harness.skill-activations",
          version: 1,
          generatedAt: "2026-09-14T00:00:00.000Z",
          activations: [{
            name: "pattern-dev",
            source: "cli-preload",
            runId: "run-1",
            digest: "sha256:other",
            activatedAt: "2026-09-14T00:00:00.000Z",
            cfcPromptRole: "context",
          }],
        },
        allowedSkillScripts: [{ skill: PIN, path: SCRIPT_PATH }],
      }),
      { skill: PIN, path: SCRIPT_PATH },
    );

    expect(output.status).toBe("error");
    expect(output.error?.code).toBe("skill_not_activated");
    expect(sandbox.calls.length).toBe(0);
  });

  it("runs an acquired script when the operator allows skill scripts", async () => {
    // The operator's one decision: no entry names this script, and it runs.
    const output = await runSkillScriptTool.invoke(
      createContext({
        sandbox,
        executions,
        acquiredSkills: [acquiredSkill()],
        skillActivations: activationsHoldingTheAcquiredSkill(),
        allowSkillScripts: true,
      }),
      { skill: PIN, path: SCRIPT_PATH },
    );

    expect(output.status).toBe("executed");
    expect(sandbox.calls.length).toBe(1);
  });

  it("refuses an acquired script when the operator allows none", async () => {
    const output = await runSkillScriptTool.invoke(
      createContext({
        sandbox,
        executions,
        acquiredSkills: [acquiredSkill()],
        skillActivations: activationsHoldingTheAcquiredSkill(),
      }),
      { skill: PIN, path: SCRIPT_PATH },
    );

    expect(output.status).toBe("error");
    expect(output.error?.code).toBe("script_not_allowlisted");
    expect(output.error?.message).toContain("does not run skill scripts");
    expect(sandbox.calls.length).toBe(0);
  });

  it("refuses a script the operator allowlisted at another commit", async () => {
    const output = await runSkillScriptTool.invoke(
      createContext({
        sandbox,
        executions,
        acquiredSkills: [acquiredSkill()],
        skillActivations: activationsHoldingTheAcquiredSkill(),
        allowedSkillScripts: [{
          skill: `${REGISTRY_ID}@${"0".repeat(40)}`,
          path: SCRIPT_PATH,
        }],
      }),
      { skill: PIN, path: SCRIPT_PATH },
    );

    expect(output.status).toBe("error");
    expect(output.error?.code).toBe("script_not_allowlisted");
    expect(sandbox.calls.length).toBe(0);
  });

  it("refuses a file the host changed after acquisition", async () => {
    await Deno.writeTextFile(
      join(hostRoot, SCRIPT_PATH),
      "#!/usr/bin/env bash\necho tampered\n",
    );

    const output = await runSkillScriptTool.invoke(
      createContext({
        sandbox,
        executions,
        acquiredSkills: [acquiredSkill()],
        skillActivations: activationsHoldingTheAcquiredSkill(),
        allowedSkillScripts: [{ skill: PIN, path: SCRIPT_PATH }],
      }),
      { skill: PIN, path: SCRIPT_PATH },
    );

    expect(output.status).toBe("error");
    expect(output.error?.code).toBe("script_snapshot_mismatch");
    expect(output.error?.message).toContain("acquired at this pin");
    expect(output.observedDigest).not.toBe(scriptDigest);
    expect(sandbox.calls.length).toBe(0);
  });

  it("refuses a script whose real path leaves the acquired skill's directory", async () => {
    // Containment is checked against the acquired root, which is the only
    // directory the child mounts. A link out of it names bytes no acquisition
    // fetched, whatever they digest to.
    const outside = await Deno.makeTempDir({ prefix: "cf-harness-outside-" });
    try {
      const escape = join(outside, "report.sh");
      await Deno.writeTextFile(escape, SCRIPT_TEXT);
      await Deno.remove(join(hostRoot, SCRIPT_PATH));
      await Deno.symlink(escape, join(hostRoot, SCRIPT_PATH));

      const output = await runSkillScriptTool.invoke(
        createContext({
          sandbox,
          executions,
          acquiredSkills: [acquiredSkill()],
          skillActivations: activationsHoldingTheAcquiredSkill(),
          allowedSkillScripts: [{ skill: PIN, path: SCRIPT_PATH }],
        }),
        { skill: PIN, path: SCRIPT_PATH },
      );

      expect(output.status).toBe("error");
      expect(output.error?.code).toBe("script_outside_root");
      expect(sandbox.calls.length).toBe(0);
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  });

  it("refuses to run an acquired script on the host, outside the sandbox", async () => {
    // The sandbox is the whole of what bounds fetched code. The host target
    // exists for the browser profile's own bundled scripts.
    const output = await runSkillScriptTool.invoke(
      createContext({
        sandbox,
        executions,
        skillScriptExecutionTarget: "host",
        acquiredSkills: [acquiredSkill()],
        skillActivations: activationsHoldingTheAcquiredSkill(),
        allowedSkillScripts: [{ skill: PIN, path: SCRIPT_PATH }],
      }),
      { skill: PIN, path: SCRIPT_PATH },
    );

    expect(output.status).toBe("error");
    expect(output.error?.code).toBe("permission_denied");
    expect(output.error?.message).toContain("runs in the sandbox");
    expect(output.acquisition).toEqual(acquisition());
    expect(sandbox.calls.length).toBe(0);
  });

  it("checks the file against the acquisition's own digest encoding", async () => {
    // The acquisition records `sha256:<unpadded base64url>` and the registry
    // snapshot records `sha256:<hex>`. Recomputing in the wrong one refuses
    // every unmodified script there is, so the encoding under test is the
    // acquisition's rather than whichever the registry path happens to use.
    expect(scriptDigest).toMatch(/^sha256:[A-Za-z0-9_-]+$/);
    expect(scriptDigest).not.toMatch(/^sha256:[0-9a-f]{64}$/);

    const output = await runSkillScriptTool.invoke(
      createContext({
        sandbox,
        executions,
        acquiredSkills: [acquiredSkill()],
        skillActivations: activationsHoldingTheAcquiredSkill(),
        allowedSkillScripts: [{ skill: PIN, path: SCRIPT_PATH }],
      }),
      { skill: PIN, path: SCRIPT_PATH },
    );

    expect(output.status).toBe("executed");
    expect(output.observedDigest).toBe(scriptDigest);
  });

  it("records the acquisition and no registry provenance", async () => {
    const output = await runSkillScriptTool.invoke(
      createContext({
        sandbox,
        executions,
        acquiredSkills: [acquiredSkill()],
        skillActivations: activationsHoldingTheAcquiredSkill(),
        allowedSkillScripts: [{ skill: PIN, path: SCRIPT_PATH }],
      }),
      { skill: PIN, path: SCRIPT_PATH },
    );

    expect(output.acquisition).toEqual(acquisition());
    expect(output.observedDigest).toBe(scriptDigest);
    expect(output.registryDigest).toBeUndefined();
    expect(output.registrySizeBytes).toBeUndefined();
    expect(output.digestMatchesRegistry).toBeUndefined();

    expect(executions.length).toBe(1);
    const record = executions[0]!;
    expect(record.skillName).toBe(PIN);
    expect(record.acquisition?.registryId).toBe(REGISTRY_ID);
    expect(record.acquisition?.commitSha).toBe(COMMIT_SHA);
    expect(record.observedDigest).toBe(scriptDigest);
    expect(record.registryDigest).toBeUndefined();
    expect(record.registrySizeBytes).toBeUndefined();
    expect(record.digestMatchesRegistry).toBeUndefined();
    expect(record.resourcePath).toBe(join(hostRoot, SCRIPT_PATH));
  });

  it("adds no integrity to the invocation, whatever a trusted caller labeled it", async () => {
    // CT-2302: a non-empty `integrity` array in `cfcInputLabels` makes the
    // sandbox fail to start, so the acquisition's ExternalIngest atom cannot
    // ride the invocation. It rides the output instead.
    //
    // The caller's own confidentiality label is passed through — that channel
    // is trusted harness plumbing, and withholding it would be a different
    // defect — so what is under test is that the ACQUIRED path contributes no
    // integrity of its own to what the caller supplied.
    await runSkillScriptTool.invoke(
      createContext({
        sandbox,
        executions,
        acquiredSkills: [acquiredSkill()],
        skillActivations: activationsHoldingTheAcquiredSkill(),
        allowedSkillScripts: [{ skill: PIN, path: SCRIPT_PATH }],
      }),
      {
        skill: PIN,
        path: SCRIPT_PATH,
        cfcInputLabels: {
          version: 1,
          entries: [{
            path: ["argv"],
            label: { confidentiality: ["finance"] },
          }],
        },
      },
    );

    const labels = sandbox.calls[0]?.cfcInvocationContext?.cfcInputLabels;
    const atoms = (labels?.entries ?? []).map((entry) => entry.label);
    expect(atoms.flatMap((label) => label.integrity ?? [])).toEqual([]);
    expect(atoms.flatMap((label) => label.confidentiality ?? []))
      .toContain("finance");
  });
});

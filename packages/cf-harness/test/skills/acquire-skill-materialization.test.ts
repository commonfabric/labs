import { join, normalize } from "@std/path";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { createFileSystemHarnessArtifactStore } from "../../src/artifacts.ts";
import { CfHarnessEngine } from "../../src/engine.ts";
import { skillsShValueDigest } from "../../src/skills-sh/acquisition.ts";
import { AcquiredSkillDirectoryReadableError } from "../../src/skills/acquired-skill-mount.ts";
import type {
  DockerRunscSandboxConfig,
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxRuntimeMountDescription,
  SandboxShellRequest,
} from "../../src/sandbox/types.ts";

const REGISTRY_ID = "zubair-trabzada/ai-finance-claude/finance-budget";
const COMMIT_SHA = "dd93980e2f9a1d4c4d50a6e1a3cbb6e2b7a91f3c";
const SCRIPT_TEXT = "#!/usr/bin/env bash\necho acquired\n";

class FakeSandboxRuntime implements SandboxRuntime {
  readonly #mounts: readonly SandboxRuntimeMountDescription[];

  // A fake stands in for the container, so what it describes is what the run
  // can read. A fake that describes no mounts answers "nothing covers this" to
  // every question asked of it, which is the one answer nothing can check.
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

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

describe("acquiring a skill's scripts outside every run root", () => {
  //
  // `acquire_skill` runs in the PARENT, so a script written where the parent's
  // sandbox can reach it is a script the planner can read. The directory sits
  // outside every run root for that reason, and the check below is what makes
  // the choice mean something rather than merely look tidy.
  //

  let workspace: string;
  let artifactRoot: string;

  const engineWith = (
    additionalMounts: DockerRunscSandboxConfig["additionalMounts"],
    root = artifactRoot,
  ) =>
    new CfHarnessEngine({
      runId: "run-1",
      // The runtime describes the configuration it was built beside, which is
      // what a real one does. The two are handed over separately here only
      // because the test supplies both.
      sandboxRuntime: new FakeSandboxRuntime([
        {
          kind: "workspace",
          hostPath: workspace,
          sandboxPath: "/workspace",
          readOnly: false,
        },
        ...additionalMounts.map((mount) => ({
          ...mount,
          sandboxPath: mount.sandboxPath ?? "/fabric",
          readOnly: mount.readOnly ?? false,
        })),
      ]),
      artifactRoot: root,
      sandbox: {
        dockerBinary: "docker",
        runtimeName: "runsc-cfc",
        image: "cf-harness:test",
        workspaceHostPath: workspace,
        workspaceMountPath: "/workspace",
        shellPath: "/bin/bash",
        dockerNetworkMode: "none",
        additionalMounts,
        extraDockerArgs: [],
      },
    });

  const oneScript = {
    registryId: REGISTRY_ID,
    commitSha: COMMIT_SHA,
    scripts: [{
      path: "scripts/report.sh",
      bytes: new TextEncoder().encode(SCRIPT_TEXT),
      valueDigest: "sha256:acquired",
    }],
  };

  beforeEach(async () => {
    workspace = await Deno.makeTempDir({ prefix: "cf-harness-workspace-" });
    artifactRoot = await Deno.makeTempDir({ prefix: "cf-harness-artifacts-" });
  });

  afterEach(async () => {
    await Deno.remove(workspace, { recursive: true });
    await Deno.remove(artifactRoot, { recursive: true });
  });

  it("writes the bytes outside the run root and records where they went", async () => {
    const engine = engineWith([]);

    const acquired = await engine.materializeAcquiredSkill(oneScript);

    expect(acquired.pin).toBe(`${REGISTRY_ID}@${COMMIT_SHA}`);
    expect(acquired.hostRoot).toBe(
      join(
        artifactRoot,
        ".acquired-skills",
        "run-1",
        COMMIT_SHA,
        "finance-budget",
      ),
    );
    const script = acquired.scripts[0]!;
    expect(script.valueDigest).toBe("sha256:acquired");
    expect(script.sandboxPath).toBe("/acquired-skill/scripts/report.sh");
    expect(await Deno.readTextFile(script.hostPath)).toBe(SCRIPT_TEXT);
    expect(script.sizeBytes).toBe(
      new TextEncoder().encode(SCRIPT_TEXT).byteLength,
    );
    // Outside the run root, so the artifact tree the parent's file tools
    // reserve does not contain it.
    expect(script.hostPath.startsWith(join(artifactRoot, "run-1/"))).toBe(
      false,
    );
    expect(engine.getRunState().acquiredSkills?.skills).toEqual([acquired]);
  });

  it("writes back the exact bytes the pin served, byte-order mark included", async () => {
    // The acquisition digests the BYTES the commit served and this writes what
    // an execution re-reads and compares against that digest, so the two have
    // to be the same bytes. A UTF-8 byte-order mark is where a decoded string
    // stops being them: it is an encoding artifact rather than a character, so
    // decoding drops it, and the digest and the size would both describe a
    // file GitHub never served — a pinned script that opens with one could
    // then never execute.
    const bytes = new Uint8Array([
      0xEF,
      0xBB,
      0xBF,
      ...new TextEncoder().encode(SCRIPT_TEXT),
    ]);
    const engine = engineWith([]);

    const acquired = await engine.materializeAcquiredSkill({
      registryId: REGISTRY_ID,
      commitSha: COMMIT_SHA,
      scripts: [{
        path: "scripts/report.sh",
        bytes,
        valueDigest: skillsShValueDigest(bytes),
      }],
    });

    const script = acquired.scripts[0]!;
    const written = await Deno.readFile(script.hostPath);
    expect(written).toEqual(bytes);
    expect(skillsShValueDigest(written)).toBe(script.valueDigest);
    expect(script.sizeBytes).toBe(bytes.byteLength);
  });

  it("refuses, naming the mount, when a mount of this run covers the directory", async () => {
    // An operator `--host-mount` over the artifact tree is the same hole as an
    // artifact root inside the workspace, so every mount is asked, not just
    // the workspace.
    const engine = engineWith([{
      kind: "host-bind",
      name: "artifacts",
      hostPath: artifactRoot,
      sandboxPath: "/artifacts",
      readOnly: false,
    }]);

    await expect(engine.materializeAcquiredSkill(oneScript)).rejects.toThrow(
      AcquiredSkillDirectoryReadableError,
    );
    await expect(engine.materializeAcquiredSkill(oneScript)).rejects.toThrow(
      "artifacts",
    );
    expect(engine.getRunState().acquiredSkills).toBeUndefined();
    await expect(
      Deno.stat(join(artifactRoot, ".acquired-skills")),
    ).rejects.toThrow(Deno.errors.NotFound);
  });

  it("refuses a mount of a handed-in runtime, which no configuration describes", async () => {
    // The check is about what the container running this can read, and for a
    // run handed its runtime the configuration beside it is not that
    // container's — "the unused resolved config … may describe a different
    // sandbox entirely", and where none was given it is nothing at all. Asked
    // of a configuration, the question about a real writable bind over the
    // artifact tree would answer "no mount covers it" and the bytes would be
    // written where the acquiring run can read them.
    const engine = new CfHarnessEngine({
      runId: "run-1",
      sandboxRuntime: new FakeSandboxRuntime([{
        kind: "host-bind",
        name: "artifacts",
        hostPath: artifactRoot,
        sandboxPath: "/artifacts",
        readOnly: false,
      }]),
      workspaceHostPath: workspace,
      artifactRoot,
    });

    await expect(engine.materializeAcquiredSkill(oneScript)).rejects.toThrow(
      AcquiredSkillDirectoryReadableError,
    );
    await expect(engine.materializeAcquiredSkill(oneScript)).rejects.toThrow(
      "artifacts",
    );
    await expect(
      Deno.stat(join(artifactRoot, ".acquired-skills")),
    ).rejects.toThrow(Deno.errors.NotFound);
  });

  it("keeps another run's acquired scripts out of this run's artifacts", async () => {
    // Run ids admit dots, so a `<runId>.acquired-skills` sibling would be the
    // run root of a run named that. One directory that no run may be named
    // holds them all instead.
    const engine = engineWith([]);
    const acquired = await engine.materializeAcquiredSkill(oneScript);

    expect(
      acquired.hostRoot.startsWith(join(artifactRoot, ".acquired-skills/")),
    )
      .toBe(true);
    expect(() =>
      createFileSystemHarnessArtifactStore({
        artifactRoot,
        runId: ".acquired-skills",
      })
    ).toThrow(".acquired-skills");
  });

  it("hands the acquisition to the tools of the run that holds it", async () => {
    // The record reaches `run_skill_script` through the tool context, so a pin
    // this run acquired gets past "no skill acquired at this pin" and stops at
    // activation — the gate that says the run was GIVEN the skill.
    const engine = engineWith([]);
    await engine.materializeAcquiredSkill(oneScript);

    const result = await engine.invokeBuiltinTool("run_skill_script", {
      skill: `${REGISTRY_ID}@${COMMIT_SHA}`,
      path: "scripts/report.sh",
    });

    expect(result.output.status).toBe("error");
    expect(result.output.error?.code).toBe("skill_not_activated");
  });

  it("refuses when the workspace itself covers the artifact tree", async () => {
    const nested = join(workspace, "artifacts");
    await Deno.mkdir(nested);
    const engine = engineWith([], nested);

    await expect(engine.materializeAcquiredSkill(oneScript)).rejects.toThrow(
      "workspace",
    );
  });
});

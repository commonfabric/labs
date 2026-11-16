/**
 * A tool context over a scripted sandbox, for the tests of the file tools
 * (`edit_file`, `view_image`) and `read_skill_resource`. The sandbox answers
 * each shell call with the next scripted result and records what it was sent;
 * the workspace `/workspace` maps to a host directory the test chooses.
 */
import { normalize } from "@std/path/posix";

import { createHarnessCfcInvocationContext } from "../../src/contracts/cfc-invocation-context.ts";
import type {
  HarnessSkillRegistry,
  HarnessSkillResourceRead,
} from "../../src/contracts/skill.ts";
import { createToolOutputId } from "../../src/contracts/tool-result.ts";
import type {
  ProcessRunRequest,
  ProcessRunResult,
} from "../../src/sandbox/process-runner.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../../src/sandbox/types.ts";
import type { HarnessToolContext } from "../../src/tools/types.ts";

export class ScriptedSandbox implements SandboxRuntime {
  readonly shellRequests: SandboxShellRequest[] = [];

  readonly #results: SandboxCommandResult[];

  constructor(results: SandboxCommandResult[] = []) {
    this.#results = [...results];
  }

  describe(): SandboxRuntimeDescription {
    return {
      kind: "runsc-cfc",
      defaultWorkingDirectory: "/workspace",
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = "/workspace"): string {
    const resolved = normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
    if (!this.isPathWithinWorkspace(resolved)) {
      throw new Error(`path escapes workspace root: ${resolved}`);
    }
    return resolved;
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
    throw new Error("ScriptedSandbox runs shell commands only");
  }

  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    this.shellRequests.push(request);
    const result = this.#results.shift();
    if (result === undefined) {
      throw new Error("ScriptedSandbox ran out of scripted results");
    }
    return Promise.resolve(result);
  }
}

export interface ToolsSmallContextOptions {
  sandbox?: SandboxRuntime;
  workspaceHostPath?: string;
  artifactRootHostPath?: string;
  skillRegistry?: HarnessSkillRegistry;
  skillResourceReads?: HarnessSkillResourceRead[];
  imageAttachmentSnapshotDir?: string;

  /** Replaces `resolveHostPath`, for a host mapping that fails. */
  resolveHostPath?: (path: string) => string;
}

export const createToolsSmallContext = (
  options: ToolsSmallContextOptions = {},
): HarnessToolContext => {
  const sandbox = options.sandbox ?? new ScriptedSandbox();
  const workspaceHostPath = options.workspaceHostPath ??
    "/tmp/cf-harness-workspace";
  const artifactRoot = options.artifactRootHostPath;
  const skillResourceReads = options.skillResourceReads ?? [];
  const withinRoot = (root: string | undefined, path: string) =>
    root !== undefined && (path === root || path.startsWith(`${root}/`));
  let currentDir = "/workspace";
  let sequence = 0;
  let cfcSequence = 0;
  return {
    runId: "run-1",
    cfcEnforcementMode: "observe",
    skillScriptExecutionTarget: "sandbox",
    workspaceHostPath,
    skillRegistry: options.skillRegistry,
    imageAttachmentSnapshotDir: options.imageAttachmentSnapshotDir,
    get currentDir() {
      return currentDir;
    },
    sandbox,
    hostProcessRunner: {
      run(_request: ProcessRunRequest): Promise<ProcessRunResult> {
        throw new Error("tools-small context runs no host processes");
      },
    },
    resolvePath(path) {
      return sandbox.resolvePath(path, currentDir);
    },
    resolveHostPath: options.resolveHostPath ?? ((path) => {
      const sandboxPath = sandbox.resolvePath(path, currentDir);
      return `${workspaceHostPath}${sandboxPath.slice("/workspace".length)}`;
    }),
    resolveHostRootPath() {
      return workspaceHostPath;
    },
    isHostPathWithinWorkspace(path) {
      return Promise.resolve(withinRoot(workspaceHostPath, path));
    },
    isHostPathWithinArtifactRoot(path) {
      return Promise.resolve(withinRoot(artifactRoot, path));
    },
    setCurrentDir(path) {
      currentDir = sandbox.resolvePath(path, currentDir);
    },
    nextOutputId(toolId) {
      sequence += 1;
      return createToolOutputId("run-1", toolId, sequence);
    },
    now() {
      return "2026-05-01T17:54:00.000Z";
    },
    recordSkillResourceRead(read) {
      skillResourceReads.push(read);
      return Promise.resolve();
    },
    recordSkillScriptExecution() {
      throw new Error("tools-small context runs no skill scripts");
    },
    createCfcInvocationContext(invocation) {
      cfcSequence += 1;
      return createHarnessCfcInvocationContext({
        sequence: cfcSequence,
        runId: "run-1",
        createdAt: "2026-04-30T00:00:00.000Z",
        cfcEnforcementMode: "observe",
        runManifest: { present: false },
        ...invocation,
      });
    },
  };
};

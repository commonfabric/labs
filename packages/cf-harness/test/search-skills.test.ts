/**
 * The model-facing skills.sh discovery tool: metadata returned, refusals
 * surfaced, and the trust limits stated in its prompt-visible descriptor.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";

import { CfHarnessEngine } from "../src/engine.ts";
import { SkillsShSearchClient } from "../src/skills-sh/search-client.ts";
import {
  searchSkillsTool,
  type SearchSkillsToolErrorOutput,
  type SearchSkillsToolSuccessOutput,
} from "../src/tools/search-skills.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

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

  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

const capturedResponse = {
  skills: [{
    id: "vercel-labs/agent-skills/vercel-react-native-skills",
    name: "vercel-react-native-skills",
    installs: 197232,
    source: "vercel-labs/agent-skills",
  }, {
    id: "owner/repo/../../escape",
    name: "refused",
    source: "owner/repo",
  }],
};

const createEngine = (configured = true): CfHarnessEngine =>
  new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: `search-skills-test-${crypto.randomUUID()}`,
    ...(configured
      ? {
        skillsShSearchClientFactory: () =>
          Promise.resolve(
            new SkillsShSearchClient({
              origin: "https://registry.example",
              fetch: () => Promise.resolve(Response.json(capturedResponse)),
            }),
          ),
      }
      : {}),
  });

describe("search-skills", () => {
  it("returns sanitized metadata and the rejected entry count", async () => {
    const engine = createEngine();
    expect(engine.skillsShSearchAvailable).toBe(true);
    expect(engine.skillsShSearchClientFactory).toBeDefined();
    const result = await engine.invokeBuiltinTool("search_skills", {
      query: "react native",
    });
    const output = result.output as SearchSkillsToolSuccessOutput;

    expect(output).toEqual({
      outputId: output.outputId,
      status: "ok",
      hits: [{
        id: "vercel-labs/agent-skills/vercel-react-native-skills",
        name: "vercel-react-native-skills",
        source: "vercel-labs/agent-skills",
        installs: 197232,
      }],
      rejected: 1,
    });
    expect(Object.keys(output.hits[0]).sort()).toEqual([
      "id",
      "installs",
      "name",
      "source",
    ]);
  });

  it("refuses when the run has no discovery registry configured", async () => {
    const result = await createEngine(false).invokeBuiltinTool(
      "search_skills",
      { query: "react native" },
    );
    const output = result.output as SearchSkillsToolErrorOutput;

    expect(output.status).toBe("error");
    expect(output.message).toContain("--skills-registry-url");
  });

  it("reports a client-construction failure without throwing it", async () => {
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `search-skills-test-${crypto.randomUUID()}`,
      skillsShSearchClientFactory: () =>
        Promise.reject(new Error("registry offline")),
    });
    const result = await engine.invokeBuiltinTool("search_skills", {
      query: "react native",
    });
    const output = result.output as SearchSkillsToolErrorOutput;

    expect(output.status).toBe("error");
    expect(output.message).toContain("registry unavailable");
    expect(output.message).toContain("registry offline");
  });

  it("reports a refused search as a tool error", async () => {
    const result = await createEngine().invokeBuiltinTool("search_skills", {
      query: "x",
    });
    const output = result.output as SearchSkillsToolErrorOutput;

    expect(output.status).toBe("error");
    expect(output.message).toContain("at least two characters");
  });

  it("declares the telemetry and content boundaries to the model", () => {
    expect(searchSkillsTool.descriptor.effectClass).toBe("read");
    expect(searchSkillsTool.descriptor.description).toContain("unverifiable");
    expect(searchSkillsTool.descriptor.description).toContain(
      "not a trust signal",
    );
    expect(searchSkillsTool.descriptor.description).toContain(
      "cannot fetch, read, or load skill content",
    );
  });
});

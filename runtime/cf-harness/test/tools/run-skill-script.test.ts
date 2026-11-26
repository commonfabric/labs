import { join } from "@std/path";
import { normalize } from "@std/path/posix";
import { expect } from "@std/expect";

import type { HarnessBrowserAccessLease } from "../../src/contracts/browser-access.ts";
import { createHarnessCfcInvocationContext } from "../../src/contracts/cfc-invocation-context.ts";
import type {
  HarnessAllowedSkillScript,
  HarnessSkillActivations,
  HarnessSkillRegistry,
  HarnessSkillResourceKind,
  HarnessSkillResourceRecord,
  HarnessSkillScriptExecution,
  HarnessSkillScriptMetadata,
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
import {
  isRunSkillScriptToolSuccessOutput,
  runSkillScriptTool,
  type RunSkillScriptToolInput,
  type RunSkillScriptToolOutput,
} from "../../src/tools/run-skill-script.ts";
import type { HarnessToolContext } from "../../src/tools/types.ts";
import { readsDespiteMode } from "../support/reads-despite-mode.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

const SKILL = "demo";
const SANDBOX_SKILLS_ROOT = "/workspace/skills";
const WORKSPACE_HOST_PATH = "/tmp/cf-harness-workspace";

const sha256 = async (content: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(content),
  );
  return `sha256:${
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }`;
};

class RecordingSandbox implements SandboxRuntime {
  readonly calls: SandboxCommandRequest[] = [];

  describe(): SandboxRuntimeDescription {
    return {
      kind: "runsc-cfc",
      defaultWorkingDirectory: "/workspace",
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
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
    return Promise.resolve({ stdout: "ran\n", stderr: "", exitCode: 0 });
  }

  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.reject(new Error("run_skill_script uses no sandbox shell"));
  }
}

class RecordingProcessRunner {
  readonly calls: ProcessRunRequest[] = [];
  readonly #result: ProcessRunResult;

  constructor(result: ProcessRunResult) {
    this.#result = result;
  }

  run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(request);
    return Promise.resolve(this.#result);
  }
}

describe("run-skill-script", () => {
  //
  // Each case writes the scripts it needs under a temporary skills root and
  // describes them to the tool in a run-start registry built here, so a case
  // can hand the tool exactly the record it is about: a runtime and a shebang
  // that disagree, a resource that is not a script, a file changed since the
  // snapshot.
  //

  let skillsRoot: string;
  let skillDir: string;
  let resources: HarnessSkillResourceRecord[];
  let executions: HarnessSkillScriptExecution[];
  let sandbox: RecordingSandbox;

  beforeEach(async () => {
    skillsRoot = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "cf-harness-run-skill-script-" }),
    );
    skillDir = join(skillsRoot, SKILL);
    await Deno.mkdir(join(skillDir, "scripts"), { recursive: true });
    resources = [];
    executions = [];
    sandbox = new RecordingSandbox();
  });

  afterEach(async () => {
    // A case may have taken permissions away from the tree it wrote.
    await Deno.chmod(join(skillDir, "scripts"), 0o755);
    await Deno.remove(skillsRoot, { recursive: true });
  });

  /**
   * Writes `content` at `path` in the skill and indexes it in the registry
   * as it stands now, with the script metadata given.
   */
  const addResource = async (
    path: string,
    content: string | Uint8Array,
    script: HarnessSkillScriptMetadata | undefined,
    kind: HarnessSkillResourceKind = "script",
  ): Promise<HarnessSkillResourceRecord> => {
    const bytes = typeof content === "string"
      ? new TextEncoder().encode(content)
      : content;
    const resourcePath = join(skillDir, path);
    await Deno.writeFile(resourcePath, bytes);
    const resource: HarnessSkillResourceRecord = {
      path,
      kind,
      resourcePath,
      sandboxResourcePath: `${SANDBOX_SKILLS_ROOT}/${SKILL}/${path}`,
      sizeBytes: bytes.byteLength,
      digest: await sha256(bytes),
      contentKind: "text",
      ...(script !== undefined ? { script } : {}),
      diagnostics: [],
    };
    resources.push(resource);
    return resource;
  };

  const addDenoScript = (path: string, source: string, shebang?: string) =>
    addResource(path, source, {
      executable: false,
      runtime: "deno",
      ...(shebang !== undefined ? { shebang } : {}),
    });

  const addBashScript = (path: string, source: string) =>
    addResource(path, source, {
      executable: true,
      runtime: "shebang",
      shebang: source.split("\n", 1)[0],
    });

  const registry = (): HarnessSkillRegistry => ({
    type: "cf-harness.skill-registry",
    version: 1,
    skillsRoot,
    sandboxSkillsRoot: SANDBOX_SKILLS_ROOT,
    generatedAt: "2026-05-01T00:00:00.000Z",
    skills: [{
      name: SKILL,
      description: "A demonstration skill",
      skillPath: join(skillDir, "SKILL.md"),
      skillDir,
      sandboxSkillPath: `${SANDBOX_SKILLS_ROOT}/${SKILL}/SKILL.md`,
      sandboxSkillDir: `${SANDBOX_SKILLS_ROOT}/${SKILL}`,
      digest: "sha256:skill",
      resources,
      frontmatter: {},
      diagnostics: [],
    }],
    diagnostics: [],
  });

  const activations = (name = SKILL): HarnessSkillActivations => ({
    type: "cf-harness.skill-activations",
    version: 1,
    generatedAt: "2026-05-01T00:00:00.000Z",
    activations: [{
      name,
      source: "cli-preload",
      runId: "run-1",
      digest: "sha256:skill",
      activatedAt: "2026-05-01T00:00:00.000Z",
      cfcPromptRole: "context",
    }],
  });

  interface ContextOptions {
    skillActivations?: HarnessSkillActivations | null;
    allowSkillScripts?: boolean;
    allowedSkillScripts?: readonly HarnessAllowedSkillScript[];
    skillScriptExecutionTarget?: "sandbox" | "host";
    hostProcessRunner?: RecordingProcessRunner;
    browserAccess?: HarnessBrowserAccessLease;
    workspaceHostPath?: string;
    artifactRootHostPath?: string;
  }

  const createContext = (options: ContextOptions = {}): HarnessToolContext => {
    let sequence = 0;
    const workspaceHostPath = options.workspaceHostPath ?? WORKSPACE_HOST_PATH;
    const within = (root: string | undefined, path: string) =>
      root !== undefined && (path === root || path.startsWith(`${root}/`));
    return {
      runId: "run-1",
      cfcEnforcementMode: "observe",
      workspaceHostPath,
      skillRegistry: registry(),
      skillActivations: options.skillActivations === null
        ? undefined
        : options.skillActivations ?? activations(),
      allowSkillScripts: options.allowSkillScripts ?? true,
      allowedSkillScripts: options.allowedSkillScripts,
      skillScriptExecutionTarget: options.skillScriptExecutionTarget ??
        "sandbox",
      browserAccess: options.browserAccess,
      currentDir: "/workspace",
      sandbox,
      hostProcessRunner: options.hostProcessRunner ??
        new RecordingProcessRunner({ stdout: "", stderr: "", exitCode: 0 }),
      resolvePath: (path) => sandbox.resolvePath(path),
      resolveHostPath: (path) =>
        `${WORKSPACE_HOST_PATH}${
          sandbox.resolvePath(path).slice(
            "/workspace".length,
          )
        }`,
      resolveHostRootPath: () => WORKSPACE_HOST_PATH,
      isHostPathWithinWorkspace: (path) =>
        Promise.resolve(within(workspaceHostPath, path)),
      isHostPathWithinArtifactRoot: (path) =>
        Promise.resolve(within(options.artifactRootHostPath, path)),
      setCurrentDir: () => {},
      nextOutputId(toolId) {
        sequence += 1;
        return createToolOutputId("run-1", toolId, sequence);
      },
      now: () => "2026-05-01T17:54:00.000Z",
      recordSkillResourceRead: () => Promise.resolve(),
      recordSkillScriptExecution(execution) {
        executions.push(execution);
        return Promise.resolve();
      },
      createCfcInvocationContext: (invocation) =>
        Promise.resolve(createHarnessCfcInvocationContext({
          sequence: 1,
          runId: "run-1",
          createdAt: "2026-05-01T00:00:00.000Z",
          cfcEnforcementMode: "observe",
          runManifest: { present: false },
          ...invocation,
        })),
    };
  };

  const run = (
    input: Omit<RunSkillScriptToolInput, "skill"> & { skill?: string },
    options?: ContextOptions,
  ): Promise<RunSkillScriptToolOutput> =>
    runSkillScriptTool.invoke(createContext(options), {
      skill: SKILL,
      ...input,
    });

  /** The output of a call the tool refused, after checking it ran nothing. */
  const refusal = async (
    input: Omit<RunSkillScriptToolInput, "skill"> & { skill?: string },
    options?: ContextOptions,
  ): Promise<RunSkillScriptToolOutput> => {
    const output = await run(input, options);
    expect(output.status).toBe("error");
    expect(sandbox.calls).toEqual([]);
    expect(executions.map(({ status, error }) => ({ status, error })))
      .toEqual([{ status: "error", error: output.error }]);
    return output;
  };

  describe("runSkillScriptTool", () => {
    describe("input", () => {
      it("returns `script_path_invalid` for a path outside `scripts/`", async () => {
        const output = await refusal({ path: "SKILL.md" });

        expect(output.error).toEqual({
          code: "script_path_invalid",
          message: "script path must name a file under scripts/",
        });
        expect(output.path).toBe("SKILL.md");
      });

      it("returns `script_path_invalid` for arguments that are not strings without null bytes", async () => {
        await addDenoScript("scripts/a.ts", "console.log(1);\n");
        // Parsed rather than typed, as a model's tool call arrives: nothing
        // checks its arguments against the schema before the tool does.
        const inputs: RunSkillScriptToolInput[] = [
          JSON.parse('{"skill":"demo","path":"scripts/a.ts","args":"--all"}'),
          JSON.parse('{"skill":"demo","path":"scripts/a.ts","args":[1]}'),
          {
            skill: SKILL,
            path: "scripts/a.ts",
            args: ["fine", "nul\0byte"],
          },
        ];

        const messages = [];
        for (const input of inputs) {
          const output = await runSkillScriptTool.invoke(
            createContext(),
            input,
          );
          expect(output.error?.code).toBe("script_path_invalid");
          messages.push(output.error?.message);
        }

        expect(messages).toEqual([
          "run_skill_script args must be an array of strings",
          "run_skill_script args must be an array of strings",
          "run_skill_script args must not contain null bytes",
        ]);
        expect(sandbox.calls).toEqual([]);
      });

      it("returns `script_path_invalid` for a timeout outside 0 to 600000 milliseconds", async () => {
        await addDenoScript("scripts/a.ts", "console.log(1);\n");

        for (const timeoutMs of [-1, 1.5, 600_001]) {
          const output = await run({ path: "scripts/a.ts", timeoutMs });

          expect(output.error).toEqual({
            code: "script_path_invalid",
            message:
              "run_skill_script timeoutMs must be an integer from 0 to 600000",
          });
        }
        expect(sandbox.calls).toEqual([]);
      });

      it("passes a timeout of 0 to the sandbox", async () => {
        await addDenoScript("scripts/a.ts", "console.log(1);\n");

        const output = await run({ path: "scripts/a.ts", timeoutMs: 0 });

        expect(output.status).toBe("executed");
        expect(sandbox.calls[0]?.timeoutMs).toBe(0);
      });
    });

    describe("resolution", () => {
      it("returns `skill_activations_missing` when the run activated nothing", async () => {
        await addDenoScript("scripts/a.ts", "console.log(1);\n");

        const output = await refusal({ path: "scripts/a.ts" }, {
          skillActivations: null,
        });

        expect(output.error?.code).toBe("skill_activations_missing");
      });

      it("returns `skill_not_activated` when only another skill is activated", async () => {
        await addDenoScript("scripts/a.ts", "console.log(1);\n");

        const output = await refusal({ path: "scripts/a.ts" }, {
          skillActivations: activations("other"),
        });

        expect(output.error).toEqual({
          code: "skill_not_activated",
          message: "skill is not activated for this run: demo",
        });
      });

      it("returns `script_not_allowlisted` for a host run that does not name the script, whatever the switch says", async () => {
        await addDenoScript("scripts/a.ts", "console.log(1);\n");

        const output = await refusal({ path: "scripts/a.ts" }, {
          allowSkillScripts: true,
          allowedSkillScripts: [{ skill: SKILL, path: "scripts/b.ts" }],
          skillScriptExecutionTarget: "host",
        });

        expect(output.error).toEqual({
          code: "script_not_allowlisted",
          message:
            "this run runs no host skill script that is not named exactly: demo:scripts/a.ts",
        });
      });

      it("returns `script_not_indexed` for a script the snapshot does not hold", async () => {
        const output = await refusal({ path: "scripts/missing.ts" });

        expect(output.error).toEqual({
          code: "script_not_indexed",
          message:
            "script not found in run-start registry for skill demo: scripts/missing.ts",
        });
      });

      it("returns `resource_not_script` with the registry's record of a resource that is not a script", async () => {
        const resource = await addResource(
          "scripts/notes.md",
          "# notes\n",
          undefined,
          "reference",
        );

        const output = await refusal({ path: "scripts/notes.md" });

        expect(output).toEqual({
          type: "cf-harness.run-skill-script-output",
          outputId: "run-1:run_skill_script:1",
          skill: SKILL,
          path: "scripts/notes.md",
          status: "error",
          runtime: undefined,
          sandboxResourcePath: resource.sandboxResourcePath,
          registryDigest: resource.digest,
          registrySizeBytes: resource.sizeBytes,
          diagnostics: [],
          error: {
            code: "resource_not_script",
            message: "resource is not a script resource: scripts/notes.md",
          },
        });
        expect(executions[0]?.resourcePath).toBe(resource.resourcePath);
      });
    });

    describe("the script's file", () => {
      it("returns `script_not_found` for a script deleted since the snapshot", async () => {
        const resource = await addDenoScript("scripts/a.ts", "1;\n");
        await Deno.remove(resource.resourcePath);

        const output = await refusal({ path: "scripts/a.ts" });

        expect(output.error?.code).toBe("script_not_found");
      });

      it(
        "returns `permission_denied` for a script in a directory it may not enter",
        // A privileged process enters a directory whatever its mode says, so
        // there is no denial to see.
        { ignore: readsDespiteMode() },
        async () => {
          await addDenoScript("scripts/a.ts", "1;\n");
          await Deno.chmod(join(skillDir, "scripts"), 0o000);

          const output = await refusal({ path: "scripts/a.ts" });

          expect(output.error?.code).toBe("permission_denied");
        },
      );

      it(
        "returns `permission_denied` for a script it may not read",
        // A privileged process reads a file whatever its mode says, so there
        // is no denial to see.
        { ignore: readsDespiteMode() },
        async () => {
          const resource = await addDenoScript("scripts/a.ts", "1;\n");
          await Deno.chmod(resource.resourcePath, 0o000);

          const output = await refusal({ path: "scripts/a.ts" });

          expect(output.error?.code).toBe("permission_denied");
        },
      );

      it("returns `unknown` for a script path that loops back on itself", async () => {
        const resource = await addDenoScript("scripts/a.ts", "1;\n");
        await Deno.remove(resource.resourcePath);
        await Deno.symlink(resource.resourcePath, resource.resourcePath);

        const output = await refusal({ path: "scripts/a.ts" });

        expect(output.error?.code).toBe("unknown");
      });

      it("returns `script_not_file` for a directory where the script was", async () => {
        const resource = await addDenoScript("scripts/a.ts", "1;\n");
        await Deno.remove(resource.resourcePath);
        await Deno.mkdir(resource.resourcePath);

        const output = await refusal({ path: "scripts/a.ts" });

        expect(output.error).toEqual({
          code: "script_not_file",
          message: "script is not a file: scripts/a.ts",
        });
      });

      it("returns `script_snapshot_mismatch` with both digests for a script changed since the snapshot", async () => {
        const resource = await addDenoScript("scripts/a.ts", "1;\n");
        const changed = new TextEncoder().encode("2;\n");
        await Deno.writeFile(resource.resourcePath, changed);

        const output = await refusal({ path: "scripts/a.ts" });

        expect(output.error?.code).toBe("script_snapshot_mismatch");
        expect(output.registryDigest).toBe(resource.digest);
        expect(output.observedDigest).toBe(await sha256(changed));
        expect(output.digestMatchesRegistry).toBe(false);
        expect(executions[0]?.digestMatchesRegistry).toBe(false);
      });
    });

    describe("Deno scripts", () => {
      it("runs a script without a shebang with no permission flags", async () => {
        await addDenoScript("scripts/a.ts", "console.log(1);\n");

        const output = await run({ path: "scripts/a.ts", args: ["x"] });

        expect(output.argv).toEqual(["deno", "run", "-", "x"]);
        expect(sandbox.calls[0]?.stdinText).toBe("console.log(1);\n");
      });

      it("runs a script with no permission flags when its shebang does not run Deno", async () => {
        await addDenoScript(
          "scripts/a.ts",
          "#!/usr/bin/env -S deno eval --allow-all\n1;\n",
          "#!/usr/bin/env -S deno eval --allow-all",
        );
        await addDenoScript(
          "scripts/b.ts",
          "#!/usr/bin/env node --allow-all\n1;\n",
          "#!/usr/bin/env node --allow-all",
        );

        const a = await run({ path: "scripts/a.ts" });
        const b = await run({ path: "scripts/b.ts" });

        expect(a.argv).toEqual(["deno", "run", "-"]);
        expect(b.argv).toEqual(["deno", "run", "-"]);
      });

      it("passes the shebang's flags up to its first word that is not a flag", async () => {
        const shebang = "#!/usr/bin/env -S deno run --allow-read main.ts --x";
        await addDenoScript("scripts/a.ts", `${shebang}\n1;\n`, shebang);

        const output = await run({ path: "scripts/a.ts" });

        expect(output.argv).toEqual(["deno", "run", "--allow-read", "-"]);
      });

      it("returns `unsupported_runtime` for a script that is not UTF-8", async () => {
        await addResource("scripts/a.ts", new Uint8Array([0xff, 0xfe]), {
          executable: false,
          runtime: "deno",
        });

        const output = await refusal({ path: "scripts/a.ts" });

        expect(output.error).toEqual({
          code: "unsupported_runtime",
          message: "Deno skill script is not valid UTF-8 text: scripts/a.ts",
        });
        expect(output.digestMatchesRegistry).toBe(true);
      });

      it("returns `unsupported_runtime` naming a relative module specifier, however it is imported", async () => {
        const sources = {
          "./side-effect.ts": 'import "./side-effect.ts";',
          "./named.ts": "import {\n  a,\n  b,\n} from './named.ts';",
          "../up.ts": 'import * as up from "../up.ts";',
          "./dynamic.ts": 'const m = await import("./dynamic.ts");',
          "./reexport.ts": 'export { x } from "./reexport.ts";',
          ".": 'export * from ".";',
          "..": 'import parent from "..";',
        };

        const messages: Record<string, string | undefined> = {};
        for (const [specifier, source] of Object.entries(sources)) {
          resources = [];
          await addDenoScript("scripts/a.ts", `${source}\n`);
          messages[specifier] = (await run({ path: "scripts/a.ts" })).error
            ?.message;
        }

        expect(messages).toEqual(
          Object.fromEntries(
            Object.keys(sources).map((specifier) => [
              specifier,
              `Deno skill scripts must be standalone in v1; relative module specifier ${
                JSON.stringify(specifier)
              } is not supported by run_skill_script.`,
            ]),
          ),
        );
        expect(sandbox.calls).toEqual([]);
      });

      it("runs a script whose relative specifiers are only in comments, strings or a later statement", async () => {
        const source = [
          "// import x from './line-comment.ts';",
          "/* import './block-comment.ts'; */",
          "const quoted = 'import \"./quoted.ts\"';",
          'const escaped = "say \\"import\\" from \\"./escaped.ts\\"";',
          "console.log(import.meta.url);",
          "const name = 'jsr:@std/path';",
          "await import(name);",
          'import { join } from "jsr:@std/path";',
          "import data from 'npm:pkg'",
          "export const later = './not-a-specifier.ts';",
          "export default 1;",
          "export { join }",
          'const unterminated = "no closing quote',
        ].join("\n");
        await addDenoScript("scripts/a.ts", source);

        const output = await run({ path: "scripts/a.ts" });

        expect(output.error).toBeUndefined();
        expect(output.status).toBe("executed");
        expect(sandbox.calls[0]?.stdinText).toBe(source);
      });

      it("runs a script whose only import is inside a block comment left open", async () => {
        await addDenoScript("scripts/a.ts", "1;\n/* import './inside.ts';");

        const output = await run({ path: "scripts/a.ts" });

        expect(output.status).toBe("executed");
      });
    });

    describe("Bash scripts", () => {
      it("runs a Bash script from stdin with its arguments", async () => {
        const source = "#!/bin/bash\necho hi\n";
        await addBashScript("scripts/a.sh", source);

        const output = await run({ path: "scripts/a.sh", args: ["one"] });

        expect(output.runtime).toBe("shebang");
        expect(output.argv).toEqual(["bash", "-s", "--", "one"]);
        expect(sandbox.calls[0]?.stdinText).toBe(source);
      });

      it("returns `unsupported_runtime` for interpreters other than a bare Bash", async () => {
        await addBashScript("scripts/flags.sh", "#!/bin/bash -e\necho hi\n");
        await addBashScript("scripts/env.sh", "#!/usr/bin/env bash -e\nls\n");
        await addBashScript("scripts/py.sh", "#!/usr/bin/python3\nprint(1)\n");
        await addResource("scripts/none.sh", "echo hi\n", {
          executable: true,
          runtime: "shebang",
        });

        const codes = [];
        for (
          const path of [
            "scripts/flags.sh",
            "scripts/env.sh",
            "scripts/py.sh",
            "scripts/none.sh",
          ]
        ) {
          const output = await run({ path });
          codes.push(output.error?.code);
          expect(output.error?.message).toBe(
            `unsupported skill script runtime for ${path}: only Deno scripts and Bash shebang scripts without interpreter flags are supported in v1`,
          );
        }

        expect(codes).toEqual(Array(4).fill("unsupported_runtime"));
        expect(sandbox.calls).toEqual([]);
      });

      it("runs a script that names Bash through `env`", async () => {
        await addBashScript("scripts/a.sh", "#!/usr/bin/env bash\necho hi\n");

        const output = await run({ path: "scripts/a.sh" });

        expect(output.argv).toEqual(["bash", "-s", "--"]);
      });

      it("returns `unsupported_runtime` for a Bash script that is not UTF-8", async () => {
        await addResource(
          "scripts/a.sh",
          new Uint8Array([0x23, 0x21, 0xff, 0x0a]),
          { executable: true, runtime: "shebang", shebang: "#!" },
        );

        const output = await refusal({ path: "scripts/a.sh" });

        expect(output.error).toEqual({
          code: "unsupported_runtime",
          message: "Bash skill script is not valid UTF-8 text: scripts/a.sh",
        });
      });

      it("returns `unsupported_runtime` naming a relatively sourced file", async () => {
        const sources = {
          "./lib.sh": "source ./lib.sh",
          "../up.sh": '. "../up.sh"',
          "./quoted.sh": "source './quoted.sh' # trailing comment",
        };

        const messages: Record<string, string | undefined> = {};
        for (const [specifier, line] of Object.entries(sources)) {
          resources = [];
          await addBashScript("scripts/a.sh", `#!/bin/bash\n\n${line}\n`);
          messages[specifier] = (await run({ path: "scripts/a.sh" })).error
            ?.message;
        }

        expect(messages).toEqual(
          Object.fromEntries(
            Object.keys(sources).map((specifier) => [
              specifier,
              `Bash skill scripts must be standalone in v1; relative source specifier ${
                JSON.stringify(specifier)
              } is not supported by run_skill_script.`,
            ]),
          ),
        );
      });

      it("runs a script whose relative sources are only commented out, quoted or absolute", async () => {
        const source = [
          "#!/bin/bash",
          "# source ./commented.sh",
          'echo "it\'s # not a comment" # source ./after-comment.sh',
          "echo don\\'t # . ./escaped.sh",
          "source /etc/profile",
          "echo 'source ./quoted.sh'",
        ].join("\n");
        await addBashScript("scripts/a.sh", source);

        const output = await run({ path: "scripts/a.sh" });

        expect(output.error).toBeUndefined();
        expect(output.status).toBe("executed");
      });
    });

    it("returns `unsupported_runtime` for a script whose runtime is unknown", async () => {
      await addResource("scripts/a.txt", "hello\n", {
        executable: false,
        runtime: "unknown",
      });
      await addResource("scripts/b.txt", "hello\n", undefined);

      const a = await refusal({ path: "scripts/a.txt" });
      executions.length = 0;
      const b = await refusal({ path: "scripts/b.txt" });

      expect(a.error?.message).toBe(
        "unsupported skill script runtime for scripts/a.txt: unknown",
      );
      expect(b.error?.message).toBe(
        "unsupported skill script runtime for scripts/b.txt: unknown",
      );
    });

    describe("host target", () => {
      const host = (
        hostProcessRunner: RecordingProcessRunner,
        options: ContextOptions = {},
      ): ContextOptions => ({
        allowedSkillScripts: [
          { skill: SKILL, path: "scripts/a.sh" },
          { skill: "agent-browser", path: "scripts/a.sh" },
        ],
        skillScriptExecutionTarget: "host",
        hostProcessRunner,
        ...options,
      });

      it("runs the script through the host runner from the workspace", async () => {
        await addBashScript("scripts/a.sh", "#!/bin/bash\necho hi\n");
        const runner = new RecordingProcessRunner({
          stdout: "hi\n",
          stderr: "",
          exitCode: 0,
        });

        const output = await run(
          { path: "scripts/a.sh", cwd: "/workspace/sub" },
          host(runner),
        );

        expect(output.status).toBe("executed");
        expect(output.stdout).toBe("hi\n");
        expect(runner.calls.map(({ command, args, cwd }) => ({
          command,
          args,
          cwd,
        }))).toEqual([{
          command: "bash",
          args: ["-s", "--"],
          cwd: `${WORKSPACE_HOST_PATH}/sub`,
        }]);
        expect(runner.calls[0]?.env?.AGENT_BROWSER_CDP).toBeUndefined();
        expect(sandbox.calls).toEqual([]);
      });

      it("returns `permission_denied` for a working directory outside the workspace or inside the artifacts", async () => {
        await addBashScript("scripts/a.sh", "#!/bin/bash\necho hi\n");
        const runner = new RecordingProcessRunner({
          stdout: "",
          stderr: "",
          exitCode: 0,
        });

        const outside = await refusal(
          { path: "scripts/a.sh" },
          host(runner, { workspaceHostPath: "/elsewhere" }),
        );
        executions.length = 0;
        const artifacts = await refusal(
          { path: "scripts/a.sh", cwd: "/workspace/.cf-harness" },
          host(runner, {
            artifactRootHostPath: `${WORKSPACE_HOST_PATH}/.cf-harness`,
          }),
        );

        for (const output of [outside, artifacts]) {
          expect(output.error).toEqual({
            code: "permission_denied",
            message:
              "host skill scripts must execute from a workspace path outside cf-harness artifacts",
          });
          expect(output.executionTarget).toBe("host");
        }
        expect(runner.calls).toEqual([]);
      });

      describe("agent-browser", () => {
        //
        // The browser profile's bundled scripts attach to the run's Browser
        // Access lease, which the harness hands them in their environment
        // and keeps out of what the model reads.
        //

        beforeEach(() => {
          skillDir = join(skillsRoot, "agent-browser");
          return Deno.mkdir(join(skillDir, "scripts"), { recursive: true });
        });

        const lease = (
          fields: Partial<HarnessBrowserAccessLease> = {},
        ): HarnessBrowserAccessLease => ({
          type: "cf-harness.chat.browser-access-lease",
          leaseId: "lease-1",
          cdpUrl: "http://127.0.0.1:9362",
          ...fields,
        });

        const runBrowserScript = async (
          browserAccess: HarnessBrowserAccessLease | undefined,
          args: string[] = [],
        ) => {
          const runner = new RecordingProcessRunner({
            stdout: "attached to http://127.0.0.1:9362\n",
            stderr: "via 127.0.0.1:9362\n",
            exitCode: 0,
          });
          const context = createContext(host(runner, { browserAccess }));
          const output = await runSkillScriptTool.invoke(
            {
              ...context,
              skillRegistry: {
                ...registry(),
                skills: [{ ...registry().skills[0]!, name: "agent-browser" }],
              },
              skillActivations: activations("agent-browser"),
            },
            { skill: "agent-browser", path: "scripts/a.sh", args },
          );
          return { output, runner };
        };

        it("hands the lease origin to the script and scrubs it from what the script prints", async () => {
          await addBashScript("scripts/a.sh", "#!/bin/bash\necho hi\n");

          const { output, runner } = await runBrowserScript(lease());

          expect(runner.calls[0]?.env?.AGENT_BROWSER_CDP).toBe(
            "http://127.0.0.1:9362",
          );
          expect(output.stdout).toBe("attached to <lease endpoint>\n");
          expect(output.stderr).toBe("via <lease endpoint>\n");
        });

        it("returns `permission_denied` without a usable lease or with a `--cdp` argument", async () => {
          await addBashScript("scripts/a.sh", "#!/bin/bash\necho hi\n");

          const cases = [
            { browserAccess: undefined, args: [] },
            {
              browserAccess: lease({ cdpUrl: "http://example.com:9" }),
              args: [],
            },
            {
              browserAccess: lease({ expiresAt: "2000-01-01T00:00:00.000Z" }),
              args: [],
            },
            { browserAccess: lease(), args: ["--cdp=http://127.0.0.1:1"] },
            { browserAccess: lease(), args: ["--cdp", "9222"] },
          ];
          const messages = [];
          for (const { browserAccess, args } of cases) {
            const { output, runner } = await runBrowserScript(
              browserAccess,
              args,
            );
            expect(output.error?.code).toBe("permission_denied");
            expect(runner.calls).toEqual([]);
            messages.push(output.error?.message);
          }

          expect(messages).toEqual([
            "host agent-browser skill scripts require a Browser Access lease endpoint",
            "host agent-browser skill scripts require a Browser Access lease endpoint",
            "Browser Access lease has expired",
            "host agent-browser skill scripts must not pass --cdp; the harness attaches the Browser Access lease endpoint itself",
            "host agent-browser skill scripts must not pass --cdp; the harness attaches the Browser Access lease endpoint itself",
          ]);
        });
      });
    });

    it("records each call's outcome with its provenance", async () => {
      const resource = await addBashScript(
        "scripts/a.sh",
        "#!/bin/bash\necho hi\n",
      );

      const output = await run({
        path: "scripts/a.sh",
        args: ["x"],
        cwd: "/workspace/sub",
      });

      expect(executions).toEqual([{
        type: "cf-harness.skill-script-execution",
        outputId: output.outputId,
        runId: "run-1",
        skillName: SKILL,
        path: "scripts/a.sh",
        status: "executed",
        executedAt: "2026-05-01T17:54:00.000Z",
        executionTarget: "sandbox",
        runtime: "shebang",
        argv: ["bash", "-s", "--", "x"],
        args: ["x"],
        cwd: "/workspace/sub",
        resourcePath: resource.resourcePath,
        sandboxResourcePath: resource.sandboxResourcePath,
        registryDigest: resource.digest,
        observedDigest: resource.digest,
        digestMatchesRegistry: true,
        registrySizeBytes: resource.sizeBytes,
        observedSizeBytes: resource.sizeBytes,
        exitCode: 0,
        diagnostics: [],
      }]);
    });
  });

  describe("isRunSkillScriptToolSuccessOutput()", () => {
    it("returns `true` only for an executed run_skill_script output", () => {
      const output = {
        type: "cf-harness.run-skill-script-output",
        status: "executed",
      };

      expect(isRunSkillScriptToolSuccessOutput(output)).toBe(true);
      expect(isRunSkillScriptToolSuccessOutput({ ...output, status: "error" }))
        .toBe(false);
      expect(isRunSkillScriptToolSuccessOutput({ ...output, type: "other" }))
        .toBe(false);
      expect(isRunSkillScriptToolSuccessOutput(undefined)).toBe(false);
    });
  });
});

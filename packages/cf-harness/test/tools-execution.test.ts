import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { normalize } from "@std/path/posix";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { CfcLabelView, CfcSandboxResult } from "@commonfabric/runner/cfc";

import { createHarnessCfcInvocationContext } from "../src/contracts/cfc-invocation-context.ts";
import type {
  HarnessAllowedSkillScript,
  HarnessSkillActivations,
  HarnessSkillRegistry,
  HarnessSkillResourceRead,
  HarnessSkillScriptExecution,
} from "../src/contracts/skill.ts";
import type { HarnessBrowserAccessLease } from "../src/contracts/browser-access.ts";
import { BROWSER_SUBAGENT_ALLOWED_SKILL_SCRIPTS } from "../src/contracts/subagent.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import { discoverHarnessSkills } from "../src/skills/registry.ts";
import {
  BASH_CWD_OUTSIDE_SANDBOX_EXIT_CODE,
  BASH_CWD_OUTSIDE_SANDBOX_PREFIX,
  BASH_SESSION_UNAVAILABLE_EXIT_CODE,
  BASH_TIMEOUT_EXIT_CODE,
  bashTool,
} from "../src/tools/bash.ts";
import { ProcessTimeoutError } from "../src/sandbox/process-runner.ts";
import { SandboxPathEscapeError } from "../src/sandbox/errors.ts";
import { browserTool } from "../src/tools/browser.ts";
import { editFileTool } from "../src/tools/edit-file.ts";
import { readFileTool } from "../src/tools/read-file.ts";
import { RESERVED_ARTIFACT_PATH_DETAIL } from "../src/tools/reserved-artifacts.ts";
import { readSkillResourceTool } from "../src/tools/read-skill-resource.ts";
import { runSkillScriptTool } from "../src/tools/run-skill-script.ts";
import {
  createWebFetchTool,
  toModelFacingWebFetchOutput,
} from "../src/tools/web-fetch.ts";
import { viewImageTool } from "../src/tools/view-image.ts";
import { writeFileTool } from "../src/tools/write-file.ts";
import type { HarnessToolContext } from "../src/tools/types.ts";
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
import { SandboxSessionUnavailableError } from "../src/sandbox/types.ts";

const ONE_PIXEL_PNG = decodeBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=",
);

const resolvePublicTestHost = () => Promise.resolve(["93.184.216.34"]);

interface FakeHttpConn {
  conn: Deno.Conn;
  writes: string[];
  isClosed: () => boolean;
}

const createFakeHttpConn = (responseText: string): FakeHttpConn => {
  const responseBytes = new TextEncoder().encode(responseText);
  const writes: string[] = [];
  let offset = 0;
  let closed = false;
  const conn = {
    read(buffer: Uint8Array): Promise<number | null> {
      if (closed) {
        return Promise.resolve(null);
      }
      if (offset >= responseBytes.byteLength) {
        return Promise.resolve(null);
      }
      const byteCount = Math.min(
        buffer.byteLength,
        responseBytes.byteLength - offset,
      );
      buffer.set(responseBytes.slice(offset, offset + byteCount));
      offset += byteCount;
      return Promise.resolve(byteCount);
    },
    write(buffer: Uint8Array): Promise<number> {
      writes.push(new TextDecoder().decode(buffer));
      return Promise.resolve(buffer.byteLength);
    },
    close(): void {
      closed = true;
    },
  } as unknown as Deno.Conn;
  return {
    conn,
    writes,
    isClosed: () => closed,
  };
};

const installMockDenoConnect = (
  connect: typeof Deno.connect,
): () => void => {
  const originalConnect = Deno.connect;
  Object.defineProperty(Deno, "connect", {
    configurable: true,
    writable: true,
    value: connect,
  });
  return () => {
    Object.defineProperty(Deno, "connect", {
      configurable: true,
      writable: true,
      value: originalConnect,
    });
  };
};

class FakeSandboxRuntime implements SandboxRuntime {
  readonly calls: Array<
    | { type: "run"; request: SandboxCommandRequest }
    | { type: "runShell"; request: SandboxShellRequest }
  > = [];

  readonly #shellResults: SandboxCommandResult[];

  constructor(
    shellResults: SandboxCommandResult[] = [{
      stdout: "",
      stderr: "",
      exitCode: 0,
    }],
  ) {
    this.#shellResults = shellResults;
  }

  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
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

  run(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    this.calls.push({ type: "run", request });
    return Promise.resolve(
      this.#shellResults.shift() ?? { stdout: "", stderr: "", exitCode: 0 },
    );
  }

  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    this.calls.push({ type: "runShell", request });
    return Promise.resolve(
      this.#shellResults.shift() ?? { stdout: "", stderr: "", exitCode: 0 },
    );
  }
}

class StrictFakeSandboxRuntime extends FakeSandboxRuntime {
  override resolvePath(path: string, cwd = this.defaultWorkingDirectory()) {
    const resolved = super.resolvePath(path, cwd);
    if (!this.isPathWithinWorkspace(resolved)) {
      throw new Error(`path escapes workspace root: ${resolved}`);
    }
    return resolved;
  }
}

class MultiRootFakeSandboxRuntime extends FakeSandboxRuntime {
  override isPathWithinAllowedRoots(path: string): boolean {
    return this.isPathWithinWorkspace(path) ||
      path === "/fabric" ||
      path.startsWith("/fabric/");
  }
}

class FakeProcessRunner implements ProcessRunner {
  readonly calls: ProcessRunRequest[] = [];

  readonly #results: ProcessRunResult[];

  constructor(
    results: ProcessRunResult[] = [{
      stdout: "",
      stderr: "",
      exitCode: 0,
    }],
  ) {
    this.#results = results;
  }

  run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(request);
    return Promise.resolve(
      this.#results.shift() ?? { stdout: "", stderr: "", exitCode: 0 },
    );
  }
}

const createContext = (
  sandbox: SandboxRuntime,
  initialCurrentDir = "/workspace",
  hostProcessRunner: ProcessRunner = new FakeProcessRunner(),
  cfcEnforcementMode: HarnessToolContext["cfcEnforcementMode"] = "observe",
  artifactRootHostPath?: string,
  skillRegistry?: HarnessSkillRegistry,
  skillResourceReads: HarnessSkillResourceRead[] = [],
  workspaceHostPath = "/tmp/cf-harness-workspace",
  skillActivations?: HarnessSkillActivations,
  allowedSkillScripts?: readonly HarnessAllowedSkillScript[],
  skillScriptExecutions: HarnessSkillScriptExecution[] = [],
  skillScriptExecutionTarget: HarnessToolContext["skillScriptExecutionTarget"] =
    "sandbox",
  browserAccess?: HarnessBrowserAccessLease,
  allowSkillScripts = false,
): HarnessToolContext => {
  let currentDir = initialCurrentDir;
  let sequence = 0;
  let cfcInvocationSequence = 0;
  return {
    runId: "run-1",
    cfcEnforcementMode,
    workspaceHostPath,
    skillRegistry,
    skillActivations,
    allowSkillScripts,
    allowedSkillScripts,
    skillScriptExecutionTarget,
    browserAccess,
    get currentDir() {
      return currentDir;
    },
    sandbox,
    hostProcessRunner,
    resolvePath(path: string) {
      return sandbox.resolvePath(path, currentDir);
    },
    resolveHostPath(path: string) {
      const sandboxPath = sandbox.resolvePath(path, currentDir);
      return sandboxPath === "/workspace"
        ? workspaceHostPath
        : `${workspaceHostPath}${sandboxPath.slice("/workspace".length)}`;
    },
    resolveHostRootPath(_path: string) {
      return workspaceHostPath;
    },
    isHostPathWithinWorkspace(path: string) {
      return Promise.resolve(
        path === workspaceHostPath ||
          path.startsWith(`${workspaceHostPath}/`),
      );
    },
    isHostPathWithinArtifactRoot(path: string) {
      return Promise.resolve(
        artifactRootHostPath !== undefined &&
          (path === artifactRootHostPath ||
            path.startsWith(`${artifactRootHostPath}/`)),
      );
    },
    doesHostPathIntersectArtifactRoot(path: string) {
      return Promise.resolve(
        artifactRootHostPath !== undefined &&
          (path === artifactRootHostPath ||
            path.startsWith(`${artifactRootHostPath}/`) ||
            artifactRootHostPath.startsWith(`${path}/`)),
      );
    },
    hostPathToWorkspacePath(path: string) {
      return path === workspaceHostPath
        ? "/workspace"
        : path.startsWith(`${workspaceHostPath}/`)
        ? `/workspace${path.slice(workspaceHostPath.length)}`
        : undefined;
    },
    setCurrentDir(path: string) {
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
    recordSkillScriptExecution(execution) {
      skillScriptExecutions.push(execution);
      return Promise.resolve();
    },
    createCfcInvocationContext(options) {
      cfcInvocationSequence += 1;
      return createHarnessCfcInvocationContext({
        sequence: cfcInvocationSequence,
        runId: "run-1",
        createdAt: "2026-04-30T00:00:00.000Z",
        cfcEnforcementMode,
        runManifest: { present: false },
        ...options,
      });
    },
  };
};

const stripCfcInvocationContexts = (
  calls: FakeSandboxRuntime["calls"],
): FakeSandboxRuntime["calls"] =>
  calls.map((call) => {
    if (call.type === "run") {
      const { cfcInvocationContext: _cfcInvocationContext, ...request } =
        call.request;
      return { type: "run", request };
    }
    const { cfcInvocationContext: _cfcInvocationContext, ...request } =
      call.request;
    return { type: "runShell", request };
  });

const observedCfcResult = (
  stdout: string,
  options: {
    stdoutLabel?: CfcSandboxResult["stdout"]["label"];
  } = {},
): CfcSandboxResult => ({
  version: 1,
  stdout: {
    channel: "stdout",
    policy: "observed",
    label: options.stdoutLabel ?? { confidentiality: ["public"] },
    segments: [{
      text: stdout,
      label: options.stdoutLabel ?? { confidentiality: ["public"] },
    }],
  },
  stderr: {
    channel: "stderr",
    policy: "observed",
    label: { confidentiality: ["public"] },
    segments: [{ text: "", label: { confidentiality: ["public"] } }],
  },
  exitCode: {
    policy: "observed",
    label: { confidentiality: ["public"] },
    value: 0,
  },
});

const digestText = async (text: string): Promise<string> => {
  const bytes = new TextEncoder().encode(text);
  const digestInput = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return `sha256:${
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }`;
};

Deno.test("bash tool executes the command through the sandbox shell runtime", async () => {
  const sandbox = new FakeSandboxRuntime([{
    stdout: "ok\n",
    stderr: "",
    exitCode: 0,
  }]);
  const context = createContext(sandbox);
  const output = await bashTool.invoke(context, {
    command: "pwd",
    cwd: "repo",
    timeoutMs: 1000,
  });

  assertEquals(output, {
    outputId: "run-1:bash:1",
    stdout: "ok\n",
    stderr: "",
    exitCode: 0,
    cwd: "/workspace/repo",
  });
  assertEquals(stripCfcInvocationContexts(sandbox.calls), [{
    type: "runShell",
    request: {
      command: [
        '__cf_harness_cwd_marker="__CF_HARNESS_CWD__run-1:bash:1__"',
        'trap \'__cf_harness_status=$?; trap - EXIT; { printf "%s%s" "$__cf_harness_cwd_marker" "$(pwd)" || true; }; exit "$__cf_harness_status"\' EXIT',
        "pwd",
      ].join("\n"),
      cwd: "/workspace/repo",
      timeoutMs: 1000,
    },
  }]);
  assertEquals(
    sandbox.calls[0]?.request.cfcInvocationContext?.toolOutputId,
    "run-1:bash:1",
  );
  assertEquals(
    sandbox.calls[0]?.request.cfcInvocationContext?.inputs.command?.bytes,
    [
      '__cf_harness_cwd_marker="__CF_HARNESS_CWD__run-1:bash:1__"',
      'trap \'__cf_harness_status=$?; trap - EXIT; { printf "%s%s" "$__cf_harness_cwd_marker" "$(pwd)" || true; }; exit "$__cf_harness_status"\' EXIT',
      "pwd",
    ].join("\n").length,
  );
  assertEquals(context.currentDir, "/workspace/repo");
});

//
// recoverable vs fatal tool-boundary narrowing (D9 / cf-review)
//

Deno.test("bash tool: a SandboxPathEscapeError on cwd is a recoverable result, not a throw", async () => {
  class PathEscapeSandbox extends FakeSandboxRuntime {
    override resolvePath(path: string, cwd = this.defaultWorkingDirectory()) {
      if (!this.isPathWithinWorkspace(path)) {
        throw new SandboxPathEscapeError(
          path,
          `path escapes workspace root: ${path}`,
        );
      }
      return super.resolvePath(path, cwd);
    }
  }
  const sandbox = new PathEscapeSandbox();
  const context = createContext(sandbox);
  const output = await bashTool.invoke(context, { command: "ls", cwd: "/etc" });

  assertEquals(output.exitCode, BASH_CWD_OUTSIDE_SANDBOX_EXIT_CODE);
  assertStringIncludes(
    output.stderr,
    `${BASH_CWD_OUTSIDE_SANDBOX_PREFIX}: /etc`,
  );
  // The raw escape message (carrying the sandbox root label) never leaks.
  assertEquals(output.stderr.includes("path escapes"), false);
  // The command never ran and the working directory is unchanged.
  assertEquals(sandbox.calls.length, 0);
  assertEquals(output.cwd, "/workspace");
});

Deno.test("bash tool: a non-escape resolvePath failure stays fatal (rethrows)", async () => {
  class CorruptResolveSandbox extends FakeSandboxRuntime {
    override resolvePath(): string {
      // NOT a path escape — a corrupt-runtime/invariant failure that must not
      // be laundered into a recoverable "cwd outside sandbox" result.
      throw new Error("sandbox runtime invariant violated: /Users/ben/.secret");
    }
  }
  const context = createContext(new CorruptResolveSandbox());
  await assertRejects(
    () => bashTool.invoke(context, { command: "ls", cwd: "repo" }),
    Error,
    "sandbox runtime invariant violated",
  );
});

Deno.test("bash tool: a ProcessTimeoutError from runShell is a recoverable result", async () => {
  class TimeoutRunShellSandbox extends FakeSandboxRuntime {
    override runShell(): Promise<SandboxCommandResult> {
      return Promise.reject(
        new ProcessTimeoutError("bash -lc 'sleep 40'", 20_000),
      );
    }
  }
  const context = createContext(new TimeoutRunShellSandbox());
  const output = await bashTool.invoke(context, {
    command: "sleep 40",
    timeoutMs: 20_000,
  });

  assertEquals(output.exitCode, BASH_TIMEOUT_EXIT_CODE);
  assertStringIncludes(output.stderr, "command timed out after 20000ms");
  // Never the raw exception text ("process timed out after ...: <command>").
  assertEquals(output.stderr.includes("process timed out after"), false);
});

Deno.test("bash tool: a ProcessTimeoutError during CFC-context setup stays fatal", async () => {
  const sandbox = new FakeSandboxRuntime();
  const context = createContext(sandbox);
  // The invocation context is built (and run state persisted) BEFORE runShell.
  // A timeout raised there is a persistence failure, not a command timeout, and
  // must stay run-fatal rather than be misreported as a recoverable timeout.
  context.createCfcInvocationContext = () => {
    throw new ProcessTimeoutError("persist-run-state", 5);
  };
  await assertRejects(
    () => bashTool.invoke(context, { command: "ls" }),
    ProcessTimeoutError,
  );
  // runShell was never reached.
  assertEquals(sandbox.calls.length, 0);
});

Deno.test("bash tool preserves currentDir inside a configured Fabric mount", async () => {
  const sandbox = new MultiRootFakeSandboxRuntime([{
    stdout: "__CF_HARNESS_CWD__run-1:bash:1__/fabric/home",
    stderr: "",
    exitCode: 0,
  }]);
  const context = createContext(sandbox);
  const output = await bashTool.invoke(context, {
    command: "cd /fabric/home",
  });

  assertEquals(output.cwd, "/fabric/home");
  assertEquals(context.currentDir, "/fabric/home");
});

Deno.test("bash tool allows curl to localhost through the sandbox shell runtime", async () => {
  const sandbox = new FakeSandboxRuntime([{
    stdout: "pong\n",
    stderr: "",
    exitCode: 0,
  }]);
  const context = createContext(sandbox);
  const output = await bashTool.invoke(context, {
    command: "curl -fsS http://localhost:8000/health",
  });

  assertEquals(output.stdout, "pong\n");
  assertEquals(stripCfcInvocationContexts(sandbox.calls), [{
    type: "runShell",
    request: {
      command: [
        '__cf_harness_cwd_marker="__CF_HARNESS_CWD__run-1:bash:1__"',
        'trap \'__cf_harness_status=$?; trap - EXIT; { printf "%s%s" "$__cf_harness_cwd_marker" "$(pwd)" || true; }; exit "$__cf_harness_status"\' EXIT',
        "curl -fsS http://localhost:8000/health",
      ].join("\n"),
      cwd: "/workspace",
      timeoutMs: undefined,
    },
  }]);
});

Deno.test("bash tool denies curl to non-localhost targets before sandbox execution", async () => {
  const sandbox = new FakeSandboxRuntime();
  const context = createContext(sandbox, "/workspace/old");
  const output = await bashTool.invoke(context, {
    command: "curl https://example.com",
    cwd: "/workspace/new",
  });

  assertEquals(output, {
    outputId: "run-1:bash:1",
    stdout: "",
    stderr:
      "bash command denied: curl host example.com is not allowed from cf-harness bash; use localhost or host.docker.internal",
    exitCode: 126,
    cwd: "/workspace/new",
  });
  assertEquals(sandbox.calls, []);
  assertEquals(context.currentDir, "/workspace/new");
});

Deno.test("web_fetch fetches public HTML, extracts text and links, and strips raw content from model output", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const html = [
    "<!doctype html>",
    "<title>Example &amp; Test</title>",
    "<style>.hidden{display:none}</style>",
    "<script>ignoreMe()</script>",
    "<h1>Hello <em>world</em></h1>",
    '<p>Read <a href="/next">next page</a>.</p>',
  ].join("");
  const tool = createWebFetchTool({
    resolveHostAddresses: resolvePublicTestHost,
    fetchFn: (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(
        new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    },
  });
  const context = createContext(new FakeSandboxRuntime());

  const output = await tool.invoke(context, {
    url: "https://example.com/start",
  });

  if (output.type !== "cf-harness.web-fetch-result") {
    throw new Error("expected web_fetch success");
  }
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.url, "https://example.com/start");
  assertEquals(calls[0]?.init?.redirect, "manual");
  assertEquals(output.outputId, "run-1:web_fetch:1");
  assertEquals(output.finalUrl, "https://example.com/start");
  assertEquals(output.title, "Example & Test");
  assertStringIncludes(output.text, "Hello world");
  assertStringIncludes(output.text, "Read next page .");
  assertEquals(output.links, [{
    text: "next page",
    href: "https://example.com/next",
  }]);
  assertStringIncludes(output.rawContent, "<script>ignoreMe()</script>");
  assertEquals(output.rawContentDigest, await digestText(html));
  assertEquals("rawContent" in toModelFacingWebFetchOutput(output), false);
});

Deno.test("web_fetch blocks localhost targets before fetching", async () => {
  const calls: string[] = [];
  const tool = createWebFetchTool({
    fetchFn: (input) => {
      calls.push(String(input));
      return Promise.resolve(new Response("should not fetch"));
    },
  });
  const context = createContext(new FakeSandboxRuntime());

  const output = await tool.invoke(context, {
    url: "http://localhost:8000/private",
  });

  assertEquals(calls, []);
  assertEquals(output, {
    type: "cf-harness.web-fetch-error",
    outputId: "run-1:web_fetch:1",
    url: "http://localhost:8000/private",
    code: "blocked_url",
    message: "web_fetch host localhost is local and is not allowed",
    fetchedAt: "2026-05-01T17:54:00.000Z",
  });
});

Deno.test("web_fetch validates redirect targets before following them", async () => {
  const tool = createWebFetchTool({
    resolveHostAddresses: resolvePublicTestHost,
    fetchFn: () =>
      Promise.resolve(
        new Response("", {
          status: 302,
          headers: { location: "http://127.0.0.1/admin" },
        }),
      ),
  });
  const context = createContext(new FakeSandboxRuntime());

  const output = await tool.invoke(context, {
    url: "https://example.com/login",
  });

  assertEquals(output, {
    type: "cf-harness.web-fetch-error",
    outputId: "run-1:web_fetch:1",
    url: "https://example.com/login",
    code: "blocked_url",
    message:
      "web_fetch redirect target denied: web_fetch host 127.0.0.1 is private and is not allowed",
    finalUrl: "https://example.com/login",
    fetchedAt: "2026-05-01T17:54:00.000Z",
  });
});

Deno.test("web_fetch rejects DNS targets that resolve to private addresses before fetching", async () => {
  const calls: string[] = [];
  const tool = createWebFetchTool({
    resolveHostAddresses: () => Promise.resolve(["10.0.0.7"]),
    fetchFn: (input) => {
      calls.push(String(input));
      return Promise.resolve(new Response("should not fetch"));
    },
  });
  const context = createContext(new FakeSandboxRuntime());

  const output = await tool.invoke(context, {
    url: "https://public.example/private",
  });

  assertEquals(calls, []);
  assertEquals(output, {
    type: "cf-harness.web-fetch-error",
    outputId: "run-1:web_fetch:1",
    url: "https://public.example/private",
    code: "blocked_url",
    message:
      "web_fetch host public.example resolved to private address 10.0.0.7 and is not allowed",
    fetchedAt: "2026-05-01T17:54:00.000Z",
  });
});

Deno.test("web_fetch rejects DNS rebinding between validation and connect", async () => {
  const resolutions = [["93.184.216.34"], ["10.0.0.7"]];
  const tool = createWebFetchTool({
    resolveHostAddresses: () =>
      Promise.resolve(resolutions.shift() ?? ["93.184.216.34"]),
  });
  const context = createContext(new FakeSandboxRuntime());

  const output = await tool.invoke(context, {
    url: "https://rebind.example/private",
  });

  assertEquals(output, {
    type: "cf-harness.web-fetch-error",
    outputId: "run-1:web_fetch:1",
    url: "https://rebind.example/private",
    code: "blocked_url",
    message:
      "web_fetch host rebind.example resolved to private address 10.0.0.7 and is not allowed",
    finalUrl: "https://rebind.example/private",
    fetchedAt: "2026-05-01T17:54:00.000Z",
  });
});

Deno.test("web_fetch rejects non-global IP literals before fetching", async () => {
  const cases = [
    "http://100.64.0.1/",
    "http://192.0.2.1/",
    "http://198.18.0.1/",
    "http://224.0.0.1/",
    "http://240.0.0.1/",
    "http://[::ffff:7f00:1]/",
    "http://[2001:db8::1]/",
    "http://[64:ff9b::a00:1]/",
  ];
  for (const url of cases) {
    const calls: string[] = [];
    const tool = createWebFetchTool({
      fetchFn: (input) => {
        calls.push(String(input));
        return Promise.resolve(new Response("should not fetch"));
      },
    });
    const context = createContext(new FakeSandboxRuntime());

    const output = await tool.invoke(context, { url });

    assertEquals(calls, []);
    if (output.type !== "cf-harness.web-fetch-error") {
      throw new Error(`expected web_fetch error for ${url}`);
    }
    assertEquals(output.code, "blocked_url");
    assertStringIncludes(output.message, "is private and is not allowed");
  }
});

Deno.test("web_fetch rejects unsupported content types without returning the body", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("png bytes"));
    },
    cancel() {
      canceled = true;
    },
  });
  const tool = createWebFetchTool({
    resolveHostAddresses: resolvePublicTestHost,
    fetchFn: () =>
      Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      ),
  });
  const context = createContext(new FakeSandboxRuntime());

  const output = await tool.invoke(context, {
    url: "https://example.com/image.png",
  });

  assertEquals(output, {
    type: "cf-harness.web-fetch-error",
    outputId: "run-1:web_fetch:1",
    url: "https://example.com/image.png",
    code: "unsupported_content_type",
    message: "web_fetch content-type image/png is not supported",
    finalUrl: "https://example.com/image.png",
    status: 200,
    contentType: "image/png",
    fetchedAt: "2026-05-01T17:54:00.000Z",
  });
  assertEquals(canceled, true);
});

Deno.test("web_fetch rejects responses without a supported content-type", async () => {
  const tool = createWebFetchTool({
    resolveHostAddresses: resolvePublicTestHost,
    fetchFn: () =>
      Promise.resolve(
        new Response(new TextEncoder().encode("headerless text"), {
          status: 200,
        }),
      ),
  });
  const context = createContext(new FakeSandboxRuntime());

  const output = await tool.invoke(context, {
    url: "https://example.com/headerless",
  });

  assertEquals(output, {
    type: "cf-harness.web-fetch-error",
    outputId: "run-1:web_fetch:1",
    url: "https://example.com/headerless",
    code: "unsupported_content_type",
    message: "web_fetch response did not include a supported text content-type",
    finalUrl: "https://example.com/headerless",
    status: 200,
    fetchedAt: "2026-05-01T17:54:00.000Z",
  });
});

Deno.test("web_fetch caps raw bytes and model text independently", async () => {
  const tool = createWebFetchTool({
    resolveHostAddresses: resolvePublicTestHost,
    fetchFn: () =>
      Promise.resolve(
        new Response("abcdef", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      ),
  });
  const context = createContext(new FakeSandboxRuntime());

  const output = await tool.invoke(context, {
    url: "https://example.com/large.txt",
    maxBytes: 3,
    maxTextChars: 2,
  });

  if (output.type !== "cf-harness.web-fetch-result") {
    throw new Error("expected web_fetch success");
  }
  assertEquals(output.bytes, 3);
  assertEquals(output.rawContent, "abc");
  assertEquals(output.rawContentTruncated, true);
  assertEquals(output.text, "ab");
  assertEquals(output.textTruncated, true);
});

Deno.test("web_fetch applies timeout while reading response body", async () => {
  const encoder = new TextEncoder();
  const tool = createWebFetchTool({
    resolveHostAddresses: resolvePublicTestHost,
    fetchFn: (_input, init) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        throw new Error("expected fetch signal");
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("partial"));
        },
        pull() {
          return new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      );
    },
  });
  const context = createContext(new FakeSandboxRuntime());

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const output = await Promise.race([
    tool.invoke(context, {
      url: "https://example.com/slow.txt",
      timeoutMs: 20,
    }),
    new Promise<never>((_, reject) => {
      watchdog = setTimeout(
        () => reject(new Error("web_fetch did not time out body read")),
        1_000,
      );
    }),
  ]).finally(() => {
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
    }
  });

  assertEquals(output, {
    type: "cf-harness.web-fetch-error",
    outputId: "run-1:web_fetch:1",
    url: "https://example.com/slow.txt",
    code: "timeout",
    message: "web_fetch timed out",
    fetchedAt: "2026-05-01T17:54:00.000Z",
  });
});

Deno.test("web_fetch applies timeout while resolving host", async () => {
  const tool = createWebFetchTool({
    resolveHostAddresses: () => new Promise(() => {}),
  });
  const context = createContext(new FakeSandboxRuntime());

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const output = await Promise.race([
    tool.invoke(context, {
      url: "https://slow.example/resolve",
      timeoutMs: 20,
    }),
    new Promise<never>((_, reject) => {
      watchdog = setTimeout(
        () => reject(new Error("web_fetch did not time out DNS resolution")),
        1_000,
      );
    }),
  ]).finally(() => {
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
    }
  });

  assertEquals(output, {
    type: "cf-harness.web-fetch-error",
    outputId: "run-1:web_fetch:1",
    url: "https://slow.example/resolve",
    code: "timeout",
    message: "web_fetch timed out",
    fetchedAt: "2026-05-01T17:54:00.000Z",
  });
});

Deno.test("web_fetch applies timeout while validating redirect target", async () => {
  const tool = createWebFetchTool({
    resolveHostAddresses: (hostname) => {
      if (hostname === "slow.example") {
        return new Promise(() => {});
      }
      return resolvePublicTestHost();
    },
    fetchFn: () =>
      Promise.resolve(
        new Response("", {
          status: 302,
          headers: { location: "https://slow.example/" },
        }),
      ),
  });
  const context = createContext(new FakeSandboxRuntime());

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const output = await Promise.race([
    tool.invoke(context, {
      url: "https://example.com/start",
      timeoutMs: 20,
    }),
    new Promise<never>((_, reject) => {
      watchdog = setTimeout(
        () =>
          reject(
            new Error("web_fetch did not time out redirect DNS resolution"),
          ),
        1_000,
      );
    }),
  ]).finally(() => {
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
    }
  });

  assertEquals(output, {
    type: "cf-harness.web-fetch-error",
    outputId: "run-1:web_fetch:1",
    url: "https://example.com/start",
    code: "timeout",
    message: "web_fetch timed out",
    fetchedAt: "2026-05-01T17:54:00.000Z",
  });
});

Deno.test("web_fetch applies timeout while connecting", async () => {
  let sawConnectSignal = false;
  const restoreConnect = installMockDenoConnect(
    ((options: Deno.ConnectOptions) => {
      sawConnectSignal = options.signal instanceof AbortSignal;
      return new Promise(() => {});
    }) as unknown as typeof Deno.connect,
  );
  const tool = createWebFetchTool({
    resolveHostAddresses: resolvePublicTestHost,
  });
  const context = createContext(new FakeSandboxRuntime());

  try {
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const output = await Promise.race([
      tool.invoke(context, {
        url: "http://example.com/connect",
        timeoutMs: 20,
      }),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(
          () => reject(new Error("web_fetch did not time out connect")),
          1_000,
        );
      }),
    ]).finally(() => {
      if (watchdog !== undefined) {
        clearTimeout(watchdog);
      }
    });

    assertEquals(sawConnectSignal, true);
    assertEquals(output, {
      type: "cf-harness.web-fetch-error",
      outputId: "run-1:web_fetch:1",
      url: "http://example.com/connect",
      code: "timeout",
      message: "web_fetch timed out",
      fetchedAt: "2026-05-01T17:54:00.000Z",
    });
  } finally {
    restoreConnect();
  }
});

Deno.test("web_fetch applies timeout while writing the request", async () => {
  let closed = false;
  const conn = {
    read(): Promise<number | null> {
      return Promise.resolve(null);
    },
    write(): Promise<number> {
      return new Promise(() => {});
    },
    close(): void {
      closed = true;
    },
  } as unknown as Deno.Conn;
  const restoreConnect = installMockDenoConnect(
    (() => Promise.resolve(conn)) as unknown as typeof Deno.connect,
  );
  const tool = createWebFetchTool({
    resolveHostAddresses: resolvePublicTestHost,
  });
  const context = createContext(new FakeSandboxRuntime());

  try {
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const output = await Promise.race([
      tool.invoke(context, {
        url: "http://example.com/write",
        timeoutMs: 20,
      }),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(
          () => reject(new Error("web_fetch did not time out request write")),
          1_000,
        );
      }),
    ]).finally(() => {
      if (watchdog !== undefined) {
        clearTimeout(watchdog);
      }
    });

    assertEquals(output, {
      type: "cf-harness.web-fetch-error",
      outputId: "run-1:web_fetch:1",
      url: "http://example.com/write",
      code: "timeout",
      message: "web_fetch timed out",
      fetchedAt: "2026-05-01T17:54:00.000Z",
    });
    assertEquals(closed, true);
  } finally {
    restoreConnect();
  }
});

Deno.test("web_fetch rejects oversized chunked size lines", async () => {
  const fakeConn = createFakeHttpConn([
    "HTTP/1.1 200 OK\r\n",
    "Content-Type: text/plain\r\n",
    "Transfer-Encoding: chunked\r\n",
    "\r\n",
    "1".repeat(5000),
  ].join(""));
  const restoreConnect = installMockDenoConnect(
    (() => Promise.resolve(fakeConn.conn)) as unknown as typeof Deno.connect,
  );
  const tool = createWebFetchTool({
    resolveHostAddresses: resolvePublicTestHost,
  });
  const context = createContext(new FakeSandboxRuntime());

  try {
    const output = await tool.invoke(context, {
      url: "http://example.com/chunked",
    });

    if (output.type !== "cf-harness.web-fetch-error") {
      throw new Error("expected web_fetch error");
    }
    assertEquals(output.code, "fetch_failed");
    assertStringIncludes(output.message, "chunked line exceeded size limit");
    assertEquals(fakeConn.isClosed(), true);
  } finally {
    restoreConnect();
  }
});

Deno.test("web_fetch rejects oversized chunked trailers", async () => {
  const trailers = Array.from(
    { length: 90 },
    (_, index) => `X-Trailer-${index}: ${"a".repeat(200)}\r\n`,
  ).join("");
  const fakeConn = createFakeHttpConn([
    "HTTP/1.1 200 OK\r\n",
    "Content-Type: text/plain\r\n",
    "Transfer-Encoding: chunked\r\n",
    "\r\n",
    "1\r\n",
    "a\r\n",
    "0\r\n",
    trailers,
    "\r\n",
  ].join(""));
  const restoreConnect = installMockDenoConnect(
    (() => Promise.resolve(fakeConn.conn)) as unknown as typeof Deno.connect,
  );
  const tool = createWebFetchTool({
    resolveHostAddresses: resolvePublicTestHost,
  });
  const context = createContext(new FakeSandboxRuntime());

  try {
    const output = await tool.invoke(context, {
      url: "http://example.com/chunked-trailers",
    });

    if (output.type !== "cf-harness.web-fetch-error") {
      throw new Error("expected web_fetch error");
    }
    assertEquals(output.code, "fetch_failed");
    assertStringIncludes(
      output.message,
      "chunked trailers exceeded size limit",
    );
    assertEquals(fakeConn.isClosed(), true);
  } finally {
    restoreConnect();
  }
});

Deno.test("bash tool updates currentDir in enforce mode from observed CFC stdout", async () => {
  const outputId = createToolOutputId("run-1", "bash", 1);
  const cwdMarker = `__CF_HARNESS_CWD__${outputId}__`;
  const sandbox = new FakeSandboxRuntime([{
    stdout: `raw public\n${cwdMarker}/workspace/repo`,
    stderr: "",
    exitCode: 0,
    cfcResult: observedCfcResult(`public\n${cwdMarker}/workspace/repo`),
  }]);
  const context = createContext(
    sandbox,
    "/workspace",
    new FakeProcessRunner(),
    "enforce-explicit",
  );

  const output = await bashTool.invoke(context, {
    command: "cd repo",
  });

  assertEquals(output.cwd, "/workspace/repo");
  assertEquals(context.currentDir, "/workspace/repo");
  assertEquals(output.stdout, `raw public\n${cwdMarker}/workspace/repo`);
});

const BROWSER_LEASE = {
  type: "cf-harness.chat.browser-access-lease",
  leaseId: "lease-1",
  cdpUrl: "http://localhost:9362",
} as const;

const createBrowserContext = (
  hostRunner: ProcessRunner,
  browserAccess?: HarnessBrowserAccessLease,
): HarnessToolContext =>
  createContext(
    new FakeSandboxRuntime(),
    "/workspace/repo",
    hostRunner,
    "observe",
    undefined,
    undefined,
    [],
    "/tmp/cf-harness-workspace",
    undefined,
    undefined,
    [],
    "sandbox",
    browserAccess,
  );

Deno.test("browser tool runs one agent-browser action attached to the lease endpoint", async () => {
  const hostRunner = new FakeProcessRunner([{
    stdout: '- heading "Example"\n',
    stderr: "",
    exitCode: 0,
  }]);
  const context = createBrowserContext(hostRunner, BROWSER_LEASE);

  const output = await browserTool.invoke(context, {
    action: "snapshot",
    interactive: true,
    timeoutMs: 1000,
  });

  assertEquals(output, {
    outputId: "run-1:browser:1",
    status: "ok",
    output: '- heading "Example"\n',
  });
  assertEquals(hostRunner.calls, [{
    command: "agent-browser",
    args: ["--cdp", "http://localhost:9362", "snapshot", "-i"],
    cwd: "/tmp/cf-harness-workspace",
    clearEnv: true,
    env: { PATH: hostRunner.calls[0]!.env!.PATH },
    timeoutMs: 1000,
  }]);
});

Deno.test("browser tool surfaces success-path stderr as detail", async () => {
  const hostRunner = new FakeProcessRunner([{
    stdout: "https://example.com/\n",
    stderr: "warning: slow page\n",
    exitCode: 0,
  }]);
  const context = createBrowserContext(hostRunner, BROWSER_LEASE);

  const output = await browserTool.invoke(context, {
    action: "get",
    kind: "url",
  });

  assertEquals(output, {
    outputId: "run-1:browser:1",
    status: "ok",
    output: "https://example.com/\n",
    detail: "warning: slow page",
  });
});

Deno.test("browser tool refuses an action when the run has no Browser Access lease", async () => {
  const hostRunner = new FakeProcessRunner();
  const context = createBrowserContext(hostRunner, undefined);

  const output = await browserTool.invoke(context, {
    action: "open",
    url: "https://example.com/",
  });

  assertEquals(hostRunner.calls, []);
  assertEquals(output, {
    outputId: "run-1:browser:1",
    status: "error",
    code: "lease_unavailable",
    message: "browser requires a Browser Access lease, and this run has none",
  });
});

Deno.test("browser tool refuses an expired Browser Access lease", async () => {
  const hostRunner = new FakeProcessRunner();
  const context = createBrowserContext(hostRunner, {
    ...BROWSER_LEASE,
    expiresAt: "2000-01-01T00:00:00.000Z",
  });

  const output = await browserTool.invoke(context, {
    action: "snapshot",
  });

  assertEquals(hostRunner.calls, []);
  assertEquals(output, {
    outputId: "run-1:browser:1",
    status: "error",
    code: "lease_unavailable",
    message: "Browser Access lease has expired",
  });
});

Deno.test("browser tool refuses a lease whose CDP endpoint is not a local origin", async () => {
  const hostRunner = new FakeProcessRunner();
  const context = createBrowserContext(hostRunner, {
    ...BROWSER_LEASE,
    cdpUrl: "http://browser.example.com:9362",
  });

  const output = await browserTool.invoke(context, {
    action: "snapshot",
  });

  assertEquals(hostRunner.calls, []);
  assertEquals(output, {
    outputId: "run-1:browser:1",
    status: "error",
    code: "lease_unavailable",
    message: "configured Browser Access CDP endpoint is invalid",
  });
});

Deno.test("browser tool refuses input outside its action vocabulary before touching the host", async () => {
  const hostRunner = new FakeProcessRunner();
  const context = createBrowserContext(hostRunner, BROWSER_LEASE);

  const evalOutput = await browserTool.invoke(context, {
    action: "eval",
  });
  const mixedOutput = await browserTool.invoke(context, {
    action: "snapshot",
    url: "https://example.com/",
  });

  assertEquals(hostRunner.calls, []);
  assertEquals(evalOutput.status, "error");
  assertEquals(
    (evalOutput as { code?: string }).code,
    "invalid_input",
  );
  assertEquals(mixedOutput, {
    outputId: "run-1:browser:2",
    status: "error",
    code: "invalid_input",
    message: "url does not apply to the snapshot action",
  });
});

Deno.test("browser tool defaults and caps host timeouts", async () => {
  const hostRunner = new FakeProcessRunner([
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
  ]);
  const context = createBrowserContext(hostRunner, BROWSER_LEASE);

  await browserTool.invoke(context, { action: "snapshot" });
  await browserTool.invoke(context, {
    action: "snapshot",
    timeoutMs: 999_999,
  });

  assertEquals(hostRunner.calls.map((call) => call.timeoutMs), [
    30_000,
    120_000,
  ]);
});

Deno.test("browser tool caps returned output", async () => {
  const hostRunner = new FakeProcessRunner([{
    stdout: "x".repeat(20_010),
    stderr: "",
    exitCode: 0,
  }]);
  const context = createBrowserContext(hostRunner, BROWSER_LEASE);

  const output = await browserTool.invoke(context, { action: "console" });

  assertEquals(output, {
    outputId: "run-1:browser:1",
    status: "ok",
    output: `${
      "x".repeat(20_000)
    }\n[cf-harness truncated output: 10 chars omitted]`,
  });
});

Deno.test("browser tool reports a nonzero exit as command_failed with the failure text", async () => {
  const hostRunner = new FakeProcessRunner([{
    stdout: "",
    stderr: "error: ref @e5 not found\n",
    exitCode: 1,
  }]);
  const context = createBrowserContext(hostRunner, BROWSER_LEASE);

  const output = await browserTool.invoke(context, {
    action: "click",
    ref: "@e5",
  });

  assertEquals(output, {
    outputId: "run-1:browser:1",
    status: "error",
    code: "command_failed",
    message: "error: ref @e5 not found\n",
    exitCode: 1,
  });
});

Deno.test("browser tool falls back to resolving the current dir when no workspace host path is known", async () => {
  const hostRunner = new FakeProcessRunner([{
    stdout: "",
    stderr: "",
    exitCode: 0,
  }]);
  const context = {
    ...createBrowserContext(hostRunner, BROWSER_LEASE),
    workspaceHostPath: undefined,
    resolveHostPath: () => "/host/resolved",
  };

  const output = await browserTool.invoke(context, { action: "errors" });

  assertEquals(output.status, "ok");
  assertEquals(hostRunner.calls[0]?.cwd, "/host/resolved");
});

Deno.test("browser tool reports a missing host mount as host_unavailable", async () => {
  const hostRunner = new FakeProcessRunner();
  const context = {
    ...createBrowserContext(hostRunner, BROWSER_LEASE),
    workspaceHostPath: undefined,
    resolveHostPath: (): string => {
      throw new Error("host execution requires a host mount path");
    },
  };

  const output = await browserTool.invoke(context, { action: "errors" });

  assertEquals(hostRunner.calls, []);
  assertEquals(output, {
    outputId: "run-1:browser:1",
    status: "error",
    code: "host_unavailable",
    message: "browser requires a host-mounted workspace to run against",
  });
});

Deno.test("browser tool reports a spawn failure as host_unavailable", async () => {
  const hostRunner: ProcessRunner = {
    run() {
      return Promise.reject(new Error("No such file or directory"));
    },
  };
  const context = createBrowserContext(hostRunner, BROWSER_LEASE);

  const output = await browserTool.invoke(context, { action: "snapshot" });

  assertEquals(output, {
    outputId: "run-1:browser:1",
    status: "error",
    code: "host_unavailable",
    message: "agent-browser could not run: No such file or directory",
  });
});

Deno.test("browser tool scrubs the lease endpoint from a timeout error", async () => {
  const hostRunner: ProcessRunner = {
    run(request) {
      return Promise.reject(
        new ProcessTimeoutError(
          [request.command, ...request.args].join(" "),
          request.timeoutMs ?? 0,
        ),
      );
    },
  };
  const context = createBrowserContext(hostRunner, BROWSER_LEASE);

  const output = await browserTool.invoke(context, {
    action: "snapshot",
    timeoutMs: 0,
  });

  assertEquals(output, {
    outputId: "run-1:browser:1",
    status: "error",
    code: "host_unavailable",
    message:
      "agent-browser could not run: process timed out after 0ms: agent-browser --cdp <lease endpoint> snapshot",
  });
});

Deno.test("browser tool scrubs the lease endpoint from what the browser prints", async () => {
  const hostRunner = new FakeProcessRunner([
    {
      stdout: "connected to http://localhost:9362 for page\n",
      stderr: "warning: http://localhost:9362 slow\n",
      exitCode: 0,
    },
    {
      stdout: "",
      stderr: "could not reach http://localhost:9362\n",
      exitCode: 1,
    },
  ]);
  const context = createBrowserContext(hostRunner, BROWSER_LEASE);

  const okOutput = await browserTool.invoke(context, { action: "console" });
  const failedOutput = await browserTool.invoke(context, {
    action: "console",
  });

  assertEquals(okOutput, {
    outputId: "run-1:browser:1",
    status: "ok",
    output: "connected to <lease endpoint> for page\n",
    detail: "warning: <lease endpoint> slow",
  });
  assertEquals(failedOutput, {
    outputId: "run-1:browser:2",
    status: "error",
    code: "command_failed",
    message: "could not reach <lease endpoint>\n",
    exitCode: 1,
  });
});

Deno.test("read_file tool resolves relative paths from the session currentDir", async () => {
  const sandbox = new FakeSandboxRuntime([{
    stdout: "hello",
    stderr: "",
    exitCode: 0,
  }]);
  const output = await readFileTool.invoke(
    createContext(sandbox, "/workspace/.ops"),
    {
      path: "../notes/todo.txt",
      maxBytes: 32,
    },
  );

  assertEquals(output, {
    outputId: "run-1:read_file:1",
    path: "/workspace/notes/todo.txt",
    content: "hello",
  });
  assertEquals(stripCfcInvocationContexts(sandbox.calls)[0], {
    type: "runShell",
    request: {
      command: [
        "set -eu",
        'if [ ! -e "$1" ]; then',
        '  echo "file not found: $1" >&2',
        "  exit 10",
        "fi",
        'if [ ! -f "$1" ]; then',
        '  echo "not a file: $1" >&2',
        "  exit 11",
        "fi",
        'if [ -n "$2" ]; then',
        '  exec head -c "$2" "$1"',
        "fi",
        'exec cat "$1"',
      ].join("\n"),
      args: ["/workspace/notes/todo.txt", "32"],
      cwd: "/workspace/.ops",
    },
  });
  assertEquals(
    sandbox.calls[0]?.request.cfcInvocationContext?.toolId,
    "read_file",
  );
  assertEquals(
    sandbox.calls[0]?.request.cfcInvocationContext?.inputs.args?.count,
    2,
  );
  assertEquals(
    sandbox.calls[0]?.request.cfcInvocationContext?.cwd,
    "/workspace/.ops",
  );
});

Deno.test("read_file tool preserves CFC result on success", async () => {
  const cfcResult = observedCfcResult("released file");
  const sandbox = new FakeSandboxRuntime([{
    stdout: "raw file",
    stderr: "",
    exitCode: 0,
    cfcResult,
  }]);

  const output = await readFileTool.invoke(createContext(sandbox), {
    path: "notes/todo.txt",
  });

  assertEquals(output, {
    outputId: "run-1:read_file:1",
    path: "/workspace/notes/todo.txt",
    content: "raw file",
    cfcResult,
  });
});

Deno.test("read_file tool rejects non-integer maxBytes", async () => {
  const sandbox = new FakeSandboxRuntime();

  await assertRejects(
    () =>
      readFileTool.invoke(createContext(sandbox), {
        path: "notes/todo.txt",
        maxBytes: 1.5,
      }),
    Error,
    "read_file maxBytes must be a non-negative integer",
  );

  assertEquals(sandbox.calls, []);
});

Deno.test("read_file tool returns a recoverable file_not_found result", async () => {
  const sandbox = new FakeSandboxRuntime([{
    stdout: "",
    stderr: "file not found: /workspace/notes/missing.txt",
    exitCode: 10,
  }]);

  const output = await readFileTool.invoke(createContext(sandbox), {
    path: "notes/missing.txt",
  });

  assertEquals(output, {
    outputId: "run-1:read_file:1",
    path: "/workspace/notes/missing.txt",
    ok: false,
    error: {
      type: "cf-harness.structured-file-tool-error",
      code: "file_not_found",
      message: "file not found: /workspace/notes/missing.txt",
      path: "/workspace/notes/missing.txt",
      detail: "file not found: /workspace/notes/missing.txt",
      exitCode: 10,
    },
  });
});

Deno.test("read_file tool returns a recoverable not_a_file result", async () => {
  const sandbox = new FakeSandboxRuntime([{
    stdout: "",
    stderr: "not a file: /workspace/notes",
    exitCode: 11,
  }]);

  const output = await readFileTool.invoke(createContext(sandbox), {
    path: "notes",
  });

  assertEquals(output, {
    outputId: "run-1:read_file:1",
    path: "/workspace/notes",
    ok: false,
    error: {
      type: "cf-harness.structured-file-tool-error",
      code: "not_a_file",
      message: "not a file: /workspace/notes",
      path: "/workspace/notes",
      detail: "not a file: /workspace/notes",
      exitCode: 11,
    },
  });
});

Deno.test("read_file tool returns a recoverable path_outside_workspace result", async () => {
  const sandbox = new StrictFakeSandboxRuntime();

  const output = await readFileTool.invoke(createContext(sandbox), {
    path: "../outside.txt",
  });

  assertEquals(output, {
    outputId: "run-1:read_file:1",
    path: "../outside.txt",
    ok: false,
    error: {
      type: "cf-harness.structured-file-tool-error",
      code: "path_outside_workspace",
      message: "path outside workspace: ../outside.txt",
      path: "../outside.txt",
      detail: "path escapes workspace root: /outside.txt",
    },
  });
  assertEquals(sandbox.calls, []);
});

Deno.test("read_file tool denies reserved artifact paths before shelling out", async () => {
  const sandbox = new FakeSandboxRuntime();
  const context = createContext(
    sandbox,
    "/workspace",
    new FakeProcessRunner(),
    "observe",
    "/tmp/cf-harness-workspace/.cf-harness-artifacts",
  );

  const rootOutput = await readFileTool.invoke(context, {
    path: ".cf-harness-artifacts",
  });
  const childOutput = await readFileTool.invoke(context, {
    path: ".cf-harness-artifacts/run-1/transcript.json",
  });

  assertEquals(rootOutput, {
    outputId: "run-1:read_file:1",
    path: "/workspace/.cf-harness-artifacts",
    ok: false,
    error: {
      type: "cf-harness.structured-file-tool-error",
      code: "permission_denied",
      message: "permission denied: /workspace/.cf-harness-artifacts",
      path: "/workspace/.cf-harness-artifacts",
      detail: RESERVED_ARTIFACT_PATH_DETAIL,
    },
  });
  assertEquals(childOutput, {
    outputId: "run-1:read_file:2",
    path: "/workspace/.cf-harness-artifacts/run-1/transcript.json",
    ok: false,
    error: {
      type: "cf-harness.structured-file-tool-error",
      code: "permission_denied",
      message:
        "permission denied: /workspace/.cf-harness-artifacts/run-1/transcript.json",
      path: "/workspace/.cf-harness-artifacts/run-1/transcript.json",
      detail: RESERVED_ARTIFACT_PATH_DETAIL,
    },
  });
  assertEquals(sandbox.calls, []);
});

describe("readSkillResourceTool", () => {
  const skillContent = [
    "---",
    "name: pattern-dev",
    "description: Build Common Fabric patterns",
    "---",
    "",
    "# Pattern Dev",
    "Build a café menu.",
  ].join("\n");
  let root: string;
  let skillPath: string;
  let registry: HarnessSkillRegistry;
  let reads: HarnessSkillResourceRead[];
  let context: HarnessToolContext;

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: "cf-harness-skill-body-" });
    skillPath = join(root, "pattern-dev", "SKILL.md");
    await Deno.mkdir(join(root, "pattern-dev"));
    await Deno.writeTextFile(skillPath, skillContent);
    registry = await discoverHarnessSkills({
      skillsRoot: root,
      sandboxSkillsRoot: "/workspace/labs/skills",
    });
    reads = [];
    context = createContext(
      new FakeSandboxRuntime(),
      "/workspace",
      new FakeProcessRunner(),
      "observe",
      undefined,
      registry,
      reads,
    );
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  it("returns the registered skill's `SKILL.md` as context with read provenance", async () => {
    const output = await readSkillResourceTool.invoke(context, {
      skill: "pattern-dev",
      path: "SKILL.md",
    });

    expect(output).toMatchObject({
      status: "read",
      path: "SKILL.md",
      kind: "other",
      content: skillContent,
      contentKind: "text",
      cfcPromptRole: "context",
      sandboxResourcePath: "/workspace/labs/skills/pattern-dev/SKILL.md",
      registryDigest: registry.skills[0].digest,
      observedDigest: registry.skills[0].digest,
      registrySizeBytes: new TextEncoder().encode(skillContent).length,
      digestMatchesRegistry: true,
      truncated: false,
      diagnostics: [],
    });
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      outputId: output.outputId,
      skillName: "pattern-dev",
      path: "SKILL.md",
      status: "read",
      cfcPromptRole: "context",
      observedDigest: registry.skills[0].digest,
    });
  });

  it("returns changed `SKILL.md` content with a snapshot mismatch diagnostic", async () => {
    const content = `${skillContent}\nList the available pastries.\n`;
    await Deno.writeTextFile(skillPath, content);

    const output = await readSkillResourceTool.invoke(context, {
      skill: "pattern-dev",
      path: "SKILL.md",
    });

    expect(output.status).toBe("read");
    expect(output.content).toBe(content);
    expect(output.registryDigest).toBe(registry.skills[0].digest);
    expect(output.digestMatchesRegistry).toBe(false);
    expect(output.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "skill-resource-snapshot-mismatch",
    ]);
    expect(reads).toHaveLength(1);
    expect(reads[0].digestMatchesRegistry).toBe(false);
  });

  it("returns `SKILL.md` when supporting files exhaust the resource scan budget", async () => {
    const referencesPath = join(root, "pattern-dev", "references");
    await Deno.mkdir(referencesPath);
    for (let index = 0; index < 2000; index += 1) {
      await Deno.writeTextFile(
        join(referencesPath, `${index}.md`),
        "Supporting guidance.",
      );
    }
    const largeRegistry = await discoverHarnessSkills({ skillsRoot: root });

    const output = await readSkillResourceTool.invoke(
      { ...context, skillRegistry: largeRegistry },
      { skill: "pattern-dev", path: "SKILL.md" },
    );

    expect(output.status).toBe("read");
    expect(output.content).toBe(skillContent);
    expect(largeRegistry.skills[0].resources).toHaveLength(2000);
    expect(largeRegistry.skills[0].diagnostics.map(({ code }) => code))
      .toContain("resource-file-limit-exceeded");
  });

  it("returns `resource_outside_root` when `SKILL.md` becomes a symlink outside its skill directory", async () => {
    const outsidePath = join(root, "outside.md");
    await Deno.writeTextFile(outsidePath, "Outside the registered skill.");
    await Deno.remove(skillPath);
    await Deno.symlink(outsidePath, skillPath);

    const output = await readSkillResourceTool.invoke(context, {
      skill: "pattern-dev",
      path: "SKILL.md",
    });

    expect(output.status).toBe("error");
    expect(output.error?.code).toBe("resource_outside_root");
    expect(output.content).toBeUndefined();
    expect(reads).toHaveLength(1);
    expect(reads[0].error?.code).toBe("resource_outside_root");
  });
});

Deno.test({
  name:
    "read_skill_resource reads indexed text resources and records provenance",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({
      prefix: "cf-harness-skill-resource-",
    });
    try {
      await Deno.mkdir(join(root, "pattern-dev", "references"), {
        recursive: true,
      });
      await Deno.writeTextFile(
        join(root, "pattern-dev", "SKILL.md"),
        [
          "---",
          "name: pattern-dev",
          "description: Build Common Fabric patterns",
          "---",
          "",
          "# Pattern Dev",
        ].join("\n"),
      );
      await Deno.writeTextFile(
        join(root, "pattern-dev", "references", "guide.md"),
        "# Guide\nUse Cells carefully.\n",
      );
      const registry = await discoverHarnessSkills({
        skillsRoot: root,
        sandboxSkillsRoot: "/workspace/labs/skills",
      });
      const reads: HarnessSkillResourceRead[] = [];

      const output = await readSkillResourceTool.invoke(
        createContext(
          new FakeSandboxRuntime(),
          "/workspace",
          new FakeProcessRunner(),
          "observe",
          undefined,
          registry,
          reads,
        ),
        {
          skill: "pattern-dev",
          path: "references/guide.md",
          maxBytes: 7,
        },
      );

      assertEquals(output.status, "read");
      assertEquals(output.skill, "pattern-dev");
      assertEquals(output.path, "references/guide.md");
      assertEquals(output.kind, "reference");
      assertEquals(output.content, "# Guide");
      assertEquals(output.contentKind, "text");
      assertEquals(output.maxBytes, 7);
      assertEquals(output.truncated, true);
      assertEquals(output.cfcPromptRole, "context");
      assertEquals(output.digestMatchesRegistry, true);
      assertEquals(
        output.sandboxResourcePath?.endsWith(
          "/pattern-dev/references/guide.md",
        ),
        true,
      );
      assertEquals(reads.length, 1);
      assertEquals(reads[0].status, "read");
      assertEquals(reads[0].path, "references/guide.md");
      assertEquals(reads[0].observedDigest, output.observedDigest);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "read_skill_resource returns metadata only for binary resources",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({
      prefix: "cf-harness-skill-resource-",
    });
    try {
      await Deno.mkdir(join(root, "pattern-dev", "assets"), {
        recursive: true,
      });
      await Deno.writeTextFile(
        join(root, "pattern-dev", "SKILL.md"),
        [
          "---",
          "name: pattern-dev",
          "description: Build Common Fabric patterns",
          "---",
        ].join("\n"),
      );
      await Deno.writeFile(
        join(root, "pattern-dev", "assets", "logo.bin"),
        new Uint8Array([0, 1, 2, 3]),
      );
      const registry = await discoverHarnessSkills({ skillsRoot: root });
      const reads: HarnessSkillResourceRead[] = [];

      const output = await readSkillResourceTool.invoke(
        createContext(
          new FakeSandboxRuntime(),
          "/workspace",
          new FakeProcessRunner(),
          "observe",
          undefined,
          registry,
          reads,
        ),
        { skill: "pattern-dev", path: "assets/logo.bin" },
      );

      assertEquals(output.status, "binary");
      assertEquals(output.content, undefined);
      assertEquals(output.contentKind, "binary");
      assertEquals(output.kind, "asset");
      assertEquals(output.truncated, false);
      assertEquals(output.digestMatchesRegistry, true);
      assertEquals(reads[0].status, "binary");
      assertEquals(reads[0].contentKind, "binary");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "read_skill_resource rejects unindexed resources and invalid traversal paths",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({
      prefix: "cf-harness-skill-resource-",
    });
    try {
      await Deno.mkdir(join(root, "pattern-dev"), { recursive: true });
      await Deno.writeTextFile(
        join(root, "pattern-dev", "SKILL.md"),
        [
          "---",
          "name: pattern-dev",
          "description: Build Common Fabric patterns",
          "---",
        ].join("\n"),
      );
      const registry = await discoverHarnessSkills({ skillsRoot: root });
      const reads: HarnessSkillResourceRead[] = [];
      const context = createContext(
        new FakeSandboxRuntime(),
        "/workspace",
        new FakeProcessRunner(),
        "observe",
        undefined,
        registry,
        reads,
      );

      const traversal = await readSkillResourceTool.invoke(context, {
        skill: "pattern-dev",
        path: "../outside.md",
      });
      const missing = await readSkillResourceTool.invoke(context, {
        skill: "pattern-dev",
        path: "references/missing.md",
      });

      assertEquals(traversal.status, "error");
      assertEquals(traversal.error?.code, "resource_path_invalid");
      assertEquals(missing.status, "error");
      assertEquals(missing.error?.code, "resource_not_indexed");
      assertEquals(reads.map((read) => read.status), ["error", "error"]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "read_skill_resource reports digest mismatches while returning call-time content",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({
      prefix: "cf-harness-skill-resource-",
    });
    try {
      const guidePath = join(root, "pattern-dev", "references", "guide.md");
      await Deno.mkdir(join(root, "pattern-dev", "references"), {
        recursive: true,
      });
      await Deno.writeTextFile(
        join(root, "pattern-dev", "SKILL.md"),
        [
          "---",
          "name: pattern-dev",
          "description: Build Common Fabric patterns",
          "---",
        ].join("\n"),
      );
      const registryContent = "old guidance\n";
      const callTimeContent = "new guidance with extra bytes\n";
      await Deno.writeTextFile(guidePath, registryContent);
      const registry = await discoverHarnessSkills({ skillsRoot: root });
      await Deno.writeTextFile(guidePath, callTimeContent);
      const reads: HarnessSkillResourceRead[] = [];

      const output = await readSkillResourceTool.invoke(
        createContext(
          new FakeSandboxRuntime(),
          "/workspace",
          new FakeProcessRunner(),
          "observe",
          undefined,
          registry,
          reads,
        ),
        { skill: "pattern-dev", path: "references/guide.md" },
      );

      assertEquals(output.status, "read");
      assertEquals(output.content, callTimeContent);
      assertEquals(output.digestMatchesRegistry, false);
      assertEquals(output.registrySizeBytes, registryContent.length);
      assertEquals(output.observedSizeBytes, callTimeContent.length);
      assertEquals(
        output.diagnostics.map((diagnostic) => diagnostic.code),
        ["skill-resource-snapshot-mismatch"],
      );
      assertEquals(reads[0].digestMatchesRegistry, false);
      assertEquals(reads[0].observedSizeBytes, callTimeContent.length);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "run_skill_script executes exact allowlisted Deno scripts with provenance",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({
      prefix: "cf-harness-skill-script-",
    });
    try {
      const skillDir = join(root, "deno-memory-profiler");
      const scriptSource =
        "#!/usr/bin/env -S deno run --allow-net --allow-read\nconsole.log('ok');\n";
      await Deno.mkdir(join(skillDir, "scripts"), { recursive: true });
      await Deno.writeTextFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: deno-memory-profiler",
          "description: Analyze Deno memory",
          "---",
        ].join("\n"),
      );
      await Deno.writeTextFile(
        join(skillDir, "scripts", "memory.ts"),
        scriptSource,
      );
      const registry = await discoverHarnessSkills({
        skillsRoot: root,
        sandboxSkillsRoot: "/workspace/skills",
      });
      const skill = registry.skills[0];
      const activations: HarnessSkillActivations = {
        type: "cf-harness.skill-activations",
        version: 1,
        generatedAt: "2026-05-01T00:00:00.000Z",
        activations: [{
          name: skill.name,
          source: "cli-preload",
          runId: "run-1",
          skillPath: skill.skillPath,
          skillDir: skill.skillDir,
          sandboxSkillPath: skill.sandboxSkillPath,
          sandboxSkillDir: skill.sandboxSkillDir,
          digest: skill.digest,
          activatedAt: "2026-05-01T00:00:00.000Z",
          cfcPromptRole: "context",
        }],
      };
      const sandbox = new FakeSandboxRuntime([{
        stdout: '{"usedSize":1}\n',
        stderr: "",
        exitCode: 0,
      }]);
      const executions: HarnessSkillScriptExecution[] = [];
      const output = await runSkillScriptTool.invoke(
        createContext(
          sandbox,
          "/workspace/subdir",
          new FakeProcessRunner(),
          "observe",
          undefined,
          registry,
          [],
          "/tmp/cf-harness-workspace",
          activations,
          [{
            skill: "deno-memory-profiler",
            path: "scripts/memory.ts",
          }],
          executions,
        ),
        {
          skill: "deno-memory-profiler",
          path: "scripts/memory.ts",
          args: ["usage", "--gc"],
        },
      );

      assertEquals(output.status, "executed");
      assertEquals(output.runtime, "deno");
      assertEquals(output.cwd, "/workspace");
      const expectedArgv = [
        "deno",
        "run",
        "--allow-net",
        "--allow-read",
        "-",
        "usage",
        "--gc",
      ];
      assertEquals(output.argv, expectedArgv);
      assertEquals(output.stdout, '{"usedSize":1}\n');
      assertEquals(output.digestMatchesRegistry, true);
      assertEquals(sandbox.calls.length, 1);
      assertEquals(stripCfcInvocationContexts(sandbox.calls), [{
        type: "run",
        request: {
          argv: expectedArgv,
          cwd: "/workspace",
          env: {
            CF_HARNESS_RUN_ID: "run-1",
            SKILL_DIR: "/workspace/skills/deno-memory-profiler",
            SKILL_NAME: "deno-memory-profiler",
            SKILL_SCRIPT:
              "/workspace/skills/deno-memory-profiler/scripts/memory.ts",
            CF_HARNESS_SKILL_SCRIPT_EXECUTION_TARGET: "sandbox",
          },
          stdinText: scriptSource,
          timeoutMs: 60000,
        },
      }]);
      assertEquals(executions.length, 1);
      assertEquals(executions[0].status, "executed");
      assertEquals(executions[0].argv, output.argv);
      assertEquals(executions[0].observedDigest, output.observedDigest);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "run_skill_script rejects Deno scripts with relative imports in v1",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({
      prefix: "cf-harness-skill-script-",
    });
    try {
      const skillDir = join(root, "module-test");
      await Deno.mkdir(join(skillDir, "scripts"), { recursive: true });
      await Deno.writeTextFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: module-test",
          "description: Test module helpers",
          "---",
        ].join("\n"),
      );
      await Deno.writeTextFile(
        join(skillDir, "scripts", "main.ts"),
        "import './helper.ts';\nconsole.log('main');\n",
      );
      await Deno.writeTextFile(
        join(skillDir, "scripts", "helper.ts"),
        "export const value = 1;\n",
      );
      const registry = await discoverHarnessSkills({
        skillsRoot: root,
        sandboxSkillsRoot: "/workspace/skills",
      });
      const skill = registry.skills[0];
      const activations: HarnessSkillActivations = {
        type: "cf-harness.skill-activations",
        version: 1,
        generatedAt: "2026-05-01T00:00:00.000Z",
        activations: [{
          name: skill.name,
          source: "cli-preload",
          runId: "run-1",
          skillPath: skill.skillPath,
          skillDir: skill.skillDir,
          sandboxSkillPath: skill.sandboxSkillPath,
          sandboxSkillDir: skill.sandboxSkillDir,
          digest: skill.digest,
          activatedAt: "2026-05-01T00:00:00.000Z",
          cfcPromptRole: "context",
        }],
      };
      const sandbox = new FakeSandboxRuntime();
      const executions: HarnessSkillScriptExecution[] = [];
      const output = await runSkillScriptTool.invoke(
        createContext(
          sandbox,
          "/workspace",
          new FakeProcessRunner(),
          "observe",
          undefined,
          registry,
          [],
          "/tmp/cf-harness-workspace",
          activations,
          [{ skill: "module-test", path: "scripts/main.ts" }],
          executions,
        ),
        { skill: "module-test", path: "scripts/main.ts" },
      );

      assertEquals(output.status, "error");
      assertEquals(output.error?.code, "unsupported_runtime");
      assertStringIncludes(output.error?.message ?? "", "relative module");
      assertStringIncludes(output.error?.message ?? "", "./helper.ts");
      assertEquals(sandbox.calls, []);
      assertEquals(executions[0].status, "error");
      assertEquals(executions[0].error?.code, "unsupported_runtime");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "run_skill_script executes exact allowlisted Bash shebang scripts from stdin",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({
      prefix: "cf-harness-skill-script-",
    });
    try {
      const skillDir = join(root, "agent-browser");
      const scriptSource = [
        "#!/bin/bash",
        "set -euo pipefail",
        'echo "url=$1"',
        'echo "skill=$SKILL_NAME"',
        "",
      ].join("\n");
      await Deno.mkdir(join(skillDir, "scripts"), { recursive: true });
      await Deno.writeTextFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: agent-browser",
          "description: Browser automation",
          "---",
        ].join("\n"),
      );
      await Deno.writeTextFile(
        join(skillDir, "scripts", "capture-workflow.sh"),
        scriptSource,
        { mode: 0o755 },
      );
      const registry = await discoverHarnessSkills({
        skillsRoot: root,
        sandboxSkillsRoot: "/workspace/skills",
      });
      const skill = registry.skills[0];
      const activations: HarnessSkillActivations = {
        type: "cf-harness.skill-activations",
        version: 1,
        generatedAt: "2026-05-01T00:00:00.000Z",
        activations: [{
          name: skill.name,
          source: "cli-preload",
          runId: "run-1",
          skillPath: skill.skillPath,
          skillDir: skill.skillDir,
          sandboxSkillPath: skill.sandboxSkillPath,
          sandboxSkillDir: skill.sandboxSkillDir,
          digest: skill.digest,
          activatedAt: "2026-05-01T00:00:00.000Z",
          cfcPromptRole: "context",
        }],
      };
      const sandbox = new FakeSandboxRuntime([{
        stdout: "url=https://example.com\nskill=agent-browser\n",
        stderr: "",
        exitCode: 0,
      }]);
      const executions: HarnessSkillScriptExecution[] = [];
      const output = await runSkillScriptTool.invoke(
        createContext(
          sandbox,
          "/workspace/subdir",
          new FakeProcessRunner(),
          "observe",
          undefined,
          registry,
          [],
          "/tmp/cf-harness-workspace",
          activations,
          [{ skill: "agent-browser", path: "scripts/capture-workflow.sh" }],
          executions,
        ),
        {
          skill: "agent-browser",
          path: "scripts/capture-workflow.sh",
          args: ["https://example.com"],
        },
      );

      assertEquals(output.status, "executed");
      assertEquals(output.runtime, "shebang");
      assertEquals(output.cwd, "/workspace");
      const expectedArgv = [
        "bash",
        "-s",
        "--",
        "https://example.com",
      ];
      assertEquals(output.argv, expectedArgv);
      assertEquals(stripCfcInvocationContexts(sandbox.calls), [{
        type: "run",
        request: {
          argv: expectedArgv,
          cwd: "/workspace",
          env: {
            CF_HARNESS_RUN_ID: "run-1",
            SKILL_DIR: "/workspace/skills/agent-browser",
            SKILL_NAME: "agent-browser",
            SKILL_SCRIPT:
              "/workspace/skills/agent-browser/scripts/capture-workflow.sh",
            CF_HARNESS_SKILL_SCRIPT_EXECUTION_TARGET: "sandbox",
          },
          stdinText: scriptSource,
          timeoutMs: 60000,
        },
      }]);
      assertEquals(executions[0].status, "executed");
      assertEquals(executions[0].runtime, "shebang");
      assertEquals(executions[0].argv, expectedArgv);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "run_skill_script can execute exact allowlisted scripts through the host runner",
  permissions: { read: true, write: true },
  async fn() {
    const workspace = await Deno.makeTempDir({
      prefix: "cf-harness-host-skill-script-workspace-",
    });
    try {
      const root = join(workspace, "skills");
      const skillDir = join(root, "agent-browser");
      const scriptSource = [
        "#!/bin/bash",
        "set -euo pipefail",
        'echo "url=$1"',
        'echo "target=$CF_HARNESS_SKILL_SCRIPT_EXECUTION_TARGET"',
        "",
      ].join("\n");
      await Deno.mkdir(join(skillDir, "scripts"), { recursive: true });
      await Deno.writeTextFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: agent-browser",
          "description: Browser automation",
          "---",
        ].join("\n"),
      );
      await Deno.writeTextFile(
        join(skillDir, "scripts", "capture-workflow.sh"),
        scriptSource,
        { mode: 0o755 },
      );
      const registry = await discoverHarnessSkills({
        skillsRoot: root,
        sandboxSkillsRoot: "/workspace/skills",
      });
      const skill = registry.skills[0];
      const activations: HarnessSkillActivations = {
        type: "cf-harness.skill-activations",
        version: 1,
        generatedAt: "2026-05-01T00:00:00.000Z",
        activations: [{
          name: skill.name,
          source: "subagent-inherit",
          runId: "run-1",
          skillPath: skill.skillPath,
          skillDir: skill.skillDir,
          sandboxSkillPath: skill.sandboxSkillPath,
          sandboxSkillDir: skill.sandboxSkillDir,
          digest: skill.digest,
          activatedAt: "2026-05-01T00:00:00.000Z",
          cfcPromptRole: "context",
        }],
      };
      const sandbox = new FakeSandboxRuntime();
      const hostRunner = new FakeProcessRunner([{
        stdout: "url=http://localhost:8000/piece\ntarget=host\n",
        stderr: "",
        exitCode: 0,
      }]);
      const executions: HarnessSkillScriptExecution[] = [];
      const context = createContext(
        sandbox,
        "/workspace/subdir",
        hostRunner,
        "observe",
        undefined,
        registry,
        [],
        workspace,
        activations,
        [{ skill: "agent-browser", path: "scripts/capture-workflow.sh" }],
        executions,
        "host",
        {
          type: "cf-harness.chat.browser-access-lease",
          leaseId: "lease-1",
          cdpUrl: "http://localhost:9362",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      );
      const output = await runSkillScriptTool.invoke(context, {
        skill: "agent-browser",
        path: "scripts/capture-workflow.sh",
        args: ["http://localhost:8000/piece"],
      });

      assertEquals(output.status, "executed");
      assertEquals(output.executionTarget, "host");
      assertEquals(
        output.stdout,
        "url=http://localhost:8000/piece\ntarget=host\n",
      );
      assertEquals(sandbox.calls, []);
      assertEquals(hostRunner.calls.length, 1);
      assertEquals(hostRunner.calls[0], {
        command: "bash",
        args: [
          "-s",
          "--",
          "http://localhost:8000/piece",
        ],
        cwd: workspace,
        clearEnv: true,
        env: {
          PATH: hostRunner.calls[0]!.env!.PATH,
          CF_HARNESS_RUN_ID: "run-1",
          SKILL_NAME: "agent-browser",
          SKILL_DIR: skill.skillDir,
          SKILL_SCRIPT: join(skill.skillDir, "scripts", "capture-workflow.sh"),
          CF_HARNESS_SKILL_SCRIPT_EXECUTION_TARGET: "host",
          AGENT_BROWSER_CDP: "http://localhost:9362",
        },
        stdinText: scriptSource,
        timeoutMs: 60000,
      });
      assertEquals(executions[0].executionTarget, "host");
      assertEquals(executions[0].argv, [
        "bash",
        "-s",
        "--",
        "http://localhost:8000/piece",
      ]);

      const deniedOutput = await runSkillScriptTool.invoke(context, {
        skill: "agent-browser",
        path: "scripts/capture-workflow.sh",
        args: [
          "--cdp",
          "http://localhost:9362",
          "http://localhost:8000/piece",
        ],
      });
      assertEquals(deniedOutput.status, "error");
      assertEquals(deniedOutput.error?.code, "permission_denied");
      assertStringIncludes(
        deniedOutput.error?.message ?? "",
        "must not pass --cdp",
      );
      assertEquals(hostRunner.calls.length, 1);
      assertEquals(executions[1].status, "error");

      const expiredContext = createContext(
        sandbox,
        "/workspace/subdir",
        hostRunner,
        "observe",
        undefined,
        registry,
        [],
        workspace,
        activations,
        [{ skill: "agent-browser", path: "scripts/capture-workflow.sh" }],
        executions,
        "host",
        {
          type: "cf-harness.chat.browser-access-lease",
          leaseId: "lease-1",
          cdpUrl: "http://localhost:9362",
          expiresAt: "2000-01-01T00:00:00.000Z",
        },
      );
      const expiredOutput = await runSkillScriptTool.invoke(expiredContext, {
        skill: "agent-browser",
        path: "scripts/capture-workflow.sh",
        args: ["http://localhost:8000/piece"],
      });
      assertEquals(expiredOutput.status, "error");
      assertEquals(expiredOutput.error?.code, "permission_denied");
      assertStringIncludes(
        expiredOutput.error?.message ?? "",
        "Browser Access lease has expired",
      );
      assertEquals(hostRunner.calls.length, 1);
    } finally {
      await Deno.remove(workspace, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "run_skill_script denies authenticated-session in the browser profile default allowlist",
  permissions: { read: true, write: true },
  async fn() {
    const workspace = await Deno.makeTempDir({
      prefix: "cf-harness-browser-skill-script-deny-",
    });
    try {
      const root = join(workspace, "skills");
      const skillDir = join(root, "agent-browser");
      await Deno.mkdir(join(skillDir, "scripts"), { recursive: true });
      await Deno.writeTextFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: agent-browser",
          "description: Browser automation",
          "---",
        ].join("\n"),
      );
      await Deno.writeTextFile(
        join(skillDir, "scripts", "capture-workflow.sh"),
        "#!/bin/bash\necho capture\n",
        { mode: 0o755 },
      );
      await Deno.writeTextFile(
        join(skillDir, "scripts", "form-automation.sh"),
        "#!/bin/bash\necho form\n",
        { mode: 0o755 },
      );
      await Deno.writeTextFile(
        join(skillDir, "scripts", "authenticated-session.sh"),
        "#!/bin/bash\necho auth\n",
        { mode: 0o755 },
      );
      const registry = await discoverHarnessSkills({
        skillsRoot: root,
        sandboxSkillsRoot: "/workspace/skills",
      });
      const skill = registry.skills[0];
      const activations: HarnessSkillActivations = {
        type: "cf-harness.skill-activations",
        version: 1,
        generatedAt: "2026-05-01T00:00:00.000Z",
        activations: [{
          name: skill.name,
          source: "subagent-inherit",
          runId: "run-1",
          skillPath: skill.skillPath,
          skillDir: skill.skillDir,
          sandboxSkillPath: skill.sandboxSkillPath,
          sandboxSkillDir: skill.sandboxSkillDir,
          digest: skill.digest,
          activatedAt: "2026-05-01T00:00:00.000Z",
          cfcPromptRole: "context",
        }],
      };
      const sandbox = new FakeSandboxRuntime();
      const hostRunner = new FakeProcessRunner();
      const executions: HarnessSkillScriptExecution[] = [];
      const context = createContext(
        sandbox,
        "/workspace",
        hostRunner,
        "observe",
        undefined,
        registry,
        [],
        workspace,
        activations,
        BROWSER_SUBAGENT_ALLOWED_SKILL_SCRIPTS,
        executions,
        "host",
        {
          type: "cf-harness.chat.browser-access-lease",
          leaseId: "lease-1",
          cdpUrl: "http://localhost:9362",
        },
      );

      const output = await runSkillScriptTool.invoke(context, {
        skill: "agent-browser",
        path: "scripts/authenticated-session.sh",
        args: [
          "--cdp",
          "http://localhost:9362",
          "http://localhost:8000/login",
        ],
      });

      assertEquals(output.status, "error");
      assertEquals(output.error?.code, "script_not_allowlisted");
      assertEquals(hostRunner.calls, []);
      assertEquals(sandbox.calls, []);
      assertEquals(executions[0].status, "error");
      assertEquals(executions[0].error?.code, "script_not_allowlisted");
    } finally {
      await Deno.remove(workspace, { recursive: true });
    }
  },
});

Deno.test({
  name: "run_skill_script rejects Bash scripts that source relative helpers",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({
      prefix: "cf-harness-skill-script-",
    });
    try {
      const skillDir = join(root, "agent-browser");
      await Deno.mkdir(join(skillDir, "scripts"), { recursive: true });
      await Deno.writeTextFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: agent-browser",
          "description: Browser automation",
          "---",
        ].join("\n"),
      );
      await Deno.writeTextFile(
        join(skillDir, "scripts", "with-helper.sh"),
        "#!/bin/bash\nsource ./helper.sh\n",
        { mode: 0o755 },
      );
      await Deno.writeTextFile(
        join(skillDir, "scripts", "helper.sh"),
        "echo helper\n",
      );
      const registry = await discoverHarnessSkills({
        skillsRoot: root,
        sandboxSkillsRoot: "/workspace/skills",
      });
      const skill = registry.skills[0];
      const activations: HarnessSkillActivations = {
        type: "cf-harness.skill-activations",
        version: 1,
        generatedAt: "2026-05-01T00:00:00.000Z",
        activations: [{
          name: skill.name,
          source: "cli-preload",
          runId: "run-1",
          skillPath: skill.skillPath,
          skillDir: skill.skillDir,
          sandboxSkillPath: skill.sandboxSkillPath,
          sandboxSkillDir: skill.sandboxSkillDir,
          digest: skill.digest,
          activatedAt: "2026-05-01T00:00:00.000Z",
          cfcPromptRole: "context",
        }],
      };
      const sandbox = new FakeSandboxRuntime();
      const executions: HarnessSkillScriptExecution[] = [];
      const output = await runSkillScriptTool.invoke(
        createContext(
          sandbox,
          "/workspace",
          new FakeProcessRunner(),
          "observe",
          undefined,
          registry,
          [],
          "/tmp/cf-harness-workspace",
          activations,
          [{ skill: "agent-browser", path: "scripts/with-helper.sh" }],
          executions,
        ),
        { skill: "agent-browser", path: "scripts/with-helper.sh" },
      );

      assertEquals(output.status, "error");
      assertEquals(output.error?.code, "unsupported_runtime");
      assertStringIncludes(output.error?.message ?? "", "relative source");
      assertStringIncludes(output.error?.message ?? "", "./helper.sh");
      assertEquals(sandbox.calls, []);
      assertEquals(executions[0].status, "error");
      assertEquals(executions[0].error?.code, "unsupported_runtime");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "run_skill_script requires activation, exact allowlist, and run-start digest",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({
      prefix: "cf-harness-skill-script-",
    });
    try {
      const scriptPath = join(root, "pattern-test", "scripts", "check.ts");
      await Deno.mkdir(join(root, "pattern-test", "scripts"), {
        recursive: true,
      });
      await Deno.writeTextFile(
        join(root, "pattern-test", "SKILL.md"),
        [
          "---",
          "name: pattern-test",
          "description: Test patterns",
          "---",
        ].join("\n"),
      );
      await Deno.writeTextFile(scriptPath, "console.log('old');\n");
      const registry = await discoverHarnessSkills({
        skillsRoot: root,
        sandboxSkillsRoot: "/workspace/skills",
      });
      const skill = registry.skills[0];
      const activations: HarnessSkillActivations = {
        type: "cf-harness.skill-activations",
        version: 1,
        generatedAt: "2026-05-01T00:00:00.000Z",
        activations: [{
          name: skill.name,
          source: "cli-preload",
          runId: "run-1",
          skillPath: skill.skillPath,
          skillDir: skill.skillDir,
          sandboxSkillPath: skill.sandboxSkillPath,
          sandboxSkillDir: skill.sandboxSkillDir,
          digest: skill.digest,
          activatedAt: "2026-05-01T00:00:00.000Z",
          cfcPromptRole: "context",
        }],
      };

      const notActivated = await runSkillScriptTool.invoke(
        createContext(
          new FakeSandboxRuntime(),
          "/workspace",
          new FakeProcessRunner(),
          "observe",
          undefined,
          registry,
          [],
        ),
        { skill: "pattern-test", path: "scripts/check.ts" },
      );
      const notAllowlisted = await runSkillScriptTool.invoke(
        createContext(
          new FakeSandboxRuntime(),
          "/workspace",
          new FakeProcessRunner(),
          "observe",
          undefined,
          registry,
          [],
          "/tmp/cf-harness-workspace",
          activations,
          [],
        ),
        { skill: "pattern-test", path: "scripts/check.ts" },
      );
      await Deno.writeTextFile(scriptPath, "console.log('new');\n");
      const executions: HarnessSkillScriptExecution[] = [];
      const drift = await runSkillScriptTool.invoke(
        createContext(
          new FakeSandboxRuntime(),
          "/workspace",
          new FakeProcessRunner(),
          "observe",
          undefined,
          registry,
          [],
          "/tmp/cf-harness-workspace",
          activations,
          [{ skill: "pattern-test", path: "scripts/check.ts" }],
          executions,
        ),
        { skill: "pattern-test", path: "scripts/check.ts" },
      );

      // The operator's one switch reaches a registry script too: no entry
      // names this one, and with the switch on it is no longer refused as
      // un-allowlisted. It is still held to the run-start digest, which this
      // file no longer matches — so the switch decides whether scripts run,
      // and decides nothing about which bytes.
      const allowedByTheSwitch = await runSkillScriptTool.invoke(
        createContext(
          new FakeSandboxRuntime(),
          "/workspace",
          new FakeProcessRunner(),
          "observe",
          undefined,
          registry,
          [],
          "/tmp/cf-harness-workspace",
          activations,
          [],
          [],
          "sandbox",
          undefined,
          true,
        ),
        { skill: "pattern-test", path: "scripts/check.ts" },
      );

      assertEquals(notActivated.status, "error");
      assertEquals(notActivated.error?.code, "skill_activations_missing");
      assertEquals(notAllowlisted.status, "error");
      assertEquals(notAllowlisted.error?.code, "script_not_allowlisted");
      // The switch is about the sandbox, so a host-target run is still held to
      // an exactly-named script: it must not open host execution to every
      // activated script on the strength of a decision that never said host.
      const hostUnderTheSwitch = await runSkillScriptTool.invoke(
        createContext(
          new FakeSandboxRuntime(),
          "/workspace",
          new FakeProcessRunner(),
          "observe",
          undefined,
          registry,
          [],
          "/tmp/cf-harness-workspace",
          activations,
          [],
          [],
          "host",
          undefined,
          true,
        ),
        { skill: "pattern-test", path: "scripts/check.ts" },
      );

      assertEquals(allowedByTheSwitch.status, "error");
      assertEquals(
        allowedByTheSwitch.error?.code,
        "script_snapshot_mismatch",
      );
      assertEquals(hostUnderTheSwitch.status, "error");
      assertEquals(hostUnderTheSwitch.error?.code, "script_not_allowlisted");
      assertEquals(drift.status, "error");
      assertEquals(drift.error?.code, "script_snapshot_mismatch");
      assertEquals(drift.digestMatchesRegistry, false);
      assertEquals(executions[0].status, "error");
      assertEquals(executions[0].error?.code, "script_snapshot_mismatch");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("edit_file applies exact replacements and returns a unified diff", async () => {
  const original = "one\ntwo\nthree\n";
  const edited = "one\nTWO\nthree\n";
  const sandbox = new FakeSandboxRuntime([
    { stdout: original, stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: edited, stderr: "", exitCode: 0 },
  ]);

  const output = await editFileTool.invoke(createContext(sandbox), {
    path: "notes/log.txt",
    edits: [{ oldText: "two\n", newText: "TWO\n" }],
  });

  assertEquals(output, {
    outputId: "run-1:edit_file:1",
    path: "/workspace/notes/log.txt",
    editsApplied: 1,
    replacements: 1,
    oldDigest: await digestText(original),
    newDigest: await digestText(edited),
    oldSizeBytes: original.length,
    newSizeBytes: edited.length,
    diff: [
      "--- /workspace/notes/log.txt",
      "+++ /workspace/notes/log.txt",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
      "",
    ].join("\n"),
  });
  const calls = stripCfcInvocationContexts(sandbox.calls);
  assertEquals(calls.map((call) => call.type), [
    "runShell",
    "runShell",
    "runShell",
  ]);
  if (calls[1]?.type !== "runShell") {
    throw new Error("expected edit_file write shell call");
  }
  assertEquals(calls[1].request.args, ["/workspace/notes/log.txt"]);
  assertEquals(calls[1].request.cwd, "/workspace");
  assertEquals(calls[1].request.stdinText, edited);
  assertEquals(
    sandbox.calls[1]?.request.cfcInvocationContext?.toolId,
    "edit_file",
  );
  assertEquals(
    sandbox.calls.map((call) =>
      call.type === "runShell"
        ? call.request.cfcInvocationContext?.toolOutputId
        : undefined
    ),
    [
      createToolOutputId("run-1", "edit_file", 1),
      createToolOutputId("run-1", "edit_file", 1),
      createToolOutputId("run-1", "edit_file", 1),
    ],
  );
  assertEquals(
    sandbox.calls[1]?.request.cfcInvocationContext?.inputs.stdin?.bytes,
    edited.length,
  );
});

Deno.test("edit_file labels write stdin with internal read CFC labels", async () => {
  const original = "alpha\nbeta\n";
  const edited = "alpha\nBETA\n";
  const readLabel = { confidentiality: ["did:key:file-secret"] };
  const trustedLabels: CfcLabelView = {
    version: 1,
    entries: [{
      path: ["args"],
      label: { confidentiality: ["did:key:trusted-path"] },
    }],
  };
  const sandbox = new FakeSandboxRuntime([
    {
      stdout: original,
      stderr: "",
      exitCode: 0,
      cfcResult: observedCfcResult(original, { stdoutLabel: readLabel }),
    },
    { stdout: "", stderr: "", exitCode: 0 },
    {
      stdout: edited,
      stderr: "",
      exitCode: 0,
      cfcResult: observedCfcResult(edited, {
        stdoutLabel: { confidentiality: ["did:key:verified-file"] },
      }),
    },
  ]);

  const output = await editFileTool.invoke(createContext(sandbox), {
    path: "notes/secret.txt",
    edits: [{ oldText: "beta\n", newText: "BETA\n" }],
    cfcInputLabels: trustedLabels,
  });

  if ("ok" in output) {
    throw new Error("expected successful edit_file output");
  }
  assertEquals(output.outputId, "run-1:edit_file:1");
  assertEquals(output.cfcResult?.stdout.label, {
    confidentiality: ["did:key:file-secret", "did:key:verified-file"],
  });
  assertEquals(output.cfcResult?.stdout.policy, "observed");
  if (output.cfcResult?.stdout.policy !== "observed") {
    throw new Error("expected observed CFC stdout");
  }
  assertEquals(
    output.cfcResult.stdout.segments.map((segment) => segment.text).join(""),
    [
      "--- /workspace/notes/secret.txt",
      "+++ /workspace/notes/secret.txt",
      "@@ -1,2 +1,2 @@",
      " alpha",
      "-beta",
      "+BETA",
      "",
    ].join("\n"),
  );
  assertEquals(
    sandbox.calls[1]?.request.cfcInvocationContext?.cfcInputLabels,
    {
      version: 1,
      entries: [
        {
          path: ["args"],
          label: { confidentiality: ["did:key:trusted-path"] },
        },
        {
          path: ["stdin"],
          label: { confidentiality: ["did:key:file-secret"] },
        },
      ],
    },
  );
});

Deno.test("edit_file omits CFC result when either internal read is unmediated", async () => {
  const original = "alpha\nbeta\n";
  const edited = "alpha\nBETA\n";
  const sandbox = new FakeSandboxRuntime([
    { stdout: original, stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
    {
      stdout: edited,
      stderr: "",
      exitCode: 0,
      cfcResult: observedCfcResult(edited),
    },
  ]);

  const output = await editFileTool.invoke(createContext(sandbox), {
    path: "notes/secret.txt",
    edits: [{ oldText: "beta\n", newText: "BETA\n" }],
  });

  if ("ok" in output) {
    throw new Error("expected successful edit_file output");
  }
  assertEquals("cfcResult" in output, false);
});

Deno.test("edit_file returns separate hunks for distant edits", async () => {
  const original = Array.from(
    { length: 30 },
    (_, index) => `line ${String(index + 1).padStart(2, "0")}\n`,
  ).join("");
  const edited = original
    .replace("line 02\n", "line 02 changed\n")
    .replace("line 29\n", "line 29 changed\n");
  const sandbox = new FakeSandboxRuntime([
    { stdout: original, stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: edited, stderr: "", exitCode: 0 },
  ]);

  const output = await editFileTool.invoke(createContext(sandbox), {
    path: "notes/distant.txt",
    edits: [
      { oldText: "line 02\n", newText: "line 02 changed\n" },
      { oldText: "line 29\n", newText: "line 29 changed\n" },
    ],
  });

  if ("ok" in output) {
    throw new Error("expected successful edit_file output");
  }
  assertStringIncludes(output.diff, "@@ -1,5 +1,5 @@");
  assertStringIncludes(output.diff, "-line 02");
  assertStringIncludes(output.diff, "+line 02 changed");
  assertStringIncludes(output.diff, "@@ -26,5 +26,5 @@");
  assertStringIncludes(output.diff, "-line 29");
  assertStringIncludes(output.diff, "+line 29 changed");
  assertEquals(output.diff.includes("line 15"), false);
  assertEquals(output.diff.match(/^@@ /gm)?.length, 2);
});

Deno.test("edit_file caps oversized diff output", async () => {
  const original = Array.from(
    { length: 450 },
    (_, index) => `old ${String(index + 1).padStart(3, "0")}\n`,
  ).join("");
  const edited = Array.from(
    { length: 450 },
    (_, index) => `new ${String(index + 1).padStart(3, "0")}\n`,
  ).join("");
  const sandbox = new FakeSandboxRuntime([
    { stdout: original, stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: edited, stderr: "", exitCode: 0 },
  ]);

  const output = await editFileTool.invoke(createContext(sandbox), {
    path: "notes/large.txt",
    edits: [{ oldText: original, newText: edited }],
  });

  if ("ok" in output) {
    throw new Error("expected successful edit_file output");
  }
  assertStringIncludes(output.diff, "[diff truncated:");
  assertEquals(output.diff.split("\n").length, 401);
});

Deno.test("edit_file applies replaceAll edits with expected replacement counts", async () => {
  const original = "red blue red\n";
  const edited = "green blue green\n";
  const sandbox = new FakeSandboxRuntime([
    { stdout: original, stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: edited, stderr: "", exitCode: 0 },
  ]);

  const output = await editFileTool.invoke(createContext(sandbox), {
    path: "notes/colors.txt",
    edits: [{
      oldText: "red",
      newText: "green",
      replaceAll: true,
      expectedReplacements: 2,
    }],
    expectedDigest: await digestText(original),
  });

  if ("ok" in output) {
    throw new Error("expected successful edit_file output");
  }
  assertEquals(output.path, "/workspace/notes/colors.txt");
  assertEquals(output.replacements, 2);
  assertEquals(output.editsApplied, 1);
});

Deno.test("edit_file rejects ambiguous single replacements without writing", async () => {
  const sandbox = new FakeSandboxRuntime([{
    stdout: "name: alpha\nname: beta\n",
    stderr: "",
    exitCode: 0,
  }]);

  const output = await editFileTool.invoke(createContext(sandbox), {
    path: "notes/names.txt",
    edits: [{ oldText: "name:", newText: "label:" }],
  });

  assertEquals(output.outputId, "run-1:edit_file:1");
  assertEquals(output.path, "/workspace/notes/names.txt");
  if (!("ok" in output) || output.ok !== false) {
    throw new Error("expected edit_file conflict output");
  }
  assertEquals(output.error.code, "edit_conflict");
  assertStringIncludes(output.error.detail ?? "", "matched 2 times");
  assertEquals(sandbox.calls.length, 1);
});

Deno.test("edit_file rejects stale expected digests without writing", async () => {
  const sandbox = new FakeSandboxRuntime([{
    stdout: "hello\n",
    stderr: "",
    exitCode: 0,
  }]);

  const output = await editFileTool.invoke(createContext(sandbox), {
    path: "notes/hello.txt",
    expectedDigest: "sha256:not-current",
    edits: [{ oldText: "hello", newText: "hi" }],
  });

  assertEquals(output.outputId, "run-1:edit_file:1");
  assertEquals(output.path, "/workspace/notes/hello.txt");
  if (!("ok" in output) || output.ok !== false) {
    throw new Error("expected edit_file conflict output");
  }
  assertEquals(output.error.code, "edit_conflict");
  assertStringIncludes(output.error.detail ?? "", "expected digest");
  assertEquals(sandbox.calls.length, 1);
});

Deno.test("write_file tool supports append mode and passes content over stdin", async () => {
  const sandbox = new FakeSandboxRuntime();
  const output = await writeFileTool.invoke(createContext(sandbox), {
    path: "notes/log.txt",
    content: "line one\n",
    mode: "append",
    createParents: true,
  });

  assertEquals(output, {
    outputId: "run-1:write_file:1",
    path: "/workspace/notes/log.txt",
    mode: "append",
  });
  assertEquals(stripCfcInvocationContexts(sandbox.calls)[0], {
    type: "runShell",
    request: {
      command: [
        "set -eu",
        'path="$1"',
        'mode="$2"',
        'create_parents="$3"',
        'parent="$(dirname "$path")"',
        'if [ "$create_parents" = "true" ]; then',
        '  mkdir -p "$parent"',
        'elif [ ! -d "$parent" ]; then',
        '  echo "file not found: parent directory $parent" >&2',
        "  exit 10",
        "fi",
        'if [ -e "$path" ] && [ ! -f "$path" ]; then',
        '  echo "not a file: $path" >&2',
        "  exit 11",
        "fi",
        'case "$mode" in',
        "  replace)",
        '    cat > "$path"',
        "    ;;",
        "  append)",
        '    cat >> "$path"',
        "    ;;",
        "  *)",
        '    echo "unsupported write mode: $mode" >&2',
        "    exit 12",
        "    ;;",
        "esac",
      ].join("\n"),
      args: ["/workspace/notes/log.txt", "append", "true"],
      cwd: "/workspace",
      stdinText: "line one\n",
    },
  });
  assertEquals(
    sandbox.calls[0]?.request.cfcInvocationContext?.toolId,
    "write_file",
  );
  assertEquals(
    sandbox.calls[0]?.request.cfcInvocationContext?.inputs.stdin?.bytes,
    "line one\n".length,
  );
  assertEquals(
    sandbox.calls[0]?.request.cfcInvocationContext?.cwd,
    "/workspace",
  );
  assertEquals(
    sandbox.calls[0]?.request.cfcInvocationContext?.toolOutputId,
    output.outputId,
  );
});

Deno.test("write_file tool merges explicit trusted CFC labels with write inputs", async () => {
  const sandbox = new FakeSandboxRuntime();
  const trustedLabels: CfcLabelView = {
    version: 1,
    entries: [{
      path: ["stdin"],
      label: {
        confidentiality: [{
          type: "test.cfc/TrustedInput",
          source: "unit-test",
        }],
      },
    }],
  };

  await writeFileTool.invoke(createContext(sandbox), {
    path: "notes/secret.txt",
    content: "secret\n",
    cfcInputLabels: trustedLabels,
  });

  assertEquals(
    sandbox.calls[0]?.request.cfcInvocationContext?.cfcInputLabels
      ?.entries[0],
    trustedLabels.entries[0],
  );
});

Deno.test("write_file uses the cwd established by an earlier bash call", async () => {
  const sandbox = new FakeSandboxRuntime([
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
  ]);
  const context = createContext(sandbox);

  await bashTool.invoke(context, {
    command: "pwd",
    cwd: "repo",
  });
  await writeFileTool.invoke(context, {
    path: "notes/log.txt",
    content: "line one\n",
  });

  assertEquals(context.currentDir, "/workspace/repo");
  assertEquals(stripCfcInvocationContexts(sandbox.calls)[1], {
    type: "runShell",
    request: {
      command: [
        "set -eu",
        'path="$1"',
        'mode="$2"',
        'create_parents="$3"',
        'parent="$(dirname "$path")"',
        'if [ "$create_parents" = "true" ]; then',
        '  mkdir -p "$parent"',
        'elif [ ! -d "$parent" ]; then',
        '  echo "file not found: parent directory $parent" >&2',
        "  exit 10",
        "fi",
        'if [ -e "$path" ] && [ ! -f "$path" ]; then',
        '  echo "not a file: $path" >&2',
        "  exit 11",
        "fi",
        'case "$mode" in',
        "  replace)",
        '    cat > "$path"',
        "    ;;",
        "  append)",
        '    cat >> "$path"',
        "    ;;",
        "  *)",
        '    echo "unsupported write mode: $mode" >&2',
        "    exit 12",
        "    ;;",
        "esac",
      ].join("\n"),
      args: ["/workspace/repo/notes/log.txt", "replace", "false"],
      cwd: "/workspace/repo",
      stdinText: "line one\n",
    },
  });
  assertEquals(
    sandbox.calls[1]?.request.cfcInvocationContext?.cwd,
    "/workspace/repo",
  );
});

Deno.test("write_file tool returns a recoverable permission_denied result", async () => {
  const sandbox = new FakeSandboxRuntime([{
    stdout: "",
    stderr: "permission denied",
    exitCode: 13,
  }]);

  const output = await writeFileTool.invoke(createContext(sandbox), {
    path: "notes/log.txt",
    content: "line one\n",
  });

  assertEquals(output, {
    outputId: "run-1:write_file:1",
    path: "/workspace/notes/log.txt",
    ok: false,
    error: {
      type: "cf-harness.structured-file-tool-error",
      code: "permission_denied",
      message: "permission denied: /workspace/notes/log.txt",
      path: "/workspace/notes/log.txt",
      detail: "permission denied",
      exitCode: 13,
    },
  });
});

Deno.test("write_file tool returns a recoverable path_outside_workspace result", async () => {
  const sandbox = new StrictFakeSandboxRuntime();

  const output = await writeFileTool.invoke(createContext(sandbox), {
    path: "../outside.txt",
    content: "line one\n",
  });

  assertEquals(output, {
    outputId: "run-1:write_file:1",
    path: "../outside.txt",
    ok: false,
    error: {
      type: "cf-harness.structured-file-tool-error",
      code: "path_outside_workspace",
      message: "path outside workspace: ../outside.txt",
      path: "../outside.txt",
      detail: "path escapes workspace root: /outside.txt",
    },
  });
  assertEquals(sandbox.calls, []);
});

Deno.test("write_file tool denies reserved artifact paths before shelling out", async () => {
  const sandbox = new FakeSandboxRuntime();
  const output = await writeFileTool.invoke(
    createContext(
      sandbox,
      "/workspace",
      new FakeProcessRunner(),
      "observe",
      "/tmp/cf-harness-workspace/.cf-harness-artifacts",
    ),
    {
      path: ".cf-harness-artifacts/run-1/tool-output.json",
      content: "tainted",
      createParents: true,
    },
  );

  assertEquals(output, {
    outputId: "run-1:write_file:1",
    path: "/workspace/.cf-harness-artifacts/run-1/tool-output.json",
    ok: false,
    error: {
      type: "cf-harness.structured-file-tool-error",
      code: "permission_denied",
      message:
        "permission denied: /workspace/.cf-harness-artifacts/run-1/tool-output.json",
      path: "/workspace/.cf-harness-artifacts/run-1/tool-output.json",
      detail: RESERVED_ARTIFACT_PATH_DETAIL,
    },
  });
  assertEquals(sandbox.calls, []);
});

Deno.test("view_image tool attaches a workspace image without shelling out", async () => {
  const workspace = await Deno.realPath(await Deno.makeTempDir());
  await Deno.writeFile(join(workspace, "capture.png"), ONE_PIXEL_PNG);
  const sandbox = new FakeSandboxRuntime();

  const output = await viewImageTool.invoke(
    createContext(
      sandbox,
      "/workspace",
      new FakeProcessRunner(),
      "observe",
      undefined,
      undefined,
      [],
      workspace,
    ),
    { path: "capture.png" },
  );

  assertEquals(output.outputId, "run-1:view_image:1");
  assertEquals(output.path, "/workspace/capture.png");
  if (!("imageAttachment" in output)) {
    throw new Error("expected view_image success output");
  }
  assertEquals(output.mediaType, "image/png");
  assertEquals(output.bytes, ONE_PIXEL_PNG.byteLength);
  assertEquals(output.imageAttachment.hostPath, join(workspace, "capture.png"));
  assertEquals(sandbox.calls, []);
});

Deno.test("view_image tool denies reserved artifact paths", async () => {
  const workspace = await Deno.realPath(await Deno.makeTempDir());
  const artifactRoot = join(workspace, ".cf-harness-artifacts");
  await Deno.mkdir(artifactRoot, { recursive: true });
  await Deno.writeFile(join(artifactRoot, "capture.png"), ONE_PIXEL_PNG);
  const sandbox = new FakeSandboxRuntime();

  const output = await viewImageTool.invoke(
    createContext(
      sandbox,
      "/workspace",
      new FakeProcessRunner(),
      "observe",
      artifactRoot,
      undefined,
      [],
      workspace,
    ),
    { path: ".cf-harness-artifacts/capture.png" },
  );

  assertEquals(output, {
    outputId: "run-1:view_image:1",
    path: "/workspace/.cf-harness-artifacts/capture.png",
    ok: false,
    error: {
      type: "cf-harness.structured-file-tool-error",
      code: "permission_denied",
      message:
        "permission denied: /workspace/.cf-harness-artifacts/capture.png",
      path: "/workspace/.cf-harness-artifacts/capture.png",
      detail: RESERVED_ARTIFACT_PATH_DETAIL,
    },
  });
  assertEquals(sandbox.calls, []);
});

Deno.test("bash tool refuses a session on a runtime without sessions, recoverably", async () => {
  const sandbox = new FakeSandboxRuntime([{
    stdout: "x\n",
    stderr: "",
    exitCode: 0,
  }]);
  const context = createContext(sandbox);
  const output = await bashTool.invoke(context, {
    command: "echo hi",
    session: "build",
  });
  assertEquals(output.exitCode, BASH_SESSION_UNAVAILABLE_EXIT_CODE);
  assertStringIncludes(String(output.stderr), "session");
  // Nothing ran: the model is told rather than silently given a fresh sandbox.
  assertEquals(sandbox.calls, []);
});

Deno.test("bash tool turns the runtime's session refusal into a recoverable result", async () => {
  class RefusingSessions extends FakeSandboxRuntime {
    override describe(): SandboxRuntimeDescription {
      return { ...super.describe(), sessions: true };
    }
    override runShell(): Promise<SandboxCommandResult> {
      return Promise.reject(
        new SandboxSessionUnavailableError("sessions need observe mode here"),
      );
    }
  }
  const context = createContext(new RefusingSessions());
  const output = await bashTool.invoke(context, {
    command: "echo hi",
    session: "build",
  });
  assertEquals(output.exitCode, BASH_SESSION_UNAVAILABLE_EXIT_CODE);
  assertStringIncludes(
    String(output.stderr),
    "sessions need observe mode here",
  );
});

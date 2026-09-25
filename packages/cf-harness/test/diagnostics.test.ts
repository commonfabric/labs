import { assertEquals } from "@std/assert";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import {
  CAPABILITY_PROBE_SENTINEL,
  classifyBashToolFailure,
  classifyBuiltinToolFailure,
  classifyHarnessPolicyEventFailure,
  classifyHarnessRunError,
  collectHarnessCapabilitySnapshot,
  createHarnessFailureRecord,
  FABRIC_STATUS_PROBE_SENTINEL,
  selectPrimaryHarnessFailure,
} from "../src/diagnostics.ts";
import { createHarnessPolicyEvent } from "../src/contracts/policy.ts";
import {
  DockerRunscSandboxRuntime,
  resolveDockerRunscSandboxConfig,
} from "../src/sandbox/docker-runsc.ts";
import type {
  ProcessRunner,
  ProcessRunRequest,
  ProcessRunResult,
} from "../src/sandbox/process-runner.ts";
import { ProcessTimeoutError } from "../src/sandbox/process-runner.ts";
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
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
    return path.startsWith("/") ? path : `${cwd}/${path}`;
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
    if (!request.command.includes(CAPABILITY_PROBE_SENTINEL)) {
      throw new Error("unexpected shell request");
    }
    return Promise.resolve({
      stdout: [
        "bash\tpresent\t/bin/bash\tGNU bash, version 5.2.26(1)-release",
        "sh\tpresent\t/bin/sh\tBusyBox v1.36.1",
        "node\tmissing\t\t",
        "deno\tpresent\t/usr/local/bin/deno\tdeno 2.2.0",
        "python\tmissing\t\t",
        "python3\tpresent\t/usr/bin/python3\tPython 3.11.9",
        "git\tpresent\t/usr/bin/git\tgit version 2.45.1",
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    });
  }
}

class FakeFabricSandboxRuntime extends FakeSandboxRuntime {
  readonly #fabricStatusJson?: string;
  readonly #readOnly: boolean;

  constructor(fabricStatusJson?: string, readOnly = true) {
    super();
    this.#fabricStatusJson = fabricStatusJson;
    this.#readOnly = readOnly;
  }

  override runShell(
    request: SandboxShellRequest,
  ): Promise<SandboxCommandResult> {
    if (request.command.includes(FABRIC_STATUS_PROBE_SENTINEL)) {
      return Promise.resolve(
        this.#fabricStatusJson === undefined
          ? { stdout: "missing\t\n", stderr: "", exitCode: 0 }
          : {
            stdout: `present\t${this.#fabricStatusJson}\n`,
            stderr: "",
            exitCode: 0,
          },
      );
    }
    return super.runShell(request);
  }

  override describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: "/workspace",
      cfc: {
        runtimeRequested: true,
        runtimeName: "runsc-cfc",
        workspaceMountPath: "/workspace",
        mounts: [
          { kind: "workspace", sandboxPath: "/workspace", readOnly: false },
          {
            kind: "fabric-fuse",
            sandboxPath: "/fabric",
            readOnly: this.#readOnly,
          },
        ],
      },
    };
  }
}

Deno.test("collectHarnessCapabilitySnapshot captures fixed sandbox capabilities", async () => {
  const snapshot = await collectHarnessCapabilitySnapshot(
    new FakeSandboxRuntime(),
    "/workspace",
    "2026-04-22T23:00:00.000Z",
  );

  assertEquals(snapshot, {
    type: "cf-harness.capability-snapshot",
    at: "2026-04-22T23:00:00.000Z",
    cfc: {
      enforcementMode: "enforce-explicit",
      absenceBehavior: "fail-closed-if-absent",
      substrateStatus: "not-attested",
      runManifest: { present: false },
      sandbox: {
        kind: "docker-runsc-cfc",
        defaultWorkingDirectory: "/workspace",
        cfc: {
          runtimeRequested: true,
          workspaceMountPath: "/workspace",
        },
      },
      mounts: {
        workspace: {
          kind: "workspace",
          status: "configured",
          sandboxPath: "/workspace",
          readOnly: false,
        },
        fabric: {
          kind: "fabric-fuse",
          status: "not-configured",
          sandboxPath: "/fabric",
          writeGovernance: {
            policy: "not-configured",
            statusProbe: "not-probed",
            delegatedToCfc: false,
          },
        },
        hostBinds: [],
      },
      protectedXattrs: {
        expectedSandboxVisible: false,
        sandboxVisibility: "not-probed",
      },
    },
    commands: {
      bash: {
        present: true,
        path: "/bin/bash",
        version: "GNU bash, version 5.2.26(1)-release",
      },
      sh: {
        present: true,
        path: "/bin/sh",
        version: "BusyBox v1.36.1",
      },
      node: { present: false },
      deno: {
        present: true,
        path: "/usr/local/bin/deno",
        version: "deno 2.2.0",
      },
      python: { present: false },
      python3: {
        present: true,
        path: "/usr/bin/python3",
        version: "Python 3.11.9",
      },
      git: {
        present: true,
        path: "/usr/bin/git",
        version: "git version 2.45.1",
      },
    },
  });
});

Deno.test("collectHarnessCapabilitySnapshot reports configured Fabric mounts", async () => {
  const snapshot = await collectHarnessCapabilitySnapshot(
    new FakeFabricSandboxRuntime(),
    "/workspace",
    "2026-04-29T23:00:00.000Z",
  );

  assertEquals(snapshot.cfc.mounts, {
    workspace: {
      kind: "workspace",
      status: "configured",
      sandboxPath: "/workspace",
      readOnly: false,
    },
    fabric: {
      kind: "fabric-fuse",
      status: "configured",
      sandboxPath: "/fabric",
      readOnly: true,
      writeGovernance: {
        policy: "host-read-only",
        statusProbe: "missing",
        delegatedToCfc: false,
      },
    },
    hostBinds: [],
  });
});

class FakeHostBindSandboxRuntime extends FakeSandboxRuntime {
  override describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: "/workspace",
      cfc: {
        runtimeRequested: true,
        runtimeName: "runsc-cfc",
        workspaceMountPath: "/workspace",
        mounts: [
          {
            kind: "workspace",
            hostPath: "/host/workspace",
            sandboxPath: "/workspace",
            readOnly: false,
          },
          {
            kind: "host-bind",
            name: "file-cabinet",
            hostPath: "/host/File Cabinet",
            sandboxPath: "/file-cabinet",
            readOnly: false,
            mode: "writable",
          },
          {
            kind: "host-bind",
            name: "loom-ops",
            hostPath: "/host/loom/.ops",
            sandboxPath: "/loom/ops",
            readOnly: true,
            mode: "readonly",
          },
        ],
      },
    };
  }
}

Deno.test("collectHarnessCapabilitySnapshot reports configured host bind mounts", async () => {
  const snapshot = await collectHarnessCapabilitySnapshot(
    new FakeHostBindSandboxRuntime(),
    "/workspace",
    "2026-06-02T23:00:00.000Z",
  );

  assertEquals(snapshot.cfc.mounts.hostBinds, [
    {
      kind: "host-bind",
      status: "configured",
      name: "file-cabinet",
      hostPath: "/host/File Cabinet",
      sandboxPath: "/file-cabinet",
      readOnly: false,
      mode: "writable",
    },
    {
      kind: "host-bind",
      status: "configured",
      name: "loom-ops",
      hostPath: "/host/loom/.ops",
      sandboxPath: "/loom/ops",
      readOnly: true,
      mode: "readonly",
    },
  ]);
});

Deno.test("collectHarnessCapabilitySnapshot reports strict daemon status for writable Fabric descriptions", async () => {
  const snapshot = await collectHarnessCapabilitySnapshot(
    new FakeFabricSandboxRuntime(
      JSON.stringify({ cfc: { mode: "enforce-strict" } }),
      false,
    ),
    "/workspace",
    "2026-04-29T23:05:00.000Z",
    { cfcEnforcementMode: "enforce-strict" },
  );

  assertEquals(snapshot.cfc.mounts.fabric.writeGovernance, {
    policy: "host-writable-cfc-strict-attested",
    statusProbe: "present",
    delegatedToCfc: true,
    attestedMode: "enforce-strict",
  });
});

Deno.test("collectHarnessCapabilitySnapshot reports writable Fabric descriptions without daemon attestation", async () => {
  const snapshot = await collectHarnessCapabilitySnapshot(
    new FakeFabricSandboxRuntime(undefined, false),
    "/workspace",
    "2026-04-29T23:10:00.000Z",
    { cfcEnforcementMode: "enforce-strict" },
  );

  assertEquals(snapshot.cfc.mounts.fabric.writeGovernance, {
    policy: "host-writable-cfc-strict-unattested",
    statusProbe: "missing",
    delegatedToCfc: true,
  });
});

Deno.test("classifyHarnessPolicyEventFailure records denied tool usage", () => {
  const failure = classifyHarnessPolicyEventFailure(
    createHarnessPolicyEvent({
      severity: "denied",
      mode: "enforce-explicit",
      toolId: "write_file",
      toolCallId: "call-1",
      detail: "write_file requires direct-command authorization",
      at: "2026-04-22T23:10:00.000Z",
    }),
  );

  assertEquals(failure, {
    type: "cf-harness.failure-record",
    kind: "tool_not_allowed",
    source: "policy_event",
    detail: "write_file requires direct-command authorization",
    at: "2026-04-22T23:10:00.000Z",
    toolId: "write_file",
    toolCallId: "call-1",
  });
});

Deno.test("classifyBashToolFailure uses the capability snapshot to explain missing python", async () => {
  const snapshot = await collectHarnessCapabilitySnapshot(
    new FakeSandboxRuntime(),
    "/workspace",
    "2026-04-22T23:20:00.000Z",
  );

  const failure = classifyBashToolFailure(
    { command: "python script.py" },
    {
      outputId: createToolOutputId("run-1", "bash", 1),
      stdout: "",
      stderr: "/bin/sh: python: command not found",
      exitCode: 127,
      cwd: "/workspace",
    },
    "2026-04-22T23:20:01.000Z",
    snapshot,
  );

  assertEquals(failure, {
    type: "cf-harness.failure-record",
    kind: "missing_binary",
    source: "tool_output",
    detail: "python is not available in the sandbox. python3 is available.",
    at: "2026-04-22T23:20:01.000Z",
    toolId: "bash",
    outputId: createToolOutputId("run-1", "bash", 1),
    command: "python script.py",
    commandName: "python",
    exitCode: 127,
  });
});

Deno.test("classifyBashToolFailure prefers the missing subcommand from shell output", async () => {
  const snapshot = await collectHarnessCapabilitySnapshot(
    new FakeSandboxRuntime(),
    "/workspace",
    "2026-04-23T18:20:00.000Z",
  );

  const failure = classifyBashToolFailure(
    { command: "echo ok && python script.py" },
    {
      outputId: createToolOutputId("run-2", "bash", 1),
      stdout: "ok",
      stderr: "/bin/sh: python: command not found",
      exitCode: 127,
      cwd: "/workspace",
    },
    "2026-04-23T18:20:01.000Z",
    snapshot,
  );

  assertEquals(failure, {
    type: "cf-harness.failure-record",
    kind: "missing_binary",
    source: "tool_output",
    detail: "python is not available in the sandbox. python3 is available.",
    at: "2026-04-23T18:20:01.000Z",
    toolId: "bash",
    outputId: createToolOutputId("run-2", "bash", 1),
    command: "echo ok && python script.py",
    commandName: "python",
    exitCode: 127,
  });
});

Deno.test("classifyBuiltinToolFailure records invalid browser actions as not allowed", () => {
  const failure = classifyBuiltinToolFailure(
    "browser",
    { action: "eval" },
    {
      outputId: createToolOutputId("run-host", "browser", 1),
      status: "error",
      code: "invalid_input",
      message: "action must be one of: open, snapshot",
    },
    "2026-04-23T18:26:00.000Z",
  );

  assertEquals(failure, {
    type: "cf-harness.failure-record",
    kind: "tool_not_allowed",
    source: "tool_output",
    detail: "action must be one of: open, snapshot",
    at: "2026-04-23T18:26:00.000Z",
    toolId: "browser",
    outputId: createToolOutputId("run-host", "browser", 1),
  });
});

Deno.test("classifyBuiltinToolFailure records a browser run without its lease as a harness error", () => {
  const failure = classifyBuiltinToolFailure(
    "browser",
    { action: "snapshot" },
    {
      outputId: createToolOutputId("run-host", "browser", 1),
      status: "error",
      code: "lease_unavailable",
      message: "Browser Access lease has expired",
    },
    "2026-04-23T18:26:00.000Z",
  );

  assertEquals(failure, {
    type: "cf-harness.failure-record",
    kind: "harness_error",
    source: "tool_output",
    detail: "Browser Access lease has expired",
    at: "2026-04-23T18:26:00.000Z",
    toolId: "browser",
    outputId: createToolOutputId("run-host", "browser", 1),
  });
});

Deno.test("classifyBuiltinToolFailure leaves browser page-level failures to the model", () => {
  const failure = classifyBuiltinToolFailure(
    "browser",
    { action: "click", ref: "@e5" },
    {
      outputId: createToolOutputId("run-host", "browser", 1),
      status: "error",
      code: "command_failed",
      message: "error: ref @e5 not found",
      exitCode: 1,
    },
    "2026-04-23T18:26:00.000Z",
  );

  assertEquals(failure, undefined);
});

Deno.test("classifyBuiltinToolFailure records blocked web_fetch URLs", () => {
  const failure = classifyBuiltinToolFailure(
    "web_fetch",
    { url: "http://localhost:8000/private" },
    {
      type: "cf-harness.web-fetch-error",
      outputId: createToolOutputId("run-web", "web_fetch", 1),
      url: "http://localhost:8000/private",
      code: "blocked_url",
      message: "web_fetch host localhost is local and is not allowed",
      fetchedAt: "2026-05-19T20:00:00.000Z",
    },
    "2026-05-19T20:00:01.000Z",
  );

  assertEquals(failure, {
    type: "cf-harness.failure-record",
    kind: "tool_not_allowed",
    source: "tool_output",
    detail: "web_fetch host localhost is local and is not allowed",
    at: "2026-05-19T20:00:01.000Z",
    toolId: "web_fetch",
    outputId: createToolOutputId("run-web", "web_fetch", 1),
  });
});

Deno.test("classifyBuiltinToolFailure handles delegate_task outputs defensively", () => {
  assertEquals(
    classifyBuiltinToolFailure(
      "delegate_task",
      {},
      {
        type: "cf-harness.delegate-task-output",
        outputId: createToolOutputId("run-delegate", "delegate_task", 1),
      },
      "2026-04-23T18:30:00.000Z",
    ),
    undefined,
  );

  assertEquals(
    classifyBuiltinToolFailure(
      "delegate_task",
      {},
      {
        type: "cf-harness.delegate-task-output",
        outputId: createToolOutputId("run-delegate", "delegate_task", 1),
        subagent: {
          type: "cf-harness.subagent-result",
          childRunId: "run-delegate.subagent.1",
          status: "failed",
          summary: "child failed",
          model: "gpt-5.4",
          modelTurns: 1,
          runState: {
            status: "failed",
            cfcEnforcementMode: "disabled",
            policyEventCounts: { total: 0, warnings: 0, denied: 0 },
            failureCount: 1,
          },
          manifest: {
            type: "cf-harness.subagent-run-manifest",
            version: 1,
            parentRunId: "run-delegate",
            parentToolCallId: "call-delegate",
            childRunId: "run-delegate.subagent.1",
            profile: "default",
            depth: 1,
            cfcEnforcementMode: "disabled",
            model: "gpt-5.4",
            allowedToolIds: ["bash", "read_file", "write_file"],
            hostToolIds: [],
            maxModelTurns: 8,
            returnPolicy: {
              type: "cf-harness.subagent-return-policy",
              channel: "summary-and-sanitized-state",
              includeSummary: true,
              includeSanitizedRunState: true,
              includeManifest: true,
              includeTranscript: false,
              includeRawFailureRecords: false,
            },
            createdAt: "2026-04-23T18:30:00.000Z",
            inputSummary: {
              type: "cf-harness.subagent-input-summary",
              goalBytes: 4,
              goalDigest: "sha256:test",
            },
          },
        },
      },
      "2026-04-23T18:30:01.000Z",
    ),
    {
      type: "cf-harness.failure-record",
      kind: "harness_error",
      source: "tool_output",
      detail: "subagent run-delegate.subagent.1 failed: child failed",
      at: "2026-04-23T18:30:01.000Z",
      toolId: "delegate_task",
      outputId: createToolOutputId("run-delegate", "delegate_task", 1),
    },
  );
});

Deno.test("classifyHarnessRunError maps timeouts and path escapes deterministically", () => {
  assertEquals(
    classifyHarnessRunError(
      new ProcessTimeoutError("docker run ...", 5000),
      {
        at: "2026-04-22T23:30:00.000Z",
        toolId: "bash",
      },
    ).kind,
    "timeout",
  );
  assertEquals(
    classifyHarnessRunError(
      new Error("path escapes workspace root: ../../etc/passwd"),
      {
        at: "2026-04-22T23:30:01.000Z",
        toolId: "read_file",
      },
    ).kind,
    "workspace_path_confusion",
  );
  assertEquals(
    classifyHarnessRunError(
      new Error(
        "chat completion transport request failed after 2 attempts for https://llm.stage.commontools.dev/v1/chat/completions: error sending request from 100.87.21.105:52328 for https://llm.stage.commontools.dev/v1/chat/completions (10.128.15.193:443): client error (SendRequest): connection error: timed out",
      ),
      {
        at: "2026-04-22T23:30:02.000Z",
      },
    ).kind,
    "timeout",
  );
  // The gateway client now names the operation, and Responses turns must still
  // classify as timeouts rather than falling through to a generic run error.
  assertEquals(
    classifyHarnessRunError(
      new Error(
        "responses transport request failed after 2 attempts for https://llm.stage.commontools.dev/v1/responses: client error (SendRequest): connection error: timed out",
      ),
      {
        at: "2026-04-22T23:30:03.000Z",
      },
    ).kind,
    "timeout",
  );
  assertEquals(
    classifyHarnessRunError(
      new Error(
        "chat.completions transport request failed after 2 attempts for https://llm.stage.commontools.dev/v1/chat/completions: connection error: timed out",
      ),
      {
        at: "2026-04-22T23:30:04.000Z",
      },
    ).kind,
    "timeout",
  );
});

Deno.test("selectPrimaryHarnessFailure prefers the highest-signal failure kind", () => {
  const primary = selectPrimaryHarnessFailure([
    createHarnessFailureRecord({
      kind: "unknown",
      source: "run_error",
      detail: "gateway boom",
      at: "2026-04-22T23:40:00.000Z",
    }),
    createHarnessFailureRecord({
      kind: "missing_binary",
      source: "tool_output",
      detail: "python is not available in the sandbox",
      at: "2026-04-22T23:40:01.000Z",
      toolId: "bash",
    }),
    createHarnessFailureRecord({
      kind: "tool_not_allowed",
      source: "policy_event",
      detail: "write_file requires direct-command authorization",
      at: "2026-04-22T23:40:02.000Z",
      toolId: "write_file",
    }),
  ]);

  assertEquals(primary?.kind, "tool_not_allowed");
});

//
// The capability snapshot is persisted into the CFC policy snapshot, so a
// transport reading taken after it is captured cannot repair the claim it
// already made.
//

const CAPABILITY_PROBE_STDOUT = [
  "bash\tpresent\t/bin/bash\tGNU bash, version 5.2.26(1)-release",
  "sh\tpresent\t/bin/sh\tBusyBox v1.36.1",
  "node\tmissing\t\t",
  "deno\tpresent\t/usr/local/bin/deno\tdeno 2.2.0",
  "python\tmissing\t\t",
  "python3\tpresent\t/usr/bin/python3\tPython 3.11.9",
  "git\tpresent\t/usr/bin/git\tgit version 2.45.1",
].join("\n");

Deno.test("collectHarnessCapabilitySnapshot reads the CFC transport before capturing the sandbox description", async () => {
  const requests: ProcessRunRequest[] = [];
  const results: ProcessRunResult[] = [
    {
      // A runtime registered with CFC enabled and neither sidecar directory.
      stdout: JSON.stringify({ "runsc-cfc": { runtimeArgs: ["--cfc"] } }),
      stderr: "",
      exitCode: 0,
    },
    { stdout: "container-123\n", stderr: "", exitCode: 0 },
    { stdout: CAPABILITY_PROBE_STDOUT, stderr: "", exitCode: 0 },
    { stdout: "0\n", stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
  ];
  const runner: ProcessRunner = {
    run(request) {
      requests.push(request);
      const result = results.shift();
      if (result === undefined) {
        throw new Error(`unexpected process request: ${request.args[0]}`);
      }
      return Promise.resolve(result);
    },
  };
  const sandbox = new DockerRunscSandboxRuntime(
    resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
      cfcInvocationContextDir: "/host/invocations",
    }),
    runner,
  );

  const snapshot = await collectHarnessCapabilitySnapshot(
    sandbox,
    "/workspace",
    "2026-04-30T00:00:00.000Z",
  );

  // What this test pins: the reading is taken BEFORE the description is
  // captured, so the persisted snapshot carries it instead of the
  // `unverified` it would hold if nothing had probed.
  assertEquals(requests[0]?.args[0], "info");
  assertEquals(
    snapshot.cfc.sandbox.cfc?.invocationContextTransportReadiness,
    "unregistered",
  );

  // What it deliberately does NOT pin: that the capability container is
  // allowed to start on that reading. It does start — this probe calls
  // `runShell` without a `cfcInvocationContext`, so it bypasses the
  // per-invocation refusal, and `engine.ts` claims the readiness check
  // precedes any sandbox execution under enforcement while it does not.
  // Asserting the full `info,create,start,wait,rm` order here would make a
  // test out of that defect and turn it into expected behavior. Whether an
  // enforcing run should abort at this point is the run-start fail-closed
  // decision tracked on CT-2122.
});

import { assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import {
  CAPABILITY_PROBE_SENTINEL,
  cfcAbsenceBehaviorForMode,
  classifyBashToolFailure,
  classifyBuiltinToolFailure,
  classifyHarnessPolicyEventFailure,
  classifyHarnessRunError,
  collectHarnessCapabilitySnapshot,
  createHarnessFailureRecord,
  FABRIC_STATUS_PROBE_SENTINEL,
  type HarnessCapabilitySnapshot,
  selectPrimaryHarnessFailure,
} from "../src/diagnostics.ts";
import { createHarnessPolicyEvent } from "../src/contracts/policy.ts";
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
      kind: "runsc-cfc",
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

  constructor(fabricStatusJson?: string) {
    super();
    this.#fabricStatusJson = fabricStatusJson;
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
      kind: "runsc-cfc",
      defaultWorkingDirectory: "/workspace",
      cfc: {
        runtimeRequested: true,
        workspaceMountPath: "/workspace",
        mounts: [
          { kind: "workspace", sandboxPath: "/workspace", readOnly: false },
          { kind: "fabric-fuse", sandboxPath: "/fabric", readOnly: false },
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
        kind: "runsc-cfc",
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
      readOnly: false,
      writeGovernance: {
        policy: "host-writable-non-strict",
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
      kind: "runsc-cfc",
      defaultWorkingDirectory: "/workspace",
      cfc: {
        runtimeRequested: true,
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

Deno.test("collectHarnessCapabilitySnapshot records strict CFC attestation for writable Fabric mounts", async () => {
  const snapshot = await collectHarnessCapabilitySnapshot(
    new FakeFabricSandboxRuntime(
      JSON.stringify({ cfc: { mode: "enforce-strict" } }),
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

Deno.test("collectHarnessCapabilitySnapshot records strict writable Fabric mounts without attestation", async () => {
  const snapshot = await collectHarnessCapabilitySnapshot(
    new FakeFabricSandboxRuntime(),
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

Deno.test("classifyHarnessPolicyEventFailure records no failure for an event that denied nothing", () => {
  const failure = classifyHarnessPolicyEventFailure(
    createHarnessPolicyEvent({
      severity: "warning",
      mode: "observe",
      toolId: "write_file",
      detail: "write_file would require direct-command authorization",
      at: "2026-04-22T23:10:00.000Z",
    }),
  );

  assertEquals(failure, undefined);
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
      new ProcessTimeoutError("runsc run ...", 5000),
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

Deno.test("selectPrimaryHarnessFailure never selects a refused subagent profile", () => {
  const refusal = createHarnessFailureRecord({
    kind: "subagent_profile_not_allowed",
    source: "policy_event",
    detail: 'delegate_task profile "web_search" is not allowed in this run',
    at: "2026-10-14T21:00:00.000Z",
    toolId: "delegate_task",
  });
  const invalid = createHarnessFailureRecord({
    kind: "invalid_tool_call",
    source: "tool_call",
    detail: "goal must be a string",
    at: "2026-10-14T21:00:01.000Z",
    toolId: "delegate_task",
  });

  assertEquals(selectPrimaryHarnessFailure([refusal]), undefined);
  assertEquals(selectPrimaryHarnessFailure([refusal, invalid]), invalid);
});

/**
 * A sandbox whose Fabric mount and probe answers a case chooses: whether the
 * mount is read-only, what the status probe prints and how it exits, and how
 * the capability probe exits.
 */
class ScriptedSandboxRuntime extends FakeSandboxRuntime {
  readonly #fabricReadOnly: boolean;
  readonly #fabricStatus: SandboxCommandResult;
  readonly #capabilityProbe: SandboxCommandResult | undefined;

  constructor(options: {
    fabricReadOnly?: boolean;
    fabricStatus?: Partial<SandboxCommandResult>;
    capabilityProbe?: SandboxCommandResult;
  }) {
    super();
    this.#fabricReadOnly = options.fabricReadOnly ?? false;
    this.#fabricStatus = {
      stdout: "missing\t\n",
      stderr: "",
      exitCode: 0,
      ...options.fabricStatus,
    };
    this.#capabilityProbe = options.capabilityProbe;
  }

  override describe(): SandboxRuntimeDescription {
    return {
      kind: "runsc-cfc",
      defaultWorkingDirectory: "/workspace",
      cfc: {
        runtimeRequested: true,
        mounts: [{
          kind: "fabric-fuse",
          hostPath: "/host/fabric",
          sandboxPath: "/fabric",
          readOnly: this.#fabricReadOnly,
        }],
      },
    };
  }

  override runShell(
    request: SandboxShellRequest,
  ): Promise<SandboxCommandResult> {
    if (request.command.includes(FABRIC_STATUS_PROBE_SENTINEL)) {
      return Promise.resolve(this.#fabricStatus);
    }
    if (this.#capabilityProbe !== undefined) {
      return Promise.resolve(this.#capabilityProbe);
    }
    return super.runShell(request);
  }
}

const AT = "2026-11-12T10:00:00.000Z";

const snapshotOf = (
  sandbox: SandboxRuntime,
  options: Parameters<typeof collectHarnessCapabilitySnapshot>[3] = {},
): Promise<HarnessCapabilitySnapshot> =>
  collectHarnessCapabilitySnapshot(sandbox, "/workspace", AT, options);

const bashOutput = (stdout: string, stderr: string, exitCode = 127) => ({
  outputId: createToolOutputId("run-bash", "bash", 1),
  stdout,
  stderr,
  exitCode,
  cwd: "/workspace",
});

describe("diagnostics", () => {
  describe("cfcAbsenceBehaviorForMode()", () => {
    it("returns the behavior each known mode publishes", () => {
      expect(cfcAbsenceBehaviorForMode("disabled")).toBe("not-required");
      expect(cfcAbsenceBehaviorForMode("observe")).toBe("observe-only");
      expect(cfcAbsenceBehaviorForMode("enforce-explicit"))
        .toBe("fail-closed-if-absent");
      expect(cfcAbsenceBehaviorForMode("enforce-strict"))
        .toBe("fail-closed-if-absent");
    });

    it("returns fail-closed for a mode this build does not know", () => {
      // A resumed run state is parsed from disk, so its mode is whatever the
      // file held, typed or not.

      const recorded: CfcEnforcementMode = JSON.parse('"enforce-later"');
      expect(cfcAbsenceBehaviorForMode(recorded)).toBe("fail-closed-if-absent");
    });
  });

  describe("collectHarnessCapabilitySnapshot()", () => {
    it("reports the workspace at the sandbox's working directory when no mount names it", async () => {
      const snapshot = await snapshotOf(new ScriptedSandboxRuntime({}));
      expect(snapshot.cfc.mounts.workspace).toEqual({
        kind: "workspace",
        status: "configured",
        sandboxPath: "/workspace",
        readOnly: false,
      });
      expect(snapshot.cfc.mounts.fabric.hostPath).toBe("/host/fabric");
    });

    it("reports a present run manifest as the run's substrate", async () => {
      const snapshot = await snapshotOf(new FakeSandboxRuntime(), {
        cfcEnforcementMode: "enforce-strict",
        runManifest: {
          type: "cf-harness.loom-run-manifest",
          version: 1,
          source: "loom",
        },
        runManifestPath: "/runs/manifest.json",
      });
      expect(snapshot.cfc.substrateStatus).toBe("manifest-present");
      expect(snapshot.cfc.runManifest).toEqual({
        present: true,
        type: "cf-harness.loom-run-manifest",
        path: "/runs/manifest.json",
      });
    });

    it("reports a strict run without a manifest as missing its substrate", async () => {
      const snapshot = await snapshotOf(new FakeSandboxRuntime(), {
        cfcEnforcementMode: "enforce-strict",
      });
      expect(snapshot.cfc.substrateStatus).toBe("missing");
      expect(snapshot.cfc.runManifest).toEqual({ present: false });
    });

    it("reports a non-strict run without a manifest as not attested", async () => {
      const snapshot = await snapshotOf(new FakeSandboxRuntime(), {
        cfcEnforcementMode: "observe",
      });
      expect(snapshot.cfc.substrateStatus).toBe("not-attested");
    });

    it("reports a disabled run as needing no substrate", async () => {
      const snapshot = await snapshotOf(new FakeSandboxRuntime(), {
        cfcEnforcementMode: "disabled",
      });
      expect(snapshot.cfc.substrateStatus).toBe("not-required");
    });

    it("records the model's auth source for each provider", async () => {
      const codex = await snapshotOf(new FakeSandboxRuntime(), {
        modelProvider: "openai-codex",
      });
      const keyless = await snapshotOf(new FakeSandboxRuntime(), {
        modelProvider: "openai-compatible-gateway",
        gatewayAuthMode: "none",
      });
      const keyed = await snapshotOf(new FakeSandboxRuntime(), {
        modelProvider: "openai-compatible-gateway",
      });
      const unnamed = await snapshotOf(new FakeSandboxRuntime());
      expect(codex.model).toEqual({
        providerId: "openai-codex",
        authSource: "owner-bound-oauth",
      });
      expect(keyless.model?.authSource).toBe("none");
      expect(keyed.model?.authSource).toBe("api-key");
      expect(unnamed.model).toBeUndefined();
    });

    it("throws with the probe's stderr when the capability probe fails", async () => {
      const sandbox = new ScriptedSandboxRuntime({
        capabilityProbe: { stdout: "partial", stderr: "boom", exitCode: 2 },
      });
      await expect(snapshotOf(sandbox)).rejects.toThrow(
        "capability probe failed with exit 2: boom",
      );
    });

    it("throws with the probe's stdout when the failed probe wrote no stderr", async () => {
      const sandbox = new ScriptedSandboxRuntime({
        capabilityProbe: { stdout: "partial", stderr: "", exitCode: 2 },
      });
      await expect(snapshotOf(sandbox)).rejects.toThrow(
        "capability probe failed with exit 2: partial",
      );
    });

    it("throws saying there is no detail when the failed probe wrote nothing", async () => {
      const sandbox = new ScriptedSandboxRuntime({
        capabilityProbe: { stdout: "", stderr: "", exitCode: 2 },
      });
      await expect(snapshotOf(sandbox)).rejects.toThrow(
        "capability probe failed with exit 2: no error detail",
      );
    });

    it("ignores probe lines for commands it does not track", async () => {
      const sandbox = new ScriptedSandboxRuntime({
        capabilityProbe: {
          stdout: "\nperl\tpresent\t/usr/bin/perl\tv5\ngit\tpresent\t\t\n",
          stderr: "",
          exitCode: 0,
        },
      });
      const snapshot = await snapshotOf(sandbox);
      expect(Object.keys(snapshot.commands)).not.toContain("perl");
      expect(snapshot.commands.git).toEqual({ present: true });
      expect(snapshot.commands.bash).toEqual({ present: false });
    });

    describe("Fabric write governance", () => {
      it("records a read-only Fabric mount as host read-only, with its attested mode", async () => {
        const snapshot = await snapshotOf(
          new ScriptedSandboxRuntime({
            fabricReadOnly: true,
            fabricStatus: {
              stdout: `present\t${
                JSON.stringify({ cfc: { mode: "observe" } })
              }\n`,
            },
          }),
          { cfcEnforcementMode: "enforce-strict" },
        );
        expect(snapshot.cfc.mounts.fabric.writeGovernance).toEqual({
          policy: "host-read-only",
          statusProbe: "present",
          delegatedToCfc: false,
          attestedMode: "observe",
        });
      });

      it("records the attested mode of a writable mount in a non-strict run", async () => {
        const snapshot = await snapshotOf(
          new ScriptedSandboxRuntime({
            fabricStatus: {
              stdout: `present\t${
                JSON.stringify({ cfc: { mode: "observe" } })
              }\n`,
            },
          }),
          { cfcEnforcementMode: "observe" },
        );
        expect(snapshot.cfc.mounts.fabric.writeGovernance).toEqual({
          policy: "host-writable-non-strict",
          statusProbe: "present",
          delegatedToCfc: false,
          attestedMode: "observe",
        });
      });

      it("leaves a strict run unattested when the status names another mode", async () => {
        const snapshot = await snapshotOf(
          new ScriptedSandboxRuntime({
            fabricStatus: {
              stdout: `present\t${
                JSON.stringify({ cfc: { mode: "observe" } })
              }\n`,
            },
          }),
          { cfcEnforcementMode: "enforce-strict" },
        );
        expect(snapshot.cfc.mounts.fabric.writeGovernance).toEqual({
          policy: "host-writable-cfc-strict-unattested",
          statusProbe: "present",
          delegatedToCfc: true,
          attestedMode: "observe",
        });
      });

      it("records a present status with no recognized mode as attesting nothing", async () => {
        const snapshot = await snapshotOf(
          new ScriptedSandboxRuntime({
            fabricStatus: {
              stdout: `present\t${JSON.stringify({ cfc: { mode: "later" } })}`,
            },
          }),
          { cfcEnforcementMode: "enforce-strict" },
        );
        expect(snapshot.cfc.mounts.fabric.writeGovernance).toEqual({
          policy: "host-writable-cfc-strict-unattested",
          statusProbe: "present",
          delegatedToCfc: true,
        });
      });

      it("records a status file that is not JSON as invalid", async () => {
        const snapshot = await snapshotOf(
          new ScriptedSandboxRuntime({
            fabricStatus: { stdout: "present\t{not json\n" },
          }),
        );
        expect(snapshot.cfc.mounts.fabric.writeGovernance?.statusProbe)
          .toBe("invalid");
      });

      it("records probe output it cannot read as invalid", async () => {
        const snapshot = await snapshotOf(
          new ScriptedSandboxRuntime({ fabricStatus: { stdout: "garbled" } }),
        );
        expect(snapshot.cfc.mounts.fabric.writeGovernance?.statusProbe)
          .toBe("invalid");
      });

      it("records a status probe that exits nonzero as invalid", async () => {
        const snapshot = await snapshotOf(
          new ScriptedSandboxRuntime({
            fabricStatus: { stdout: "present\t{}\n", exitCode: 1 },
          }),
        );
        expect(snapshot.cfc.mounts.fabric.writeGovernance?.statusProbe)
          .toBe("invalid");
      });
    });
  });

  describe("classifyHarnessPolicyEventFailure()", () => {
    it("returns a record without a call id for a denial that names none", () => {
      const failure = classifyHarnessPolicyEventFailure(
        createHarnessPolicyEvent({
          severity: "denied",
          mode: "enforce-strict",
          toolId: "bash",
          detail: "bash is not allowed",
          at: AT,
        }),
        "harness_error",
      );
      expect(failure).toEqual({
        type: "cf-harness.failure-record",
        kind: "harness_error",
        source: "policy_event",
        detail: "bash is not allowed",
        at: AT,
        toolId: "bash",
      });
    });
  });

  describe("classifyBashToolFailure()", () => {
    it("returns undefined for an exit code other than 127", () => {
      expect(
        classifyBashToolFailure(
          { command: "python x.py" },
          bashOutput("", "python: command not found", 1),
          AT,
        ),
      ).toBeUndefined();
    });

    it("returns undefined for exit 127 whose output does not say a command is missing", () => {
      expect(
        classifyBashToolFailure(
          { command: "./run" },
          bashOutput("", "killed by the user"),
          AT,
        ),
      ).toBeUndefined();
    });

    it("names the command the shell output names, past blank lines", () => {
      const failure = classifyBashToolFailure(
        { command: "echo hi" },
        bashOutput("", "\n\nnode: not found"),
        AT,
      );
      expect(failure?.commandName).toBe("node");
      expect(failure?.detail).toBe(
        "node was not found while executing a shell command.",
      );
    });

    it("names python as available when python3 is the one missing", async () => {
      const snapshot = await snapshotOf(
        new ScriptedSandboxRuntime({
          capabilityProbe: {
            stdout:
              "python\tpresent\t/usr/bin/python\t\npython3\tmissing\t\t\n",
            stderr: "",
            exitCode: 0,
          },
        }),
      );
      const failure = classifyBashToolFailure(
        { command: "python3 x.py" },
        bashOutput("", "python3: command not found"),
        AT,
        snapshot,
      );
      expect(failure?.detail).toBe(
        "python3 is not available in the sandbox. python is available.",
      );
    });

    describe("when the output names no command", () => {
      // The shell said something was missing without saying what, so the
      // classifier reads the command the model ran instead.

      it("names the first command past comments, assignments and keywords", () => {
        const failure = classifyBashToolFailure(
          {
            command: [
              "# set up",
              "",
              "if true; then",
              "  LANG=C TZ=UTC 'jq' . data.json",
              "fi",
            ].join("\n"),
          },
          bashOutput("", "command not found"),
          AT,
        );
        expect(failure?.commandName).toBe("jq");
      });

      it("names the command an exec replaces the shell with", () => {
        const failure = classifyBashToolFailure(
          { command: "exec deno run main.ts" },
          bashOutput("", "command not found"),
          AT,
        );
        expect(failure?.commandName).toBe("deno");
      });

      it("returns a record with no command name for a bare exec", () => {
        const failure = classifyBashToolFailure(
          { command: "exec" },
          bashOutput("", "command not found"),
          AT,
        );
        expect(failure?.kind).toBe("missing_binary");
        expect(failure?.commandName).toBeUndefined();
        expect(failure?.detail).toBe("a shell command was not found");
      });

      it("returns a record with no command name for a script of only keywords", () => {
        const failure = classifyBashToolFailure(
          { command: "# nothing\ndo\ndone" },
          bashOutput("", "command not found"),
          AT,
        );
        expect(failure?.commandName).toBeUndefined();
      });
    });
  });

  describe("classifyBuiltinToolFailure()", () => {
    it("classifies a bash output the same way classifyBashToolFailure does", () => {
      const failure = classifyBuiltinToolFailure(
        "bash",
        { command: "git status" },
        bashOutput("", "git: command not found"),
        AT,
      );
      expect(failure).toEqual({
        type: "cf-harness.failure-record",
        kind: "missing_binary",
        source: "tool_output",
        detail: "git was not found while executing a shell command.",
        at: AT,
        toolId: "bash",
        outputId: createToolOutputId("run-bash", "bash", 1),
        command: "git status",
        commandName: "git",
        exitCode: 127,
      });
    });

    it("returns undefined for a tool it does not classify", () => {
      expect(classifyBuiltinToolFailure("submit_result", {}, {}, AT))
        .toBeUndefined();
    });

    it("returns undefined for a web_fetch output that is not an error", () => {
      expect(
        classifyBuiltinToolFailure(
          "web_fetch",
          {},
          {
            type: "cf-harness.web-fetch-output",
            outputId: createToolOutputId("run-web", "web_fetch", 1),
          },
          AT,
        ),
      ).toBeUndefined();
    });

    it("records a failed web_fetch other than a blocked URL as a harness error with its status", () => {
      const failure = classifyBuiltinToolFailure(
        "web_fetch",
        {},
        {
          type: "cf-harness.web-fetch-error",
          outputId: createToolOutputId("run-web", "web_fetch", 2),
          code: "http_error",
          status: 503,
          message: "upstream unavailable",
        },
        AT,
      );
      expect(failure?.kind).toBe("harness_error");
      expect(failure?.exitCode).toBe(503);
    });

    describe("read_skill_resource", () => {
      it("records a failed read as a harness error carrying its message", () => {
        const failure = classifyBuiltinToolFailure(
          "read_skill_resource",
          {},
          {
            type: "cf-harness.read-skill-resource-output",
            outputId: createToolOutputId("run-skill", "read_skill_resource", 1),
            status: "error",
            error: { code: "resource_not_indexed", message: "not indexed" },
          },
          AT,
        );
        expect(failure).toEqual({
          type: "cf-harness.failure-record",
          kind: "harness_error",
          source: "tool_output",
          detail: "not indexed",
          at: AT,
          toolId: "read_skill_resource",
          outputId: createToolOutputId("run-skill", "read_skill_resource", 1),
        });
      });

      it("returns undefined for a read that succeeded", () => {
        expect(
          classifyBuiltinToolFailure(
            "read_skill_resource",
            {},
            {
              type: "cf-harness.read-skill-resource-output",
              outputId: createToolOutputId(
                "run-skill",
                "read_skill_resource",
                1,
              ),
              status: "read",
            },
            AT,
          ),
        ).toBeUndefined();
      });
    });

    describe("structured file tools", () => {
      const fileError = (code: string, exitCode?: number) => ({
        outputId: createToolOutputId("run-file", "read_file", 1),
        path: "/workspace/a.txt",
        ok: false,
        error: {
          type: "cf-harness.structured-file-tool-error",
          code,
          message: `failed: ${code}`,
          path: "/workspace/a.txt",
          ...(exitCode !== undefined ? { exitCode } : {}),
        },
      });

      it("records each error code as its failure kind", () => {
        const kinds = [
          "file_not_found",
          "edit_conflict",
          "not_a_file",
          "permission_denied",
          "path_outside_workspace",
          "unknown",
        ].map((code) =>
          classifyBuiltinToolFailure("read_file", {}, fileError(code), AT)
            ?.kind
        );
        expect(kinds).toEqual([
          "file_not_found",
          "harness_error",
          "not_a_file",
          "permission_denied",
          "workspace_path_confusion",
          "unknown",
        ]);
      });

      it("records the tool it ran and the exit code it carried", () => {
        for (const toolId of ["view_image", "edit_file", "write_file"]) {
          const failure = classifyBuiltinToolFailure(
            toolId,
            {},
            fileError("permission_denied", 13),
            AT,
          );
          expect(failure?.toolId).toBe(toolId);
          expect(failure?.exitCode).toBe(13);
          expect(failure?.detail).toBe("failed: permission_denied");
        }
      });

      it("returns undefined for a file tool output that succeeded", () => {
        expect(
          classifyBuiltinToolFailure(
            "read_file",
            {},
            { outputId: "out", path: "/workspace/a.txt", ok: true },
            AT,
          ),
        ).toBeUndefined();
      });
    });
  });

  describe("classifyHarnessRunError()", () => {
    it("records every call detail the options carry", () => {
      const failure = classifyHarnessRunError(
        new ProcessTimeoutError("runsc run", 5000),
        {
          at: AT,
          source: "tool_output",
          toolId: "bash",
          toolCallId: "call-7",
          outputId: createToolOutputId("run-err", "bash", 1),
          command: "sleep 99",
          commandName: "sleep",
        },
      );
      expect(failure).toEqual({
        type: "cf-harness.failure-record",
        kind: "timeout",
        source: "tool_output",
        detail: "process timed out after 5000ms: runsc run",
        at: AT,
        toolId: "bash",
        toolCallId: "call-7",
        outputId: createToolOutputId("run-err", "bash", 1),
        command: "sleep 99",
        commandName: "sleep",
      });
      expect(failure.detail).toContain("runsc run");
    });

    it("records harness faults as harness errors and anything else as unknown", () => {
      const kindOf = (message: string) =>
        classifyHarnessRunError(new Error(message), { at: AT }).kind;
      expect(kindOf("unknown builtin tool: frobnicate")).toBe("harness_error");
      expect(kindOf("chat completion response did not include a message"))
        .toBe("harness_error");
      expect(kindOf("transport request failed: connection refused"))
        .toBe("unknown");
      expect(kindOf("gateway boom")).toBe("unknown");
    });

    it("records a run error from its source unless the options name one", () => {
      const failure = classifyHarnessRunError(new Error("gateway boom"), {
        at: AT,
      });
      expect(failure.source).toBe("run_error");
      expect("toolId" in failure).toBe(false);
    });
  });
});

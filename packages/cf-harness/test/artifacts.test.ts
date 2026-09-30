import { checkoutDocsCorpusRoots } from "../src/docs-corpus/corpus.ts";
import { resolveHarnessSkillsRoot } from "../src/skills/root.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { normalize } from "@std/path/posix";

import type { CfcSandboxResult } from "@commonfabric/runner/cfc";
import { isObjectOrArray } from "@commonfabric/utils/types";

import {
  createFileSystemHarnessArtifactStore,
  readHarnessRunArtifacts,
  readHarnessRunReport,
  readHarnessRunState,
  readHarnessTranscript,
} from "../src/artifacts.ts";
import type { HarnessPolicyTrace } from "../src/contracts/policy-trace.ts";
import { CFC_PROMPT_SLOT_BOUND_ATOM_TYPE } from "../src/contracts/prompt-slot.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import { createPatternSkillsFixture } from "./support/pattern-skills-fixture.ts";
import {
  chatViewOfRequest,
  responsesBodyFromChatFixture,
} from "./support/responses-fixture.ts";

class FakeSandboxRuntime implements SandboxRuntime {
  readonly shellRequests: SandboxShellRequest[] = [];

  readonly #shellResults: SandboxCommandResult[];

  constructor(
    shellResults: SandboxCommandResult[] = [],
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

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    this.shellRequests.push(request);
    if (request.command.includes(CAPABILITY_PROBE_SENTINEL)) {
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
    return Promise.resolve(
      this.#shellResults.shift() ?? { stdout: "", stderr: "", exitCode: 0 },
    );
  }
}

const observedCfcResult = (
  stdout: string,
  options: {
    stderrPolicy?: "observed" | "denied";
    stderr?: string;
    exitCode?: number;
    stdoutLabel?: CfcSandboxResult["stdout"]["label"];
    stderrLabel?: CfcSandboxResult["stderr"]["label"];
    exitCodeLabel?: CfcSandboxResult["exitCode"]["label"];
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
  stderr: options.stderrPolicy === "denied"
    ? {
      channel: "stderr",
      policy: "denied",
      label: options.stderrLabel ?? {},
      reason: "stderr release denied",
    }
    : {
      channel: "stderr",
      policy: "observed",
      label: options.stderrLabel ?? {},
      segments: [{
        text: options.stderr ?? "",
        label: options.stderrLabel ?? {},
      }],
    },
  exitCode: {
    policy: "observed",
    label: options.exitCodeLabel ?? {},
    value: options.exitCode ?? 0,
  },
});

const labelHasConfidentialityValue = (
  label: unknown,
  value: unknown,
): boolean =>
  isObjectOrArray(label) &&
  "confidentiality" in label &&
  Array.isArray(label.confidentiality) &&
  label.confidentiality.some((entry) =>
    JSON.stringify(entry) === JSON.stringify(value)
  );

const cfcInputLabelContains = (
  labels: unknown,
  pathRoot: string,
  value: unknown,
): boolean => {
  if (
    !isObjectOrArray(labels) ||
    !("entries" in labels) ||
    !Array.isArray(labels.entries)
  ) {
    return false;
  }
  const entry = labels.entries.find((entry) =>
    isObjectOrArray(entry) &&
    "path" in entry &&
    Array.isArray(entry.path) &&
    entry.path.length === 1 &&
    entry.path[0] === pathRoot
  );
  return isObjectOrArray(entry) && "label" in entry &&
    labelHasConfidentialityValue(entry.label, value);
};

Deno.test({
  name:
    "CfHarnessEngine persists run state and tool output artifacts when artifactRoot is configured",
  permissions: { read: true, write: true },
  async fn() {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-artifacts-",
    });
    try {
      const engine = new CfHarnessEngine({
        artifactRoot,
        sandboxRuntime: new FakeSandboxRuntime([
          { stdout: "hello\n", stderr: "", exitCode: 0 },
        ]),
        runId: "run-artifacts",
        // The persisted run state and the invocation context beside it are both
        // asserted to record this rung.
        cfcEnforcementMode: "observe",
        now: (() => {
          const timestamps = [
            "2026-04-15T21:00:00.000Z",
            "2026-04-15T21:00:01.000Z",
            "2026-04-15T21:00:02.000Z",
            "2026-04-15T21:00:03.000Z",
            "2026-04-15T21:00:04.000Z",
          ];
          return () => timestamps.shift() ?? "2026-04-15T21:00:05.000Z";
        })(),
      });

      const result = await engine.invokeBuiltinTool("bash", {
        command: "echo hello",
      });
      const runRoot = join(artifactRoot, "run-artifacts");
      const persistedState = await readHarnessRunState(
        join(runRoot, "run-state.json"),
      );
      const capabilitySnapshotPath = join(runRoot, "capabilities.json");

      assertEquals(
        result.resultRef.artifactPath,
        join(
          runRoot,
          "tool-outputs",
          "run-artifacts_bash_1-bash.json",
        ),
      );
      assertEquals(
        JSON.parse(await Deno.readTextFile(result.resultRef.artifactPath!)),
        {
          outputId: createToolOutputId("run-artifacts", "bash", 1),
          stdout: "hello\n",
          stderr: "",
          exitCode: 0,
          cwd: "/workspace",
        },
      );
      assertEquals(
        JSON.parse(await Deno.readTextFile(capabilitySnapshotPath)),
        persistedState.capabilitySnapshot,
      );
      assertEquals(persistedState, {
        runId: "run-artifacts",
        status: "pending",
        createdAt: "2026-04-15T21:00:00.000Z",
        updatedAt: "2026-04-15T21:00:05.000Z",
        cfcEnforcementMode: "observe",
        modelProvider: "openai-compatible-gateway",
        modelAuthSource: "api-key",
        cfcInvocationContexts: [{
          type: "cf-harness.cfc-invocation-context",
          version: 1,
          sequence: 1,
          runId: "run-artifacts",
          createdAt: "2026-04-15T21:00:03.000Z",
          toolId: "bash",
          toolOutputId: createToolOutputId("run-artifacts", "bash", 1),
          operation: "shell",
          cfcEnforcementMode: "observe",
          cwd: "/workspace",
          runManifest: { present: false },
          inputs: {
            command: {
              type: "cf-harness.redacted-text-summary",
              bytes: 218,
              digest:
                "sha256:639e51198d6d74a7eaf2333cf7cb33819448ba30b4c8aa668809cda975728cfd",
            },
          },
        }],
        currentDir: "/workspace",
        docsCorpus: {
          type: "cf-harness.docs-corpus-record",
          source: "checkout-default",
          roots: checkoutDocsCorpusRoots(),
        },
        skillsRoot: resolveHarnessSkillsRoot(),
        artifactRoot: runRoot,
        capabilitySnapshot: {
          type: "cf-harness.capability-snapshot",
          at: "2026-04-15T21:00:01.000Z",
          model: {
            providerId: "openai-compatible-gateway",
            authSource: "api-key",
          },
          cfc: {
            enforcementMode: "observe",
            absenceBehavior: "observe-only",
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
        },
        capabilitiesPath: capabilitySnapshotPath,
        policyEvents: [],
        toolOutputs: [result.resultRef],
        failureRecords: [],
      });
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  },
});

Deno.test({
  name: "CfHarnessEngine persists Loom run manifest artifacts",
  permissions: { read: true, write: true },
  async fn() {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-manifest-",
    });
    const runManifest = {
      type: "cf-harness.loom-run-manifest" as const,
      version: 1 as const,
      source: "loom" as const,
      wishId: "W-519",
      cfc: { enforcementMode: "observe" as const },
    };
    try {
      const engine = new CfHarnessEngine({
        artifactRoot,
        sandboxRuntime: new FakeSandboxRuntime([
          { stdout: "ok\n", stderr: "", exitCode: 0 },
        ]),
        runId: "run-with-manifest",
        runManifest,
        runManifestPath: "/tmp/original-loom-run-manifest.json",
      });

      await engine.invokeBuiltinTool("bash", { command: "echo ok" });

      const runRoot = join(artifactRoot, "run-with-manifest");
      const manifestPath = join(runRoot, "run-manifest.json");
      const persistedState = await readHarnessRunState(
        join(runRoot, "run-state.json"),
      );

      assertEquals(
        JSON.parse(await Deno.readTextFile(manifestPath)),
        runManifest,
      );
      assertEquals(persistedState.cfcEnforcementMode, "observe");
      assertEquals(persistedState.runManifest, runManifest);
      assertEquals(persistedState.runManifestPath, manifestPath);
      assertEquals(persistedState.capabilitySnapshot?.cfc.runManifest, {
        present: true,
        type: "cf-harness.loom-run-manifest",
        path: manifestPath,
      });
      assertEquals(
        persistedState.capabilitySnapshot?.cfc.substrateStatus,
        "manifest-present",
      );
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "CfHarnessPromptLoop persists the transcript when artifactRoot is configured",
  permissions: { read: true, write: true },
  async fn() {
    await using fixture = await createPatternSkillsFixture();
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-transcript-",
    });
    try {
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          artifactRoot,
          sandboxRuntime: new FakeSandboxRuntime([
            {
              stdout: "hello from file",
              stderr: "",
              exitCode: 0,
              cfcResult: observedCfcResult("hello from file"),
            },
          ]),
          runId: "run-loop-persisted",
          model: "gpt-5.4",
          skillsRoot: fixture.skillsRoot,
          // Read back off the persisted snapshot below: the operator's switch
          // has to survive the whole `engine.config` to run-state path, not
          // only the projection that builds the snapshot object.
          allowSkillScripts: true,
          // The policy-snapshot comparison below reads this rung and its
          // source back, and the run reads a file, which a rung above this
          // one refuses without direct-command authorization.
          cfcEnforcementMode: "enforce-explicit",
          now: (() => {
            const timestamps = [
              "2026-04-15T21:10:00.000Z",
              "2026-04-15T21:10:01.000Z",
              "2026-04-15T21:10:02.000Z",
              "2026-04-15T21:10:03.000Z",
              "2026-04-15T21:10:04.000Z",
              "2026-04-15T21:10:05.000Z",
              "2026-04-15T21:10:06.000Z",
            ];
            return () => timestamps.shift() ?? "2026-04-15T21:10:07.000Z";
          })(),
        }),
        fetchFn: (_input, init) => {
          const body = JSON.parse(String(init?.body)) as {
            messages: Array<{ role: string }>;
          };
          const payload = chatViewOfRequest(body).messages.some((message) =>
              message.role === "tool"
            )
            ? {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "Persisted summary.",
                },
              }],
            }
            : {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({ path: "notes/todo.txt" }),
                    },
                  }],
                },
              }],
            };
          return Promise.resolve(
            new Response(
              JSON.stringify(responsesBodyFromChatFixture(payload, init?.body)),
              { status: 200 },
            ),
          );
        },
      });

      const result = await loop.runPrompt({
        prompt: "Summarize the todo file.",
      });

      const runRoot = join(artifactRoot, "run-loop-persisted");
      const transcriptPath = join(runRoot, "transcript.json");
      const policySnapshotPath = join(runRoot, "policy-snapshot.json");
      const policyTracePath = join(runRoot, "policy-trace.json");
      const runReportPath = join(runRoot, "run-report.json");
      const persistedState = await readHarnessRunState(
        join(runRoot, "run-state.json"),
      );
      const persistedPolicySnapshot = JSON.parse(
        await Deno.readTextFile(policySnapshotPath),
      );
      const persistedPolicyTrace = JSON.parse(
        await Deno.readTextFile(policyTracePath),
      );
      const persistedReport = await readHarnessRunReport(runReportPath);

      assertEquals(result.runState.transcriptPath, transcriptPath);
      assertEquals(result.runState.cfcPolicySnapshotPath, policySnapshotPath);
      assertEquals(result.runState.policyTracePath, policyTracePath);
      assertEquals(result.runState.runReportPath, runReportPath);
      assertEquals(
        await readHarnessTranscript(transcriptPath),
        result.transcript,
      );
      assertEquals(persistedState.transcriptPath, transcriptPath);
      assertEquals(persistedState.cfcPolicySnapshotPath, policySnapshotPath);
      assertEquals(persistedState.cfcPolicySnapshot, persistedPolicySnapshot);
      assertEquals(persistedState.policyTracePath, policyTracePath);
      assertEquals(persistedState.policyTrace, persistedPolicyTrace);
      assertEquals(persistedState.runReportPath, runReportPath);
      assertEquals(persistedState.artifactRoot, runRoot);
      assertEquals(persistedState.endedAt, "2026-04-15T21:10:07.000Z");
      assertEquals(persistedState.terminalReason, "assistant_completed");
      assertEquals(persistedState.policyEvents, []);
      assertEquals(persistedState.failureRecords, []);
      assertEquals(
        persistedState.capabilitySnapshot?.commands.python3.present,
        true,
      );
      assertEquals(
        persistedPolicySnapshot.type,
        "cf-harness.cfc-policy-snapshot",
      );
      assertEquals(persistedPolicySnapshot.version, 1);
      assertEquals(
        persistedPolicySnapshot.generatedAt,
        "2026-04-15T21:10:03.000Z",
      );
      assertEquals(persistedPolicySnapshot.cfc, {
        enforcementMode: "enforce-explicit",
        enforcementModeSource: "explicit-config",
        absenceBehavior: "fail-closed-if-absent",
        substrateStatus: "not-attested",
      });
      assertEquals(persistedPolicySnapshot.skillScripts, {
        allowSkillScripts: true,
        allowedScripts: [],
      });
      assertEquals(persistedPolicySnapshot.runManifest, { present: false });
      assertEquals(persistedPolicySnapshot.promptSlot, {
        present: false,
        bindingSource: "absent",
      });
      assertEquals(persistedPolicySnapshot.parentTools, {
        allowance: "all-builtins",
        allowedToolIds: [
          "bash",
          "read_file",
          "view_image",
          "read_skill_resource",
          "edit_file",
          "write_file",
          "delegate_task",
          "describe_handle",
          "finish_task",
          "research",
        ],
      });
      assertEquals(persistedPolicySnapshot.subagents.allowedProfiles, [
        "default",
      ]);
      assertEquals(
        persistedPolicySnapshot.subagents.profileConfigs[0].allowedToolIds,
        ["bash", "read_file", "view_image", "edit_file", "write_file"],
      );
      assertEquals(
        persistedPolicySnapshot.substrate?.sandbox?.kind,
        "docker-runsc-cfc",
      );
      assertEquals(persistedPolicyTrace.type, "cf-harness.policy-trace");
      assertEquals(persistedPolicyTrace.version, 1);
      assertEquals(persistedPolicyTrace.runId, "run-loop-persisted");
      assertEquals(
        persistedPolicyTrace.cfcPolicySnapshotPath,
        policySnapshotPath,
      );
      assertEquals(
        persistedPolicyTrace.cfcPolicySnapshotDigest.startsWith("sha256:"),
        true,
      );
      assertEquals(persistedPolicyTrace.decisionCounts, {
        total: 1,
        allowed: 1,
        warned: 0,
        denied: 0,
        invalid: 0,
        withheld: 0,
      });
      assertEquals(persistedPolicyTrace.decisions[0], {
        type: "cf-harness.policy-decision",
        sequence: 1,
        runId: "run-loop-persisted",
        at: "2026-04-15T21:10:07.000Z",
        toolActivitySequence: 1,
        toolCallId: "call-1",
        toolId: "read_file",
        effectClass: "read",
        cfcEnforcementMode: "enforce-explicit",
        decision: "allowed",
        reasonCodes: ["cfc_enforce_explicit_read"],
        toolInputSummary: {
          type: "cf-harness.tool-input-summary",
          toolId: "read_file",
          path: "notes/todo.txt",
        },
      });
      assertEquals(persistedPolicyTrace.cfcInvocationContexts?.length, 1);
      assertEquals(
        persistedPolicyTrace.cfcInvocationContexts?.[0].toolId,
        "read_file",
      );
      assertEquals(
        persistedPolicyTrace.cfcInvocationContexts?.[0].inputs.args?.count,
        2,
      );
      assertEquals(
        JSON.stringify(persistedPolicyTrace).includes("hello from file"),
        false,
      );
      assertEquals(persistedReport.type, "cf-harness.run-report");
      assertEquals(persistedReport.runId, "run-loop-persisted");
      assertEquals(persistedReport.status, "completed");
      assertEquals(persistedReport.model, "gpt-5.4");
      assertEquals(
        persistedReport.modelProvider,
        "openai-compatible-gateway",
      );
      assertEquals(persistedReport.modelAuthSource, "api-key");
      assertEquals(persistedReport.modelTurns, 2);
      assertEquals(persistedReport.finalAssistantText, "Persisted summary.");
      assertEquals(persistedReport.cfcPolicySnapshot, persistedPolicySnapshot);
      assertEquals(persistedReport.policyTracePath, policyTracePath);
      assertEquals(persistedReport.policyTrace, persistedPolicyTrace);
      assertEquals(persistedReport.policyDecisionCounts, {
        total: 1,
        allowed: 1,
        warned: 0,
        denied: 0,
        invalid: 0,
        withheld: 0,
      });
      assertEquals(persistedReport.policyDecisions, [
        persistedPolicyTrace.decisions[0],
      ]);
      assertEquals(persistedReport.policyEventCounts, {
        total: 0,
        warnings: 0,
        denied: 0,
      });
      assertEquals(persistedReport.toolActivity.length, 1);
      assertEquals(persistedReport.toolActivity[0], {
        type: "cf-harness.tool-activity",
        runId: "run-loop-persisted",
        sequence: 1,
        startedAt: "2026-04-15T21:10:06.000Z",
        endedAt: "2026-04-15T21:10:07.000Z",
        toolCallId: "call-1",
        toolId: "read_file",
        effectClass: "read",
        cfcEnforcementMode: "enforce-explicit",
        policyDecision: "allowed",
        executionStatus: "completed",
        toolInputSummary: {
          type: "cf-harness.tool-input-summary",
          toolId: "read_file",
          path: "notes/todo.txt",
        },
        resultRef: result.runState.toolOutputs[0],
      });
      assertEquals(persistedReport.modelAttempts?.length, 2);
      assertEquals(
        persistedReport.modelAttempts?.map((attempt) => attempt.providerId),
        ["openai-compatible-gateway", "openai-compatible-gateway"],
      );
      assertEquals(
        persistedReport.modelAttempts?.map((attempt) => attempt.operation),
        ["responses", "responses"],
      );
      assertEquals(
        persistedReport.modelAttempts?.map((attempt) => attempt.sequence),
        [1, 2],
      );
      assertEquals(
        persistedReport.modelAttempts?.map((attempt) => attempt.modelTurn),
        [1, 2],
      );
      assertEquals(
        persistedReport.modelAttempts?.map((attempt) => attempt.runId),
        ["run-loop-persisted", "run-loop-persisted"],
      );
      assertEquals(
        persistedReport.modelAttempts?.[0].outcome,
        "http_response",
      );
      assertEquals(persistedReport.modelAttempts?.[0].httpStatus, 200);
      assertEquals(
        {
          model: persistedReport.modelAttempts?.[0].request.model,
          messageCount: persistedReport.modelAttempts?.[0].request
            .messageCount,
          toolCount: persistedReport.modelAttempts?.[0].request.toolCount,
        },
        {
          model: "gpt-5.4",
          messageCount: 1,
          toolCount: 10,
        },
      );
      assert(
        (persistedReport.modelAttempts?.[0].request.serializedBytes ?? 0) >
          0,
      );
      assertEquals(
        persistedReport.modelAttempts?.[1].request.messageCount,
        3,
      );
      assertEquals(
        JSON.stringify(persistedReport.modelAttempts).includes(
          "Summarize the todo file.",
        ),
        false,
      );
      assertEquals(
        persistedReport.timeline.map((entry) => entry.kind),
        [
          "run_started",
          "transcript_message",
          "transcript_message",
          "tool_activity",
          "transcript_message",
          "transcript_message",
          "run_finished",
        ],
      );
      assertEquals(
        persistedReport.timeline
          .filter((entry) => entry.kind === "transcript_message")
          .map((entry) => entry.role),
        ["user", "assistant", "tool", "assistant"],
      );
      assertEquals(
        persistedReport.timeline.find((entry) =>
          entry.kind === "tool_activity"
        ),
        {
          type: "cf-harness.timeline-entry",
          sequence: 4,
          kind: "tool_activity",
          at: "2026-04-15T21:10:06.000Z",
          endedAt: "2026-04-15T21:10:07.000Z",
          toolActivitySequence: 1,
          toolCallId: "call-1",
          toolId: "read_file",
          policyDecision: "allowed",
          executionStatus: "completed",
        },
      );
      assertEquals(
        persistedReport.timeline[persistedReport.timeline.length - 1],
        {
          type: "cf-harness.timeline-entry",
          sequence: 7,
          kind: "run_finished",
          at: "2026-04-15T21:10:07.000Z",
          status: "completed",
          terminalReason: "assistant_completed",
        },
      );
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "CfHarnessPromptLoop persists CFC model-context continuity across run artifacts",
  permissions: { read: true, write: true },
  async fn() {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-cfc-continuity-",
    });
    const promptSlotBinding = {
      type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
      source: {
        type: "test.prompt-slot",
        subject: "cfc-continuity-artifact-test",
      },
      role: "direct-command",
      kernelName: "cf-harness",
      surface: "test",
      subject: "cfc-continuity-artifact-test",
      eventId: "event-cfc-continuity",
      valueDigest: "sha256:test-prompt-value",
    } as const;
    const runManifest = {
      type: "cf-harness.loom-run-manifest",
      version: 1,
      source: "loom",
      instanceId: "loom-test",
      wishId: "W-CFC-CONTINUITY",
      dispatchClass: "gtd-ops",
      capabilityProfile: "read_file write_file bash",
      promptSlot: promptSlotBinding,
      cfc: {
        enforcementMode: "enforce-explicit",
        labelSource: "loom-run-manifest",
      },
    } as const;
    const secretLabel = {
      type: "test.cfc/source",
      id: "alice-secret",
    };
    try {
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          artifactRoot,
          sandboxRuntime: new FakeSandboxRuntime([
            {
              stdout: "raw secret\n",
              stderr: "",
              exitCode: 0,
              cfcResult: observedCfcResult("released secret\n", {
                stderrPolicy: "denied",
                stdoutLabel: { confidentiality: [secretLabel] },
              }),
            },
            {
              stdout: "raw later\n",
              stderr: "",
              exitCode: 0,
              cfcResult: observedCfcResult("released later\n", {
                stdoutLabel: {},
              }),
            },
          ]),
          runId: "run-cfc-continuity-artifacts",
          model: "gpt-5.4",
          runManifest,
          runManifestPath: "/tmp/original-cfc-continuity-manifest.json",
        }),
        fetchFn: (_input, init) => {
          const body = JSON.parse(String(init?.body)) as {
            messages: Array<{ role: string; content?: string }>;
          };
          const hasToolResponse = chatViewOfRequest(body).messages.some((
            message,
          ) => message.role === "tool");
          const toolResponseCount =
            chatViewOfRequest(body).messages.filter((message) =>
              message.role === "tool"
            ).length;
          const payload = !hasToolResponse
            ? {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{
                    id: "call-read-secret",
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({
                        command: "cat secret.txt",
                      }),
                    },
                  }],
                },
              }],
            }
            : toolResponseCount === 1
            ? {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{
                    id: "call-use-secret",
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({
                        command: "printf done",
                      }),
                    },
                  }],
                },
              }],
            }
            : {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "CFC continuity smoke complete.",
                },
              }],
            };
          return Promise.resolve(
            new Response(
              JSON.stringify(responsesBodyFromChatFixture(payload, init?.body)),
              { status: 200 },
            ),
          );
        },
      });

      const result = await loop.runPrompt({
        prompt: "Run a CFC continuity smoke.",
        promptSlotBinding,
      });

      const runRoot = join(artifactRoot, "run-cfc-continuity-artifacts");
      const persistedState = await readHarnessRunState(
        join(runRoot, "run-state.json"),
      );
      const persistedPolicyTrace = JSON.parse(
        await Deno.readTextFile(join(runRoot, "policy-trace.json")),
      ) as HarnessPolicyTrace;
      const persistedReport = await readHarnessRunReport(
        join(runRoot, "run-report.json"),
      );

      assertEquals(result.finalAssistantText, "CFC continuity smoke complete.");
      assertEquals(persistedState.cfcEnforcementMode, "enforce-explicit");
      assertEquals(persistedState.runManifest, runManifest);
      assertEquals(
        persistedState.runManifestPath,
        join(runRoot, "run-manifest.json"),
      );
      assertEquals(persistedState.promptSlotBinding, promptSlotBinding);
      assertEquals(persistedState.cfcInvocationContexts?.length, 2);
      assertEquals(
        persistedState.cfcInvocationContexts?.map((context) => context.toolId),
        ["bash", "bash"],
      );
      assertEquals(
        persistedState.cfcInvocationContexts?.[0].runManifest,
        {
          present: true,
          path: join(runRoot, "run-manifest.json"),
          source: "loom",
          wishId: "W-CFC-CONTINUITY",
          dispatchClass: "gtd-ops",
          cfcEnforcementMode: "enforce-explicit",
          promptSlotPresent: true,
        },
      );
      assertEquals(
        cfcInputLabelContains(
          persistedState.cfcInvocationContexts?.[0].cfcInputLabels,
          "command",
          secretLabel,
        ),
        false,
      );
      assertEquals(
        cfcInputLabelContains(
          persistedState.cfcInvocationContexts?.[1].cfcInputLabels,
          "command",
          secretLabel,
        ),
        true,
      );
      assertEquals(
        labelHasConfidentialityValue(
          persistedState.cfcModelContext?.label,
          secretLabel,
        ),
        true,
      );
      const cfcModelContext = persistedState.cfcModelContext;
      assert(cfcModelContext !== undefined);
      assertEquals(cfcModelContext.observations.length, 1);
      assertEquals(
        cfcModelContext.observations[0],
        {
          type: "cf-harness.cfc-model-context-observation",
          sequence: 1,
          at: cfcModelContext.updatedAt,
          toolCallId: "call-read-secret",
          toolId: "bash",
          outputId: createToolOutputId(
            "run-cfc-continuity-artifacts",
            "bash",
            1,
          ),
          channels: ["stdout"],
          policy: "observed",
          label: { confidentiality: [secretLabel] },
        },
      );
      assertEquals(
        persistedPolicyTrace.cfcInvocationContexts?.length,
        2,
      );
      assertEquals(
        cfcInputLabelContains(
          persistedPolicyTrace.cfcInvocationContexts?.[1].cfcInputLabels,
          "command",
          secretLabel,
        ),
        true,
      );
      assertEquals(
        persistedReport.policyTrace?.cfcInvocationContexts?.length,
        2,
      );
      assertEquals(persistedReport.modelTurns, 3);
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "CfHarnessPromptLoop persists subagent refs, child artifacts, and report timeline",
  permissions: { read: true, write: true },
  async fn() {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-subagent-",
    });
    try {
      const promptSlotBinding = {
        type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
        source: { type: "test.prompt-slot", subject: "subagent-artifact-test" },
        role: "direct-command",
        kernelName: "cf-harness",
        surface: "test",
        subject: "subagent-artifact-test",
        eventId: "event-subagent-artifact",
      } as const;
      const requestBodies: Array<{
        messages: Array<{ role: string; content: string }>;
        tools: Array<{ function: { name: string } }>;
      }> = [];
      const credentialOwner = {
        type: "cf-harness.credential-owner-ref" as const,
        version: 1 as const,
        ownerKey: "loom:user-a",
        tenantKey: "loom:tenant-a",
      };
      let runningSubagentRef: unknown;
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          artifactRoot,
          sandboxRuntime: new FakeSandboxRuntime(),
          runId: "run-subagent-persisted",
          model: "gpt-5.4",
          runManifest: {
            type: "cf-harness.loom-run-manifest",
            version: 1,
            source: "loom",
            credentialOwner,
          },
        }),
        fetchFn: async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as {
            messages: Array<{ role: string; content: string }>;
            tools: Array<{ function: { name: string } }>;
          };
          requestBodies.push(body);
          if (requestBodies.length === 2) {
            const parentWhileChildRunning = await readHarnessRunState(
              join(
                artifactRoot,
                "run-subagent-persisted",
                "run-state.json",
              ),
            );
            runningSubagentRef = parentWhileChildRunning.subagentRuns?.[0];
          }
          const payload = requestBodies.length === 1
            ? {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{
                    id: "call-subagent-persisted",
                    type: "function",
                    function: {
                      name: "delegate_task",
                      arguments: JSON.stringify({
                        goal: "Inspect persisted child artifacts.",
                        context: "Return a short summary.",
                      }),
                    },
                  }],
                },
              }],
            }
            : requestBodies.length === 2
            ? {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "Child artifact summary.",
                },
              }],
            }
            : {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "Parent artifact summary.",
                },
              }],
            };
          return new Response(
            JSON.stringify(responsesBodyFromChatFixture(payload, init?.body)),
            { status: 200 },
          );
        },
      });

      const result = await loop.runPrompt({
        prompt: "Delegate and persist the child run.",
        promptSlotBinding,
      });

      const runRoot = join(artifactRoot, "run-subagent-persisted");
      const childRunRoot = join(
        artifactRoot,
        "run-subagent-persisted.subagent.1",
      );
      const persistedState = await readHarnessRunState(
        join(runRoot, "run-state.json"),
      );
      const persistedReport = await readHarnessRunReport(
        join(runRoot, "run-report.json"),
      );
      const childState = await readHarnessRunState(
        join(childRunRoot, "run-state.json"),
      );
      const childTranscript = await readHarnessTranscript(
        join(childRunRoot, "transcript.json"),
      );
      const delegateToolOutput = JSON.parse(
        await Deno.readTextFile(persistedState.toolOutputs[0].artifactPath!),
      ) as {
        type: string;
        outputId: string;
        subagent: {
          childRunId: string;
          status: string;
          summary: string;
        };
      };

      assertEquals(result.finalAssistantText, "Parent artifact summary.");
      assertEquals(persistedState.subagentRuns?.length, 1);
      const subagentRun = persistedState.subagentRuns?.[0];
      if (subagentRun === undefined) {
        throw new Error("expected persisted subagent run ref");
      }
      assertEquals(subagentRun, result.runState.subagentRuns?.[0]);
      assertEquals(
        subagentRun.outputId,
        createToolOutputId("run-subagent-persisted", "delegate_task", 1),
      );
      assertEquals(subagentRun.parentToolCallId, "call-subagent-persisted");
      assertEquals(
        subagentRun.childRunId,
        "run-subagent-persisted.subagent.1",
      );
      assertEquals(subagentRun.status, "completed");
      if (subagentRun.status === "running") {
        throw new Error("expected terminal subagent run ref");
      }
      assertEquals(subagentRun.summary, "Child artifact summary.");
      assertEquals(subagentRun.manifest.allowedToolIds, [
        "bash",
        "read_file",
        "view_image",
        "edit_file",
        "write_file",
      ]);
      assertEquals(subagentRun.manifest.hostToolIds, []);
      assertEquals(subagentRun.manifest.returnPolicy, {
        type: "cf-harness.subagent-return-policy",
        channel: "summary-and-sanitized-state",
        includeSummary: true,
        includeSanitizedRunState: true,
        includeManifest: true,
        includeTranscript: false,
        includeRawFailureRecords: false,
      });
      assertEquals(
        subagentRun.manifest.inputSummary.goalDigest.startsWith("sha256:"),
        true,
      );
      assertEquals(subagentRun.runState.artifactRoot, childRunRoot);
      assertEquals(runningSubagentRef, {
        type: "cf-harness.subagent-run-ref",
        parentToolCallId: "call-subagent-persisted",
        childRunId: "run-subagent-persisted.subagent.1",
        status: "running",
        manifest: subagentRun.manifest,
      });

      assertEquals(childState.runId, "run-subagent-persisted.subagent.1");
      assertEquals(childState.lineage, {
        role: "subagent",
        rootRunId: "run-subagent-persisted",
        parentRunId: "run-subagent-persisted",
        parentToolCallId: "call-subagent-persisted",
        depth: 1,
      });
      assertEquals(childState.runManifest?.source, "loom");
      assertEquals(childState.runManifest?.credentialOwner, credentialOwner);
      // The child scans the tree its parent scanned, and records how that tree
      // was arrived at rather than relabelling an inherited default as
      // something an operator named.
      assertEquals(childState.skillsRoot?.source, "checkout-default");
      assertEquals(childState.skillsRoot, persistedState.skillsRoot);
      assertEquals(childState.status, "completed");
      assertEquals(childState.artifactRoot, childRunRoot);
      assertEquals(
        childState.transcriptPath,
        join(childRunRoot, "transcript.json"),
      );
      assertEquals(
        childState.runReportPath,
        join(childRunRoot, "run-report.json"),
      );
      assertEquals(childState.terminalReason, "assistant_completed");
      assertEquals(childTranscript.map((message) => message.role), [
        "system",
        "user",
        "assistant",
      ]);
      assertEquals(
        childTranscript[1].content.includes(
          "Inspect persisted child artifacts.",
        ),
        true,
      );
      assertEquals(
        childTranscript[1].content.includes(
          "Delegate and persist the child run.",
        ),
        false,
      );

      assertEquals(delegateToolOutput.type, "cf-harness.delegate-task-output");
      assertEquals(
        delegateToolOutput.subagent.childRunId,
        subagentRun.childRunId,
      );
      assertEquals(delegateToolOutput.subagent.status, "completed");
      assertEquals(
        delegateToolOutput.subagent.summary,
        "Child artifact summary.",
      );

      assertEquals(persistedReport.subagentRuns?.[0], subagentRun);
      assertEquals(persistedReport.toolActivity[0].toolId, "delegate_task");
      assertEquals(persistedReport.toolActivity[0].effectClass, "side-effect");
      assertEquals(
        persistedReport.toolActivity[0].resultRef?.outputId,
        createToolOutputId("run-subagent-persisted", "delegate_task", 1),
      );
      const timelineEntry = persistedReport.timeline.find((entry) =>
        entry.kind === "subagent_run"
      );
      if (timelineEntry === undefined) {
        throw new Error("expected subagent_run timeline entry");
      }
      assertEquals(timelineEntry.toolCallId, "call-subagent-persisted");
      assertEquals(
        timelineEntry.childRunId,
        "run-subagent-persisted.subagent.1",
      );
      assertEquals(timelineEntry.subagentStatus, "completed");
      assertEquals(timelineEntry.status, "completed");
      assertEquals(timelineEntry.terminalReason, "assistant_completed");
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "CfHarnessPromptLoop keeps raw child failure fields out of parent delegate output",
  permissions: { read: true, write: true },
  async fn() {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-subagent-failure-",
    });
    const rawChildCommand = "secret-child-command --token=raw-child-detail";
    try {
      const promptSlotBinding = {
        type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
        source: {
          type: "test.prompt-slot",
          subject: "subagent-failure-artifact-test",
        },
        role: "direct-command",
        kernelName: "cf-harness",
        surface: "test",
        subject: "subagent-failure-artifact-test",
        eventId: "event-subagent-failure-artifact",
      } as const;
      let requestCount = 0;
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          artifactRoot,
          sandboxRuntime: new FakeSandboxRuntime([
            {
              stdout: "",
              stderr: "/bin/sh: secret-child-command: command not found\n",
              exitCode: 127,
            },
          ]),
          runId: "run-subagent-sanitized-failure",
          model: "gpt-5.4",
          // The child's second failure is the `tool_not_allowed` policy event
          // this rung produces, and the run asserts a failure count of two.
          cfcEnforcementMode: "enforce-explicit",
        }),
        fetchFn: (_input, init) => {
          requestCount += 1;
          const payload = requestCount === 1
            ? {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{
                    id: "call-subagent-sanitized-failure",
                    type: "function",
                    function: {
                      name: "delegate_task",
                      arguments: JSON.stringify({
                        goal: "Run a diagnostic command and summarize failure.",
                      }),
                    },
                  }],
                },
              }],
            }
            : requestCount === 2
            ? {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{
                    id: "call-child-bash-failure",
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({
                        command: rawChildCommand,
                      }),
                    },
                  }],
                },
              }],
            }
            : requestCount === 3
            ? {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "Child summarized the failed diagnostic command.",
                },
              }],
            }
            : {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "Parent received the sanitized child summary.",
                },
              }],
            };
          return Promise.resolve(
            new Response(
              JSON.stringify(responsesBodyFromChatFixture(payload, init?.body)),
              { status: 200 },
            ),
          );
        },
      });

      await loop.runPrompt({
        prompt: "Delegate a diagnostic command.",
        promptSlotBinding,
      });

      const runRoot = join(artifactRoot, "run-subagent-sanitized-failure");
      const childRunRoot = join(
        artifactRoot,
        "run-subagent-sanitized-failure.subagent.1",
      );
      const persistedState = await readHarnessRunState(
        join(runRoot, "run-state.json"),
      );
      const childState = await readHarnessRunState(
        join(childRunRoot, "run-state.json"),
      );
      const delegateToolOutput = JSON.parse(
        await Deno.readTextFile(persistedState.toolOutputs[0].artifactPath!),
      ) as {
        subagent: {
          runState: {
            failureCount: number;
            primaryFailure?: Record<string, unknown>;
          };
        };
      };
      const parentFailure = delegateToolOutput.subagent.runState.primaryFailure;
      if (parentFailure === undefined) {
        throw new Error("expected sanitized parent failure summary");
      }

      assertEquals(delegateToolOutput.subagent.runState.failureCount, 2);
      assertEquals(parentFailure.type, "cf-harness.subagent-failure-summary");
      assertEquals(parentFailure.kind, "tool_not_allowed");
      assertEquals(parentFailure.source, "policy_event");
      assertEquals(parentFailure.toolId, "bash");
      // The call id is the child model's own text, so it stays in the audit
      // artifacts rather than reaching the parent model.
      assertEquals("toolCallId" in parentFailure, false);
      assertEquals("outputId" in parentFailure, false);
      assertEquals("commandName" in parentFailure, false);
      assertEquals("exitCode" in parentFailure, false);
      assertEquals("command" in parentFailure, false);
      assertEquals("detail" in parentFailure, false);
      assertEquals("at" in parentFailure, false);
      assertEquals(
        JSON.stringify(delegateToolOutput).includes(rawChildCommand),
        false,
      );
      assertEquals(
        JSON.stringify(delegateToolOutput).includes("raw-child-detail"),
        false,
      );
      const persistedSubagentRun = persistedState.subagentRuns?.[0];
      if (
        persistedSubagentRun === undefined ||
        persistedSubagentRun.status === "running"
      ) {
        throw new Error("expected terminal persisted subagent run ref");
      }
      assertEquals(
        parentFailure,
        persistedSubagentRun.runState.primaryFailure as
          | Record<string, unknown>
          | undefined,
      );

      assertEquals(childState.primaryFailure?.kind, "tool_not_allowed");
      assertEquals(
        JSON.stringify(childState.primaryFailure).includes(rawChildCommand),
        false,
      );
      const missingBinaryFailure = childState.failureRecords?.find((failure) =>
        failure.kind === "missing_binary"
      );
      const deniedFailure = childState.failureRecords?.find((failure) =>
        failure.kind === "tool_not_allowed"
      );
      assertEquals(missingBinaryFailure?.command, rawChildCommand);
      assertEquals(
        missingBinaryFailure?.detail.includes(
          "secret-child-command",
        ),
        true,
      );
      assertEquals(deniedFailure?.source, "policy_event");
      assertEquals(deniedFailure?.toolId, "bash");
      assertEquals(
        JSON.stringify(deniedFailure).includes(
          rawChildCommand,
        ),
        false,
      );
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  },
});

Deno.test({
  name: "CfHarnessEngine persists prompt slot binding in run state artifacts",
  permissions: { read: true, write: true },
  async fn() {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-prompt-slot-",
    });
    try {
      const promptSlotBinding = {
        type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
        source: { type: "test.prompt-slot", subject: "artifact-test" },
        role: "direct-command",
        kernelName: "cf-harness",
        surface: "test",
        subject: "artifact-test",
        eventId: "event-artifact",
      } as const;
      const engine = new CfHarnessEngine({
        artifactRoot,
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-prompt-slot",
      });

      engine.setPromptSlotBinding(promptSlotBinding);
      await engine.persistRunState();

      const persistedState = await readHarnessRunState(
        join(artifactRoot, "run-prompt-slot", "run-state.json"),
      );
      assertEquals(persistedState.promptSlotBinding, promptSlotBinding);
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  },
});

Deno.test({
  name: "CfHarnessPromptLoop persists denied tool activity in the run report",
  permissions: { read: true, write: true },
  async fn() {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-denied-report-",
    });
    try {
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          artifactRoot,
          sandboxRuntime: new FakeSandboxRuntime(),
          runId: "run-denied-report",
          model: "gpt-5.4",
          // The write the run asks for is denied at this rung, and the persisted
          // tool activity is asserted to record the denial and the rung.
          cfcEnforcementMode: "enforce-explicit",
          now: (() => {
            const timestamps = [
              "2026-04-15T21:20:00.000Z",
              "2026-04-15T21:20:01.000Z",
              "2026-04-15T21:20:02.000Z",
              "2026-04-15T21:20:03.000Z",
              "2026-04-15T21:20:04.000Z",
              "2026-04-15T21:20:05.000Z",
              "2026-04-15T21:20:06.000Z",
              "2026-04-15T21:20:07.000Z",
              "2026-04-15T21:20:08.000Z",
              "2026-04-15T21:20:09.000Z",
            ];
            return () => timestamps.shift() ?? "2026-04-15T21:20:10.000Z";
          })(),
        }),
        fetchFn: (_input, init) => {
          const body = JSON.parse(String(init?.body)) as {
            messages: Array<{ role: string }>;
          };
          const payload = chatViewOfRequest(body).messages.some((message) =>
              message.role === "tool"
            )
            ? {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "Write was denied.",
                },
              }],
            }
            : {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{
                    id: "call-denied-report",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: JSON.stringify({
                        path: "notes/out.txt",
                        content: "nope",
                      }),
                    },
                  }],
                },
              }],
            };
          return Promise.resolve(
            new Response(
              JSON.stringify(responsesBodyFromChatFixture(payload, init?.body)),
              { status: 200 },
            ),
          );
        },
      });

      const result = await loop.runPrompt({
        prompt: "Write the output file.",
      });

      const runReport = await readHarnessRunReport(
        join(artifactRoot, "run-denied-report", "run-report.json"),
      );
      const policyTrace = JSON.parse(
        await Deno.readTextFile(
          join(artifactRoot, "run-denied-report", "policy-trace.json"),
        ),
      );

      assertEquals(result.runState.toolOutputs, []);
      assertEquals(policyTrace.decisionCounts, {
        total: 1,
        allowed: 0,
        warned: 0,
        denied: 1,
        invalid: 0,
        withheld: 0,
      });
      assertEquals(policyTrace.decisions[0].decision, "denied");
      assertEquals(policyTrace.decisions[0].reasonCodes, [
        "write_file_enforce_explicit_requires_direct_command",
      ]);
      assertEquals(policyTrace.decisions[0].policyEventIndexes, [0]);
      assertEquals(
        policyTrace.decisions[0].detail,
        "write_file requires direct-command authorization in enforce-explicit",
      );
      assertEquals(runReport.policyEventCounts, {
        total: 1,
        warnings: 0,
        denied: 1,
      });
      assertEquals(runReport.toolActivity, [{
        type: "cf-harness.tool-activity",
        runId: "run-denied-report",
        sequence: 1,
        startedAt: "2026-04-15T21:20:06.000Z",
        endedAt: "2026-04-15T21:20:07.000Z",
        toolCallId: "call-denied-report",
        toolId: "write_file",
        effectClass: "write",
        cfcEnforcementMode: "enforce-explicit",
        policyDecision: "denied",
        executionStatus: "not-run",
        toolInputSummary: {
          type: "cf-harness.tool-input-summary",
          toolId: "write_file",
          path: "notes/out.txt",
          mode: "replace",
          contentBytes: 4,
          contentDigest:
            "sha256:ca3704aa0b06f5954c79ee837faa152d84d6b2d42838f0637a15eda8337dbdce",
        },
        policyEventIndexes: [0],
      }]);
      assertEquals(
        runReport.timeline.map((entry) => entry.kind),
        [
          "run_started",
          "transcript_message",
          "transcript_message",
          "tool_activity",
          "policy_event",
          "failure_record",
          "transcript_message",
          "transcript_message",
          "run_finished",
        ],
      );
      assertEquals(
        runReport.timeline.find((entry) => entry.kind === "policy_event"),
        {
          type: "cf-harness.timeline-entry",
          sequence: 5,
          kind: "policy_event",
          at: "2026-04-15T21:20:07.000Z",
          policyEventIndex: 0,
          severity: "denied",
          toolCallId: "call-denied-report",
          toolId: "write_file",
        },
      );
      assertEquals(
        runReport.timeline.find((entry) => entry.kind === "tool_activity"),
        {
          type: "cf-harness.timeline-entry",
          sequence: 4,
          kind: "tool_activity",
          at: "2026-04-15T21:20:06.000Z",
          endedAt: "2026-04-15T21:20:07.000Z",
          toolActivitySequence: 1,
          toolCallId: "call-denied-report",
          toolId: "write_file",
          policyDecision: "denied",
          executionStatus: "not-run",
        },
      );
      assertEquals(
        runReport.timeline.find((entry) => entry.kind === "failure_record"),
        {
          type: "cf-harness.timeline-entry",
          sequence: 6,
          kind: "failure_record",
          at: "2026-04-15T21:20:07.000Z",
          failureRecordIndex: 0,
          failureKind: "tool_not_allowed",
          source: "policy_event",
          toolId: "write_file",
        },
      );
      assertEquals(JSON.stringify(runReport).includes("nope"), false);
      assertEquals(JSON.stringify(policyTrace).includes("nope"), false);
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "CfHarnessPromptLoop records output mediation denials in persisted tool activity",
  permissions: { read: true, write: true },
  async fn() {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-missing-cfc-report-",
    });
    try {
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          artifactRoot,
          sandboxRuntime: new FakeSandboxRuntime([
            { stdout: "secret from sandbox\n", stderr: "", exitCode: 0 },
          ]),
          runId: "run-missing-cfc-report",
          model: "gpt-5.4",
          // Output mediation denies the sandbox result at this rung, which is the
          // denial the run report is asserted to carry.
          cfcEnforcementMode: "enforce-explicit",
        }),
        fetchFn: (_input, init) => {
          const body = JSON.parse(String(init?.body)) as {
            messages: Array<{ role: string }>;
          };
          const payload = chatViewOfRequest(body).messages.some((message) =>
              message.role === "tool"
            )
            ? {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "Handled denied output.",
                },
              }],
            }
            : {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{
                    id: "call-missing-cfc-report",
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({
                        command: "cat secret.txt",
                      }),
                    },
                  }],
                },
              }],
            };
          return Promise.resolve(
            new Response(
              JSON.stringify(responsesBodyFromChatFixture(payload, init?.body)),
              { status: 200 },
            ),
          );
        },
      });

      const promptSlotBinding = {
        type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
        source: { type: "test.prompt-slot", subject: "artifact-test" },
        role: "direct-command",
        kernelName: "cf-harness",
        surface: "test",
        subject: "artifact-test",
        eventId: "event-artifact",
      } as const;
      const result = await loop.runPrompt({
        prompt: "Run the direct command.",
        promptSlotBinding,
      });
      const toolMessage = result.transcript.at(-2);
      if (toolMessage?.role !== "tool") {
        throw new Error("expected bash tool message");
      }
      const denied = JSON.parse(toolMessage.content) as {
        type: string;
        handle?: { metadataRef?: unknown };
      };
      const runRoot = join(artifactRoot, "run-missing-cfc-report");
      const runReport = await readHarnessRunReport(
        join(runRoot, "run-report.json"),
      );

      assertEquals(denied.type, "cf-harness.observation-denied");
      assertEquals(denied.handle?.metadataRef, undefined);
      assertEquals(toolMessage.content.includes("secret from sandbox"), false);
      assertEquals(toolMessage.content.includes(artifactRoot), false);
      assertEquals(runReport.policyEventCounts, {
        total: 1,
        warnings: 0,
        denied: 1,
      });
      assertEquals(runReport.toolActivity.length, 1);
      assertEquals(runReport.toolActivity[0]?.policyDecision, "denied");
      assertEquals(runReport.toolActivity[0]?.executionStatus, "completed");
      assertEquals(runReport.toolActivity[0]?.policyEventIndexes, [0]);
      assertEquals(
        runReport.toolActivity[0]?.resultRef?.artifactPath,
        join(
          runRoot,
          "tool-outputs",
          "run-missing-cfc-report_bash_1-bash.json",
        ),
      );
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  },
});

Deno.test("createFileSystemHarnessArtifactStore rejects path-traversal run ids", () => {
  assertThrows(
    () =>
      createFileSystemHarnessArtifactStore({
        artifactRoot: "/tmp/cf-harness-artifacts",
        runId: "../escape",
      }),
    Error,
    "runId must be a simple path segment",
  );
});

Deno.test({
  name: "readHarnessRunArtifacts confines transcript loading to the run root",
  permissions: { read: true, write: true },
  async fn() {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-read-artifacts-",
    });
    try {
      const runRoot = join(artifactRoot, "run-1");
      const runStatePath = join(runRoot, "run-state.json");
      const defaultTranscriptPath = join(runRoot, "transcript.json");
      const outsideTranscriptPath = join(artifactRoot, "outside.json");

      await Deno.mkdir(runRoot, { recursive: true });
      await Deno.writeTextFile(
        runStatePath,
        JSON.stringify({
          runId: "run-1",
          status: "completed",
          createdAt: "2026-04-17T20:00:00.000Z",
          updatedAt: "2026-04-17T20:00:01.000Z",
          cfcEnforcementMode: "observe",
          transcriptPath: outsideTranscriptPath,
          policyEvents: [],
          toolOutputs: [],
          failureRecords: [],
        }),
      );
      await Deno.writeTextFile(
        defaultTranscriptPath,
        JSON.stringify([{ role: "assistant", content: "inside transcript" }]),
      );
      await Deno.writeTextFile(
        outsideTranscriptPath,
        JSON.stringify([{ role: "assistant", content: "outside transcript" }]),
      );

      const artifacts = await readHarnessRunArtifacts(runRoot);

      assertEquals(artifacts.transcriptPath, defaultTranscriptPath);
      assertEquals(artifacts.transcript, [{
        role: "assistant",
        content: "inside transcript",
      }]);
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "filesystem artifact store advertises an image-attachment snapshot dir under its run root",
  permissions: { read: true, write: true },
  async fn() {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-artifacts-",
    });
    try {
      const store = createFileSystemHarnessArtifactStore({
        artifactRoot,
        runId: "run-snapshot-dir",
      });
      assertEquals(
        store.imageAttachmentSnapshotDir,
        join(store.runRoot, "image-attachments"),
      );
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  },
});

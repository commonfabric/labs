import { assertEquals } from "@std/assert";
import { readHarnessRunReport } from "../src/artifacts.ts";
import { createHarnessRunReport } from "../src/contracts/run-report.ts";

Deno.test("legacy run reports remain readable without provider metadata", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = `${directory}/run-report.json`;
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        type: "cf-harness.run-report",
        runId: "legacy-run",
        generatedAt: "2026-01-01T00:00:00.000Z",
        status: "completed",
        model: "legacy-model",
        modelTurns: 1,
        cfcEnforcementMode: "disabled",
        policyEventCounts: { total: 0, warnings: 0, denied: 0 },
        policyDecisionCounts: { total: 0, allowed: 0, warned: 0, denied: 0 },
        policyEvents: [],
        policyDecisions: [],
        timeline: [],
        toolActivity: [],
        toolOutputs: [],
      }),
    );

    const report = await readHarnessRunReport(path);
    assertEquals(report.modelProvider, undefined);
    assertEquals(report.modelAuthSource, undefined);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("run reports carry the fabric session's resolved CFC posture", () => {
  const fabricSessionCfc = {
    enforcementMode: "enforce-strict",
    enforcementModeSource: "configured",
    flowLabels: "persist",
    flowLabelsSource: "posture",
    posture: "max-enforcement",
  } as const;
  const report = createHarnessRunReport({
    runState: {
      runId: "postured-state",
      status: "completed",
      updatedAt: "2026-01-01T00:00:00.000Z",
      cfcEnforcementMode: "enforce-explicit",
      fabricSessionCfc,
      policyEvents: [],
      policyDecisions: [],
      toolOutputs: [],
    },
    model: "postured-model",
    modelTurns: 1,
    toolActivity: [],
  });

  assertEquals(report.fabricSessionCfc, fabricSessionCfc);
});

Deno.test("run reports omit the fabric-session posture when the run had no session", () => {
  const report = createHarnessRunReport({
    runState: {
      runId: "sessionless-state",
      status: "completed",
      updatedAt: "2026-01-01T00:00:00.000Z",
      cfcEnforcementMode: "disabled",
      policyEvents: [],
      policyDecisions: [],
      toolOutputs: [],
    },
    model: "sessionless-model",
    modelTurns: 1,
    toolActivity: [],
  });

  assertEquals("fabricSessionCfc" in report, false);
});

Deno.test("run reports do not invent API-key auth for legacy run state", () => {
  const report = createHarnessRunReport({
    runState: {
      runId: "legacy-state",
      status: "completed",
      updatedAt: "2026-01-01T00:00:00.000Z",
      cfcEnforcementMode: "disabled",
      policyEvents: [],
      policyDecisions: [],
      toolOutputs: [],
    },
    model: "legacy-model",
    modelTurns: 1,
    toolActivity: [],
  });

  assertEquals(report.modelProvider, undefined);
  assertEquals(report.modelAuthSource, undefined);
});

Deno.test("run reports preserve the non-secret local Loom host binding", () => {
  const report = createHarnessRunReport({
    runState: {
      runId: "loom-local",
      status: "completed",
      updatedAt: "2026-08-13T00:00:00.000Z",
      cfcEnforcementMode: "disabled",
      modelProvider: "openai-codex",
      modelAuthSource: "cf-harness-local-store",
      credentialOwner: {
        type: "cf-harness.credential-owner-ref",
        version: 1,
        ownerKey: "local",
      },
      harnessHomeIdentity: "sha256:opaque-home",
      policyEvents: [],
      policyDecisions: [],
      toolOutputs: [],
    },
    model: "gpt-5.6-terra",
    modelTurns: 1,
    toolActivity: [],
  });

  assertEquals(report.modelProvider, "openai-codex");
  assertEquals(report.modelAuthSource, "cf-harness-local-store");
  assertEquals(report.credentialOwner?.ownerKey, "local");
  assertEquals(report.harnessHomeIdentity, "sha256:opaque-home");
});

Deno.test("run reports preserve aggregate and per-turn model usage", () => {
  const usage = {
    inputTokens: 300,
    cachedInputTokens: 100,
    cacheWriteTokens: 80,
    outputTokens: 50,
    totalTokens: 350,
    estimatedCostUsd: 0.01,
  };
  const modelUsage = [
    {
      modelTurn: 1,
      usage: {
        inputTokens: 100,
        cachedInputTokens: 0,
        cacheWriteTokens: 80,
        outputTokens: 20,
        totalTokens: 120,
      },
    },
    {
      modelTurn: 2,
      usage: {
        inputTokens: 200,
        cachedInputTokens: 100,
        cacheWriteTokens: 0,
        outputTokens: 30,
        totalTokens: 230,
      },
    },
  ];
  const report = createHarnessRunReport({
    runState: {
      runId: "usage-run",
      status: "completed",
      updatedAt: "2026-01-01T00:00:00.000Z",
      cfcEnforcementMode: "disabled",
      policyEvents: [],
      policyDecisions: [],
      toolOutputs: [],
    },
    model: "gpt-5.6-terra",
    reasoningEffort: "low",
    promptCacheMode: "explicit",
    cacheAffinity: "custom",
    modelTurns: 2,
    usage,
    totalUsage: usage,
    modelUsage,
    toolActivity: [],
  });

  assertEquals(report.usage, usage);
  assertEquals(report.totalUsage, usage);
  assertEquals(report.modelUsage, modelUsage);
  assertEquals(report.reasoningEffort, "low");
  assertEquals(report.promptCacheMode, "explicit");
  assertEquals(report.cacheAffinity, "custom");
});

Deno.test("run reports end the timeline with the run's terminal reason and drop undated entries", () => {
  const report = createHarnessRunReport({
    runState: {
      runId: "ended-state",
      status: "failed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:02.000Z",
      endedAt: "2026-01-01T00:00:02.000Z",
      terminalReason: "setup_error",
      cfcEnforcementMode: "disabled",
      policyEvents: [],
      policyDecisions: [],
      toolOutputs: [],
    },
    model: "ended-model",
    modelTurns: 0,
    toolActivity: [],
    timeline: [{ kind: "transcript_message", at: "" }],
  });

  assertEquals(
    report.timeline.map((entry) => [entry.kind, entry.terminalReason]),
    [["run_started", undefined], ["run_finished", "setup_error"]],
  );
});

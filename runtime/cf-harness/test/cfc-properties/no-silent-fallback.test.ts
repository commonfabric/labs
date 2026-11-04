/**
 * P-no-silent-fallback (AH-CFC-15): an enforcing run whose mediation is
 * unavailable stays enforcing.
 *
 * The episode is a `bash` call whose result carries no `CfcSandboxResult` —
 * the boundary said nothing about it. The failure mode this guards against is
 * not the denial; it is the harness quietly behaving as though it were in
 * `observe`, exposing the output with a warning and recording a mode it did
 * not act under. That degradation is invisible in a transcript, which is why
 * the assertions are the two checks that read the mode against the behavior.
 *
 * AUD-2 fails on a decision reason code from another mode's family than the
 * run claims, so a run that fell back to observe-shaped decisions under an
 * enforcing claim is caught there. AUD-7 turns to `warn` on any artifact
 * recording `observe`, so a run that rewrote its own claim to match its
 * behavior is caught there instead. Between them a silent fallback has nowhere
 * to land.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FileSystemHarnessArtifactStore } from "../../src/artifacts.ts";
import { CfHarnessEngine } from "../../src/engine.ts";
import { CfHarnessPromptLoop } from "../../src/prompt-loop.ts";

import {
  auditArtifacts,
  checkThatRan,
  directPromptSlotBinding,
  messagesOf,
  propertyArtifactRoot,
  propertyRunDir,
  scriptedModel,
  ScriptedSandboxRuntime,
} from "./support/episode.ts";

/** What the sandbox printed, which an unmediated enforcing run must withhold. */
const UNMEDIATED_STDOUT = "unmediated-output-line";

interface FallbackEpisode {
  runDir: string;
  /** The mode the run's own state records after the unmediated observation. */
  recordedMode: string;
  /** Whether the model-facing result was the typed denial. */
  denied: boolean;
  modelVisibleText: string;
  reasonCodes: readonly string[];
}

const runUnmediatedEpisode = async (): Promise<FallbackEpisode> => {
  const runId = "no-silent-fallback";
  const artifactRoot = await propertyArtifactRoot(runId);
  const engine = new CfHarnessEngine({
    // A plain result: stdout and an exit code, and no `cfcResult` beside them.
    sandboxRuntime: new ScriptedSandboxRuntime([{
      stdout: `${UNMEDIATED_STDOUT}\n`,
      stderr: "",
      exitCode: 0,
    }]),
    runId,
    model: "gpt-5.4",
    cfcEnforcementMode: "enforce-explicit",
    artifactStore: new FileSystemHarnessArtifactStore({ artifactRoot, runId }),
  });
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine,
    fetchFn: scriptedModel([{
      toolName: "bash",
      arguments: { command: "cat ./notes.txt" },
    }]),
  });

  const result = await loop.runPrompt({
    prompt: "Read the notes.",
    promptSlotBinding: directPromptSlotBinding,
  });
  await engine.persistRunState();

  const toolMessage = result.transcript.find((message) =>
    message.role === "tool" && message.toolName === "bash"
  );
  expect(toolMessage).toBeDefined();
  const content = JSON.parse(toolMessage!.content) as Record<string, unknown>;

  return {
    runDir: propertyRunDir(artifactRoot, runId),
    recordedMode: result.runState.cfcEnforcementMode,
    denied: content.type === "cf-harness.observation-denied",
    modelVisibleText: result.transcript.map((message) => message.content)
      .join("\n"),
    reasonCodes: (result.runState.policyDecisions ?? []).flatMap((record) =>
      record.reasonCodes ?? []
    ),
  };
};

describe("cfc property: no silent fallback", () => {
  describe("P-no-silent-fallback — mediation unavailable under an enforcing mode", () => {
    it("returns the typed denial rather than the output", async () => {
      const episode = await runUnmediatedEpisode();

      expect(episode.denied).toBe(true);
      expect(episode.modelVisibleText).not.toContain(UNMEDIATED_STDOUT);
    });

    it("still records the enforcing mode it was asked for", async () => {
      // The degradation this property exists for: a run that answered as
      // `observe` and then said so would look consistent to a reader who only
      // compared the two.
      const episode = await runUnmediatedEpisode();

      expect(episode.recordedMode).toBe("enforce-explicit");
    });

    it("reaches for no decision reason code from another mode's family", async () => {
      // The other half: a run that kept its claim and made observe-shaped
      // decisions under it.
      const episode = await runUnmediatedEpisode();

      const foreign = episode.reasonCodes.filter((code) =>
        code.startsWith("cfc_observe_") || code === "cfc_disabled"
      );
      expect(foreign).toEqual([]);
    });

    it("is seen as enforcing by AUD-2 and AUD-7", async () => {
      // The checker is the assertion. AUD-2 catches a foreign reason-code
      // family under an enforcing claim; AUD-7 catches an artifact that
      // records `observe` at all, which would drop it off `pass` to `warn`.
      const episode = await runUnmediatedEpisode();

      const audit = await auditArtifacts(episode.runDir);
      expect(audit.verdicts("AUD-2")).toEqual(["pass"]);
      expect(audit.verdicts("AUD-7")).toEqual(["pass"]);
      const weakened = [
        ...checkThatRan(audit, "AUD-2"),
        ...checkThatRan(audit, "AUD-7"),
      ].filter((finding) =>
        finding.verdict === "fail" || finding.verdict === "warn"
      );
      expect(messagesOf(weakened)).toBe("");
    });
  });
});

/**
 * P-influence (AH-CFC-7/8): what the model read accumulates, what it did not
 * does not.
 *
 * One mediated `bash` call carries both directions. Its `stdout` comes back
 * observed under a confidentiality label, so the model read labeled content
 * and the run must carry influence for it. Its `stderr` comes back denied, so
 * the model read nothing and the run must carry no influence for it.
 *
 * AUD-8 is the assertion. Over the 239-run corpus it is `not-applicable` on
 * every run — no run there ever exposed a labeled channel — so a `pass` here
 * is the check's first exercise against evidence rather than against absence.
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
  mediatedBashResult,
  messagesOf,
  propertyArtifactRoot,
  propertyRunDir,
  scriptedModel,
  ScriptedSandboxRuntime,
} from "./support/episode.ts";

const OBSERVED_STDOUT = "influence-observed-line\n";

interface InfluenceEpisode {
  runDir: string;
  /** The channels the run accumulated influence for, as `toolCallId:channel`. */
  influencing: readonly string[];
  modelVisibleText: string;
}

const runInfluenceEpisode = async (): Promise<InfluenceEpisode> => {
  const runId = "influence";
  const artifactRoot = await propertyArtifactRoot(runId);
  const engine = new CfHarnessEngine({
    sandboxRuntime: new ScriptedSandboxRuntime([
      mediatedBashResult(OBSERVED_STDOUT, {
        stdoutLabel: { confidentiality: ["secret"] },
        stderrPolicy: "denied",
      }),
    ]),
    runId,
    model: "gpt-5.4",
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

  const observations = result.runState.cfcModelContext?.observations ?? [];
  return {
    runDir: propertyRunDir(artifactRoot, runId),
    influencing: observations.flatMap((observation) =>
      observation.channels.map((channel) =>
        `${observation.toolCallId}:${channel}`
      )
    ),
    modelVisibleText: result.transcript.map((message) => message.content)
      .join("\n"),
  };
};

describe("cfc property: influence accumulation", () => {
  describe("P-influence — a labeled observation the model read", () => {
    it("accumulates as influence on the run's model context", async () => {
      // AH-CFC-7, the positive direction.
      const episode = await runInfluenceEpisode();

      // The observation has to have reached the model for influence over it
      // to mean anything: a regression that dropped stdout and kept the CFC
      // summary would otherwise satisfy the entry below.
      expect(episode.modelVisibleText).toContain(OBSERVED_STDOUT.trim());
      expect(episode.influencing).toContain("call-1:stdout");
    });

    it("is seen by AUD-8 as evidence rather than as an absent subject", async () => {
      // The corpus leaves AUD-8 `not-applicable` on all 239 runs. A verdict of
      // `pass` here means the check read a labeled channel and an influence
      // entry and found them consistent.
      const episode = await runInfluenceEpisode();

      const audit = await auditArtifacts(episode.runDir);
      const aud8 = audit.findings("AUD-8");
      expect(aud8).toHaveLength(1);
      expect(aud8[0].verdict).toBe("pass");
    });
  });

  describe("P-influence — a refused observation the model did not read", () => {
    it("accumulates no influence for the refused channel", async () => {
      // AH-CFC-7's second sentence: a denied observation must not accumulate
      // as if its content were visible. Without this the property would pass
      // on a run that accumulated everything indiscriminately.
      const episode = await runInfluenceEpisode();

      expect(episode.influencing).not.toContain("call-1:stderr");
    });

    it("leaves AUD-8 with no disagreement to report", async () => {
      const episode = await runInfluenceEpisode();

      const audit = await auditArtifacts(episode.runDir);
      // `pass` rather than the absence of `fail`: `inconclusive` means the
      // check could not read its evidence, which is not agreement.
      expect(audit.verdicts("AUD-8")).toEqual(["pass"]);
      const disagreeing = checkThatRan(audit, "AUD-8").filter((finding) =>
        finding.verdict === "fail"
      );
      expect(messagesOf(disagreeing)).toBe("");
    });
  });
});

/**
 * P-deny-egress and P-allow: a label decides an outcome, in both directions.
 *
 * One pattern, one seeded document, two episodes. The refused episode passes
 * the pattern a reference derived from a `Confidential` field, so its answer
 * carries the label and the answer sink's ceiling refuses to release it. The
 * permitted episode drops exactly that input and nothing else, so the same
 * pattern's answer releases.
 *
 * Running both is the point. A suite that only proves refusals cannot tell a
 * working gate from one that refuses everything, and AUD-16 counting a refusal
 * means nothing unless a run that should not be refused is not.
 *
 * The assertions are the audit's verdicts over the artifacts these episodes
 * write, not hand-read JSON. What the refusal itself contains is pinned in
 * `test/run-pattern.test.ts`, which owns the tool's contract; what is pinned
 * here is that the refusal reaches an artifact and that a check can see it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FileSystemHarnessArtifactStore } from "../../src/artifacts.ts";
import { KNOWN_DEFECT_CHECKS } from "../../audit/checks/known-defects.ts";
import { CfHarnessEngine } from "../../src/engine.ts";
import { CfHarnessPromptLoop } from "../../src/prompt-loop.ts";
import type { RunPatternToolSuccessOutput } from "../../src/tools/run-pattern.ts";

import {
  auditArtifacts,
  checkThatRan,
  createLabeledFabric,
  directPromptSlotBinding,
  InertSandboxRuntime,
  messagesOf,
  OPTIONAL_SECRET_PATTERN_SOURCE,
  propertyArtifactRoot,
  propertyRunDir,
  scriptedModel,
  seedLabeledSecret,
  TOTAL_RESULT_SCHEMA,
} from "./support/episode.ts";

/** The seeded secret, which no model-visible text may carry. */
const SECRET = "s3cr3t";

interface EpisodeOutcome {
  runDir: string;
  runId: string;
  /** Every model-facing message of the run, joined, for a disclosure check. */
  modelVisibleText: string;
  output: RunPatternToolSuccessOutput;
}

/**
 * Runs one `run_pattern` episode end to end and answers what it wrote.
 *
 * `withSource` is the only difference between the two properties: it decides
 * whether the labeled reference reaches the pattern's inputs.
 */
const runEpisode = async (
  options: { withSource: boolean },
): Promise<EpisodeOutcome> => {
  // The root first: nothing that can throw may sit between the fabric being
  // created and the `try` that disposes it, or a failure leaks a runtime and
  // a storage manager into the test process.
  const runId = `deny-egress-${options.withSource ? "refused" : "allowed"}`;
  const artifactRoot = await propertyArtifactRoot(runId);
  const fabric = await createLabeledFabric("enforce-explicit");
  try {
    const sourceRef = await seedLabeledSecret(
      fabric.runtime,
      fabric.space,
      runId,
    );
    const engine = new CfHarnessEngine({
      sandboxRuntime: new InertSandboxRuntime(),
      runId,
      model: "gpt-5.4",
      // The factory supplies the emulated session; the config beside it names
      // the space, which is what the run-end cell-labels read needs to know
      // which space to ask about. Without it the run retains no record of
      // having asked, and AUD-9 reads that as evidence not kept.
      fabricSession: {
        apiUrl: "http://toolshed.test",
        identityKeyPath: "/keys/unused.pkcs8",
        space: String(fabric.space),
      },
      fabricSessionFactory: () => Promise.resolve({ pieces: fabric.pieces }),
      artifactStore: new FileSystemHarnessArtifactStore({
        artifactRoot,
        runId,
      }),
    });
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine,
      allowedToolIds: ["run_pattern", "finish_task"],
      fetchFn: scriptedModel([{
        toolName: "run_pattern",
        arguments: {
          sourceText: OPTIONAL_SECRET_PATTERN_SOURCE,
          inputs: options.withSource
            ? { amount: 2, source: sourceRef }
            : { amount: 2 },
          resultSchema: TOTAL_RESULT_SCHEMA,
        },
      }, {
        toolName: "finish_task",
        arguments: {
          outcome: "gave-up",
          message:
            "This probe cannot deliver an openable answer with the available tools.",
        },
      }]),
    });

    const result = await loop.runPrompt({
      prompt: "Total the amount.",
      promptSlotBinding: directPromptSlotBinding,
    });
    await engine.persistRunState();
    expect(result.taskOutcome?.outcome).toBe("gave-up");

    const toolMessage = result.transcript.find((message) =>
      message.role === "tool" && message.toolName === "run_pattern"
    );
    expect(toolMessage).toBeDefined();
    return {
      runDir: propertyRunDir(artifactRoot, runId),
      runId,
      modelVisibleText: result.transcript.map((message) => message.content)
        .join("\n"),
      output: JSON.parse(toolMessage!.content) as RunPatternToolSuccessOutput,
    };
  } finally {
    await fabric.dispose();
  }
};

describe("cfc property: egress of a labeled flow", () => {
  describe("P-deny-egress — a ceilinged sink refuses a labeled answer", () => {
    it("records a release refusal in both channels, and AUD-16 counts the trace", async () => {
      const episode = await runEpisode({ withSource: true });

      // The refusal happened, and it is a refusal a label decided rather than
      // one authority decided: the run succeeded and withheld its values.
      expect(episode.output.status).toBe("ok");
      expect(episode.output.value).toBeUndefined();
      expect(episode.output.policyRefusal?.gates).toEqual(["sink-ceiling"]);

      // The checker is the assertion library, and the channel it reads is the
      // release decision in `policy-trace.json`, not the `policyRefusal` on
      // the output above. The two are the same refusal written down twice:
      // the output carries it to the model as data, the trace records that
      // policy said no. A refusal the model can see but the trace does not
      // record fails here.
      const audit = await auditArtifacts(episode.runDir, {
        expectRefusals: true,
      });
      const aud16 = checkThatRan(audit, "AUD-16");
      expect(aud16).toHaveLength(1);
      expect(
        aud16[0].evidence.some((
          item: { artifact?: string; pointer?: string },
        ) =>
          item.artifact === "policy-trace.json" &&
          (item.pointer ?? "").includes("release")
        ),
      ).toBe(true);
      expect(aud16[0].verdict).not.toBe("fail");
      expect(aud16[0].message).toContain("1 release refusal");
      expect(aud16[0].message).toContain("sink-ceiling");
    });

    it("keeps the labeled payload out of every model-visible message", async () => {
      // AH-CFC-11: the refusal reaches the model through the typed channel,
      // carrying what was refused and not what it withheld.
      const episode = await runEpisode({ withSource: true });

      expect(episode.modelVisibleText).not.toContain(SECRET);
      expect(episode.output.valueError).toContain("policy refused to release");
    });
  });

  describe("P-allow — the same flow without the labeled input", () => {
    it("releases the answer", async () => {
      // The guard against a gate that refuses everything: one input dropped,
      // nothing else changed, and the value comes back.
      const episode = await runEpisode({ withSource: false });

      expect(episode.output.status).toBe("ok");
      expect(episode.output.policyRefusal).toBeUndefined();
      expect(episode.output.value).toEqual({ total: 2 });
    });

    it("leaves no check about what this run did failing", async () => {
      // The guard against the audit becoming an always-fails alarm. A check
      // that starts over-firing fails here rather than in a nightly report
      // nobody reads.
      //
      // The Group E checks are excluded, and only they: each is a defect we
      // already know about, written to fail until it is fixed, so its finding
      // here is the register working rather than a check over-firing. The
      // exact set they report is the assertion below.
      const episode = await runEpisode({ withSource: false });

      const audit = await auditArtifacts(episode.runDir);
      // Without this the assertion below would hold on an audit that read
      // nothing at all.
      expect(audit.results.length).toBeGreaterThan(0);
      const knownDefects = new Set(
        KNOWN_DEFECT_CHECKS.map((check) => check.id),
      );
      const failing = audit.results.filter((result) =>
        result.verdict === "fail" && !knownDefects.has(result.checkId)
      );
      expect(messagesOf(failing)).toBe("");
    });

    it("weakens only the checks a one-run permitted corpus cannot satisfy", async () => {
      // Not a ceiling but the exact set, so a check that starts warning shows
      // up here. None of these four is a defect; each is what a single
      // permitted run honestly cannot establish:
      //
      // AUD-2  — this run's one side effect is `run_pattern`, which reaches
      //          the fabric, so nothing exercised the enforcing claim.
      // AUD-9  — the same fact read for retention: a run that recorded no
      //          invocation context could have run host-side or could have
      //          lost the evidence, and a tool activity states neither, so
      //          the answer is unconfirmed rather than missing.
      // AUD-13 — the fabric-session posture predates the full posture record.
      // AUD-16 — a corpus holding one permitted run has no refusal in it.
      //          P-deny-egress is where that check is exercised.
      // AUD-18 — one run records no posture, so there is nothing to compare.
      //
      // AUD-22 IS a defect, and is here because it is a known one: the
      // episode's binding mints direct-command authority with no digest of
      // the value and a subject that names no principal, which is H2. It
      // leaves this set when the mint sites are fixed.
      //
      // AUD-21 is absent from the set on purpose, and its absence is the
      // check discriminating rather than the check being asleep: this run's
      // one side effect is `run_pattern`, the one tool that does bottom out
      // in a sink check, so its admitting decision carries a release record.
      // It fails on a run of sandbox tools, which is H9.
      const episode = await runEpisode({ withSource: false });

      const audit = await auditArtifacts(episode.runDir);
      const unsettled = audit.results
        .filter((result) =>
          result.verdict !== "pass" && result.verdict !== "not-applicable"
        )
        .map((result) => `${result.checkId} ${result.verdict}`)
        .sort();
      expect(unsettled).toEqual([
        "AUD-13 inconclusive",
        "AUD-16 warn",
        "AUD-18 inconclusive",
        "AUD-2 warn",
        "AUD-22 fail",
        "AUD-9 warn",
      ]);
    });
  });
});

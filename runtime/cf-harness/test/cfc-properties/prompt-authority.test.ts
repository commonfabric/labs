/**
 * P-prompt-authority (AH-CFC-3/4/5): only a direct command authorizes a side
 * effect.
 *
 * A prompt slot carries a role, and the role is where authority lives. Text
 * the operator typed binds as `direct-command`; text that arrived by some
 * other route — a document a tool retrieved, the body of a skill, something
 * the model quoted back — binds as `context` or `quote`. Content cannot
 * promote itself by asking, so a side-effect request under any of those, or
 * under no binding at all, is refused.
 *
 * The refusal codes are the assertion. Five of the six `*_requires_direct_command`
 * codes appeared in no test before this file, so the negative direction was
 * carried by reading the switch rather than by running it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FileSystemHarnessArtifactStore } from "../../src/artifacts.ts";
import {
  CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  type PromptSlotBinding,
  type PromptSlotRole,
} from "../../src/contracts/prompt-slot.ts";
import { CfHarnessEngine } from "../../src/engine.ts";
import { CfHarnessPromptLoop } from "../../src/prompt-loop.ts";

import {
  auditArtifacts,
  checkThatRan,
  InertSandboxRuntime,
  messagesOf,
  propertyArtifactRoot,
  propertyRunDir,
  scriptedModel,
} from "./support/episode.ts";

/**
 * A slot binding in the role named, standing for where its text came from.
 *
 * `subject` names the route rather than the content, because the route is
 * what the role is a claim about.
 */
const bindingFor = (
  role: PromptSlotRole,
  subject: string,
): PromptSlotBinding => ({
  type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  source: { type: "test.prompt-slot", subject },
  role,
  kernelName: "cf-harness",
  surface: "test",
  subject,
  eventId: `event-${subject}`,
});

interface AuthorityEpisode {
  runDir: string;
  allowed: boolean;
  reasonCodes: readonly string[];
}

/**
 * Asks for one side effect under `binding` and answers how policy decided.
 *
 * `bash` is the side effect: it needs no fabric, so the episode isolates the
 * authority question from everything else a tool can refuse over.
 */
const runAuthorityEpisode = async (
  label: string,
  binding?: PromptSlotBinding,
): Promise<AuthorityEpisode> => {
  const runId = `authority-${label}`;
  const artifactRoot = await propertyArtifactRoot(runId);
  const engine = new CfHarnessEngine({
    sandboxRuntime: new InertSandboxRuntime(),
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
      arguments: { command: "touch ./side-effect.txt" },
    }]),
  });

  const result = await loop.runPrompt({
    prompt: "Make the change.",
    ...(binding === undefined ? {} : { promptSlotBinding: binding }),
  });
  await engine.persistRunState();

  const decision = (result.runState.policyDecisions ?? []).find((record) =>
    record.toolId === "bash"
  );
  expect(decision).toBeDefined();
  return {
    runDir: propertyRunDir(artifactRoot, runId),
    allowed: decision!.decision === "allowed",
    reasonCodes: decision!.reasonCodes ?? [],
  };
};

/** The routes by which text reaches a model without carrying authority. */
const UNAUTHORITATIVE: readonly { label: string; role: PromptSlotRole }[] = [
  { label: "retrieved-document", role: "context" },
  { label: "skill-body", role: "context" },
  { label: "quoted-text", role: "quote" },
];

describe("cfc property: prompt authority", () => {
  describe("P-prompt-authority — a side effect under a direct command", () => {
    it("is allowed, and says the direct command is why", async () => {
      // The positive direction, without which every assertion below would
      // hold on a harness that refused unconditionally.
      const episode = await runAuthorityEpisode(
        "direct",
        bindingFor("direct-command", "operator-typed"),
      );

      expect(episode.allowed).toBe(true);
      expect(episode.reasonCodes).toContain(
        "cfc_enforce_explicit_direct_command",
      );
    });
  });

  describe("P-prompt-authority — a side effect the content asked for", () => {
    for (const { label, role } of UNAUTHORITATIVE) {
      it(`is refused when it arrives as ${label}`, async () => {
        const episode = await runAuthorityEpisode(
          label,
          bindingFor(role, label),
        );

        expect(episode.allowed).toBe(false);
        expect(episode.reasonCodes).toContain(
          "cfc_enforce_explicit_requires_direct_command",
        );
      });
    }

    it("is refused when no prompt slot is bound at all", async () => {
      // Absence is not authority either. A run that bound nothing must not
      // read as a run whose operator asked for this.
      const episode = await runAuthorityEpisode("unbound");

      expect(episode.allowed).toBe(false);
      expect(episode.reasonCodes).toContain(
        "cfc_enforce_explicit_requires_direct_command",
      );
    });

    it("leaves the denial channel intact for AUD-4 to read", async () => {
      // AH-CFC-11: a refusal is recorded as a policy event and reaches the
      // model only through the typed channel. AUD-4 is what reads that.
      const episode = await runAuthorityEpisode(
        "quoted-text-audited",
        bindingFor("quote", "quoted-text"),
      );

      const audit = await auditArtifacts(episode.runDir);
      const failing = checkThatRan(audit, "AUD-4").filter((finding) =>
        finding.verdict === "fail"
      );
      expect(messagesOf(failing)).toBe("");
    });
  });
});

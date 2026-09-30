/**
 * Where `run_pattern`'s release-boundary decisions land: `policy-trace.json`,
 * beside the tool-policy decisions the prompt loop records before a call runs.
 *
 * The loop records its allow-side decision before the tool runs, so a
 * boundary that refuses inside the call cannot appear there. What is under
 * test is that the second decision is appended after it, in the order the two
 * were decided in, carrying the refusal's attribution and the reference to
 * the tool output it decided about.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { normalize } from "@std/path/posix";
import { describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";
import {
  harnessReleaseDecisionOf,
  harnessReleaseDecisionOutcome,
} from "../src/contracts/policy-refusal.ts";
import type { HarnessPolicyTrace } from "../src/contracts/policy-trace.ts";
import { createCliPromptSlotBinding } from "../src/contracts/prompt-slot.ts";
import type { HarnessTranscriptOmissions } from "../src/contracts/transcript-omissions.ts";
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
import { responsesBodyFromChatFixture } from "./support/responses-fixture.ts";

const signer = await Identity.fromPassphrase("cf-harness release decisions");

/** A pattern whose answer widens with the labelled input it is handed. */
const SECRET_LENGTH_PATTERN_SOURCE = [
  "import { computed, pattern, Reactive } from 'commonfabric';",
  "interface Source { secret: string; }",
  "interface Input { amount: number; source: Reactive<Source>; }",
  "interface Output { total: number; }",
  "export default pattern<Input, Output>(({ amount, source }) => ({",
  "  total: computed(() => amount + (source.secret ?? '').length),",
  "}));",
  "",
].join("\n");

const TOTAL_RESULT_SCHEMA = {
  type: "object",
  properties: { total: { type: "number" } },
  required: ["total"],
} as const;

class FakeSandboxRuntime implements SandboxRuntime {
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
    return Promise.resolve(
      request.command.includes(CAPABILITY_PROBE_SENTINEL)
        ? {
          stdout:
            "bash\tpresent\t/bin/bash\tGNU bash, version 5.2.26(1)-release",
          stderr: "",
          exitCode: 0,
        }
        : { stdout: "", stderr: "", exitCode: 0 },
    );
  }
}

/** A fabric session that withholds what its ceiling refuses. */
async function createStrictFabric() {
  const storage = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("http://toolshed.test"),
    storageManager: storage,
    // The rung and the label persistence the withheld release rests on. The
    // seeded confidentiality reaches the pattern's read through the persisted
    // labels, and the release boundary then refuses it, which is the
    // `withheld` decision the test reads out of the policy trace.
    cfcEnforcementMode: "enforce-strict",
    cfcFlowLabels: "persist",
  });
  const pieces = new PiecesController(
    await createSession({
      identity: signer,
      spaceName: `release-decisions-${crypto.randomUUID()}`,
    }),
    runtime,
  );
  await pieces.synced();
  return {
    runtime,
    pieces,
    space: pieces.getSpace(),
    dispose: async () => {
      await runtime.dispose();
      await storage.close();
    },
  };
}

/**
 * Seeds a document whose `secret` field carries confidentiality, and answers
 * the link an agent would pass as the input naming it.
 */
async function seedLabelledSecret(
  runtime: Runtime,
  space: ReturnType<PiecesController["getSpace"]>,
): Promise<string> {
  const seed = runtime.edit();
  const sourceCell = runtime.getCell(
    space,
    "release-decision-source",
    { type: "object", properties: { secret: { type: "string" } } },
    seed,
  );
  writeSeedEnvelopeDoc(seed, space);
  seedStoredEnvelope(seed, {
    space,
    scope: "space",
    id: sourceCell.getAsNormalizedFullLink().id,
    path: [],
  }, {
    value: { secret: "s3cr3t" },
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [{ path: ["secret"], label: { confidentiality: ["secret"] } }],
      },
    },
  });
  expect((await seed.commit()).ok).toBeDefined();
  return createLLMFriendlyLink(sourceCell.getAsNormalizedFullLink(), space);
}

describe("run_pattern release decisions in the policy trace", () => {
  it("appends the withheld-values decision after the allow-side decision of the same call", async () => {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-release-decisions-",
    });
    const { runtime, pieces, space, dispose } = await createStrictFabric();
    try {
      const sourceRef = await seedLabelledSecret(runtime, space);
      let turns = 0;
      const fetchFn: typeof fetch = (_input, init) => {
        turns += 1;
        const payload = turns === 1
          ? {
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{
                  id: "call-run-pattern",
                  type: "function",
                  function: {
                    name: "run_pattern",
                    arguments: JSON.stringify({
                      sourceText: SECRET_LENGTH_PATTERN_SOURCE,
                      inputs: { amount: 2, source: sourceRef },
                      resultSchema: TOTAL_RESULT_SCHEMA,
                    }),
                  },
                }],
              },
            }],
          }
          : {
            choices: [{
              index: 0,
              message: { role: "assistant", content: "Done." },
            }],
          };
        return Promise.resolve(
          new Response(
            JSON.stringify(responsesBodyFromChatFixture(payload, init?.body)),
            { status: 200 },
          ),
        );
      };
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          artifactRoot,
          sandboxRuntime: new FakeSandboxRuntime(),
          runId: "run-release-decision",
          model: "gpt-5.4",
          fabricSessionFactory: () => Promise.resolve({ pieces }),
        }),
        fetchFn,
      });

      await loop.runPrompt({
        prompt: "Run the pattern over the source.",
        promptSlotBinding: createCliPromptSlotBinding({
          kernelName: "cf-harness",
          subject: "release-decisions",
        }),
      });

      const trace = JSON.parse(
        await Deno.readTextFile(
          join(artifactRoot, "run-release-decision", "policy-trace.json"),
        ),
      ) as HarnessPolicyTrace;
      const forCall = trace.decisions.filter((decision) =>
        decision.toolCallId === "call-run-pattern"
      );
      expect(forCall.length).toBe(2);
      const [allowSide, release] = forCall;
      // The order in the trace is the order the two were decided in: whether
      // the call may run, then what the boundary inside it did.
      expect(allowSide.decision).toBe("allowed");
      expect(allowSide.release).toBeUndefined();
      expect(release.sequence).toBeGreaterThan(allowSide.sequence);
      // The outcome and the reason code state one fact and are read together:
      // an operator counting withheld releases off the outcome and an audit
      // keying on the reason code must not be able to disagree.
      expect(release.decision).toBe("withheld");
      expect(release.reasonCodes).toEqual(["cfc_release_withheld"]);
      expect(release.release?.reasonCode).toBe("cfc_release_withheld");
      expect(release.release?.boundary).toBe("release");
      expect(release.release?.sink).toBe("run_pattern");
      expect(release.release?.ceiling).toEqual([]);
      expect(release.release?.refusal?.gates).toEqual(["sink-ceiling"]);
      expect(release.release?.refusal?.offendingAtoms).toEqual(['"secret"']);
      // The attribution names the input to drop, which is the whole of what
      // the caller can act on.
      expect(release.release?.refusal?.inputKeys).toEqual(["source"]);
      expect(release.release?.refusal?.attribution).toBe("complete");
      // The decision joins to the artifact it decided about.
      expect(release.resultRef?.toolId).toBe("run_pattern");
      expect(release.resultRef?.artifactPath).toContain("tool-outputs");
      // The call ran and answered with the reference to its result, so nothing
      // here was denied.
      expect(trace.decisionCounts.withheld).toBe(1);
      expect(trace.decisionCounts.denied).toBe(0);
      const releaseRef = release.resultRef;
      if (releaseRef?.artifactPath === undefined) {
        throw new Error("expected release decision artifact reference");
      }
      const omissions = JSON.parse(
        await Deno.readTextFile(
          join(
            artifactRoot,
            "run-release-decision",
            "transcript-omissions.json",
          ),
        ),
      ) as HarnessTranscriptOmissions;
      const resultOmissions = omissions.results.find((result) =>
        result.outputId === releaseRef.outputId
      );
      expect(
        resultOmissions?.rules.find((rule) => rule.rule === "artifact-only")
          ?.locations,
      ).toContainEqual({
        artifactPath: releaseRef.artifactPath,
        jsonPointer: "/releaseDecision",
      });
    } finally {
      await dispose();
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("reads no decision off an output whose reason code or boundary is not one the trace carries", () => {
    // A tool output is read back through JSON, so the two discriminants are
    // checked against their closed sets rather than asserted into them: a
    // value outside either would reach the trace as a reason code no reader
    // of it can branch on, and the loop records nothing instead.
    const decision = {
      reasonCode: "cfc_release_withheld",
      boundary: "release",
      sink: "run_pattern",
    };
    expect(harnessReleaseDecisionOf({ releaseDecision: decision }))
      .toEqual(decision);
    expect(
      harnessReleaseDecisionOf({
        releaseDecision: { ...decision, reasonCode: "cfc_release_maybe" },
      }),
    ).toBeUndefined();
    expect(
      harnessReleaseDecisionOf({
        releaseDecision: { ...decision, boundary: "egress" },
      }),
    ).toBeUndefined();
    expect(harnessReleaseDecisionOf({ releaseDecision: "withheld" }))
      .toBeUndefined();
    expect(harnessReleaseDecisionOf({})).toBeUndefined();
  });

  it("gives each reason code the decision it states", () => {
    // The trace's counts are read straight off this mapping. An observed
    // measurement counted as a denial would report an enforcement that never
    // happened, and a withheld release counted as one would report a call that
    // never ran — it ran, and answered with the reference to its result.
    // Only a refused commit landed no result, which is what `denied` is.
    expect(harnessReleaseDecisionOutcome("cfc_release_allowed"))
      .toBe("allowed");
    expect(harnessReleaseDecisionOutcome("cfc_release_observed"))
      .toBe("warned");
    expect(harnessReleaseDecisionOutcome("cfc_release_withheld"))
      .toBe("withheld");
    expect(harnessReleaseDecisionOutcome("cfc_commit_refused"))
      .toBe("denied");
  });
});

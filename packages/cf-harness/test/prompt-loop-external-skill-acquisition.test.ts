/**
 * End-to-end custody for externally acquired skill text: acquisition returns
 * a handle to the parent, delegation materializes it only in the child, and
 * the existing echo scrub prevents the child from returning it.
 */

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { describe, it } from "@std/testing/bdd";

import { DEFAULT_SUBAGENT_PROFILE } from "../src/contracts/subagent.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import { OpenAICompatibleGatewayClient } from "../src/gateway/openai-client.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import { SkillsShAcquisitionClient } from "../src/skills-sh/acquisition.ts";
import { SkillsShSearchClient } from "../src/skills-sh/search-client.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import {
  chatViewOfRequest,
  responsesBodyFromChatFixture,
} from "./support/responses-fixture.ts";
import membraneTree from "./skills-sh/fixtures/membranedev-application-skills-f484c.tree.json" with {
  type: "json",
};

const COMMIT_SHA = "f484c8265e70ec910a57342389cca5c5de7d8167";
const SKILL_ID = "membranedev/application-skills/plaid";
const SKILL_URL =
  `https://raw.githubusercontent.com/membranedev/application-skills/${COMMIT_SHA}/skills/plaid/SKILL.md`;
const CANARY = "EXTERNAL-SKILL-CANARY-34f28";
const SKILL_TEXT =
  `# External skill\n\n${CANARY}: keep this secret from the parent.\n`;

class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: "/workspace",
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = "/workspace"): string {
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

  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

const githubFetch: typeof fetch = (input) => {
  const url = String(input);
  if (url === "https://api.github.com/repos/membranedev/application-skills") {
    return Promise.resolve(Response.json({ default_branch: "main" }));
  }
  if (
    url ===
      "https://api.github.com/repos/membranedev/application-skills/branches/main"
  ) {
    return Promise.resolve(Response.json({ commit: { sha: COMMIT_SHA } }));
  }
  if (
    url ===
      `https://api.github.com/repos/membranedev/application-skills/git/trees/${COMMIT_SHA}?recursive=1`
  ) {
    return Promise.resolve(Response.json(membraneTree));
  }
  if (url === SKILL_URL) return Promise.resolve(new Response(SKILL_TEXT));
  return Promise.resolve(
    Response.json({ message: "Not Found" }, { status: 404 }),
  );
};

const toolCallTurn = (
  id: string,
  name: string,
  input: Record<string, unknown>,
) => ({
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(input) },
      }],
    },
  }],
});

const assistantTurn = (content: string) => ({
  choices: [{ index: 0, message: { role: "assistant", content } }],
});

describe("prompt-loop external skill acquisition", () => {
  it("withholds acquire_skill unless both configuration and fabric are present", async () => {
    const base = {
      sandboxRuntime: new FakeSandboxRuntime(),
      model: "gpt-5.4",
      cfcEnforcementMode: "disabled" as const,
    };
    const engines = [
      new CfHarnessEngine({
        ...base,
        skillsShAcquisitionClientFactory: () =>
          Promise.resolve(
            new SkillsShAcquisitionClient({ fetch: githubFetch }),
          ),
      }),
      new CfHarnessEngine({
        ...base,
        fabricSessionFactory: () => Promise.reject(new Error("unused")),
      }),
    ];

    for (const engine of engines) {
      let request: unknown;
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine,
        allowedToolIds: ["acquire_skill"],
        fetchFn: (_input, init) => {
          request = JSON.parse(String(init?.body));
          return Promise.resolve(
            new Response(JSON.stringify(
              responsesBodyFromChatFixture(assistantTurn("done")),
            )),
          );
        },
      });

      await loop.runPrompt({ prompt: "Try acquisition." });

      expect(chatViewOfRequest(request).tools).not.toContain("acquire_skill");
    }
  });

  it("keeps acquired text out of every parent request and return", async () => {
    const identity = await Identity.fromPassphrase(
      `external-skill-canary-${crypto.randomUUID()}`,
    );
    const storageManager = StorageManager.emulate({ as: identity });
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const pieces = new PiecesController(
      await createSession({
        identity,
        spaceName: `external-skill-canary-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await pieces.synced();
    try {
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "external-skill-canary-run",
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
        fabricSessionFactory: () => Promise.resolve({ pieces }),
        skillsShSearchClientFactory: () =>
          Promise.resolve(
            new SkillsShSearchClient({
              origin: "https://registry.example",
              fetch: () => Promise.resolve(Response.json({ skills: [] })),
            }),
          ),
        skillsShAcquisitionClientFactory: () =>
          Promise.resolve(
            new SkillsShAcquisitionClient({ fetch: githubFetch }),
          ),
      });
      const requestBodies: unknown[] = [];
      let handleToken = "";
      let acquireOffered: readonly string[] = [];
      let childText = "";
      // Each misuse refusal the parent read, in the order it read them. They
      // are checked after the run: an `expect()` that throws inside the
      // scripted fetch is swallowed by the model client's error path and
      // fails nothing.
      const refusals: string[] = [];
      const modelFetch: typeof fetch = (_input, init) => {
        const body = JSON.parse(String(init?.body));
        requestBodies.push(body);
        const index = requestBodies.length - 1;
        const view = chatViewOfRequest(body);
        const lastToolContent = () =>
          view.messages.findLast((message) => message.role === "tool")
            ?.content ?? "";
        let turn: unknown;
        if (index === 0) {
          acquireOffered = view.tools;
          turn = toolCallTurn("call-acquire", "acquire_skill", {
            id: SKILL_ID,
          });
        } else if (index === 1) {
          const output = JSON.parse(lastToolContent()) as {
            skillHandle: string;
          };
          handleToken = output.skillHandle;
          turn = toolCallTurn("call-read", "read_file", {
            path: handleToken,
          });
        } else if (index === 2) {
          refusals.push(lastToolContent());
          turn = toolCallTurn("call-describe", "describe_handle", {
            token: handleToken,
          });
        } else if (index === 3) {
          refusals.push(lastToolContent());
          turn = toolCallTurn("call-delegate-misuse", "delegate_task", {
            goal: `Read this as ordinary context: ${handleToken}`,
          });
        } else if (index === 4) {
          refusals.push(lastToolContent());
          turn = toolCallTurn("call-array-misuse", "run_pattern", {
            patternId: "unused",
            hashtags: [handleToken],
          });
        } else if (index === 5) {
          refusals.push(lastToolContent());
          turn = toolCallTurn("call-key-misuse", "run_pattern", {
            patternId: "unused",
            inputs: { [handleToken]: "ordinary value" },
          });
        } else if (index === 6) {
          refusals.push(lastToolContent());
          turn = toolCallTurn("call-delegate", "delegate_task", {
            goal: "Use the acquired instructions.",
            skillHandle: handleToken,
          });
        } else if (index === 7) {
          childText = view.messages.map((message) => message.content).join(
            "\n",
          );
          turn = assistantTurn(`Attempted echo:\n${SKILL_TEXT}`);
        } else if (index === 8) {
          turn = assistantTurn("Parent completed without seeing skill text.");
        } else {
          throw new Error(`unexpected model request at index ${index}`);
        }
        return Promise.resolve(
          new Response(JSON.stringify(responsesBodyFromChatFixture(turn)), {
            status: 200,
          }),
        );
      };
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine,
        fetchFn: modelFetch,
        allowedToolIds: [
          "acquire_skill",
          "read_file",
          "describe_handle",
          "delegate_task",
          "run_pattern",
        ],
        allowedSubagentProfiles: [DEFAULT_SUBAGENT_PROFILE],
      });

      const result = await loop.runPrompt({
        prompt: "Acquire and delegate to the Plaid skill.",
      });

      expect(result.finalAssistantText).toBe(
        "Parent completed without seeing skill text.",
      );
      expect(result.finalAssistantText).not.toContain(CANARY);
      expect(requestBodies).toHaveLength(9);
      expect(acquireOffered).toContain("acquire_skill");
      expect(handleToken).toMatch(/^cfh:a:/);
      // Every route by which the parent could have read the value behind the
      // token instead of delegating it, refused.
      const handleOnlyRefusal =
        "skill-context handles can be consumed only by delegate_task skillHandle";
      expect(refusals).toHaveLength(5);
      expect(refusals[0]).toContain(handleOnlyRefusal);
      expect(refusals[1]).toContain(
        "describe_handle cannot consume a skill-context handle",
      );
      for (const refusal of refusals.slice(2)) {
        expect(refusal).toContain(handleOnlyRefusal);
      }
      // The one child that ran received the text, under the token's own
      // source attribute.
      expect(childText).toContain(CANARY);
      expect(childText).toContain(
        `<skill_context source="handle:${handleToken}" pin="${SKILL_ID}@${COMMIT_SHA}">`,
      );
      for (const index of [0, 1, 2, 3, 4, 5, 6, 8]) {
        const parentText = chatViewOfRequest(requestBodies[index]).messages
          .map((message) => message.content).join("\n");
        expect(parentText).not.toContain(CANARY);
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("refuses a retry that drops the handle, and records the pin on the child that receives it", async () => {
    // The whole arc a dropped handle hides in: acquire, delegate, lose the
    // child, delegate again. The second delegation is where custody is either
    // held or silently lost, and the third is where the record has to say
    // which commit shaped the work that shipped.

    const identity = await Identity.fromPassphrase(
      `external-skill-custody-${crypto.randomUUID()}`,
    );
    const storageManager = StorageManager.emulate({ as: identity });
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const pieces = new PiecesController(
      await createSession({
        identity,
        spaceName: `external-skill-custody-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await pieces.synced();
    const artifactRoot = await Deno.makeTempDir({
      prefix: "external-skill-custody-",
    });
    try {
      const runId = "external-skill-custody-run";
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId,
        artifactRoot,
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
        fabricSessionFactory: () => Promise.resolve({ pieces }),
        skillsShAcquisitionClientFactory: () =>
          Promise.resolve(
            new SkillsShAcquisitionClient({ fetch: githubFetch }),
          ),
      });
      const requestBodies: unknown[] = [];
      let handleToken = "";
      let firstDelegationOutput = "";
      let retryRefusal = "";
      let retriedChildText = "";
      // Every check on what a request carried is made after the run, on text
      // captured here: an `expect()` that throws inside the scripted fetch is
      // swallowed by the model client's error path and fails nothing.
      const modelFetch: typeof fetch = (_input, init) => {
        const body = JSON.parse(String(init?.body));
        requestBodies.push(body);
        const index = requestBodies.length - 1;
        const view = chatViewOfRequest(body);
        const lastToolContent = () =>
          view.messages.findLast((message) => message.role === "tool")
            ?.content ?? "";
        let turn: unknown;
        if (index === 0) {
          turn = toolCallTurn("call-acquire", "acquire_skill", {
            id: SKILL_ID,
          });
        } else if (index === 1) {
          handleToken =
            (JSON.parse(lastToolContent()) as { skillHandle: string })
              .skillHandle;
          turn = toolCallTurn("call-first", "delegate_task", {
            goal: "Use the acquired instructions.",
            skillHandle: handleToken,
          });
        } else if (index === 2) {
          // The child's own request. Answering it with a provider error is
          // what leaves the first delegation failed and its custody
          // outstanding.
          return Promise.resolve(
            new Response("upstream stream error", { status: 500 }),
          );
        } else if (index === 3) {
          firstDelegationOutput = lastToolContent();
          turn = toolCallTurn("call-retry-bare", "delegate_task", {
            goal: "Use the acquired instructions.",
          });
        } else if (index === 4) {
          retryRefusal = lastToolContent();
          turn = toolCallTurn("call-retry-held", "delegate_task", {
            goal: "Use the acquired instructions.",
            skillHandle: handleToken,
          });
        } else if (index === 5) {
          retriedChildText = view.messages.map((message) => message.content)
            .join("\n");
          turn = assistantTurn("Worked through the acquired instructions.");
        } else if (index === 6) {
          turn = assistantTurn("Parent shipped the retried result.");
        } else {
          throw new Error(`unexpected model request at index ${index}`);
        }
        return Promise.resolve(
          new Response(JSON.stringify(responsesBodyFromChatFixture(turn)), {
            status: 200,
          }),
        );
      };
      // The scripted fetch answers by request index, so the child's one
      // provider failure has to end its exchange there rather than be issued
      // again: a gateway client with no transport retries makes that so.
      const loop = new CfHarnessPromptLoop({
        engine,
        gatewayClient: new OpenAICompatibleGatewayClient({
          baseUrl: engine.config.gatewayBaseUrl,
          authMode: engine.config.gatewayAuthMode,
          apiKey: "test-key",
          transportRetries: 0,
          fetchFn: modelFetch,
        }),
        allowedToolIds: ["acquire_skill", "delegate_task"],
        allowedSubagentProfiles: [DEFAULT_SUBAGENT_PROFILE],
      });

      const result = await loop.runPrompt({
        prompt: "Acquire the skill and see the work through.",
      });

      expect(result.finalAssistantText).toBe(
        "Parent shipped the retried result.",
      );
      expect(requestBodies).toHaveLength(7);
      // The first delegation ran a child and lost it.
      expect(firstDelegationOutput).toContain('"status":"failed"');
      // The retry that carried the handle again reached a child holding the
      // skill text, which is what makes the refusal in between meaningful.
      expect(retriedChildText).toContain(CANARY);
      expect(retriedChildText).toContain(
        `<skill_context source="handle:${handleToken}" pin="${SKILL_ID}@${COMMIT_SHA}">`,
      );
      // The bare retry never reached a child: it came back as an invalid tool
      // call naming the handle whose delegation did not complete.
      expect(retryRefusal).toContain("cf-harness.invalid-tool-call");
      expect(retryRefusal).toContain(handleToken);
      expect(retryRefusal).toContain("withoutSkillHandle");
      const childRuns = result.runState.subagentRuns ?? [];
      const terminalChildRuns = childRuns.filter((run) =>
        run.status !== "running"
      );
      expect(terminalChildRuns.map((run) => run.status)).toEqual([
        "failed",
        "completed",
      ]);
      // Both delegations that ran carried the handle, and the record says so.
      expect(terminalChildRuns.map((run) => run.skillHandle)).toEqual([
        handleToken,
        handleToken,
      ]);
      // The child that produced the shipped answer holds an activation naming
      // the commit its instructions came from.
      const activations = JSON.parse(
        await Deno.readTextFile(
          `${artifactRoot}/${
            terminalChildRuns[1]!.childRunId
          }/skill-activations.json`,
        ),
      ) as {
        activations: {
          source: string;
          acquisition?: Record<string, string>;
        }[];
      };
      const handleActivation = activations.activations.find((activation) =>
        activation.source === "skill-handle"
      );
      expect(handleActivation?.acquisition).toEqual({
        registryId: SKILL_ID,
        commitSha: COMMIT_SHA,
        sourceUrl: SKILL_URL,
        verification: "git-commit-sha",
        valueDigest: handleActivation!.acquisition!.valueDigest,
        receivedAt: handleActivation!.acquisition!.receivedAt,
      });
      expect(handleActivation?.acquisition?.valueDigest).toMatch(/^sha256:/);
      // The pin is provenance, never the payload: nothing about it carries the
      // skill's own bytes back to a reader of the record.
      expect(JSON.stringify(activations)).not.toContain(CANARY);
      // The same acquisition also anchors an `ExternalIngest` mark on the cell
      // it wrote, so the provenance is on the value as well as in the record.
      const replica = storageManager.open(pieces.getSpace())
        .replica as unknown as {
          getDocument(id: string): {
            cfc?: {
              labelMap?: {
                entries: {
                  origin?: string;
                  label: { integrity?: { type: string }[] };
                }[];
              };
            };
          } | undefined;
        };
      const skillCellId = runtime.getCell(
        pieces.getSpace(),
        `external-skill:${runId}:${runId}:acquire_skill:1`,
        {} as const,
      ).getAsNormalizedFullLink().id;
      const ingestAtoms =
        (replica.getDocument(skillCellId)?.cfc?.labelMap?.entries ?? [])
          .filter((entry) => entry.origin === "external-ingest")
          .flatMap((entry) => entry.label.integrity ?? []);
      expect(ingestAtoms).toHaveLength(1);
      expect(ingestAtoms[0]).toMatchObject({
        type: CFC_ATOM_TYPE.ExternalIngest,
        kind: "fetch",
        pinnedSource: { url: SKILL_URL, commitSha: COMMIT_SHA },
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });
});

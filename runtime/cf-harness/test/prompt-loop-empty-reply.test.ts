import { expect } from "@std/expect";
import { join, normalize } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { createFileSystemHarnessArtifactStore } from "../src/artifacts.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import { OpenAICompatibleGatewayClient } from "../src/gateway/openai-client.ts";
import { OpenAICompatibleGatewayModelClient } from "../src/model/openai-compatible-gateway.ts";
import { OpenAICodexResponsesClient } from "../src/model/openai-codex-responses.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import type { HarnessRunState } from "../src/run-state.ts";
import type { SandboxRuntime } from "../src/sandbox/types.ts";

const sandbox: SandboxRuntime = {
  describe: () => ({
    kind: "runsc-cfc",
    defaultWorkingDirectory: "/workspace",
    cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
  }),
  resolvePath: (path, cwd = "/workspace") =>
    normalize(path.startsWith("/") ? path : `${cwd}/${path}`),
  isPathWithinWorkspace: (path) => path.startsWith("/workspace/"),
  isPathWithinAllowedRoots: (path) => path.startsWith("/workspace/"),
  defaultWorkingDirectory: () => "/workspace",
  run: () => {
    throw new Error("Unexpected sandbox command");
  },
  runShell: (request) => {
    expect(request.command).toContain(CAPABILITY_PROBE_SENTINEL);
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  },
};

/** Returns the empty-reply evidence files written by any invocation. */
const emptyReplyPaths = async (runRoot: string): Promise<string[]> => {
  const paths: string[] = [];
  for await (const entry of Deno.readDir(runRoot)) {
    if (
      entry.name.startsWith("model-turn-") &&
      entry.name.endsWith("-empty-reply.json")
    ) {
      paths.push(join(runRoot, entry.name));
    }
  }
  return paths;
};

describe("prompt-loop-empty-reply", () => {
  it("retains both empty replies when a resumed invocation repeats the turn number", async () => {
    const root = await Deno.makeTempDir({ prefix: "empty-reply-resume-" });
    try {
      let runState: HarnessRunState | undefined;
      let firstPath: string | undefined;
      let firstContents: string | undefined;
      let requests = 0;
      const markers: string[] = [];
      for (const marker of ["first-invocation", "resumed-invocation"]) {
        const artifactStore = createFileSystemHarnessArtifactStore({
          artifactRoot: root,
          runId: "empty-reply-resume",
        });
        const engine = new CfHarnessEngine({
          sandboxRuntime: sandbox,
          artifactStore,
          runId: "empty-reply-resume",
          model: "fixture-chat",
          runState,
        });
        const loop = new CfHarnessPromptLoop({
          engine,
          apiKey: "fictional-key",
          fetchFn: () => {
            requests++;
            return Promise.resolve(
              new Response(JSON.stringify({
                choices: [{
                  message: { role: "assistant", content: "", marker },
                }],
              })),
            );
          },
        });
        await expect(loop.runTranscript({
          transcript: [{ role: "user", content: "Continue." }],
        })).rejects.toMatchObject({
          code: "provider-unavailable",
          message:
            "The model returned an empty assistant response with no tool calls",
        });
        runState = engine.getRunState();
        expect(runState.runId).toBe("empty-reply-resume");
        expect(runState.status).toBe("failed");
        const paths = await emptyReplyPaths(artifactStore.runRoot);
        if (firstPath === undefined) {
          expect(paths).toHaveLength(1);
          firstPath = paths[0];
          firstContents = await Deno.readTextFile(firstPath);
        } else {
          expect(paths).toHaveLength(2);
          expect(await Deno.readTextFile(firstPath)).toBe(firstContents);
          for (const path of paths) {
            const artifact = JSON.parse(await Deno.readTextFile(path));
            expect(artifact.modelTurn).toBe(1);
            expect(artifact.modelAttemptSequence).toBe(1);
            markers.push(
              JSON.parse(artifact.diagnostic.responseBodyExcerpt).choices[0]
                .message.marker,
            );
          }
        }
      }
      expect(requests).toBe(2);
      expect(markers.sort()).toEqual([
        "first-invocation",
        "resumed-invocation",
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("preserves the empty-reply failure when diagnostic storage fails", async () => {
    const root = await Deno.makeTempDir({ prefix: "empty-reply-storage-" });
    try {
      const artifactStore = createFileSystemHarnessArtifactStore({
        artifactRoot: root,
        runId: "empty-reply-storage",
      });
      let writes = 0;
      artifactStore.persistEmptyReply = () => {
        writes++;
        return Promise.reject(new Error("Diagnostic storage unavailable"));
      };
      const engine = new CfHarnessEngine({
        sandboxRuntime: sandbox,
        artifactStore,
        runId: "empty-reply-storage",
        model: "fixture-chat",
      });
      const loop = new CfHarnessPromptLoop({
        engine,
        apiKey: "fictional-key",
        fetchFn: () =>
          Promise.resolve(
            new Response(JSON.stringify({
              choices: [{ message: { role: "assistant", content: "" } }],
            })),
          ),
      });
      await expect(loop.runPrompt({ prompt: "Reply briefly." }))
        .rejects.toMatchObject({
          code: "provider-unavailable",
          message:
            "The model returned an empty assistant response with no tool calls",
        });
      expect(writes).toBe(1);
      expect(engine.getRunState().status).toBe("failed");
      expect(engine.getRunState().primaryFailure?.detail).toBe(
        "The model returned an empty assistant response with no tool calls",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  for (
    const provider of ["chat", "responses", "codex", "codex-streamed"] as const
  ) {
    for (const content of ["", " \n", "Done."]) {
      it(`retains only empty ${provider} replies in artifacts (${JSON.stringify(content)})`, async () => {
        const root = await Deno.makeTempDir({ prefix: "empty-reply-" });
        try {
          const artifactStore = createFileSystemHarnessArtifactStore({
            artifactRoot: root,
            runId: "empty-reply",
          });
          const model = provider === "chat" ? "fixture-chat" : "gpt-5.6";
          const isCodex = provider.startsWith("codex");
          const payload = provider === "chat"
            ? {
              model,
              usage: {
                prompt_tokens: 100,
                completion_tokens: 0,
                total_tokens: 100,
              },
              choices: [{
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content,
                  ignored_detail: "private-marker",
                },
              }],
            }
            : {
              instructions: "fixture instructions ".padEnd(19_000, "x"),
              tools: [{
                type: "function",
                name: "fixture_tool",
                description: "echoed tool",
              }],
              model,
              usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 },
              status: "completed",
              incomplete_details: null,
              error: null,
              output: [{
                type: "reasoning",
                id: "reasoning-fixture",
                summary: [],
                encrypted_content: "fixture-reasoning".repeat(200),
              }, {
                type: "message",
                role: "assistant",
                content: [
                  { type: "output_text", text: content },
                  {
                    type: "refusal",
                    refusal: "",
                    detail: "fixture refusal metadata",
                  },
                  { type: "unknown_part", text: "private-marker" },
                ],
              }],
            };
          const streamedItems = provider === "codex-streamed"
            ? payload.output ?? []
            : [];
          const terminal = provider === "codex-streamed"
            ? { ...payload, output: [] }
            : payload;
          const {
            instructions: _instructions,
            tools: _tools,
            ...retainedPayload
          } = payload;
          const {
            instructions: _terminalInstructions,
            tools: _terminalTools,
            ...retainedTerminal
          } = terminal;
          const events = [
            ...streamedItems.map((item) => ({
              type: "response.output_item.done",
              item,
            })),
            { type: "response.completed", response: terminal },
          ];
          let requests = 0;
          const fetchFn = () => {
            requests++;
            return Promise.resolve(
              new Response(
                isCodex
                  ? events.map((event) => `data: ${JSON.stringify(event)}\n\n`)
                    .join("")
                  : JSON.stringify(payload),
                {
                  headers: {
                    "content-type": isCodex
                      ? "text/event-stream"
                      : "application/json",
                  },
                },
              ),
            );
          };
          const modelClient = isCodex
            ? new OpenAICodexResponsesClient({
              transportRetries: 0,
              fetchFn,
              credentialOwner: {
                type: "cf-harness.credential-owner-ref",
                version: 1,
                ownerKey: "fictional-owner",
                tenantKey: "fictional-tenant",
              },
              credentialResolver: {
                resolve: () =>
                  Promise.resolve({
                    type: "oauth",
                    providerId: "openai-codex",
                    accessToken: "fictional-access",
                    refreshToken: "fictional-refresh",
                    accountId: "fictional-account",
                    expiresAt: Date.now() + 60_000,
                  }),
              },
            })
            : new OpenAICompatibleGatewayModelClient(
              new OpenAICompatibleGatewayClient({
                baseUrl: "https://gateway.test",
                authMode: "none",
                fetchFn,
                transportRetries: 0,
              }),
            );
          const engine = new CfHarnessEngine({
            sandboxRuntime: sandbox,
            runId: "empty-reply",
            model,
            modelProvider: modelClient.providerId,
            credentialOwnerKey: "fictional-owner",
            artifactStore,
          });
          const loop = new CfHarnessPromptLoop({ engine, modelClient });
          const run = loop.runPrompt({ prompt: "Reply briefly." });
          if (content.trim().length === 0) {
            await expect(run).rejects.toMatchObject({
              code: "provider-unavailable",
              message:
                "The model returned an empty assistant response with no tool calls",
            });
            expect(engine.getRunState().status).toBe("failed");
            const paths = await emptyReplyPaths(artifactStore.runRoot);
            expect(paths).toHaveLength(1);
            const artifact = JSON.parse(await Deno.readTextFile(paths[0]));
            expect(artifact.modelTurn).toBe(1);
            expect(artifact.modelAttemptSequence).toBe(1);
            expect(artifact.diagnostic.decision).toEqual({
              decoder: provider === "chat" ? "chat-completions" : "responses",
              reason: "no-non-whitespace-text-or-tool-calls",
              contentCharacters: content.length,
              trimmedContentCharacters: 0,
              toolCallCount: 0,
            });
            const raw = JSON.parse(artifact.diagnostic.responseBodyExcerpt);
            expect(raw).toEqual(
              isCodex
                ? { terminal: retainedTerminal, streamedItems }
                : retainedPayload,
            );
            expect(artifact.diagnostic.responseBodyExcerpt).not.toContain(
              "fixture instructions",
            );
            expect(artifact.diagnostic.responseBodyExcerpt).not.toContain(
              "echoed tool",
            );
            expect(artifact.diagnostic.responseBodyTruncated).toBe(false);
            expect(artifact.diagnostic.responseBodyBytes).toBe(
              new TextEncoder().encode(artifact.diagnostic.responseBodyExcerpt)
                .length,
            );
          } else {
            const result = await run;
            expect(result.finalAssistantText).toBe(content);
            expect(JSON.stringify(result)).not.toContain("private-marker");
            expect(await emptyReplyPaths(artifactStore.runRoot)).toEqual([]);
          }
          expect(requests).toBe(1);
          for (
            const name of [
              "run-report.json",
              "run-state.json",
              "transcript.json",
            ]
          ) {
            expect(await Deno.readTextFile(join(artifactStore.runRoot, name)))
              .not.toContain("private-marker");
          }
        } finally {
          await Deno.remove(root, { recursive: true });
        }
      });
    }
  }
});

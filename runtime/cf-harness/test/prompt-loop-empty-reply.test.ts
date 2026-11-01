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

describe("prompt-loop-empty-reply", () => {
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
              choices: [{
                message: {
                  role: "assistant",
                  content,
                  ignored_detail: "private-marker",
                },
              }],
            }
            : {
              status: "completed",
              output: [{
                type: "message",
                role: "assistant",
                content: [
                  { type: "output_text", text: content },
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
          const path = join(
            artifactStore.runRoot,
            "model-turn-1-empty-reply.json",
          );
          if (content.trim().length === 0) {
            await expect(run).rejects.toMatchObject({
              code: "provider-unavailable",
              message:
                "The model returned an empty assistant response with no tool calls",
            });
            expect(engine.getRunState().status).toBe("failed");
            const artifact = JSON.parse(await Deno.readTextFile(path));
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
              isCodex ? { terminal, streamedItems } : payload,
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
            await expect(Deno.stat(path)).rejects.toBeInstanceOf(
              Deno.errors.NotFound,
            );
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

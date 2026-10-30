/** Checks the explicitly backed tool surface for durable Loom collections. */

import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  createHarnessHandleTable,
  mintAddressHandle,
  parseHandleRef,
} from "../../src/handle-table.ts";
import { CfHarnessPromptLoop } from "../../src/prompt-loop.ts";
import { directPromptSlotBindingFor } from "../support/prompt-slot-binding.ts";
import { responsesBodyFromChatFixture } from "../support/responses-fixture.ts";
import { startCommandHost } from "../support/command-host.ts";
import { openLegacySpace } from "../support/legacy-space.ts";
import { isObjectNotArray } from "@commonfabric/js-values/types";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  parentToolIdsForBacking,
  withheldToolIds,
} from "../../src/contracts/tool-descriptor.ts";
import { CfHarnessEngine } from "../../src/engine.ts";
import type { SandboxRuntime } from "../../src/sandbox/types.ts";
import type { ProcessRunRequest } from "../../src/sandbox/process-runner.ts";
import { getBuiltinTool } from "../../src/tools/registry.ts";

/** Backing sufficient only for the Loom authoring tools. */
const backing = {
  fabricSessionAvailable: false,
  patternIndexAvailable: false,
  skillsShSearchAvailable: false,
  skillsShAcquisitionAvailable: false,
  skillRegistryAvailable: false,
  docsCorpusAvailable: false,
  loomAuthoringAvailable: true,
};

/** Sandbox fixture which never starts a process. */
const sandbox: SandboxRuntime = {
  describe: () => ({
    kind: "runsc-cfc",
    defaultWorkingDirectory: "/workspace",
    cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
  }),
  defaultWorkingDirectory: () => "/workspace",
  resolvePath: (path) => path,
  isPathWithinWorkspace: () => true,
  isPathWithinAllowedRoots: () => true,
  run: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  runShell: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
};

/** Matching host evidence, including renderer data that stays host-side. */
const receipt = {
  loom_id: "loom-1111111111111111",
  request_id: "collection-one",
  version: 2,
  created: true,
  component_ids: ["c-1"],
  operation_ids: ["op-1", "op-2"],
  displaced: [{
    component_id: "c-old",
    title: "pattern:did:key:private/fid1:private",
  }],
};

/** Helper for tests, which records only explicitly routed host commands. */
const engineFixture = (configured = true) => {
  const calls: ProcessRunRequest[] = [];
  const engine = new CfHarnessEngine({
    model: "gpt-5.4",
    sandboxRuntime: sandbox,
    ...(configured
      ? {
        loomAuthoring: {
          cliPath: "/trusted/loom",
          transport: { kind: "broker" as const, queuePath: "/trusted/queue" },
        },
      }
      : {}),
    processRunner: {
      run(request) {
        calls.push(request);
        return Promise.resolve({
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            ok: true,
            result: {
              receipt,
              replayed: false,
              manifest: {
                loom_id: receipt.loom_id,
                version: 2,
                title: "References",
                components: [{
                  component_id: "c-1",
                  title: "A chart",
                  subject: { ref: "pattern:did:key:private/fid1:private" },
                  render: { url: "http://private-renderer" },
                }],
              },
            },
          }),
        });
      },
    },
  });
  return { engine, calls };
};

describe("loom-authoring", () => {
  describe("held Pattern Instances", () => {
    for (const named of [false, true]) {
      it(`resolves producer refs and rejects restricted, foreign-space, and subpath tokens in a ${named ? "named" : "DID"} session`, async () => {
        const identity = await Identity.fromPassphrase(
          "Loom tool isolated fixture",
        );
        const storageManager = StorageManager.emulate({ as: identity });
        const runtime = new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager,
        });
        const pieces = named
          ? await openLegacySpace(identity, runtime, "composition-receipt")
          : new PiecesController(
            createSession({
              identity,
              spaceDid: (await Identity.generate()).did(),
            }),
            runtime,
          );
        const received: Record<string, unknown>[] = [];
        await using host = startCommandHost({
          list: () =>
            Response.json({
              commands: [
                {
                  id: "loom.compose",
                  scope: "global",
                  inputs: { type: "object" },
                },
                { id: "loom.add", scope: "loom", inputs: { type: "object" } },
              ],
            }),
          run: (body) => {
            if (!isObjectNotArray(body)) {
              throw new Error("Expected command body");
            }
            received.push(body);
            return Response.json({ ok: true });
          },
        });
        try {
          const producer = new CfHarnessEngine({
            sandboxRuntime: sandbox,
            fabricSessionFactory: () => Promise.resolve({ pieces }),
          });
          const { output: produced } = await producer.invokeBuiltinTool(
            "run_pattern",
            {
              sourceText:
                "import { pattern } from 'commonfabric'; export default pattern(() => ({ count: 1 }));",
            },
          );
          if (
            !isObjectNotArray(produced) || produced.status !== "ok" ||
            typeof produced.ref !== "string" ||
            typeof produced.pieceId !== "string"
          ) {
            throw new Error("Expected a successful piece receipt");
          }
          await runtime.idle();
          await pieces.synced();
          const link = {
            ...parseHandleRef(produced.ref),
            space: pieces.getSpace(),
          };
          const createdId = produced.pieceId;
          const foreign = createSession({
            identity,
            spaceDid: (await Identity.generate()).did(),
          });
          const cases = [
            {
              ref: createLLMFriendlyLink(link, pieces.getSpace()),
              noFabric: true,
              allowed: false,
            },
            {
              ref: createLLMFriendlyLink(link, pieces.getSpace()),
              cancelDuringResolution: true,
              allowed: false,
            },
            {
              ref: createLLMFriendlyLink(
                runtime.getCell(pieces.getSpace(), "held-non-pattern")
                  .getAsNormalizedFullLink(),
                pieces.getSpace(),
              ),
              allowed: false,
            },
            {
              ref: createLLMFriendlyLink(link, pieces.getSpace()),
              allowed: true,
            },
            {
              ref: createLLMFriendlyLink(link),
              allowed: true,
            },
            {
              ref: createLLMFriendlyLink(link, pieces.getSpace()),
              capability: "skill-context" as const,
              allowed: false,
            },
            {
              ref: createLLMFriendlyLink(
                { ...link, path: ["count"] },
                pieces.getSpace(),
              ),
              allowed: false,
            },
            {
              ref: createLLMFriendlyLink(
                { ...link, scope: "session" },
                pieces.getSpace(),
              ),
              allowed: false,
            },
            {
              ref: createLLMFriendlyLink(
                { ...link, space: foreign.space },
                pieces.getSpace(),
              ),
              allowed: false,
            },
          ];
          for (const candidate of cases) {
            const calls: ProcessRunRequest[] = [];
            const controller = new AbortController();
            const engine = new CfHarnessEngine({
              model: "gpt-5.4",
              sandboxRuntime: sandbox,
              ...(!candidate.noFabric
                ? {
                  fabricSessionFactory: () => {
                    if (candidate.cancelDuringResolution) controller.abort();
                    return Promise.resolve({ pieces });
                  },
                }
                : {}),
              loomAuthoring: {
                cliPath: "/trusted/loom",
                transport: { kind: "broker", queuePath: "/trusted/queue" },
              },
              loomCommands: {
                url: host.url,
                actor: "agent:test",
                runId: "test",
              },
              processRunner: {
                run(request) {
                  calls.push(request);
                  return Promise.resolve({
                    exitCode: 0,
                    stderr: "",
                    stdout: JSON.stringify({
                      ok: true,
                      result: {
                        receipt,
                        replayed: false,
                        manifest: { loom_id: receipt.loom_id, version: 2 },
                      },
                    }),
                  });
                },
              },
            });
            const minted = await mintAddressHandle(
              createHarnessHandleTable(engine.getRunState().runId),
              candidate.ref,
              candidate.capability === undefined
                ? {}
                : { capability: candidate.capability },
            );
            await engine.recordHandleTable(minted.table);
            for (const field of ["pattern_token", "ref"]) {
              calls.length = 0;
              const { output } = await engine.invokeBuiltinTool(
                "loom_compose",
                {
                  request_id: "collection-one",
                  components: [{ [field]: minted.token }],
                },
                { signal: controller.signal },
              );
              expect(output.status).toBe(candidate.allowed ? "ok" : "error");
              expect(calls).toHaveLength(candidate.allowed ? 1 : 0);
              expect(JSON.stringify(output)).not.toContain("did:key:");
            }
            if (candidate.allowed) {
              expect(JSON.parse(calls[0].stdinText!).components[0].ref).toMatch(
                /^pattern:did:key:.+\/fid1:/,
              );
            }
            for (const command of ["loom.compose", "loom.add"]) {
              received.length = 0;
              const { output } = await engine.invokeBuiltinTool("run_command", {
                command,
                args: command === "loom.compose"
                  ? {
                    request_id: "collection-one",
                    components: [{ ref: minted.token }],
                  }
                  : { ref: minted.token },
              }, { signal: controller.signal });
              expect(output.status).toBe(
                candidate.allowed ? "executed" : "failed_to_deliver",
              );
              expect(received).toHaveLength(candidate.allowed ? 1 : 0);
              if (candidate.allowed) {
                expect(JSON.stringify(received[0])).toContain(
                  `pattern:${pieces.getSpace()}/${createdId}`,
                );
                expect(JSON.stringify(received[0])).not.toContain("/of:");
              }
            }
            if (candidate.allowed) {
              received.length = 0;
              const payloads = [{
                choices: [{
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "",
                    tool_calls: [{
                      id: "compose-held",
                      type: "function",
                      function: {
                        name: "run_command",
                        arguments: JSON.stringify({
                          calls: [{
                            command: "loom.compose",
                            args: {
                              request_id: "receipt-loop",
                              components: [{ ref: minted.token }],
                            },
                          }],
                        }),
                      },
                    }],
                  },
                }],
              }, {
                choices: [{
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "Done",
                  },
                }],
              }];
              let index = 0;
              const loop = new CfHarnessPromptLoop({
                engine,
                apiKey: "synthetic-test-key",
                model: "gpt-5.4",
                allowedToolIds: ["run_command"],
                fetchFn: () =>
                  Promise.resolve(Response.json(
                    responsesBodyFromChatFixture(payloads[index++]),
                  )),
              });
              await loop.runPrompt({
                prompt: "Compose the piece I hold",
                promptSlotBinding: directPromptSlotBindingFor("held-receipt"),
              });
              expect(received).toHaveLength(1);
              expect(JSON.stringify(received[0])).toContain(
                `pattern:${pieces.getSpace()}/${createdId}`,
              );
              expect(JSON.stringify(received[0])).not.toContain("/of:");
            }
          }
        } finally {
          await runtime.dispose();
          await storageManager.close();
        }
      });
    }
  });

  describe("prompt-loop authority", () => {
    it("requires direct-command authority before invoking the host write", async () => {
      for (const direct of [false, true]) {
        const { engine, calls } = engineFixture();
        const payloads = [
          {
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{
                  id: "compose-one",
                  type: "function",
                  function: {
                    name: "loom_compose",
                    arguments: JSON.stringify({
                      request_id: "collection-one",
                      components: [{ ref: "url:https://example.com" }],
                    }),
                  },
                }],
              },
            }],
          },
          {
            choices: [{
              index: 0,
              message: { role: "assistant", content: "Done" },
            }],
          },
        ];
        let index = 0;
        const loop = new CfHarnessPromptLoop({
          engine,
          apiKey: "synthetic-test-key",
          model: "gpt-5.4",
          allowedToolIds: ["loom_compose"],
          fetchFn: () =>
            Promise.resolve(
              new Response(
                JSON.stringify(responsesBodyFromChatFixture(payloads[index++])),
                { status: 200 },
              ),
            ),
        });
        await loop.runPrompt({
          prompt: "Make a Loom",
          ...(direct
            ? { promptSlotBinding: directPromptSlotBindingFor("loom-tools") }
            : {}),
        });
        expect(calls).toHaveLength(direct ? 1 : 0);
      }
    });
  });

  describe("host command boundary", () => {
    it("rejects ambiguous or malformed components without starting a host command", async () => {
      for (
        const components of [
          [],
          Array(101).fill({ ref: "url:https://example.com" }),
          [{}],
          [{ ref: "url:https://example.com", pattern_token: "cfh:a:abcde" }],
          [{ ref: "url:https://example.com", actor: "user" }],
          [{ pattern_token: 4 }],
          [{ ref: "piece:space/id" }],
        ]
      ) {
        const { engine, calls } = engineFixture();
        const { output } = await engine.invokeBuiltinTool("loom_compose", {
          request_id: "collection-one",
          components,
        });
        expect(output).toMatchObject({
          status: "error",
          mayHaveCommitted: false,
        });
        expect(calls).toHaveLength(0);
      }
    });

    it("projects historical context without leaking host paths or referenced cells", async () => {
      for (
        const bound_loom of [null, {
          loom_id: receipt.loom_id,
          version: 7,
          archived: false,
          source: "host-context",
          private: "private-host-path",
        }]
      ) {
        const engine = new CfHarnessEngine({
          sandboxRuntime: sandbox,
          loomAuthoring: {
            cliPath: "/trusted/loom",
            transport: { kind: "broker", queuePath: "/trusted/queue" },
          },
          processRunner: {
            run: () =>
              Promise.resolve({
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify({
                  ok: true,
                  result: {
                    kind: "authoring-context",
                    historical: true,
                    run_scoped: true,
                    truncated: true,
                    bound_loom,
                    authored: [{ receipt }, {
                      receipt: { loom_id: receipt.loom_id },
                    }],
                    secret: "private-host-path",
                  },
                }),
              }),
          },
        });
        const { output } = await engine.invokeBuiltinTool(
          "loom_authoring_context",
          {},
        );
        expect(output).toMatchObject({
          status: "ok",
          kind: "authoring-context",
          historical: true,
          truncated: true,
          authored: [{
            receipt: {
              loom_id: receipt.loom_id,
              displaced: [{ component_id: "c-old" }],
            },
          }, { receipt: { loom_id: receipt.loom_id, displaced: [] } }],
        });
        expect(JSON.stringify(output)).not.toContain("private");
        if (output.status !== "ok") {
          throw new Error("Expected historical context");
        }
        if (bound_loom === null) expect(output.bound_loom).toBeNull();
        else {expect(output.bound_loom).toMatchObject({
            loom_id: receipt.loom_id,
            version: 7,
          });}
      }
    });

    it("does not disclose uncertain host errors as proof of failed composition", async () => {
      const engine = new CfHarnessEngine({
        sandboxRuntime: sandbox,
        loomAuthoring: {
          cliPath: "/trusted/loom",
          transport: { kind: "broker", queuePath: "/trusted/queue" },
        },
        processRunner: {
          run: () =>
            Promise.resolve({
              exitCode: 1,
              stderr: "",
              stdout: JSON.stringify({
                ok: false,
                error: "private-cell-address",
              }),
            }),
        },
      });
      const { output } = await engine.invokeBuiltinTool("loom_compose", {
        request_id: "collection-one",
        components: [{ ref: "url:https://example.com" }],
      });
      expect(output).toMatchObject({ status: "error", mayHaveCommitted: true });
      expect(JSON.stringify(output)).not.toContain("private");
    });

    it("handles sparse inspection and failed reads without granting cell references", async () => {
      for (
        const manifest of [
          { loom_id: receipt.loom_id, version: 3 },
          {
            loom_id: receipt.loom_id,
            version: 3,
            components: [{ component_id: "c-1", title: "Only a label" }],
          },
          {},
        ]
      ) {
        const engine = new CfHarnessEngine({
          sandboxRuntime: sandbox,
          loomAuthoring: {
            cliPath: "/trusted/loom",
            transport: { kind: "broker", queuePath: "/trusted/queue" },
          },
          processRunner: {
            run: () =>
              Promise.resolve({
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify({ ok: true, result: { manifest } }),
              }),
          },
        });
        const { output } = await engine.invokeBuiltinTool("loom_inspect", {
          loom_id: receipt.loom_id,
        });
        if ("version" in manifest) {
          expect(output).toMatchObject({
            status: "ok",
            manifest: {
              components: "components" in manifest ? manifest.components : [],
            },
          });
        } else {expect(output).toMatchObject({
            status: "error",
            mayHaveCommitted: false,
          });}
      }
    });

    it("forwards existing non-Fabric object references without inventing or resolving them", async () => {
      for (
        const ref of [
          "wish:W-123",
          "page-id:pg_11111111111111111111111111111111",
          "section:pg_11111111111111111111111111111111:es-22222222222222222222222222222222",
          "intention:step-11111111111111111111111111111111",
          "chat:conv-example",
          "person:email:synthetic@example.com",
          "thread:signal.desktop:synthetic",
          "moment:moment-example",
          "loom:loom-2222222222222222",
          "run:r-123456789abc",
        ]
      ) {
        const { engine, calls } = engineFixture();
        const { output } = await engine.invokeBuiltinTool("loom_compose", {
          request_id: "collection-one",
          components: [{ ref }],
        });
        expect(output.status).toBe("ok");
        expect(calls).toHaveLength(1);
        expect(JSON.parse(calls[0].stdinText ?? "").components).toEqual([{
          ref,
        }]);
      }
    });

    it("keeps current displacement empty when replaying an old receipt", async () => {
      const engine = new CfHarnessEngine({
        sandboxRuntime: sandbox,
        loomAuthoring: {
          cliPath: "/trusted/loom",
          transport: { kind: "broker", queuePath: "/trusted/queue" },
        },
        processRunner: {
          run: () =>
            Promise.resolve({
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({
                ok: true,
                result: {
                  receipt,
                  replayed: true,
                  displaced: [],
                  manifest: { loom_id: receipt.loom_id, version: 9 },
                },
              }),
            }),
        },
      });
      const { output } = await engine.invokeBuiltinTool("loom_compose", {
        request_id: "collection-one",
        components: [{ ref: "url:https://example.com" }],
      });
      expect(output).toMatchObject({
        status: "ok",
        displaced: [],
        receipt: { displaced: [{ component_id: "c-old" }] },
        replayed: true,
      });
    });

    it("gives conflict-specific recovery without disclosing host error text", async () => {
      for (
        const [code, recovery] of [["version-conflict", "Inspect"], [
          "request-conflict",
          "original",
        ], ["bad-args", "Correct"]]
      ) {
        const engine = new CfHarnessEngine({
          sandboxRuntime: sandbox,
          loomAuthoring: {
            cliPath: "/trusted/loom",
            transport: { kind: "broker", queuePath: "/trusted/queue" },
          },
          processRunner: {
            run: () =>
              Promise.resolve({
                exitCode: 1,
                stderr: "",
                stdout: JSON.stringify({
                  ok: false,
                  code,
                  error: "private backend detail",
                }),
              }),
          },
        });
        const { output } = await engine.invokeBuiltinTool("loom_compose", {
          request_id: "collection-one",
          components: [{ ref: "url:https://example.com" }],
        });
        expect(output).toMatchObject({
          status: "error",
          mayHaveCommitted: false,
          code,
        });
        if (output.status === "error") {
          expect(output.message).toContain(recovery);
        }
        expect(JSON.stringify(output)).not.toContain("private");
      }
    });

    it("returns durable evidence without renderer data or raw Pattern Instance references", async () => {
      const { engine, calls } = engineFixture();
      const { output } = await engine.invokeBuiltinTool("loom_compose", {
        request_id: "collection-one",
        components: [{ ref: "url:https://example.com" }],
      });
      expect(output.status).toBe("ok");
      expect(output).toMatchObject({
        kind: "loom-authored",
        current_version: 2,
        receipt: {
          loom_id: receipt.loom_id,
          operation_ids: receipt.operation_ids,
        },
      });
      expect(JSON.stringify(output)).not.toContain("private");
      expect(calls).toHaveLength(1);
    });

    it("inspects layout without granting unheld Pattern Instances", async () => {
      const { engine } = engineFixture();
      const { output } = await engine.invokeBuiltinTool("loom_inspect", {
        loom_id: receipt.loom_id,
      });
      expect(output.status).toBe("ok");
      expect(output).toMatchObject({
        manifest: {
          components: [{
            component_id: "c-1",
            title: "A chart",
            reference_kind: "pattern",
          }],
        },
      });
      expect(JSON.stringify(output)).not.toContain("private");
    });

    it("refuses raw Pattern Instance references and unknown tokens before a host write", async () => {
      for (
        const component of [{ ref: "pattern:did:key:private/fid1:private" }, {
          pattern_token: "cfh:a:abcde",
        }]
      ) {
        const { engine, calls } = engineFixture();
        const { output } = await engine.invokeBuiltinTool("loom_compose", {
          request_id: "collection-one",
          components: [component],
        });
        expect(output.status).toBe("error");
        expect(calls).toHaveLength(0);
      }
    });

    it("refuses composition when configuration is absent or the turn is cancelled", async () => {
      for (const configured of [true, false]) {
        const { engine, calls } = engineFixture(configured);
        const { output } = await engine.invokeBuiltinTool("loom_compose", {
          request_id: "collection-one",
          components: [{ ref: "url:https://example.com" }],
        }, configured ? { signal: AbortSignal.abort() } : {});
        expect(output.status).toBe("error");
        expect(calls).toHaveLength(0);
      }
    });
  });

  describe("tool availability", () => {
    it("offers authoring and exact reads when the host backs them", () => {
      const ids = parentToolIdsForBacking(backing);
      expect(ids).toContain("loom_compose");
      expect(ids).toContain("loom_inspect");
      expect(ids).toContain("loom_authoring_context");
      expect(ids).not.toContain("run_pattern");
    });

    it("withholds the tools when the host has no authoring configuration", () => {
      const unavailable = { ...backing, loomAuthoringAvailable: false };
      expect([...withheldToolIds(unavailable)]).toContain("loom_compose");
      expect(parentToolIdsForBacking(unavailable)).not.toContain(
        "loom_compose",
      );
    });

    it("classifies composition as a write and context retrieval as reads", () => {
      expect(getBuiltinTool("loom_compose")?.descriptor.effectClass).toBe(
        "write",
      );
      expect(getBuiltinTool("loom_inspect")?.descriptor.effectClass).toBe(
        "read",
      );
      expect(getBuiltinTool("loom_authoring_context")?.descriptor.effectClass)
        .toBe("read");
    });
  });
});

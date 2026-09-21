/**
 * The model-facing boundary of `run_pattern` diagnostics: compiler messages
 * can embed compiler-generated bare fabric identifiers (the `/fid1:.../`
 * virtual module roots) which the handle boundary deliberately never swaps,
 * so the prompt loop scrubs them from the model-bound rendering while the
 * persisted artifact keeps the raw text. The same boundary is where a
 * diagnostic superseded by a later failure is collapsed to a summary.
 */

import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  FileSystemHarnessArtifactStore,
  type HarnessArtifactStore,
} from "../src/artifacts.ts";
import {
  createHarnessTranscriptOmissions,
  type HarnessTranscriptOmissions,
} from "../src/contracts/transcript-omissions.ts";
import type { HarnessTranscriptMessage } from "../src/contracts/transcript.ts";
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
import { scrubBareFabricIdentifiers } from "../src/fabric-identifier-scrub.ts";
import { responsesBodyFromChatFixture } from "./support/responses-fixture.ts";
import { directPromptSlotBindingFor } from "./support/prompt-slot-binding.ts";

// Marks each prompt below as one a person typed. `run_pattern` and
// `assign_slug` dispatch under that authorization.
const directPromptSlotBinding = directPromptSlotBindingFor("run-pattern");

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
    if (request.command.includes(CAPABILITY_PROBE_SENTINEL)) {
      return Promise.resolve({
        stdout: "bash\tpresent\t/bin/bash\tGNU bash, version 5.2.26(1)-release",
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

/** Artifact store that records tool outputs in memory, touching no disk. */
class RecordingArtifactStore implements HarnessArtifactStore {
  readonly artifactRoot = "/artifacts";
  readonly runRoot: string;
  readonly toolOutputs: Array<{
    toolId: string;
    outputId: string;
    output: unknown;
  }> = [];

  /** Every transcript the run persisted, each as it stood at that moment. */
  readonly transcripts: HarnessTranscriptMessage[][] = [];

  constructor(runId: string) {
    this.runRoot = `${this.artifactRoot}/${runId}`;
  }

  persistRunState(): Promise<string> {
    return Promise.resolve(`${this.runRoot}/run-state.json`);
  }

  persistTranscript(
    transcript: readonly HarnessTranscriptMessage[],
  ): Promise<string> {
    this.transcripts.push(structuredClone([...transcript]));
    return Promise.resolve(`${this.runRoot}/transcript.json`);
  }

  persistCapabilitySnapshot(): Promise<string> {
    return Promise.resolve(`${this.runRoot}/capabilities.json`);
  }

  persistCfcPolicySnapshot(): Promise<string> {
    return Promise.resolve(`${this.runRoot}/policy-snapshot.json`);
  }

  persistRunReport(): Promise<string> {
    return Promise.resolve(`${this.runRoot}/run-report.json`);
  }

  persistToolOutput(
    toolId: string,
    outputId: string,
    output: unknown,
  ): Promise<string> {
    this.toolOutputs.push({ toolId, outputId, output });
    return Promise.resolve(
      `${this.runRoot}/tool-outputs/${outputId}-${toolId}.json`,
    );
  }
}

/** Filesystem store that also snapshots each transcript after its real write. */
class RecordingFileArtifactStore extends FileSystemHarnessArtifactStore {
  readonly transcripts: HarnessTranscriptMessage[][] = [];

  override async persistTranscript(
    transcript: readonly HarnessTranscriptMessage[],
  ): Promise<string> {
    const path = await super.persistTranscript(transcript);
    this.transcripts.push(structuredClone([...transcript]));
    return path;
  }
}

describe("prompt-loop run_pattern model boundary", () => {
  describe("scrubBareFabricIdentifiers()", () => {
    it("replaces bare tagged hashes, DIDs, and data URIs with the placeholder", () => {
      const hash = "A".repeat(43);
      expect(scrubBareFabricIdentifiers(
        `Could not resolve "/fid1:${hash}/missing.ts".`,
      )).toBe('Could not resolve "/[fabric-id]/missing.ts".');
      expect(scrubBareFabricIdentifiers("space did:key:z6MkfffTest denied"))
        .toBe("space [fabric-id] denied");
      expect(scrubBareFabricIdentifiers("at data:application/json;base64,AAAA"))
        .toBe("at [fabric-id]");
      expect(scrubBareFabricIdentifiers("at DATA:text/plain;base64,AAAA"))
        .toBe("at [fabric-id]");
    });

    it("leaves schemed link forms and handle tokens untouched", () => {
      const hash = "B".repeat(43);
      const schemed = `/of:fid1:${hash}/items/0`;
      const computed = `computed:fid1:${hash}`;
      const token = "cfh:a:abcde";
      const text = `see ${schemed} then ${computed} and ${token}`;
      expect(scrubBareFabricIdentifiers(text)).toBe(text);
    });
  });

  it("records the compiled pattern's result schema on the handle minted for its result reference", async () => {
    const signer = await Identity.fromPassphrase("run-pattern result schema");
    const storageManager = StorageManager.emulate({ as: signer });
    const fabricRuntime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `run-pattern-schema-${crypto.randomUUID()}`,
      }),
      fabricRuntime,
    );
    await pieces.synced();
    try {
      const runId = "run-pattern-result-schema";
      const doublingSource = [
        "import { computed, pattern } from 'commonfabric';",
        "export default pattern<{ n: number }, { doubled: number }>(",
        "  ({ n }) => ({ doubled: computed(() => n * 2) }),",
        ");",
      ].join("\n");
      const requestBodies: unknown[] = [];
      const fetchFn: typeof fetch = (_input, init) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        const payload = requestBodies.length === 1
          ? {
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "run_pattern",
                    arguments: JSON.stringify({
                      sourceText: doublingSource,
                      inputs: { n: 3 },
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
          new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
            status: 200,
          }),
        );
      };
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          sandboxRuntime: new FakeSandboxRuntime(),
          runId,
          model: "gpt-5.4",
          fabricSessionFactory: () => Promise.resolve({ pieces }),
        }),
        fetchFn,
      });

      const result = await loop.runPrompt({
        prompt: "Run the pattern.",
        promptSlotBinding: directPromptSlotBinding,
      });

      // One handle: the result reference, carrying the shape compilation
      // already knew, so the token is checkable without reading the cell.
      const entries = result.runState.handleTable?.entries ?? [];
      expect(entries.length).toBe(1);
      const schema = entries[0]?.schema as
        | { properties?: Record<string, unknown> }
        | undefined;
      expect(schema?.properties?.doubled).toBeDefined();
      // The schema reaches the model through the token, not inline.
      const toolMessage = result.transcript.find(
        (message) => message.role === "tool",
      );
      expect(toolMessage?.content).not.toContain("resultRefSchema");
    } finally {
      await fabricRuntime.dispose();
      await storageManager.close();
    }
  });

  it("shows the model a named piece's slug and URL while keeping the piece id out of the tool message", async () => {
    const signer = await Identity.fromPassphrase("run-pattern registration");
    const storageManager = StorageManager.emulate({ as: signer });
    const spaceName = `run-pattern-register-${crypto.randomUUID()}`;
    const fabricRuntime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const pieces = new PiecesController(
      await createSession({ identity: signer, spaceName }),
      fabricRuntime,
    );
    await pieces.synced();
    try {
      // A real default pattern, so the space has a piece registry to join.
      const defaultRoot = await pieces.create(
        [
          "import { handler, pattern, type Cell, type Stream } from 'commonfabric';",
          "const addPiece = handler<{ piece: unknown }, { pieceRegistry: Cell<unknown[]> }>(",
          "  true,",
          "  { type: 'object', properties: { pieceRegistry: { type: 'array', asCell: ['cell'] } } },",
          "  ({ piece }, { pieceRegistry }) => {",
          "    pieceRegistry.push(piece);",
          "  },",
          ");",
          "export default pattern<",
          "  { pieceRegistry: unknown[] },",
          "  { pieceRegistry: unknown[]; addPiece: Stream<{ piece: unknown }> }",
          ">(",
          "  ({ pieceRegistry }) => ({",
          "    pieceRegistry,",
          "    addPiece: addPiece({ pieceRegistry }),",
          "  }),",
          ");",
        ].join("\n"),
        { input: { pieceRegistry: [] } },
      );
      await pieces.linkDefaultPattern(defaultRoot.getCell());
      await fabricRuntime.idle();
      await pieces.synced();
      const doublingSource = [
        "import { computed, pattern, UI } from 'commonfabric';",
        "export default pattern<{ n: number }, { doubled: number }>(",
        "  ({ n }) => ({ doubled: computed(() => n * 2), [UI]: <div>{n * 2}</div> }),",
        ");",
      ].join("\n");
      let calls = 0;
      const fetchFn: typeof fetch = (_input, init) => {
        calls += 1;
        let payload;
        if (calls === 1) {
          payload = {
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "run_pattern",
                    arguments: JSON.stringify({
                      sourceText: doublingSource,
                      inputs: { n: 3 },
                    }),
                  },
                }],
              },
            }],
          };
        } else if (calls === 2) {
          // The model lifts the result token out of the tool message it was
          // just shown and names the piece with it, the way a live agent
          // chains the two tools.
          const token = String(init?.body ?? "").match(/cfh:a:[a-z2-9]+/)?.[0];
          payload = {
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{
                  id: "call-2",
                  type: "function",
                  function: {
                    name: "assign_slug",
                    arguments: JSON.stringify({
                      token,
                      slug: "doubling-report",
                    }),
                  },
                }],
              },
            }],
          };
        } else {
          payload = {
            choices: [{
              index: 0,
              message: { role: "assistant", content: "Done." },
            }],
          };
        }
        return Promise.resolve(
          new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
            status: 200,
          }),
        );
      };
      const artifactStore = new RecordingArtifactStore(
        "run-pattern-registration",
      );
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          sandboxRuntime: new FakeSandboxRuntime(),
          runId: "run-pattern-registration",
          artifactStore,
          model: "gpt-5.4",
          fabricSessionFactory: () => Promise.resolve({ pieces }),
        }),
        fetchFn,
      });

      const result = await loop.runPrompt({
        prompt: "Publish the pattern.",
        promptSlotBinding: directPromptSlotBinding,
      });

      const toolMessages = result.transcript.filter(
        (message) => message.role === "tool",
      );
      // The second tool message is assign_slug's.
      const toolMessage = toolMessages[1];
      expect(toolMessage?.content).toContain("doubling-report");
      expect(toolMessage?.content).toContain(
        `http://toolshed.test/${spaceName}/doubling-report`,
      );
      // The address a person opens is the slug, and the piece id it stands in
      // for stays on the trusted side as it always has.
      const registered = await pieces.getRegisteredPieces();
      expect(registered.length).toBe(1);
      expect(toolMessage?.content).not.toContain(registered[0].id);
      expect(toolMessage?.content).not.toContain("pieceId");
      expect(
        artifactStore.toolOutputs.find((entry) =>
          entry.toolId === "assign_slug"
        )?.output,
      )
        .toMatchObject({ slug: "doubling-report", pieceId: registered[0].id });
      const named = result.runState.toolOutputs.find((entry) =>
        entry.toolId === "assign_slug"
      );
      const omissions = createHarnessTranscriptOmissions(result.transcript);
      expect(
        omissions.results.find((entry) => entry.outputId === named?.outputId)
          ?.rules,
      )
        .toEqual([{
          rule: "artifact-only",
          locations: [{
            artifactPath: named?.artifactPath,
            jsonPointer: "/pieceId",
          }],
        }]);
    } finally {
      await fabricRuntime.dispose();
      await storageManager.close();
    }
  });

  it("keeps a bare fabric identifier in an assign_slug error out of the model-facing tool message", async () => {
    const did = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
    let calls = 0;
    const fetchFn: typeof fetch = () => {
      calls += 1;
      const payload = calls === 1
        ? {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call-1",
                type: "function",
                function: {
                  name: "assign_slug",
                  arguments: JSON.stringify({
                    token: "/of:fid1:abc",
                    slug: "doubling-report",
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
        new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
          status: 200,
        }),
      );
    };
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "assign-slug-scrub",
        model: "gpt-5.4",
        fabricSessionFactory: () =>
          Promise.reject(new Error(`authorization denied for ${did}`)),
      }),
      fetchFn,
    });

    const result = await loop.runPrompt({
      prompt: "Name the piece.",
      promptSlotBinding: directPromptSlotBinding,
    });

    const toolMessage = result.transcript.find(
      (message) => message.role === "tool",
    );
    expect(toolMessage?.content).toContain(
      "could not establish the fabric session",
    );
    expect(toolMessage?.content).not.toContain(did);
    expect(toolMessage?.content).toContain("[fabric-id]");
  });

  it("keeps bare fabric identifiers in compile diagnostics out of the model-facing tool message while the artifact keeps the raw text", async () => {
    const signer = await Identity.fromPassphrase("run-pattern scrub");
    const storageManager = StorageManager.emulate({ as: signer });
    const fabricRuntime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `run-pattern-scrub-${crypto.randomUUID()}`,
      }),
      fabricRuntime,
    );
    await pieces.synced();
    try {
      const runId = "run-pattern-scrub";
      const artifactStore = new RecordingArtifactStore(runId);
      const brokenSource = [
        "import { computed, pattern } from 'commonfabric';",
        "import { helper } from './missing.ts';",
        "export default pattern<{ n: number }, { doubled: number }>(",
        "  ({ n }) => ({ doubled: computed(() => helper(n)) }),",
        ");",
      ].join("\n");
      const requestBodies: unknown[] = [];
      const fetchFn: typeof fetch = (_input, init) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        const payload = requestBodies.length === 1
          ? {
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "run_pattern",
                    arguments: JSON.stringify({ sourceText: brokenSource }),
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
          new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
            status: 200,
          }),
        );
      };
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          sandboxRuntime: new FakeSandboxRuntime(),
          artifactStore,
          runId,
          model: "gpt-5.4",
          fabricSessionFactory: () => Promise.resolve({ pieces }),
        }),
        fetchFn,
      });

      const result = await loop.runPrompt({
        prompt: "Run the pattern.",
        promptSlotBinding: directPromptSlotBinding,
      });

      const toolMessage = result.transcript.find(
        (message) => message.role === "tool",
      );
      expect(toolMessage?.content).toBeDefined();
      const toolContent = toolMessage!.content!;
      const parsed = JSON.parse(toolContent) as {
        status: string;
        message: string;
      };
      expect(parsed.status).toBe("compile-error");
      expect(parsed.message).toContain("[fabric-id]");
      expect(toolContent).not.toMatch(/fid1:[A-Za-z0-9_-]{43}/);
      expect(toolContent).not.toContain("did:key:");
      expect(toolContent).not.toContain("data:");
      // The persisted artifact keeps the raw diagnostic — the scrub is a
      // model-boundary rendering, not a rewrite of the record.
      const persisted = artifactStore.toolOutputs.find(
        (entry) => entry.toolId === "run_pattern",
      );
      const persistedMessage =
        (persisted?.output as { message: string }).message;
      expect(persistedMessage).toMatch(/fid1:[A-Za-z0-9_-]{43}/);
    } finally {
      await fabricRuntime.dispose();
      await storageManager.close();
    }
  });

  it("collapses the superseded compile diagnostic when a second run_pattern failure arrives", async () => {
    const artifactRoot = await Deno.makeTempDir();
    const signer = await Identity.fromPassphrase("run-pattern collapse");
    const storageManager = StorageManager.emulate({ as: signer });
    const fabricRuntime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `run-pattern-collapse-${crypto.randomUUID()}`,
      }),
      fabricRuntime,
    );
    await pieces.synced();
    try {
      const runId = "run-pattern-collapse";
      const artifactStore = new RecordingFileArtifactStore({
        artifactRoot,
        runId,
      });
      // The long missing-module name keeps the raw diagnostic larger than its
      // collapse marker while contributing a Fabric id for the prior scrub.
      const brokenSource = (missing: string) =>
        [
          "import { computed, pattern } from 'commonfabric';",
          `import { helper } from './${missing}-${"x".repeat(2_000)}.ts';`,
          "export default pattern<{ n: number }, { doubled: number }>(",
          `  ({ n }) => ({ doubled: computed(() => ${missing}(n)) }),`,
          ");",
        ].join("\n");
      let calls = 0;
      const fetchFn: typeof fetch = () => {
        calls += 1;
        const payload = calls <= 2
          ? {
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{
                  id: `call-${calls}`,
                  type: "function",
                  function: {
                    name: "run_pattern",
                    arguments: JSON.stringify({
                      sourceText: brokenSource(`missing-${calls}`),
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
          new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
            status: 200,
          }),
        );
      };
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          sandboxRuntime: new FakeSandboxRuntime(),
          artifactStore,
          runId,
          model: "gpt-5.4",
          fabricSessionFactory: () => Promise.resolve({ pieces }),
        }),
        fetchFn,
      });

      const result = await loop.runPrompt({
        prompt: "Run the pattern.",
        promptSlotBinding: directPromptSlotBinding,
      });

      const contents = result.transcript
        .filter((message) => message.role === "tool")
        .map((message) =>
          JSON.parse(message.content) as {
            status: string;
            message: string;
            messageCollapsed?: boolean;
            messageOriginalLength?: number;
          }
        );
      expect(contents.length).toBe(2);
      expect(contents[0].status).toBe("compile-error");
      expect(contents[0].messageCollapsed).toBe(true);
      expect(contents[0].message).toContain(
        "superseded run_pattern diagnostic collapsed",
      );
      expect(contents[0].message).toContain(
        "attempt 1, compile-error, first line:",
      );
      expect(contents[0].messageOriginalLength).toBeGreaterThan(
        contents[0].message.length,
      );
      expect(contents[1].messageCollapsed).toBe(undefined);
      expect(contents[1].message).toContain("missing-2");
      // Each persisted transcript holds the context the model was given on
      // the turn that followed it: the first diagnostic in full while it was
      // the newest, and summarized once the second superseded it.
      const messageAt = (
        transcript: HarnessTranscriptMessage[],
      ): string | undefined => {
        const first = transcript.find((message) => message.role === "tool");
        return first === undefined
          ? undefined
          : (JSON.parse(first.content) as { message: string }).message;
      };
      const persisted = artifactStore.transcripts.map(messageAt)
        .filter((message) => message !== undefined);
      expect(persisted[0]).toContain("missing-1");
      expect(persisted.at(-1)).toContain(
        "superseded run_pattern diagnostic collapsed",
      );
      // Both diagnostics stay whole in the tool-output artifacts.
      const outputs = await Promise.all(
        result.runState.toolOutputs
          .filter((entry) => entry.toolId === "run_pattern")
          .map(async (entry) =>
            (JSON.parse(await Deno.readTextFile(entry.artifactPath!)) as {
              message: string;
            }).message
          ),
      );
      expect(outputs.length).toBe(2);
      expect(outputs[0]).toContain("missing-1");
      expect(outputs[1]).toContain("missing-2");

      const omissions = JSON.parse(
        await Deno.readTextFile(
          `${artifactStore.runRoot}/transcript-omissions.json`,
        ),
      ) as HarnessTranscriptOmissions;
      const firstResult = omissions.results.find((entry) =>
        entry.outputId === result.runState.toolOutputs[0].outputId
      );
      expect(firstResult).toEqual({
        transcriptIndex: 2,
        toolCallId: "call-1",
        toolId: "run_pattern",
        outputId: result.runState.toolOutputs[0].outputId,
        rules: [{
          rule: "bare-fabric-identifier-scrub",
          locations: [{
            artifactPath: result.runState.toolOutputs[0].artifactPath,
            jsonPointer: "/message",
          }],
        }, {
          rule: "superseded-run-pattern-diagnostic-collapse",
          locations: [{
            artifactPath: result.runState.toolOutputs[0].artifactPath,
            jsonPointer: "/message",
          }],
        }],
      });
    } finally {
      await fabricRuntime.dispose();
      await storageManager.close();
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("collapses the superseded pattern source when a second run_pattern call arrives", async () => {
    const signer = await Identity.fromPassphrase("run-pattern source collapse");
    const storageManager = StorageManager.emulate({ as: signer });
    const fabricRuntime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `run-pattern-source-${crypto.randomUUID()}`,
      }),
      fabricRuntime,
    );
    await pieces.synced();
    try {
      const runId = "run-pattern-source";
      const artifactStore = new RecordingArtifactStore(runId);
      const sourceFor = (attempt: number) =>
        [
          "import { computed, pattern } from 'commonfabric';",
          `// draft ${attempt}: ${"a reason this line exists. ".repeat(20)}`,
          "export default pattern<{ n: number }, { doubled: number }>(",
          `  ({ n }) => ({ doubled: computed(() => missing${attempt}(n)) }),`,
          ");",
        ].join("\n");
      let calls = 0;
      const fetchFn: typeof fetch = () => {
        calls += 1;
        const payload = calls <= 2
          ? {
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{
                  id: `call-${calls}`,
                  type: "function",
                  function: {
                    name: "run_pattern",
                    arguments: JSON.stringify({
                      sourceText: sourceFor(calls),
                      description: "Doubles a number",
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
          new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
            status: 200,
          }),
        );
      };
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          sandboxRuntime: new FakeSandboxRuntime(),
          artifactStore,
          runId,
          model: "gpt-5.4",
          fabricSessionFactory: () => Promise.resolve({ pieces }),
        }),
        fetchFn,
      });

      const result = await loop.runPrompt({
        prompt: "Run the pattern.",
        promptSlotBinding: directPromptSlotBinding,
      });

      const sourcesIn = (
        transcript: readonly HarnessTranscriptMessage[],
      ): string[] =>
        transcript.filter((message) => message.role === "assistant")
          .flatMap((message) => message.toolCalls ?? [])
          .filter((toolCall) => toolCall.function.name === "run_pattern")
          .map((toolCall) =>
            (JSON.parse(toolCall.function.arguments) as { sourceText: string })
              .sourceText
          );
      const sources = sourcesIn(result.transcript);
      expect(sources.length).toBe(2);
      expect(sources[0]).toBe(
        "[cf-harness: superseded run_pattern source collapsed for model " +
          `context; attempt 1, ${sourceFor(1).length} characters. The newest ` +
          "run_pattern call carries the source to edit; this attempt's " +
          `source is preserved in tool output ${runId}:run_pattern:1.]`,
      );
      expect(sources[1]).toBe(sourceFor(2));
      // The rest of the call the model wrote is left as it wrote it.
      const collapsedCall = result.transcript
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.toolCalls ?? [])[0];
      expect(JSON.parse(collapsedCall.function.arguments).description).toBe(
        "Doubles a number",
      );
      // Each persisted transcript holds the context the model was given on
      // the turn that followed it.
      const persisted = artifactStore.transcripts.map(sourcesIn)
        .filter((entry) => entry.length > 0);
      expect(persisted[0][0]).toBe(sourceFor(1));
      expect(persisted.at(-1)?.[0]).toContain(
        "superseded run_pattern source collapsed",
      );
      // Both drafts stay whole in artifacts of their own.
      const preserved = artifactStore.toolOutputs
        .filter((entry) => entry.toolId === "run-pattern-source")
        .map((entry) =>
          entry.output as { outputId: string; sourceText: string }
        );
      expect(preserved.map((entry) => entry.outputId)).toEqual([
        `${runId}:run_pattern:1`,
        `${runId}:run_pattern:2`,
      ]);
      expect(preserved[0].sourceText).toBe(sourceFor(1));
      expect(preserved[1].sourceText).toBe(sourceFor(2));
    } finally {
      await fabricRuntime.dispose();
      await storageManager.close();
    }
  });

  it("collapses both sources of a batched turn once a later call supersedes them", async () => {
    const signer = await Identity.fromPassphrase("run-pattern source batch");
    const storageManager = StorageManager.emulate({ as: signer });
    const fabricRuntime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `run-pattern-batch-${crypto.randomUUID()}`,
      }),
      fabricRuntime,
    );
    await pieces.synced();
    try {
      const runId = "run-pattern-batch";
      const artifactStore = new RecordingArtifactStore(runId);
      const sourceFor = (attempt: number) =>
        [
          "import { computed, pattern } from 'commonfabric';",
          `// draft ${attempt}: ${"a reason this line exists. ".repeat(20)}`,
          "export default pattern<{ n: number }, { doubled: number }>(",
          `  ({ n }) => ({ doubled: computed(() => missing${attempt}(n)) }),`,
          ");",
        ].join("\n");
      const patternCall = (attempt: number) => ({
        id: `call-${attempt}`,
        type: "function",
        function: {
          name: "run_pattern",
          arguments: JSON.stringify({ sourceText: sourceFor(attempt) }),
        },
      });
      let calls = 0;
      const fetchFn: typeof fetch = () => {
        calls += 1;
        // One turn making two calls at once, then a turn making a third.
        const payload = calls === 1
          ? {
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [patternCall(1), patternCall(2)],
              },
            }],
          }
          : calls === 2
          ? {
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [patternCall(3)],
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
          new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
            status: 200,
          }),
        );
      };
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          sandboxRuntime: new FakeSandboxRuntime(),
          artifactStore,
          runId,
          model: "gpt-5.4",
          fabricSessionFactory: () => Promise.resolve({ pieces }),
        }),
        fetchFn,
      });

      const result = await loop.runPrompt({
        prompt: "Run the patterns.",
        promptSlotBinding: directPromptSlotBinding,
      });

      const sources = result.transcript
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.toolCalls ?? [])
        .map((toolCall) =>
          (JSON.parse(toolCall.function.arguments) as { sourceText: string })
            .sourceText
        );
      expect(sources.length).toBe(3);
      expect(sources[0]).toContain(
        `attempt 1, ${sourceFor(1).length} characters`,
      );
      expect(sources[0]).toContain(`tool output ${runId}:run_pattern:1.]`);
      expect(sources[1]).toContain(
        `attempt 2, ${sourceFor(2).length} characters`,
      );
      expect(sources[1]).toContain(`tool output ${runId}:run_pattern:2.]`);
      expect(sources[2]).toBe(sourceFor(3));
      // Each marker names an artifact that was written.
      const preserved = artifactStore.toolOutputs
        .filter((entry) => entry.toolId === "run-pattern-source")
        .map((entry) => (entry.output as { outputId: string }).outputId);
      expect(preserved).toEqual([
        `${runId}:run_pattern:1`,
        `${runId}:run_pattern:2`,
        `${runId}:run_pattern:3`,
      ]);
    } finally {
      await fabricRuntime.dispose();
      await storageManager.close();
    }
  });

  it("collapses the first source of a batched turn that no later turn follows", async () => {
    const signer = await Identity.fromPassphrase("run-pattern batch final");
    const storageManager = StorageManager.emulate({ as: signer });
    const fabricRuntime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `run-pattern-batch-final-${crypto.randomUUID()}`,
      }),
      fabricRuntime,
    );
    await pieces.synced();
    try {
      const runId = "run-pattern-batch-final";
      const artifactStore = new RecordingArtifactStore(runId);
      const sourceFor = (attempt: number) =>
        [
          "import { computed, pattern } from 'commonfabric';",
          `// draft ${attempt}: ${"a reason this line exists. ".repeat(20)}`,
          "export default pattern<{ n: number }, { doubled: number }>(",
          `  ({ n }) => ({ doubled: computed(() => missing${attempt}(n)) }),`,
          ");",
        ].join("\n");
      let calls = 0;
      const fetchFn: typeof fetch = () => {
        calls += 1;
        // The batch is the run's last word before the final answer, so the
        // sibling it superseded has no later call to collapse it.
        const payload = calls === 1
          ? {
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [1, 2].map((attempt) => ({
                  id: `call-${attempt}`,
                  type: "function",
                  function: {
                    name: "run_pattern",
                    arguments: JSON.stringify({
                      sourceText: sourceFor(attempt),
                    }),
                  },
                })),
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
          new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
            status: 200,
          }),
        );
      };
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          sandboxRuntime: new FakeSandboxRuntime(),
          artifactStore,
          runId,
          model: "gpt-5.4",
          fabricSessionFactory: () => Promise.resolve({ pieces }),
        }),
        fetchFn,
      });

      const result = await loop.runPrompt({
        prompt: "Run the patterns.",
        promptSlotBinding: directPromptSlotBinding,
      });

      const sources = result.transcript
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.toolCalls ?? [])
        .map((toolCall) =>
          (JSON.parse(toolCall.function.arguments) as { sourceText: string })
            .sourceText
        );
      expect(sources.length).toBe(2);
      expect(sources[0]).toContain(`tool output ${runId}:run_pattern:1.]`);
      expect(sources[1]).toBe(sourceFor(2));
    } finally {
      await fabricRuntime.dispose();
      await storageManager.close();
    }
  });

  it("keeps every draft when the run has no artifact store to preserve them in", async () => {
    const signer = await Identity.fromPassphrase("run-pattern no store");
    const storageManager = StorageManager.emulate({ as: signer });
    const fabricRuntime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `run-pattern-no-store-${crypto.randomUUID()}`,
      }),
      fabricRuntime,
    );
    await pieces.synced();
    try {
      const sourceFor = (attempt: number) =>
        [
          "import { computed, pattern } from 'commonfabric';",
          `// draft ${attempt}: ${"a reason this line exists. ".repeat(20)}`,
          "export default pattern<{ n: number }, { doubled: number }>(",
          `  ({ n }) => ({ doubled: computed(() => missing${attempt}(n)) }),`,
          ");",
        ].join("\n");
      let calls = 0;
      const fetchFn: typeof fetch = () => {
        calls += 1;
        const payload = calls <= 2
          ? {
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{
                  id: `call-${calls}`,
                  type: "function",
                  function: {
                    name: "run_pattern",
                    arguments: JSON.stringify({ sourceText: sourceFor(calls) }),
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
          new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
            status: 200,
          }),
        );
      };
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          sandboxRuntime: new FakeSandboxRuntime(),
          runId: "run-pattern-no-store",
          model: "gpt-5.4",
          fabricSessionFactory: () => Promise.resolve({ pieces }),
        }),
        fetchFn,
      });

      const result = await loop.runPrompt({
        prompt: "Run the pattern.",
        promptSlotBinding: directPromptSlotBinding,
      });

      // Nothing holds the drafts but the transcript, so the transcript keeps
      // them: a marker here would name an artifact nobody wrote.
      const sources = result.transcript
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.toolCalls ?? [])
        .map((toolCall) =>
          (JSON.parse(toolCall.function.arguments) as { sourceText: string })
            .sourceText
        );
      expect(sources).toEqual([sourceFor(1), sourceFor(2)]);
    } finally {
      await fabricRuntime.dispose();
      await storageManager.close();
    }
  });
});

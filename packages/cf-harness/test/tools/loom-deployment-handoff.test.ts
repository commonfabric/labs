/** Checks host deployment receipts at the model-facing Loom tool boundary. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { pieceId } from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  createFileSystemHarnessArtifactStore,
  readHarnessRunState,
} from "../../src/artifacts.ts";
import { CfHarnessEngine } from "../../src/engine.ts";
import {
  createHarnessHandleTable,
  mintAddressHandle,
} from "../../src/handle-table.ts";
import { CfHarnessPromptLoop } from "../../src/prompt-loop.ts";
import type { HarnessRunState } from "../../src/run-state.ts";
import type { SandboxRuntime } from "../../src/sandbox/types.ts";
import { directPromptSlotBindingFor } from "../support/prompt-slot-binding.ts";
import { responsesBodyFromChatFixture } from "../support/responses-fixture.ts";

/** Sandbox fixture whose operations have no process or network effects. */
const sandbox: SandboxRuntime = {
  describe: () => ({
    kind: "docker-runsc-cfc",
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

/** Helper for tests, which gives each case an isolated real Pattern Instance. */
const fixture = async () => {
  const identity = await Identity.fromPassphrase("deployed-pattern-fixture");
  const storage = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL("http://toolshed.test/base"),
    storageManager: storage,
  });
  const pieces = new PiecesController(
    await createSession({ identity, spaceName: "handoff" }),
    runtime,
  );
  const created = await pieces.create(
    "import { pattern } from 'commonfabric'; export default pattern(() => ({ count: 1 }));",
  );
  await runtime.idle();
  await pieces.synced();
  const cell = created.getCell();
  return {
    pieces,
    runtime,
    link: createLLMFriendlyLink(
      cell.getAsNormalizedFullLink(),
      pieces.getSpace(),
    ),
    receipt: {
      schema: "loom-deployed-pattern-v1",
      api_url: "http://toolshed.test/base/",
      space: "handoff",
      piece_id: pieceId(cell)!,
    },
    async close() {
      await runtime.dispose();
      await storage.close();
    },
  };
};

/** One model-selected tool call. */
interface Call {
  /** The dedicated tool's name. */
  name: string;

  /** Model-owned input fields. */
  args: Record<string, unknown>;
}

/** Helper for tests, which drives actual tool dispatch and model projection. */
const runCalls = async (engine: CfHarnessEngine, calls: Call[]) => {
  let index = 0;
  const loop = new CfHarnessPromptLoop({
    engine,
    apiKey: "synthetic-key",
    model: "gpt-5.4",
    allowedToolIds: ["loom_authoring_context", "loom_compose", "finish_task"],
    fetchFn: () => {
      const call = calls[index++];
      if (call === undefined) {
        throw new Error("The model requested an unscripted handoff turn");
      }
      const message = {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: `call-${index}`,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.args),
          },
        }],
      };
      return Promise.resolve(
        new Response(
          JSON.stringify(responsesBodyFromChatFixture({
            choices: [{ index: 0, message }],
          })),
          { status: 200 },
        ),
      );
    },
  });
  const result = await loop.runPrompt({
    prompt: "Collect the Pattern I deployed into a Loom.",
    promptSlotBinding: directPromptSlotBindingFor("handoff"),
  });
  expect(result.taskOutcome?.outcome).toBe("gave-up");
  return result;
};

/** Helper for tests, which represents a successful host context command. */
const contextResult = (deployed: unknown) => ({
  kind: "authoring-context",
  historical: true,
  run_scoped: true,
  truncated: false,
  bound_loom: { loom_id: "loom-1111111111111111", available: true },
  authored: [],
  ...(deployed === undefined ? {} : { deployed_patterns: deployed }),
});

describe("loom-deployment-handoff", () => {
  it("persists one general token across repeated context and a resumed dedicated composition", async () => {
    const f = await fixture();
    const root = await Deno.makeTempDir({ prefix: "loom-handoff-" });
    try {
      const runId = "deployment-handoff";
      const artifactStore = createFileSystemHarnessArtifactStore({
        artifactRoot: root,
        runId,
      });
      const submitted: Record<string, unknown>[] = [];
      const makeEngine = (runState?: HarnessRunState) =>
        new CfHarnessEngine({
          runId,
          runState,
          artifactStore,
          model: "gpt-5.4",
          sandboxRuntime: sandbox,
          fabricSession: {
            apiUrl: "http://toolshed.test/base",
            space: "handoff",
            identityKeyPath: "/synthetic/key",
          },
          fabricSessionFactory: () => Promise.resolve({ pieces: f.pieces }),
          loomAuthoring: {
            cliPath: "/trusted/loom",
            transport: { kind: "broker", queuePath: "/trusted/queue" },
          },
          processRunner: {
            run(request) {
              const command = request.args.indexOf("loom.compose");
              let result: unknown;
              if (command >= 0) {
                const input = JSON.parse(request.stdinText!);
                submitted.push(input);
                result = {
                  receipt: {
                    loom_id: "loom-1111111111111111",
                    request_id: input.request_id,
                    version: 1,
                    created: true,
                    component_ids: ["c-1"],
                    operation_ids: ["op-1"],
                    displaced: [],
                  },
                  replayed: false,
                  manifest: { loom_id: "loom-1111111111111111", version: 1 },
                };
              } else {
                result = contextResult({ receipts: [f.receipt, f.receipt] });
              }
              return Promise.resolve({
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify({ ok: true, result }),
              });
            },
          },
        });
      const minted = await mintAddressHandle(
        createHarnessHandleTable(runId),
        f.link,
      );
      const composition = {
        request_id: "same-run-collection",
        components: [{ pattern_token: minted.token, stage: true }],
      };
      const first = await runCalls(makeEngine(), [
        { name: "loom_authoring_context", args: {} },
        { name: "loom_authoring_context", args: {} },
        { name: "loom_compose", args: composition },
        {
          name: "finish_task",
          args: {
            outcome: "gave-up",
            message:
              "The available tools can inspect deployments but cannot name a displayable result.",
          },
        },
      ]);
      const observations = first.transcript.filter((m) =>
        m.role === "tool" &&
        JSON.parse(m.content!).kind === "authoring-context"
      );
      for (const observation of observations) {
        expect(JSON.parse(observation.content!)).toMatchObject({
          status: "ok",
          deployed_patterns: [{ pattern_token: minted.token }],
        });
        expect(observation.content).not.toContain(f.receipt.piece_id);
      }
      expect(observations).toHaveLength(2);
      expect(first.runState.handleTable?.entries).toHaveLength(1);
      const saved = await readHarnessRunState(
        `${artifactStore.runRoot}/run-state.json`,
      );
      expect(saved.handleTable).toEqual(first.runState.handleTable);
      const raw = await Deno.readTextFile(saved.toolOutputs[0].artifactPath!);
      expect(raw).toContain(f.receipt.piece_id);
      expect(raw).not.toContain(minted.token);
      const second = await runCalls(makeEngine(saved), [
        { name: "loom_authoring_context", args: {} },
        { name: "loom_compose", args: composition },
        {
          name: "finish_task",
          args: {
            outcome: "gave-up",
            message:
              "The available tools can inspect deployments but cannot name a displayable result.",
          },
        },
      ]);
      const lowered = {
        request_id: "same-run-collection",
        components: [{
          ref: `pattern:${f.pieces.getSpace()}/${f.receipt.piece_id}`,
          stage: true,
        }],
      };
      expect(submitted).toEqual([lowered, lowered]);
      expect(second.runState.handleTable?.entries).toHaveLength(1);
    } finally {
      await f.close();
      await Deno.remove(root, { recursive: true });
    }
  });

  it("projects verified deployments while retaining ordinary context for unavailable inputs", async () => {
    const f = await fixture();
    try {
      const cases = [
        { name: "old-host", deployed: undefined },
        {
          name: "no-fabric",
          noFabric: true,
          deployed: { receipts: [f.receipt] },
        },
        {
          name: "no-target",
          noTarget: true,
          deployed: { receipts: [f.receipt] },
        },
        {
          name: "unavailable-fabric",
          unavailableFabric: true,
          deployed: { receipts: [f.receipt] },
        },
        { name: "missing-list", deployed: {} },
        { name: "invalid-list", deployed: { receipts: "not a receipt array" } },
        {
          name: "bounded-list",
          deployed: { receipts: [...Array(32).fill({}), f.receipt] },
        },
        ...[
          { api_url: "not a URL" },
          { api_url: "http://toolshed.test:8001/base" },
          { api_url: "http://toolshed.test/other" },
          { api_url: "http://alias.test/base" },
          { api_url: "http://toolshed.test/base?run=other" },
          { space: "foreign" },
          { piece_id: "fid1:bad" },
          { piece_id: `fid1:${"A".repeat(43)}` },
          {
            piece_id: f.runtime.getCell(f.pieces.getSpace(), "ordinary-cell")
              .getAsNormalizedFullLink().id.slice(3),
          },
          { schema: "unknown" },
          { api_url: undefined },
        ].map((delta, index) => ({
          name: `invalid-${index}`,
          deployed: { receipts: [{ ...f.receipt, ...delta }] },
        })),
        {
          name: "restricted",
          restricted: true,
          deployed: { receipts: [f.receipt] },
        },
        {
          name: "restricted-qualified",
          restricted: true,
          qualified: true,
          deployed: { receipts: [f.receipt] },
        },
        {
          name: "general-qualified",
          general: true,
          qualified: true,
          deployed: {
            receipts: [{ ...f.receipt, space: f.pieces.getSpace() }],
          },
        },
      ];
      for (const candidate of cases) {
        const engine = new CfHarnessEngine({
          runId: candidate.name,
          model: "gpt-5.4",
          sandboxRuntime: sandbox,
          ...(!("noFabric" in candidate)
            ? {
              fabricSessionFactory: () =>
                "unavailableFabric" in candidate
                  ? Promise.reject(
                    new Error("Synthetic unavailable Fabric session"),
                  )
                  : Promise.resolve({ pieces: f.pieces }),
            }
            : {}),
          ...(!("noTarget" in candidate) && !("noFabric" in candidate)
            ? {
              fabricSession: {
                apiUrl: "http://toolshed.test/base",
                space: "handoff",
                identityKeyPath: "/synthetic/key",
              },
            }
            : {}),
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
                  result: contextResult(candidate.deployed),
                }),
              }),
          },
        });
        let expectedToken: string | undefined;
        if ("restricted" in candidate || "general" in candidate) {
          const held = await mintAddressHandle(
            createHarnessHandleTable(candidate.name),
            "qualified" in candidate
              ? `/@${f.pieces.getSpace()}/of:${f.receipt.piece_id}`
              : f.link,
            "restricted" in candidate ? { capability: "skill-context" } : {},
          );
          await engine.recordHandleTable(held.table);
          if ("general" in candidate) expectedToken = held.token;
        }
        const result = await runCalls(engine, [
          { name: "loom_authoring_context", args: {} },
          {
            name: "finish_task",
            args: {
              outcome: "gave-up",
              message:
                "The available tools can inspect deployments but cannot name a displayable result.",
            },
          },
        ]);
        const observation = result.transcript.find((m) => m.role === "tool")!;
        expect(JSON.parse(observation.content!)).toMatchObject({
          status: "ok",
          kind: "authoring-context",
          bound_loom: { loom_id: "loom-1111111111111111", available: true },
          deployed_patterns: expectedToken === undefined
            ? []
            : [{ pattern_token: expectedToken }],
        });
        expect(observation.content).not.toContain(f.receipt.piece_id);
        if (expectedToken === undefined) {
          expect(observation.content).not.toContain("cfh:a:");
        }
        expect(result.runState.handleTable?.entries ?? []).toHaveLength(
          "restricted" in candidate || "general" in candidate ? 1 : 0,
        );
        if ("restricted" in candidate) {
          expect(result.runState.handleTable?.entries[0].capability).toBe(
            "skill-context",
          );
        }
      }
    } finally {
      await f.close();
    }
  });
});

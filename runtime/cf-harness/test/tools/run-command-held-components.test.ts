/**
 * Checks that a Loom component a host names in a command's answer reaches the
 * model as a held handle, and never as the address the host stored.
 */

import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { pieceId } from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { CfHarnessEngine } from "../../src/engine.ts";
import { resolveHandleToken } from "../../src/handle-table.ts";
import { CfHarnessPromptLoop } from "../../src/prompt-loop.ts";
import type { SandboxRuntime } from "../../src/sandbox/types.ts";
import { HELD_COMPONENT_LIMIT } from "../../src/tools/loom-commands.ts";
import { type CommandHost, startCommandHost } from "../support/command-host.ts";
import { directPromptSlotBindingFor } from "../support/prompt-slot-binding.ts";
import { responsesBodyFromChatFixture } from "../support/responses-fixture.ts";

/** Sandbox fixture whose operations have no process or network effects. */
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

/** A Loom manifest naming each of `refs` as one component, plus `extra`. */
const manifest = (refs: readonly string[], extra: object = {}) => ({
  ok: true,
  id: "loom.inspect",
  result: {
    kind: "manifest",
    manifest: {
      loom_id: "loom-38aa85ab0d3248da",
      title: "Invites",
      ...extra,
      components: refs.map((ref, index) => ({
        component_id: `comp-${index}`,
        subject: { mode: "reference", ref },
        title: `Component ${index}`,
      })),
    },
  },
  outputs: { loom_id: "loom-38aa85ab0d3248da", version: 3 },
});

describe("run_command: components a host names", () => {
  let identity: Identity;
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;
  let instanceId: string;
  let plainId: string;
  let host: CommandHost;
  let answer: unknown;

  beforeAll(async () => {
    identity = await Identity.fromPassphrase("held-components");
    storage = StorageManager.emulate({ as: identity });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test/"),
      storageManager: storage,
    });
    pieces = new PiecesController(
      createSession({ identity, spaceDid: (await Identity.generate()).did() }),
      runtime,
    );
    const created = await pieces.create(
      "import { pattern } from 'commonfabric'; export default pattern(() => ({ count: 1 }));",
    );
    const plain = runtime.getCell(pieces.getSpace(), { held: "plain" });
    await runtime.editWithRetry((tx) => {
      plain.withTx(tx).set({ value: 1 });
    });
    await runtime.idle();
    await pieces.synced();
    instanceId = pieceId(created.getCell())!;
    plainId = pieceId(plain)!;
    host = startCommandHost({
      list: () =>
        Response.json({
          commands: [{
            id: "loom.inspect",
            effect: "read",
            inputs: { type: "object" },
          }],
        }),
      run: () => Response.json(answer),
    });
  });

  afterAll(async () => {
    await host[Symbol.asyncDispose]();
    await runtime.dispose();
    await storage.close();
  });

  /**
   * Runs one `run_command loom.inspect` turn whose answer is `manifest(refs)`,
   * returning the tool message the model read and the engine.
   */
  const inspect = async (refs: readonly string[], extra: object = {}) => {
    answer = manifest(refs, extra);
    const engine = new CfHarnessEngine({
      model: "gpt-5.4",
      sandboxRuntime: sandbox,
      loomCommands: { url: host.url, actor: "agent:test", runId: "job-1" },
      fabricSessionFactory: () => Promise.resolve({ pieces }),
    });
    const bodies: string[] = [];
    let turn = 0;
    const loop = new CfHarnessPromptLoop({
      engine,
      apiKey: "synthetic-key",
      model: "gpt-5.4",
      allowedToolIds: ["run_command", "finish_task"],
      fetchFn: (_url, init) => {
        bodies.push(String(init?.body ?? ""));
        turn += 1;
        const call = turn === 1
          ? {
            name: "run_command",
            args: { command: "loom.inspect", args: {} },
          }
          : {
            name: "finish_task",
            args: { outcome: "gave-up", message: "done" },
          };
        return Promise.resolve(
          new Response(
            JSON.stringify(responsesBodyFromChatFixture({
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{
                    id: `call-${turn}`,
                    type: "function",
                    function: {
                      name: call.name,
                      arguments: JSON.stringify(call.args),
                    },
                  }],
                },
              }],
            })),
            { status: 200 },
          ),
        );
      },
    });
    await loop.runPrompt({
      prompt: "Update a row in my Invites loom.",
      promptSlotBinding: directPromptSlotBindingFor("held-components"),
    });
    // The second request carries the tool message the first call produced.
    return { seen: bodies[1] ?? "", engine };
  };

  it("hands the model a held handle for an own-space Pattern Instance", async () => {
    const { seen, engine } = await inspect([
      `pattern:${pieces.getSpace()}/${instanceId}`,
    ]);
    expect(seen).not.toContain(instanceId);
    expect(seen).not.toContain("pattern:");
    const token = seen.match(/cfh:a:[A-Za-z0-9]+/)?.[0];
    expect(token).toBeDefined();
    expect(resolveHandleToken(engine.handleTable!, token!)?.ref)
      .toContain(`of:${instanceId}`);
  });

  it("holds Loom's stored of: spelling, and an address under any key", async () => {
    const own = pieces.getSpace();
    const { seen, engine } = await inspect(
      [`pattern:${own}/of:${instanceId}`],
      {
        inbox: `pattern:${own}/${instanceId}`,
        also: [`pattern:${own}/${instanceId}`],
      },
    );
    expect(seen).not.toContain(instanceId);
    expect(seen).not.toContain("pattern:");
    const tokens = new Set(seen.match(/cfh:a:[A-Za-z0-9]+/g));
    // one piece, one handle, wherever and however it was spelled
    expect(tokens.size).toBe(1);
    expect(resolveHandleToken(engine.handleTable!, [...tokens][0])?.ref)
      .toContain(`of:${instanceId}`);
  });

  it("withholds a component it cannot hold, saying why, and never its address", async () => {
    const foreign = (await Identity.generate()).did();
    const own = pieces.getSpace();
    const { seen } = await inspect([
      `pattern:${foreign}/${instanceId}`,
      `pattern:${own}/${plainId}`,
      `pattern:${own}/of:fid1:${"A".repeat(43)}`,
    ], { also: [`pattern:${foreign}/${plainId}`] });
    expect(seen).not.toContain(instanceId);
    expect(seen).not.toContain(plainId);
    expect(seen).not.toContain("A".repeat(43));
    expect(seen).not.toMatch(/cfh:a:/);
    expect(seen.match(/ref_unheld\\":\\"foreign-space/g)).toHaveLength(1);
    expect(seen.match(/ref_unheld\\":\\"not-a-pattern-instance/g))
      .toHaveLength(2);
    expect(seen).toContain('{\\"unheld\\":\\"foreign-space\\"}');
  });

  it("keeps a named slug and the retired piece: spelling, which are not stored addresses", async () => {
    const own = pieces.getSpace();
    const { seen } = await inspect([
      `pattern:${own}/invites`,
      `piece:${own}/${instanceId}`,
    ]);
    expect(seen).toContain(`pattern:${own}/invites`);
    expect(seen).not.toContain("unheld");
  });

  it("verifies at most the limit's worth of distinct pieces in one answer", async () => {
    const own = pieces.getSpace();
    const ids = Array.from(
      { length: HELD_COMPONENT_LIMIT + 1 },
      (_, index) => `fid1:${String(index).padStart(43, "B")}`,
    );
    const { seen } = await inspect(ids.map((id) => `pattern:${own}/${id}`));
    expect(seen.match(/ref_unheld\\":\\"limit/g)).toHaveLength(1);
    expect(seen.match(/ref_unheld\\":\\"not-a-pattern-instance/g))
      .toHaveLength(HELD_COMPONENT_LIMIT);
  });
});

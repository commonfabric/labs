import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";

import { createCfHarnessCliCapabilities } from "../../src/cli.ts";
import { HARNESS_COMMAND_CATALOG_MODEL_MAX_BYTES } from "../../src/client-actions/command-result.ts";
import {
  HARNESS_COMMAND_ARGS_MAX_BYTES,
  HARNESS_COMMAND_ID_MAX_LENGTH,
} from "../../src/contracts/client-command.ts";
import {
  LOOM_COMMAND_TOOL_IDS,
  parentToolIdsForBacking,
  withheldToolIds,
} from "../../src/contracts/tool-descriptor.ts";
import {
  CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  type PromptSlotBinding,
} from "../../src/contracts/prompt-slot.ts";
import { createToolOutputId } from "../../src/contracts/tool-result.ts";
import { CfHarnessEngine } from "../../src/engine.ts";
import {
  createLoomCommandCatalogSource,
  type HarnessLoomCommandsConfig,
} from "../../src/loom-commands.ts";
import { CfHarnessPromptLoop } from "../../src/prompt-loop.ts";
import type {
  ProcessRunner,
  ProcessRunRequest,
  ProcessRunResult,
} from "../../src/sandbox/process-runner.ts";
import type { SandboxRuntime } from "../../src/sandbox/types.ts";
import { harnessSessionToolBacking } from "../../src/session-assembly.ts";
import {
  type ListCommandsOutput,
  listCommandsTool,
  LOOM_COMMAND_COMPLETED_LIMIT,
  LOOM_COMMAND_TOOLS,
  LOOM_COMMAND_UNTRUSTED_NOTICE,
  LOOM_COMMANDS_EFFECT_NOTICE,
  loomCommandModelContextObservation,
  RUN_COMMAND_BATCH_LIMIT,
  type RunCommandInput,
  runCommandModelView,
  type RunCommandOutput,
  runCommandTool,
} from "../../src/tools/loom-commands.ts";
import { LOOM_RETRIEVAL_MAX_OUTPUT_CHARS } from "../../src/tools/loom-retrieval.ts";
import { getBuiltinTool } from "../../src/tools/registry.ts";
import type { HarnessToolContext } from "../../src/tools/types.ts";
import { directPromptSlotBindingFor } from "../support/prompt-slot-binding.ts";
import { responsesBodyFromChatFixture } from "../support/responses-fixture.ts";

const OWNER = "https://cfc.test/atom/owner";
const HEALTH = "https://cfc.test/atom/facet/health";

/** A fresh broker-routed host configuration. */
const freshConfig = (): HarnessLoomCommandsConfig => ({
  cliPath: "/trusted/loom",
  transport: { kind: "broker", queuePath: "/trusted/queue" },
});

/** The manifest the stub host lists: two visible rows and one hidden. */
const MANIFEST = {
  schema: "loom.commands",
  version: 3,
  commands: [
    {
      id: "loom.compose",
      title: "Compose a loom.",
      help: "Creates or extends a loom.",
      scope: "global",
      inputs: { type: "object", properties: { title: { type: "string" } } },
      outputs: ["loom_id", "version"],
    },
    {
      id: "loom.inspect",
      title: "Read a loom's manifest.",
      scope: "loom",
      inputs: { type: "object" },
    },
    { id: "share.invite", actors: ["user"], origins_refused: ["session"] },
    {
      id: "people-discovery.dossier",
      title: "Gather what is known about a person.",
      scope: "global",
      effect: "read",
      inputs: {
        type: "object",
        required: ["entity_id"],
        "x-surface": "pill",
        properties: {
          entity_id: { type: "string" },
          limit: { type: "integer", default: 50, "x-widget": "stepper" },
        },
      },
      outputs: ["messages", "records"],
    },
  ],
};

/** The signature the listing shows for `people-discovery.dossier`. */
const DOSSIER_SIGNATURE =
  "people-discovery.dossier(entity_id: string, limit?: integer = 50) -> {messages, records}  [read, global]";

/** Helper for tests, which answers `command list` and `command run` apart. */
const contextWith = (
  options: {
    manifest?: string;
    answer?:
      | string
      | ((request: ProcessRunRequest) => Promise<ProcessRunResult>);
    config?: HarnessLoomCommandsConfig;
    configured?: boolean;
    aborted?: boolean;
    ceiling?: readonly unknown[];
    queryLabel?: unknown[];
    referents?: Record<string, unknown>[];
  } = {},
): { context: HarnessToolContext; calls: ProcessRunRequest[] } => {
  const calls: ProcessRunRequest[] = [];
  const controller = new AbortController();
  if (options.aborted === true) controller.abort();
  let outputs = 0;
  const hostProcessRunner: ProcessRunner = {
    run(request: ProcessRunRequest): Promise<ProcessRunResult> {
      calls.push(request);
      if (request.args[1] === "list") {
        return Promise.resolve({
          stdout: options.manifest ?? JSON.stringify(MANIFEST),
          stderr: "",
          exitCode: 0,
        });
      }
      const answer = options.answer ?? JSON.stringify({ ok: true });
      return typeof answer === "string"
        ? Promise.resolve({ stdout: answer, stderr: "", exitCode: 0 })
        : answer(request);
    },
  };
  const config = options.config ?? freshConfig();
  const context: Partial<HarnessToolContext> = {
    nextOutputId: (toolId: string) =>
      createToolOutputId("run-commands", toolId, ++outputs),
    hostProcessRunner,
    // The engine holds one catalog source for the run, as here.
    ...(options.configured === false ? {} : {
      loomCommands: config,
      loomCommandCatalog: createLoomCommandCatalogSource(
        config,
        hostProcessRunner,
      ),
    }),
    ...(options.ceiling !== undefined
      ? {
        cfcReadMaxConfidentiality: options
          .ceiling as HarnessToolContext["cfcReadMaxConfidentiality"],
      }
      : {}),
    ...(options.queryLabel !== undefined
      ? {
        toolInputCfcLabel: {
          confidentiality: options.queryLabel,
        } as HarnessToolContext["toolInputCfcLabel"],
      }
      : {}),
    ...(options.referents !== undefined
      ? {
        mintReferentHandle: (referent: Record<string, unknown>) => {
          options.referents!.push(referent);
          return Promise.resolve(`cfh:v:3333${options.referents!.length}`);
        },
      }
      : {}),
    signal: controller.signal,
  };
  return { context: context as HarnessToolContext, calls };
};

/** Narrows a listing to its success arm, failing the test otherwise. */
const listed = (output: ListCommandsOutput) => {
  expect(output.status).toBe("ok");
  if (output.status !== "ok") throw new Error("unreachable");
  return output;
};

/** Narrows a command's output to its executed arm, failing the test otherwise. */
const executed = (output: RunCommandOutput) => {
  expect(output.status).toBe("executed");
  if (output.status !== "executed") throw new Error("unreachable");
  return output;
};

/** Narrows a command's output to its batch arm, failing the test otherwise. */
const batched = (output: RunCommandOutput) => {
  expect(output.status).toBe("batch");
  if (output.status !== "batch") throw new Error("unreachable");
  return output;
};

/** Sandbox fixture which never starts a process. */
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

/** Helper for engine tests, which answers list and run like `contextWith`. */
const engineWith = (
  answer: string,
  options: {
    ceiling?: readonly unknown[];
    cfcEnforcementMode?: CfcEnforcementMode;
  } = {},
) => {
  const calls: ProcessRunRequest[] = [];
  const engine = new CfHarnessEngine({
    model: "gpt-5.4",
    sandboxRuntime: sandbox,
    loomCommands: freshConfig(),
    ...(options.cfcEnforcementMode !== undefined
      ? { cfcEnforcementMode: options.cfcEnforcementMode }
      : {}),
    ...(options.ceiling !== undefined
      ? {
        fabricSession: {
          apiUrl: "https://toolshed.example/",
          identityKeyPath: "/keys/agent.pkcs8",
          space: "my-space",
          cfcReadMaxConfidentiality: options
            .ceiling as HarnessToolContext["cfcReadMaxConfidentiality"],
        },
      }
      : {}),
    processRunner: {
      run(request) {
        calls.push(request);
        return Promise.resolve({
          stdout: request.args[1] === "list"
            ? JSON.stringify(MANIFEST)
            : answer,
          stderr: "",
          exitCode: 0,
        });
      },
    },
  });
  return { engine, calls };
};

describe("loom-commands tools", () => {
  describe("availability", () => {
    /** Backing with everything but the command broker switched off. */
    const backing = {
      fabricSessionAvailable: false,
      patternIndexAvailable: false,
      skillsShSearchAvailable: false,
      skillsShAcquisitionAvailable: false,
      skillRegistryAvailable: false,
      docsCorpusAvailable: false,
    };

    it("names the two tools, listing as a read and running as a write", () => {
      expect([...LOOM_COMMAND_TOOL_IDS]).toEqual([
        "list_commands",
        "run_command",
      ]);
      expect(getBuiltinTool("list_commands")?.descriptor.effectClass).toBe(
        "read",
      );
      expect(getBuiltinTool("run_command")?.descriptor.effectClass).toBe(
        "write",
      );
      expect(LOOM_COMMAND_TOOLS.map((tool) => tool.descriptor.toolId))
        .toEqual(["list_commands", "run_command"]);
    });

    it("withholds the tools without a host command broker and offers them with one", () => {
      const without = { ...backing, loomCommandsAvailable: false };
      for (const toolId of LOOM_COMMAND_TOOL_IDS) {
        expect(withheldToolIds(without).has(toolId)).toBe(true);
        expect(parentToolIdsForBacking(without)).not.toContain(toolId);
        const offered = { ...backing, loomCommandsAvailable: true };
        expect(withheldToolIds(offered).has(toolId)).toBe(false);
        expect(parentToolIdsForBacking(offered)).toContain(toolId);
      }
    });

    it("derives the availability flag from a session's `loomCommands` configuration", () => {
      const base = {
        model: "gpt-5.4",
        workspaceHostPath: "/tmp/workspace",
      } as unknown as Parameters<typeof harnessSessionToolBacking>[0];
      expect(harnessSessionToolBacking(base).loomCommandsAvailable).toBe(false);
      expect(
        harnessSessionToolBacking({ ...base, loomCommands: freshConfig() })
          .loomCommandsAvailable,
      ).toBe(true);
    });

    it("lists the tools among the CLI's selectable parent tools", () => {
      const capabilities = createCfHarnessCliCapabilities();
      for (const toolId of LOOM_COMMAND_TOOL_IDS) {
        expect(capabilities.parentToolIds).toContain(toolId);
        expect(capabilities.builtinToolIds).toContain(toolId);
      }
    });
  });

  describe("listCommandsTool", () => {
    it("returns an error without starting a process when the run has no configuration", async () => {
      const { context, calls } = contextWith({ configured: false });
      expect(await listCommandsTool.invoke(context, {})).toMatchObject({
        status: "error",
        code: "not_configured",
      });
      expect(calls).toHaveLength(0);
    });

    it("returns an error without starting a process once the turn is cancelled", async () => {
      const { context, calls } = contextWith({ aborted: true });
      expect(await listCommandsTool.invoke(context, {})).toMatchObject({
        status: "error",
        code: "cancelled",
      });
      expect(calls).toHaveLength(0);
    });

    it("relays a host failure as a typed error", async () => {
      const { context } = contextWith({ manifest: "Error: no broker" });
      expect(await listCommandsTool.invoke(context, {})).toMatchObject({
        status: "error",
        code: "command_failed",
      });
    });

    it("returns the commands an agent may run, the hidden count, and the effect notice", async () => {
      const { context } = contextWith();
      const output = listed(await listCommandsTool.invoke(context, {}));
      expect(output.notice).toBe(LOOM_COMMANDS_EFFECT_NOTICE);
      expect(output.entries).toEqual([
        {
          name: "loom.compose",
          signature:
            "loom.compose(title?: string) -> {loom_id, version}  [global]",
          title: "Compose a loom.",
          description: "Creates or extends a loom.",
        },
        {
          name: "loom.inspect",
          signature: "loom.inspect(...)  [loom]",
          title: "Read a loom's manifest.",
        },
        {
          name: "people-discovery.dossier",
          signature: DOSSIER_SIGNATURE,
          title: "Gather what is known about a person.",
        },
      ]);
      expect(output.hidden).toBe(1);
      expect(output.compacted).toBeUndefined();
      expect(output.omitted).toBeUndefined();
    });

    it("returns the full argument schema, without `x-*` keywords, only for a command named in `detail`", async () => {
      const { context } = contextWith();
      const output = listed(
        await listCommandsTool.invoke(context, {
          detail: ["people-discovery.dossier"],
        }),
      );
      const [compose, , dossier] = output.entries;
      expect("inputSchema" in compose).toBe(false);
      expect(dossier).toMatchObject({
        signature: DOSSIER_SIGNATURE,
        inputSchema: {
          type: "object",
          required: ["entity_id"],
          properties: {
            entity_id: { type: "string" },
            limit: { type: "integer", default: 50 },
          },
        },
      });
      expect(JSON.stringify(output)).not.toContain("x-");
    });

    it("counts unreadable rows as omitted", async () => {
      const { context } = contextWith({
        manifest: JSON.stringify({ commands: [{ id: "a.b" }, 7] }),
      });
      expect(listed(await listCommandsTool.invoke(context, {})).omitted)
        .toBe(1);
    });

    it("compacts a catalog past the model bound, keeping the commands named in `detail` whole", async () => {
      const help = "h".repeat(4_000);
      const rows = Array.from({ length: 12 }, (_, index) => ({
        id: `cmd.n${index}`,
        help,
        inputs: { type: "object" },
      }));
      expect(JSON.stringify(rows).length).toBeGreaterThan(
        HARNESS_COMMAND_CATALOG_MODEL_MAX_BYTES,
      );
      const { context } = contextWith({
        manifest: JSON.stringify({ commands: rows }),
      });
      const output = listed(
        await listCommandsTool.invoke(context, { detail: ["cmd.n11"] }),
      );
      expect(output.compacted).toBeGreaterThan(0);
      const last = output.entries.at(-1)!;
      expect(last.name).toBe("cmd.n11");
      expect("description" in last).toBe(true);
      expect("inputSchema" in last).toBe(true);
      const compactedEntry = output.entries.at(-2)!;
      expect("description" in compactedEntry).toBe(false);
      expect(compactedEntry.signature).toBe("cmd.n10(...)  [global]");
    });
  });

  describe("runCommandTool", () => {
    it("returns an error without starting a process when the run has no configuration", async () => {
      const { context, calls } = contextWith({ configured: false });
      expect(
        await runCommandTool.invoke(context, { command: "a.b", args: {} }),
      ).toMatchObject({
        status: "failed_to_deliver",
        code: "not_configured",
        landed: "no",
      });
      expect(calls).toHaveLength(0);
    });

    it("refuses malformed input before starting a process", async () => {
      const inputs = [
        { command: "-bad", args: {} },
        { command: 7, args: {} },
        { command: `a${"b".repeat(128)}`, args: {} },
        { command: "a.b", args: [] },
        { command: "a.b", args: { when: new Date() } },
        { command: "a.b", args: {}, loomId: "loom-x" },
        { command: "a.b", args: {}, loomId: 7 },
        { command: "a.b", args: {}, expectedVersion: -1 },
        { command: "a.b", args: {}, expectedVersion: 1.5 },
      ];
      for (const input of inputs) {
        const { context, calls } = contextWith();
        expect(
          await runCommandTool.invoke(
            context,
            input as unknown as Parameters<typeof runCommandTool.invoke>[1],
          ),
        ).toMatchObject({
          status: "failed_to_deliver",
          code: "invalid_input",
          landed: "no",
        });
        expect(calls).toHaveLength(0);
      }
    });

    it("refuses args larger than the contract's bound before starting a process", async () => {
      const { context, calls } = contextWith();
      const output = await runCommandTool.invoke(context, {
        command: "loom.compose",
        args: { title: "x".repeat(HARNESS_COMMAND_ARGS_MAX_BYTES) },
      });
      expect(output).toMatchObject({
        status: "failed_to_deliver",
        code: "invalid_input",
      });
      if (output.status === "failed_to_deliver") {
        expect(output.reason).toContain(`${HARNESS_COMMAND_ARGS_MAX_BYTES}`);
      }
      expect(calls).toHaveLength(0);
    });

    it("returns an error without starting a process once the turn is cancelled", async () => {
      const { context, calls } = contextWith({ aborted: true });
      expect(
        await runCommandTool.invoke(context, {
          command: "loom.compose",
          args: {},
        }),
      ).toMatchObject({ status: "failed_to_deliver", code: "cancelled" });
      expect(calls).toHaveLength(0);
    });

    it("refuses without running when the host's list cannot be read", async () => {
      const { context, calls } = contextWith({ manifest: "[]" });
      expect(
        await runCommandTool.invoke(context, {
          command: "loom.compose",
          args: {},
        }),
      ).toMatchObject({
        status: "failed_to_deliver",
        code: "malformed_payload",
        landed: "no",
      });
      expect(calls.map((call) => call.args[1])).toEqual(["list"]);
    });

    it("returns `unknown_command` with the nearest listed names for a command the listing leaves out, sending nothing", async () => {
      for (
        const [command, suggestion] of [
          ["share.invite", undefined],
          ["loom.compse", "loom.compose"],
          ["dossier", "people-discovery.dossier"],
        ] as const
      ) {
        const { context, calls } = contextWith();
        const output = await runCommandTool.invoke(context, {
          command,
          args: {},
        });
        expect(output).toMatchObject({ status: "unknown_command", command });
        if (output.status !== "unknown_command") throw new Error("unreachable");
        expect(output.suggestions.length).toBeLessThanOrEqual(3);
        expect(output.suggestions).not.toContain("share.invite");
        if (suggestion !== undefined) {
          expect(output.suggestions[0]).toBe(suggestion);
        }
        expect(output.hint).toContain("list_commands");
        expect(calls.map((call) => call.args[1])).toEqual(["list"]);
      }
    });

    it("adds the signature to an answer the host refused as `bad-args`, and to no other", async () => {
      for (const [code, signed] of [["bad-args", true], ["other", false]]) {
        const { context } = contextWith({
          answer: JSON.stringify({ ok: false, code, error: "no" }),
        });
        const output = executed(
          await runCommandTool.invoke(context, {
            command: "people-discovery.dossier",
            args: { entity_id: "e" },
          }),
        );
        expect(output.signature).toBe(signed ? DOSSIER_SIGNATURE : undefined);
      }
    });

    it("reads the host's listing once for the run, and again only when listed explicitly", async () => {
      const { context, calls } = contextWith();
      await runCommandTool.invoke(context, {
        command: "loom.compose",
        args: {},
      });
      await runCommandTool.invoke(context, {
        command: "loom.inspect",
        args: {},
        loomId: "loom-0123456789abcdef",
      });
      await listCommandsTool.invoke(context, {});
      await runCommandTool.invoke(context, {
        command: "loom.compose",
        args: {},
      });
      expect(calls.map((call) => call.args[1])).toEqual([
        "list",
        "run",
        "run",
        "list",
        "run",
      ]);
    });

    describe("batches", () => {
      it("returns one result per call in order, running the listed calls and sending nothing for an unknown one", async () => {
        const { context, calls } = contextWith({
          answer: (request) =>
            Promise.resolve({
              stdout: JSON.stringify({ ok: true, id: request.args[2] }),
              stderr: "",
              exitCode: 0,
            }),
        });
        const output = batched(
          await runCommandTool.invoke(context, {
            calls: [
              { command: "loom.compose", args: { title: "Trip" } },
              { command: "loom.compse", args: {} },
              {
                command: "loom.inspect",
                args: {},
                loomId: "loom-0123456789abcdef",
              },
            ],
          }),
        );
        expect(output.results.map((result) => result.status)).toEqual([
          "executed",
          "unknown_command",
          "executed",
        ]);
        expect(executed(output.results[0]).outcome.id).toBe("loom.compose");
        expect(output.results[1]).toMatchObject({
          suggestions: expect.arrayContaining(["loom.compose"]),
        });
        expect(executed(output.results[2]).outcome.id).toBe("loom.inspect");
        const sequence = output.results.map((result) =>
          Number(result.outputId.split(":").at(-1))
        );
        expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
        expect(new Set(sequence).size).toBe(3);
        expect(calls.map((call) => call.args.slice(1, 3))).toEqual([
          ["list", "--json"],
          ["run", "loom.compose"],
          ["run", "loom.inspect"],
        ]);
      });

      it("returns a call whose answer was lost beside its siblings' answers", async () => {
        const { context } = contextWith({
          answer: (request) =>
            request.args[2] === "loom.inspect"
              ? Promise.reject(new Error("killed"))
              : Promise.resolve({
                stdout: JSON.stringify({ ok: true }),
                stderr: "",
                exitCode: 0,
              }),
        });
        const output = batched(
          await runCommandTool.invoke(context, {
            calls: [
              { command: "loom.compose", args: {} },
              { command: "loom.inspect", args: {} },
              { command: "loom.compose", args: {} },
            ],
          }),
        );
        expect(output.results.map((result) => result.status)).toEqual([
          "executed",
          "failed_to_deliver",
          "executed",
        ]);
        expect(output.results[1]).toMatchObject({ landed: "unknown" });
      });

      it("keeps at most four calls in flight to the host", async () => {
        const total = 6;
        const pending: (() => void)[] = [];
        const fourInFlight = Promise.withResolvers<void>();
        let started = 0;
        let released = false;
        const { context } = contextWith({
          answer: () => {
            started += 1;
            const answer = Promise.withResolvers<ProcessRunResult>();
            const settle = () =>
              answer.resolve({
                stdout: JSON.stringify({ ok: true }),
                stderr: "",
                exitCode: 0,
              });
            if (released) settle();
            else pending.push(settle);
            if (pending.length === 4) fourInFlight.resolve();
            return answer.promise;
          },
        });
        const output = runCommandTool.invoke(context, {
          calls: Array.from(
            { length: total },
            () => ({ command: "loom.compose", args: {} }),
          ),
        });
        await fourInFlight.promise;
        expect(started).toBe(4);
        released = true;
        for (const settle of pending) settle();
        const results = batched(await output).results;
        expect(started).toBe(total);
        expect(results.map((result) => result.status)).toEqual(
          Array(total).fill("executed"),
        );
      });

      it("refuses a batch larger than the limit, and one that also names a lone call, sending nothing", async () => {
        for (
          const [input, code] of [
            [{
              calls: Array.from(
                { length: RUN_COMMAND_BATCH_LIMIT + 1 },
                () => ({ command: "loom.compose", args: {} }),
              ),
            }, "batch_too_large"],
            [{ calls: [] }, "invalid_input"],
            [{
              command: "loom.compose",
              args: {},
              calls: [{ command: "loom.compose", args: {} }],
            }, "invalid_input"],
          ] as const
        ) {
          const { context, calls } = contextWith();
          expect(
            await runCommandTool.invoke(
              context,
              input as unknown as Parameters<typeof runCommandTool.invoke>[1],
            ),
          ).toMatchObject({ status: "failed_to_deliver", code, landed: "no" });
          expect(calls).toHaveLength(0);
        }
      });

      it("runs a batch of the limit's size", async () => {
        const { context, calls } = contextWith();
        const output = batched(
          await runCommandTool.invoke(context, {
            calls: Array.from(
              { length: RUN_COMMAND_BATCH_LIMIT },
              () => ({ command: "loom.compose", args: {} }),
            ),
          }),
        );
        expect(output.results).toHaveLength(RUN_COMMAND_BATCH_LIMIT);
        expect(calls).toHaveLength(RUN_COMMAND_BATCH_LIMIT + 1);
      });

      it("measures the answers against one output bound for the whole batch, leaving out what no longer fits", async () => {
        const rows = Array.from(
          { length: 6 },
          (_, index) => `${index}`.repeat(1_500),
        );
        const { context } = contextWith({
          answer: JSON.stringify({ ok: true, rows }),
        });
        const output = batched(
          await runCommandTool.invoke(context, {
            calls: Array.from(
              { length: 8 },
              () => ({ command: "loom.compose", args: {} }),
            ),
          }),
        );
        const results = output.results.map(executed);
        expect(results[0].entry?.status).toBe("admitted");
        expect(results.at(-1)?.entry).toBeUndefined();
        expect(results.at(-1)?.truncated).toBe(true);
        expect(output.truncated).toBe(true);
        expect(JSON.stringify(output).length).toBeLessThanOrEqual(
          LOOM_RETRIEVAL_MAX_OUTPUT_CHARS,
        );
      });

      it("keeps the batch's model view within the output bound whatever the summaries carry", async () => {
        const { context } = contextWith({
          answer: JSON.stringify({
            ok: false,
            id: "i".repeat(120),
            code: "c".repeat(120),
            completed: Array.from({ length: 32 }, () => "x".repeat(110)),
          }),
        });
        const output = batched(
          await runCommandTool.invoke(context, {
            calls: Array.from(
              { length: RUN_COMMAND_BATCH_LIMIT },
              () => ({ command: "loom.compose", args: {} }),
            ),
          }),
        );
        expect(
          JSON.stringify(runCommandModelView({ ...output }).output).length,
        ).toBeLessThanOrEqual(LOOM_RETRIEVAL_MAX_OUTPUT_CHARS);
        const results = output.results.map(executed);
        expect(results).toHaveLength(RUN_COMMAND_BATCH_LIMIT);
        for (const result of results) {
          expect(result.outcome).not.toHaveProperty("completed");
          expect(result.outcome.completedOmitted).toBe(32);
        }
      });

      it("leaves out a result's hint and keeps the signature a `bad-args` refusal carries", async () => {
        const { context } = contextWith({
          answer: (request) =>
            Promise.resolve({
              stdout: JSON.stringify({
                ok: false,
                code: request.args[2] === "loom.compose"
                  ? "forbidden"
                  : "bad-args",
              }),
              stderr: "",
              exitCode: 0,
            }),
        });
        const [refused, badArgs] = batched(
          await runCommandTool.invoke(context, {
            calls: [
              { command: "loom.compose", args: {} },
              { command: "people-discovery.dossier", args: {} },
            ],
          }),
        ).results.map(executed);
        expect(refused.outcome.code).toBe("not_granted");
        expect(refused).not.toHaveProperty("hint");
        expect(badArgs.signature).toBe(DOSSIER_SIGNATURE);
      });

      it("withholds a call's answer above the ceiling and leaves its label out of the batch's", async () => {
        const { context } = contextWith({
          ceiling: [OWNER],
          answer: (request) =>
            Promise.resolve({
              stdout: JSON.stringify({
                ok: true,
                detail: request.args[2] === "loom.inspect"
                  ? "secret detail"
                  : "plain",
                ifc: {
                  confidentiality: [
                    request.args[2] === "loom.inspect" ? HEALTH : OWNER,
                  ],
                },
              }),
              stderr: "",
              exitCode: 0,
            }),
        });
        const output = batched(
          await runCommandTool.invoke(context, {
            calls: [
              { command: "loom.compose", args: {} },
              { command: "loom.inspect", args: {} },
            ],
          }),
        );
        const [admitted, withheld] = output.results.map(executed);
        expect(admitted.entry?.status).toBe("admitted");
        expect(withheld.entry).toEqual({
          status: "withheld",
          reasonCode: "cfc_ceiling_exceeded",
        });
        expect(JSON.stringify(output)).not.toContain("secret detail");
        expect(output.cfc).toEqual({
          version: 1,
          observedLabel: { confidentiality: [OWNER] },
        });
      });

      it("rejects a call whose configuration became invalid after the catalog was read, rather than reporting an answer lost", async () => {
        for (const batch of [false, true]) {
          const config = freshConfig();
          const { context, calls } = contextWith({ config });
          await listCommandsTool.invoke(context, {});
          config.cliPath = "loom";
          const call = { command: "loom.compose", args: {} };
          await expect(
            runCommandTool.invoke(context, batch ? { calls: [call] } : call),
          ).rejects.toThrow("absolute `cliPath`");
          expect(calls.map((request) => request.args[1])).toEqual(["list"]);
        }
      });

      it("joins the executed calls' labels as the batch's", async () => {
        const { context } = contextWith({
          answer: (request) =>
            Promise.resolve({
              stdout: JSON.stringify({
                ok: true,
                ifc: {
                  confidentiality: [
                    request.args[2] === "loom.inspect" ? HEALTH : OWNER,
                  ],
                },
              }),
              stderr: "",
              exitCode: 0,
            }),
        });
        const output = batched(
          await runCommandTool.invoke(context, {
            calls: [
              { command: "loom.compose", args: {} },
              { command: "loom.inspect", args: {} },
            ],
          }),
        );
        expect(output.cfc.observedLabel?.confidentiality).toEqual([
          OWNER,
          HEALTH,
        ]);
      });
    });

    it("returns an answer that may have landed when the host's answer is lost", async () => {
      const { context } = contextWith({
        answer: () => Promise.reject(new Error("killed")),
      });
      expect(
        await runCommandTool.invoke(context, {
          command: "loom.compose",
          args: {},
        }),
      ).toEqual({
        outputId: expect.any(String),
        status: "failed_to_deliver",
        code: "command_failed",
        reason: "The host command's answer was lost.",
        landed: "unknown",
      });
    });

    it("admits an answer within the ceiling, holds it as a command referent, and reads the outcome's summary", async () => {
      const answer = {
        ok: true,
        id: "loom.compose",
        echo: "/loom.compose Trip",
        outputs: { loom_id: "loom-0123456789abcdef", version: 2 },
        may_have_landed: false,
        completed: ["op-1", 5],
        receipt: { created: true },
      };
      const referents: Record<string, unknown>[] = [];
      const { context, calls } = contextWith({
        answer: JSON.stringify(answer),
        ceiling: [OWNER],
        queryLabel: [OWNER],
        referents,
      });
      const output = executed(
        await runCommandTool.invoke(context, {
          command: "loom.compose",
          args: { title: "Trip" },
          loomId: "loom-0123456789abcdef",
          expectedVersion: 1,
        }),
      );
      expect(output.notice).toBe(LOOM_COMMAND_UNTRUSTED_NOTICE);
      expect(output.outcome).toEqual({
        ok: true,
        id: "loom.compose",
        mayHaveLanded: false,
        completed: ["op-1"],
        bodyBytes: JSON.stringify(answer).length,
      });
      expect(output.entry).toMatchObject({
        status: "admitted",
        value: answer,
        labelSource: "query",
        handle: "cfh:v:33331",
      });
      expect(output.truncated).toBe(false);
      expect(output.hint).toBeUndefined();
      expect(output.cfc).toEqual({
        version: 1,
        observedLabel: { confidentiality: [OWNER] },
      });
      expect(referents).toEqual([{
        source: "run_command",
        value: answer,
        label: { confidentiality: [OWNER], integrity: [] },
        labelSource: "command",
        provenance: {
          command: "loom.compose",
          actor: "agent",
          loomId: "loom-0123456789abcdef",
          version: 2,
        },
      }]);
      expect(calls[1].args.slice(0, 3)).toEqual([
        "command",
        "run",
        "loom.compose",
      ]);
    });

    it("withholds an answer above the ceiling and shows only the outcome's summary", async () => {
      const answer = {
        ok: false,
        code: "version-conflict",
        error: "secret detail",
        ifc: { confidentiality: [HEALTH] },
      };
      const referents: Record<string, unknown>[] = [];
      const { context } = contextWith({
        answer: JSON.stringify(answer),
        ceiling: [OWNER],
        referents,
      });
      const output = executed(
        await runCommandTool.invoke(context, {
          command: "loom.inspect",
          args: {},
        }),
      );
      expect(output.outcome).toEqual({
        ok: false,
        code: "version-conflict",
        bodyBytes: JSON.stringify(answer).length,
      });
      expect(output.entry).toEqual({
        status: "withheld",
        reasonCode: "cfc_ceiling_exceeded",
      });
      expect(JSON.stringify(output)).not.toContain("secret detail");
      expect(output.cfc).toEqual({ version: 1 });
      expect(referents).toEqual([]);
    });

    it("restates the broker's and the command layer's refusals as `not_granted`, keeping the host's code", async () => {
      for (const hostCode of ["forbidden", "refused"]) {
        const { context } = contextWith({
          answer: JSON.stringify({ ok: false, code: hostCode, error: "no" }),
        });
        const output = executed(
          await runCommandTool.invoke(context, {
            command: "loom.compose",
            args: {},
          }),
        );
        expect(output.outcome).toMatchObject({
          ok: false,
          code: "not_granted",
          hostCode,
        });
        expect(output.hint).toContain("`loom.compose`");
      }
    });

    it("keeps a successful answer's own code, and holds a version only when the outputs name a nonnegative integer", async () => {
      const referents: Record<string, unknown>[] = [];
      const { context } = contextWith({
        answer: JSON.stringify({
          ok: true,
          code: "refused",
          outputs: { version: -1 },
        }),
        referents,
      });
      const output = executed(
        await runCommandTool.invoke(context, {
          command: "loom.compose",
          args: {},
        }),
      );
      expect(output.outcome.code).toBe("refused");
      expect(output.hint).toBeUndefined();
      expect(referents[0].provenance).toEqual({
        command: "loom.compose",
        actor: "agent",
      });
    });

    it("cuts the outcome's code and operation ids to an identifier's length, and names at most the limit of them", async () => {
      const long = "c".repeat(HARNESS_COMMAND_ID_MAX_LENGTH + 5);
      const { context } = contextWith({
        answer: JSON.stringify({
          ok: false,
          code: long,
          completed: Array.from(
            { length: LOOM_COMMAND_COMPLETED_LIMIT + 4 },
            () => long,
          ),
        }),
      });
      const output = executed(
        await runCommandTool.invoke(context, {
          command: "loom.compose",
          args: {},
        }),
      );
      expect(output.outcome.code).toHaveLength(HARNESS_COMMAND_ID_MAX_LENGTH);
      expect(output.outcome.completed).toHaveLength(
        LOOM_COMMAND_COMPLETED_LIMIT,
      );
      for (const id of output.outcome.completed ?? []) {
        expect(id).toHaveLength(HARNESS_COMMAND_ID_MAX_LENGTH);
      }
    });

    it("leaves out an answer that alone passes the output bound, marking the result truncated", async () => {
      const { context } = contextWith({
        answer: JSON.stringify({
          ok: true,
          rows: Array.from(
            { length: 40 },
            (_, index) => `${index}`.repeat(1_500),
          ),
        }),
      });
      const output = executed(
        await runCommandTool.invoke(context, {
          command: "loom.compose",
          args: {},
        }),
      );
      expect(output.outcome.bodyBytes).toBeGreaterThan(
        LOOM_RETRIEVAL_MAX_OUTPUT_CHARS,
      );
      expect(output.entry).toBeUndefined();
      expect(output.truncated).toBe(true);
    });
  });

  describe("loomCommandModelContextObservation()", () => {
    const resultRef = {
      toolId: "run_command",
      outputId: createToolOutputId("run-commands", "run_command", 1),
    };

    it("returns the answer's label over the output channel, truncated when the answer was bounded", () => {
      const label = { confidentiality: [OWNER] };
      expect(
        loomCommandModelContextObservation(
          {
            status: "executed",
            truncated: true,
            cfc: { observedLabel: label },
          },
          resultRef,
          "call-1",
        ),
      ).toEqual({
        toolCallId: "call-1",
        toolId: "run_command",
        outputId: resultRef.outputId,
        channels: ["output"],
        label,
        truncated: true,
      });
      expect(
        loomCommandModelContextObservation(
          {
            status: "executed",
            truncated: false,
            cfc: { observedLabel: label },
          },
          resultRef,
          "call-1",
        ),
      ).not.toHaveProperty("truncated");
    });

    it("returns `undefined` for a withheld answer, an undelivered command, or a non-object", () => {
      for (
        const output of [
          { status: "executed", cfc: { version: 1 } },
          { status: "executed" },
          { status: "failed_to_deliver" },
          "text",
        ]
      ) {
        expect(
          loomCommandModelContextObservation(output, resultRef, "call-1"),
        ).toBeUndefined();
      }
    });
  });

  describe("engine wiring", () => {
    it("measures a command's answer against the fabric session's read ceiling", async () => {
      const answer = JSON.stringify({
        ok: true,
        ifc: { confidentiality: [HEALTH] },
      });
      const bounded = engineWith(answer, { ceiling: [OWNER] });
      const { output } = await bounded.engine.invokeBuiltinTool(
        "run_command",
        { command: "loom.compose", args: {} },
      );
      expect(executed(output).entry?.status).toBe("withheld");
      expect(bounded.calls[0].env?.LOOM_PAGE_RPC_QUEUE).toBe("/trusted/queue");
      const unbounded = engineWith(answer);
      const unboundedOutput = await unbounded.engine.invokeBuiltinTool(
        "run_command",
        { command: "loom.compose", args: {} },
      );
      expect(executed(unboundedOutput.output).entry?.status).toBe("admitted");
    });
  });

  describe("prompt loop", () => {
    /**
     * Has the model call `run_command` once under `binding` — `loom.compose`
     * unless `input` says otherwise — then finish.
     */
    const composeOnce = (
      engine: CfHarnessEngine,
      binding: PromptSlotBinding,
      input: RunCommandInput = { command: "loom.compose", args: {} },
    ) => {
      const payloads = [
        {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "run-one",
                type: "function",
                function: {
                  name: "run_command",
                  arguments: JSON.stringify(input),
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
      return new CfHarnessPromptLoop({
        engine,
        apiKey: "synthetic-test-key",
        model: "gpt-5.4",
        allowedToolIds: ["run_command"],
        fetchFn: (_url, init) =>
          Promise.resolve(
            new Response(
              JSON.stringify(
                responsesBodyFromChatFixture(payloads[index++], init?.body),
              ),
              { status: 200 },
            ),
          ),
      }).runPrompt({
        prompt: "Compose the trip loom",
        promptSlotBinding: binding,
      });
    };

    it("runs a command at `enforce-explicit` only for a direct command, refusing one a `context` task asks for", async () => {
      // A request a pattern submitted binds its task as `context`; a person's
      // own request binds as a direct command.
      const context: PromptSlotBinding = {
        type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
        source: { type: "test.prompt-slot", subject: "pattern-request" },
        role: "context",
        kernelName: "cf-harness",
        surface: "test",
        subject: "pattern-request",
        eventId: "event-pattern-request",
      };
      for (
        const [binding, decision, hostCalls] of [
          [context, "denied", []],
          [directPromptSlotBindingFor("loom-commands"), "allowed", [
            "list",
            "run",
          ]],
        ] as const
      ) {
        const { engine, calls } = engineWith(JSON.stringify({ ok: true }), {
          cfcEnforcementMode: "enforce-explicit",
        });
        const result = await composeOnce(engine, binding);
        const record = (result.runState.policyDecisions ?? []).find((entry) =>
          entry.toolId === "run_command"
        );
        expect(record?.decision).toBe(decision);
        expect(calls.map((call) => call.args[1])).toEqual([...hostCalls]);
      }
    });

    it("judges a batch as one write: refused whole for a `context` task, and sent whole for a direct command", async () => {
      const context: PromptSlotBinding = {
        type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
        source: { type: "test.prompt-slot", subject: "pattern-request" },
        role: "context",
        kernelName: "cf-harness",
        surface: "test",
        subject: "pattern-request",
        eventId: "event-pattern-request",
      };
      const input = {
        calls: [
          { command: "loom.compose", args: {} },
          { command: "loom.inspect", args: {} },
        ],
      };
      for (
        const [binding, decisions, hostCalls] of [
          [context, ["denied"], []],
          [directPromptSlotBindingFor("loom-commands"), ["allowed"], [
            "list",
            "run",
            "run",
          ]],
        ] as const
      ) {
        const { engine, calls } = engineWith(JSON.stringify({ ok: true }), {
          cfcEnforcementMode: "enforce-explicit",
        });
        const result = await composeOnce(engine, binding, input);
        expect(
          (result.runState.policyDecisions ?? [])
            .filter((entry) => entry.toolId === "run_command")
            .map((entry) => entry.decision),
        ).toEqual([...decisions]);
        expect(calls.map((call) => call.args[1])).toEqual([...hostCalls]);
      }
    });

    it("shows the model a batch's answers without their labels, and records one observation joining them", async () => {
      const { engine } = engineWith(JSON.stringify({
        ok: true,
        echo: "answered",
        ifc: { confidentiality: [OWNER] },
      }));
      const result = await composeOnce(
        engine,
        directPromptSlotBindingFor("loom-commands"),
        {
          calls: [
            { command: "loom.compose", args: {} },
            { command: "loom.inspect", args: {} },
          ],
        },
      );
      const toolMessage = result.transcript.find((message) =>
        message.role === "tool"
      );
      const shown = JSON.parse(
        (toolMessage as { content: string }).content,
      ) as { status: string; cfc?: unknown; results: { cfc?: unknown }[] };
      expect(shown.status).toBe("batch");
      expect(shown.cfc).toBeUndefined();
      expect(shown.results).toHaveLength(2);
      for (const shownResult of shown.results) {
        expect(shownResult).toMatchObject({ status: "executed" });
        expect(shownResult.cfc).toBeUndefined();
      }
      const observed = engine.getRunState().cfcModelContext;
      expect(observed?.observations.map((entry) => entry.toolId)).toEqual([
        "run_command",
      ]);
      expect(observed?.label).toEqual({ confidentiality: [OWNER] });
    });

    it("shows the model the answer without its label, and records the label as an observation", async () => {
      const { engine, calls } = engineWith(JSON.stringify({
        ok: true,
        echo: "composed the trip loom",
        ifc: { confidentiality: [OWNER] },
      }));
      const payloads = [
        {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "run-one",
                type: "function",
                function: {
                  name: "run_command",
                  arguments: JSON.stringify({
                    command: "loom.compose",
                    args: {},
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
      const requests: string[] = [];
      const loop = new CfHarnessPromptLoop({
        engine,
        apiKey: "synthetic-test-key",
        model: "gpt-5.4",
        allowedToolIds: ["run_command"],
        fetchFn: (_url, init) => {
          requests.push(String(init?.body ?? ""));
          return Promise.resolve(
            new Response(
              JSON.stringify(
                responsesBodyFromChatFixture(payloads[index++], init?.body),
              ),
              { status: 200 },
            ),
          );
        },
      });
      // A write needs direct-command authority under the default
      // `enforce-strict` mode.
      const result = await loop.runPrompt({
        prompt: "Compose the trip loom",
        promptSlotBinding: directPromptSlotBindingFor("loom-commands"),
      });
      expect(calls.map((call) => call.args[1])).toEqual(["list", "run"]);
      const toolMessage = result.transcript.find((message) =>
        message.role === "tool"
      );
      const shown = JSON.parse(
        (toolMessage as { content: string }).content,
      ) as Record<string, unknown>;
      expect(shown.status).toBe("executed");
      expect(shown.cfc).toBeUndefined();
      expect(requests[1]).toContain("composed the trip loom");
      const context = engine.getRunState().cfcModelContext;
      expect(
        context?.observations.map((observation) => observation.toolId),
      ).toEqual(["run_command"]);
      expect(context?.label).toEqual({ confidentiality: [OWNER] });
    });
  });
});

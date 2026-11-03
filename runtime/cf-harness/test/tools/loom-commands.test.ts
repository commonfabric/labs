import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
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
  createHarnessHandleTable,
  mintAddressHandle,
} from "../../src/handle-table.ts";
import {
  createLoomCommandCatalogSource,
  type HarnessLoomCommandsConfig,
} from "../../src/loom-commands.ts";
import { CfHarnessPromptLoop } from "../../src/prompt-loop.ts";
import type { ProcessRunRequest } from "../../src/sandbox/process-runner.ts";
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
import {
  type CommandHost,
  type CommandHostAnswers,
  startCommandHost,
} from "../support/command-host.ts";
import { directPromptSlotBindingFor } from "../support/prompt-slot-binding.ts";
import { responsesBodyFromChatFixture } from "../support/responses-fixture.ts";

const OWNER = "https://cfc.test/atom/owner";
const HEALTH = "https://cfc.test/atom/facet/health";

/** A host configuration whose endpoint is `url`. */
const configFor = (url: string): HarnessLoomCommandsConfig => ({
  url,
  actor: "agent:agent-runner",
  runId: "job-1",
});

/**
 * The stub host every run in this file reaches, started once for the file.
 * Each fixture sets how it answers and clears what it received, so a
 * fixture's `calls` hold only the requests made since it was built.
 */
let host: CommandHost;

/** How the stub host answers, as the latest fixture set it. */
let answers: Required<CommandHostAnswers>;

/** How a stub host answers `POST /command`: one text, or per call. */
type Answer =
  | string
  | ((call: { id: string }) => Response | Promise<Response>);

/** Helper for fixtures, which answers one posted call with `answer`. */
const answerTo = (answer: Answer | undefined, body: unknown) =>
  typeof answer === "function"
    ? answer(body as { id: string })
    : new Response(answer ?? JSON.stringify({ ok: true }));

/** Helper for tests, which reads the command id a request posted. */
const idOf = (body: unknown): unknown => (body as { id?: unknown }).id;

/** The manifest the stub host lists for this caller. */
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

/**
 * Helper for tests, which answers `GET /commands` and `POST /command` apart,
 * and returns a tool context over the host, what the host received, and the
 * configuration the context holds.
 */
const contextWith = (
  options: {
    manifest?: string;
    answer?: Answer;
    configured?: boolean;
    aborted?: boolean;
    cancelDuringListing?: boolean;
    ceiling?: readonly unknown[];
    queryLabel?: unknown[];
    referents?: Record<string, unknown>[];
  } = {},
): {
  context: HarnessToolContext;
  calls: CommandHost["requests"];
  config: HarnessLoomCommandsConfig;
} => {
  const controller = new AbortController();
  if (options.aborted === true) controller.abort();
  let outputs = 0;
  host.requests.length = 0;
  answers = {
    list: () => {
      if (options.cancelDuringListing) controller.abort();
      return new Response(options.manifest ?? JSON.stringify(MANIFEST));
    },
    run: (body) => answerTo(options.answer, body),
  };
  const config = configFor(host.url);
  const context: Partial<HarnessToolContext> = {
    nextOutputId: (toolId: string) =>
      createToolOutputId("run-commands", toolId, ++outputs),
    // The engine holds one catalog source for the run, as here.
    ...(options.configured === false ? {} : {
      loomCommands: config,
      loomCommandCatalog: createLoomCommandCatalogSource(config),
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
  return {
    context: context as HarnessToolContext,
    calls: host.requests,
    config,
  };
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

/**
 * Helper for engine tests, which answers list and run like `contextWith`, and
 * records every process the engine starts on the host, refusing it.
 */
const engineWith = (
  answer: string,
  options: {
    ceiling?: readonly unknown[];
    cfcEnforcementMode?: CfcEnforcementMode;
    manifest?: () => string;
  } = {},
) => {
  const processes: ProcessRunRequest[] = [];
  host.requests.length = 0;
  answers = {
    list: () => new Response(options.manifest?.() ?? JSON.stringify(MANIFEST)),
    run: () => new Response(answer),
  };
  const engine = new CfHarnessEngine({
    model: "gpt-5.4",
    sandboxRuntime: sandbox,
    loomCommands: configFor(host.url),
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
        processes.push(request);
        return Promise.reject(new Error("No host process may start."));
      },
    },
  });
  return { engine, calls: host.requests, processes };
};

describe("loom-commands tools", () => {
  beforeAll(() => {
    host = startCommandHost({
      list: (request) => answers.list(request),
      run: (body, request) => answers.run(body, request),
    });
  });

  afterAll(async () => {
    await host[Symbol.asyncDispose]();
  });

  describe("availability", () => {
    /** Backing with everything but the command endpoint switched off. */
    const backing = {
      fabricSessionAvailable: false,
      patternIndexAvailable: false,
      skillsShSearchAvailable: false,
      skillsShAcquisitionAvailable: false,
      skillRegistryAvailable: false,
      docsCorpusAvailable: false,
    };

    it("classifies the command tools by their authority", () => {
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

    it("withholds the tools without a host command endpoint and offers them with one", () => {
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
        harnessSessionToolBacking({
          ...base,
          loomCommands: configFor("http://127.0.0.1:1"),
        })
          .loomCommandsAvailable,
      ).toBe(true);
    });

    it("offers `run_command` an input schema with no top-level combinator, which some providers refuse", () => {
      const schema = getBuiltinTool("run_command")?.descriptor.inputSchema;
      for (const keyword of ["oneOf", "anyOf", "allOf", "not"]) {
        expect(schema).not.toHaveProperty(keyword);
      }
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
    it("returns an error without sending a request when the run has no configuration", async () => {
      const { context, calls } = contextWith({ configured: false });
      expect(await listCommandsTool.invoke(context, {})).toMatchObject({
        status: "error",
        code: "not_configured",
      });
      expect(calls).toHaveLength(0);
    });

    it("returns an error without sending a request once the turn is cancelled", async () => {
      const { context, calls } = contextWith({ aborted: true });
      expect(await listCommandsTool.invoke(context, {})).toMatchObject({
        status: "error",
        code: "cancelled",
      });
      expect(calls).toHaveLength(0);
    });

    it("relays a host failure as a typed error", async () => {
      const { context } = contextWith({ manifest: "Error: no host" });
      expect(await listCommandsTool.invoke(context, {})).toMatchObject({
        status: "error",
        code: "command_failed",
      });
    });

    it("shows external effects in model-facing signatures", async () => {
      const { context } = contextWith({
        manifest: JSON.stringify({
          commands: [{ id: "message.send", effect: "external" }],
        }),
      });
      const output = listed(await listCommandsTool.invoke(context, {}));
      expect(output.entries[0].signature).toContain("[external, global]");
    });

    it("returns the commands the host listed and the effect notice", async () => {
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

    it("shows the commands the host names as relevant first, marked, and keeps every other command", async () => {
      const { context, config } = contextWith();
      config.relevant = ["people-discovery.dossier", "not.listed"];
      const output = listed(await listCommandsTool.invoke(context, {}));
      expect(output.entries.map((entry) => [entry.name, entry.relevant]))
        .toEqual([
          ["people-discovery.dossier", true],
          ["loom.compose", undefined],
          ["loom.inspect", undefined],
        ]);
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
    it("returns an error without sending a request when the run has no configuration", async () => {
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

    it("refuses malformed input before sending a request", async () => {
      const inputs = [
        {},
        { args: {} },
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

    it("refuses args whose resolved handles exceed the contract's bound before posting", async () => {
      const { context, calls } = contextWith();
      const minted = await mintAddressHandle(
        createHarnessHandleTable("expanded-args"),
        "/of:fid1:" + "a".repeat(43),
      );
      const args = {
        text: minted.token + " ".repeat(
          HARNESS_COMMAND_ARGS_MAX_BYTES - minted.token.length - 11,
        ),
      };
      expect(JSON.stringify(args).length).toBe(HARNESS_COMMAND_ARGS_MAX_BYTES);
      const output = await runCommandTool.invoke({
        ...context,
        handleTable: minted.table,
      }, {
        command: "loom.inspect",
        args,
      });
      expect(output).toMatchObject({
        status: "failed_to_deliver",
        code: "invalid_input",
      });
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    });

    it("preserves own prototype-named keys while resolving component arguments", async () => {
      const { context, calls } = contextWith();
      const args = JSON.parse(
        '{"__proto__":{"retained":true},"title":"cfh:ordinary"}',
      );
      const output = await runCommandTool.invoke(context, {
        command: "loom.compose",
        args,
      });
      expect(output.status).toBe("executed");
      expect(JSON.stringify(calls.at(-1)?.body)).toContain(
        '"__proto__":{"retained":true}',
      );
    });

    it("reports a failed Fabric session read without blaming a held reference", async () => {
      const { context, calls } = contextWith();
      const minted = await mintAddressHandle(
        createHarnessHandleTable("session-read"),
        "/of:fid1:" + "a".repeat(43),
      );
      const output = await runCommandTool.invoke({
        ...context,
        handleTable: minted.table,
        getFabricSession: () =>
          Promise.reject(new Error("private session failure")),
      }, {
        command: "loom.compose",
        args: { components: [{ ref: minted.token }] },
      });
      expect(output).toMatchObject({
        status: "failed_to_deliver",
        code: "command_failed",
      });
      expect(JSON.stringify(output)).not.toContain("private session failure");
      expect(JSON.stringify(output)).not.toContain("source.read");
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    });

    it("refuses args larger than the contract's bound before sending a request", async () => {
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

    it("ends only the cancelled caller's wait on a catalog read another caller shares", async () => {
      for (const cancelled of ["first", "second"] as const) {
        const first = contextWith();
        const second = contextWith();
        const listing = Promise.withResolvers<Response>();
        answers.list = () => listing.promise;
        // Both callers wait on the one read the run holds.
        const signals = [new AbortController(), new AbortController()];
        Object.assign(first.context, { signal: signals[0].signal });
        Object.assign(second.context, {
          signal: signals[1].signal,
          loomCommandCatalog: first.context.loomCommandCatalog,
        });
        const call = { command: "loom.compose", args: {} };
        const pending = [
          runCommandTool.invoke(first.context, call),
          runCommandTool.invoke(second.context, call),
        ];
        signals[cancelled === "first" ? 0 : 1].abort();
        listing.resolve(new Response(JSON.stringify(MANIFEST)));
        const [one, two] = await Promise.all(pending);
        const [gone, kept] = cancelled === "first" ? [one, two] : [two, one];
        expect(gone).toMatchObject({
          status: "failed_to_deliver",
          code: "cancelled",
          landed: "no",
        });
        expect(kept).toMatchObject({ status: "executed" });
        expect(host.requests.map((request) => request.path)).toEqual([
          "/commands",
          "/command",
        ]);
      }
    });

    it("does not dispatch after cancellation while the fresh catalog is loading", async () => {
      const { context, calls } = contextWith({
        cancelDuringListing: true,
        manifest: JSON.stringify({
          commands: [{
            id: "loom.inspect",
            effect: "read",
            inputs: { type: "object" },
          }],
        }),
      });
      expect(
        await runCommandTool.invoke(context, {
          command: "loom.inspect",
          args: {},
        }),
      ).toMatchObject({
        status: "failed_to_deliver",
        code: "cancelled",
        landed: "no",
      });
      expect(calls.map((call) => call.path)).toEqual(["/commands"]);
    });

    it("returns an error without sending a request once the turn is cancelled", async () => {
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
      expect(calls.map((call) => call.path)).toEqual(["/commands"]);
    });

    it("sends an unlisted command to the host for admission", async () => {
      const { context, calls } = contextWith({
        answer: () => Response.json({ ok: false, code: "refused" }),
      });
      const output = await runCommandTool.invoke(context, {
        command: "share.invite",
        args: {},
      });
      expect(executed(output).outcome.code).toBe("not_granted");
      expect(calls.map((call) => call.path)).toEqual(["/commands", "/command"]);
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
      expect(calls.map((call) => call.path)).toEqual([
        "/commands",
        "/command",
        "/command",
        "/commands",
        "/command",
      ]);
    });

    describe("batches", () => {
      it("returns one result per call in order, sending unlisted names to the host", async () => {
        const { context, calls } = contextWith({
          answer: ({ id }) => Response.json({ ok: true, id }),
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
          "executed",
          "executed",
        ]);
        expect(executed(output.results[0]).outcome.id).toBe("loom.compose");
        expect(executed(output.results[1]).outcome.id).toBe("loom.compse");
        expect(executed(output.results[2]).outcome.id).toBe("loom.inspect");
        const sequence = output.results.map((result) =>
          Number(result.outputId.split(":").at(-1))
        );
        expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
        expect(new Set(sequence).size).toBe(3);
        expect(calls.map((call) => [call.path, call.body && idOf(call.body)]))
          .toEqual([
            ["/commands", undefined],
            ["/command", "loom.compose"],
            ["/command", "loom.compse"],
            ["/command", "loom.inspect"],
          ]);
      });

      it("returns a call whose answer was lost beside its siblings' answers", async () => {
        const { context } = contextWith({
          answer: ({ id }) =>
            id === "loom.inspect"
              ? new Response("killed", { status: 502 })
              : Response.json({ ok: true }),
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
            const answer = Promise.withResolvers<Response>();
            const settle = () => answer.resolve(Response.json({ ok: true }));
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

      it("shrinks later calls' summaries when their escaped size would pass the bound", async () => {
        const control = String.fromCharCode(0).repeat(128);
        const { context } = contextWith({
          manifest: JSON.stringify({
            commands: [{
              id: "loom.compose",
              inputs: { type: "object" },
              outputs: [control, control, control],
            }],
          }),
          answer: JSON.stringify({ ok: false, code: "bad-args", id: control }),
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
        expect(results[0].signature).toBeDefined();
        expect(results.at(-1)?.signature).toBeUndefined();
        for (const result of results) {
          expect(result.outcome).toMatchObject({ ok: false, code: "bad-args" });
        }
      });

      it("keeps every `bad-args` signature in a batch whose summaries fit", async () => {
        const { context } = contextWith({
          answer: JSON.stringify({ ok: false, code: "bad-args" }),
        });
        const output = batched(
          await runCommandTool.invoke(context, {
            calls: Array.from(
              { length: RUN_COMMAND_BATCH_LIMIT },
              () => ({ command: "people-discovery.dossier", args: {} }),
            ),
          }),
        );
        for (const result of output.results.map(executed)) {
          expect(result.signature).toBe(DOSSIER_SIGNATURE);
          expect(result).not.toHaveProperty("summaryOmitted");
        }
      });

      it("leaves out a result's hint and keeps the signature a `bad-args` refusal carries", async () => {
        const { context } = contextWith({
          answer: ({ id }) =>
            Response.json({
              ok: false,
              code: id === "loom.compose" ? "forbidden" : "bad-args",
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
          answer: ({ id }) =>
            Response.json({
              ok: true,
              detail: id === "loom.inspect" ? "secret detail" : "plain",
              ifc: {
                confidentiality: [id === "loom.inspect" ? HEALTH : OWNER],
              },
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
          const { context, calls, config } = contextWith();
          await listCommandsTool.invoke(context, {});
          config.url = "loom";
          const call = { command: "loom.compose", args: {} };
          await expect(
            runCommandTool.invoke(context, batch ? { calls: [call] } : call),
          ).rejects.toThrow("endpoint");
          expect(calls.map((request) => request.path)).toEqual(["/commands"]);
        }
      });

      it("joins the executed calls' labels as the batch's", async () => {
        const { context } = contextWith({
          answer: ({ id }) =>
            Response.json({
              ok: true,
              ifc: {
                confidentiality: [id === "loom.inspect" ? HEALTH : OWNER],
              },
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
        answer: () => new Response("killed", { status: 502 }),
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
      expect(calls[1]).toEqual({
        method: "POST",
        path: "/command",
        runId: "job-1",
        body: {
          id: "loom.compose",
          args: { title: "Trip" },
          context: { loom_id: "loom-0123456789abcdef", expected_version: 1 },
          actor: "agent:agent-runner",
        },
      });
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

    it("restates the host's and the command layer's refusals as `not_granted`, keeping the host's code", async () => {
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
      expect(bounded.calls[0].runId).toBe("job-1");
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
      binding: PromptSlotBinding | undefined,
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

    it("admits declared reads from context tasks and gates other effects", async () => {
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
        const effect of ["read", "write", "external", "unknown", undefined]
      ) {
        for (
          const binding of [
            undefined,
            context,
            directPromptSlotBindingFor("loom-commands"),
          ]
        ) {
          const allowed = binding?.role === "direct-command" ||
            effect === "read";
          const { engine, calls } = engineWith(JSON.stringify({ ok: true }), {
            cfcEnforcementMode: "enforce-explicit",
            manifest: () =>
              JSON.stringify({ commands: [{ id: "loom.compose", effect }] }),
          });
          const result = await composeOnce(engine, binding);
          const record = (result.runState.policyDecisions ?? []).find((entry) =>
            entry.toolId === "run_command"
          );
          expect(record?.decision).toBe(allowed ? "allowed" : "denied");
          expect(record?.effectClass).toBe(
            effect === "read"
              ? "read"
              : effect === "external"
              ? "side-effect"
              : "write",
          );
          expect(calls.map((call) => call.path)).toEqual(
            allowed ? ["/commands", "/command"] : ["/commands"],
          );
        }
      }
    });

    it("requires a direct binding for reads under enforce-strict", async () => {
      for (
        const binding of [
          undefined,
          directPromptSlotBindingFor("loom-commands"),
        ]
      ) {
        const { engine, calls } = engineWith(JSON.stringify({ ok: true }), {
          cfcEnforcementMode: "enforce-strict",
          manifest: () =>
            JSON.stringify({
              commands: [{ id: "loom.compose", effect: "read" }],
            }),
        });
        const result = await composeOnce(engine, binding);
        expect(
          result.runState.policyDecisions?.find((entry) =>
            entry.toolId === "run_command"
          )?.decision,
        )
          .toBe(binding === undefined ? "denied" : "allowed");
        expect(calls.map((call) => call.path)).toEqual(
          binding === undefined ? ["/commands"] : ["/commands", "/command"],
        );
      }
    });

    it("admits read batches from context tasks and gates mixed batches", async () => {
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
      for (const effect of ["read", "write", "external", undefined]) {
        for (
          const binding of [
            undefined,
            context,
            directPromptSlotBindingFor("loom-commands"),
          ]
        ) {
          const allowed = binding?.role === "direct-command" ||
            effect === "read";
          const { engine, calls } = engineWith(JSON.stringify({ ok: true }), {
            cfcEnforcementMode: "enforce-explicit",
            manifest: () =>
              JSON.stringify({
                commands: [
                  { id: "loom.compose", effect },
                  { id: "loom.inspect", effect: "read" },
                ],
              }),
          });
          const result = await composeOnce(engine, binding, input);
          expect(
            (result.runState.policyDecisions ?? [])
              .filter((entry) => entry.toolId === "run_command")
              .map((entry) => entry.decision),
          ).toEqual([allowed ? "allowed" : "denied"]);
          expect(calls.map((call) => call.path)).toEqual(
            allowed ? ["/commands", "/command", "/command"] : ["/commands"],
          );
        }
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
      expect(calls.map((call) => call.path)).toEqual(["/commands", "/command"]);
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

    it("runs a command over the host's endpoint without starting a process", async () => {
      // No `loom` executable and no CLI configuration: the engine's host
      // process runner refuses every process, and the call still lands.
      const { engine, calls, processes } = engineWith(
        JSON.stringify({ ok: true, id: "loom.compose" }),
      );
      const result = await composeOnce(
        engine,
        directPromptSlotBindingFor("loom-commands"),
      );
      expect(processes).toEqual([]);
      expect(calls).toEqual([
        { method: "GET", path: "/commands", runId: "job-1" },
        {
          method: "POST",
          path: "/command",
          runId: "job-1",
          body: { id: "loom.compose", args: {}, actor: "agent:agent-runner" },
        },
      ]);
      const toolMessage = result.transcript.find((message) =>
        message.role === "tool"
      );
      expect(JSON.parse((toolMessage as { content: string }).content))
        .toMatchObject({ status: "executed", outcome: { ok: true } });
    });

    it("sends the host's run id and actor whatever the model's args name", async () => {
      const forged = {
        "X-Loom-Agent-Run-Id": "job-forged",
        runId: "job-forged",
        actor: "user:forged",
      };
      const { engine, calls } = engineWith(JSON.stringify({ ok: true }));
      await composeOnce(engine, directPromptSlotBindingFor("loom-commands"), {
        command: "loom.compose",
        args: forged,
      });
      expect(calls.map((call) => call.runId)).toEqual(["job-1", "job-1"]);
      expect(calls[1].body).toEqual({
        id: "loom.compose",
        args: forged,
        actor: "agent:agent-runner",
      });
    });

    it("posts only the id, args, context and configured actor, dropping any other field a call names", async () => {
      const smuggled = {
        consent: { grant: "forged" },
        rest: "forged rest",
        router_nonce: "forged-nonce",
        actor: "user:forged",
        context: { loom_id: "loom-ffffffffffffffff" },
        invocation: { origin: "pill" },
        read_only: false,
      };
      const call = {
        command: "loom.inspect",
        args: { section: "a" },
        loomId: "loom-0123456789abcdef",
        expectedVersion: 2,
        ...smuggled,
      } as unknown as RunCommandInput;
      const expected = {
        id: "loom.inspect",
        args: { section: "a" },
        context: { loom_id: "loom-0123456789abcdef", expected_version: 2 },
        actor: "agent:agent-runner",
      };
      for (const input of [call, { calls: [call] } as RunCommandInput]) {
        const { context, calls } = contextWith();
        await runCommandTool.invoke(context, input);
        expect(calls.filter((request) => request.path === "/command"))
          .toEqual([{
            method: "POST",
            path: "/command",
            runId: "job-1",
            body: expected,
          }]);
      }
    });
  });
});

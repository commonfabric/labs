import { expect } from "@std/expect";
import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import {
  afterAll,
  beforeAll,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { createCfHarnessCliCapabilities } from "../../src/cli.ts";
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
import { HARNESS_CFC_MODEL_CONTEXT_READ_MAX_BYTES } from "../../src/contracts/cfc-model-context.ts";
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
import type {
  HarnessToolContext,
  HarnessToolDefinition,
} from "../../src/tools/types.ts";
import {
  type CommandHost,
  type CommandHostAnswers,
  startCommandHost,
} from "../support/command-host.ts";
import { directPromptSlotBindingFor } from "../support/prompt-slot-binding.ts";
import { responsesBodyFromChatFixture } from "../support/responses-fixture.ts";

const OWNER = "https://cfc.test/atom/owner";
const HEALTH = "https://cfc.test/atom/facet/health";
const VOUCHED = "https://cfc.test/atom/vouched";

/** A read the host declares, of `ref` at `revision` under `confidentiality`. */
const readOf = (
  ref: string,
  revision: string | null,
  confidentiality: readonly unknown[],
  details: Record<string, unknown> = {},
) => ({
  ref,
  revision,
  coverage: revision === null
    ? { kind: "body", revisionScope: "none" }
    : { kind: "body", pages: [1] },
  ifc: { confidentiality: [...confidentiality] },
  ...details,
});

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

/**
 * A copy of `context` whose catalog source records each read before passing
 * it on, and the reads asked of it.
 */
const askedOf = (
  context: HarnessToolContext,
): { context: HarnessToolContext; asked: string[] } => {
  const asked: string[] = [];
  const source = context.loomCommandCatalog;
  if (source === undefined) throw new Error("the context holds no catalog");
  return {
    context: {
      ...context,
      loomCommandCatalog: {
        current: () => (asked.push("current"), source.current()),
        refresh: () => (asked.push("refresh"), source.refresh()),
      },
    },
    asked,
  };
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
      expect(getBuiltinTool("list_commands")).toBe(listCommandsTool);
      expect(getBuiltinTool("run_command")).toBe(runCommandTool);
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

    it("returns a cancellation when the turn is cancelled during the host call", async () => {
      const { context, calls } = contextWith({ cancelDuringListing: true });
      const output = await listCommandsTool.invoke(context, {});
      expect(output).toMatchObject({
        status: "error",
        code: "cancelled",
        message: "The turn was cancelled during the host call.",
      });
      expect(calls.map((call) => call.path)).toEqual(["/commands"]);
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

    it("returns descriptions only for commands named in `detail`", async () => {
      const { context } = contextWith();
      const plain = listed(await listCommandsTool.invoke(context, {}));
      expect(plain.entries[0]).not.toHaveProperty("description");
      const detailed = listed(
        await listCommandsTool.invoke(context, { detail: ["loom.compose"] }),
      );
      expect(detailed.entries[0]).toMatchObject({
        description: "Creates or extends a loom.",
      });
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

    it("keeps every signature in a large catalog and details only for named commands", async () => {
      const help = "h".repeat(4_000);
      const rows = Array.from({ length: 500 }, (_, index) => ({
        id: `cmd.n${index}`,
        help,
        title: help,
        inputs: { type: "object" },
      }));
      const { context } = contextWith({
        manifest: JSON.stringify({ commands: rows }),
      });
      const output = listed(
        await listCommandsTool.invoke(context, { detail: ["cmd.n499"] }),
      );
      expect(output.entries).toHaveLength(rows.length);
      expect(output).not.toHaveProperty("compacted");
      const last = output.entries.at(-1)!;
      expect(last.name).toBe("cmd.n499");
      expect("description" in last).toBe(true);
      expect("inputSchema" in last).toBe(true);
      const summary = output.entries.at(-2)!;
      expect("description" in summary).toBe(false);
      expect(summary.signature).toBe("cmd.n498(...)  [global]");
    });
  });

  describe("runCommandTool", () => {
    // The tool as the registry holds it, which takes whatever input a model
    // sent, as the engine passes it.
    const untypedRunCommandTool: HarnessToolDefinition = runCommandTool;

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

    it("delivers a full artifact preflight without trimming its HTML", async () => {
      const page = "<!doctype html><html><body>" +
        '<p>Evidence, alternatives, and limits: "résumé" 🧶.</p>\n'.repeat(
          4_000,
        ) +
        "</body></html>";
      const args = {
        candidate: {
          entries: [{
            title: "Research dossier",
            artifact: { page, components: { lists: [], notes: false } },
          }],
          nothing_because: null,
        },
      };
      const { context, calls } = contextWith({
        manifest: JSON.stringify({
          ...MANIFEST,
          commands: [{
            id: "preparation.check-preparation",
            title: "Validate a prepared artifact.",
            scope: "global",
            effect: "read",
            inputs: { type: "object" },
          }],
        }),
      });
      const output = await runCommandTool.invoke(context, {
        command: "preparation.check-preparation",
        args,
      });
      expect(output.status).toBe("executed");
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
      expect(calls.at(-1)?.body).toMatchObject({
        id: "preparation.check-preparation",
        args,
      });
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
          await untypedRunCommandTool.invoke(context, input),
        ).toMatchObject({
          status: "failed_to_deliver",
          code: "invalid_input",
          landed: "no",
        });
        expect(calls).toHaveLength(0);
      }
    });

    it("refuses input that is not an object before sending a request", async () => {
      for (const input of ["loom.compose", null, ["loom.compose"]]) {
        const { context, calls } = contextWith();
        expect(
          await untypedRunCommandTool.invoke(context, input),
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

    it("starts no further piece checks once the turn is cancelled", async () => {
      const space =
        "did:key:z6MkpiecesAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const ids = Array.from(
        { length: 20 },
        (_, index) => `fid1:${String(index).padStart(43, "C")}`,
      );
      const controller = new AbortController();
      const { context } = contextWith({
        answer: JSON.stringify({
          ok: true,
          id: "loom.inspect",
          result: {
            components: ids.map((id) => ({ ref: `pattern:${space}/${id}` })),
          },
        }),
      });
      let reads = 0;
      await runCommandTool.invoke({
        ...context,
        signal: controller.signal,
        getFabricSession: () => {
          reads += 1;
          controller.abort();
          return Promise.reject(new Error("cancelled read"));
        },
      }, { command: "loom.inspect", args: {} });
      // the first window of checks may already be under way; none after it
      expect(reads).toBeGreaterThan(0);
      expect(reads).toBeLessThan(ids.length);
    });

    it("refuses a component reference to a token the run does not hold, before posting", async () => {
      const { context, calls } = contextWith();
      const output = await runCommandTool.invoke({
        ...context,
        handleTable: createHarnessHandleTable("unheld-component"),
      }, {
        command: "loom.compose",
        args: { components: [{ ref: "cfh:a:zzzzz" }] },
      });
      expect(output).toMatchObject({
        status: "failed_to_deliver",
        code: "invalid_input",
        landed: "no",
        reason: expect.stringContaining(
          "Use the ref returned by run_pattern or assign_slug",
        ),
      });
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
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
        const { context } = contextWith();
        const listing = Promise.withResolvers<Response>();
        answers.list = () => listing.promise;
        // Both callers wait on the one read the run holds.
        const signals = [new AbortController(), new AbortController()];
        const call = { command: "loom.compose", args: {} };
        const pending = signals.map(({ signal }) =>
          runCommandTool.invoke({ ...context, signal }, call)
        );
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
      const { context: unwatched, calls } = contextWith({ aborted: true });
      const { context, asked } = askedOf(unwatched);
      expect(
        await runCommandTool.invoke(context, {
          command: "loom.compose",
          args: {},
        }),
      ).toMatchObject({ status: "failed_to_deliver", code: "cancelled" });
      expect(calls).toHaveLength(0);
      // Nor is the host asked for its catalog, which would otherwise land
      // after the answer.
      expect(asked).toEqual([]);
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

      it("returns `invalid_input` for a malformed call beside its siblings' answers, sending only theirs", async () => {
        const { context, calls } = contextWith({
          answer: ({ id }) => Response.json({ ok: true, id }),
        });
        const output = batched(
          await runCommandTool.invoke(context, {
            calls: [
              { command: "loom.compose", args: {} },
              { command: "-bad", args: {} },
            ],
          }),
        );
        expect(output.results.map((result) => result.status)).toEqual([
          "executed",
          "failed_to_deliver",
        ]);
        expect(output.results[1]).toMatchObject({
          code: "invalid_input",
          landed: "no",
        });
        expect(calls.map((call) => call.body && idOf(call.body))).toEqual([
          undefined,
          "loom.compose",
        ]);
      });

      it("refuses a batch without running any call when the host's list cannot be read", async () => {
        const { context, calls } = contextWith({ manifest: "[]" });
        expect(
          await runCommandTool.invoke(context, {
            calls: [{ command: "loom.compose", args: {} }],
          }),
        ).toMatchObject({
          status: "failed_to_deliver",
          code: "malformed_payload",
          landed: "no",
        });
        expect(calls.map((call) => call.path)).toEqual(["/commands"]);
      });

      it("sends no call that would start after the turn is cancelled", async () => {
        // Four calls start at once and the host holds their answers until the
        // fourth arrives, then cancels the turn and answers all four, so the
        // fifth, which waits for one of them to finish, is never sent.
        const controller = new AbortController();
        const held: (() => void)[] = [];
        const { context, calls } = contextWith({
          answer: () => {
            const answer = Promise.withResolvers<Response>();
            held.push(() => answer.resolve(Response.json({ ok: true })));
            if (held.length === 4) {
              controller.abort();
              for (const release of held) release();
            }
            return answer.promise;
          },
        });
        const output = batched(
          await runCommandTool.invoke({
            ...context,
            signal: controller.signal,
          }, {
            calls: Array.from(
              { length: 5 },
              () => ({ command: "loom.inspect", args: {} }),
            ),
          }),
        );
        expect(output.results[4]).toMatchObject({
          status: "failed_to_deliver",
          code: "cancelled",
          landed: "no",
        });
        expect(calls.filter((call) => call.path === "/command")).toHaveLength(
          4,
        );
      });

      it("returns `cancelled` without reading the Fabric session for calls with held or unheld references that start after the turn is cancelled", async () => {
        // As above, the turn is cancelled while four calls are in flight. The
        // fifth carries a held reference, which would otherwise be read from
        // the Fabric session, and the sixth a reference the run does not
        // hold, which would otherwise be refused as `invalid_input`.
        const controller = new AbortController();
        const held: (() => void)[] = [];
        const { context, calls } = contextWith({
          answer: () => {
            const answer = Promise.withResolvers<Response>();
            held.push(() => answer.resolve(Response.json({ ok: true })));
            if (held.length === 4) {
              controller.abort();
              for (const release of held) release();
            }
            return answer.promise;
          },
        });
        const minted = await mintAddressHandle(
          createHarnessHandleTable("cancelled-batch"),
          "/of:fid1:" + "a".repeat(43),
        );
        let sessionReads = 0;
        const output = batched(
          await runCommandTool.invoke({
            ...context,
            signal: controller.signal,
            handleTable: minted.table,
            getFabricSession: () => {
              sessionReads += 1;
              return Promise.reject(new Error("no session in this test"));
            },
          }, {
            calls: [
              ...Array.from(
                { length: 4 },
                () => ({ command: "loom.inspect", args: {} }),
              ),
              {
                command: "loom.compose",
                args: { components: [{ ref: minted.token }] },
              },
              {
                command: "loom.compose",
                args: { components: [{ ref: "cfh:a:zzzzz" }] },
              },
            ],
          }),
        );
        for (const result of output.results.slice(4)) {
          expect(result).toMatchObject({
            status: "failed_to_deliver",
            code: "cancelled",
            landed: "no",
          });
        }
        expect(sessionReads).toBe(0);
        expect(calls.filter((call) => call.path === "/command")).toHaveLength(
          4,
        );
      });

      it("returns `cancelled` without sending a call whose references were being read when the turn is cancelled", async () => {
        // Both calls start at once. The first reads its arguments for held
        // references, and the second's read of the Fabric session cancels
        // the turn before the first's read ends.
        const controller = new AbortController();
        const { context, calls } = contextWith();
        const minted = await mintAddressHandle(
          createHarnessHandleTable("cancelled-during-read"),
          "/of:fid1:" + "a".repeat(43),
        );
        const output = batched(
          await runCommandTool.invoke({
            ...context,
            signal: controller.signal,
            handleTable: minted.table,
            getFabricSession: () => {
              controller.abort();
              return Promise.reject(new Error("no session in this test"));
            },
          }, {
            calls: [
              { command: "loom.compose", args: { title: "cfh:ordinary" } },
              {
                command: "loom.compose",
                args: { components: [{ ref: minted.token }] },
              },
            ],
          }),
        );
        expect(output.results[0]).toMatchObject({
          status: "failed_to_deliver",
          code: "cancelled",
          landed: "no",
        });
        expect(calls.filter((call) => call.path === "/command")).toHaveLength(
          0,
        );
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
        expect(results.at(-1)?.hint).toBe(
          "The result body was omitted to fit the tool output limit. No requested values are shown. Read a smaller date range, fewer results, or a smaller batch.",
        );
        expect(results.at(-1)?.truncated).toBe(true);
        expect(output.truncated).toBe(true);
        expect(JSON.stringify(output).length).toBeLessThanOrEqual(
          LOOM_RETRIEVAL_MAX_OUTPUT_CHARS,
        );
      });

      it("keeps a fitting answer beside failed siblings without reserving their omission hints", async () => {
        const answer = {
          ok: true,
          rows: Array.from({ length: 11 }, () => "x".repeat(3_900)),
        };
        const { context } = contextWith({
          answer: ({ id }) =>
            id === "loom.compose"
              ? Response.json(answer)
              : new Response("unavailable", { status: 502 }),
        });
        const output = batched(
          await runCommandTool.invoke(context, {
            calls: [
              ...Array.from(
                { length: 8 },
                () => ({ command: "loom.inspect", args: {} }),
              ),
              { command: "loom.compose", args: {} },
            ],
          }),
        );
        expect(
          output.results.slice(0, 8).every((result) =>
            result.status === "failed_to_deliver"
          ),
        ).toBe(true);
        expect(executed(output.results[8]).entry?.status).toBe("admitted");
        expect(output.truncated).toBe(false);
        expect(JSON.stringify(output).length).toBeLessThanOrEqual(
          LOOM_RETRIEVAL_MAX_OUTPUT_CHARS,
        );
      });

      it("allocates bodies smallest-first while returning calls in input order", async () => {
        const bodies: Record<string, object> = {
          "calendar.day": {
            ok: true,
            rows: Array.from({ length: 10 }, () => "c".repeat(3_900)),
          },
          "source.read": { ok: true, text: "e".repeat(3_000) },
          "person.find": { ok: true, name: "Donut" },
          "search.query": {
            ok: true,
            rows: Array.from({ length: 3 }, () => "s".repeat(3_900)),
          },
        };
        for (
          const commands of [Object.keys(bodies), Object.keys(bodies).reverse()]
        ) {
          const { context } = contextWith({
            answer: ({ id }) => new Response(JSON.stringify(bodies[id])),
          });
          const output = batched(
            await runCommandTool.invoke(context, {
              calls: commands.map((command) => ({ command, args: {} })),
            }),
          );
          const results = output.results.map(executed);
          for (const [index, command] of commands.entries()) {
            expect(results[index].outcome.bodyBytes).toBe(
              new TextEncoder().encode(JSON.stringify(bodies[command])).length,
            );
            expect(results[index].entry?.status).toBe(
              command === "calendar.day" ? undefined : "admitted",
            );
          }
          expect(JSON.stringify(output).length).toBeLessThanOrEqual(
            LOOM_RETRIEVAL_MAX_OUTPUT_CHARS,
          );
        }
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

      it("keeps refusal guidance and the signature a `bad-args` refusal carries", async () => {
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
        expect(refused.hint).toContain("Do not retry it");
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
          reads: true,
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

    it("keeps refusal guidance when an oversized answer has no entry", async () => {
      for (const batch of [false, true]) {
        const { context } = contextWith({
          answer: JSON.stringify({
            ok: false,
            code: "forbidden",
            rows: Array.from({ length: 40 }, () => "x".repeat(3_000)),
          }),
        });
        const call = { command: "loom.compose", args: {} };
        const result = await runCommandTool.invoke(
          context,
          batch ? { calls: [call] } : call,
        );
        const output = executed(batch ? batched(result).results[0] : result);
        expect(output.outcome.code).toBe("not_granted");
        expect(output.entry).toBeUndefined();
        expect(output.truncated).toBe(true);
        expect(output.hint).toContain("Do not retry it");
        expect(output.hint).not.toContain("Read a smaller");
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
      expect(output.hint).toBe(
        "The result body was omitted to fit the tool output limit. No requested values are shown. Read a smaller date range, fewer results, or a smaller batch.",
      );
      expect(output.truncated).toBe(true);
    });
  });

  describe("runCommandTool's declared reads", () => {
    const run = (
      answer: unknown,
      options: Parameters<typeof contextWith>[0] = {},
    ) => {
      const { context, calls } = contextWith({
        answer: JSON.stringify(answer),
        ...options,
      });
      return {
        calls,
        output: runCommandTool.invoke(context, {
          command: "people-discovery.dossier",
          args: { entity_id: "e-1" },
        }),
      };
    };

    it("labels an answer by the join of its reads' labels, recording the reads beside it and showing them nowhere", async () => {
      const mail = readOf("gmail:thread-a", "rev-a", [OWNER], {
        provisional: ["gmail"],
        title: "Lunch",
        at: "2026-11-20T12:00:00Z",
        author: { email: "a@example.com" },
      });
      const chart = {
        ...readOf("health:visit-b", "rev-b", [HEALTH]),
        ifc: { confidentiality: [HEALTH], integrity: [VOUCHED] },
      };
      const answer = { ok: true, id: "people-discovery.dossier", records: 2 };
      const referents: Record<string, unknown>[] = [];
      const output = executed(
        await run({ ...answer, reads: [mail, chart] }, { referents }).output,
      );

      expect(output.entry).toMatchObject({
        status: "admitted",
        value: answer,
        labelSource: "row",
      });
      expect(output.outcome.bodyBytes).toBe(JSON.stringify(answer).length);
      expect(output.cfc).toEqual({
        version: 1,
        observedLabel: { confidentiality: [OWNER, HEALTH] },
        reads: [mail, chart],
      });
      // The answer combines rows of two stores with the model's arguments,
      // so it keeps the integrity of neither.
      expect(referents[0]).toMatchObject({
        label: { confidentiality: [OWNER, HEALTH], integrity: [] },
      });
      expect(JSON.stringify(runCommandModelView(output).output)).not.toContain(
        "gmail:thread-a",
      );
    });

    it("joins the arguments' label with the reads', so a public read does not make an answer public", async () => {
      const output = executed(
        await run({
          ok: true,
          echo: "/people-discovery.dossier e-1",
          reads: [readOf("web:https://example.com/", null, [])],
        }, { queryLabel: [OWNER] }).output,
      );

      expect(output.cfc.observedLabel).toEqual({ confidentiality: [OWNER] });
      expect(output.cfc.reads).toHaveLength(1);
    });

    it("joins an answer's own `ifc` with its reads', and withholds one whose own `ifc` cannot be read", async () => {
      const joined = executed(
        await run({
          ok: true,
          ifc: { confidentiality: [HEALTH], integrity: [VOUCHED] },
          reads: [readOf("gmail:thread-a", "rev-a", [OWNER])],
        }).output,
      );
      expect(joined.entry).toMatchObject({
        status: "admitted",
        value: { ok: true },
        labelSource: "row",
      });
      expect(joined.cfc.observedLabel).toEqual({
        confidentiality: [OWNER, HEALTH],
      });

      const unreadable = executed(
        await run({
          ok: true,
          ifc: { confidentiality: "secret" },
          reads: [readOf("gmail:thread-a", "rev-a", [OWNER])],
        }).output,
      );
      expect(unreadable.entry).toEqual({
        status: "withheld",
        reasonCode: "cfc_label_read_failed",
      });
      expect(unreadable.cfc).toEqual({ version: 1 });
    });

    it("labels an answer that declares no reads as the call's arguments", async () => {
      const labeled = executed(
        await run({ ok: true, reads: [] }, { queryLabel: [OWNER] }).output,
      );
      expect(labeled.entry).toMatchObject({
        status: "admitted",
        value: { ok: true },
        labelSource: "query",
      });
      expect(labeled.cfc).toEqual({
        version: 1,
        observedLabel: { confidentiality: [OWNER] },
        reads: [],
      });

      const unlabeled = executed(await run({ ok: true, reads: [] }).output);
      expect(unlabeled.cfc).toEqual({ version: 1, reads: [] });
    });

    it("labels an answer with no `reads` key by its own `ifc`, or else by the query, and records no reads", async () => {
      const byQuery = executed(
        await run({ ok: true, echo: "answered" }, { queryLabel: [OWNER] })
          .output,
      );
      expect(byQuery.entry).toMatchObject({
        status: "admitted",
        value: { ok: true, echo: "answered" },
        labelSource: "query",
      });
      expect(byQuery.cfc).toEqual({
        version: 1,
        observedLabel: { confidentiality: [OWNER] },
      });

      const byRow = executed(
        await run({ ok: true, ifc: { confidentiality: [HEALTH] } }, {
          queryLabel: [OWNER],
        }).output,
      );
      expect(byRow.entry).toMatchObject({
        status: "admitted",
        value: { ok: true },
        labelSource: "row",
      });
      expect(byRow.cfc).toEqual({
        version: 1,
        observedLabel: { confidentiality: [HEALTH] },
      });
    });

    it("withholds an answer whose reads cannot be read, recording none", async () => {
      for (
        const reads of [
          "two",
          null,
          [{
            ref: "gmail:thread-a",
            revision: "r",
            coverage: { kind: "body" },
          }],
          [{ ...readOf("gmail:thread-a", "r", [OWNER]), revision: 3 }],
          [{ ...readOf("gmail:thread-a", "r", [OWNER]), coverage: {} }],
          [{ ...readOf("", "r", [OWNER]) }],
          ["gmail:thread-a"],
          [readOf("gmail:thread-a", "r", [OWNER], { provisional: [] })],
          [readOf("gmail:thread-a", "r", [OWNER], { provisional: [3] })],
          [readOf("gmail:thread-a", "r", [OWNER], { provisional: "gmail" })],
        ]
      ) {
        const output = executed(await run({ ok: true, reads }).output);
        expect(output.entry).toEqual({
          status: "withheld",
          reasonCode: "cfc_label_read_failed",
        });
        expect(output.cfc).toEqual({ version: 1 });
      }
    });

    it("records no reads for an answer withheld by the ceiling", async () => {
      const output = executed(
        await run({
          ok: true,
          reads: [readOf("health:visit-b", "rev-b", [HEALTH])],
        }, { ceiling: [OWNER] }).output,
      );
      expect(output.entry?.status).toBe("withheld");
      expect(output.cfc).toEqual({ version: 1 });
    });

    it("leaves out an answer that declares more reads than an observation records, and shows one at the bound", async () => {
      const reads = (count: number) =>
        Array.from(
          { length: count },
          (_, n) => readOf(`gmail:thread-${n}`, "r", [OWNER]),
        );
      const past = executed(
        await run({ ok: true, reads: reads(513) }).output,
      );
      expect(past.entry).toBeUndefined();
      expect(past.truncated).toBe(true);
      expect(past.hint).toContain("at most 512 reads");
      expect(past.hint).not.toContain("tool output limit");
      expect(past.cfc).toEqual({ version: 1 });

      const at = executed(await run({ ok: true, reads: reads(512) }).output);
      expect(at.entry?.status).toBe("admitted");
      expect(at.cfc.reads).toHaveLength(512);
    });

    it("admits a read at every limit Loom states, and leaves out an answer whose read is larger than one observation records", async () => {
      // Loom bounds a read's reference at 1,000 characters, its title at
      // 3,000 and its pages at 1,000; multibyte text and long page numbers
      // take the serialized read past 16 KiB.
      const atLimits = {
        ...readOf("gmail:" + "é".repeat(994), "r".repeat(200), [OWNER], {
          title: "\u{1F600}".repeat(1500),
          at: "2".repeat(100),
          provisional: ["gmail"],
        }),
        coverage: {
          kind: "body",
          pages: Array.from({ length: 1000 }, (_, n) => 1_000_000_000 + n),
        },
      };
      expect(new TextEncoder().encode(JSON.stringify(atLimits)).length)
        .toBeGreaterThan(16_384);
      const admitted = executed(
        await run({ ok: true, reads: [atLimits] }).output,
      );
      expect(admitted.entry?.status).toBe("admitted");
      expect(admitted.cfc.reads).toEqual([atLimits]);

      const oversized = executed(
        await run({
          ok: true,
          reads: [readOf("gmail:thread-a", "r", [OWNER], {
            title: "x".repeat(HARNESS_CFC_MODEL_CONTEXT_READ_MAX_BYTES),
          })],
        }).output,
      );
      expect(oversized.entry).toBeUndefined();
      expect(oversized.truncated).toBe(true);
      expect(oversized.hint).toContain(
        `each at most ${HARNESS_CFC_MODEL_CONTEXT_READ_MAX_BYTES} bytes`,
      );
      expect(oversized.cfc).toEqual({ version: 1 });
    });

    it("bounds a batch's reads together, leaving out the answer that would pass the bound", async () => {
      const reads = Array.from(
        { length: 300 },
        (_, n) => readOf(`gmail:thread-${n}`, "r", [OWNER]),
      );
      const { context } = contextWith({
        answer: () => Response.json({ ok: true, reads }),
      });
      const output = batched(
        await runCommandTool.invoke(context, {
          calls: [
            { command: "people-discovery.dossier", args: { entity_id: "a" } },
            { command: "people-discovery.dossier", args: { entity_id: "b" } },
          ],
        }),
      );
      const [first, second] = output.results.map(executed);
      expect(first.entry?.status).toBe("admitted");
      expect(second.entry).toBeUndefined();
      expect(output.cfc.reads).toEqual(reads);
    });

    it("joins a batch's reads in the calls' order", async () => {
      const a = readOf("gmail:thread-a", "rev-a", [OWNER]);
      const b = readOf("health:visit-b", "rev-b", [HEALTH]);
      const { context } = contextWith({
        answer: (call) =>
          Response.json(
            (call as { args?: { entity_id?: string } }).args?.entity_id ===
                "a"
              ? { ok: true, reads: [a], padding: "x".repeat(200) }
              : (call as { args?: { entity_id?: string } }).args?.entity_id ===
                  "b"
              ? { ok: true, reads: [b] }
              : { ok: true },
          ),
      });
      const output = batched(
        await runCommandTool.invoke(context, {
          calls: [
            { command: "people-discovery.dossier", args: { entity_id: "a" } },
            { command: "people-discovery.dossier", args: { entity_id: "c" } },
            { command: "people-discovery.dossier", args: { entity_id: "b" } },
          ],
        }),
      );
      expect(output.cfc).toEqual({
        version: 1,
        observedLabel: { confidentiality: [OWNER, HEALTH] },
        reads: [a, b],
      });
    });

    it("shows the model an `unlabelled-read` refusal as a refusal naming the stores, with guidance", async () => {
      const refusal = {
        ok: false,
        id: "preparation.calendar",
        code: "unlabelled-read",
        stores: ["item"],
        error:
          "preparation.calendar read rows from a store that carries no label (item); the answer is not sent without one",
        reads: [],
      };
      const output = executed(
        await run(refusal, { queryLabel: [OWNER] }).output,
      );
      expect(output.outcome).toMatchObject({
        ok: false,
        code: "unlabelled-read",
      });
      expect(output.outcome).not.toHaveProperty("hostCode");
      expect(output.hint).toContain("stores that carry no label");
      expect(output.entry).toMatchObject({
        status: "admitted",
        value: { stores: ["item"], code: "unlabelled-read" },
      });

      const other = executed(
        await run({ ok: false, code: "not-found", reads: [] }).output,
      );
      expect(other.hint).toBeUndefined();
    });
  });

  describe("runCommandTool.effectClassOf()", () => {
    const effectOf = (
      input: Record<string, unknown>,
      context: HarnessToolContext,
    ) => runCommandTool.effectClassOf!(input, context);

    it("returns the strongest effect the listed commands of a call or batch declare", async () => {
      const { context } = contextWith();
      expect(
        await effectOf({
          command: "people-discovery.dossier",
          args: { entity_id: "e" },
        }, context),
      ).toBe("read");
      expect(
        await effectOf({
          calls: [
            { command: "people-discovery.dossier", args: {} },
            { command: "loom.compose", args: {} },
          ],
        }, context),
      ).toBe("write");
    });

    it("returns `write` when the effect cannot be read: no catalog, a cancelled turn, an unreadable list, an empty batch, or a malformed call", async () => {
      const read = { command: "people-discovery.dossier", args: {} };
      expect(await effectOf(read, contextWith({ configured: false }).context))
        .toBe("write");
      const { context: cancelled, asked } = askedOf(
        contextWith({ aborted: true }).context,
      );
      expect(await effectOf(read, cancelled)).toBe("write");
      expect(asked).toEqual([]);
      expect(await effectOf(read, contextWith({ manifest: "[]" }).context))
        .toBe("write");
      const { context } = contextWith();
      expect(await effectOf({ calls: [] }, context)).toBe("write");
      expect(await effectOf({ calls: [read, "loom.compose"] }, context)).toBe(
        "write",
      );
    });

    it("returns `write` when the turn is cancelled during the catalog read", async () => {
      const { context } = contextWith();
      const controller = new AbortController();
      const requested = Promise.withResolvers<void>();
      const listing = Promise.withResolvers<Response>();
      answers.list = () => {
        requested.resolve();
        return listing.promise;
      };
      const pending = effectOf(
        { command: "people-discovery.dossier", args: {} },
        { ...context, signal: controller.signal },
      );
      try {
        await requested.promise;
        controller.abort();
        expect(await pending).toBe("write");
      } finally {
        // The catalog read outlives its cancelled caller. Finish it while
        // this fixture still owns the shared host's answers and requests.
        listing.resolve(new Response(JSON.stringify(MANIFEST)));
        await context.loomCommandCatalog!.current();
      }
    });
  });

  describe("runCommandModelView()", () => {
    it("returns a batch's results without their labels, leaving a result that is not a record as it was", () => {
      const view = runCommandModelView({
        status: "batch",
        cfc: { version: 1 },
        results: [{ status: "executed", cfc: { version: 1 } }, "lost"],
      });
      expect(view.output).toEqual({
        status: "batch",
        results: [{ status: "executed" }, "lost"],
      });
      expect(view.artifactOnlyPointers).toEqual(["/cfc", "/results/0/cfc"]);
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

    it("carries the reads an answer recorded, and refuses a result whose recorded reads are not reads", () => {
      const read = readOf("gmail:thread-a", "rev-a", [OWNER]);
      expect(
        loomCommandModelContextObservation(
          {
            status: "executed",
            truncated: false,
            cfc: { version: 1, reads: [read] },
          },
          resultRef,
          "call-1",
        ),
      ).toEqual({
        toolCallId: "call-1",
        toolId: "run_command",
        outputId: resultRef.outputId,
        channels: ["output"],
        label: { confidentiality: [] },
        reads: [read],
      });
      expect(() =>
        loomCommandModelContextObservation(
          { status: "executed", cfc: { version: 1, reads: [{ ref: "x" }] } },
          resultRef,
          "call-1",
        )
      ).toThrow(TypeError);
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

    /**
     * Has the model call `run_command` once per input, each in its own turn,
     * with the host answering each posted call through `answer`, then
     * finish. Returns the run's result and each request sent to the model.
     */
    const runCalls = async (
      inputs: RunCommandInput[],
      answer: (call: { args?: Record<string, unknown> }) => unknown,
    ) => {
      const { engine } = engineWith("{}");
      answers = {
        ...answers,
        run: (body) =>
          Response.json(answer(body as { args?: Record<string, unknown> })),
      };
      const payloads = [
        ...inputs.map((input, index) => ({
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: `run-${index + 1}`,
                type: "function",
                function: {
                  name: "run_command",
                  arguments: JSON.stringify(input),
                },
              }],
            },
          }],
        })),
        {
          choices: [{
            index: 0,
            message: { role: "assistant", content: "Done" },
          }],
        },
      ];
      let turn = 0;
      const requests: string[] = [];
      const result = await new CfHarnessPromptLoop({
        engine,
        apiKey: "synthetic-test-key",
        model: "gpt-5.4",
        allowedToolIds: ["run_command"],
        fetchFn: (_url, init) => {
          requests.push(String(init?.body ?? ""));
          return Promise.resolve(
            new Response(
              JSON.stringify(
                responsesBodyFromChatFixture(payloads[turn++], init?.body),
              ),
              { status: 200 },
            ),
          );
        },
      }).runPrompt({
        prompt: "Gather what is known about Ada",
        promptSlotBinding: directPromptSlotBindingFor("loom-commands"),
      });
      return { engine, result, requests };
    };

    /** The JSON the model was shown for each tool result, in order. */
    const shownResults = (
      result: Awaited<ReturnType<typeof runCalls>>["result"],
    ) =>
      result.transcript.flatMap((message) =>
        message.role === "tool"
          ? [JSON.parse((message as { content: string }).content)]
          : []
      );

    it("records one observation per answer carrying the reads it declared, numbered in order, and shows the model none of them", async () => {
      // The public read comes first: the second call's arguments carry what
      // the run observed by then, and its answer takes their label.
      const page = readOf("web:https://example.com/only-in-reads", null, []);
      const mail = readOf("gmail:thread-only-in-reads", "rev-a", [OWNER], {
        title: "Title only in reads",
      });
      const chart = readOf("health:visit-only-in-reads", "rev-b", [HEALTH]);
      const { engine, result, requests } = await runCalls(
        [
          { command: "people-discovery.dossier", args: { entity_id: "a" } },
          { command: "people-discovery.dossier", args: { entity_id: "b" } },
        ],
        (call) =>
          call.args?.entity_id === "a"
            ? { ok: true, records: 1, reads: [page] }
            : { ok: true, records: 2, reads: [mail, chart] },
      );

      const observations = engine.getRunState().cfcModelContext?.observations;
      expect(
        observations?.map((observation) => ({
          sequence: observation.sequence,
          toolCallId: observation.toolCallId,
          label: observation.label,
          reads: observation.reads?.map((read) => [read.ref, read.revision]),
        })),
      ).toEqual([{
        sequence: 1,
        toolCallId: "run-1",
        label: { confidentiality: [] },
        reads: [["web:https://example.com/only-in-reads", null]],
      }, {
        sequence: 2,
        toolCallId: "run-2",
        label: { confidentiality: [OWNER, HEALTH] },
        reads: [
          ["gmail:thread-only-in-reads", "rev-a"],
          ["health:visit-only-in-reads", "rev-b"],
        ],
      }]);
      expect(observations?.[1].reads).toEqual([mail, chart]);
      expect(shownResults(result).map((shown) => shown.entry.value)).toEqual([
        { ok: true, records: 1 },
        { ok: true, records: 2 },
      ]);
      for (const request of requests) {
        expect(request).not.toContain("only-in-reads");
        expect(request).not.toContain("Title only in reads");
      }
    });

    it("leaves no observation for an answer that declares no reads and has no confidentiality", async () => {
      const { engine, result } = await runCalls(
        [{ command: "people-discovery.dossier", args: { entity_id: "a" } }],
        () => ({ ok: true, records: 0, reads: [] }),
      );

      expect(shownResults(result)[0]).toMatchObject({
        status: "executed",
        entry: { status: "admitted", value: { ok: true, records: 0 } },
      });
      expect(engine.getRunState().cfcModelContext).toBeUndefined();
    });

    it("shows the model an answer with no `reads` key as before, and records no reads for it", async () => {
      const { engine, result } = await runCalls(
        [{ command: "people-discovery.dossier", args: { entity_id: "a" } }],
        () => ({ ok: true, records: 3, ifc: { confidentiality: [OWNER] } }),
      );

      const [shown] = shownResults(result);
      expect(Object.keys(shown).sort()).toEqual(
        ["entry", "notice", "outcome", "outputId", "status", "truncated"],
      );
      expect(shown).toMatchObject({
        status: "executed",
        notice: LOOM_COMMAND_UNTRUSTED_NOTICE,
        outcome: {
          ok: true,
          bodyBytes: JSON.stringify({
            ok: true,
            records: 3,
            ifc: { confidentiality: [OWNER] },
          }).length,
        },
        entry: {
          status: "admitted",
          labelSource: "row",
          value: { ok: true, records: 3 },
        },
        truncated: false,
      });
      expect(Object.keys(shown.entry).sort()).toEqual(
        ["handle", "label", "labelSource", "status", "value"],
      );
      const observations = engine.getRunState().cfcModelContext?.observations;
      expect(observations).toHaveLength(1);
      expect(observations?.[0]).not.toHaveProperty("reads");
    });

    it("shows the model an `unlabelled-read` refusal as a tool result it can act on", async () => {
      const { result } = await runCalls(
        [{ command: "people-discovery.dossier", args: { entity_id: "a" } }],
        () => ({
          ok: false,
          id: "people-discovery.dossier",
          code: "unlabelled-read",
          stores: ["item"],
          error: "read rows from a store that carries no label (item)",
          reads: [],
        }),
      );

      expect(shownResults(result)[0]).toMatchObject({
        status: "executed",
        outcome: { ok: false, code: "unlabelled-read" },
        hint: expect.stringContaining("stores that carry no label"),
        entry: { status: "admitted", value: { stores: ["item"] } },
      });
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
          body: {
            id: "loom.compose",
            args: {},
            actor: "agent:agent-runner",
            reads: true,
          },
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
        reads: true,
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
        reads: true,
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

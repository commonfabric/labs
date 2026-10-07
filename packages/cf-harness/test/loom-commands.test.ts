import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { parseCfHarnessCliArgs } from "./support/on-linux.ts";
import {
  HARNESS_COMMAND_CATALOG_LIMIT,
  HARNESS_COMMAND_DESCRIPTION_MAX_LENGTH,
  HARNESS_COMMAND_ID_MAX_LENGTH,
  HARNESS_COMMAND_SCHEMA_MAX_BYTES,
  HARNESS_COMMAND_SUMMARY_MAX_LENGTH,
} from "../src/contracts/client-command.ts";
import {
  createLoomCommandCatalogSource,
  type HarnessLoomCommandsConfig,
  isHiddenFromAgents,
  listLoomCommands,
  LOOM_COMMAND_OUTPUTS_LIMIT,
  loomCommandCatalogOf,
  loomCommandEntryOfRow,
  nearestCommandNames,
  readLoomCommandsConfig,
  runLoomCommand,
  validateLoomCommandsConfig,
} from "../src/loom-commands.ts";
import type {
  ProcessRunner,
  ProcessRunRequest,
} from "../src/sandbox/process-runner.ts";

/** A broker-routed host configuration. */
const config: HarnessLoomCommandsConfig = {
  cliPath: "/trusted/loom",
  transport: { kind: "broker", queuePath: "/trusted/queue" },
};

/** Helper for tests, which answers every process with `stdout`. */
const runnerAnswering = (
  stdout: string,
  exitCode = 0,
): { runner: ProcessRunner; calls: ProcessRunRequest[] } => {
  const calls: ProcessRunRequest[] = [];
  return {
    calls,
    runner: {
      run(request) {
        calls.push(request);
        return Promise.resolve({ stdout, stderr: "host text", exitCode });
      },
    },
  };
};

/** A process runner whose process cannot be started. */
const failingRunner: ProcessRunner = {
  run: () => Promise.reject(new Error("spawn failed")),
};

describe("loom-commands", () => {
  it("uses each concurrent job's identity for discovery and execution in a cleared environment", async () => {
    const { runner, calls } = runnerAnswering(
      JSON.stringify({ ok: true, commands: [] }),
    );
    await Promise.all(["job-first", "job-second"].map(async (jobId) => {
      const parsed = await parseCfHarnessCliArgs(
        ["--prompt", "t", "--loom-commands-config", "/trusted/config.json"],
        {
          cwd: "/trusted",
          env: {},
          commandJobId: jobId,
          readTextFile: () =>
            Promise.resolve(JSON.stringify({
              ...config,
              jobIdEnvVar: "HOST_JOB_ID",
              jobId: "file-must-not-supply-the-current-job",
            })),
        },
      );
      if ("help" in parsed) throw new Error("expected config");
      await listLoomCommands(parsed.loomCommands!, runner);
      await runLoomCommand(
        parsed.loomCommands!,
        { command: "note.create", args: {} },
        runner,
      );
    }));
    expect(calls).toHaveLength(4);
    for (const jobId of ["job-first", "job-second"]) {
      const own = calls.filter((call) => call.env?.HOST_JOB_ID === jobId);
      expect(own).toHaveLength(2);
      expect(own.map((call) => call.args?.[1]).sort()).toEqual(["list", "run"]);
      for (const call of own) {
        expect(call.clearEnv).toBe(true);
        expect(call.env?.LOOM_PAGE_RPC_QUEUE).toBe(config.transport.queuePath);
      }
    }
  });

  describe("validateLoomCommandsConfig()", () => {
    it("throws for an invalid or reserved job identity environment name", () => {
      for (
        const jobIdEnvVar of ["", "bad-name", "PATH", "LOOM_PAGE_RPC_QUEUE"]
      ) {
        expect(() => validateLoomCommandsConfig({ ...config, jobIdEnvVar }))
          .toThrow("jobIdEnvVar");
      }
    });

    it("accepts an absolute CLI path and an absolute broker queue", () => {
      expect(() => validateLoomCommandsConfig(config)).not.toThrow();
    });

    it("throws for a relative CLI path", () => {
      expect(() => validateLoomCommandsConfig({ ...config, cliPath: "loom" }))
        .toThrow("absolute `cliPath`");
    });

    it("throws for the direct transport, which does not stamp the actor", () => {
      expect(() =>
        validateLoomCommandsConfig({
          ...config,
          transport: {
            kind: "direct",
            instanceDir: "/instance",
            runId: "run",
            actor: "agent:x",
          } as unknown as HarnessLoomCommandsConfig["transport"],
        })
      ).toThrow("broker transport");
    });

    it("throws for a transport that is not an object", () => {
      expect(() =>
        validateLoomCommandsConfig({
          ...config,
          transport: "broker" as unknown as HarnessLoomCommandsConfig[
            "transport"
          ],
        })
      ).toThrow("broker transport");
    });

    it("throws for a relative or missing queue path", () => {
      for (const queuePath of ["queue", undefined]) {
        expect(() =>
          validateLoomCommandsConfig({
            ...config,
            transport: {
              kind: "broker",
              queuePath,
            } as unknown as HarnessLoomCommandsConfig["transport"],
          })
        ).toThrow("absolute broker `queuePath`");
      }
    });
  });

  describe("readLoomCommandsConfig()", () => {
    it("returns `undefined` when no path is named", async () => {
      expect(await readLoomCommandsConfig(undefined)).toBeUndefined();
    });

    it("throws for a relative path before reading anything", async () => {
      await expect(
        readLoomCommandsConfig("commands.json", () => {
          throw new Error("read");
        }),
      ).rejects.toThrow("must be absolute");
    });

    it("returns the configuration a file names", async () => {
      const read = await readLoomCommandsConfig(
        "/trusted/commands.json",
        (path) => {
          expect(path).toBe("/trusted/commands.json");
          return Promise.resolve(JSON.stringify(config));
        },
      );
      expect(read).toEqual(config);
    });

    it("throws for a file that names no CLI", async () => {
      for (const text of ["[]", JSON.stringify({ transport: {} })]) {
        await expect(
          readLoomCommandsConfig(
            "/trusted/commands.json",
            () => Promise.resolve(text),
          ),
        ).rejects.toThrow("host CLI and a transport");
      }
    });

    it("throws for a file whose transport is not a broker", async () => {
      await expect(
        readLoomCommandsConfig(
          "/trusted/commands.json",
          () =>
            Promise.resolve(JSON.stringify({
              cliPath: "/trusted/loom",
              transport: { kind: "direct" },
            })),
        ),
      ).rejects.toThrow("broker transport");
    });
  });

  describe("isHiddenFromAgents()", () => {
    it("returns `false` for a row that declares nothing about who may run it", () => {
      expect(isHiddenFromAgents({ id: "loom.compose" })).toBe(false);
    });

    it("returns `true` for a pattern's verb and a developer command", () => {
      expect(isHiddenFromAgents({ id: "pv.abc", origin: "pattern" })).toBe(
        true,
      );
      expect(isHiddenFromAgents({ id: "dev.x", developer: true })).toBe(true);
      expect(isHiddenFromAgents({ id: "x", origin: "builtin" })).toBe(false);
    });

    it("returns `true` when every declared actor is a person, and `false` when one is an agent", () => {
      expect(isHiddenFromAgents({ id: "x", actors: ["user"] })).toBe(true);
      expect(isHiddenFromAgents({ id: "x", actors: ["user", "agent:ask"] }))
        .toBe(false);
      expect(isHiddenFromAgents({ id: "x", actors: [] })).toBe(false);
      expect(isHiddenFromAgents({ id: "x", actors: "user" })).toBe(false);
    });

    it("returns `true` for a row that refuses the `session` origin", () => {
      expect(
        isHiddenFromAgents({ id: "x", origins_refused: ["session"] }),
      ).toBe(true);
      expect(isHiddenFromAgents({ id: "x", origins_refused: ["script"] }))
        .toBe(false);
    });

    it("returns `true` for a row requiring an origin other than `session`, and `false` for one requiring it", () => {
      expect(isHiddenFromAgents({ id: "x", origins_required: ["script"] }))
        .toBe(true);
      expect(isHiddenFromAgents({ id: "x", origins_required: ["session"] }))
        .toBe(false);
    });

    it("returns `true` for a row that runs only over a consent grant", () => {
      expect(isHiddenFromAgents({ id: "x", grant: "connector" })).toBe(true);
      expect(isHiddenFromAgents({ id: "x", grant: true })).toBe(true);
      for (const grant of [null, false, ""]) {
        expect(isHiddenFromAgents({ id: "x", grant })).toBe(false);
      }
    });
  });

  describe("loomCommandEntryOfRow()", () => {
    it("reads a manifest row as a callable descriptor and its target", () => {
      const inputs = {
        type: "object",
        properties: { title: { type: "string" } },
      };
      expect(loomCommandEntryOfRow({
        id: "loom.rename",
        title: "Rename the loom in focus.",
        help: "Renames it.",
        inputs,
        scope: "loom",
        outputs: ["loom_id", 7, "version"],
        effect: "change",
      })).toEqual({
        name: "loom.rename",
        title: "Rename the loom in focus.",
        description: "Renames it.",
        inputSchema: inputs,
        effect: "change",
        target: "loom",
        outputs: ["loom_id", "version"],
      });
    });

    it("returns `undefined` for a row whose id the command grammar refuses", () => {
      for (const id of [undefined, 7, "", "-bad", `a${"b".repeat(128)}`]) {
        expect(loomCommandEntryOfRow({ id })).toBeUndefined();
      }
    });

    it("leaves out empty text, an undeclared effect, and empty outputs, and targets `global` by default", () => {
      expect(loomCommandEntryOfRow({
        id: "search.run",
        title: "",
        help: 3,
        inputs: { type: "object" },
        effect: "maybe",
        outputs: "loom_id",
        scope: "",
      })).toEqual({
        name: "search.run",
        inputSchema: { type: "object" },
        target: "global",
      });
    });

    it("cuts the title and description to the catalog's bounds", () => {
      const entry = loomCommandEntryOfRow({
        id: "page.write",
        title: "t".repeat(HARNESS_COMMAND_SUMMARY_MAX_LENGTH + 5),
        help: "h".repeat(HARNESS_COMMAND_DESCRIPTION_MAX_LENGTH + 5),
      });
      expect(entry?.title).toHaveLength(HARNESS_COMMAND_SUMMARY_MAX_LENGTH);
      expect(entry?.description).toHaveLength(
        HARNESS_COMMAND_DESCRIPTION_MAX_LENGTH,
      );
    });

    it("cuts the target and each output name to an identifier's length, and keeps at most the output-name limit", () => {
      const entry = loomCommandEntryOfRow({
        id: "a.b",
        scope: "s".repeat(HARNESS_COMMAND_ID_MAX_LENGTH + 5),
        outputs: Array.from(
          { length: LOOM_COMMAND_OUTPUTS_LIMIT + 3 },
          (_, index) =>
            `${index}`.padEnd(HARNESS_COMMAND_ID_MAX_LENGTH + 5, "x"),
        ),
      });
      expect(entry?.target).toHaveLength(HARNESS_COMMAND_ID_MAX_LENGTH);
      expect(entry?.outputs).toHaveLength(LOOM_COMMAND_OUTPUTS_LIMIT);
      for (const name of entry?.outputs ?? []) {
        expect(name).toHaveLength(HARNESS_COMMAND_ID_MAX_LENGTH);
      }
    });

    it("removes the `x-*` extension keywords from the argument schema", () => {
      expect(
        loomCommandEntryOfRow({
          id: "a.b",
          inputs: {
            type: "object",
            "x-surface": "pill",
            properties: { title: { type: "string", "x-widget": "text" } },
          },
        })?.inputSchema,
      ).toEqual({
        type: "object",
        properties: { title: { type: "string" } },
      });
    });

    it("names the inputs the host fills from context, which the shown schema no longer marks", () => {
      const entry = loomCommandEntryOfRow({
        id: "pane.rename",
        inputs: {
          type: "object",
          required: ["pane", "title"],
          properties: {
            pane: { type: "string", "x-source": "context.pane" },
            title: { type: "string" },
          },
        },
      });
      expect(entry?.hostFilled).toEqual(["pane"]);
      expect(JSON.stringify(entry?.inputSchema)).not.toContain("x-source");
      expect(loomCommandEntryOfRow({ id: "a.b", inputs: { type: "object" } }))
        .not.toHaveProperty("hostFilled");
    });

    it("shows an argument schema that is not an object, or is too large, as open", () => {
      expect(loomCommandEntryOfRow({ id: "a.b", inputs: [1] })?.inputSchema)
        .toBe(true);
      expect(
        loomCommandEntryOfRow({
          id: "a.b",
          inputs: { description: "x".repeat(HARNESS_COMMAND_SCHEMA_MAX_BYTES) },
        })?.inputSchema,
      ).toBe(true);
    });
  });

  describe("loomCommandCatalogOf()", () => {
    it("keeps visible rows in order and counts hidden and unreadable ones", () => {
      const catalog = loomCommandCatalogOf([
        { id: "loom.compose" },
        { id: "share.invite", actors: ["user"] },
        "not a row",
        { id: "-bad" },
        { id: "loom.inspect" },
      ]);
      expect(catalog.entries.map((entry) => entry.name)).toEqual([
        "loom.compose",
        "loom.inspect",
      ]);
      expect(catalog).toMatchObject({ hidden: 1, malformed: 2, omitted: 0 });
    });

    it("keeps at most the contract's catalog limit and counts the rest", () => {
      const rows = Array.from(
        { length: HARNESS_COMMAND_CATALOG_LIMIT + 2 },
        (_, index) => ({ id: `cmd.n${index}` }),
      );
      const catalog = loomCommandCatalogOf(rows);
      expect(catalog.entries).toHaveLength(HARNESS_COMMAND_CATALOG_LIMIT);
      expect(catalog.omitted).toBe(2);
    });
  });

  describe("nearestCommandNames()", () => {
    const names = [
      "loom.compose",
      "loom.inspect",
      "people-discovery.dossier",
      "calendar.list",
      "share.invite",
    ];

    it("returns a name containing the one called before nearer misspellings", () => {
      expect(nearestCommandNames("dossier", names)[0]).toBe(
        "people-discovery.dossier",
      );
    });

    it("returns at most three names, nearest by edit distance first", () => {
      expect(nearestCommandNames("loom.compse", names)).toEqual([
        "loom.compose",
        "loom.inspect",
        "share.invite",
      ]);
    });

    it("returns no names from an empty catalog", () => {
      expect(nearestCommandNames("loom.compose", [])).toEqual([]);
    });
  });

  describe("createLoomCommandCatalogSource()", () => {
    /** A manifest of one visible command. */
    const manifest = JSON.stringify({ commands: [{ id: "loom.compose" }] });

    it("reads the host once for any number of uses, concurrent ones included", async () => {
      const { runner, calls } = runnerAnswering(manifest);
      const source = createLoomCommandCatalogSource(config, runner);
      const reads = await Promise.all([source.current(), source.current()]);
      await source.current();
      expect(calls).toHaveLength(1);
      for (const read of reads) {
        expect(read).toMatchObject({
          status: "ok",
          catalog: { entries: [{ name: "loom.compose" }] },
        });
      }
    });

    it("reads the host again on refresh and holds what it read", async () => {
      const { runner, calls } = runnerAnswering(manifest);
      const source = createLoomCommandCatalogSource(config, runner);
      await source.current();
      await source.refresh();
      await source.current();
      expect(calls).toHaveLength(2);
    });

    it("does not hold a read that failed, so the next use asks again", async () => {
      const { runner, calls } = runnerAnswering("Error: no broker");
      const source = createLoomCommandCatalogSource(config, runner);
      expect(await source.current()).toMatchObject({
        status: "error",
        code: "command_failed",
      });
      await source.current();
      expect(calls).toHaveLength(2);
    });
  });

  describe("listLoomCommands()", () => {
    it("runs `loom command list --json` over the broker queue in a cleared environment", async () => {
      const { runner, calls } = runnerAnswering(
        JSON.stringify({ schema: "s", version: 1, commands: [{ id: "a.b" }] }),
      );
      expect(await listLoomCommands(config, runner)).toEqual({
        status: "ok",
        commands: [{ id: "a.b" }],
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe("/trusted/loom");
      expect(calls[0].args).toEqual(["command", "list", "--json"]);
      expect(calls[0].clearEnv).toBe(true);
      expect(calls[0].env?.LOOM_PAGE_RPC_QUEUE).toBe("/trusted/queue");
      expect(calls[0].stdinText).toBeUndefined();
    });

    it("returns `command_failed` when the process cannot start or prints no JSON", async () => {
      expect(await listLoomCommands(config, failingRunner)).toMatchObject({
        status: "error",
        code: "command_failed",
      });
      const { runner } = runnerAnswering("Error: broker refused", 1);
      expect(await listLoomCommands(config, runner)).toMatchObject({
        status: "error",
        code: "command_failed",
      });
    });

    it("returns `command_failed` for a manifest the CLI printed but exited nonzero on", async () => {
      const { runner } = runnerAnswering(
        JSON.stringify({ commands: [{ id: "a.b" }] }),
        1,
      );
      expect(await listLoomCommands(config, runner)).toMatchObject({
        status: "error",
        code: "command_failed",
      });
    });

    it("returns `malformed_payload` for a manifest without a command list", async () => {
      for (const stdout of ["[]", JSON.stringify({ commands: {} })]) {
        const { runner } = runnerAnswering(stdout);
        expect(await listLoomCommands(config, runner)).toMatchObject({
          status: "error",
          code: "malformed_payload",
        });
      }
    });

    it("throws for an invalid configuration before starting a process", async () => {
      const { runner, calls } = runnerAnswering("{}");
      await expect(
        listLoomCommands({ ...config, cliPath: "loom" }, runner),
      ).rejects.toThrow("absolute `cliPath`");
      expect(calls).toHaveLength(0);
    });
  });

  describe("runLoomCommand()", () => {
    it("passes the id, the loom and the expected version on argv, and the args on stdin", async () => {
      const answer = { ok: true, id: "loom.add", outputs: { version: 4 } };
      const { runner, calls } = runnerAnswering(JSON.stringify(answer));
      const output = await runLoomCommand(
        config,
        {
          command: "loom.add",
          args: { ref: "page:A.md" },
          loomId: "loom-0123456789abcdef",
          expectedVersion: 3,
        },
        runner,
      );
      expect(output).toEqual({
        status: "ok",
        body: answer,
        bodyBytes: JSON.stringify(answer).length,
      });
      expect(calls[0].args).toEqual([
        "command",
        "run",
        "loom.add",
        "--args-json",
        "-",
        "--json",
        "--loom",
        "loom-0123456789abcdef",
        "--expect",
        "3",
      ]);
      expect(calls[0].stdinText).toBe(JSON.stringify({ ref: "page:A.md" }));
      expect(calls[0].env?.LOOM_PAGE_RPC_QUEUE).toBe("/trusted/queue");
    });

    it("leaves the loom and version flags off when the invocation names neither", async () => {
      const { runner, calls } = runnerAnswering(JSON.stringify({ ok: false }));
      const output = await runLoomCommand(
        config,
        { command: "search.run", args: {} },
        runner,
      );
      expect(output.status).toBe("ok");
      expect(calls[0].args).toEqual([
        "command",
        "run",
        "search.run",
        "--args-json",
        "-",
        "--json",
      ]);
    });

    it("returns an answer that may have landed when the process fails or prints no JSON", async () => {
      const invocation = { command: "loom.compose", args: {} };
      expect(await runLoomCommand(config, invocation, failingRunner)).toEqual({
        status: "error",
        code: "command_failed",
        message: "The host command's answer was lost.",
        landed: "unknown",
      });
      const { runner } = runnerAnswering("Traceback", 1);
      expect(await runLoomCommand(config, invocation, runner)).toMatchObject({
        status: "error",
        code: "command_failed",
        landed: "unknown",
      });
    });

    it("throws for an invalid configuration before starting a process", async () => {
      const { runner, calls } = runnerAnswering("{}");
      await expect(
        runLoomCommand(
          { ...config, cliPath: "loom" },
          { command: "a.b", args: {} },
          runner,
        ),
      ).rejects.toThrow("absolute `cliPath`");
      expect(calls).toHaveLength(0);
    });

    it("returns `malformed_payload` for JSON that is not a command result", async () => {
      for (const stdout of ["[]", JSON.stringify({ ok: "yes" })]) {
        const { runner } = runnerAnswering(stdout);
        expect(
          await runLoomCommand(config, { command: "a.b", args: {} }, runner),
        ).toMatchObject({
          status: "error",
          code: "malformed_payload",
          landed: "unknown",
        });
      }
    });
  });
});

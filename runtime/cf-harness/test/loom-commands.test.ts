import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { parseCfHarnessCliArgs } from "./support/on-linux.ts";
import { startCommandHost } from "./support/command-host.ts";
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
  listLoomCommands,
  LOOM_COMMAND_OUTPUTS_LIMIT,
  loomCommandCatalogOf,
  loomCommandEntryOfRow,
  nearestCommandNames,
  runLoomCommand,
  validateLoomCommandsConfig,
} from "../src/loom-commands.ts";

/** A host configuration whose endpoint is `url`. */
const configFor = (url: string): HarnessLoomCommandsConfig => ({
  url,
  actor: "agent:agent-runner",
  runId: "job-1",
});

/** An endpoint nothing listens on: a request to it cannot be sent. */
const UNREACHABLE = "http://127.0.0.1:1";

describe("loom-commands", () => {
  it("sends each concurrent run's own id, from its flags, on discovery and execution", async () => {
    await using host = startCommandHost();
    await Promise.all(["job-first", "job-second"].map(async (runId) => {
      const parsed = await parseCfHarnessCliArgs(
        [
          "--prompt",
          "t",
          "--commands-url",
          host.url,
          "--commands-actor",
          "agent:agent-runner",
          "--commands-run-id",
          runId,
        ],
        { cwd: "/trusted", env: {} },
      );
      if ("help" in parsed) throw new Error("expected config");
      await listLoomCommands(parsed.loomCommands!);
      await runLoomCommand(parsed.loomCommands!, {
        command: "note.create",
        args: {},
      });
    }));
    expect(host.requests).toHaveLength(4);
    for (const runId of ["job-first", "job-second"]) {
      const own = host.requests.filter((request) => request.runId === runId);
      expect(own.map((request) => request.path).sort()).toEqual([
        "/command",
        "/commands",
      ]);
    }
  });

  describe("validateLoomCommandsConfig()", () => {
    it("accepts an http(s) endpoint, an actor and a run id", () => {
      for (const url of ["http://127.0.0.1:8080", "https://host.test/base"]) {
        expect(() => validateLoomCommandsConfig(configFor(url))).not.toThrow();
      }
    });

    it("throws for an endpoint that is not an http(s) URL", () => {
      for (const url of ["", "127.0.0.1:8080", "file:///commands"]) {
        expect(() => validateLoomCommandsConfig(configFor(url))).toThrow(
          "`http:` or `https:` endpoint",
        );
      }
    });

    it("throws for an endpoint with a query or a fragment", () => {
      for (
        const url of [
          "http://127.0.0.1:8080/?a=1",
          "http://127.0.0.1:8080/#a",
          "http://127.0.0.1:8080/?",
          "http://127.0.0.1:8080/#",
        ]
      ) {
        expect(() => validateLoomCommandsConfig(configFor(url))).toThrow(
          "no query or fragment",
        );
      }
    });

    it("throws for an empty actor", () => {
      expect(() =>
        validateLoomCommandsConfig({ ...configFor(UNREACHABLE), actor: "" })
      ).toThrow("actor");
    });

    it("throws for relevant commands that are not a list of ids", () => {
      for (const relevant of ["search.run", [7]]) {
        expect(() =>
          validateLoomCommandsConfig({
            ...configFor(UNREACHABLE),
            relevant: relevant as unknown as string[],
          })
        ).toThrow("Relevant commands");
      }
    });

    it("throws for an empty run id, or one a header cannot carry", () => {
      for (const runId of ["", "job 1", "job\n1", "jöb"]) {
        expect(() =>
          validateLoomCommandsConfig({ ...configFor(UNREACHABLE), runId })
        ).toThrow("run id");
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

    it("keeps a schema typed whose `x-*` annotations alone pass the size bound", () => {
      expect(
        loomCommandEntryOfRow({
          id: "a.b",
          inputs: {
            type: "object",
            "x-help": "x".repeat(HARNESS_COMMAND_SCHEMA_MAX_BYTES),
            properties: { title: { type: "string" } },
          },
        })?.inputSchema,
      ).toEqual({ type: "object", properties: { title: { type: "string" } } });
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
    it("keeps every row the host listed, in order, whatever it declares, and counts unreadable ones", () => {
      const catalog = loomCommandCatalogOf([
        { id: "loom.compose" },
        { id: "share.invite", actors: ["user"], origins_refused: ["session"] },
        "not a row",
        { id: "-bad" },
        { id: "pv.abc", origin: "pattern" },
      ]);
      expect(catalog.entries.map((entry) => entry.name)).toEqual([
        "loom.compose",
        "share.invite",
        "pv.abc",
      ]);
      expect(catalog).toEqual(expect.objectContaining({ malformed: 2 }));
    });

    it("keeps every row past the Weaver's client-command catalog limit", () => {
      const rows = Array.from(
        { length: HARNESS_COMMAND_CATALOG_LIMIT + 70 },
        (_, index) => ({ id: `cmd.n${index}` }),
      );
      expect(loomCommandCatalogOf(rows).entries).toHaveLength(
        HARNESS_COMMAND_CATALOG_LIMIT + 70,
      );
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
    const manifest = { commands: [{ id: "loom.compose" }] };

    it("reads the host once for any number of uses, concurrent ones included", async () => {
      await using host = startCommandHost({
        list: () => Response.json(manifest),
      });
      const source = createLoomCommandCatalogSource(configFor(host.url));
      const reads = await Promise.all([source.current(), source.current()]);
      await source.current();
      expect(host.requests).toHaveLength(1);
      for (const read of reads) {
        expect(read).toMatchObject({
          status: "ok",
          catalog: { entries: [{ name: "loom.compose" }] },
        });
      }
    });

    it("reads the host again on refresh and holds what it read", async () => {
      await using host = startCommandHost({
        list: () => Response.json(manifest),
      });
      const source = createLoomCommandCatalogSource(configFor(host.url));
      await source.current();
      await source.refresh();
      await source.current();
      expect(host.requests).toHaveLength(2);
    });

    it("does not hold a read that failed, so the next use asks again", async () => {
      await using host = startCommandHost({
        list: () => new Response("no", { status: 503 }),
      });
      const source = createLoomCommandCatalogSource(configFor(host.url));
      expect(await source.current()).toMatchObject({
        status: "error",
        code: "command_failed",
      });
      await source.current();
      expect(host.requests).toHaveLength(2);
    });
  });

  describe("listLoomCommands()", () => {
    it("reads `GET <url>/commands` with the run's id", async () => {
      await using host = startCommandHost({
        list: () =>
          Response.json({ schema: "s", version: 1, commands: [{ id: "a.b" }] }),
      });
      expect(await listLoomCommands(configFor(`${host.url}/`))).toEqual({
        status: "ok",
        commands: [{ id: "a.b" }],
      });
      expect(host.requests).toEqual([
        { method: "GET", path: "/commands", runId: "job-1" },
      ]);
    });

    it("returns `command_failed` when nothing answers or the answer is not JSON", async () => {
      expect(await listLoomCommands(configFor(UNREACHABLE))).toMatchObject({
        status: "error",
        code: "command_failed",
      });
      await using host = startCommandHost({
        list: () => new Response("Traceback"),
      });
      expect(await listLoomCommands(configFor(host.url))).toMatchObject({
        status: "error",
        code: "command_failed",
      });
    });

    it("returns `command_failed` for a manifest the host answered with an error status", async () => {
      await using host = startCommandHost({
        list: () =>
          Response.json({ commands: [{ id: "a.b" }] }, { status: 500 }),
      });
      expect(await listLoomCommands(configFor(host.url))).toMatchObject({
        status: "error",
        code: "command_failed",
      });
    });

    it("returns `malformed_payload` for a manifest without a command list", async () => {
      for (const manifest of [[], { commands: {} }]) {
        await using host = startCommandHost({
          list: () => Response.json(manifest),
        });
        expect(await listLoomCommands(configFor(host.url))).toMatchObject({
          status: "error",
          code: "malformed_payload",
        });
      }
    });

    it("throws for an invalid configuration before sending anything", async () => {
      await using host = startCommandHost();
      await expect(
        listLoomCommands({ ...configFor(host.url), actor: "" }),
      ).rejects.toThrow("actor");
      expect(host.requests).toHaveLength(0);
    });
  });

  describe("runLoomCommand()", () => {
    it("posts the id, the args, the actor, and the loom and expected version as context", async () => {
      const answer = { ok: true, id: "loom.add", outputs: { version: 4 } };
      await using host = startCommandHost({ run: () => Response.json(answer) });
      const output = await runLoomCommand(configFor(host.url), {
        command: "loom.add",
        args: { ref: "page:A.md" },
        loomId: "loom-0123456789abcdef",
        expectedVersion: 3,
      });
      expect(output).toEqual({
        status: "ok",
        body: answer,
        bodyBytes: JSON.stringify(answer).length,
      });
      expect(host.requests).toEqual([{
        method: "POST",
        path: "/command",
        runId: "job-1",
        body: {
          id: "loom.add",
          args: { ref: "page:A.md" },
          context: { loom_id: "loom-0123456789abcdef", expected_version: 3 },
          actor: "agent:agent-runner",
        },
      }]);
    });

    it("leaves the context out when the invocation names neither a loom nor a version", async () => {
      await using host = startCommandHost();
      await runLoomCommand(configFor(host.url), {
        command: "search.run",
        args: {},
      });
      expect(host.requests[0].body).toEqual({
        id: "search.run",
        args: {},
        actor: "agent:agent-runner",
      });
    });

    it("returns the host's refusal as its answer, whatever the HTTP status", async () => {
      const refusal = { ok: false, code: "forbidden", error: "not for agents" };
      await using host = startCommandHost({
        run: () => Response.json(refusal, { status: 403 }),
      });
      expect(
        await runLoomCommand(configFor(host.url), { command: "a.b", args: {} }),
      ).toEqual({
        status: "ok",
        body: refusal,
        bodyBytes: JSON.stringify(refusal).length,
      });
    });

    it("returns an answer that may have landed when nothing answers or the answer is not JSON", async () => {
      const invocation = { command: "loom.compose", args: {} };
      expect(await runLoomCommand(configFor(UNREACHABLE), invocation)).toEqual({
        status: "error",
        code: "command_failed",
        message: "The host command's answer was lost.",
        landed: "unknown",
      });
      await using host = startCommandHost({
        run: () => new Response("Traceback", { status: 500 }),
      });
      expect(await runLoomCommand(configFor(host.url), invocation))
        .toMatchObject({
          status: "error",
          code: "command_failed",
          landed: "unknown",
        });
    });

    it("throws for an invalid configuration before sending anything", async () => {
      await using host = startCommandHost();
      await expect(
        runLoomCommand(
          { ...configFor(host.url), url: "loom" },
          { command: "a.b", args: {} },
        ),
      ).rejects.toThrow("endpoint");
      expect(host.requests).toHaveLength(0);
    });

    it("returns `malformed_payload` for JSON that is not a command result", async () => {
      for (const answer of [[], { ok: "yes" }]) {
        await using host = startCommandHost({
          run: () => Response.json(answer),
        });
        expect(
          await runLoomCommand(configFor(host.url), {
            command: "a.b",
            args: {},
          }),
        ).toMatchObject({
          status: "error",
          code: "malformed_payload",
          landed: "unknown",
        });
      }
    });
  });
});

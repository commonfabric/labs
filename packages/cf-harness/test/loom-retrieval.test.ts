import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type HarnessLoomRetrievalConfig,
  LOOM_SEARCH_SCHEMA_VERSION,
  loomRetrievalArgv,
  type LoomRetrievalCommand,
  readLoomReadCeilingRecord,
  readLoomRetrievalConfig,
  runLoomRetrievalCommand,
  validateLoomRetrievalConfig,
} from "../src/loom-retrieval.ts";
import type {
  ProcessRunRequest,
  ProcessRunResult,
} from "../src/sandbox/process-runner.ts";

/** A broker-routed host configuration. */
const broker: HarnessLoomRetrievalConfig = {
  cliPath: "/trusted/loom",
  transport: { kind: "broker", queuePath: "/trusted/queue" },
};

/** A direct configuration pinned to one instance. */
const direct: HarnessLoomRetrievalConfig = {
  cliPath: "/trusted/loom",
  transport: {
    kind: "direct",
    instanceDir: "/trusted/instance",
    runId: "run-1",
    actor: "agent:cf-harness",
  },
};

/** The smallest search payload the pinned schema version admits. */
const searchPayload = {
  schemaVersion: LOOM_SEARCH_SCHEMA_VERSION,
  query: "donuts",
  filters: {},
  hits: [],
  source_status: {},
  warnings: [],
  truncated: false,
};

/** Helper for tests, which records every process request and replies once. */
const runnerReplying = (
  result: Partial<ProcessRunResult>,
): {
  calls: ProcessRunRequest[];
  run(request: ProcessRunRequest): Promise<ProcessRunResult>;
} => {
  const calls: ProcessRunRequest[] = [];
  return {
    calls,
    run(request) {
      calls.push(request);
      return Promise.resolve({
        stdout: "",
        stderr: "",
        exitCode: 0,
        ...result,
      });
    },
  };
};

describe("loom-retrieval", () => {
  describe("validateLoomRetrievalConfig()", () => {
    it("throws for a relative CLI path, a relative ceiling file, an unsupported transport, and a malformed facet", () => {
      for (
        const config of [
          { ...broker, cliPath: "relative/loom" },
          { ...broker, readCeilingFile: "relative/ceiling.json" },
          { ...broker, transport: { kind: "broker", queuePath: "queue" } },
          { ...broker, transport: { kind: "unknown" } },
          { ...direct, transport: { ...direct.transport, runId: " run-1" } },
          {
            ...direct,
            transport: { ...direct.transport, instanceDir: "relative" },
          },
          { ...broker, facets: ["Work Stuff"] },
          { ...broker, facets: [] },
        ]
      ) {
        expect(() =>
          validateLoomRetrievalConfig(
            config as unknown as HarnessLoomRetrievalConfig,
          )
        ).toThrow();
      }
    });

    it("accepts the broker and direct transports with an absolute ceiling file and facet ids", () => {
      validateLoomRetrievalConfig({
        ...broker,
        readCeilingFile: "/trusted/ceiling.json",
        facets: ["work", "family-2"],
      });
      validateLoomRetrievalConfig(direct);
    });
  });

  describe("readLoomRetrievalConfig()", () => {
    it("returns `undefined` for no path and throws for a relative one", async () => {
      expect(await readLoomRetrievalConfig(undefined)).toBeUndefined();
      await expect(readLoomRetrievalConfig("relative.json")).rejects.toThrow();
    });

    it("returns the validated configuration the file holds", async () => {
      const config = await readLoomRetrievalConfig(
        "/trusted/config.json",
        () => Promise.resolve(JSON.stringify(broker)),
      );
      expect(config).toEqual(broker);
    });

    it("throws when the file lacks a CLI path or transport", async () => {
      await expect(
        readLoomRetrievalConfig(
          "/trusted/config.json",
          () => Promise.resolve(JSON.stringify({ cliPath: "/trusted/loom" })),
        ),
      ).rejects.toThrow();
    });
  });

  describe("loomRetrievalArgv()", () => {
    it("builds each command's argv with `--json`, and `--concise` where `page` takes it", () => {
      const cases: Record<LoomRetrievalCommand, [unknown, string[]]> = {
        search: [
          {
            query: "donuts",
            sources: "google.gmail,fc",
            since: "2026-09-01",
            until: "2026-09-18",
            tz: "America/Los_Angeles",
            person: "alice@example.com",
            limit: 5,
            rank: "score",
          },
          [
            "search",
            "donuts",
            "--json",
            "--sources",
            "google.gmail,fc",
            "--since",
            "2026-09-01",
            "--until",
            "2026-09-18",
            "--tz",
            "America/Los_Angeles",
            "--person",
            "alice@example.com",
            "--limit",
            "5",
            "--rank",
            "score",
          ],
        ],
        "page.discover": [
          { kind: "project", limit: 10 },
          [
            "page",
            "discover",
            "--json",
            "--concise",
            "--kind",
            "project",
            "--limit",
            "10",
          ],
        ],
        "page.inspect": [
          { target: "P-12" },
          ["page", "inspect", "P-12", "--json", "--concise"],
        ],
        "page.read": [
          { target: "People/Alice/about.md" },
          ["page", "read", "People/Alice/about.md", "--json"],
        ],
        people: [
          { query: "alice@example.com", shape: "summary" },
          ["people", "alice@example.com", "--json", "--shape", "summary"],
        ],
        "calendar.list": [
          { from: "2026-09-01", to: "2026-09-30" },
          [
            "calendar",
            "list",
            "--json",
            "--from",
            "2026-09-01",
            "--to",
            "2026-09-30",
          ],
        ],
        context: [
          { read: "activity", since: "now-30m", until: "now" },
          [
            "context",
            "activity",
            "--json",
            "--since",
            "now-30m",
            "--until",
            "now",
          ],
        ],
        profile: [{ fresh: true }, ["profile", "--json", "--fresh"]],
      };
      for (const [command, [input, argv]] of Object.entries(cases)) {
        expect(loomRetrievalArgv(command as LoomRetrievalCommand, input))
          .toEqual(argv);
      }
    });

    it("builds the shortest form of each command from its required fields alone", () => {
      expect(loomRetrievalArgv("search", { query: "donuts" })).toEqual([
        "search",
        "donuts",
        "--json",
      ]);
      expect(loomRetrievalArgv("search", { person: "alice@example.com" }))
        .toEqual(["search", "--json", "--person", "alice@example.com"]);
      expect(loomRetrievalArgv("page.discover", {})).toEqual([
        "page",
        "discover",
        "--json",
        "--concise",
      ]);
      expect(loomRetrievalArgv("calendar.list", { all: true })).toEqual([
        "calendar",
        "list",
        "--json",
        "--all",
      ]);
      expect(loomRetrievalArgv("context", { read: "where", at: "now-30m" }))
        .toEqual(["context", "where", "--json", "--at", "now-30m"]);
      expect(loomRetrievalArgv("profile", {})).toEqual(["profile", "--json"]);
    });

    it("throws for values the loom parser would read as flags or as other verbs", () => {
      for (
        const [command, input] of [
          ["search", {}],
          ["search", { query: "--list-sources" }],
          ["search", { query: "donuts", limit: 0 }],
          ["search", { query: "donuts", rank: "random" }],
          ["search", { query: "donuts", since: "-1d" }],
          ["page.inspect", { target: "--concise" }],
          ["page.inspect", {}],
          ["page.read", { target: "" }],
          ["page.discover", { kind: "all\n" }],
          ["people", { query: "revoke" }],
          ["people", { query: "list" }],
          ["people", { query: "group-add" }],
          ["people", { query: "Alice" }],
          ["people", { query: "alice@example.com", shape: "full" }],
          ["calendar.list", { from: "yesterday" }],
          ["calendar.list", { from: "2026-09-01", all: true }],
          ["context", { read: "hosted" }],
          ["context", {}],
          ["profile", "fresh"],
          ["profile", null],
          ["context", { read: "where", since: "now-30m" }],
          ["profile", { fresh: "yes" }],
        ] as const
      ) {
        expect(() => loomRetrievalArgv(command, input)).toThrow();
      }
    });

    it("throws for an input with a field the command does not take", () => {
      expect(() => loomRetrievalArgv("profile", { rpc_queue: "/tmp/q" }))
        .toThrow();
      expect(() => loomRetrievalArgv("search", { query: "x", engine: "index" }))
        .toThrow();
    });
  });

  describe("runLoomRetrievalCommand()", () => {
    it("runs the configured CLI over a cleared environment carrying only the broker queues", async () => {
      const runner = runnerReplying({ stdout: JSON.stringify(searchPayload) });
      const output = await runLoomRetrievalCommand(
        broker,
        "search",
        { query: "donuts" },
        runner,
      );
      expect(output).toEqual({ status: "ok", payload: searchPayload });
      expect(runner.calls).toHaveLength(1);
      const [call] = runner.calls;
      expect(call.command).toBe("/trusted/loom");
      expect(call.args).toEqual(["search", "donuts", "--json"]);
      expect(call.clearEnv).toBe(true);
      expect(call.stdinText).toBeUndefined();
      expect(call.env?.LOOM_PAGE_RPC_QUEUE).toBe("/trusted/queue");
      expect(call.env?.LOOM_SEARCH_BROKER_QUEUE).toBe("/trusted/queue");
      expect(call.env?.LOOM_INSTANCE_DIR).toBeUndefined();
      expect(typeof call.env?.PATH).toBe("string");
    });

    it("pins a direct call to the configured instance and run identity", async () => {
      const runner = runnerReplying({ stdout: JSON.stringify({ name: "Me" }) });
      await runLoomRetrievalCommand(direct, "profile", {}, runner);
      const [call] = runner.calls;
      expect(call.env?.LOOM_INSTANCE_DIR).toBe("/trusted/instance");
      expect(call.env?.LOOM_DISPATCH_ID).toBe("run-1");
      expect(call.env?.LOOM_PAGE_RPC_QUEUE).toBeUndefined();
      expect(call.args).toEqual(["profile", "--json"]);
    });

    it("returns `invalid_input` without starting a process for an input the argv builder refuses", async () => {
      const runner = runnerReplying({});
      const output = await runLoomRetrievalCommand(
        broker,
        "people",
        { query: "revoke" },
        runner,
      );
      expect(output.status).toBe("error");
      expect(output.status === "error" && output.code).toBe("invalid_input");
      expect(runner.calls).toHaveLength(0);
    });

    it("accepts a search payload that carries no `schemaVersion`", async () => {
      const { schemaVersion: _version, ...unversioned } = searchPayload;
      const output = await runLoomRetrievalCommand(
        broker,
        "search",
        { query: "donuts" },
        runnerReplying({ stdout: JSON.stringify(unversioned) }),
      );
      expect(output).toEqual({ status: "ok", payload: unversioned });
    });

    it("refuses a search payload whose `schemaVersion` is present and differs from the pinned one", async () => {
      for (
        const payload of [
          { ...searchPayload, schemaVersion: null },
          { ...searchPayload, schemaVersion: 2 },
          { ...searchPayload, schemaVersion: "1" },
        ]
      ) {
        const output = await runLoomRetrievalCommand(
          broker,
          "search",
          { query: "donuts" },
          runnerReplying({ stdout: JSON.stringify(payload) }),
        );
        expect(output).toEqual({
          status: "error",
          code: "schema_version_mismatch",
          message: expect.stringContaining("schemaVersion"),
        });
      }
    });

    it("does not ask a non-search payload for a schema version", async () => {
      const output = await runLoomRetrievalCommand(
        broker,
        "calendar.list",
        {},
        runnerReplying({ stdout: "[]" }),
      );
      expect(output).toEqual({ status: "ok", payload: [] });
    });

    it("returns `command_failed` for a nonzero exit or unparsable stdout, without relaying host text", async () => {
      for (
        const reply of [
          { exitCode: 2, stderr: "usage: loom search /private/path" },
          { exitCode: 0, stdout: "not json /private/path" },
        ]
      ) {
        const output = await runLoomRetrievalCommand(
          broker,
          "search",
          { query: "donuts" },
          runnerReplying(reply),
        );
        expect(output.status).toBe("error");
        if (output.status === "error") {
          expect(output.code).toBe("command_failed");
          expect(output.message).not.toContain("/private/path");
        }
      }
    });

    it("maps the people and search person exit codes to `not_found` and `contested`", async () => {
      for (
        const [command, input, exitCode, code] of [
          ["people", { query: "nobody@example.com" }, 1, "not_found"],
          ["people", { query: "alice@example.com" }, 3, "contested"],
          ["search", { person: "nobody@example.com" }, 1, "not_found"],
          ["search", { person: "alice@example.com" }, 3, "contested"],
        ] as const
      ) {
        const output = await runLoomRetrievalCommand(
          broker,
          command,
          input,
          runnerReplying({ exitCode, stderr: "Error: unknown person" }),
        );
        expect(output.status === "error" && output.code).toBe(code);
      }
    });

    it("reads a profile exiting 1 as a payload only when it says a fallback tier supplied it", async () => {
      const payload = { name: "Me", hasProfile: false, source: "basename" };
      const output = await runLoomRetrievalCommand(
        broker,
        "profile",
        {},
        runnerReplying({ exitCode: 1, stdout: JSON.stringify(payload) }),
      );
      expect(output).toEqual({ status: "ok", payload });
      for (
        const reply of [
          { exitCode: 1, stdout: JSON.stringify({ name: "Me" }) },
          { exitCode: 1, stdout: JSON.stringify({ hasProfile: true }) },
          { exitCode: 2, stdout: JSON.stringify(payload) },
        ]
      ) {
        const failed = await runLoomRetrievalCommand(
          broker,
          "profile",
          {},
          runnerReplying(reply),
        );
        expect(failed.status === "error" && failed.code).toBe(
          "command_failed",
        );
      }
    });

    it("returns `host_refused` with the host's code for a page payload the host refused", async () => {
      const output = await runLoomRetrievalCommand(
        broker,
        "page.inspect",
        { target: "P-404" },
        runnerReplying({
          exitCode: 1,
          stdout: JSON.stringify({
            ok: false,
            code: "unknown_page",
            error: "no page at /private/path",
          }),
        }),
      );
      expect(output).toEqual({
        status: "error",
        code: "host_refused",
        message: expect.not.stringContaining("/private/path"),
        hostCode: "unknown_page",
      });
    });

    it("returns `command_failed` when the process runner throws", async () => {
      const output = await runLoomRetrievalCommand(
        broker,
        "profile",
        {},
        { run: () => Promise.reject(new Error("spawn failed at /private")) },
      );
      expect(output.status === "error" && output.code).toBe("command_failed");
      expect(output.status === "error" && output.message).not.toContain(
        "/private",
      );
    });
  });

  describe("readLoomReadCeilingRecord()", () => {
    const record = {
      loomReadCeiling: ["https://cfc.test/owner", {
        anyOf: ["https://cfc.test/facet/work"],
      }],
      facets: ["work"],
      facetSource: "wish",
    };

    it("returns the clause list and facets the record carries", async () => {
      expect(
        await readLoomReadCeilingRecord(
          "/trusted/ceiling.json",
          () => Promise.resolve(JSON.stringify(record)),
        ),
      ).toEqual(record);
    });

    it("throws for a record that is unreadable, not an object, or missing a clause list or facets", async () => {
      for (
        const text of [
          "not json",
          "[]",
          JSON.stringify({ ...record, loomReadCeiling: [] }),
          JSON.stringify({ ...record, facets: [] }),
          JSON.stringify({ ...record, facetSource: "" }),
        ]
      ) {
        await expect(
          readLoomReadCeilingRecord(
            "/trusted/ceiling.json",
            () => Promise.resolve(text),
          ),
        ).rejects.toThrow();
      }
    });
  });
});

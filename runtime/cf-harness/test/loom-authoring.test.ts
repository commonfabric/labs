/** Checks transport attribution and receipt evidence for host Loom commands. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  executeLoomAuthoringCommand,
  type HarnessLoomAuthoringConfig,
  type LoomAuthoringCommand,
  readLoomAuthoringConfig,
  validateLoomAuthoringConfig,
} from "../src/loom-authoring.ts";
import type { ProcessRunRequest } from "../src/sandbox/process-runner.ts";

/** A composition the daemon committed. */
const receipt = {
  loom_id: "loom-1111111111111111",
  request_id: "collection-one",
  version: 2,
  created: true,
  component_ids: ["c-1"],
  operation_ids: ["op-1", "op-2"],
  displaced: [],
};

/** A current manifest beside the historical composition. */
const reply = {
  ok: true,
  result: {
    kind: "manifest",
    receipt,
    replayed: true,
    manifest: { loom_id: receipt.loom_id, version: 3, components: [] },
  },
};

/** Arguments retained across retries of one logical request. */
const input = {
  request_id: "collection-one",
  title: "Donut references",
  components: [{ ref: "url:https://example.com/donuts" }],
};

describe("loom-authoring", () => {
  const broker: HarnessLoomAuthoringConfig = {
    cliPath: "/trusted/loom",
    transport: { kind: "broker", queuePath: "/trusted/queue" },
  };

  it("rejects malformed operator routing and grants before offering tools", async () => {
    for (
      const config of [
        { ...broker, cliPath: "relative" },
        { ...broker, allowCommentThreads: "yes" },
        { ...broker, boundLoomId: "unbound" },
        { ...broker, transport: { kind: "broker", queuePath: "relative" } },
        { ...broker, transport: { kind: "unknown" } },
      ]
    ) {
      expect(() =>
        validateLoomAuthoringConfig(config as HarnessLoomAuthoringConfig)
      ).toThrow();
    }
    await expect(readLoomAuthoringConfig("relative")).rejects.toThrow();
    for (
      const value of [null, [], {}, {
        cliPath: "/trusted/loom",
        transport: null,
      }]
    ) {
      await expect(
        readLoomAuthoringConfig(
          "/trusted/config",
          () => Promise.resolve(JSON.stringify(value)),
        ),
      )
        .rejects.toThrow();
    }
  });

  it("rejects invalid requests before any process can apply a write", async () => {
    let calls = 0;
    const runner = {
      run: () => {
        calls++;
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify(reply),
          stderr: "",
        });
      },
    };
    const cases: [LoomAuthoringCommand, unknown][] = [
      ["unsupported" as LoomAuthoringCommand, {}],
      ["loom.compose", null],
      ["loom.inspect", {}],
      ["loom.inspect", { loom_id: "not-an-id" }],
      ["loom.compose", { ...input, expected_version: 3 }],
      ["loom.compose", {
        ...input,
        loom_id: receipt.loom_id,
        expected_version: 0,
      }],
      ...["", " ", "x\n", "x".repeat(201)].map((
        request_id,
      ): [LoomAuthoringCommand, unknown] => ["loom.compose", {
        ...input,
        request_id,
      }]),
      ...[null, [], Array(101).fill({ ref: "url:https://example.com" })].map((
        components,
      ): [LoomAuthoringCommand, unknown] => ["loom.compose", {
        ...input,
        components,
      }]),
    ];
    for (const [command, args] of cases) {
      expect(await executeLoomAuthoringCommand(broker, command, args, runner))
        .toMatchObject({ status: "error", mayHaveCommitted: false });
    }
    expect(calls).toBe(0);
    const result = await executeLoomAuthoringCommand(broker, "loom.compose", {
      ...input,
      loom_id: receipt.loom_id,
      expected_version: 1,
    }, {
      run: (request) => {
        expect(request.args.slice(-4)).toEqual([
          "--loom",
          receipt.loom_id,
          "--expect",
          "1",
        ]);
        expect(JSON.parse(request.stdinText!)).toEqual(input);
        return runner.run();
      },
    });
    expect(result.status).toBe("ok");
    expect(calls).toBe(1);
  });

  it("keeps unknown and unreadable write outcomes uncertain but never claims read commits", async () => {
    for (const command of ["loom.compose", "loom.inspect"] as const) {
      for (
        const response of [
          {
            exitCode: 1,
            stdout: JSON.stringify({ ok: false, error: "backend error" }),
            stderr: "",
          },
          { exitCode: 0, stdout: "null", stderr: "" },
          { exitCode: 0, stdout: "{broken", stderr: "" },
          null,
        ]
      ) {
        const result = await executeLoomAuthoringCommand(
          broker,
          command,
          command === "loom.compose" ? input : { loom_id: receipt.loom_id },
          {
            run: () =>
              response === null
                ? Promise.reject(new Error("lost connection"))
                : Promise.resolve(response),
          },
        );
        expect(result).toMatchObject({
          status: "error",
          mayHaveCommitted: command === "loom.compose",
        });
      }
    }
    for (const command of ["loom.inspect", "loom.authoring-context"] as const) {
      const result = await executeLoomAuthoringCommand(broker, command, {
        loom_id: receipt.loom_id,
      }, {
        run: () =>
          Promise.resolve({
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({ ok: true, result: {} }),
          }),
      });
      expect(result).toMatchObject({
        status: "error",
        mayHaveCommitted: false,
      });
    }
  });

  describe("executeLoomAuthoringCommand()", () => {
    it("preserves historical receipts when only the implicit origin is missing", async () => {
      const calls: ProcessRunRequest[] = [];
      const result = await executeLoomAuthoringCommand(
        {
          cliPath: "/trusted/loom",
          boundLoomId: "loom-2222222222222222",
          transport: { kind: "broker", queuePath: "/trusted/queue" },
        },
        "loom.authoring-context",
        {},
        {
          run(request) {
            calls.push(request);
            return Promise.resolve(
              request.args.includes("--loom")
                ? {
                  exitCode: 1,
                  stderr: "",
                  stdout: JSON.stringify({ ok: false, code: "no-loom" }),
                }
                : {
                  exitCode: 0,
                  stderr: "",
                  stdout: JSON.stringify({
                    ok: true,
                    result: {
                      kind: "authoring-context",
                      historical: true,
                      run_scoped: true,
                      authored: [{ receipt }],
                      bound_loom: null,
                      truncated: false,
                    },
                  }),
                },
            );
          },
        },
      );
      expect(result).toMatchObject({
        status: "ok",
        result: {
          authored: [{ receipt }],
          bound_loom: { loom_id: "loom-2222222222222222", available: false },
        },
      });
      expect(calls).toHaveLength(2);
      expect(calls[1].args).not.toContain("--loom");
    });

    it("does not reinterpret an explicitly missing target as an unbound history read", async () => {
      let calls = 0;
      const result = await executeLoomAuthoringCommand(
        {
          cliPath: "/trusted/loom",
          boundLoomId: "loom-1111111111111111",
          transport: { kind: "broker", queuePath: "/trusted/queue" },
        },
        "loom.authoring-context",
        { loom_id: "loom-2222222222222222" },
        {
          run() {
            calls++;
            return Promise.resolve({
              exitCode: 1,
              stderr: "",
              stdout: JSON.stringify({ ok: false, code: "no-loom" }),
            });
          },
        },
      );
      expect(result).toMatchObject({
        status: "error",
        code: "no-loom",
        mayHaveCommitted: false,
      });
      expect(calls).toBe(1);
    });

    it("rejects explicitly null targets instead of creating or choosing the implicit origin", async () => {
      for (
        const command of ["loom.compose", "loom.authoring-context"] as const
      ) {
        let calls = 0;
        const result = await executeLoomAuthoringCommand(
          {
            cliPath: "/trusted/loom",
            boundLoomId: "loom-1111111111111111",
            transport: { kind: "broker", queuePath: "/trusted/queue" },
          },
          command,
          { ...(command === "loom.compose" ? input : {}), loom_id: null },
          {
            run() {
              calls++;
              return Promise.resolve({
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify(reply),
              });
            },
          },
        );
        expect(result.status).toBe("error");
        expect(calls).toBe(0);
      }
    });

    it("rejects run ids that collapse under the host's whitespace normalization", () => {
      for (const runId of ["   ", " run-one", "run-one "]) {
        expect(() =>
          validateLoomAuthoringConfig({
            cliPath: "/trusted/loom",
            transport: {
              kind: "direct",
              instanceDir: "/trusted/instance",
              runId,
              actor: "agent:cf-harness",
            },
          })
        ).toThrow();
      }
    });

    it("distinguishes verified command refusals from unreadable commit outcomes", async () => {
      for (
        const code of [
          "version-conflict",
          "request-conflict",
          "bad-args",
          "no-loom",
        ]
      ) {
        const result = await executeLoomAuthoringCommand(
          {
            cliPath: "/trusted/loom",
            transport: { kind: "broker", queuePath: "/trusted/queue" },
          },
          "loom.compose",
          input,
          {
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
        );
        expect(result).toMatchObject({
          status: "error",
          code,
          mayHaveCommitted: false,
        });
      }
    });

    it("uses argv and stdin with the configured broker queue", async () => {
      const calls: ProcessRunRequest[] = [];
      const result = await executeLoomAuthoringCommand(
        {
          cliPath: "/trusted/loom",
          transport: { kind: "broker", queuePath: "/trusted/queue" },
        },
        "loom.compose",
        input,
        {
          run(request) {
            calls.push(request);
            return Promise.resolve({
              exitCode: 0,
              stdout: JSON.stringify(reply),
              stderr: "",
            });
          },
        },
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe("/trusted/loom");
      expect(calls[0].args).toEqual([
        "command",
        "run",
        "loom.compose",
        "--args-json",
        "-",
        "--json",
      ]);
      expect(JSON.parse(calls[0].stdinText!)).toEqual(input);
      expect(calls[0].clearEnv).toBe(true);
      expect(calls[0].env?.LOOM_PAGE_RPC_QUEUE).toBe("/trusted/queue");
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.result.receipt).toEqual(receipt);
        expect(result.result.replayed).toBe(true);
      }
    });

    it("pins direct calls to the configured instance, run, and agent", async () => {
      const calls: ProcessRunRequest[] = [];
      await executeLoomAuthoringCommand(
        {
          cliPath: "/trusted/loom",
          transport: {
            kind: "direct",
            instanceDir: "/trusted/instance",
            runId: "chat-session-one",
            actor: "agent:cf-harness",
          },
        },
        "loom.compose",
        input,
        {
          run(request) {
            calls.push(request);
            return Promise.resolve({
              exitCode: 0,
              stdout: JSON.stringify(reply),
              stderr: "",
            });
          },
        },
      );
      expect(calls[0].args.slice(0, 5)).toEqual([
        "command",
        "run",
        "--transport",
        "direct",
        "loom.compose",
      ]);
      expect(calls[0].env?.LOOM_INSTANCE_DIR).toBe("/trusted/instance");
      expect(calls[0].env?.LOOM_DISPATCH_ID).toBe("chat-session-one");
      expect(calls[0].args.slice(-2)).toEqual(["--actor", "agent:cf-harness"]);
    });

    it("returns uncertain failure for a mismatched or missing receipt", async () => {
      for (
        const result of [
          {},
          { ...reply.result, receipt: { ...receipt, request_id: "another" } },
          {
            ...reply.result,
            manifest: { loom_id: "loom-2222222222222222", version: 3 },
          },
        ]
      ) {
        const output = await executeLoomAuthoringCommand(
          {
            cliPath: "/trusted/loom",
            transport: { kind: "broker", queuePath: "/trusted/queue" },
          },
          "loom.compose",
          input,
          {
            run() {
              return Promise.resolve({
                exitCode: 0,
                stdout: JSON.stringify({ ok: true, result }),
                stderr: "",
              });
            },
          },
        );
        expect(output.status).toBe("error");
        if (output.status === "error") {
          expect(output.mayHaveCommitted).toBe(true);
        }
      }
    });

    it("refuses actor or transport arguments before spawning a process", async () => {
      let calls = 0;
      const output = await executeLoomAuthoringCommand(
        {
          cliPath: "/trusted/loom",
          transport: { kind: "broker", queuePath: "/trusted/queue" },
        },
        "loom.compose",
        { ...input, actor: "user" },
        {
          run() {
            calls++;
            return Promise.resolve({ exitCode: 1, stdout: "", stderr: "" });
          },
        },
      );
      expect(calls).toBe(0);
      expect(output.status).toBe("error");
    });
  });
});

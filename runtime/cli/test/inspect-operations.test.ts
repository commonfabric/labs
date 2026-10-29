import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Database } from "@db/sqlite";
import { toFileUrl } from "@std/path";
import { applyCommit, close, open } from "@commonfabric/memory/v2/engine";
import { toValuePath } from "@commonfabric/memory/v2";
import {
  CODEMIRROR_CHANGESET_CODEC,
  operationBaselineHash,
} from "@commonfabric/memory/v2/operation-codec";
import { inspect } from "../commands/inspect.ts";

async function output(argv: string[]): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => lines.push(values.join(" "));
  try {
    await inspect.parse(argv);
    return lines.join("\n");
  } finally {
    console.log = original;
  }
}

describe("cf inspect operations", () => {
  it("renders unavailable, empty, active, truncated, and JSON reports", async () => {
    const directory = await Deno.makeTempDir({ prefix: "inspect-operations-" });
    try {
      const oldStore = `${directory}/old.sqlite`;
      new Database(oldStore, { create: true }).close();
      expect(await output(["operations", oldStore])).toContain(
        "operation tables are absent",
      );

      const path = `${directory}/operations.sqlite`;
      const engine = await open({ url: toFileUrl(path) });
      try {
        applyCommit(engine, {
          sessionId: "session:setup",
          principal: "did:key:z6MkInspectOperations",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set" as const,
              id: "of:a",
              value: { value: { body: "x" } },
            }, {
              op: "set" as const,
              id: "of:b",
              value: { value: { body: "x" } },
            }, {
              op: "set" as const,
              id: "of:user-scoped",
              scope: "user" as const,
              value: { value: { body: "user" } },
            }, {
              op: "set" as const,
              id: "of:session-scoped",
              scope: "session" as const,
              value: { value: { body: "session" } },
            }],
          },
        });
        applyCommit(engine, {
          sessionId: "session:writer",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: ["a", "b"].map((name) => ({
              op: "apply-op" as const,
              id: `of:${name}`,
              path: toValuePath(["body"]),
              codec: CODEMIRROR_CHANGESET_CODEC,
              submissionId: `${name}:1`,
              base: null,
              baselineHash: operationBaselineHash("x"),
              payload: {
                updates: [{ clientId: name, changes: [1, [0, "y"]] }],
              },
            })),
          },
        });
        applyCommit(engine, {
          sessionId: "session:writer",
          commit: {
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "apply-op",
              id: "of:b",
              path: toValuePath(["body"]),
              codec: CODEMIRROR_CHANGESET_CODEC,
              submissionId: "b:2",
              base: { epoch: 1, version: 1 },
              payload: {
                updates: [{
                  clientId: "b",
                  changes: [2, [0, "z"]],
                }],
              },
            }, {
              op: "release-op-field",
              id: "of:b",
              path: toValuePath(["body"]),
              codec: CODEMIRROR_CHANGESET_CODEC,
              cursor: { epoch: 1, version: 2 },
            }],
          },
        });
      } finally {
        close(engine);
      }

      const corrupt = new Database(path);
      try {
        corrupt.prepare(
          "DELETE FROM op_checkpoint WHERE id = ? AND version = 0",
        ).run("of:b");
      } finally {
        corrupt.close();
      }

      expect(await output(["operations", path, "of:missing"])).toContain(
        "no collaborative operation fields",
      );
      const human = await output(["operations", path, "--limit", "1"]);
      expect(human).toContain("active\tof:a");
      expect(human).toContain("submissions=1 integrated=1 checkpoints=1");
      expect(human).toContain("field list truncated at 1");

      const unhealthy = await output([
        "operations",
        path,
        "of:b",
        "--history-limit",
        "1",
      ]);
      expect(unhealthy).toContain("inactive\tof:b");
      expect(unhealthy).toContain("INCONSISTENT");
      expect(unhealthy).toContain("submissions=1+ integrated=1+");

      const json = JSON.parse(
        await output([
          "operations",
          path,
          "of:a",
          "--json",
        ]),
      );
      expect(json.fields[0].address.id).toBe("of:a");

      const scopes = await output(["scopes", path]);
      expect(scopes).toContain("3 scope(s)");
      expect(scopes).toContain("user z6MkInsp…ions");
      expect(scopes).toContain("session z6MkInsp…ions/session:");
      expect(scopes).toContain("inspect overlay");
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });
});

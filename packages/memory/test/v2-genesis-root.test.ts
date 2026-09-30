import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { toFileUrl } from "@std/path";
import * as Engine from "../v2/engine.ts";
import { encodeMemoryBoundary } from "../v2.ts";
import { readGenesisRoot } from "../v2/genesis-root.ts";

const space = "did:key:root-test-space";
const root = {
  source: "system:loom/main.tsx",
  cause: "test-publication",
  argument: { title: "A Loom" },
};

describe("v2-genesis-root", () => {
  it("refuses malformed durable root reservations instead of adopting an invalid source", async () => {
    const engine = await Engine.open({
      url: new URL("memory://invalid-genesis-receipt"),
    });
    const commit = {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set" as const, id: "of:root", value: { value: {} } }],
      genesisRoot: root,
    };
    try {
      expect(readGenesisRoot(engine)).toBeUndefined();
      Engine.applyCommit(engine, {
        sessionId: "bootstrap",
        space,
        principal: space,
        commit,
      });
      engine.database.prepare(
        'UPDATE "commit" SET original = ? WHERE seq = 1',
      ).run("truncated durable receipt");
      expect(() => readGenesisRoot(engine)).toThrow("Invalid genesis receipt");
      for (
        const invalid of [
          null,
          {},
          ...[
            null,
            [],
            "root",
            { ...root, cause: "" },
            {
              ...root,
              cause: "x".repeat(513),
            },
            { ...root, source: "system:loom/data.json" },
            {
              ...root,
              sourceRoots: [false],
            },
          ].map((genesisRoot) => ({ ...commit, genesisRoot })),
          {
            ...commit,
            genesisRoot: {
              source: "https://untrusted.example/main.tsx",
              cause: "x",
            },
          },
          {
            ...commit,
            genesisRoot: { ...root, sourceRoots: ["system:../outside.tsx"] },
          },
        ]
      ) {
        engine.database.prepare(
          'UPDATE "commit" SET original = ? WHERE seq = 1',
        ).run(encodeMemoryBoundary(invalid));
        expect(() => readGenesisRoot(engine)).toThrow(
          "Invalid genesis receipt",
        );
      }
    } finally {
      Engine.close(engine);
    }
  });

  it("retains the root reservation atomically across a store restart", async () => {
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    let engine = await Engine.open({ url: toFileUrl(path) });
    try {
      Engine.applyCommit(engine, {
        sessionId: "bootstrap",
        space,
        principal: space,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          genesisRoot: root,
          operations: [{
            op: "set",
            id: `of:${space}`,
            value: { value: { ["did:key:manager"]: "OWNER" } },
          }],
        },
      });
      expect(readGenesisRoot(engine)).toEqual(root);
      Engine.close(engine);
      engine = await Engine.open({ url: toFileUrl(path) });
      expect(readGenesisRoot(engine)).toEqual(root);
    } finally {
      Engine.close(engine);
      await Deno.remove(path);
    }
  });
});

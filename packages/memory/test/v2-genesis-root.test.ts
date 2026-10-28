import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { toFileUrl } from "@std/path";
import * as Engine from "../v2/engine.ts";
import { encodeMemoryBoundary, type GenesisRoot } from "../v2.ts";
import {
  isGenesisRoot,
  readGenesisRoot,
  readSpaceKind,
} from "../v2/genesis-root.ts";

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
          {
            ...commit,
            genesisRoot: { cause: "creator-root", argument: { title: "x" } },
          },
          {
            ...commit,
            genesisRoot: {
              cause: "creator-root",
              sourceRoots: ["system:loom/main.test.tsx"],
            },
          },
          { ...commit, genesisRoot: { cause: "" } },
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

  it("reads back a creator-placed reservation, which names a cause and no source", async () => {
    const engine = await Engine.open({
      url: new URL("memory://creator-placed-genesis-receipt"),
    });
    const creatorRoot = { cause: "in-space-root" };
    try {
      Engine.applyCommit(engine, {
        sessionId: "bootstrap",
        space,
        principal: space,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          genesisRoot: creatorRoot,
          operations: [{
            op: "set",
            id: `of:${space}`,
            value: { value: { ["did:key:manager"]: "OWNER" } },
          }],
        },
      });
      expect(readGenesisRoot(engine)).toEqual(creatorRoot);
    } finally {
      Engine.close(engine);
    }
  });

  it("types a reservation naming no source as one naming nothing to create the root from", () => {
    const creatorPlaced: GenesisRoot = { cause: "creator-root" };
    const sourced: GenesisRoot = {
      ...root,
      sourceRoots: ["system:loom/main.test.tsx"],
    };
    // @ts-expect-error: `sourceRoots` without a `source`.
    const withSourceRoots: GenesisRoot = {
      cause: "creator-root",
      sourceRoots: ["system:loom/main.test.tsx"],
    };
    // @ts-expect-error: `argument` without a `source`.
    const withArgument: GenesisRoot = {
      cause: "creator-root",
      argument: { title: "A Loom" },
    };
    expect([creatorPlaced, sourced].map(isGenesisRoot)).toEqual([true, true]);
    expect([withSourceRoots, withArgument].map(isGenesisRoot)).toEqual([
      false,
      false,
    ]);
  });

  it("reads back the kind a genesis receipt declares, and none from one that declares none", async () => {
    const engine = await Engine.open({
      url: new URL("memory://space-kind-genesis-receipt"),
    });
    const genesis = {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set" as const,
        id: `of:${space}`,
        value: { value: { ["did:key:manager"]: "OWNER" } },
      }],
    };
    try {
      expect(readSpaceKind(engine)).toBeUndefined();
      Engine.applyCommit(engine, {
        sessionId: "bootstrap",
        space,
        principal: space,
        commit: { ...genesis, spaceKind: "fabrichat-room" },
      });
      expect(readSpaceKind(engine)).toBe("fabrichat-room");
      engine.database.prepare(
        'UPDATE "commit" SET original = ? WHERE seq = 1',
      ).run(encodeMemoryBoundary(genesis));
      expect(readSpaceKind(engine)).toBeUndefined();
    } finally {
      Engine.close(engine);
    }
  });

  it("reads a receipt whose kind is not well formed as declaring none, and leaves its root reservation readable", async () => {
    const engine = await Engine.open({
      url: new URL("memory://malformed-space-kind-receipt"),
    });
    const commit = {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      genesisRoot: root,
      operations: [{
        op: "set" as const,
        id: `of:${space}`,
        value: { value: { ["did:key:manager"]: "OWNER" } },
      }],
    };
    try {
      Engine.applyCommit(engine, {
        sessionId: "bootstrap",
        space,
        principal: space,
        commit,
      });
      for (const spaceKind of ["Fabrichat Room", "", 7, { kind: "notebook" }]) {
        engine.database.prepare(
          'UPDATE "commit" SET original = ? WHERE seq = 1',
        ).run(encodeMemoryBoundary({ ...commit, spaceKind }));
        expect(readSpaceKind(engine)).toBeUndefined();
        expect(readGenesisRoot(engine)).toEqual(root);
      }
    } finally {
      Engine.close(engine);
    }
  });

  it("reads a genesis receipt that holds no commit as declaring no kind, where reading its root throws", async () => {
    const engine = await Engine.open({
      url: new URL("memory://non-commit-space-kind-receipt"),
    });
    try {
      Engine.applyCommit(engine, {
        sessionId: "bootstrap",
        space,
        principal: space,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          spaceKind: "notebook",
          operations: [{
            op: "set",
            id: `of:${space}`,
            value: { value: { ["did:key:manager"]: "OWNER" } },
          }],
        },
      });
      for (
        const receipt of [
          encodeMemoryBoundary({
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            spaceKind: "notebook",
          }),
          encodeMemoryBoundary({ spaceKind: "notebook" }),
          "truncated durable receipt",
        ]
      ) {
        engine.database.prepare(
          'UPDATE "commit" SET original = ? WHERE seq = 1',
        ).run(receipt);
        expect(readSpaceKind(engine)).toBeUndefined();
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

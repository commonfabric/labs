import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  TEST_MEMORY_SERVER_AUTH,
  testPrincipalSessionOpenAuthFactory,
} from "./memory-v2-test-utils.ts";

// Resume owned-cell pre-sync for a pattern with a static nested sub-pattern node.
//
// On a cold resume, the runner walks the pattern tree and pre-syncs each
// sub-pattern's owned (derived internal) cells before instantiation, so the
// resume instantiation commit reads confirmed-loaded state and stays
// read-mostly. The walk derives each child node's result cell from its output
// redirect, resolved the same way the minting path resolves it.
//
// This is a coverage-and-smoke test: it drives the owned-cell walk and its
// redirect resolution and asserts the nested value survives a cold reload. It
// does not by itself distinguish resolving the redirect to its end from taking
// the unresolved head, because this single-hop binding makes those the same
// cell — the multi-hop case where they differ is exercised by the home
// rehydration churn integration test (nested profile patterns), which would
// regress to commit churn if the walk pre-synced the wrong subtree.

const signer = await Identity.fromPassphrase("resume owned cells");
const space = signer.did();

function plainLoopback(
  server: MemoryV2Server.Server,
): MemoryV2Client.Transport {
  return MemoryV2Client.loopback(server);
}

class LoopbackSessionFactory implements SessionFactory {
  readonly #getServer: () => MemoryV2Server.Server;

  constructor(getServer: () => MemoryV2Server.Server) {
    this.#getServer = getServer;
  }
  async create(spaceId: string, sgnr?: Signer) {
    const client = await MemoryV2Client.connect({
      transport: plainLoopback(this.#getServer()),
    });
    const session = await client.mount(
      spaceId,
      {},
      testPrincipalSessionOpenAuthFactory(sgnr),
    );
    return { client, session };
  }
}

class LoopbackStorageManager extends StorageManager {
  static make(
    as: Identity,
    server: MemoryV2Server.Server,
  ): LoopbackStorageManager {
    return new LoopbackStorageManager(
      { as, memoryHost: new URL("memory://") } as Options,
      server,
    );
  }
  private constructor(options: Options, server: MemoryV2Server.Server) {
    super(options, new LoopbackSessionFactory(() => server));
  }
  override registerSpaceHostDetailed() {
    return { accepted: false, reason: "no-remote-resolution" } as const;
  }
}

// An outer pattern that statically composes an inner sub-pattern; the inner
// pattern keeps a derived internal cell (the lifted scaled value), so the resume
// walk has an owned cell to pre-sync for the nested node.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { lift, pattern } from 'commonfabric';",
      "const scale = lift((n: number) => n * 10);",
      "const inner = pattern<{ n: number }>(({ n }) => {",
      "  return { scaled: scale(n) };",
      "});",
      "export default pattern<{ seed: number }>(({ seed }) => {",
      "  const child = inner({ n: seed });",
      "  return { value: child.scaled };",
      "});",
    ].join("\n"),
  }],
};

// Three sibling sub-pattern nodes of the SAME inner pattern type. Their result
// cells are minted from distinct reserved output spots (x/y/z), the structure
// most likely to collide if the walk's cycle key were not identity-safe. Each
// child owns its own derived `scaled` cell, so a skipped sibling would drop that
// cell from the resume pre-sync set.
const SIBLINGS_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { lift, pattern } from 'commonfabric';",
      "const scale = lift((n: number) => n * 10);",
      "const inner = pattern<{ n: number }>(({ n }) => {",
      "  return { scaled: scale(n) };",
      "});",
      "export default pattern<{ a: number; b: number; c: number }>(({ a, b, c }) => {",
      "  const x = inner({ n: a });",
      "  const y = inner({ n: b });",
      "  const z = inner({ n: c });",
      "  return { x: x.scaled, y: y.scaled, z: z.scaled };",
      "});",
    ].join("\n"),
  }],
};

describe("resume owned-cell pre-sync", () => {
  let server: MemoryV2Server.Server;
  let sm1: LoopbackStorageManager;
  let sm2: LoopbackStorageManager;

  beforeEach(() => {
    server = new MemoryV2Server.Server({
      authorizeSessionOpen(message) {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
    });
    sm1 = LoopbackStorageManager.make(signer, server);
    sm2 = LoopbackStorageManager.make(signer, server);
  });
  afterEach(async () => {
    await sm1?.close();
    await sm2?.close();
    await server?.close();
  });

  it("resumes a nested sub-pattern's value from durable state", async () => {
    // CREATE (runtime A): run the composed pattern and persist its value.
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm1,
    });
    const compiled1 = await rt1.patternManager.compilePattern(PROGRAM, {
      space,
    });
    const tx0 = rt1.edit();
    const rc1 = rt1.getCell<{ value: number }>(
      space,
      "owned-result",
      compiled1.resultSchema,
      tx0,
    );
    const h1 = rt1.run(tx0, compiled1, { seed: 7 }, rc1);
    await tx0.commit();
    for (let k = 0; k < 10; k++) {
      await h1.pull();
      await rt1.idle();
    }
    await rt1.patternManager.flushCompileCacheWrites();
    await sm1.synced();
    expect(rc1.key("value").get()).toBe(70);
    await rt1.dispose({ closeStorage: false });

    // RESUME (runtime B): cold cache. start() walks the pattern tree and
    // pre-syncs the nested node's owned cells before instantiating.
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm2,
    });
    try {
      await rt2.patternManager.compilePattern(PROGRAM, { space });
      const tx = rt2.edit();
      const rc2 = rt2.getCell<{ value: number }>(
        space,
        "owned-result",
        compiled1.resultSchema,
        tx,
      );
      await tx.commit();

      const started = await rt2.start(rc2);
      expect(started).toBe(true);

      for (let k = 0; k < 10; k++) {
        await rc2.pull();
        await rt2.idle();
      }
      expect(rc2.key("value").get()).toBe(70);
    } finally {
      await rt2.dispose({ closeStorage: false });
    }
  });

  it("pre-syncs every same-type sibling sub-pattern across a cold resume", async () => {
    // Drives the real owned-cell walk over three sibling nodes of the same inner
    // pattern. If the cycle key collided across siblings, the walk would skip a
    // sibling's subtree; here every sibling's owned `scaled` cell must survive
    // the cold resume with its own value.
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm1,
    });
    const compiled1 = await rt1.patternManager.compilePattern(
      SIBLINGS_PROGRAM,
      {
        space,
      },
    );
    const tx0 = rt1.edit();
    const rc1 = rt1.getCell<{ x: number; y: number; z: number }>(
      space,
      "siblings-result",
      compiled1.resultSchema,
      tx0,
    );
    const h1 = rt1.run(tx0, compiled1, { a: 1, b: 2, c: 3 }, rc1);
    await tx0.commit();
    for (let k = 0; k < 10; k++) {
      await h1.pull();
      await rt1.idle();
    }
    await rt1.patternManager.flushCompileCacheWrites();
    await sm1.synced();
    expect([
      rc1.key("x").get(),
      rc1.key("y").get(),
      rc1.key("z").get(),
    ]).toEqual([10, 20, 30]);
    await rt1.dispose({ closeStorage: false });

    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm2,
    });
    try {
      await rt2.patternManager.compilePattern(SIBLINGS_PROGRAM, { space });
      const tx = rt2.edit();
      const rc2 = rt2.getCell<{ x: number; y: number; z: number }>(
        space,
        "siblings-result",
        compiled1.resultSchema,
        tx,
      );
      await tx.commit();

      const started = await rt2.start(rc2);
      expect(started).toBe(true);

      for (let k = 0; k < 10; k++) {
        await rc2.pull();
        await rt2.idle();
      }
      // All three siblings resumed with their own distinct values — no sibling
      // was conflated or dropped by the cycle key.
      expect([
        rc2.key("x").get(),
        rc2.key("y").get(),
        rc2.key("z").get(),
      ]).toEqual([10, 20, 30]);
    } finally {
      await rt2.dispose({ closeStorage: false });
    }
  });
});

describe("resume owned-cell walk cycle-detection key", () => {
  // Direct refutation of the review note:
  // "Cycle-detection key is not identity-safe; collisions can skip sub-pattern
  //  traversal and miss required pre-sync cells on resume."
  //
  // collectResumeOwnedCells dedups sub-pattern nodes on
  // `${space}\0${id}\0${scope}` (runner.ts). The id is the content-addressed
  // entity id createRef() mints from the child node's resultFor cause {space,
  // id, path}, so the output-spot path that distinguishes sibling nodes is
  // already folded into the id. These tests mint child result cells exactly the
  // way the walk does and show the key is injective over distinct nodes:
  // distinct nodes get distinct keys, the \0 delimiter is unambiguous because
  // every component is null-free, and only a genuinely identical node
  // collapses.

  let keyServer: MemoryV2Server.Server;
  let keySm: LoopbackStorageManager;
  let rt: Runtime;

  beforeEach(() => {
    keyServer = new MemoryV2Server.Server({
      authorizeSessionOpen(message) {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
    });
    keySm = LoopbackStorageManager.make(signer, keyServer);
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: keySm,
    });
  });
  afterEach(async () => {
    await rt.dispose();
    await keySm.close();
    await keyServer.close();
  });

  // Mirror of the walk's cycle key (collectResumeOwnedCells in runner.ts).
  const cycleKey = (cell: Cell<any>): string => {
    const l = cell.getAsNormalizedFullLink();
    return `${l.space}\0${l.id}\0${l.scope ?? "space"}`;
  };

  // Mint a child result cell the way the walk does: from a resultFor cause over
  // the resolved output spot {space, id, path}, with an optional cell scope.
  const mint = (
    causeId: string,
    path: string[],
    scope: "space" | "user" | "session" = "space",
  ): Cell<any> =>
    rt.getCell(
      space,
      { resultFor: { space, id: causeId, path } },
      undefined,
      undefined,
      scope,
    );

  it("gives distinct sub-pattern nodes distinct keys", () => {
    const cells = [
      mint("of:spot-a", ["value"]),
      mint("of:spot-b", ["value"]), // sibling: different output spot
      mint("of:spot-a", ["other"]), // same spot id, different path
      mint("of:spot-a", ["a", "b"]), // multi-component path
      mint("of:spot-a", ["ab"]), // would join-collide with ["a","b"] under a delimiter
      mint("of:spot-a", ["a\x00b"]), // a path component that itself contains the delimiter
    ];
    const keys = cells.map(cycleKey);
    expect(new Set(keys).size).toBe(cells.length); // injective: no collisions

    // The \0 delimiter is unambiguous because no component can carry a null byte:
    // space is a DID, id is an `of:` content hash, scope is one of three literals.
    for (const c of cells) {
      const l = c.getAsNormalizedFullLink();
      expect(l.space).not.toContain("\0");
      expect(String(l.id)).not.toContain("\0");
      expect(String(l.scope ?? "space")).not.toContain("\0");
    }
  });

  it("captures scope, so the three cell scopes do not collide", () => {
    const keys = [
      mint("of:spot", ["value"], "space"),
      mint("of:spot", ["value"], "user"),
      mint("of:spot", ["value"], "session"),
    ].map(cycleKey);
    expect(new Set(keys).size).toBe(3);
  });

  it("collapses only a genuinely identical node", () => {
    // Same cause and scope -> same cell -> same key. The dedup fires for a real
    // cycle, never for a distinct sibling.
    expect(cycleKey(mint("of:spot", ["value"]))).toBe(
      cycleKey(mint("of:spot", ["value"])),
    );
  });

  it("separates siblings by the entity id, which the omitted path folds into", () => {
    const siblings = [
      mint("of:spot", ["x"]),
      mint("of:spot", ["y"]),
      mint("of:spot", ["z"]),
    ];
    // A key that dropped the id (the reviewer's feared shape) WOULD collide for
    // these sibling spots...
    const naiveKey = (cell: Cell<any>): string => {
      const l = cell.getAsNormalizedFullLink();
      return `${l.space}\0${l.scope ?? "space"}`;
    };
    expect(new Set(siblings.map(naiveKey)).size).toBe(1);
    // ...but the real key does not, because the path is folded into the id, so
    // the id alone already differs across the siblings.
    expect(new Set(siblings.map(cycleKey)).size).toBe(3);
    expect(
      new Set(siblings.map((c) => String(c.getAsNormalizedFullLink().id))).size,
    )
      .toBe(3);
  });
});

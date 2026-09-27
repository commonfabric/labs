import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import {
  TEST_MEMORY_SERVER_AUTH,
  testPrincipalSessionOpenAuthFactory,
} from "./memory-v2-test-utils.ts";

// Convergence guard for the list-builtin resume preservation.
//
// The reload preservation holds the durable aggregate while a per-element result
// is still streaming in, so the list doesn't flicker to empty. The risk is that
// it cannot tell "still loading" from "settled undefined" and so freezes a
// genuine shrink. These tests exercise a steady-state (non-resume) shrink: an
// element's per-element result legitimately settles undefined, so the aggregate
// should get shorter, and the builtin must publish that shrink rather than pin
// the longer prior value.

const signer = await Identity.fromPassphrase("list shrink converge");
const space = signer.did();

function lb(s: MemoryV2Server.Server) {
  return MemoryV2Client.loopback(s);
}
class F implements SessionFactory {
  #gs: () => MemoryV2Server.Server;

  constructor(gs: () => MemoryV2Server.Server) {
    this.#gs = gs;
  }
  async create(spaceId: string, sgnr?: Signer) {
    const client = await MemoryV2Client.connect({ transport: lb(this.#gs()) });
    const session = await client.mount(
      spaceId,
      {},
      testPrincipalSessionOpenAuthFactory(sgnr),
    );
    return { client, session };
  }
}
class SM extends StorageManager {
  static make(as: Identity, s: MemoryV2Server.Server) {
    return new SM({ as, memoryHost: new URL("memory://") } as Options, s);
  }
  private constructor(o: Options, s: MemoryV2Server.Server) {
    super(o, new F(() => s));
  }
  override registerSpaceHostDetailed() {
    return { accepted: false, reason: "no-remote-resolution" } as const;
  }
}

function runtime() {
  const server = new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });
  const sm = SM.make(signer, server);
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: sm,
  });
  return { rt, server };
}

// The pattern returns `items` too, so the test can mutate an element through the
// result cell and have the predicate/op re-evaluate.
const FILTER_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { keep?: boolean; label: string }[] }>(({ items }) => {",
      "  return { items, kept: items.filter((item) => item.keep) };",
      "});",
    ].join("\n"),
  }],
};

const FLATMAP_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { keep?: boolean; n: number }[] }>(({ items }) => {",
      "  return { items, values: items.flatMap((item) => item.keep ? item.n : undefined) };",
      "});",
    ].join("\n"),
  }],
};

describe("list builtin steady-state shrink convergence", () => {
  it("filter: a predicate that settles undefined drops its element", async () => {
    const { rt, server } = runtime();
    try {
      const compiled = await rt.patternManager.compilePattern(FILTER_PROGRAM, {
        space,
      });
      const tx0 = rt.edit();
      const rc = rt.getCell<{ kept: { label: string }[] }>(
        space,
        "shrink-filter",
        compiled.resultSchema,
        tx0,
      );
      rt.run(tx0, compiled, {
        items: [
          { keep: true, label: "a" },
          { keep: true, label: "b" },
          { keep: true, label: "c" },
        ],
      }, rc);
      await tx0.commit();
      for (let k = 0; k < 10; k++) {
        await rc.pull();
        await rt.idle();
      }
      expect(
        (rc.key("kept").getAsQueryResult() ?? []).map((x: { label: string }) =>
          x.label
        ),
      ).toEqual(["a", "b", "c"]);

      // b's predicate settles undefined -> b drops.
      const tx1 = rt.edit();
      rc.withTx(tx1).key("items").key(1).key("keep").set(undefined as never);
      await tx1.commit();
      for (let k = 0; k < 10; k++) {
        await rc.pull();
        await rt.idle();
      }
      expect(
        (rc.key("kept").getAsQueryResult() ?? []).map((x: { label: string }) =>
          x.label
        ),
      ).toEqual(["a", "c"]);
    } finally {
      await rt.dispose();
      await server.close();
    }
  });

  it("flatMap: an op that settles undefined drops its element", async () => {
    const { rt, server } = runtime();
    try {
      const compiled = await rt.patternManager.compilePattern(FLATMAP_PROGRAM, {
        space,
      });
      const tx0 = rt.edit();
      const rc = rt.getCell<{ values: number[] }>(
        space,
        "shrink-flatmap",
        compiled.resultSchema,
        tx0,
      );
      rt.run(tx0, compiled, {
        items: [
          { keep: true, n: 1 },
          { keep: true, n: 2 },
          { keep: true, n: 3 },
        ],
      }, rc);
      await tx0.commit();
      for (let k = 0; k < 10; k++) {
        await rc.pull();
        await rt.idle();
      }
      expect(rc.key("values").getAsQueryResult() ?? []).toEqual([1, 2, 3]);

      // The middle element's op settles undefined (skip) -> [1,3].
      const tx1 = rt.edit();
      rc.withTx(tx1).key("items").key(1).key("keep").set(false as never);
      await tx1.commit();
      for (let k = 0; k < 10; k++) {
        await rc.pull();
        await rt.idle();
      }
      expect(rc.key("values").getAsQueryResult() ?? []).toEqual([1, 3]);
    } finally {
      await rt.dispose();
      await server.close();
    }
  });
});

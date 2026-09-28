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
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  newSharedServer,
  testPrincipalSessionOpenAuthFactory,
} from "./memory-v2-test-utils.ts";

// awaitInputThenSettle path in the list builtins (filter/flatMap/map).
//
// On a resume reconcile the builtin can find its durable result container
// already loaded and non-empty (priorLen > 0) while the input list reads empty
// or undefined. Writing [] then would clobber the durable aggregate before the
// input is confirmed, so the builtin holds the durable value and awaits the
// input, clearing the result only once the input confirms genuinely empty
// (otherwise re-reconciling and converging).
//
// This drives that path with a durable state that is inconsistent the way a
// stale container is: the first runtime builds a non-empty result, then — with
// the builtin's action stopped so it cannot react — sets the input list to []
// and persists that. On resume the reconcile reads priorLen > 0 with an empty
// input, takes awaitInputThenSettle, and settles the result to [].

const signer = await Identity.fromPassphrase("list resume input settle");
const space = signer.did();

function loopback(s: MemoryV2Server.Server) {
  return MemoryV2Client.loopback(s);
}
class F implements SessionFactory {
  #gs: () => MemoryV2Server.Server;

  constructor(gs: () => MemoryV2Server.Server) {
    this.#gs = gs;
  }
  async create(id: string, s?: Signer) {
    const client = await MemoryV2Client.connect({
      transport: loopback(this.#gs()),
    });
    const session = await client.mount(
      id,
      {},
      testPrincipalSessionOpenAuthFactory(s),
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

// Each pattern returns `items` too, so the test can overwrite the input list
// through the result cell after the builtin's action is stopped.
const FILTER_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { keep: boolean; label: string }[] }>(({ items }) => {",
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
      "export default pattern<{ items: { keep: boolean; n: number }[] }>(({ items }) => {",
      "  return { items, values: items.flatMap((item) => item.keep ? item.n : undefined) };",
      "});",
    ].join("\n"),
  }],
};
const MAP_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { n: number }[] }>(({ items }) => {",
      "  return { items, doubled: items.map((item) => item.n * 2) };",
      "});",
    ].join("\n"),
  }],
};

describe("list builtin resume input-settle", () => {
  let server: MemoryV2Server.Server;

  beforeEach(() => {
    server = newSharedServer();
  });
  afterEach(async () => {
    await server.close();
  });

  async function run(
    program: RuntimeProgram,
    id: string,
    field: string,
    items: unknown[],
    builtValue: unknown[],
  ): Promise<void> {
    const sm1 = SM.make(signer, server);
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm1,
    });
    const compiled = await rt1.patternManager.compilePattern(program, {
      space,
    });
    const tx0 = rt1.edit();
    const rc1 = rt1.getCell<Record<string, unknown[]>>(
      space,
      id,
      compiled.resultSchema,
      tx0,
    );
    rt1.run(tx0, compiled, { items }, rc1);
    await tx0.commit();
    for (let k = 0; k < 10; k++) {
      await rc1.pull();
      await rt1.idle();
    }
    expect(rc1.key(field).getAsQueryResult() ?? []).toEqual(builtValue);

    // Stop the builtin's action, then overwrite the input list with [] so the
    // durable container stays non-empty while the input is empty. Scheduler
    // only, not `dispose({ closeStorage: false })`: rt1 goes on being used as
    // a WRITER on the next line, so this freezes reactions rather than tearing
    // the runtime down.
    rt1.scheduler.dispose();
    const tx1 = rt1.edit();
    rc1.withTx(tx1).key("items").set([]);
    await tx1.commit();
    await rt1.patternManager.flushCompileCacheWrites();
    await sm1.synced();
    await rt1.dispose();

    const sm2 = SM.make(signer, server);
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm2,
    });
    try {
      await rt2.patternManager.compilePattern(program, { space });
      const tx = rt2.edit();
      const rc2 = rt2.getCell<Record<string, unknown[]>>(
        space,
        id,
        compiled.resultSchema,
        tx,
      );
      await tx.commit();
      const started = await rt2.start(rc2);
      expect(started).toBe(true);
      for (let k = 0; k < 20; k++) {
        await rc2.pull();
        await rt2.idle();
      }
      // The container is held while the input confirms, then settled to [] —
      // converging on the confirmed empty input rather than the stale value.
      expect(rc2.key(field).getAsQueryResult() ?? []).toEqual([]);
    } finally {
      await rt2.dispose();
    }
  }

  it("filter settles its stale container against a confirmed-empty input", async () => {
    await run(
      FILTER_PROGRAM,
      "is-filter",
      "kept",
      [{ keep: true, label: "a" }, { keep: true, label: "b" }],
      [{ keep: true, label: "a" }, { keep: true, label: "b" }],
    );
  });

  it("flatMap settles its stale container against a confirmed-empty input", async () => {
    await run(
      FLATMAP_PROGRAM,
      "is-flatmap",
      "values",
      [{ keep: true, n: 1 }, { keep: true, n: 2 }],
      [1, 2],
    );
  });

  it("map settles its stale container against a confirmed-empty input", async () => {
    await run(
      MAP_PROGRAM,
      "is-map",
      "doubled",
      [{ n: 1 }, { n: 2 }, { n: 3 }],
      [2, 4, 6],
    );
  });
});

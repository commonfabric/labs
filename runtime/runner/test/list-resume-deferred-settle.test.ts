import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("list-resume-deferred-settle");
const space = signer.did();

// Resume-time deferral path in the map/filter/flatMap builtins.
//
// When a builtin's per-element runs are sync-gated on resume (awaitSync), the
// first reconcile after a cold start defers those runs until storage sync
// completes. The hard case to reach is when the durable result container is
// already loaded (so the builtin keeps its prior identity) while the input list
// reads empty on that first reconcile, because the list lives deep inside a
// larger persisted document that hydrates only after the first reconcile.
//
// This mirrors the home-favorites shape: a Default empty-list nested several
// levels down in the pattern's state, populated by handler calls in the first
// runtime rather than by the run() argument. On resume in a fresh runtime the
// container is present but the nested list arrives late, so the builtin runs its
// deferred per-element settle path and must still converge to the right
// aggregate.
const RESULT_CAUSE = "list-resume-deferred-settle result cell";

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { Cell, Default, handler, pattern } from 'commonfabric';",
        "",
        "interface Entry { value: number }",
        "",
        "interface Bucket {",
        "  items: Entry[] | Default<[]>;",
        "  opt?: Entry[];",
        "}",
        "interface Level2 { bucket: Bucket }",
        "interface Level1 { inner: Level2 }",
        "",
        "interface Input {",
        "  store:",
        "    | Level1",
        "    | Default<{ inner: { bucket: { items: []; opt?: Entry[] } } }>;",
        "}",
        "",
        "const addEntry = handler<{ value: number }, { items: Cell<Entry[]> }>(",
        "  ({ value }, { items }) => {",
        "    items.set([...items.get(), { value }]);",
        "  },",
        ");",
        "",
        "const reverseEntries = handler<unknown, { items: Cell<Entry[]> }>(",
        "  (_event, { items }) => {",
        "    items.set([...items.get()].reverse());",
        "  },",
        ");",
        "",
        "const seedOpt = handler<unknown, { opt: Cell<Entry[] | undefined> }>(",
        "  (_event, { opt }) => {",
        "    opt.set([{ value: 6 }, { value: 7 }]);",
        "  },",
        ");",
        "",
        "const clearOpt = handler<unknown, { opt: Cell<Entry[] | undefined> }>(",
        "  (_event, { opt }) => {",
        "    opt.set(undefined);",
        "  },",
        ");",
        "",
        "export default pattern<Input, any>(({ store }) => {",
        "  const items = store.inner.bucket.items;",
        "  const optRef = store.inner.bucket.opt;",
        "  const opt = optRef as Entry[];",
        "  const doubled = items.map((e) => ({ value: e.value * 2 }));",
        "  const positioned = items.map((e, i) => ({ value: e.value, at: i }));",
        "  const evens = items.filter((e) => e.value % 2 === 0);",
        "  const spread = items.flatMap((e) => [e.value, e.value]);",
        "  const optDoubled = opt.map((e) => ({ value: e.value * 2 }));",
        "  const optEvens = opt.filter((e) => e.value % 2 === 0);",
        "  const optSpread = opt.flatMap((e) => [e.value, e.value]);",
        "  return {",
        "    add: addEntry({ items }),",
        "    reverse: reverseEntries({ items }),",
        "    seed: seedOpt({ opt: optRef }),",
        "    clear: clearOpt({ opt: optRef }),",
        "    doubled,",
        "    positioned,",
        "    evens,",
        "    spread,",
        "    optDoubled,",
        "    optEvens,",
        "    optSpread,",
        "  };",
        "});",
      ].join("\n"),
    },
  ],
};

describe("list builtins defer-settle when their input hydrates after resume", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  const newRuntime = () =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await storageManager?.close();
  });

  it("converges the deep-nested aggregate after a cold resume", async () => {
    const rt1 = newRuntime();
    // Session 1: compile + run, then populate the nested list via the handler
    // (not via the run() argument), so the list is durable but lives deep
    // inside the pattern's own state document.
    const tx1 = rt1.edit();
    const pm1 = rt1.patternManager;
    const cold = await pm1.compilePattern(PROGRAM, { space, tx: tx1 });
    const resultCell1 = rt1.getCell<Record<string, unknown>>(
      space,
      RESULT_CAUSE,
      undefined,
      tx1,
    );
    const r1 = rt1.run(tx1, cold, {}, resultCell1);
    await tx1.commit().settled;
    await r1.pull();

    for (const value of [1, 2, 3, 4]) {
      r1.key("add").send({ value });
      await r1.pull();
      await rt1.idle();
    }

    // Reorder the existing elements: this drives the index-changed re-run branch
    // in map (the same element cell reappears at a new position), and leaves a
    // durable reversed order for the resume to converge to.
    r1.key("reverse").send({});
    await r1.pull();
    await rt1.idle();

    // Drive the optional list through populated -> undefined: seeding creates
    // per-element runs, clearing back to undefined exercises the builtins'
    // undefined-input branch (which stops those runs and resets the result to
    // []). The durable end state leaves opt undefined.
    r1.key("seed").send({});
    await r1.pull();
    await rt1.idle();
    r1.key("clear").send({});
    await r1.pull();
    await rt1.idle();

    const live = r1.getAsQueryResult() as {
      doubled: { value: number }[];
      positioned: { value: number; at: number }[];
      evens: { value: number }[];
      spread: number[];
      optDoubled: { value: number }[];
      optEvens: { value: number }[];
      optSpread: number[];
    };
    expect(live.doubled.map((e) => e.value)).toEqual([8, 6, 4, 2]);
    expect(live.positioned).toEqual([
      { value: 4, at: 0 },
      { value: 3, at: 1 },
      { value: 2, at: 2 },
      { value: 1, at: 3 },
    ]);
    expect(live.evens.map((e) => e.value)).toEqual([4, 2]);
    expect(live.spread).toEqual([4, 4, 3, 3, 2, 2, 1, 1]);
    expect(live.optDoubled).toEqual([]);
    expect(live.optEvens).toEqual([]);
    expect(live.optSpread).toEqual([]);

    await pm1.flushCompileCacheWrites();
    await rt1.storageManager.synced();

    // Session 2: a fresh runtime cold-resumes the same result cell. The result
    // container persists, but the nested list hydrates only after the first
    // reconcile, exercising the builtins' deferred per-element settle path.
    const rt2 = newRuntime();
    try {
      const tx2 = rt2.edit();
      const resultCell2 = rt2.getCell<Record<string, unknown>>(
        space,
        RESULT_CAUSE,
        undefined,
        tx2,
      );
      await tx2.commit().settled;

      await resultCell2.sync();
      const started = await rt2.start(resultCell2);
      expect(started).toBe(true);

      for (let k = 0; k < 8; k++) {
        await resultCell2.pull();
        await rt2.idle();
      }

      const resumed = resultCell2.getAsQueryResult() as {
        doubled: { value: number }[];
        positioned: { value: number; at: number }[];
        evens: { value: number }[];
        spread: number[];
        optDoubled: { value: number }[];
        optEvens: { value: number }[];
        optSpread: number[];
      };
      expect(resumed.doubled.map((e) => e.value)).toEqual([8, 6, 4, 2]);
      expect(resumed.positioned).toEqual([
        { value: 4, at: 0 },
        { value: 3, at: 1 },
        { value: 2, at: 2 },
        { value: 1, at: 3 },
      ]);
      expect(resumed.evens.map((e) => e.value)).toEqual([4, 2]);
      expect(resumed.spread).toEqual([4, 4, 3, 3, 2, 2, 1, 1]);
      expect(resumed.optDoubled).toEqual([]);
      expect(resumed.optEvens).toEqual([]);
      expect(resumed.optSpread).toEqual([]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { OpaqueCell } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import type { Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager as StorageManagerV2,
} from "../src/storage/v2.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import { resumeSettleRunKind } from "../src/builtins/resume-republish.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  newSharedServer,
  testPrincipalSessionOpenAuthFactory,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("list builtin edge paths");
const space = signer.did();

describe("list builtin edge paths", () => {
  // These tests exercise edge paths in the three list builtins (map/filter/
  // flatMap) that the resume-preservation tests do not reach:
  //
  //   - The usesIndex re-run branch: a reused per-element run whose element
  //     keeps its identity (a cell link) but lands at a new index re-executes
  //     its op so the index argument it observes is current.
  //   - The non-array guard: a list input that resolves to a non-array value
  //     makes the reconcile throw.
  //
  // Both are driven against a live runtime (no resume needed): cell-link
  // elements give stable identity across a reorder, and a direct set() of a
  // scalar list drives the non-array path.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commonfabric"]["lift"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];

  // An op pattern with no explicit argument schema runs in legacy mode, where
  // inferListOpArgumentUsage reports every argument (element, index, array,
  // params) as used. That makes usesIndex true, so a reused element that shifts
  // position re-runs its op.
  function indexUsingOp(
    // deno-lint-ignore no-explicit-any
    fn: (element: any, index: any) => any,
  ) {
    // deno-lint-ignore no-explicit-any
    return pattern(({ element, index }: any) => fn(element, index));
  }

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    const { commonfabric } = createTrustedBuilder(runtime);
    ({ lift, pattern } = commonfabric);
  });

  async function commitTx() {
    if (tx.status().status !== "ready") {
      return { ok: undefined, error: undefined };
    }
    runtime.prepareTxForCommit(tx);
    return await tx.commit();
  }

  afterEach(async () => {
    await commitTx();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("re-runs a reused map element when its index changes (usesIndex)", async () => {
    // The op tags each element with the index it observed, so a reorder that
    // keeps an element's identity but moves it must re-run that element to
    // refresh the observed index.
    const tagIndex = lift(
      (input: { element: number; index: number }) =>
        input.element * 100 + input.index,
    );
    const op = indexUsingOp((element, index) => tagIndex({ element, index }));

    const cellA = runtime.getCell<number>(space, "m-a", undefined, tx);
    cellA.withTx(tx).set(1);
    const cellB = runtime.getCell<number>(space, "m-b", undefined, tx);
    cellB.withTx(tx).set(2);
    const cellC = runtime.getCell<number>(space, "m-c", undefined, tx);
    cellC.withTx(tx).set(3);

    const mapPattern = pattern<{ values: number[] }>(({ values }) => ({
      values,
      tagged: (values as unknown as OpaqueCell<number[]>).mapWithPattern(
        // deno-lint-ignore no-explicit-any
        op as any,
        {},
      ),
    }));

    const resultCell = runtime.getCell<
      { values: number[]; tagged: number[] }
    >(space, "map-index-rerun", undefined, tx);
    const result = runtime.run(tx, mapPattern, {
      values: [cellA, cellB, cellC],
    }, resultCell);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    // element*100 + index: [1*100+0, 2*100+1, 3*100+2]
    expect(result.key("tagged").get()).toEqual([100, 201, 302]);

    // Reverse the list: [C, B, A]. Identity is stable (cell links), so each run
    // is reused, but every element's index changed, forcing a re-run.
    result.withTx(tx).key("values").set([cellC, cellB, cellA]);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    // [3*100+0, 2*100+1, 1*100+2]
    expect(result.key("tagged").get()).toEqual([300, 201, 102]);
  });

  it("re-runs a reused filter element when its index changes (usesIndex)", async () => {
    // Keep elements at even observed indices. A reorder changes which elements
    // sit at even indices, so reused runs must re-evaluate their predicate.
    const keepEven = lift(
      (input: { element: number; index: number }) => input.index % 2 === 0,
    );
    const op = indexUsingOp((element, index) => keepEven({ element, index }));

    const cellA = runtime.getCell<number>(space, "f-a", undefined, tx);
    cellA.withTx(tx).set(10);
    const cellB = runtime.getCell<number>(space, "f-b", undefined, tx);
    cellB.withTx(tx).set(20);
    const cellC = runtime.getCell<number>(space, "f-c", undefined, tx);
    cellC.withTx(tx).set(30);

    const filterPattern = pattern<{ values: number[] }>(({ values }) => ({
      values,
      evens: (values as unknown as OpaqueCell<number[]>).filterWithPattern(
        // deno-lint-ignore no-explicit-any
        op as any,
        {},
      ),
    }));

    const resultCell = runtime.getCell<
      { values: number[]; evens: number[] }
    >(space, "filter-index-rerun", undefined, tx);
    const result = runtime.run(tx, filterPattern, {
      values: [cellA, cellB, cellC],
    }, resultCell);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    // indices 0,2 kept: A(10), C(30)
    expect(result.key("evens").get()).toEqual([10, 30]);

    // [C, A, B]: now C at 0 (kept), A at 1 (dropped), B at 2 (kept).
    result.withTx(tx).key("values").set([cellC, cellA, cellB]);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("evens").get()).toEqual([30, 20]);
  });

  it("re-runs a reused flatMap element when its index changes (usesIndex)", async () => {
    // Each element contributes its index, so a reorder must re-run reused
    // elements to refresh the contributed value.
    const emitIndex = lift(
      (input: { element: number; index: number }) => input.index,
    );
    const op = indexUsingOp((element, index) => emitIndex({ element, index }));

    const cellA = runtime.getCell<number>(space, "fm-a", undefined, tx);
    cellA.withTx(tx).set(7);
    const cellB = runtime.getCell<number>(space, "fm-b", undefined, tx);
    cellB.withTx(tx).set(8);
    const cellC = runtime.getCell<number>(space, "fm-c", undefined, tx);
    cellC.withTx(tx).set(9);

    const flatMapPattern = pattern<{ values: number[] }>(({ values }) => ({
      values,
      indices: (values as unknown as OpaqueCell<number[]>).flatMapWithPattern(
        // deno-lint-ignore no-explicit-any
        op as any,
        {},
      ),
    }));

    const resultCell = runtime.getCell<
      { values: number[]; indices: number[] }
    >(space, "flatmap-index-rerun", undefined, tx);
    const result = runtime.run(tx, flatMapPattern, {
      values: [cellA, cellB, cellC],
    }, resultCell);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("indices").get()).toEqual([0, 1, 2]);

    // Rotate: [B, C, A]. Identity stable, indices shift, so each reused run
    // re-emits its new index.
    result.withTx(tx).key("values").set([cellB, cellC, cellA]);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("indices").get()).toEqual([0, 1, 2]);
  });

  it("spreads a flatMap element whose op returns an array", async () => {
    // flatMap flattens one level: an op returning an array has its entries
    // pushed individually into the aggregate.
    const expand = lift((x: number) => [x, x + 1]);
    const op = pattern(
      // deno-lint-ignore no-explicit-any
      ({ element }: any) => expand(element),
    );

    const flatMapPattern = pattern<{ values: number[] }>(({ values }) => ({
      out: (values as unknown as OpaqueCell<number[]>).flatMapWithPattern(
        // deno-lint-ignore no-explicit-any
        op as any,
        {},
      ),
    }));

    const resultCell = runtime.getCell<{ out: number[] }>(
      space,
      "flatmap-spread",
      undefined,
      tx,
    );
    const result = runtime.run(tx, flatMapPattern, {
      values: [1, 5],
    }, resultCell);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("out").get()).toEqual([1, 2, 5, 6]);
  });

  // The non-array guard fires inside the builtin's scheduler action, so the
  // error surfaces through the scheduler's error handler rather than the
  // pull() promise. Each variant seeds the list input as a scalar.
  async function expectNonArrayThrow(
    name: string,
    build: (
      values: OpaqueCell<number[]>,
      // deno-lint-ignore no-explicit-any
      op: any,
      // deno-lint-ignore no-explicit-any
    ) => any,
    messageRe: RegExp,
  ): Promise<void> {
    const op = pattern(
      // deno-lint-ignore no-explicit-any
      ({ element }: any) => lift((x: number) => x)(element),
    );
    const opPattern = pattern<{ values: number[] }>(({ values }) => ({
      // deno-lint-ignore no-explicit-any
      out: build(values as unknown as OpaqueCell<number[]>, op as any),
    }));
    const resultCell = runtime.getCell<{ out: number[] }>(
      space,
      name,
      undefined,
      tx,
    );
    const errors: string[] = [];
    runtime.scheduler.onError((e) => errors.push(String(e?.message ?? e)));
    // Seed the input as a scalar, not an array.
    const result = runtime.run(tx, opPattern, {
      // deno-lint-ignore no-explicit-any
      values: 42 as any,
    }, resultCell);
    await commitTx();
    tx = runtime.edit();

    try {
      await result.pull();
    } catch (_e) {
      // The throw may also surface here depending on scheduling; either path is
      // acceptable as long as the guard fired.
      errors.push(String(_e));
    }
    await runtime.idle();

    expect(errors.some((m) => messageRe.test(m))).toBe(true);
  }

  it("throws when a map list input is not an array", async () => {
    // map reads the list with getRaw(), so a non-array input value survives to
    // the guard. (filter/flatMap read through an array-typed schema that
    // coerces a non-array to undefined, taking the empty-result path instead, so
    // their guard is not reachable from a non-array input value.)
    await expectNonArrayThrow(
      "map-non-array",
      (values, op) => values.mapWithPattern(op, {}),
      /map currently only supports arrays/,
    );
  });
});

//
// Resume harness for the owned-cell walk's nested-node branches.
//
// The walk (Runner.#collectResumeOwnedCells) recurses through nested sub-pattern
// nodes. A sub-pattern whose result cell carries a non-"space" cell scope makes
// the walk re-scope the child result cell before recursing, the branch the
// single-space resume tests do not reach. A cold resume drives the walk.
//

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

class LoopbackStorageManager extends StorageManagerV2 {
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

// An outer pattern that composes an inner sub-pattern scoped to "user" (via
// `.asScope("user")`). The inner pattern keeps a derived internal cell (the
// lifted scaled value), so the resume walk both re-scopes the child result cell
// to "user" and has an owned cell to pre-sync for the nested node.
const SCOPED_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { lift, pattern, UI } from 'commonfabric';",
      "const scale = lift((n: number) => n * 10);",
      "const inner = pattern<{ n: number }>(({ n }) => {",
      "  return { scaled: scale(n) };",
      "});",
      // The explicit Output type omits UI, so the inferred result schema has no
      // $UI property even though the result object carries one. That makes the
      // resume walk's UI-presence branch sync the UI cell separately.
      "export default pattern<{ seed: number }, { value: number }>(({ seed }) => {",
      "  const child = inner.asScope('user')({ n: seed });",
      "  return {",
      "    value: child.scaled,",
      "    [UI]: <div>{child.scaled}</div>,",
      "  };",
      "});",
    ].join("\n"),
  }],
};

describe("resume owned-cell walk: scoped sub-pattern", () => {
  let server: MemoryV2Server.Server;
  let sm1: LoopbackStorageManager;
  let sm2: LoopbackStorageManager;

  beforeEach(() => {
    server = newSharedServer();
    sm1 = LoopbackStorageManager.make(signer, server);
    sm2 = LoopbackStorageManager.make(signer, server);
  });
  afterEach(async () => {
    await sm1?.close();
    await sm2?.close();
    await server?.close();
  });

  it("re-scopes a user-scoped nested sub-pattern across a cold resume", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm1,
    });
    const compiled1 = await rt1.patternManager.compilePattern(SCOPED_PROGRAM, {
      space,
    });
    const tx0 = rt1.edit();
    const rc1 = rt1.getCell<{ value: number }>(
      space,
      "scoped-owned-result",
      compiled1.resultSchema,
      tx0,
    );
    const h1 = rt1.run(tx0, compiled1, { seed: 4 }, rc1);
    await tx0.commit();
    for (let k = 0; k < 10; k++) {
      await h1.pull();
      await rt1.idle();
    }
    await rt1.patternManager.flushCompileCacheWrites();
    await sm1.synced();
    expect(rc1.key("value").get()).toBe(40);
    await rt1.dispose({ closeStorage: false });

    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm2,
    });
    try {
      await rt2.patternManager.compilePattern(SCOPED_PROGRAM, { space });
      const tx = rt2.edit();
      const rc2 = rt2.getCell<{ value: number }>(
        space,
        "scoped-owned-result",
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
      expect(rc2.key("value").get()).toBe(40);
    } finally {
      await rt2.dispose({ closeStorage: false });
    }
  });
});

//
// Cross-space link load kick (Runtime.ensureLinkedDocLoaded).
//
// A value read that follows a link to a target in ANOTHER space, whose doc is
// absent from this session's replica, kicks an async load and registers it as a
// cross-space promise so pull()'s convergence loop awaits it. Per-space server
// queries cannot follow links across space boundaries, so the client fetches
// the target itself. A reader session that never created the target drives the
// kick.
//

const spaceH = signer.did(); // "home" — holds the link
const spaceP = (await Identity.fromPassphrase("edge paths target P")).did();

const CROSS_SPACE_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { handler, pattern, Writable } from 'commonfabric';",
      "export const child = pattern<{ name: string }>(({ name }) => ({",
      "  name,",
      "  greeting: 'hello',",
      "}));",
      "type ChildOutput = { name: string; greeting: string };",
      "const create = handler<",
      "  { name?: string },",
      "  { items: Writable<ChildOutput[]> }",
      ">((event, { items }) => {",
      `  items.push(child.inSpace("${spaceP}")({`,
      "    name: event.name ?? 'Ada',",
      "  }) as ChildOutput);",
      "});",
      "export default pattern(() => {",
      "  const items = new Writable<ChildOutput[]>([]).for('items');",
      "  return { items, create: create({ items }) };",
      "});",
    ].join("\n"),
  }],
};

const crossSpaceLinkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  // deno-lint-ignore no-explicit-any
} as any;

describe("cross-space link load kick", () => {
  let server: MemoryV2Server.Server;
  let writerStorage: EmulatedStorageManager;
  let readerStorage: EmulatedStorageManager;

  beforeEach(() => {
    server = newSharedServer();
    writerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    readerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
  });
  afterEach(async () => {
    await writerStorage?.close();
    await readerStorage?.close();
    await server?.close();
  });

  it("kicks an async load for a cross-space link target and converges", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerStorage,
    });
    try {
      // Writer: create the parent in H and the child in P, fully synced.
      const tx1 = rt1.edit();
      const parent = await rt1.patternManager.compilePattern(
        CROSS_SPACE_PROGRAM,
        { space: spaceH, tx: tx1 },
      );
      const resultCell1 = rt1.getCell<Record<string, unknown>>(
        spaceH,
        "edge-paths-cross-space-parent",
        undefined,
        tx1,
      );
      // deno-lint-ignore no-explicit-any
      const r1 = rt1.run(tx1, parent as any, {}, resultCell1);
      await tx1.commit();
      await r1.pull();
      r1.key("create").send({ name: "Ada" });
      await r1.pull();
      await rt1.idle();
      // The cross-space child creation rides server->client delivery turns;
      // drain them before reading the freshly pushed link.
      await clock.settle();
      await r1.pull();
      // deno-lint-ignore no-explicit-any
      const links = r1.key("items").asSchema(crossSpaceLinkListSchema)
        .get() as any[];
      expect(links.length).toBe(1);
      expect(links[0].getAsNormalizedFullLink().space).toBe(spaceP);
      await rt1.patternManager.flushCompileCacheWrites();
      await rt1.storageManager.synced();
      const parentLink = r1.getAsNormalizedFullLink();

      // Reader: a fresh session whose replica never fetched space P. A deep
      // whole-value pull of the linking parent's items goes through traverse's
      // followPointer, which finds the cross-space child doc absent and kicks
      // the async load via ensureLinkedDocLoaded; the convergence loop awaits
      // it.
      const parentCell = rt2.getCellFromLink(parentLink);
      await parentCell.sync();
      const itemsCell = parentCell.key("items");
      await itemsCell.pull();
      // deno-lint-ignore no-explicit-any
      const items = itemsCell.get() as any[];
      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBe(1);
      expect(items[0]?.name).toBe("Ada");

      // Also read through the link by key path, and drain any kicked async load
      // so the kick is observed within this test rather than leaking into the
      // next one.
      const childField = parentCell.key("items").key(0).key("name");
      const pulled = await childField.pull();
      expect(pulled).toBe("Ada");
      await rt2.idle();
      await rt2.storageManager.synced();
      await rt2.idle();
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});

Deno.test("resume-settle run kind: bookkeeping ONLY on the serving posture; derivation on clients (r3756175819 — the shared decision all three list builtins stamp)", () => {
  // The settle writes DERIVED content (result := f(input)): stamped
  // bookkeeping on a flag-ON client it committed authored-class — a
  // by-construction violation of the client derivation-commit removal.
  // The serving posture keeps the sanctioned internal bookkeeping kind
  // (serving-loop.md §3d) so the wave admits the recovery write.
  expect(
    resumeSettleRunKind({ servingPosture: true } as unknown as Runtime),
  ).toBe("bookkeeping");
  expect(
    resumeSettleRunKind({ servingPosture: false } as unknown as Runtime),
  ).toBe("derivation");
});

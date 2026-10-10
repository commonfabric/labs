import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import type { RuntimeProgram } from "../src/harness/types.ts";
import type { Node, Pattern } from "../src/builder/types.ts";
import { isPattern } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { CooperativeYield } from "../src/scheduler/cooperative-yield.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("resume presync plan count");
const space = signer.did();

// A three-level tree: the root maps a durable list to `row` pieces, and
// each row instantiates a nested `badge`. Every level has a lift of its
// own, so each instance holds nodes the pre-sync plans. The root also
// hands each row a derived value no row reads, so nothing computes it and
// no store holds its document: the argument of every row links to a
// document that is absent everywhere.
const TREE_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "type Item = { n: number };",
      "export const badge = pattern<{ item: Item }, { label: string }>(",
      "  ({ item }) => ({ label: computed(() => `b:${item.n}`) }),",
      ");",
      "export const row = pattern<{ item: Item; hint?: string }, {",
      "  value: number;",
      "  badge: { label: string };",
      "}>(({ item }) => ({",
      "  value: computed(() => item.n * 2),",
      "  badge: badge({ item }),",
      "}));",
      "export default pattern<{ items: Item[] }, {",
      "  rows: { value: number; badge: { label: string } }[];",
      "}>(({ items }) => {",
      "  const hint = computed(() => `${items.length} items`);",
      "  return { rows: items.map((item) => row({ item, hint })) };",
      "});",
    ].join("\n"),
  }],
};

// The same tree, its root handed the rows' `hint` by its caller rather than
// deriving it: the argument of every row links to whatever the caller
// supplied.
const HANDED_TREE_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "type Item = { n: number };",
      "export const badge = pattern<{ item: Item }, { label: string }>(",
      "  ({ item }) => ({ label: computed(() => `b:${item.n}`) }),",
      ");",
      "export const row = pattern<{ item: Item; hint?: string }, {",
      "  value: number;",
      "  badge: { label: string };",
      "}>(({ item }) => ({",
      "  value: computed(() => item.n * 2),",
      "  badge: badge({ item }),",
      "}));",
      "export default pattern<{ items: Item[]; hint?: string }, {",
      "  rows: { value: number; badge: { label: string } }[];",
      "}>(({ items, hint }) => ({",
      "  rows: items.map((item) => row({ item, hint })),",
      "}));",
    ].join("\n"),
  }],
};

const ITEMS = [{ n: 1 }, { n: 2 }, { n: 3 }];

/** The pattern a node instantiates, or undefined for any other node. */
function childPatternOf(node: Node): Pattern | undefined {
  const module = node.module;
  if (typeof module !== "object" || module === null) return undefined;
  if (!("type" in module) || module.type !== "pattern") return undefined;
  const implementation = (module as { implementation: unknown })
    .implementation;
  return isPattern(implementation) ? implementation : undefined;
}

describe("resume-presync-plan-count", () => {
  // The resume pre-sync plans each node of each instance it names. A plan
  // is the same whoever asks for it, so one per `(instance, node)` pair is
  // what a load needs; every further plan of the same pair is the parent's
  // start and the child's own start each walking the child's subtree.

  let server: ReturnType<typeof newSharedServer>;
  let managers: EmulatedStorageManager[];
  let runtimes: Runtime[];

  beforeEach(() => {
    server = newSharedServer();
    managers = [];
    runtimes = [];
  });

  afterEach(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    for (const manager of managers) await manager.close();
    await server.close();
  });

  function replica(): Runtime {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    managers.push(manager);
    runtimes.push(runtime);
    return runtime;
  }

  it("plans each node of each instance once on a cold resume", async () => {
    const cellId = "resume-presync-plan-count-root";

    const author = replica();
    const compiled = await author.patternManager.compilePattern(
      TREE_PROGRAM,
      { space },
    );
    const tx = author.edit();
    const authored = author.getCell<{ rows: { value: number }[] }>(
      space,
      cellId,
      compiled.resultSchema,
      tx,
    );
    author.run(tx, compiled, { items: ITEMS }, authored);
    await tx.commit().settled;
    await authored.pull();
    await author.settled();
    await author.patternManager.flushCompileCacheWrites();
    await author.storageManager.synced();
    expect(
      (authored.key("rows").getAsQueryResult() as { value: number }[])
        .map((item) => item.value),
    ).toEqual([2, 4, 6]);
    await author.dispose({ closeStorage: false });
    runtimes.splice(runtimes.indexOf(author), 1);

    // The pairs the tree holds: the root's nodes, each row's nodes once per
    // item, and each badge's nodes once per item. `map` wraps its element
    // pattern in a one-node piece, so a row is that wrapper's node plus the
    // row pattern's own.
    const wrapperPattern = compiled.nodes
      .map((node) => (node.inputs as { op?: unknown }).op)
      .find(isPattern)!;
    const rowPattern = wrapperPattern.nodes
      .map(childPatternOf)
      .find((pattern) => pattern !== undefined)!;
    const badgePattern = rowPattern.nodes
      .map(childPatternOf)
      .find((pattern) => pattern !== undefined)!;
    const expectedPairs = compiled.nodes.length +
      ITEMS.length * (wrapperPattern.nodes.length + rowPattern.nodes.length +
          badgePattern.nodes.length);

    const resumer = replica();
    await resumer.patternManager.compilePattern(TREE_PROGRAM, { space });
    const plans = new Map<string, Map<Node, number>>();
    // The name-syncs the load pays: the root's own, and one more for each
    // child start that finds something its run reads absent.
    let nameSyncs = 0;
    resumer.runner.accessForTestingOnly.dependencySyncer = (
      resultCell,
      pattern,
      inputs,
      sync,
    ) => {
      nameSyncs += 1;
      return sync(resultCell, pattern, inputs);
    };
    resumer.runner.accessForTestingOnly.presyncPlanRecorder = (
      piece,
      node,
      site,
    ) => {
      if (site !== "node") return;
      const perNode = plans.get(piece) ?? new Map<Node, number>();
      perNode.set(node, (perNode.get(node) ?? 0) + 1);
      plans.set(piece, perNode);
    };
    const resumed = resumer.getCell<{ rows: { value: number }[] }>(
      space,
      cellId,
      compiled.resultSchema,
    );
    expect(await resumer.runner.start(resumed)).toBe(true);
    // The pull demands the rows the way a rendering does, so the
    // coordinator runs and every row and badge starts.
    await resumed.pull();
    await resumer.settled();
    await resumer.storageManager.synced();
    expect(
      (resumed.key("rows").getAsQueryResult() as {
        value: number;
        badge: { label: string };
      }[]).map((item) => [item.value, item.badge.label]),
    ).toEqual([[2, "b:1"], [4, "b:2"], [6, "b:3"]]);

    let pairs = 0;
    let calls = 0;
    for (const perNode of plans.values()) {
      for (const count of perNode.values()) {
        pairs += 1;
        calls += count;
      }
    }
    expect(pairs).toBe(expectedPairs);
    expect(calls).toBe(pairs);
    expect(nameSyncs).toBe(1);
  });

  it("names a nested instance's family once when its argument links to a document nothing has written", async () => {
    const cellId = "resume-presync-plan-count-handed-root";

    const author = replica();
    const compiled = await author.patternManager.compilePattern(
      HANDED_TREE_PROGRAM,
      { space },
    );
    // A document no one writes, handed down to every row: a viewer's
    // per-user cell before the viewer has written one has this shape. The
    // store holds nothing for it, so no name-sync can deliver it.
    const unwritten = author.getCell<string>(
      space,
      "resume-presync-plan-count-unwritten",
      { type: "string" },
    );
    const tx = author.edit();
    const authored = author.getCell<{ rows: { value: number }[] }>(
      space,
      cellId,
      compiled.resultSchema,
      tx,
    );
    author.run(tx, compiled, { items: ITEMS, hint: unwritten }, authored);
    await tx.commit().settled;
    await authored.pull();
    await author.settled();
    await author.patternManager.flushCompileCacheWrites();
    await author.storageManager.synced();
    await author.dispose({ closeStorage: false });
    runtimes.splice(runtimes.indexOf(author), 1);

    const resumer = replica();
    await resumer.patternManager.compilePattern(HANDED_TREE_PROGRAM, { space });
    let nameSyncs = 0;
    resumer.runner.accessForTestingOnly.dependencySyncer = (
      resultCell,
      pattern,
      inputs,
      sync,
    ) => {
      nameSyncs += 1;
      return sync(resultCell, pattern, inputs);
    };
    const resumed = resumer.getCell<{ rows: { value: number }[] }>(
      space,
      cellId,
      compiled.resultSchema,
    );
    expect(await resumer.runner.start(resumed)).toBe(true);
    await resumed.pull();
    await resumer.settled();
    await resumer.storageManager.synced();
    expect(
      (resumed.key("rows").getAsQueryResult() as {
        value: number;
        badge: { label: string };
      }[]).map((item) => [item.value, item.badge.label]),
    ).toEqual([[2, "b:1"], [4, "b:2"], [6, "b:3"]]);
    // The root's own name-sync planned every row and named what its nodes
    // read; a row's start finds nothing a name-sync of its own could add.
    expect(nameSyncs).toBe(1);
  });

  it("yields to the event loop between the syncs of a resume wave", async () => {
    const runtime = replica();
    // A slice of zero spends on every cell, so the wave yields between each
    // pair of syncs it issues.
    const yielder = new CooperativeYield(0);
    runtime.runner.accessForTestingOnly.resumeYield = yielder;
    const cells = [
      runtime.getCell(space, "wave-yield-first"),
      runtime.getCell(space, "wave-yield-second"),
      runtime.getCell(space, "wave-yield-third"),
    ];
    // A timer the first sync arms fires on the next macrotask turn: before
    // the last sync is issued if the wave yields between them, and only
    // after the whole wave if it does not.
    let issued = 0;
    let issuedWhenTimerFired = -1;
    const timer = Promise.withResolvers<void>();
    await runtime.runner.accessForTestingOnly.kickResumeWave(cells, (cell) => {
      if (cell === cells[0]) {
        setTimeout(() => {
          issuedWhenTimerFired = issued;
          timer.resolve();
        }, 0);
      }
      issued += 1;
      return Promise.resolve(undefined);
    });
    await timer.promise;
    expect(issued).toBe(3);
    expect(yielder.yieldCount).toBeGreaterThan(0);
    expect(issuedWhenTimerFired).toBeGreaterThan(0);
    expect(issuedWhenTimerFired).toBeLessThan(3);
  });

  it("reports a sync's rejection through the wave, never as unhandled", async () => {
    const runtime = replica();
    runtime.runner.accessForTestingOnly.resumeYield = new CooperativeYield(0);
    const unhandled: unknown[] = [];
    const record = (event: PromiseRejectionEvent) => {
      unhandled.push(event.reason);
      event.preventDefault();
    };
    globalThis.addEventListener("unhandledrejection", record);
    try {
      const cells = [
        runtime.getCell(space, "wave-rejects-first"),
        runtime.getCell(space, "wave-rejects-second"),
      ];
      // The first sync rejects at once, while the wave is still awaiting
      // the turn it takes before issuing the second.
      const failure = new Error("sync refused");
      const wave = runtime.runner.accessForTestingOnly.kickResumeWave(
        cells,
        (cell) =>
          cell === cells[0]
            ? Promise.reject(failure)
            : Promise.resolve(undefined),
      );
      await expect(wave).rejects.toBe(failure);
      // A rejection reaches the host as unhandled on a later macrotask
      // turn, so one more turn passes before the listener is asked.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      globalThis.removeEventListener("unhandledrejection", record);
    }
  });
});

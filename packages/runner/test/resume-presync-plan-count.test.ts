import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";

import type { RuntimeProgram } from "../src/harness/types.ts";
import type {
  DerivedInternalCellDescriptor,
  Node,
  Pattern,
} from "../src/builder/types.ts";
import { isPattern } from "../src/builder/types.ts";
import {
  getArtifactEntryRef,
  noteDerivedCopy,
} from "../src/builder/pattern-metadata.ts";
import type { NodePlan } from "../src/runner.ts";
import { getDerivedInternalCellLink } from "../src/link-utils.ts";
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

// The plain tree, each row owning a derived value that never holds one: its
// computation runs and yields `undefined`, so the row's cell stays the record
// setup wrote, with no value, in the store and on every replica that loads
// it.
const VALUELESS_TREE_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "type Item = { n: number };",
      "export const badge = pattern<{ item: Item }, { label: string }>(",
      "  ({ item }) => ({ label: computed(() => `b:${item.n}`) }),",
      ");",
      "export const row = pattern<{ item: Item }, {",
      "  value: number;",
      "  note?: string;",
      "  badge: { label: string };",
      "}>(({ item }) => {",
      "  const note = computed(() => (item.n > 100 ? 'large' : undefined));",
      "  return {",
      "    value: computed(() => item.n * 2),",
      "    note,",
      "    badge: badge({ item }),",
      "  };",
      "});",
      "export default pattern<{ items: Item[] }, {",
      "  rows: { value: number; note?: string; badge: { label: string } }[];",
      "}>(({ items }) => ({",
      "  rows: items.map((item) => row({ item })),",
      "}));",
    ].join("\n"),
  }],
};

// The plain tree, each row owning a per-user derived value with a default
// that its computation never produces: once the computation has run, the
// viewer's instance of the cell holds the record setup wrote and no value,
// and the next start owes that instance the default.
const SEEDED_DEFAULT_TREE_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern, type Default, type PerUser } from 'commonfabric';",
      "type Item = { n: number };",
      "export const row = pattern<{ item: Item }, {",
      "  value: number;",
      "  mark?: string;",
      "}>(({ item }) => {",
      "  const mark = computed(",
      "    (): PerUser<Default<string, 'none'>> | undefined =>",
      "      item.n > 100 ? 'large' : undefined,",
      "  );",
      "  return { value: computed(() => item.n * 2), mark };",
      "});",
      "export default pattern<{ items: Item[] }, {",
      "  rows: { value: number; mark?: string }[];",
      "}>(({ items }) => ({",
      "  rows: items.map((item) => row({ item })),",
      "}));",
    ].join("\n"),
  }],
};

// The plain tree with the per-user value one level down: each row runs a
// `badge` scoped to the user, and the badge owns the value. The badge's own
// result is per-user, so no default is owed to its cell.
const SCOPED_BADGE_TREE_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern, type Default, type PerUser } from 'commonfabric';",
      "type Item = { n: number };",
      "export const badge = pattern<{ item: Item }, { mark?: string }>(",
      "  ({ item }) => ({",
      "    mark: computed(",
      "      (): PerUser<Default<string, 'none'>> | undefined =>",
      "        item.n > 100 ? 'large' : undefined,",
      "    ),",
      "  }),",
      ");",
      "export const row = pattern<{ item: Item }, {",
      "  value: number;",
      "  badge: { mark?: string };",
      "}>(({ item }) => ({",
      "  value: computed(() => item.n * 2),",
      "  badge: badge.asScope('user')({ item }),",
      "}));",
      "export default pattern<{ items: Item[] }, {",
      "  rows: { value: number; badge: { mark?: string } }[];",
      "}>(({ items }) => ({",
      "  rows: items.map((item) => row({ item })),",
      "}));",
    ].join("\n"),
  }],
};

// The plain tree, each row owning two cells of the session's own with no
// default to seed: a per-session derived value, and a per-session writable
// nothing has written. A session that has not run the row holds no document
// for either, in the store or anywhere else.
const SESSION_CELL_TREE_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern, type PerSession, Writable } from 'commonfabric';",
      "type Item = { n: number };",
      "export const row = pattern<{ item: Item }, {",
      "  value: number;",
      "  note?: string;",
      "  draft?: string;",
      "}>(({ item }) => {",
      "  const note = computed(",
      "    (): PerSession<string | undefined> =>",
      "      item.n > 100 ? 'large' : undefined,",
      "  );",
      "  const draft = new Writable.perSession<string | undefined>(undefined);",
      "  return { value: computed(() => item.n * 2), note, draft };",
      "});",
      "export default pattern<{ items: Item[] }, {",
      "  rows: { value: number; note?: string; draft?: string }[];",
      "}>(({ items }) => ({",
      "  rows: items.map((item) => row({ item })),",
      "}));",
    ].join("\n"),
  }],
};

const ITEMS = [{ n: 1 }, { n: 2 }, { n: 3 }];

/** The id of the inputs document `plan` reads, for a plan of a node with one. */
function inputsDocumentOf(plan: NodePlan | undefined): string | undefined {
  return plan !== undefined && "inputsCell" in plan
    ? plan.inputsCell.getAsNormalizedFullLink().id
    : undefined;
}

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

  /**
   * Runs `program` over `ITEMS` under `cellId` on a runtime of its own until
   * the store holds the whole tree, and returns the compiled root. Each
   * program here maps the items to rows whose `value` doubles an item's.
   */
  async function authorTree(
    cellId: string,
    program: RuntimeProgram = TREE_PROGRAM,
  ): Promise<Pattern> {
    const author = replica();
    const compiled = await author.patternManager.compilePattern(
      program,
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
    return compiled;
  }

  /**
   * The `(instance, node)` pairs the tree `compiled` holds over `ITEMS`: the
   * root's nodes, each row's nodes once per item, and each badge's nodes
   * once per item. `map` wraps its element pattern in a one-node piece, so a
   * row is that wrapper's node plus the row pattern's own.
   */
  function treePairs(compiled: Pattern): number {
    const wrapperPattern = compiled.nodes
      .map((node) => (node.inputs as { op?: unknown }).op)
      .find(isPattern)!;
    const rowPattern = wrapperPattern.nodes
      .map(childPatternOf)
      .find((pattern) => pattern !== undefined)!;
    const badgePattern = rowPattern.nodes
      .map(childPatternOf)
      .find((pattern) => pattern !== undefined)!;
    return compiled.nodes.length +
      ITEMS.length * (wrapperPattern.nodes.length + rowPattern.nodes.length +
          badgePattern.nodes.length);
  }

  it("holds one binding per node of each instance after a fresh tree starts", async () => {
    // A node's binding is held once computed, by whichever plan computed
    // it, so a later plan of the same node finds it. A fresh start binds
    // every node against the argument its setup wrote, so every binding is
    // held; one against a stand-in argument, which a later plan never asks
    // for, is not.
    const author = replica();
    const compiled = await author.patternManager.compilePattern(TREE_PROGRAM, {
      space,
    });
    const tx = author.edit();
    const result = author.getCell<{ rows: { value: number }[] }>(
      space,
      "fresh-tree-stand-in-bindings",
      compiled.resultSchema,
      tx,
    );
    author.run(tx, compiled, { items: ITEMS }, result);
    await tx.commit().settled;
    await result.pull();
    await author.settled();
    expect(
      result.key("rows").getAsQueryResult().map((row: { value: number }) =>
        row.value
      ),
    )
      .toEqual([2, 4, 6]);
    expect(author.runner.accessForTestingOnly.heldNodeBindings).toBe(
      treePairs(compiled),
    );
  });

  it("binds a node once for a plan made after its instantiation", async () => {
    // A load plans a node in its pre-sync, instantiates it, and may plan it
    // again: a name-sync of its family that starts after the instantiation,
    // for one. The binding held by the first plan serves them all.
    const author = replica();
    const compiled = await author.patternManager.compilePattern(TREE_PROGRAM, {
      space,
    });
    let bindings = 0;
    author.runner.accessForTestingOnly.nodeBindingRecorder = () => {
      bindings += 1;
    };
    let tx = author.edit();
    const result = author.getCell<{ rows: { value: number }[] }>(
      space,
      "fresh-tree-plan-after-instantiation",
      compiled.resultSchema,
      tx,
    );
    author.run(tx, compiled, { items: ITEMS }, result);
    await tx.commit().settled;
    await result.pull();
    await author.settled();
    const bound = bindings;
    expect(bound).toBeGreaterThan(0);

    tx = author.edit();
    for (const node of compiled.nodes) {
      author.runner.accessForTestingOnly.nodePlan(
        tx,
        node,
        result.withTx(tx),
        compiled,
      );
    }
    tx.abort();
    expect(bindings).toBe(bound);
  });

  it("binds a node once across plans holding its pattern as two objects of one identity", async () => {
    // A pre-sync plans a nested instance's nodes under the pattern object
    // embedded in its parent's graph, and the instance's own start under
    // the object loaded by the pattern's identity. Both hold the same nodes
    // at the same positions, so a plan under either finds the binding the
    // other computed.
    const author = replica();
    const compiled = await author.patternManager.compilePattern(TREE_PROGRAM, {
      space,
    });
    let bindings = 0;
    author.runner.accessForTestingOnly.nodeBindingRecorder = () => {
      bindings += 1;
    };
    let tx = author.edit();
    const result = author.getCell<{ rows: { value: number }[] }>(
      space,
      "fresh-tree-pattern-as-two-objects",
      compiled.resultSchema,
      tx,
    );
    author.run(tx, compiled, { items: ITEMS }, result);
    await tx.commit().settled;
    await result.pull();
    await author.settled();
    author.runner.accessForTestingOnly.forgetNodeBindings();
    bindings = 0;

    // A copy of the compiled pattern, down to its nodes, derived from it the
    // way the runtime derives a copy and so of the same identity.
    const copy: Pattern = {
      ...compiled,
      nodes: compiled.nodes.map((node) => ({ ...node })),
    };
    noteDerivedCopy(copy, compiled);
    expect(getArtifactEntryRef(copy)).toEqual(getArtifactEntryRef(compiled));

    tx = author.edit();
    const plans = compiled.nodes.map((node) =>
      author.runner.accessForTestingOnly.nodePlan(
        tx,
        node,
        result.withTx(tx),
        compiled,
      )
    );
    const again = copy.nodes.map((node) =>
      author.runner.accessForTestingOnly.nodePlan(
        tx,
        node,
        result.withTx(tx),
        copy,
      )
    );
    tx.abort();
    expect(bindings).toBe(compiled.nodes.length);
    expect(again.map(inputsDocumentOf)).toEqual(plans.map(inputsDocumentOf));
  });

  it("plans each node of each instance once on a cold resume", async () => {
    const cellId = "resume-presync-plan-count-root";
    const compiled = await authorTree(cellId);
    const expectedPairs = treePairs(compiled);

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

  it("binds each node of each instance once across the pre-sync and the instantiation", async () => {
    // A node's bindings are a function of the node, the result cell it is
    // bound on and the argument link it is bound against, and the pre-sync
    // and the instantiation bind the same nodes on the same cells. One
    // binding per `(instance, node)` pair is what a load needs.

    const cellId = "resume-presync-plan-count-bindings-root";
    const compiled = await authorTree(cellId);
    const expectedPairs = treePairs(compiled);

    const resumer = replica();
    await resumer.patternManager.compilePattern(TREE_PROGRAM, { space });
    let bindings = 0;
    resumer.runner.accessForTestingOnly.nodeBindingRecorder = () => {
      bindings += 1;
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

    expect(bindings).toBe(expectedPairs);
    // Each node's instantiation found the binding the pre-sync held for it,
    // and it is held still.
    expect(resumer.runner.accessForTestingOnly.heldNodeBindings).toBe(
      expectedPairs,
    );
  });

  it("mints each derived internal cell's id once across a resume", async () => {
    // The id of a derived internal cell is the hash of its result cell's
    // entity and its partial cause. The pre-sync names every instance's
    // owned cells, each node that binds one asks for its id again, and so
    // does the scheduler summary of every action of the instance.

    const cellId = "resume-presync-plan-count-derived-ids-root";
    const compiled = await authorTree(cellId);

    const resumer = replica();
    await resumer.patternManager.compilePattern(TREE_PROGRAM, { space });
    let mints = 0;
    const minted = new Set<string>();
    resumer.derivedInternalCellIds.accessForTestingOnly.mintRecorder = (
      resultId,
      partialCause,
    ) => {
      mints += 1;
      minted.add(JSON.stringify([resultId, partialCause]));
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

    expect(minted.size).toBeGreaterThan(0);
    expect(mints).toBe(minted.size);
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

  it("names a nested instance's family once when a derived cell it owns holds no value", async () => {
    const cellId = "resume-presync-plan-count-valueless-root";

    const author = replica();
    const compiled = await author.patternManager.compilePattern(
      VALUELESS_TREE_PROGRAM,
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
    await author.dispose({ closeStorage: false });
    runtimes.splice(runtimes.indexOf(author), 1);

    const wrapperPattern = compiled.nodes
      .map((node) => (node.inputs as { op?: unknown }).op)
      .find(isPattern)!;
    const rowPattern = wrapperPattern.nodes
      .map(childPatternOf)
      .find((pattern) => pattern !== undefined)!;

    const resumer = replica();
    await resumer.patternManager.compilePattern(VALUELESS_TREE_PROGRAM, {
      space,
    });
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
    // Every piece the pre-sync plans: the root, and each wrapper, row and
    // badge under it.
    const pieces = new Set<string>();
    resumer.runner.accessForTestingOnly.presyncPlanRecorder = (piece) => {
      pieces.add(piece);
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
    const read = resumed.key("rows").getAsQueryResult() as {
      value: number;
      note?: string;
      badge: { label: string };
    }[];
    expect(read.map((item) => [item.value, item.badge.label]))
      .toEqual([[2, "b:1"], [4, "b:2"], [6, "b:3"]]);
    expect(read.map((item) => item.note))
      .toEqual([undefined, undefined, undefined]);

    // What the store handed this replica for each row. A row is the piece
    // the row pattern's derived cells exist under: each has its record, and
    // one of them, the note, has no value.
    const documents = managers[managers.length - 1].open(space).replica;
    const rows = [...pieces]
      .map((piece) =>
        rowPattern.derivedInternalCells!.map((descriptor) =>
          documents.getDocument(
            getDerivedInternalCellLink(
              resumer.getCellFromEntityId(space, piece),
              descriptor,
            ).id,
          )
        )
      )
      .filter((owned) => owned.every((document) => document !== undefined));
    expect(rows).toHaveLength(ITEMS.length);
    for (const owned of rows) {
      expect(owned.filter((document) => document!.value === undefined))
        .toHaveLength(1);
    }
    // No name-sync could deliver a value the store does not hold, so no
    // row's start asks for one: the root's is the only name-sync.
    expect(nameSyncs).toBe(1);
  });

  /**
   * Resumes the tree at `cellId` in a runtime of its own, as the user who set
   * it up, by `how`, with `intercept` installed for the resume. Returns the
   * name-syncs the resume paid and, for each piece its pre-sync planned that
   * owns the cell `descriptor` describes, what the replica holds for it.
   */
  async function resumeTree(
    program: RuntimeProgram,
    cellId: string,
    descriptor: DerivedInternalCellDescriptor,
    how: "start" | "synced run in a caller's transaction" = "start",
    intercept?: (runtime: Runtime) => Disposable,
  ): Promise<{
    nameSyncs: number;
    cells: Map<string, { value?: unknown }>;
  }> {
    const runtime = replica();
    const pattern = await runtime.patternManager.compilePattern(program, {
      space,
    });
    let nameSyncs = 0;
    runtime.runner.accessForTestingOnly.dependencySyncer = (
      resultCell,
      pattern,
      inputs,
      sync,
    ) => {
      nameSyncs += 1;
      return sync(resultCell, pattern, inputs);
    };
    const pieces = new Set<string>();
    runtime.runner.accessForTestingOnly.presyncPlanRecorder = (piece) => {
      pieces.add(piece);
    };
    using _intercepted = intercept?.(runtime);
    const resumed = runtime.getCell<unknown>(
      space,
      cellId,
      pattern.resultSchema,
    );
    if (how === "start") {
      expect(await runtime.runner.start(resumed)).toBe(true);
    } else {
      const tx = runtime.edit();
      await runtime.runSynced(resumed.withTx(tx), pattern, { items: ITEMS });
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    await resumed.pull();
    await runtime.settled();
    await runtime.storageManager.synced();
    const documents = managers[managers.length - 1].open(space).replica;
    const cells = new Map<string, { value?: unknown }>();
    for (const piece of pieces) {
      const id = getDerivedInternalCellLink(
        runtime.getCellFromEntityId(space, piece),
        descriptor,
      ).id;
      const document = documents.getDocument(id, descriptor.scope);
      if (document !== undefined) cells.set(id, document);
    }
    await runtime.dispose({ closeStorage: false });
    runtimes.splice(runtimes.indexOf(runtime), 1);
    return { nameSyncs, cells };
  }

  /** The derived cell called `partialCause` that `pattern` owns. */
  function ownedDescriptor(
    pattern: Pattern,
    partialCause: string,
  ): DerivedInternalCellDescriptor {
    return pattern.derivedInternalCells!
      .find((descriptor) => descriptor.partialCause === partialCause)!;
  }

  it("seeds a nested instance's per-user default when a pre-sync that seeds nothing named it", async () => {
    const cellId = "resume-presync-plan-count-seeded-default-root";
    const compiled = await authorTree(cellId, SEEDED_DEFAULT_TREE_PROGRAM);
    const wrapperPattern = compiled.nodes
      .map((node) => (node.inputs as { op?: unknown }).op)
      .find(isPattern)!;
    const rowPattern = wrapperPattern.nodes
      .map(childPatternOf)
      .find((pattern) => pattern !== undefined)!;
    const markDescriptor = ownedDescriptor(rowPattern, "mark");
    expect(markDescriptor).toMatchObject({
      kind: "computed",
      scope: "user",
      schema: { default: "none" },
    });

    // A first resume leaves each row's cell with its record and no value:
    // the computation ran, and produces nothing.
    const left = await resumeTree(
      SEEDED_DEFAULT_TREE_PROGRAM,
      cellId,
      markDescriptor,
    );
    expect([...left.cells.values()].map((document) => document.value))
      .toEqual([undefined, undefined, undefined]);

    // A synced run in a caller's transaction names the tree without
    // preparing its defaults, so each row's own start is what seeds the
    // default the row owes that cell.
    const seeded: string[] = [];
    await resumeTree(
      SEEDED_DEFAULT_TREE_PROGRAM,
      cellId,
      markDescriptor,
      "synced run in a caller's transaction",
      (runtime) => {
        const stamp = runtime.stampServerRun.bind(runtime);
        return stub(runtime, "stampServerRun", (tx, info) => {
          if (info.actionId.startsWith("scoped-default/")) {
            seeded.push(info.actionId.slice("scoped-default/".length));
          }
          stamp(tx, info);
        });
      },
    );
    expect(seeded.toSorted()).toEqual([...left.cells.keys()].toSorted());
  });

  it("names a nested instance's family once when a scoped sub-instance's derived cell holds no value", async () => {
    const cellId = "resume-presync-plan-count-scoped-badge-root";
    const compiled = await authorTree(cellId, SCOPED_BADGE_TREE_PROGRAM);
    const wrapperPattern = compiled.nodes
      .map((node) => (node.inputs as { op?: unknown }).op)
      .find(isPattern)!;
    const rowPattern = wrapperPattern.nodes
      .map(childPatternOf)
      .find((pattern) => pattern !== undefined)!;
    const badgePattern = rowPattern.nodes
      .map(childPatternOf)
      .find((pattern) => pattern !== undefined)!;
    const markDescriptor = ownedDescriptor(badgePattern, "mark");
    expect(markDescriptor).toMatchObject({
      kind: "computed",
      scope: "user",
      schema: { default: "none" },
    });

    // A first resume leaves each badge's cell with its record and no value.
    const left = await resumeTree(
      SCOPED_BADGE_TREE_PROGRAM,
      cellId,
      markDescriptor,
    );
    expect([...left.cells.values()].map((document) => document.value))
      .toEqual([undefined, undefined, undefined]);

    // The badge's result is per-user like its cell, so no default is owed
    // to the cell, and no row is held for it.
    const again = await resumeTree(
      SCOPED_BADGE_TREE_PROGRAM,
      cellId,
      markDescriptor,
    );
    expect(again.nameSyncs).toBe(1);
  });

  it("names a nested instance's family once when a cell it owns is the session's own", async () => {
    const cellId = "resume-presync-plan-count-session-cell-root";
    const compiled = await authorTree(cellId, SESSION_CELL_TREE_PROGRAM);
    const wrapperPattern = compiled.nodes
      .map((node) => (node.inputs as { op?: unknown }).op)
      .find(isPattern)!;
    const rowPattern = wrapperPattern.nodes
      .map(childPatternOf)
      .find((pattern) => pattern !== undefined)!;
    expect(ownedDescriptor(rowPattern, "note")).toMatchObject({
      kind: "computed",
      scope: "session",
    });
    expect(ownedDescriptor(rowPattern, "draft")).toMatchObject({
      scope: "session",
    });

    // The root's pre-sync asks the store for each row's cells under this
    // session, and a session that has not run the rows has written neither.
    // No store holds a document for another session's instance, so a row's
    // own name-sync could deliver nothing: the root's is the only one.
    const resumed = await resumeTree(
      SESSION_CELL_TREE_PROGRAM,
      cellId,
      ownedDescriptor(rowPattern, "note"),
    );
    expect(resumed.nameSyncs).toBe(1);
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

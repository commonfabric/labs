import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import {
  convertibleJsFromFabricValue,
  fabricFromConvertibleJsValue,
  type FabricValue,
} from "@commonfabric/data-model";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";

import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import type {
  DerivedInternalCellDescriptor,
  Pattern,
} from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  getDerivedInternalCell,
  getDerivedInternalCellLink,
  parseLink,
} from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import {
  getPieceSourceSnapshot,
  PatternSetupPostCommitError,
  preparePieceSourceTransitionBaseline,
} from "../src/runner.ts";
import { Runtime } from "../src/runtime.ts";
import type { CommitError } from "../src/storage/interface.ts";
import {
  PieceStateMovedError,
  readStoredSetupBuild,
  STORED_SETUP_BUILD_VERSION,
  type StoredSetupBuild,
  storedSetupBuildOf,
} from "../src/stored-setup-build.ts";

import { interceptPieceStartCommit } from "./support/intercept-piece-start-commit.ts";

const signer = await Identity.fromPassphrase("stored-setup-build-repair");
const space = signer.did();

// Two derived cells inside the view tree. A cell a result key reaches is
// named by its path; one inside the `[UI]` tree is a positional root of the
// build, with an anonymous cause `{ $generated: N }` in the order the builder
// reaches it. The stored tree links each slot to its cell by that cause.
const DERIVED: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern, UI, Writable } from 'commonfabric';",
      "export default pattern<{ input: Writable<number> }>(({ input }) => ({",
      "  [UI]: (",
      "    <div>",
      "      {computed(() => input.get() * 2)}",
      "      {computed(() => input.get() * 3)}",
      "    </div>",
      "  ),",
      "}));",
      "",
    ].join("\n"),
  }],
};

// The same two derived cells, and a writable inside the view tree: a
// positional cell that holds state recomputing does not restore.
const STATEFUL: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern, UI, Writable } from 'commonfabric';",
      "export default pattern<{ input: Writable<number> }>(({ input }) => ({",
      "  [UI]: (",
      "    <div>",
      "      {computed(() => input.get() * 2)}",
      "      {computed(() => input.get() * 3)}",
      "      <span>{new Writable('draft')}</span>",
      "    </div>",
      "  ),",
      "}));",
      "",
    ].join("\n"),
  }],
};

// The two derived cells, and two writables inside the view tree of one
// description: positional cells holding state that only their numbers tell
// apart.
const STATEFUL_PAIR: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern, UI, Writable } from 'commonfabric';",
      "export default pattern<{ input: Writable<number> }>(({ input }) => ({",
      "  [UI]: (",
      "    <div>",
      "      {computed(() => input.get() * 2)}",
      "      {computed(() => input.get() * 3)}",
      "      <span>{new Writable('first')}</span>",
      "      <span>{new Writable('second')}</span>",
      "    </div>",
      "  ),",
      "}));",
      "",
    ].join("\n"),
  }],
};

// A derived cell and a sub-pattern child inside the view tree: the child's
// spot is a positional cell holding state, whose value links to the child's
// own result document.
const WITH_CHILD: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern, UI, Writable } from 'commonfabric';",
      "const Counter = pattern<{ label: string }>(({ label }) => ({",
      "  label,",
      "  count: new Writable(0),",
      "}));",
      "export default pattern<{ input: Writable<number> }>(({ input }) => ({",
      "  [UI]: (",
      "    <div>",
      "      {computed(() => input.get() * 2)}",
      "      {Counter({ label: 'a' })}",
      "    </div>",
      "  ),",
      "}));",
      "",
    ].join("\n"),
  }],
};

// Two children of one pattern, which its module exports under three names:
// sub-pattern children holding state that only their numbers tell apart.
const ALIASED_CHILDREN: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern, UI, Writable } from 'commonfabric';",
      "import { Counter } from './counter.tsx';",
      "export default pattern<{ input: Writable<number> }>(() => {",
      "  const first = Counter({ label: 'first' });",
      "  const second = Counter({ label: 'second' });",
      "  return {",
      "    [UI]: <div>{first.count}{second.count}</div>,",
      "  };",
      "});",
      "",
    ].join("\n"),
  }, {
    name: "/counter.tsx",
    contents: [
      "import { pattern, Writable } from 'commonfabric';",
      "export const Counter = pattern<",
      "  { label: string },",
      "  { label: string; count: number }",
      ">(({ label }) => ({ label, count: new Writable<number>(0).for('count') }));",
      "export default Counter;",
      "export const Tally = Counter;",
      "",
    ].join("\n"),
  }],
};

// A parent whose one child, from a module of its own, holds two writables of
// one description in its view.
const WITH_STATEFUL_CHILD: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern, UI } from 'commonfabric';",
        "import { Inner } from './inner.tsx';",
        "export default pattern<Record<string, never>>(() => {",
        "  const child = Inner({});",
        "  return { [UI]: <div>{child}</div> };",
        "});",
        "",
      ].join("\n"),
    },
    {
      name: "/inner.tsx",
      contents: [
        "import { pattern, UI, Writable } from 'commonfabric';",
        "export const Inner = pattern<Record<string, never>>(() => ({",
        "  [UI]: (",
        "    <div>",
        "      <span>{new Writable('x')}</span>",
        "      <span>{new Writable('y')}</span>",
        "    </div>",
        "  ),",
        "}));",
        "",
      ].join("\n"),
    },
  ],
};

const INPUT = 5;
const SLOT_VALUES = [INPUT * 2, INPUT * 3];

type Result = { $UI: { children: unknown[] } };

type PositionalDescriptor = DerivedInternalCellDescriptor & {
  partialCause: { $generated: number };
};

const isPositional = (
  descriptor: DerivedInternalCellDescriptor,
): descriptor is PositionalDescriptor =>
  typeof (descriptor.partialCause as { $generated?: unknown })?.$generated ===
    "number";

/**
 * `value` with every positional partial cause anywhere in it renumbered by
 * `renumber`, as another build of the same source would have numbered it.
 * The renumbered causes are deep-frozen, as the builder leaves every cause
 * it assigns.
 */
const renumbered = (
  value: unknown,
  renumber: (n: number) => number,
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => renumbered(item, renumber));
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (
      typeof record.$generated === "number" && Object.keys(record).length === 1
    ) {
      return Object.freeze({ $generated: renumber(record.$generated) });
    }
    return Object.fromEntries(
      Object.entries(record).map((
        [key, item],
      ) => [key, renumbered(item, renumber)]),
    );
  }
  return value;
};

/**
 * The pattern another build of `pattern`'s source would have produced, had
 * it numbered each positional cell `renumber(N)` instead of `N`: the same
 * nodes, cells and result, with every positional cause renumbered. Each
 * node keeps its module, so a sub-pattern node still runs the same child
 * pattern, under the identity that pattern is known by, and the child's own
 * cells are numbered as they were.
 */
const otherBuild = (
  pattern: Pattern,
  renumber: (n: number) => number,
): Pattern => ({
  ...pattern,
  nodes: pattern.nodes.map((node) => ({
    ...renumbered(node, renumber) as Pattern["nodes"][number],
    module: node.module,
  })),
  result: renumbered(pattern.result, renumber) as Pattern["result"],
  derivedInternalCells: renumbered(
    pattern.derivedInternalCells,
    renumber,
  ) as Pattern["derivedInternalCells"],
});

describe("stored-setup-build-repair", () => {
  // A piece's result projection and internal-cell manifest are written by the
  // build that sets it up, and link each slot to the derived cell that build
  // numbered for it. A later build of the same pattern source can number its
  // roots differently, and then writes each slot's value to a cell the stored
  // projection reads as another slot. Setup stamps a record of the build it
  // staged, `Runner.#storedSetupVerdict()` holds a stored setup against the
  // build a start loads, and `#startCore()` re-stages the internal cells and
  // the projection where that puts them right. Where the record says a cell
  // holding state moved, the start, and a setup of the same version, refuse
  // the piece and write nothing.

  let server: ReturnType<typeof newLoopbackServer>;
  let rt: Runtime;

  const openRuntime = (as: Identity): Runtime =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as }),
    });

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    rt = openRuntime(signer);
  });

  afterEach(async () => {
    await rt.idle();
    await rt.patternManager.flushCompileCacheWrites();
    await rt.storageManager.synced();
    await rt.dispose();
    await server.close();
  });

  const settled = async () => {
    await rt.idle();
    await rt.storageManager.synced();
    await rt.idle();
  };

  const entryRefOf = (artifact: object) =>
    rt.patternManager.getLeastArtifactEntryRef(artifact);

  // Sets a piece up from `program`, lets its derived cells compute, and stops
  // it, so that a later start takes the plain start path and its decision.
  const setUpAndStop = async (name: string, program = DERIVED) => {
    const tx = rt.edit();
    const pattern = await rt.patternManager.compilePattern(program, {
      space,
      tx,
    }) as Pattern;
    const cell = rt.getCell<Result>(space, name, undefined, tx);
    const running = rt.run(tx, pattern, { input: INPUT }, cell);
    await tx.commit().settled;
    await running.pull();
    await settled();
    rt.runner.stop(cell);
    const ref = entryRefOf(pattern)!;
    return { cell, pattern, ref };
  };

  // The sub-pattern a node of `parent` instantiates.
  const childOf = (parent: Pattern): object =>
    (parent.nodes as { module: { type: string; implementation: object } }[])
      .find((node) => node.module.type === "pattern")!.module.implementation;

  const positionalDescriptors = (pattern: Pattern): PositionalDescriptor[] =>
    (pattern.derivedInternalCells ?? []).filter(isPositional);

  // The number of the positional cell `spot` is, among `pattern`'s.
  const childSpotNumber = (
    pattern: Pattern,
    spot: Cell<unknown>,
    cell: Cell<unknown>,
  ): number =>
    positionalDescriptors(pattern).find((descriptor) =>
      getDerivedInternalCellLink(cell, descriptor).id ===
        spot.getAsNormalizedFullLink().id
    )!.partialCause.$generated;

  const redirectLinkTo = (
    cell: Cell<unknown>,
    descriptor: DerivedInternalCellDescriptor,
    tx: ReturnType<Runtime["edit"]>,
  ) =>
    getDerivedInternalCell(cell as Cell, descriptor, tx)
      .getAsWriteRedirectLink({ base: cell, includeSchema: true });

  // `value` with every link in it replaced by what `replace` returns for
  // it, where that is anything.
  const mapLinks = (
    value: unknown,
    base: Cell<unknown>,
    replace: (id: string) => unknown,
  ): unknown => {
    const link = parseLink(value, base);
    if (link !== undefined) return replace(link.id) ?? value;
    if (Array.isArray(value)) {
      return value.map((item) => mapLinks(item, base, replace));
    }
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map((
          [key, item],
        ) => [key, mapLinks(item, base, replace)]),
      );
    }
    return value;
  };

  const rawProjection = (cell: Cell<unknown>): unknown =>
    convertibleJsFromFabricValue(cell.getRaw() as FabricValue);

  // The ids the stored projection links each slot to, by the slot's path.
  const projectionLinkIds = (cell: Cell<unknown>): Record<string, string> => {
    const ids: Record<string, string> = {};
    const walk = (value: unknown, path: string) => {
      const link = parseLink(value, cell);
      if (link !== undefined) {
        ids[path] = link.id;
      } else if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, `${path}/${index}`));
      } else if (typeof value === "object" && value !== null) {
        for (const [key, item] of Object.entries(value)) {
          walk(item, `${path}/${key}`);
        }
      }
    };
    walk(rawProjection(cell), "");
    return ids;
  };

  const manifestCauses = (cell: Cell<unknown>): unknown[] =>
    (convertibleJsFromFabricValue(cell.getMetaRaw("internal")) as {
      partialCause: unknown;
    }[]).map((entry) => entry.partialCause);

  const stampOf = (cell: Cell<unknown>): StoredSetupBuild | undefined =>
    readStoredSetupBuild(cell.getMetaRaw("patternSetupBuild"));

  const stamp = async (
    cell: Cell<unknown>,
    record: StoredSetupBuild | string | undefined,
  ) => {
    const tx = rt.edit();
    cell.withTx(tx).setMetaRaw(
      "patternSetupBuild",
      record === undefined
        ? undefined
        : fabricFromConvertibleJsValue(record as never),
      rawMetaWriteAuthorization,
    );
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  // Stores the projection, the manifest and the record as the build
  // `otherBuild(pattern, renumber)` would have written them: every link to a
  // positional cell names the cell `renumber` gives it.
  const storeAsBuild = async (
    cell: Cell<unknown>,
    pattern: Pattern,
    ref: { identity: string; symbol: string },
    renumber: (n: number) => number,
  ) => {
    const other = otherBuild(pattern, renumber);
    const tx = rt.edit();
    const withTx = cell.withTx(tx);
    const replacement = new Map<string, unknown>(
      positionalDescriptors(pattern).map((descriptor) => [
        getDerivedInternalCellLink(withTx, descriptor).id,
        redirectLinkTo(withTx, {
          ...descriptor,
          partialCause: Object.freeze({
            $generated: renumber(descriptor.partialCause.$generated),
          }),
        }, tx),
      ]),
    );
    withTx.setRawUntyped(
      fabricFromConvertibleJsValue(
        mapLinks(rawProjection(withTx), withTx, (id) => replacement.get(id)),
      ),
      false,
      "output",
    );
    const manifest = (other.derivedInternalCells ?? []).map((descriptor) => ({
      partialCause: descriptor.partialCause,
      ...(descriptor.kind !== undefined && { kind: descriptor.kind }),
      link: redirectLinkTo(withTx, descriptor, tx),
    }));
    withTx.setMetaRaw(
      "internal",
      fabricFromConvertibleJsValue(manifest),
      rawMetaWriteAuthorization,
    );
    withTx.setMetaRaw(
      "patternSetupBuild",
      fabricFromConvertibleJsValue(
        storedSetupBuildOf(other, ref, entryRefOf) as never,
      ),
      rawMetaWriteAuthorization,
    );
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  const startAndReadSlots = async (cell: Cell<Result>): Promise<unknown[]> => {
    expect(await rt.start(cell)).toBe(true);
    await cell.pull();
    await settled();
    return (cell.getAsQueryResult() as Result).$UI.children;
  };

  // How many times the runner has logged `name` as a warning: a hold of a
  // piece with no record, or a refusal of one whose record says a cell
  // holding state moved. Neither writes any setup, so the log line is its
  // one signal; `describeHold()` is what it says.
  const warned = (name: string): number =>
    (getLoggerCountsBreakdown().runner?.[name] as
      | { warn?: number }
      | undefined)?.warn ?? 0;
  const holdsLogged = () => warned("piece-start-repair-held");
  const refusalsLogged = () => warned("piece-start-refused");

  // Starts `cell`, which its record says another build set up with a cell
  // holding state at another number, and checks the start refuses it: it
  // rejects with the cells that moved, leaves the piece unregistered and its
  // stored setup as it was, and logs the refusal once.
  const expectStartRefused = async (cell: Cell<Result>) => {
    const stored = storedSetupOf(cell);
    const before = refusalsLogged();

    const refused = await rt.start(cell).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(PieceStateMovedError);
    expect(rt.runner.isRunning(cell)).toBe(false);
    await settled();
    expect(storedSetupOf(cell)).toEqual(stored);
    expect(refusalsLogged()).toBe(before + 1);
    return refused as PieceStateMovedError;
  };

  // The stored projection, manifest and record of `cell`, to hold a later
  // reading against.
  const storedSetupOf = (cell: Cell<unknown>) => ({
    projection: cell.getRaw(),
    manifest: cell.getMetaRaw("internal"),
    stamp: cell.getMetaRaw("patternSetupBuild"),
  });

  it("numbers the view's derived cells positionally", async () => {
    // The fixture's premise: the two slots are consecutive positional roots,
    // so a build with one more root ahead of them moves both by one.
    const { pattern } = await setUpAndStop("positional");
    const causes = positionalDescriptors(pattern).map((descriptor) =>
      descriptor.partialCause.$generated
    ).sort();

    expect(causes).toEqual([0, 1]);
  });

  it("stamps a record of the build setup staged, naming its cells that hold state", async () => {
    const { cell, ref } = await setUpAndStop("stamped");
    const record = stampOf(cell);

    expect(record?.v).toBe(STORED_SETUP_BUILD_VERSION);
    expect(record?.pattern).toEqual(ref);
    expect(record?.state).toEqual([]);
    const { cell: other } = await setUpAndStop("stamped-too");
    expect(stampOf(other)).toEqual(record);

    const { cell: stateful, pattern } = await setUpAndStop(
      "stamped-stateful",
      STATEFUL,
    );
    const writable = positionalDescriptors(pattern).find((descriptor) =>
      descriptor.kind !== "computed"
    )!;
    expect(stampOf(stateful)?.state.map(([number]) => number)).toEqual([
      writable.partialCause.$generated,
    ]);
  });

  it("re-stages a piece whose stored setup is a build that numbered one more root", async () => {
    const { cell, pattern, ref } = await setUpAndStop("shifted");
    const expected = projectionLinkIds(cell);
    const expectedCauses = manifestCauses(cell);
    const record = stampOf(cell);
    // The slot each positional cause's cell is linked from, by cause number.
    const slotOfCause = (generated: number): string => {
      const descriptor = positionalDescriptors(pattern).find((candidate) =>
        candidate.partialCause.$generated === generated
      )!;
      const id = getDerivedInternalCellLink(cell, descriptor).id;
      return Object.entries(expected).find(([, linked]) => linked === id)![0];
    };
    await storeAsBuild(cell, pattern, ref, (n) => n + 1);
    // The simulation is faithful: the slot of cause 0 now links the cell this
    // build numbers 1, which is the slot after it, read one slot off.
    expect(projectionLinkIds(cell)[slotOfCause(0)]).toBe(
      expected[slotOfCause(1)],
    );
    expect(manifestCauses(cell)).not.toEqual(expectedCauses);
    expect(stampOf(cell)).not.toEqual(record);

    expect(await startAndReadSlots(cell)).toEqual(SLOT_VALUES);

    expect(projectionLinkIds(cell)).toEqual(expected);
    expect(manifestCauses(cell)).toEqual(expectedCauses);
    expect(stampOf(cell)).toEqual(record);
  });

  it("re-stages a piece whose stored setup is a build that mapped two same-shaped cells the other way", async () => {
    // Two cells of one description trading places keep the manifest's causes
    // and the cells' descriptions; the projection map is what differs.
    const { cell, pattern, ref } = await setUpAndStop("swapped");
    const expected = projectionLinkIds(cell);
    const expectedCauses = manifestCauses(cell);
    const record = stampOf(cell);
    await storeAsBuild(cell, pattern, ref, (n) => 1 - n);
    expect(projectionLinkIds(cell)).not.toEqual(expected);
    const numbersOf = (causes: unknown[]) =>
      causes.map((cause) => (cause as { $generated: number }).$generated)
        .toSorted();
    expect(numbersOf(manifestCauses(cell))).toEqual(
      numbersOf(expectedCauses),
    );
    expect(stampOf(cell)?.cells).toBe(record?.cells);
    expect(stampOf(cell)?.projection).not.toBe(record?.projection);
    const holdsBefore = holdsLogged();

    expect(await startAndReadSlots(cell)).toEqual(SLOT_VALUES);

    expect(holdsLogged()).toBe(holdsBefore);

    expect(projectionLinkIds(cell)).toEqual(expected);
    expect(stampOf(cell)).toEqual(record);
  });

  it("refuses to start a piece whose cell holding state another build numbered differently, writing nothing", async () => {
    // Running the piece would read the writable's slot from the cell the
    // current build numbers for it, where another cell's state sits. The
    // start runs no part of it and writes nothing, so the stored setup stays
    // as the evidence of what moved, for a migration that can move the
    // state.
    const { cell, pattern, ref } = await setUpAndStop("refused", STATEFUL);
    await storeAsBuild(cell, pattern, ref, (n) => n + 1);
    const writable =
      positionalDescriptors(pattern).find((descriptor) =>
        descriptor.kind !== "computed"
      )!.partialCause.$generated;

    const refused = await expectStartRefused(cell);

    expect(refused.moved).toEqual([{
      description: "cell, not computed, no writer",
      hasState: true,
      from: writable + 1,
      to: writable,
    }]);
    expect(refused.ambiguous).toEqual([]);
    expect(refused.pattern).toEqual(ref);
  });

  it("rejects `startWithCommit()` with the refusal a retry of its commit reaches", async () => {
    // The start's first commit is lost to a stale basis, and the piece's
    // record of another build lands before the retry, whose judgment
    // refuses the piece.
    const { cell, pattern, ref } = await setUpAndStop(
      "refused-on-retry",
      STATEFUL,
    );
    const staleBasis = {
      name: "StorageTransactionInconsistent",
      message: "injected stale basis",
    } as CommitError;
    const commit = interceptPieceStartCommit(rt, {
      refusal: staleBasis,
      held: true,
    });
    try {
      const started = rt.runner.startWithCommit(cell).then(
        () => undefined,
        (error: unknown) => error,
      );
      await commit.intercepted;
      await storeAsBuild(cell, pattern, ref, (n) => n + 1);
      commit.release();

      const refused = await started;
      expect(refused).toBeInstanceOf(PieceStateMovedError);
      expect((refused as PieceStateMovedError).pattern).toEqual(ref);
      expect(rt.runner.isRunning(cell)).toBe(false);
    } finally {
      commit.restore();
    }
  });

  it("refuses each later start of a refused piece in turn, rather than finding it already running", async () => {
    const { cell, pattern, ref } = await setUpAndStop(
      "refused-again",
      STATEFUL,
    );
    await storeAsBuild(cell, pattern, ref, (n) => n + 1);

    await expectStartRefused(cell);
    await expectStartRefused(cell);
  });

  it("starts a refused piece once its stored setup is a record of a build that numbers its cells as the running build does", async () => {
    // A build whose numbering matches the record, such as a compiler change
    // reverted, lets the piece run. Here the stored setup is put back to the
    // running build's own, which is what such a build would find.
    const { cell, pattern, ref } = await setUpAndStop(
      "refused-then-run",
      STATEFUL,
    );
    const own = storedSetupOf(cell);
    await storeAsBuild(cell, pattern, ref, (n) => n + 1);
    await expectStartRefused(cell);
    const tx = rt.edit();
    const withTx = cell.withTx(tx);
    withTx.setRawUntyped(own.projection as FabricValue, false, "output");
    withTx.setMetaRaw("internal", own.manifest, rawMetaWriteAuthorization);
    withTx.setMetaRaw(
      "patternSetupBuild",
      own.stamp,
      rawMetaWriteAuthorization,
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(storedSetupOf(cell)).toEqual(own);

    expect((await startAndReadSlots(cell)).slice(0, 2)).toEqual(SLOT_VALUES);
    expect(rt.runner.isRunning(cell)).toBe(true);
  });

  it("refuses to start a piece whose child another build numbered differently, writing none of its children's documents", async () => {
    // The running build would instantiate the child at its own number. The
    // refusal comes before any of the piece's nodes, so no child runs, and
    // neither spot nor the child's result document is written.
    const { cell, pattern, ref } = await setUpAndStop(
      "refused-child",
      WITH_CHILD,
    );
    const spots = positionalDescriptors(pattern).map((descriptor) =>
      getDerivedInternalCell(cell as Cell, descriptor)
    );
    const childSpot = spots.find((spot) =>
      parseLink(spot.getRaw(), spot) !== undefined
    )!;
    const child = rt.getCellFromLink(parseLink(childSpot.getRaw(), childSpot)!);
    const shiftedSpots = positionalDescriptors(pattern).map((descriptor) =>
      getDerivedInternalCell(cell as Cell, {
        ...descriptor,
        partialCause: Object.freeze({
          $generated: descriptor.partialCause.$generated + 1,
        }),
      })
    );
    await storeAsBuild(cell, pattern, ref, (n) => n + 1);
    const before = [...spots, ...shiftedSpots, child].map((doc) =>
      doc.getRaw()
    );
    expect(rt.runner.isRunning(child)).toBe(false);

    const refused = await expectStartRefused(cell);

    expect(refused.moved.map(({ from, to }) => [from, to])).toEqual([[
      childSpotNumber(pattern, childSpot, cell) + 1,
      childSpotNumber(pattern, childSpot, cell),
    ]]);
    expect([...spots, ...shiftedSpots, child].map((doc) => doc.getRaw()))
      .toEqual(before);
    expect(rt.runner.isRunning(child)).toBe(false);
  });

  it("refuses to set up again a piece whose record says a cell holding state moved, staging nothing", async () => {
    // A setup of the version the record names, by a build that numbers the
    // writable differently, would stage this build's projection over the
    // writable's state and record that as agreed.
    const { cell, pattern, ref } = await setUpAndStop(
      "setup-refused",
      STATEFUL,
    );
    await storeAsBuild(cell, pattern, ref, (n) => n + 1);
    const stored = storedSetupOf(cell);
    const before = warned("piece-setup-refused");

    const tx = rt.edit();
    expect(() => rt.run(tx, pattern, { input: INPUT }, cell)).toThrow(
      PieceStateMovedError,
    );
    tx.abort("setup refused");
    await settled();

    expect(storedSetupOf(cell)).toEqual(stored);
    expect(rt.runner.isRunning(cell)).toBe(false);
    expect(warned("piece-setup-refused")).toBe(before + 1);
  });

  describe("with a child whose record says its state moved", () => {
    // The parent's own record agrees with the build; its child's says
    // another build numbered three of its two writables' description, so
    // which went where cannot be told.

    // Sets up the parent and stops it, then stamps the child's record as
    // another build's. Returns the parent, its pattern and the child.
    const setUpWithRefusedChild = async (name: string) => {
      const { cell, pattern } = await setUpAndStop(name, WITH_STATEFUL_CHILD);
      const spot = getDerivedInternalCell(
        cell as Cell,
        positionalDescriptors(pattern)[0],
      );
      const child = rt.getCellFromLink<Result>(
        parseLink(spot.getRaw(), spot)!,
      );
      const own = stampOf(child)!;
      const description = own.state[0][1];
      await stamp(child, {
        ...own,
        cells: "a record of another build",
        state: [[0, description], [1, description], [2, description]],
      });
      return { cell, pattern, ref: entryRefOf(pattern)!, child };
    };

    it("rejects `runSynced()` of the parent's version with the child's refusal", async () => {
      // `runSynced()` commits the setup, then starts the piece and awaits the
      // start, so the child's refusal reaches its caller. The parent's own
      // record agrees with the build, so its setup re-stages what it holds.
      const { cell, pattern, child } = await setUpWithRefusedChild(
        "child-refused-run-synced",
      );
      const storedChild = storedSetupOf(child);

      const refused = await rt.runSynced(cell, pattern, {}).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(refused).toBeInstanceOf(PieceStateMovedError);
      expect((refused as PieceStateMovedError).piece).toBe(child.sourceURI);
      expect(rt.runner.isRunning(cell)).toBe(false);
      await settled();
      expect(storedSetupOf(child)).toEqual(storedChild);
    });

    it("rejects `runSyncedWithCommit()` of the parent's version with a post-commit error whose cause is the child's refusal", async () => {
      // The receipted setup a source update runs: its setup commits, and the
      // start after it is refused, so the caller gets the receipt of the
      // commit and, as its cause, the refusal.
      const { cell, pattern, ref, child } = await setUpWithRefusedChild(
        "child-refused-receipt",
      );
      const storedChild = storedSetupOf(child);
      const expected = getPieceSourceSnapshot(
        cell,
        rt.runner.sessionPatternPointerFor(cell),
      )!;
      const pieceSourceTransition = {
        revisionId: crypto.randomUUID(),
        baseline: await preparePieceSourceTransitionBaseline(
          rt,
          cell,
          expected,
        ),
        timestamp: Date.now(),
        operation: "edit" as const,
        origin: null,
        expected,
      };

      const refused = await rt.runSyncedWithCommit(cell, pattern, {}, {
        expectedPatternIdentity: expected.pattern,
        pieceSourceTransition,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(refused).toBeInstanceOf(PatternSetupPostCommitError);
      const { commit, cause } = refused as PatternSetupPostCommitError;
      expect(commit.pattern).toEqual(ref);
      expect(cause).toBeInstanceOf(PieceStateMovedError);
      expect((cause as PieceStateMovedError).piece).toBe(child.sourceURI);
      expect(rt.runner.isRunning(cell)).toBe(false);
      await settled();
      expect(storedSetupOf(child)).toEqual(storedChild);
    });

    it("refuses the parent's start, naming the child, and writes to neither", async () => {
      const { cell, child } = await setUpWithRefusedChild("child-refused");
      const stored = [storedSetupOf(cell), storedSetupOf(child)];
      const starts = refusalsLogged();
      const setups = warned("piece-setup-refused");

      const refused = await rt.start(cell).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(refused).toBeInstanceOf(PieceStateMovedError);
      expect((refused as PieceStateMovedError).piece).toBe(child.sourceURI);
      expect(rt.runner.isRunning(cell)).toBe(false);
      expect(rt.runner.isRunning(child)).toBe(false);
      await settled();
      expect([storedSetupOf(cell), storedSetupOf(child)]).toEqual(stored);
      expect(warned("piece-setup-refused")).toBe(setups + 1);
      expect(refusalsLogged()).toBe(starts + 1);
    });

    it("refuses a setup of the parent's version whose start sets the child up in the same transaction, naming the child", async () => {
      // Here the child's record is loaded, and the parent's start, which
      // sets the child up, runs within `run()`'s own transaction, so the
      // child's refusal reaches `run()`'s caller. Where the child's record is
      // not loaded yet, `run()` cannot judge it: the refusal comes when the
      // parent starts, and is logged rather than thrown to `run()`'s caller.
      const { cell, pattern, child } = await setUpWithRefusedChild(
        "child-refused-setup",
      );
      const stored = [storedSetupOf(cell), storedSetupOf(child)];

      const tx = rt.edit();
      let refused: unknown;
      try {
        rt.run(tx, pattern, {}, cell);
      } catch (error) {
        refused = error;
      }
      tx.abort("setup refused");
      await settled();

      expect(refused).toBeInstanceOf(PieceStateMovedError);
      expect((refused as PieceStateMovedError).piece).toBe(child.sourceURI);
      expect(rt.runner.isRunning(cell)).toBe(false);
      expect([storedSetupOf(cell), storedSetupOf(child)]).toEqual(stored);
    });
  });

  it("refuses to start a piece whose cells holding state of one description another build mapped the other way", async () => {
    // Two writables of one description trading numbers keep every cell at a
    // number of its description, so the pairing reports no move; only the
    // projection map differs. Re-staging would link each writable's slot to
    // the other's state, so the start holds on the shared description.
    const { cell, pattern, ref } = await setUpAndStop("traded", STATEFUL_PAIR);
    const [first, second] = positionalDescriptors(pattern).filter((
      descriptor,
    ) => descriptor.kind !== "computed").map((descriptor) =>
      descriptor.partialCause.$generated
    );
    await storeAsBuild(
      cell,
      pattern,
      ref,
      (n) => n === first ? second : n === second ? first : n,
    );
    expect(stampOf(cell)?.cells).toBe(
      storedSetupBuildOf(pattern, ref, entryRefOf).cells,
    );

    const refused = await expectStartRefused(cell);

    expect(refused.moved).toEqual([]);
    expect(refused.ambiguous.map(({ before, after }) => [before, after]))
      .toEqual([[[first, second], [first, second]]]);
  });

  it("refuses to start a piece whose record says a cell holding state moved, under a marker naming another version", async () => {
    // A manifest lacking one of the version's cells under a marker naming
    // another version is repaired whatever the cells holding state, where
    // no record of the version exists: that is a version whose setup never
    // ran. A record of the version proves its setup did run, so the refusal
    // it decided stands.
    const { cell, pattern, ref } = await setUpAndStop(
      "held-under-other-marker",
      STATEFUL,
    );
    await storeAsBuild(cell, pattern, ref, (n) => n + 1);
    const tx = rt.edit();
    const manifest = convertibleJsFromFabricValue(
      cell.withTx(tx).getMetaRaw("internal"),
    ) as unknown[];
    cell.withTx(tx).setMetaRaw(
      "internal",
      fabricFromConvertibleJsValue(manifest.slice(1)),
      rawMetaWriteAuthorization,
    );
    cell.withTx(tx).setMetaRaw(
      "patternSetupIdentity",
      { identity: "another version", symbol: ref.symbol },
      rawMetaWriteAuthorization,
    );
    expect((await tx.commit().settled).error).toBeUndefined();

    await expectStartRefused(cell);
  });

  it("re-stages a piece with no record whose build has no cell holding state", async () => {
    const { cell, pattern, ref } = await setUpAndStop("unrecorded-derived");
    const expected = projectionLinkIds(cell);
    const record = stampOf(cell);
    await storeAsBuild(cell, pattern, ref, (n) => n + 1);
    await stamp(cell, undefined);
    expect(stampOf(cell)).toBeUndefined();

    expect(await startAndReadSlots(cell)).toEqual(SLOT_VALUES);

    expect(projectionLinkIds(cell)).toEqual(expected);
    expect(stampOf(cell)).toEqual(record);
  });

  it("holds a piece with no record whose build has a cell holding state", async () => {
    // With no record of the build that set the piece up, nothing says which
    // cells moved, and the stored setup of a build with a cell holding state
    // is left as it is. Nothing says the piece's state moved either, so it
    // runs over that setup rather than being refused.
    const { cell, pattern, ref } = await setUpAndStop(
      "unrecorded-stateful",
      STATEFUL,
    );
    await storeAsBuild(cell, pattern, ref, (n) => n + 1);
    await stamp(cell, undefined);
    const stored = storedSetupOf(cell);
    const holdsBefore = holdsLogged();
    const refusalsBefore = refusalsLogged();

    expect(await rt.start(cell)).toBe(true);
    await cell.pull();
    await settled();

    expect(rt.runner.isRunning(cell)).toBe(true);
    expect(storedSetupOf(cell)).toEqual(stored);
    expect(holdsLogged()).toBe(holdsBefore + 1);
    expect(refusalsLogged()).toBe(refusalsBefore);
  });

  it("holds rather than refuses a piece whose version-1 record says a cell holding state moved", async () => {
    // A record of version 1 may describe a child by a name another load
    // gives it differently, so it reads as none, and a hold it would have
    // decided is one with no record: the piece runs over its stored setup.
    const { cell, pattern, ref } = await setUpAndStop(
      "version-1-moved",
      STATEFUL,
    );
    await storeAsBuild(cell, pattern, ref, (n) => n + 1);
    await stamp(cell, { ...stampOf(cell)!, v: 1 } as never);
    expect(stampOf(cell)).toBeUndefined();
    const stored = storedSetupOf(cell);
    const holdsBefore = holdsLogged();
    const refusalsBefore = refusalsLogged();

    expect(await rt.start(cell)).toBe(true);
    await cell.pull();
    await settled();

    expect(rt.runner.isRunning(cell)).toBe(true);
    expect(storedSetupOf(cell)).toEqual(stored);
    expect(holdsLogged()).toBe(holdsBefore + 1);
    expect(refusalsLogged()).toBe(refusalsBefore);
  });

  it("reads a record of another version as none", async () => {
    const { cell, pattern, ref } = await setUpAndStop("other-version");
    const expected = projectionLinkIds(cell);
    const record = stampOf(cell);
    await storeAsBuild(cell, pattern, ref, (n) => n + 1);
    await stamp(cell, "a record of another version");
    expect(stampOf(cell)).toBeUndefined();

    expect(await startAndReadSlots(cell)).toEqual(SLOT_VALUES);

    expect(projectionLinkIds(cell)).toEqual(expected);
    expect(stampOf(cell)).toEqual(record);
  });

  it("reads a record of version 1 as none", async () => {
    // Version 1 described a sub-pattern child by the first of its module's
    // names for it that a load registered, and a cold reopen can register them
    // in another order than setup did. This is the record of a setup whose
    // load registered `Tally` first, which this build's description of the
    // child does not match.
    const { cell, pattern, ref } = await setUpAndStop(
      "version-1",
      ALIASED_CHILDREN,
    );
    const registeredFirst = (artifact: object) => {
      const entry = entryRefOf(artifact);
      return entry?.symbol === "Counter"
        ? { ...entry, symbol: "Tally" }
        : entry;
    };
    await stamp(
      cell,
      {
        ...storedSetupBuildOf(pattern, ref, registeredFirst),
        v: 1,
      } as never,
    );
    expect(stampOf(cell)).toBeUndefined();
    const stored = storedSetupOf(cell);
    const holds = holdsLogged();

    expect(await rt.start(cell)).toBe(true);
    await cell.pull();
    await settled();

    expect(holdsLogged()).toBe(holds);
    expect(storedSetupOf(cell)).toEqual(stored);
  });

  it("leaves a piece alone whose stored setup agrees with the build", async () => {
    const { cell } = await setUpAndStop("agreeing");
    const stored = storedSetupOf(cell);

    expect(await startAndReadSlots(cell)).toEqual(SLOT_VALUES);

    expect(storedSetupOf(cell)).toEqual(stored);
  });

  it("leaves a piece alone whose stored setup predates the record", async () => {
    // A document set up before the record existed carries none, and an
    // agreeing manifest is all it is judged by: nothing re-stages it, and
    // nothing stamps it until a setup runs for another reason.
    const { cell } = await setUpAndStop("unrecorded");
    await stamp(cell, undefined);
    const stored = storedSetupOf(cell);
    expect(stored.stamp).toBeUndefined();

    expect(await startAndReadSlots(cell)).toEqual(SLOT_VALUES);

    expect(storedSetupOf(cell)).toEqual(stored);
  });

  it("leaves a piece alone on a cold reopen by another runtime of the same build", async () => {
    // The cases above start in the runtime that set the piece up, so the
    // start describes the same pattern object setup stamped. A reopen loads
    // the pattern by identity through the compile cache, and its record has
    // to be the same one, or every cold start would re-stage.
    const { cell } = await setUpAndStop("cold");
    const stored = storedSetupOf(cell);
    await rt.patternManager.flushCompileCacheWrites();
    await rt.storageManager.synced();
    await rt.dispose();

    rt = openRuntime(signer);
    const reopened = rt.getCell<Result>(space, "cold");
    expect(await startAndReadSlots(reopened)).toEqual(SLOT_VALUES);

    expect(storedSetupOf(reopened)).toEqual(stored);
  });

  it("leaves a piece alone on a cold reopen whose children's module exports them under several names", async () => {
    // A load registers each of a module's names for a pattern, in an order
    // that differs between setup and a reopen by identity. A child is
    // described by the least of them, so the reopen describes the children
    // as setup did, and finds nothing moved.
    const { cell } = await setUpAndStop("cold-aliased", ALIASED_CHILDREN);
    const stored = storedSetupOf(cell);
    const described = stampOf(cell)!.state.map(([, description]) =>
      description.replace(/ [^ ]+#/, " <child>#")
    );
    expect(described).toEqual([
      "cell, computed, written by sub-pattern <child>#Counter",
      "cell, computed, written by sub-pattern <child>#Counter",
    ]);
    await rt.patternManager.flushCompileCacheWrites();
    await rt.storageManager.synced();
    await rt.dispose();

    rt = openRuntime(signer);
    const reopened = rt.getCell<Result>(space, "cold-aliased");
    const holds = holdsLogged();
    expect(await rt.start(reopened)).toBe(true);
    await reopened.pull();
    await settled();

    expect(holdsLogged()).toBe(holds);
    expect(storedSetupOf(reopened)).toEqual(stored);
  });

  it("describes children alike on setup and on a cold reopen, which register their names in different orders", async () => {
    // Each load registers all of a module's names before it returns a
    // pattern, so the least of them is known by the time a description is
    // computed, whatever order the load registered them in.
    const { cell, pattern, ref } = await setUpAndStop(
      "cold-described",
      ALIASED_CHILDREN,
    );
    expect(rt.patternManager.getArtifactEntryRef(childOf(pattern))?.symbol)
      .toBe("Counter");
    const stamped = stampOf(cell);
    await rt.patternManager.flushCompileCacheWrites();
    await rt.storageManager.synced();
    await rt.dispose();

    rt = openRuntime(signer);
    const reopened = rt.getCell<Result>(space, "cold-described");
    expect(await rt.start(reopened)).toBe(true);
    await reopened.pull();
    await settled();
    const loaded = rt.patternManager.artifactFromIdentitySync(
      ref.identity,
      ref.symbol,
    ) as Pattern;

    expect(rt.patternManager.getArtifactEntryRef(childOf(loaded))?.symbol)
      .toBe("Tally");
    expect(storedSetupBuildOf(loaded, ref, entryRefOf)).toEqual(stamped);
  });

  describe("for a principal with READ access to the space", () => {
    // The repair commits as whoever starts the piece. A READ member cannot
    // make that commit, and a start whose only failure is the repair's is a
    // start the member is still entitled to: the piece runs for them over
    // the stored setup, the record stays as it was, and the next start by a
    // writer repairs it.

    const AUDIENCE = "did:key:z6Mk-runner-stored-setup-build-repair-audience";

    /** Opens each session on the one in-process server, as `signer`. */
    class LoopbackSessionFactory implements SessionFactory {
      readonly supportsAclBootstrap = true;
      readonly #server: MemoryV2Server.Server;

      constructor(server: MemoryV2Server.Server) {
        this.#server = server;
      }

      async create(
        space: MemorySpace,
        signer?: Signer,
        requested: MemoryV2Client.MountOptions = {},
      ) {
        const client = await MemoryV2Client.connect({
          transport: MemoryV2Client.loopback(this.#server),
        });
        const session = await client.mount(
          space,
          requested,
          (_space, _session, context) => ({
            invocation: {
              aud: context.audience,
              challenge: context.challenge.value,
            },
            authorization: { principal: signer?.did() },
          }),
        );
        return { client, session };
      }
    }

    class TestStorageManager extends StorageManager {
      static overServer(
        options: Omit<Options, "memoryHost">,
        factory: SessionFactory,
      ): TestStorageManager {
        return new TestStorageManager(
          { ...options, memoryHost: new URL("memory://") },
          factory,
        );
      }
    }

    let enforcing: MemoryV2Server.Server;
    let runtimes: Runtime[];

    const openAs = (identity: Identity): Runtime => {
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: TestStorageManager.overServer(
          { as: identity },
          new LoopbackSessionFactory(enforcing),
        ),
      });
      runtimes.push(runtime);
      return runtime;
    };

    beforeEach(() => {
      enforcing = new MemoryV2Server.Server({
        store: new URL(
          `memory://stored-setup-build-repair-${crypto.randomUUID()}`,
        ),
        authorizeSessionOpen: authorizeLoopbackSessionOpen,
        sessionOpenAuth: { audience: AUDIENCE },
        acl: { mode: "enforce" },
        subscriptionRefreshDelayMs: 0,
      });
      runtimes = [];
    });

    afterEach(async () => {
      for (const runtime of runtimes) await runtime.dispose();
      await enforcing.close();
    });

    it("starts a piece whose stored setup is another build's, without re-staging it", async () => {
      const owner = await Identity.fromPassphrase("build repair owner");
      const reader = await Identity.fromPassphrase("build repair reader");
      const ownerRt = openAs(owner);
      const shared = await ownerRt.createSpace({
        grants: { [reader.did()]: "READ" },
      });
      const tx = ownerRt.edit();
      const pattern = await ownerRt.patternManager.compilePattern(DERIVED, {
        space: shared,
        tx,
      }) as Pattern;
      const owned = ownerRt.getCell<Result>(shared, "shared", undefined, tx);
      const running = ownerRt.run(tx, pattern, { input: INPUT }, owned);
      await tx.commit().settled;
      await running.pull();
      await ownerRt.idle();
      ownerRt.runner.stop(owned);
      // The record of a build that numbered one more root, over the current
      // build's projection: the start owes a repair, and the values read
      // right either way.
      const ref = ownerRt.patternManager.getArtifactEntryRef(pattern)!;
      const foreign = storedSetupBuildOf(
        otherBuild(pattern, (n) => n + 1),
        ref,
        (artifact) => ownerRt.patternManager.getArtifactEntryRef(artifact),
      );
      const stampTx = ownerRt.edit();
      owned.withTx(stampTx).setMetaRaw(
        "patternSetupBuild",
        fabricFromConvertibleJsValue(foreign as never),
        rawMetaWriteAuthorization,
      );
      expect((await stampTx.commit().settled).error).toBeUndefined();
      await ownerRt.patternManager.flushCompileCacheWrites();
      await ownerRt.storageManager.synced();

      const readerRt = openAs(reader);
      const read = readerRt.getCell<Result>(shared, "shared");
      // Rejects when the start's commit fails, through the retry a refused
      // repair takes.
      expect(await readerRt.runner.startWithCommit(read)).toBe(true);
      await read.pull();
      await readerRt.idle();

      expect(readerRt.runner.isRunning(read)).toBe(true);
      expect((read.getAsQueryResult() as Result).$UI.children).toEqual(
        SLOT_VALUES,
      );
      expect(readStoredSetupBuild(read.getMetaRaw("patternSetupBuild")))
        .toEqual(foreign);
    });

    it("refuses a piece whose record says a cell holding state moved, as it does for a writer", async () => {
      // A refusal writes nothing, so whether the starter could write does
      // not change it: a READ member is refused the same piece a writer is.
      const owner = await Identity.fromPassphrase("build refusal owner");
      const reader = await Identity.fromPassphrase("build refusal reader");
      const ownerRt = openAs(owner);
      const shared = await ownerRt.createSpace({
        grants: { [reader.did()]: "READ" },
      });
      const tx = ownerRt.edit();
      const pattern = await ownerRt.patternManager.compilePattern(STATEFUL, {
        space: shared,
        tx,
      }) as Pattern;
      const owned = ownerRt.getCell<Result>(shared, "shared", undefined, tx);
      const running = ownerRt.run(tx, pattern, { input: INPUT }, owned);
      await tx.commit().settled;
      await running.pull();
      await ownerRt.idle();
      ownerRt.runner.stop(owned);
      // The record of a build that numbered one more root: the writable
      // sits at the next number there.
      const ref = ownerRt.patternManager.getArtifactEntryRef(pattern)!;
      const foreign = storedSetupBuildOf(
        otherBuild(pattern, (n) => n + 1),
        ref,
        (artifact) => ownerRt.patternManager.getArtifactEntryRef(artifact),
      );
      const stampTx = ownerRt.edit();
      owned.withTx(stampTx).setMetaRaw(
        "patternSetupBuild",
        fabricFromConvertibleJsValue(foreign as never),
        rawMetaWriteAuthorization,
      );
      expect((await stampTx.commit().settled).error).toBeUndefined();
      await ownerRt.patternManager.flushCompileCacheWrites();
      await ownerRt.storageManager.synced();

      const readerRt = openAs(reader);
      const read = readerRt.getCell<Result>(shared, "shared");
      const refused = await readerRt.start(read).then(
        () => undefined,
        (error: unknown) => error,
      );
      await readerRt.idle();

      expect(refused).toBeInstanceOf(PieceStateMovedError);
      expect(readerRt.runner.isRunning(read)).toBe(false);
      expect(readStoredSetupBuild(read.getMetaRaw("patternSetupBuild")))
        .toEqual(foreign);
    });
  });
});

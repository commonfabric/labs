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
import { Runtime } from "../src/runtime.ts";
import {
  readStoredSetupBuild,
  type StoredSetupBuild,
  storedSetupBuildOf,
} from "../src/stored-setup-build.ts";

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
 * nodes, cells and result, with every positional cause renumbered.
 */
const otherBuild = (
  pattern: Pattern,
  renumber: (n: number) => number,
): Pattern => ({
  ...pattern,
  nodes: renumbered(pattern.nodes, renumber) as Pattern["nodes"],
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
  // the projection where that puts them right, and leaves the stored setup
  // as it is where a cell holding state moved.

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
    rt.patternManager.getArtifactEntryRef(artifact);

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

  const positionalDescriptors = (pattern: Pattern): PositionalDescriptor[] =>
    (pattern.derivedInternalCells ?? []).filter(isPositional);

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

  // How many times a start has logged a hold. A hold's start writes no
  // setup, so the log line is its one signal; `describeHold()` is what it
  // says.
  const holdsLogged = (): number =>
    (getLoggerCountsBreakdown().runner?.["piece-start-repair-held"] as
      | { warn?: number }
      | undefined)?.warn ?? 0;

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

    expect(record?.v).toBe(1);
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

  it("holds a piece whose cell holding state another build numbered differently, writing nothing", async () => {
    // Re-staging would link the writable's slot to the cell the current build
    // numbers for it, where another cell's state sits. The start writes no
    // setup instead, so the stored setup stays as the evidence of what
    // moved, for a repair that can move the state.
    const { cell, pattern, ref } = await setUpAndStop("held", STATEFUL);
    await storeAsBuild(cell, pattern, ref, (n) => n + 1);
    const stored = storedSetupOf(cell);
    const holdsBefore = holdsLogged();

    expect(await rt.start(cell)).toBe(true);
    await cell.pull();
    await settled();

    expect(rt.runner.isRunning(cell)).toBe(true);
    expect(storedSetupOf(cell)).toEqual(stored);
    expect(holdsLogged()).toBe(holdsBefore + 1);
  });

  it("holds a piece whose cells holding state of one description another build mapped the other way", async () => {
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
    const stored = storedSetupOf(cell);
    expect(stampOf(cell)?.cells).toBe(
      storedSetupBuildOf(pattern, ref, entryRefOf).cells,
    );

    expect(await rt.start(cell)).toBe(true);
    await cell.pull();
    await settled();

    expect(rt.runner.isRunning(cell)).toBe(true);
    expect(storedSetupOf(cell)).toEqual(stored);
  });

  it("holds a piece whose record says a cell holding state moved, under a marker naming another version", async () => {
    // A manifest lacking one of the version's cells under a marker naming
    // another version is repaired whatever the cells holding state, where
    // no record of the version exists: that is a version whose setup never
    // ran. A record of the version proves its setup did run, so the hold it
    // decided stands.
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
    const stored = storedSetupOf(cell);

    expect(await rt.start(cell)).toBe(true);
    await cell.pull();
    await settled();

    expect(rt.runner.isRunning(cell)).toBe(true);
    expect(storedSetupOf(cell)).toEqual(stored);
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
    // is left as it is.
    const { cell, pattern, ref } = await setUpAndStop(
      "unrecorded-stateful",
      STATEFUL,
    );
    await storeAsBuild(cell, pattern, ref, (n) => n + 1);
    await stamp(cell, undefined);
    const stored = storedSetupOf(cell);

    expect(await rt.start(cell)).toBe(true);
    await cell.pull();
    await settled();

    expect(rt.runner.isRunning(cell)).toBe(true);
    expect(storedSetupOf(cell)).toEqual(stored);
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
  });
});

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
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

const signer = await Identity.fromPassphrase("stored-setup-build-repair");
const space = signer.did();

// Two derived cells inside the view tree. A cell a result key reaches is
// named by its path; one inside the `[UI]` tree is a positional root of the
// build, with an anonymous cause `{ $generated: N }` in the order the builder
// reaches it. The stored tree links each slot to its cell by that cause.
const PROGRAM: RuntimeProgram = {
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

const INPUT = 5;
const SLOT_VALUES = [INPUT * 2, INPUT * 3];

type Result = { $UI: { children: number[] } };

type PositionalDescriptor = DerivedInternalCellDescriptor & {
  partialCause: { $generated: number };
};

const isPositional = (
  descriptor: DerivedInternalCellDescriptor,
): descriptor is PositionalDescriptor =>
  typeof (descriptor.partialCause as { $generated?: unknown })?.$generated ===
    "number";

describe("stored-setup-build-repair", () => {
  // A piece's result projection and internal-cell manifest are written by the
  // build that sets it up, and link each slot to the derived cell that build
  // numbered for it. A later build of the same pattern source can number its
  // roots differently, and then writes each slot's value to a cell the stored
  // projection reads as another slot. `Runner.#storedSetupAgrees()` sees the
  // disagreement from the stored state alone, and `#startCore()` re-stages the
  // internal cells and the projection before instantiating.

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

  // Sets a piece up, lets its derived cells compute, and stops it, so that a
  // later start takes the plain start path and its repair decision.
  const setUpAndStop = async (name: string) => {
    const tx = rt.edit();
    const pattern = await rt.patternManager.compilePattern(PROGRAM, {
      space,
      tx,
    }) as Pattern;
    const cell = rt.getCell<Result>(space, name, undefined, tx);
    const running = rt.run(tx, pattern, { input: INPUT }, cell);
    await tx.commit().settled;
    await running.pull();
    await settled();
    rt.runner.stop(cell);
    return { cell, pattern };
  };

  const positionalDescriptors = (pattern: Pattern): PositionalDescriptor[] =>
    (pattern.derivedInternalCells ?? []).filter(isPositional);

  const shiftedDescriptor = (
    descriptor: PositionalDescriptor,
    by: number,
  ): PositionalDescriptor => ({
    ...descriptor,
    // Deep-frozen, as the builder leaves every cause it assigns; the id
    // minting refuses one that is not.
    partialCause: Object.freeze({
      $generated: descriptor.partialCause.$generated + by,
    }),
  });

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

  const writeProjection = async (
    cell: Cell<unknown>,
    rewrite: (
      withTx: Cell<unknown>,
      tx: ReturnType<Runtime["edit"]>,
    ) => unknown,
  ) => {
    const tx = rt.edit();
    const withTx = cell.withTx(tx);
    withTx.setRawUntyped(
      fabricFromConvertibleJsValue(rewrite(withTx, tx)),
      false,
      "output",
    );
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  // Stores the projection and the manifest as a build with `by` more roots
  // ahead of these would have written them: every link to a positional cell
  // names the cell `by` positions later.
  const storeAsShiftedBuild = async (
    cell: Cell<unknown>,
    pattern: Pattern,
    by: number,
  ) => {
    const tx = rt.edit();
    const withTx = cell.withTx(tx);
    const replacement = new Map<string, unknown>(
      positionalDescriptors(pattern).map((descriptor) => [
        getDerivedInternalCellLink(withTx, descriptor).id,
        redirectLinkTo(withTx, shiftedDescriptor(descriptor, by), tx),
      ]),
    );
    withTx.setRawUntyped(
      fabricFromConvertibleJsValue(
        mapLinks(rawProjection(withTx), withTx, (id) => replacement.get(id)),
      ),
      false,
      "output",
    );
    const manifest = (pattern.derivedInternalCells ?? []).map((descriptor) => {
      const stored = isPositional(descriptor)
        ? shiftedDescriptor(descriptor, by)
        : descriptor;
      return {
        partialCause: stored.partialCause,
        ...(stored.kind !== undefined && { kind: stored.kind }),
        link: redirectLinkTo(withTx, stored, tx),
      };
    });
    withTx.setMetaRaw(
      "internal",
      fabricFromConvertibleJsValue(manifest),
      rawMetaWriteAuthorization,
    );
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  const setBuildStamp = async (
    cell: Cell<unknown>,
    stamp: FabricValue | undefined,
  ) => {
    const tx = rt.edit();
    cell.withTx(tx).setMetaRaw(
      "patternSetupBuild",
      stamp,
      rawMetaWriteAuthorization,
    );
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  const startAndReadSlots = async (cell: Cell<Result>): Promise<number[]> => {
    expect(await rt.start(cell)).toBe(true);
    await cell.pull();
    await settled();
    return (cell.getAsQueryResult() as Result).$UI.children;
  };

  it("numbers the view's derived cells positionally", async () => {
    // The fixture's premise: the two slots are consecutive positional roots,
    // so a build with one more root ahead of them moves both by one.
    const { pattern } = await setUpAndStop("positional");
    const causes = positionalDescriptors(pattern).map((descriptor) =>
      descriptor.partialCause.$generated
    ).sort();

    expect(causes).toEqual([0, 1]);
  });

  it("stamps the digest of the build setup staged", async () => {
    const { cell } = await setUpAndStop("stamped");
    const stamp = cell.getMetaRaw("patternSetupBuild");

    expect(typeof stamp).toBe("string");
    expect(stamp).not.toBe("");
    const { cell: other } = await setUpAndStop("stamped-too");
    expect(other.getMetaRaw("patternSetupBuild")).toBe(stamp);
  });

  it("re-stages a piece whose stored setup is a build that numbered one more root", async () => {
    const { cell, pattern } = await setUpAndStop("shifted");
    const expected = projectionLinkIds(cell);
    const expectedCauses = manifestCauses(cell);
    // The slot each positional cause's cell is linked from, by cause number.
    const slotOfCause = (generated: number): string => {
      const descriptor = positionalDescriptors(pattern).find((candidate) =>
        candidate.partialCause.$generated === generated
      )!;
      const id = getDerivedInternalCellLink(cell, descriptor).id;
      return Object.entries(expected).find(([, linked]) => linked === id)![0];
    };
    await storeAsShiftedBuild(cell, pattern, 1);
    // The simulation is faithful: the slot of cause 0 now links the cell this
    // build numbers 1, which is the slot after it, read one slot off.
    expect(projectionLinkIds(cell)[slotOfCause(0)]).toBe(
      expected[slotOfCause(1)],
    );
    expect(manifestCauses(cell)).not.toEqual(expectedCauses);

    expect(await startAndReadSlots(cell)).toEqual(SLOT_VALUES);

    expect(projectionLinkIds(cell)).toEqual(expected);
    expect(manifestCauses(cell)).toEqual(expectedCauses);
  });

  it("re-stages a piece whose stamped build digest is not this build's", async () => {
    // A build that keeps every cause and kind but moves a node behind one of
    // them leaves the manifest's causes intact, so only the digest sees it.
    // Simulated by swapping the two slots' links and stamping another build.
    const { cell, pattern } = await setUpAndStop("other-digest");
    const expected = projectionLinkIds(cell);
    const stamp = cell.getMetaRaw("patternSetupBuild");
    const [first, second] = positionalDescriptors(pattern);
    await writeProjection(cell, (withTx, tx) => {
      const swap = new Map<string, unknown>([
        [
          getDerivedInternalCellLink(withTx, first).id,
          redirectLinkTo(withTx, second, tx),
        ],
        [
          getDerivedInternalCellLink(withTx, second).id,
          redirectLinkTo(withTx, first, tx),
        ],
      ]);
      return mapLinks(rawProjection(withTx), withTx, (id) => swap.get(id));
    });
    await setBuildStamp(cell, "another build");
    expect(projectionLinkIds(cell)["/$UI/children/0"]).toBe(
      expected["/$UI/children/1"],
    );

    expect(await startAndReadSlots(cell)).toEqual(SLOT_VALUES);

    expect(projectionLinkIds(cell)).toEqual(expected);
    expect(cell.getMetaRaw("patternSetupBuild")).toBe(stamp);
  });

  it("leaves a piece alone whose stored setup agrees with the build", async () => {
    const { cell } = await setUpAndStop("agreeing");
    const projection = cell.getRaw();
    const manifest = cell.getMetaRaw("internal");

    expect(await startAndReadSlots(cell)).toEqual(SLOT_VALUES);

    expect(cell.getRaw()).toEqual(projection);
    expect(cell.getMetaRaw("internal")).toEqual(manifest);
  });

  it("leaves a piece alone whose stored setup predates the build digest", async () => {
    // A document set up before the digest existed carries none, and an
    // agreeing manifest is all it is judged by: nothing re-stages it, and
    // nothing stamps it until a setup runs for another reason.
    const { cell } = await setUpAndStop("undigested");
    await setBuildStamp(cell, undefined);
    expect(cell.getMetaRaw("patternSetupBuild")).toBeUndefined();
    const projection = cell.getRaw();
    const manifest = cell.getMetaRaw("internal");

    expect(await startAndReadSlots(cell)).toEqual(SLOT_VALUES);

    expect(cell.getRaw()).toEqual(projection);
    expect(cell.getMetaRaw("internal")).toEqual(manifest);
    expect(cell.getMetaRaw("patternSetupBuild")).toBeUndefined();
  });

  it("leaves a piece alone on a cold reopen by another runtime of the same build", async () => {
    // The cases above start in the runtime that set the piece up, so the
    // start digests the same pattern object setup stamped. A reopen loads the
    // pattern by identity through the compile cache, and its digest has to
    // be the same one, or every cold start would re-stage.
    const { cell } = await setUpAndStop("cold");
    const stamp = cell.getMetaRaw("patternSetupBuild");
    const projection = cell.getRaw();
    const manifest = cell.getMetaRaw("internal");
    await rt.patternManager.flushCompileCacheWrites();
    await rt.storageManager.synced();
    await rt.dispose();

    rt = openRuntime(signer);
    const reopened = rt.getCell<Result>(space, "cold");
    expect(await startAndReadSlots(reopened)).toEqual(SLOT_VALUES);

    expect(reopened.getMetaRaw("patternSetupBuild")).toBe(stamp);
    expect(reopened.getRaw()).toEqual(projection);
    expect(reopened.getMetaRaw("internal")).toEqual(manifest);
  });

  describe("for a principal with READ access to the space", () => {
    // The repair commits as whoever starts the piece. A READ member cannot
    // make that commit, and a start whose only failure is the repair's is a
    // start the member is still entitled to: the piece runs for them over
    // the stored setup, the stamp stays as it was, and the next start by a
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
      const pattern = await ownerRt.patternManager.compilePattern(PROGRAM, {
        space: shared,
        tx,
      }) as Pattern;
      const owned = ownerRt.getCell<Result>(shared, "shared", undefined, tx);
      const running = ownerRt.run(tx, pattern, { input: INPUT }, owned);
      await tx.commit().settled;
      await running.pull();
      await ownerRt.idle();
      ownerRt.runner.stop(owned);
      const stampTx = ownerRt.edit();
      owned.withTx(stampTx).setMetaRaw(
        "patternSetupBuild",
        "another build",
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
      expect(read.getMetaRaw("patternSetupBuild")).toBe("another build");
    });
  });
});

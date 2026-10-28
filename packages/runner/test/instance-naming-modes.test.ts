/**
 * Runtimes that differ in their `instanceNames` experimental flag, over one
 * store. Compiled code is never shared between the two naming modes, and a
 * cold start in either mode starts a parent the other set up, since both
 * modes stamp the same setup record. Each runtime sits on a storage manager
 * of its own over one memory server, so it starts from what it syncs, as a
 * runtime in another process does.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import type { Pattern } from "../src/builder/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("instance-naming-modes");
const space = signer.did();

// A counter whose count a stream bumps.
const COUNTER = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "const bump = handler<{ by: number }, { count: Writable<number> }>(",
  "  (event, { count }) => {",
  "    count.set(count.get() + event.by);",
  "  },",
  ");",
  "export const Counter = pattern<",
  "  { label: string },",
  "  { count: Writable<number>; bump: Stream<{ by: number }> }",
  ">(() => {",
  "  const count = new Writable<number>(0).for('count');",
  "  return { count, bump: bump({ count }) };",
  "});",
  "",
].join("\n");

// A parent with two `const`-bound children of one pattern.
const PARENT: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    { name: "/counter.tsx", contents: COUNTER },
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "import { Counter } from './counter.tsx';",
        "export default pattern<Record<string, never>>(() => {",
        "  const s = Counter({ label: 's' });",
        "  const a = Counter({ label: 'a' });",
        "  return {",
        "    views: [s, a],",
        "    aCount: a.count,",
        "    sCount: s.count,",
        "    aBump: a.bump,",
        "    sBump: s.bump,",
        "  };",
        "});",
        "",
      ].join("\n"),
    },
  ],
};

describe("instance-naming-modes", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let live: { runtime: Runtime; manager: EmulatedStorageManager }[];

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    live = [];
  });
  afterEach(async () => {
    for (const { runtime, manager } of live) {
      await runtime.dispose({ closeStorage: false });
      await manager.close();
    }
    await server.close();
  });

  // A runtime on a storage manager of its own over `server`, naming
  // instances when `instanceNames` is true.
  const runtimeNaming = (instanceNames: boolean): Runtime => {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { instanceNames },
    });
    live.push({ runtime, manager });
    return runtime;
  };

  // Writes back everything `runtime` holds and stops it.
  const retire = async (runtime: Runtime) => {
    await runtime.idle();
    await runtime.patternManager.flushCompileCacheWrites();
    await runtime.storageManager.synced();
    const index = live.findIndex((entry) => entry.runtime === runtime);
    const [{ manager }] = live.splice(index, 1);
    await runtime.dispose({ closeStorage: false });
    await manager.close();
  };

  // Whether `pattern` gives any sub-pattern instance an instance name.
  const namesAnInstance = (pattern: Pattern): boolean =>
    (pattern.derivedInternalCells ?? []).some((descriptor) =>
      descriptor.legacyPartialCause !== undefined
    );

  describe("compiled code", () => {
    it("is not shared from a runtime that names instances with one that does not", async () => {
      const naming = runtimeNaming(true);
      const named = await naming.patternManager.compilePattern(PARENT, {
        space,
      });
      const identity = naming.patternManager.getArtifactEntryRef(named)!
        .identity;
      await retire(naming);

      const positional = runtimeNaming(false);
      const loaded = await positional.patternManager.compilePattern(PARENT, {
        space,
        knownEntryIdentity: identity,
      });

      expect({
        named: namesAnInstance(named),
        loaded: namesAnInstance(loaded),
      }).toEqual({ named: true, loaded: false });
    });

    it("is not shared from a runtime that does not name instances with one that does", async () => {
      const positional = runtimeNaming(false);
      const unnamed = await positional.patternManager.compilePattern(PARENT, {
        space,
      });
      const identity = positional.patternManager.getArtifactEntryRef(unnamed)!
        .identity;
      await retire(positional);

      const naming = runtimeNaming(true);
      const loaded = await naming.patternManager.compilePattern(PARENT, {
        space,
        knownEntryIdentity: identity,
      });

      expect({
        unnamed: namesAnInstance(unnamed),
        loaded: namesAnInstance(loaded),
      }).toEqual({ unnamed: false, loaded: true });
    });
  });

  describe("a parent with two children of one pattern, started cold", () => {
    // The setup record a start holds the stored setup against describes a
    // named instance at its legacy number, in its cells and in its
    // projection, so the record one naming mode stamps is the record the
    // other builds. A start in either mode, of a parent the other mode set
    // up, therefore never takes the change of mode for a move of the
    // children's state.

    const PIECE = "parent";

    const bump = async (runtime: Runtime, key: string, by: number) => {
      const parent = runtime.getCell(space, PIECE);
      await parent.sync();
      parent.key(key).send({ by });
      await runtime.idle();
    };

    // Sets the parent up in a runtime with naming `setUpNaming`, with a count
    // of 7 written to `a` and 20 to `s`, then starts it cold in a runtime
    // with naming `startNaming`. Returns how the start ended and the counts
    // the parent then shows.
    const setUpThenStart = async (
      setUpNaming: boolean,
      startNaming: boolean,
    ) => {
      const first = runtimeNaming(setUpNaming);
      const pattern = await first.patternManager.compilePattern(PARENT, {
        space,
      });
      const tx = first.edit();
      const running = first.run(
        tx,
        pattern,
        {},
        first.getCell(space, PIECE, undefined, tx),
      );
      expect((await tx.commit().settled).error).toBeUndefined();
      await running.pull();
      await first.idle();
      await bump(first, "aBump", 7);
      await bump(first, "sBump", 20);
      await retire(first);

      const second = runtimeNaming(startNaming);
      const parent = second.getCell<Record<string, unknown>>(space, PIECE);
      await parent.sync();
      const started = await second.runner.start(parent).then(
        (result) => result,
        (error: unknown) => (error as Error).name,
      );
      await second.idle();
      await parent.pull();
      const value = parent.get() as Record<string, unknown>;
      return { started, aCount: value.aCount, sCount: value.sCount };
    };

    it("starts it, with fresh children, when a runtime with naming on reopens a parent one with naming off set up", async () => {
      // The named instances run at spots of their own, which the setup with
      // naming off never set up.
      expect(await setUpThenStart(false, true)).toEqual({
        started: true,
        aCount: 0,
        sCount: 0,
      });
    });

    it("starts it, with fresh children, when a runtime with naming off reopens a parent one with naming on set up", async () => {
      // The positional roots run at spots of their own, which the setup with
      // naming on never set up.
      expect(await setUpThenStart(true, false)).toEqual({
        started: true,
        aCount: 0,
        sCount: 0,
      });
    });

    it("starts it and shows its children's counts, when a runtime with naming on reopens a parent one with naming on set up", async () => {
      expect(await setUpThenStart(true, true)).toEqual({
        started: true,
        aCount: 7,
        sCount: 20,
      });
    });

    it("starts it and shows its children's counts, when a runtime with naming off reopens a parent one with naming off set up", async () => {
      expect(await setUpThenStart(false, false)).toEqual({
        started: true,
        aCount: 7,
        sCount: 20,
      });
    });
  });
});

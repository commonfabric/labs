import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { deepFreeze } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import {
  instancePartialCause,
  nameInstance,
} from "../src/builder/instance-name.ts";
import { pattern } from "../src/builder/pattern.ts";
import type { Pattern, PatternFactory } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { getDerivedInternalCellLink } from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("instance-name-stamp");
const space = signer.did();

// A child compiled from source, so that what it sets up carries a pattern
// identity for the guard to name.
const COUNTER = [
  "import { pattern, Writable } from 'commonfabric';",
  "export default pattern<{ label: string }, { count: Writable<number> }>(",
  "  () => {",
  "    const count = new Writable<number>(0).for('count');",
  "    return { count };",
  "  },",
  ");",
  "",
].join("\n");

/** Whether the compiled pattern `compiled` can be called as a factory. */
const isFactory = (
  compiled: Pattern,
): compiled is Pattern & PatternFactory<{ label: string }, unknown> =>
  typeof compiled === "function";

describe("instance-name-stamp", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let rt: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    rt = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });
  afterEach(async () => {
    await rt?.dispose();
    await storageManager?.close();
  });

  /**
   * A parent holding the instance `a` of the compiled `Counter`, named, and a
   * positional instance of it after `a`, and with `withC` a third instance,
   * `c`, named, after both.
   */
  const parentPattern = async (
    { withC = false }: { withC?: boolean } = {},
  ): Promise<Pattern> => {
    const Counter = await rt.patternManager.compilePattern({
      main: "/counter.tsx",
      files: [{ name: "/counter.tsx", contents: COUNTER }],
    }, { space });
    if (!isFactory(Counter)) throw new Error("`Counter` is not a factory");
    return pattern<Record<string, never>>(() => {
      const a = nameInstance(Counter({ label: "a" }), "a");
      const p = Counter({ label: "p" });
      const views = [a, p];
      if (withC) views.push(nameInstance(Counter({ label: "c" }), "c"));
      return { views };
    });
  };

  /** The id of the child the parent at `cell` runs for the instance `name`. */
  const namedChild = (cell: Cell<unknown>, name: string): string => {
    const spot = getDerivedInternalCellLink(cell, {
      partialCause: deepFreeze(instancePartialCause(name)),
    });
    return rt.getCell(space, {
      resultFor: { space: spot.space, id: spot.id, path: [] },
    }).getAsNormalizedFullLink().id;
  };

  /** Records, until disposed, each child document the guard reads, by id. */
  const guardReads = (): { ids: string[]; [Symbol.dispose](): void } => {
    const ids: string[] = [];
    const access = rt.runner.accessForTestingOnly;
    access.displacedChildReadRecorder = (child) => ids.push(child);
    return {
      ids,
      [Symbol.dispose]: () => {
        access.displacedChildReadRecorder = undefined;
      },
    };
  };

  /**
   * A stopped parent named `name` that ran `parent`, with the named
   * instance's count set to 7. Returns the parent's result cell and each
   * child's result cell.
   */
  const deployedParent = async (name: string, parent: Pattern) => {
    const tx = rt.edit();
    const cell = rt.getCell<{ views: { count: number }[] }>(
      space,
      name,
      undefined,
      tx,
    );
    const running = rt.run(tx, parent, {}, cell);
    expect((await tx.commit().settled).error).toBeUndefined();
    await running.pull();
    await rt.idle();
    const named = cell.key("views").key(0).resolveAsCell();
    const positional = cell.key("views").key(1).resolveAsCell();
    await named.sync();
    await positional.sync();
    const write = rt.edit();
    named.withTx(write).key("count").set(7);
    expect((await write.commit().settled).error).toBeUndefined();
    await rt.idle();
    rt.runner.stop(cell);
    return { cell, named, positional };
  };

  /** Writes `name` as the instance name stamped on `child`. */
  const stamp = async (child: Cell<unknown>, name: string) => {
    const tx = rt.edit();
    child.withTx(tx).setMetaRaw(
      "instanceName",
      name,
      rawMetaWriteAuthorization,
    );
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  /**
   * Sets the parent at `cell` up again with the in-process `parent`, the way
   * an updater does: its pattern pointer is moved to `parent`'s keyless
   * identity first, and the setup goes through the root repair call the
   * updater makes.
   */
  const update = async (cell: Cell<unknown>, parent: Pattern) => {
    const ref = rt.patternManager.ensureKeylessPatternIdentity(parent);
    const tx = rt.edit();
    cell.withTx(tx).setMetaRaw("patternIdentity", {
      identity: ref.identity,
      symbol: ref.symbol,
    }, rawMetaWriteAuthorization);
    expect((await tx.commit().settled).error).toBeUndefined();
    await rt.runSynced(cell.withTx(), parent, {}, {
      expectedPatternIdentity: ref,
    });
    await rt.idle();
  };

  describe("a named instance's child", () => {
    it("carries its instance's name as its `instanceName` meta, where a positional instance's child carries none", async () => {
      const { named, positional } = await deployedParent(
        "stamped",
        await parentPattern(),
      );

      expect({
        named: named.getMetaRaw("instanceName"),
        positional: positional.getMetaRaw("instanceName"),
      }).toStrictEqual({ named: "a", positional: undefined });
    });
  });

  describe("a parent's setup", () => {
    it("refuses to set up an instance over a child stamped with another instance's name", async () => {
      const parent = await parentPattern();
      const { cell, named } = await deployedParent("stamped-other", parent);
      await stamp(named, "b");

      await expect(update(cell, parent)).rejects.toThrow(
        /refusing to set up .*#default for instance "a" over the child of .*#default that instance "b" set up/,
      );
    });

    it("refuses to set up an instance over a child stamped with another instance's name that records no pattern identity", async () => {
      // An in-process child's identity is keyless, and a keyless identity is
      // never stored on the child.

      const Child = pattern<{ label: string }>(({ label }) => ({ label }));
      const parent = pattern<Record<string, never>>(() => ({
        views: [nameInstance(Child({ label: "a" }), "a")],
      }));
      const tx = rt.edit();
      const cell = rt.getCell<{ views: { label: string }[] }>(
        space,
        "stamped-keyless",
        undefined,
        tx,
      );
      const running = rt.run(tx, parent, {}, cell);
      expect((await tx.commit().settled).error).toBeUndefined();
      await running.pull();
      await rt.idle();
      const child = cell.key("views").key(0).resolveAsCell();
      await child.sync();
      rt.runner.stop(cell);
      await stamp(child, "b");

      await expect(update(cell, parent)).rejects.toThrow(
        /refusing to set up .* for instance "a" over a child with no stored pattern identity that instance "b" set up/,
      );
    });

    it("refuses to set up a positional instance over a child stamped with an instance's name", async () => {
      const parent = await parentPattern();
      const { cell, positional } = await deployedParent(
        "stamped-positional",
        parent,
      );
      await stamp(positional, "a");

      await expect(update(cell, parent)).rejects.toThrow(
        /refusing to set up .*#default for a positional spot over the child of .*#default that instance "a" set up/,
      );
    });

    it("leaves its parent and the stamped child as they were when it refuses", async () => {
      const parent = await parentPattern();
      const { cell, named } = await deployedParent("stamped-left", parent);
      await stamp(named, "b");
      await cell.sync();
      const before = {
        internal: cell.getMetaRaw("internal"),
        result: cell.getRaw(),
      };

      await expect(update(cell, parent)).rejects.toThrow(
        /refusing to set up/,
      );
      await cell.sync();
      await named.sync();

      expect({
        internal: cell.getMetaRaw("internal"),
        result: cell.getRaw(),
        stamp: named.getMetaRaw("instanceName"),
        count: named.key("count").get(),
      }).toEqual({ ...before, stamp: "b", count: 7 });
    });

    it("sets up an instance over a child stamped with its own name, keeping the child's state", async () => {
      const parent = await parentPattern();
      const { cell, named } = await deployedParent("stamped-own", parent);
      await stamp(named, "a");

      await update(cell, parent);
      await rt.idle();
      await named.sync();

      expect(named.key("count").get()).toBe(7);
    });
  });

  describe("what the guard reads", () => {
    it("reads no child in a fresh parent's setup, nor in a start that no updater asked for, and reads the named child in an update", async () => {
      const parent = await parentPattern();
      let fresh: string[];
      let cell: Cell<unknown>;
      let named: Cell<unknown>;
      {
        using reads = guardReads();
        ({ cell, named } = await deployedParent("reads-fresh", parent));
        fresh = [...reads.ids];
      }
      let restart: string[];
      {
        using reads = guardReads();
        await rt.runSynced(cell, parent, {});
        await rt.idle();
        rt.runner.stop(cell);
        restart = [...reads.ids];
      }

      using reads = guardReads();
      await update(cell, parent);

      expect({
        fresh,
        restart,
        updateReadsNamed: reads.ids.includes(
          named.getAsNormalizedFullLink().id,
        ),
      }).toStrictEqual({ fresh: [], restart: [], updateReadsNamed: true });
    });

    it("reads no child of an instance the parent's stored manifest does not record", async () => {
      // `c` is added in the update, so no child of it has been set up, while
      // `a`'s child is read as usual.

      const { cell } = await deployedParent(
        "reads-unrecorded-instance",
        await parentPattern(),
      );

      using reads = guardReads();
      await update(cell, await parentPattern({ withC: true }));

      expect({
        a: reads.ids.includes(namedChild(cell, "a")),
        c: reads.ids.includes(namedChild(cell, "c")),
      }).toStrictEqual({ a: true, c: false });
    });
  });
});

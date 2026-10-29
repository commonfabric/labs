import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  deepFreeze,
  fabricFromConvertibleJsValue,
} from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";

import {
  EmulatedStorageManager,
  newLoopbackServer,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";
import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { getDerivedInternalCellLink } from "../src/link-utils.ts";
import { type MetaField, rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import {
  type StoredSetupBuild,
  storedSetupBuildOf,
} from "../src/stored-setup-build.ts";

const signer = await Identity.fromPassphrase("instance-carry-over");
const space = signer.did();

// Two child patterns of one shape, so a parent's argument and result schemas
// accept either child at either spot, and nothing but the guard can refuse
// one running over the other's state.
const COUNTER = [
  "import { pattern, Writable } from 'commonfabric';",
  "export const Counter = pattern<",
  "  { label: string },",
  "  { count: Writable<number> }",
  ">(() => {",
  "  const count = new Writable<number>(0).for('count');",
  "  return { count };",
  "});",
  "",
].join("\n");

const OTHER = COUNTER.replace("Counter", "Other");

/**
 * A parent of `body`, which builds the children the result `{ views, aCount,
 * sCount? }` names. A child bound to a `const` is a named instance; one bound
 * by destructuring keeps the positional cause every child had before named
 * instances, which is how a deployed parent's stored state is reproduced.
 */
const parentProgram = (
  body: string,
  counter = COUNTER,
): RuntimeProgram => ({
  main: "/main.tsx",
  files: [
    { name: "/counter.tsx", contents: counter },
    { name: "/other.tsx", contents: OTHER },
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "import { Counter } from './counter.tsx';",
        "import { Other } from './other.tsx';",
        "export default pattern<Record<string, never>>(() => {",
        body,
        "});",
        "",
      ].join("\n"),
    },
  ],
});

// The parent as deployed: one child, `a`, at a positional spot.
const DEPLOYED = parentProgram([
  "  const [a] = [Counter({ label: 'a' })];",
  "  return { views: [a], aCount: a.count };",
].join("\n"));

// The same parent source with `a` bound to a `const`, which is what the
// deployed parent's own source compiles to once instances are named.
const NAMED = parentProgram([
  "  const a = Counter({ label: 'a' });",
  "  return { views: [a], aCount: a.count };",
].join("\n"));

// The parent as deployed with two children of one pattern, `a` and `b`.
const DEPLOYED_TWO = parentProgram([
  "  const [a, b] = [Counter({ label: 'a' }), Counter({ label: 'b' })];",
  "  return { views: [a, b], aCount: a.count, bCount: b.count };",
].join("\n"));

// The same parent source with both children bound to a `const`.
const NAMED_TWO = parentProgram([
  "  const a = Counter({ label: 'a' });",
  "  const b = Counter({ label: 'b' });",
  "  return { views: [a, b], aCount: a.count, bCount: b.count };",
].join("\n"));

// `NAMED_TWO` with a change to the parent's own source alone, so an update to
// it moves the parent's pointer while every child keeps its identity.
const NAMED_TWO_EDITED = parentProgram([
  "  const a = Counter({ label: 'a' });",
  "  const b = Counter({ label: 'b' });",
  "  return { views: [a, b], aCount: a.count, bCount: b.count, edited: 1 };",
].join("\n"));

// An unrelated sibling `s` inserted ahead of `a`.
const NAMED_WITH_SIBLING = parentProgram([
  "  const s = Other({ label: 's' });",
  "  const a = Counter({ label: 'a' });",
  "  return { views: [s, a], aCount: a.count, sCount: s.count };",
].join("\n"));

// The same insertion with the sibling positional, which puts it at the
// positional spot the deployed parent gave `a`.
const POSITIONAL_SIBLING_OF_NAMED = parentProgram([
  "  const [s] = [Other({ label: 's' })];",
  "  const a = Counter({ label: 'a' });",
  "  return { views: [s, a], aCount: a.count, sCount: s.count };",
].join("\n"));

// The parent as deployed with a `Counter` child `a` ahead of an `Other` child
// `t`.
const DEPLOYED_WITH_OTHER = parentProgram([
  "  const [a, t] = [Counter({ label: 'a' }), Other({ label: 't' })];",
  "  return { views: [a, t], aCount: a.count, tCount: t.count };",
].join("\n"));

// The same parent source with both children bound to a `const`.
const NAMED_WITH_OTHER = parentProgram([
  "  const a = Counter({ label: 'a' });",
  "  const t = Other({ label: 't' });",
  "  return { views: [a, t], aCount: a.count, tCount: t.count };",
].join("\n"));

// `NAMED_WITH_OTHER` with a change to the parent's own source alone, so an
// update to it moves the parent's pointer while every child keeps its
// identity.
const NAMED_WITH_OTHER_EDITED = parentProgram([
  "  const a = Counter({ label: 'a' });",
  "  const t = Other({ label: 't' });",
  "  return { views: [a, t], aCount: a.count, tCount: t.count, edited: 1 };",
].join("\n"));

// `COUNTER` with a node of its own, which the start's pre-sync plans on
// whichever child it binds an instance to.
const COUNTER_WITH_NODE = [
  "import { computed, pattern, Writable } from 'commonfabric';",
  "export const Counter = pattern<",
  "  { label: string },",
  "  { count: Writable<number>; shown: string }",
  ">(({ label }) => {",
  "  const count = new Writable<number>(0).for('count');",
  "  const shown = computed(() => `${label}: ${count.get()}`);",
  "  return { count, shown };",
  "});",
  "",
].join("\n");

// `DEPLOYED` with `COUNTER_WITH_NODE` as its child.
const DEPLOYED_NODE_CHILD = parentProgram(
  [
    "  const [a] = [Counter({ label: 'a' })];",
    "  return { views: [a], aCount: a.count };",
  ].join("\n"),
  COUNTER_WITH_NODE,
);

// `NAMED` with `COUNTER_WITH_NODE` as its child.
const NAMED_NODE_CHILD = parentProgram(
  [
    "  const a = Counter({ label: 'a' });",
    "  return { views: [a], aCount: a.count };",
  ].join("\n"),
  COUNTER_WITH_NODE,
);

// `NAMED_WITH_SIBLING` with `COUNTER_WITH_NODE` as `a`'s pattern.
const NAMED_WITH_SIBLING_NODE_CHILD = parentProgram(
  [
    "  const s = Other({ label: 's' });",
    "  const a = Counter({ label: 'a' });",
    "  return { views: [s, a], aCount: a.count, sCount: s.count };",
  ].join("\n"),
  COUNTER_WITH_NODE,
);

// `DEPLOYED` with a second child of the same pattern, `n`, added after `a`
// and bound to a `const`.
const DEPLOYED_WITH_NAMED_ADDED = parentProgram([
  "  const [a] = [Counter({ label: 'a' })];",
  "  const n = Counter({ label: 'n' });",
  "  return { views: [a, n], aCount: a.count, nCount: n.count };",
].join("\n"));

describe("instance-carry-over", () => {
  // Every runtime here names instances, through the experimental flag that
  // turns naming on, unless a case says otherwise.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let rt: Runtime;
  // Runtimes `freshRuntime()` has replaced, kept running until the case ends.
  let replaced: Runtime[];

  // The options of a runtime that names instances when `instanceNames` is
  // true, and compiles every instance positionally when it is false.
  const naming = (instanceNames = true) => ({
    apiUrl: new URL(import.meta.url),
    experimental: { instanceNames },
  });

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    rt = new Runtime({ ...naming(), storageManager });
    replaced = [];
  });
  afterEach(async () => {
    await rt?.dispose();
    for (const runtime of replaced) await runtime.dispose();
    await storageManager?.close();
  });

  const compile = (program: RuntimeProgram) =>
    rt.patternManager.compilePattern(program, { space });

  /**
   * A stopped parent that ran `deployed`, with `counts` written to its result,
   * its pattern pointers naming `named`, the source it runs, unless `marker`
   * is `"absent"`, which leaves no setup marker, as a parent set up before
   * the marker existed has none. Its setup record is the one a runtime
   * without instance names stamps for `named`, which is the one this runtime
   * builds for it; `record` rewrites it, or `"absent"` leaves none, as a
   * parent set up before the record existed has none, and as a parent with no
   * setup marker has by default. By default the parent
   * holds `a`'s count of 7 at the positional spot `DEPLOYED` gives it.
   */
  const deployedParent = async (
    name: string,
    {
      marker = "named",
      record = marker === "absent" ? "absent" : (stamped) => stamped,
      deployed: deployedProgram = DEPLOYED,
      named: namedProgram = NAMED,
      counts = { aCount: 7 },
    }: {
      marker?: "named" | "absent";
      record?: "absent" | ((stamped: StoredSetupBuild) => StoredSetupBuild);
      deployed?: RuntimeProgram;
      named?: RuntimeProgram;
      counts?: Record<string, number>;
    } = {},
  ): Promise<Cell<Record<string, unknown>>> => {
    const deployed = await compile(deployedProgram);
    const named = await compile(namedProgram);
    const namedRef = rt.patternManager.getArtifactEntryRef(named)!;
    const tx = rt.edit();
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      name,
      undefined,
      tx,
    );
    const running = rt.run(tx, deployed, {}, cell);
    await tx.commit().settled;
    await running.pull();
    const write = rt.edit();
    for (const [key, count] of Object.entries(counts)) {
      cell.withTx(write).key(key).set(count);
    }
    expect((await write.commit().settled).error).toBeUndefined();
    await rt.idle();
    rt.runner.stop(cell);
    const stamp = rt.edit();
    cell.withTx(stamp).setMetaRaw("patternIdentity", {
      identity: namedRef.identity,
      symbol: namedRef.symbol,
    }, rawMetaWriteAuthorization);
    cell.withTx(stamp).setMetaRaw(
      "patternSetupIdentity",
      marker === "named"
        ? { identity: namedRef.identity, symbol: namedRef.symbol }
        : undefined,
      rawMetaWriteAuthorization,
    );
    cell.withTx(stamp).setMetaRaw(
      "patternSetupBuild",
      record === "absent" ? undefined : fabricFromConvertibleJsValue(
        record(
          storedSetupBuildOf(
            named,
            namedRef,
            (artifact) => rt.patternManager.getLeastArtifactEntryRef(artifact),
          ),
        ) as never,
      ),
      rawMetaWriteAuthorization,
    );
    expect((await stamp.commit().settled).error).toBeUndefined();
    return cell;
  };

  // How many times an instance has been reported starting fresh.
  const freshStarts = (): number =>
    (getLoggerCountsBreakdown()["runner"]?.["instance-carry-over"] as
      | { warn?: number }
      | undefined)?.warn ?? 0;

  /**
   * Updates the parent at `cell` to `program`, through the root repair call
   * the updater makes, and returns the parent's result.
   */
  const update = async (
    cell: Cell<Record<string, unknown>>,
    program: RuntimeProgram,
  ): Promise<Record<string, unknown>> => {
    const pattern = await compile(program);
    const ref = rt.patternManager.getArtifactEntryRef(pattern)!;
    const stamp = rt.edit();
    cell.withTx(stamp).setMetaRaw("patternIdentity", {
      identity: ref.identity,
      symbol: ref.symbol,
    }, rawMetaWriteAuthorization);
    expect((await stamp.commit().settled).error).toBeUndefined();
    await rt.runSynced(cell.withTx(), pattern, undefined, {
      expectedPatternIdentity: ref,
    });
    await rt.idle();
    await cell.pull();
    return cell.get() as Record<string, unknown>;
  };

  /**
   * A runtime of its own over the same storage, in place of `rt`, holding
   * none of the patterns `rt` compiled, and the parent `name` as it reads it.
   */
  const freshRuntime = async (
    name: string,
  ): Promise<Cell<Record<string, unknown>>> => {
    await rt.patternManager.flushCompileCacheWrites();
    await rt.storageManager.synced();
    replaced.push(rt);
    rt = new Runtime({ ...naming(), storageManager });
    const cell = rt.getCell<Record<string, unknown>>(space, name);
    await cell.sync();
    return cell;
  };

  // The child the parent at `cell` runs at the positional cause
  // `{ $generated: n }`.
  const positionalChild = (cell: Cell<unknown>, n: number) => {
    const spot = getDerivedInternalCellLink(cell, {
      partialCause: deepFreeze({ $generated: n }),
    });
    return rt.getCell(space, {
      resultFor: { space: spot.space, id: spot.id, path: [] },
    });
  };

  // Writes each entry of `fields` to the meta field it names on `cell`.
  const writeMeta = async (
    cell: Cell<unknown>,
    fields: Record<string, unknown>,
  ) => {
    const tx = rt.edit();
    for (const [field, value] of Object.entries(fields)) {
      cell.withTx(tx).setMetaRaw(
        field as MetaField,
        value as never,
        rawMetaWriteAuthorization,
      );
    }
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  describe("a named instance", () => {
    it("keeps its deployed child's state when an unrelated sibling is inserted ahead of it, and the sibling starts fresh", async () => {
      const cell = await deployedParent("sibling-inserted");

      const result = await update(cell, NAMED_WITH_SIBLING);

      expect({ aCount: result.aCount, sCount: result.sCount }).toEqual({
        aCount: 7,
        sCount: 0,
      });
    });

    it("keeps each deployed child's state when the parent's previous pattern names two children of one pattern", async () => {
      const cell = await deployedParent("two-children-named", {
        deployed: DEPLOYED_TWO,
        named: NAMED_TWO,
        counts: { aCount: 7, bCount: 9 },
      });

      const result = await update(cell, NAMED_TWO);

      expect({ aCount: result.aCount, bCount: result.bCount }).toEqual({
        aCount: 7,
        bCount: 9,
      });
    });

    it("keeps its deployed child's state through an update that moves it and changes its source, in a runtime that has not loaded the parent's previous pattern", async () => {
      // Only the previous pattern places `a` here: its identity changed, and
      // the spot `s` takes holds `a`'s deployed child. The start's pre-sync
      // is what loads that pattern from the parent's stored source.

      await deployedParent("fresh-runtime-previous-pattern");
      const cell = await freshRuntime("fresh-runtime-previous-pattern");

      const result = await update(
        cell,
        parentProgram(
          [
            "  const s = Other({ label: 's' });",
            "  const a = Counter({ label: 'a' });",
            "  return { views: [s, a], aCount: a.count, sCount: s.count };",
          ].join("\n"),
          `${COUNTER}// A newer version.\n`,
        ),
      );

      expect({ aCount: result.aCount, sCount: result.sCount }).toEqual({
        aCount: 7,
        sCount: 0,
      });
    });

    it("starts fresh, rather than take a child another instance carries, through the parent's previous pattern", async () => {
      const cell = await deployedParent("claimed-previous-pattern");
      const taken = positionalChild(cell, 0).getAsNormalizedFullLink();
      await writeMeta(cell, {
        instanceChildren: [{
          name: "x",
          child: { space: taken.space, id: taken.id, scope: taken.scope },
        }],
      });

      const result = await update(cell, NAMED);

      expect(result.aCount).toBe(0);
    });

    it("starts fresh, and reports it, when it is renamed", async () => {
      const named = await compile(NAMED);
      const tx = rt.edit();
      const cell = rt.getCell<Record<string, unknown>>(
        space,
        "renamed",
        undefined,
        tx,
      );
      const running = rt.run(tx, named, {}, cell);
      await tx.commit().settled;
      await running.pull();
      const write = rt.edit();
      cell.withTx(write).key("aCount").set(7);
      expect((await write.commit().settled).error).toBeUndefined();
      await rt.idle();
      rt.runner.stop(cell);
      const before = freshStarts();

      const result = await update(
        cell,
        parentProgram([
          "  const b = Counter({ label: 'a' });",
          "  return { views: [b], aCount: b.count };",
        ].join("\n")),
      );

      expect(result.aCount).toBe(0);
      expect(freshStarts() - before).toBe(1);
    });

    it("keeps the child it carried over across a further update", async () => {
      const cell = await deployedParent("further-update");
      await update(cell, NAMED_WITH_SIBLING);

      const result = await update(cell, NAMED);

      expect(result.aCount).toBe(7);
    });

    it("keeps its deployed child's state through a start under the same source and a live update after it", async () => {
      // The start is a runtime first running a deployed parent whose source
      // has not changed, and the update a pointer move the running parent's
      // watcher follows.

      const cell = await deployedParent("same-source-start");
      expect(await rt.runner.start(cell)).toBe(true);
      await rt.idle();
      await cell.pull();
      expect((cell.get() as Record<string, unknown>).aCount).toBe(7);

      const withSibling = await compile(NAMED_WITH_SIBLING);
      const ref = rt.patternManager.getArtifactEntryRef(withSibling)!;
      const stamp = rt.edit();
      cell.withTx(stamp).setMetaRaw("patternIdentity", {
        identity: ref.identity,
        symbol: ref.symbol,
      }, rawMetaWriteAuthorization);
      expect((await stamp.commit().settled).error).toBeUndefined();
      await rt.idle();
      await rt.runner.patternPointerFollowed(cell);
      await cell.pull();

      const result = cell.get() as Record<string, unknown>;
      expect({ aCount: result.aCount, sCount: result.sCount }).toEqual({
        aCount: 7,
        sCount: 0,
      });
    });

    it("keeps its deployed child's state when the parent holds no setup record", async () => {
      // With no record of the pattern last set up, this runtime's build of
      // that pattern places the instance.

      const cell = await deployedParent("no-record", { record: "absent" });

      const result = await update(cell, NAMED_WITH_SIBLING);

      expect({ aCount: result.aCount, sCount: result.sCount }).toEqual({
        aCount: 7,
        sCount: 0,
      });
    });

    it("keeps its deployed child's state through its pattern identity, when the parent's setup record numbers its cell otherwise than this runtime's build of the pattern last set up", async () => {
      // The record is of a build that numbered `a`'s cell one further on,
      // so the child at the number this runtime's build gives `a` may be
      // another's. The one positional child of `a`'s pattern is `a`'s own.
      // `s`, which the pattern last set up never had, is reported.

      const cell = await deployedParent("record-disagrees", {
        record: (stamped) => ({
          ...stamped,
          cells: "a build that numbered its cells otherwise",
          state: stamped.state.map(([n, description]) => [n + 1, description]),
        }),
      });
      const before = freshStarts();

      const result = await update(cell, NAMED_WITH_SIBLING);

      expect({ aCount: result.aCount, sCount: result.sCount }).toEqual({
        aCount: 7,
        sCount: 0,
      });
      expect(freshStarts() - before).toBe(1);
    });

    it("starts fresh, where the parent's setup record holds cells of its description that this runtime's build cannot be matched with", async () => {
      // The record is of a build with a third `Counter` child, so which of
      // its cells went where cannot be told, though none of `a`'s or `b`'s
      // numbers changed.

      const cell = await deployedParent("record-unmatched", {
        deployed: DEPLOYED_TWO,
        named: NAMED_TWO,
        counts: { aCount: 7, bCount: 9 },
        record: (stamped) => ({
          ...stamped,
          cells: "a build with a third child",
          state: [...stamped.state, [
            stamped.state.length,
            stamped.state[0][1],
          ]],
        }),
      });

      const result = await update(cell, NAMED_TWO_EDITED);

      expect({ aCount: result.aCount, bCount: result.bCount }).toEqual({
        aCount: 0,
        bCount: 0,
      });
    });

    it("keeps each deployed child's state, the one whose cell the parent's setup record numbers otherwise through its pattern identity", async () => {
      // The record moves `t`'s cell alone. `a`, whose cell the record numbers
      // as this runtime's build does, keeps its own at the cause the pattern
      // last set up gives it, and `t` the one positional child of its
      // pattern.

      const cell = await deployedParent("record-disagrees-for-one", {
        deployed: DEPLOYED_WITH_OTHER,
        named: NAMED_WITH_OTHER,
        counts: { aCount: 7, tCount: 3 },
        record: (stamped) => ({
          ...stamped,
          cells: "a build that numbered its cells otherwise",
          state: stamped.state.map(([n, description]) =>
            description.endsWith("#Other") ? [n + 1, description] : [
              n,
              description,
            ]
          ),
        }),
      });

      const result = await update(cell, NAMED_WITH_OTHER_EDITED);

      expect({ aCount: result.aCount, tCount: result.tCount }).toEqual({
        aCount: 7,
        tCount: 3,
      });
    });

    it("keeps its deployed child's state, taking the pattern last set up from the setup record where it names another than `patternSetupIdentity`", async () => {
      // A start repair re-stamps the record and leaves the setup marker
      // naming the pattern before. The marker here names the deployed
      // source, which names no instance; the record names the one that does.

      const cell = await deployedParent("record-over-marker");
      const deployedRef = rt.patternManager.getArtifactEntryRef(
        await compile(DEPLOYED),
      )!;
      await writeMeta(cell, {
        patternSetupIdentity: {
          identity: deployedRef.identity,
          symbol: deployedRef.symbol,
        },
      });

      const result = await update(cell, NAMED_WITH_SIBLING);

      expect(result.aCount).toBe(7);
    });

    it("keeps its deployed child's state through its pattern identity, where the pattern last set up does not name it", async () => {
      const cell = await deployedParent("previous-positional", {
        named: DEPLOYED,
      });
      const before = freshStarts();

      const result = await update(cell, NAMED);

      expect(result.aCount).toBe(7);
      expect(freshStarts() - before).toBe(0);
    });

    it("keeps its deployed child's state through its pattern identity, where the parent's pattern last set up does not load", async () => {
      const cell = await deployedParent("previous-unloadable", {
        record: "absent",
      });
      await writeMeta(cell, {
        patternSetupIdentity: { identity: "unloadable", symbol: "default" },
      });
      const before = freshStarts();

      const result = await update(cell, NAMED);

      expect(result.aCount).toBe(7);
      expect(freshStarts() - before).toBe(0);
    });

    it("keeps its deployed child's state when the parent carries no setup marker", async () => {
      const cell = await deployedParent("no-setup-marker", {
        marker: "absent",
      });

      const result = await update(cell, NAMED_WITH_SIBLING);

      expect({ aCount: result.aCount, sCount: result.sCount }).toEqual({
        aCount: 7,
        sCount: 0,
      });
    });

    it("starts fresh, and reports it, where the pattern last set up left two children of its pattern positional", async () => {
      // TODO(danfuzz): The fresh children are this tier's behavior, not the
      // intended one. Matching an instance the pattern last set up left
      // positional by order among that pattern's positional children carries
      // each child over, and the counts become 7 and 9; the `TODO(danfuzz)`
      // where carry-over plans each instance is that change.

      const cell = await deployedParent("two-left-positional", {
        deployed: DEPLOYED_TWO,
        named: DEPLOYED_TWO,
        counts: { aCount: 7, bCount: 9 },
      });
      const before = freshStarts();

      const result = await update(cell, NAMED_TWO);

      expect({ aCount: result.aCount, bCount: result.bCount }).toEqual({
        aCount: 0,
        bCount: 0,
      });
      expect(freshStarts() - before).toBe(2);
    });

    it("starts fresh, and reports it, where two instances would each take the one positional child of their pattern", async () => {
      // TODO(danfuzz): The fresh children are this tier's behavior, not the
      // intended one. Taking the child at an instance's own positional spot,
      // where no move shows, carries the deployed child over to `a`, and its
      // count becomes 7; the `TODO(danfuzz)` where carry-over plans each
      // instance is that change.

      const cell = await deployedParent("one-child-two-instances", {
        marker: "absent",
      });
      const before = freshStarts();

      const result = await update(cell, NAMED_TWO);

      expect({ aCount: result.aCount, bCount: result.bCount }).toEqual({
        aCount: 0,
        bCount: 0,
      });
      expect(freshStarts() - before).toBe(2);
    });

    describe("bound to a `const` where the deployed source left it positional", () => {
      it("keeps its child's state when a named sibling is inserted ahead of it", async () => {
        const cell = await deployedParent("bound-later-named-sibling", {
          named: DEPLOYED,
        });

        const result = await update(cell, NAMED_WITH_SIBLING);

        expect({ aCount: result.aCount, sCount: result.sCount }).toEqual({
          aCount: 7,
          sCount: 0,
        });
      });

      it("refuses to let a positional sibling inserted ahead of it take its child's state", async () => {
        const cell = await deployedParent("bound-later-positional-sibling", {
          named: DEPLOYED,
        });

        await expect(update(cell, POSITIONAL_SIBLING_OF_NAMED)).rejects
          .toThrow(
            /refusing to set up .*#Other for a positional spot over the child of .*#Counter that instance "a" carries/,
          );
      });

      it("carries the one positional child of its pattern over, though the deployed source's instance was deleted", async () => {
        // The judgment this makes: `p` is deleted, and `q`, a new instance of
        // the same pattern elsewhere, takes `p`'s state, since `p`'s child was
        // the only unclaimed positional child of that identity. That is
        // best-effort continuity, not a guarantee against misattribution:
        // nothing here tells `q` apart from `p` under a new name, so a new
        // instance can take a deleted one's state.

        const cell = await deployedParent("deleted-then-added", {
          deployed: parentProgram([
            "  const [p] = [Counter({ label: 'p' })];",
            "  return { views: [p], pCount: p.count };",
          ].join("\n")),
          named: parentProgram([
            "  const [p] = [Counter({ label: 'p' })];",
            "  return { views: [p], pCount: p.count };",
          ].join("\n")),
          counts: { pCount: 7 },
        });

        const result = await update(
          cell,
          parentProgram([
            "  const s = Other({ label: 's' });",
            "  const q = Counter({ label: 'q' });",
            "  return { views: [s, q], qCount: q.count, sCount: s.count };",
          ].join("\n")),
        );

        expect({ qCount: result.qCount, sCount: result.sCount }).toEqual({
          qCount: 7,
          sCount: 0,
        });
      });

      it("leaves a child its pattern still sets up positionally to that spot, when a `const` instance of the same pattern is added", async () => {
        const cell = await deployedParent("positional-kept-named-added", {
          named: DEPLOYED,
        });

        const result = await update(cell, DEPLOYED_WITH_NAMED_ADDED);

        expect({ aCount: result.aCount, nCount: result.nCount }).toEqual({
          aCount: 7,
          nCount: 0,
        });
      });

      it("leaves a child its pattern still sets up positionally to that spot, when a `const` instance of the same pattern is added to a parent with no setup marker", async () => {
        const cell = await deployedParent(
          "positional-kept-named-added-no-marker",
          { marker: "absent", named: DEPLOYED },
        );

        const result = await update(cell, DEPLOYED_WITH_NAMED_ADDED);

        expect({ aCount: result.aCount, nCount: result.nCount }).toEqual({
          aCount: 7,
          nCount: 0,
        });
      });
    });
  });

  describe("a runtime with naming off", () => {
    it("carries nothing over and records nothing, updating a parent to a source that binds its child to a `const`", async () => {
      // With naming off the source names no instance, so nothing is pending
      // and carry-over writes nothing.

      await deployedParent("naming-off");
      replaced.push(rt);
      rt = new Runtime({ ...naming(false), storageManager });
      const reopened = rt.getCell<Record<string, unknown>>(space, "naming-off");
      await reopened.sync();
      const before = freshStarts();

      await update(reopened, NAMED);

      expect(reopened.getMetaRaw("instanceChildren")).toBeUndefined();
      expect(freshStarts() - before).toBe(0);
    });
  });

  describe("a positional child", () => {
    it("refuses to set up over the child a named instance carried over", async () => {
      const cell = await deployedParent("positional-over-carried");

      await expect(update(cell, POSITIONAL_SIBLING_OF_NAMED)).rejects.toThrow(
        /refusing to set up .*#Other for a positional spot over the child of .*#Counter that instance "a" carries/,
      );
    });
  });

  describe("a named instance, in a runtime whose storage holds none of its parent's children", () => {
    // Each runtime here sits on a storage manager of its own over one memory
    // server, so it holds only what it has synced from that server.

    let server: ReturnType<typeof newLoopbackServer>;
    let managers: EmulatedStorageManager[];
    let made: Runtime[];

    // A runtime on a storage manager of its own over `server`.
    const runtimeOnServer = (): Runtime => {
      const manager = EmulatedStorageManager.connectTo(server, { as: signer });
      managers.push(manager);
      const runtime = new Runtime({ ...naming(), storageManager: manager });
      made.push(runtime);
      return runtime;
    };

    // `rt` stands in for the runtime the enclosing hooks made until the case
    // ends, so the shared helpers act on the server's runtimes.
    beforeEach(() => {
      server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
      managers = [];
      made = [];
      replaced.push(rt);
      rt = runtimeOnServer();
    });
    afterEach(async () => {
      for (const runtime of made) {
        await runtime.dispose({ closeStorage: false });
      }
      for (const manager of managers) await manager.close();
      await server.close();
      rt = replaced.pop()!;
    });

    /**
     * A runtime on storage of its own over the same server, in place of `rt`,
     * and the parent `name` as it reads it.
     */
    const coldRuntime = async (
      name: string,
    ): Promise<Cell<Record<string, unknown>>> => {
      await rt.patternManager.flushCompileCacheWrites();
      await rt.storageManager.synced();
      rt = runtimeOnServer();
      const cell = rt.getCell<Record<string, unknown>>(space, name);
      await cell.sync();
      return cell;
    };

    /**
     * The pieces the pre-sync plans nodes on, from here on in `rt`, in the
     * order it plans them. The first start after an update is the one that
     * carries children over, so the first child of the parent `cell` listed
     * is the one that start's pre-sync bound an instance to.
     */
    const presyncedPieces = (): string[] => {
      const pieces: string[] = [];
      rt.runner.accessForTestingOnly.presyncPlanRecorder = (piece) =>
        pieces.push(piece);
      return pieces;
    };

    // The first piece in `pieces` other than the parent `cell`.
    const firstChild = (pieces: string[], cell: Cell<unknown>) =>
      pieces.find((piece) => piece !== cell.getAsNormalizedFullLink().id);

    it("is bound by the start's pre-sync to the one positional child of its pattern identity", async () => {
      // The pattern last set up left `a` positional, so the exact match does
      // not place it, and the match by pattern identity reads the child at
      // the positional spot the parent's manifest records.

      await deployedParent("cold-identity", {
        deployed: DEPLOYED_NODE_CHILD,
        named: DEPLOYED_NODE_CHILD,
      });
      const cell = await coldRuntime("cold-identity");
      const carried = positionalChild(cell, 0).getAsNormalizedFullLink().id;
      const presynced = presyncedPieces();

      const result = await update(cell, NAMED_WITH_SIBLING_NODE_CHILD);

      expect({
        firstChild: firstChild(presynced, cell),
        aCount: result.aCount,
      }).toEqual({ firstChild: carried, aCount: 7 });
    });

    it("is bound by the start's pre-sync to the child the pattern last set up gives it", async () => {
      await deployedParent("cold-previous", {
        deployed: DEPLOYED_NODE_CHILD,
        named: NAMED_NODE_CHILD,
      });
      const cell = await coldRuntime("cold-previous");
      const carried = positionalChild(cell, 0).getAsNormalizedFullLink().id;
      const presynced = presyncedPieces();

      const result = await update(cell, NAMED_WITH_SIBLING_NODE_CHILD);

      expect({
        firstChild: firstChild(presynced, cell),
        aCount: result.aCount,
      }).toEqual({ firstChild: carried, aCount: 7 });
    });
  });
});

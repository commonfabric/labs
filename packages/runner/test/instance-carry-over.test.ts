import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { deepFreeze } from "@commonfabric/data-model";
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

const THIRD = COUNTER.replace("Counter", "Third");

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
    { name: "/third.tsx", contents: THIRD },
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "import { Counter } from './counter.tsx';",
        "import { Other } from './other.tsx';",
        "import { Third } from './third.tsx';",
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

// `NAMED` under a newer version of `Counter`'s own source.
const NAMED_WITH_NEWER_COUNTER = parentProgram(
  [
    "  const a = Counter({ label: 'a' });",
    "  return { views: [a], aCount: a.count };",
  ].join("\n"),
  `${COUNTER}// A newer version.\n`,
);

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

// `DEPLOYED` with a second child of the same pattern, `n`, added after `a`
// and bound to a `const`.
const DEPLOYED_WITH_NAMED_ADDED = parentProgram([
  "  const [a] = [Counter({ label: 'a' })];",
  "  const n = Counter({ label: 'n' });",
  "  return { views: [a, n], aCount: a.count, nCount: n.count };",
].join("\n"));

// `NAMED_TWO` with an unrelated sibling `s` inserted ahead of both.
const NAMED_TWO_WITH_SIBLING = parentProgram([
  "  const s = Other({ label: 's' });",
  "  const a = Counter({ label: 'a' });",
  "  const b = Counter({ label: 'b' });",
  "  return {",
  "    views: [s, a, b],",
  "    aCount: a.count,",
  "    bCount: b.count,",
  "    sCount: s.count,",
  "  };",
].join("\n"));

// The parent as deployed with an `Other` child ahead of two `Counter`
// children.
const DEPLOYED_THREE = parentProgram([
  "  const [o, c1, c2] = [",
  "    Other({ label: 'o' }),",
  "    Counter({ label: '1' }),",
  "    Counter({ label: '2' }),",
  "  ];",
  "  return {",
  "    views: [o, c1, c2],",
  "    oCount: o.count,",
  "    c1Count: c1.count,",
  "    c2Count: c2.count,",
  "  };",
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

// `NAMED_WITH_SIBLING` with `COUNTER_WITH_NODE` as `a`'s pattern.
const NAMED_WITH_SIBLING_NODE_CHILD = parentProgram(
  [
    "  const s = Other({ label: 's' });",
    "  const a = Counter({ label: 'a' });",
    "  return { views: [s, a], aCount: a.count, sCount: s.count };",
  ].join("\n"),
  COUNTER_WITH_NODE,
);

// `NAMED` under a newer version of `COUNTER_WITH_NODE`.
const NAMED_NEWER_NODE_CHILD = parentProgram(
  [
    "  const a = Counter({ label: 'a' });",
    "  return { views: [a], aCount: a.count };",
  ].join("\n"),
  `${COUNTER_WITH_NODE}// A newer version.\n`,
);

// The parent as deployed with a `Counter` child `a` ahead of an `Other` child
// `t`.
const DEPLOYED_WITH_OTHER = parentProgram([
  "  const [a, t] = [Counter({ label: 'a' }), Other({ label: 't' })];",
  "  return { views: [a, t], aCount: a.count, tCount: t.count };",
].join("\n"));

// `DEPLOYED_WITH_OTHER` with `a` bound to a `const` under a newer version of
// `Counter`'s own source, and a positional `Third` child `s` inserted ahead
// of it, which puts `a`'s positional spot where `t` sat.
const NAMED_NEWER_COUNTER_AFTER_POSITIONAL_SIBLING = parentProgram(
  [
    "  const [s] = [Third({ label: 's' })];",
    "  const a = Counter({ label: 'a' });",
    "  const [t] = [Other({ label: 't' })];",
    "  return {",
    "    views: [s, a, t],",
    "    aCount: a.count,",
    "    sCount: s.count,",
    "    tCount: t.count,",
    "  };",
  ].join("\n"),
  `${COUNTER}// A newer version.\n`,
);

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
   * the marker existed has none. By default the parent holds `a`'s count of 7
   * at the positional spot `DEPLOYED` gives it.
   */
  const deployedParent = async (
    name: string,
    {
      marker = "named",
      deployed: deployedProgram = DEPLOYED,
      named: namedProgram = NAMED,
      counts = { aCount: 7 },
    }: {
      marker?: "named" | "absent";
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

    it("keeps its deployed child's state at its own positional spot when the parent carries no setup marker and the child's own source changed", async () => {
      const cell = await deployedParent("no-setup-marker-newer-child", {
        marker: "absent",
      });
      const before = freshStarts();

      const result = await update(cell, NAMED_WITH_NEWER_COUNTER);

      expect(result.aCount).toBe(7);
      expect(freshStarts() - before).toBe(0);
    });

    it("keeps each deployed child's state at its own positional spot when the parent carries no setup marker and two deployed children run its pattern", async () => {
      const cell = await deployedParent("no-setup-marker-two-candidates", {
        marker: "absent",
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

    it("starts fresh, and reports it, when the parent carries no setup marker and no deployed child sits at its positional spot", async () => {
      // `a` and `b` both match the one deployed child by identity, so it goes
      // to neither that way. `a` then takes it at its own positional spot,
      // and `b`, which the deployed parent never had, finds nothing at its
      // own.

      const cell = await deployedParent("no-setup-marker-new-instance", {
        marker: "absent",
      });
      const before = freshStarts();

      const result = await update(cell, NAMED_TWO);

      expect({ aCount: result.aCount, bCount: result.bCount }).toEqual({
        aCount: 7,
        bCount: 0,
      });
      expect(freshStarts() - before).toBe(1);
    });

    it("starts fresh, and reports it, rather than take the child at its positional spot when another instance sets up the pattern that child runs", async () => {
      // `s` is inserted ahead of two deployed `Counter` children, so its own
      // positional spot holds one of them. Both match `a` and `b` alike, so
      // neither is carried over by identity, and `a` and `b` setting up
      // `Counter` is the sign that the children have moved. The second
      // fresh start is `b`'s, whose own spot holds nothing.

      const cell = await deployedParent("no-setup-marker-moved", {
        marker: "absent",
        deployed: DEPLOYED_TWO,
        named: NAMED_TWO,
        counts: { aCount: 7, bCount: 9 },
      });
      const before = freshStarts();

      const result = await update(
        cell,
        parentProgram([
          "  const s = Other({ label: 's' });",
          "  const a = Counter({ label: 'a' });",
          "  const b = Counter({ label: 'b' });",
          "  return {",
          "    views: [s, a, b],",
          "    sCount: s.count,",
          "    aCount: a.count,",
          "    bCount: b.count,",
          "  };",
        ].join("\n")),
      );

      expect(result.sCount).toBe(0);
      expect(freshStarts() - before).toBe(2);
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

    it("starts fresh, rather than take a child at its positional spot that carries another instance's name, when the parent carries no setup marker", async () => {
      const cell = await deployedParent("no-setup-marker-stamped", {
        marker: "absent",
      });
      await writeMeta(positionalChild(cell, 0), { instanceName: "zzz" });

      const result = await update(cell, NAMED_WITH_NEWER_COUNTER);

      expect(result.aCount).toBe(0);
    });

    it("starts fresh, rather than take a child of another pattern at its positional spot, when children of its own pattern run at other spots of a parent with no setup marker", async () => {
      // Two `Counter` children leave identity matching undecided, and the
      // `Other` child at `a`'s own spot is the sign the children moved.

      const cell = await deployedParent("no-setup-marker-own-identity-moved", {
        marker: "absent",
        deployed: DEPLOYED_THREE,
        named: DEPLOYED_THREE,
        counts: { oCount: 5, c1Count: 7, c2Count: 9 },
      });

      const result = await update(cell, NAMED);

      expect(result.aCount).toBe(0);
    });

    it("takes the child at its own positional spot, rather than either of two children of its pattern, when the parent carries no setup marker", async () => {
      const cell = await deployedParent("no-setup-marker-two-matches", {
        marker: "absent",
        deployed: DEPLOYED_TWO,
        named: NAMED_TWO,
        counts: { aCount: 7, bCount: 9 },
      });

      const result = await update(cell, NAMED_WITH_SIBLING);

      expect({ aCount: result.aCount, sCount: result.sCount }).toEqual({
        aCount: 9,
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

    it("starts fresh, rather than take a child another instance carries, at its own positional spot", async () => {
      const cell = await deployedParent("claimed-own-spot", {
        marker: "absent",
      });
      const taken = positionalChild(cell, 0).getAsNormalizedFullLink();
      await writeMeta(cell, {
        instanceChildren: [{
          name: "x",
          child: { space: taken.space, id: taken.id, scope: taken.scope },
        }],
      });

      const result = await update(cell, NAMED_WITH_NEWER_COUNTER);

      expect(result.aCount).toBe(0);
    });

    it("keeps each `.map()` element's child state through a start in a runtime that names instances", async () => {
      // The elements were set up by a runtime that named no instance, which a
      // runtime with naming off reproduces with the very source that names
      // `row`.

      const program: RuntimeProgram = {
        main: "/main.tsx",
        files: [
          { name: "/counter.tsx", contents: COUNTER },
          {
            name: "/main.tsx",
            contents: [
              "import { pattern } from 'commonfabric';",
              "import { Counter } from './counter.tsx';",
              "export default pattern<{ items: string[] }>(({ items }) => {",
              "  const rows = items.map((item) => {",
              "    const row = Counter({ label: item });",
              "    return { count: row.count };",
              "  });",
              "  return { rows };",
              "});",
              "",
            ].join("\n"),
          },
        ],
      };
      replaced.push(rt);
      rt = new Runtime({ ...naming(false), storageManager });
      {
        const deployed = await compile(program);
        const tx = rt.edit();
        const cell = rt.getCell<Record<string, unknown>>(
          space,
          "map-elements",
          undefined,
          tx,
        );
        const running = rt.run(tx, deployed, { items: ["x", "y"] }, cell);
        await tx.commit().settled;
        await running.pull();
        await rt.idle();
        const write = rt.edit();
        cell.withTx(write).key("rows").key(0).key("count").set(7);
        cell.withTx(write).key("rows").key(1).key("count").set(9);
        expect((await write.commit().settled).error).toBeUndefined();
        await rt.idle();
        rt.runner.stop(cell);
      }
      const cell = await freshRuntime("map-elements");

      expect(await rt.runner.start(cell)).toBe(true);
      await rt.idle();
      await cell.pull();

      const rows = cell.key("rows");
      expect([
        rows.key(0).key("count").get(),
        rows.key(1).key("count").get(),
      ]).toEqual([7, 9]);
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

    describe("bound to a `const` where the deployed source left it positional", () => {
      it("keeps its child's state", async () => {
        const cell = await deployedParent("bound-later", {
          named: DEPLOYED,
        });

        const result = await update(cell, NAMED);

        expect(result.aCount).toBe(7);
      });

      it("keeps its child's state at its own positional spot when its own source changed in the same update", async () => {
        // The child's pattern identity changed, so no positional child of the
        // parent's previous pattern matches it by order.

        const cell = await deployedParent("bound-later-newer-child", {
          named: DEPLOYED,
        });
        const before = freshStarts();

        const result = await update(cell, NAMED_WITH_NEWER_COUNTER);

        expect(result.aCount).toBe(7);
        expect(freshStarts() - before).toBe(0);
      });

      it("starts fresh, and reports it, rather than take the child of another pattern at its positional spot, when its own source changed and a positional sibling was inserted ahead of it", async () => {
        // `a`'s positional spot holds `t`'s deployed child, whose pattern `t`
        // still sets up, which is the sign the children moved.

        const cell = await deployedParent("bound-later-newer-child-moved", {
          deployed: DEPLOYED_WITH_OTHER,
          named: DEPLOYED_WITH_OTHER,
          counts: { aCount: 7, tCount: 3 },
        });
        const before = freshStarts();

        const result = await update(
          cell,
          NAMED_NEWER_COUNTER_AFTER_POSITIONAL_SIBLING,
        );

        expect(result.aCount).toBe(0);
        expect(freshStarts() - before).toBe(1);
      });

      it("keeps each child's state when two children of one pattern are bound to `const`s", async () => {
        const cell = await deployedParent("bound-later-two", {
          deployed: DEPLOYED_TWO,
          named: DEPLOYED_TWO,
          counts: { aCount: 7, bCount: 9 },
        });

        const result = await update(cell, NAMED_TWO);

        expect({ aCount: result.aCount, bCount: result.bCount }).toEqual({
          aCount: 7,
          bCount: 9,
        });
      });

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

      it("keeps each child's state when two children of one pattern are bound to `const`s with a named sibling inserted ahead of them", async () => {
        const cell = await deployedParent("bound-later-two-named-sibling", {
          deployed: DEPLOYED_TWO,
          named: DEPLOYED_TWO,
          counts: { aCount: 7, bCount: 9 },
        });

        const result = await update(cell, NAMED_TWO_WITH_SIBLING);

        expect({
          aCount: result.aCount,
          bCount: result.bCount,
          sCount: result.sCount,
        }).toEqual({ aCount: 7, bCount: 9, sCount: 0 });
      });

      it("keeps its child's state by its pattern identity when a named sibling is inserted ahead of it, where the parent's previous pattern does not load", async () => {
        // With no previous pattern to match it by order, the instance takes
        // the one positional child of its own pattern identity.

        const cell = await deployedParent("bound-later-previous-unloadable", {
          named: DEPLOYED,
        });
        await writeMeta(cell, {
          patternSetupIdentity: { identity: "unloadable", symbol: "default" },
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
  });

  describe("a named instance's name", () => {
    it("gives each of two children a handler's loop binds to one `const` a child of its own", async () => {
      const program: RuntimeProgram = {
        main: "/main.tsx",
        files: [
          { name: "/counter.tsx", contents: COUNTER },
          {
            name: "/main.tsx",
            contents: [
              "import { handler, pattern, Writable } from 'commonfabric';",
              "import { Counter } from './counter.tsx';",
              "const make = handler<",
              "  void,",
              "  { counts: Writable<Writable<number>[]> }",
              ">((_, { counts }) => {",
              "  for (const label of ['x', 'y']) {",
              "    const c = Counter({ label });",
              "    counts.push(c.count);",
              "  }",
              "});",
              "export default pattern<Record<string, never>>(() => {",
              "  const counts = new Writable<Writable<number>[]>([]).for('counts');",
              "  return { counts, make: make({ counts }) };",
              "});",
              "",
            ].join("\n"),
          },
        ],
      };
      const pattern = await compile(program);
      const tx = rt.edit();
      const cell = rt.getCell<Record<string, unknown>>(
        space,
        "handler-loop-children",
        undefined,
        tx,
      );
      const running = rt.run(tx, pattern, {}, cell);
      await tx.commit().settled;
      await running.pull();
      cell.key("make").send(undefined);
      await rt.idle();
      await cell.pull();

      // Each element links to the `count` of the child the loop made for it.
      const links = cell.key("counts").resolveAsCell().getRaw() as {
        "/": { "link@1": { id: string } };
      }[];
      expect(links.length).toBe(2);
      expect(links[0]["/"]["link@1"].id).not.toBe(links[1]["/"]["link@1"].id);
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

    it("is bound by the start's pre-sync to the positional child order matching carries over", async () => {
      await deployedParent("cold-order", {
        deployed: DEPLOYED_NODE_CHILD,
        named: DEPLOYED_NODE_CHILD,
      });
      const cell = await coldRuntime("cold-order");
      const carried = positionalChild(cell, 0).getAsNormalizedFullLink().id;
      const presynced = presyncedPieces();

      const result = await update(cell, NAMED_WITH_SIBLING_NODE_CHILD);

      expect({
        firstChild: firstChild(presynced, cell),
        aCount: result.aCount,
      }).toEqual({ firstChild: carried, aCount: 7 });
    });

    it("is bound by the start's pre-sync to the child at its own positional spot when its own source changed", async () => {
      await deployedParent("cold-own-spot", {
        deployed: DEPLOYED_NODE_CHILD,
        named: DEPLOYED_NODE_CHILD,
      });
      const cell = await coldRuntime("cold-own-spot");
      const carried = positionalChild(cell, 0).getAsNormalizedFullLink().id;
      const presynced = presyncedPieces();

      const result = await update(cell, NAMED_NEWER_NODE_CHILD);

      expect({
        firstChild: firstChild(presynced, cell),
        aCount: result.aCount,
      }).toEqual({ firstChild: carried, aCount: 7 });
    });
  });
});

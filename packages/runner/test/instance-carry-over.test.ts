import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { instancePartialCause } from "../src/builder/instance-name.ts";
import { getDerivedInternalCellLink } from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
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

// The same insertion with both children positional.
const POSITIONAL_WITH_SIBLING = parentProgram([
  "  const [s, a] = [Other({ label: 's' }), Counter({ label: 'a' })];",
  "  return { views: [s, a], aCount: a.count, sCount: s.count };",
].join("\n"));

describe("instance-carry-over", () => {
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
      await cell.pull();

      const result = cell.get() as Record<string, unknown>;
      expect({ aCount: result.aCount, sCount: result.sCount }).toEqual({
        aCount: 7,
        sCount: 0,
      });
    });
  });

  describe("a named instance's name", () => {
    it("binds an instance named for an inherited member to a child of its own", async () => {
      const program = parentProgram([
        "  const toString = Counter({ label: 'a' });",
        "  return { views: [toString], aCount: toString.count };",
      ].join("\n"));
      const pattern = await compile(program);
      const tx = rt.edit();
      const cell = rt.getCell<Record<string, unknown>>(
        space,
        "inherited-member-name",
        undefined,
        tx,
      );
      const running = rt.run(tx, pattern, {}, cell);
      await tx.commit().settled;
      await running.pull();
      const write = rt.edit();
      cell.withTx(write).key("aCount").set(5);
      expect((await write.commit().settled).error).toBeUndefined();
      await rt.idle();
      await cell.pull();

      expect((cell.get() as Record<string, unknown>).aCount).toBe(5);
    });
  });

  describe("a named instance's child", () => {
    it("refuses to set up for one instance over the child another instance set up", async () => {
      // A parent's `instanceChildren` pointing instance `a` at `b`'s child is
      // what a wrong carry-over would leave.

      const named = await compile(NAMED_TWO);
      const tx = rt.edit();
      const cell = rt.getCell<Record<string, unknown>>(
        space,
        "stamped-children",
        undefined,
        tx,
      );
      const running = rt.run(tx, named, {}, cell);
      await tx.commit().settled;
      await running.pull();
      await rt.idle();
      rt.runner.stop(cell);
      const spot = getDerivedInternalCellLink(cell, {
        partialCause: instancePartialCause("b"),
      });
      const bChild = rt.getCell(space, {
        resultFor: { space: spot.space, id: spot.id, path: [] },
      }).getAsNormalizedFullLink();
      const wrong = rt.edit();
      cell.withTx(wrong).setMetaRaw("instanceChildren", {
        a: { space: bChild.space, id: bChild.id, scope: bChild.scope },
      }, rawMetaWriteAuthorization);
      expect((await wrong.commit().settled).error).toBeUndefined();

      await expect(update(cell, NAMED_TWO)).rejects.toThrow(
        /refusing to set up .*#Counter for instance "a" over the child of .*#Counter that instance "b" set up/,
      );
    });
  });

  describe("a positional child", () => {
    it("refuses to set up over a child whose own pattern another positional spot sets up", async () => {
      const cell = await deployedParent("positional-moved");

      await expect(update(cell, POSITIONAL_WITH_SIBLING)).rejects.toThrow(
        /refusing to set up .*#Other for a positional spot over the child of .*#Counter: another positional spot of its parent sets up .*#Counter/,
      );
    });

    it("refuses to set up over a child of another pattern when a child of its own pattern runs at another positional spot", async () => {
      const positional = parentProgram([
        "  const [o, a] = [Other({ label: 'o' }), Counter({ label: 'a' })];",
        "  return { views: [o, a], aCount: a.count, oCount: o.count };",
      ].join("\n"));
      const cell = await deployedParent("positional-incoming-elsewhere", {
        deployed: positional,
        named: positional,
      });

      await expect(update(
        cell,
        parentProgram([
          "  const [a, t] = [Counter({ label: 'a' }), Third({ label: 't' })];",
          "  return { views: [a, t], aCount: a.count, tCount: t.count };",
        ].join("\n")),
      )).rejects.toThrow(
        /refusing to set up .*#Counter for a positional spot over the child of .*#Other: a child of .*#Counter runs at another positional spot/,
      );
    });

    it("refuses to set up over the child a named instance carried over", async () => {
      const cell = await deployedParent("positional-over-carried");

      await expect(update(cell, POSITIONAL_SIBLING_OF_NAMED)).rejects.toThrow(
        /refusing to set up .*#Other for a positional spot over the child of .*#Counter that instance "a" carries/,
      );
    });
  });
});

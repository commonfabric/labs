import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { deepFreeze } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { getDerivedInternalCellLink } from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import {
  getPatternSource,
  getPieceSourceSnapshot,
  preparePieceSourceTransitionBaseline,
} from "../src/runner.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("positional-child-guard");
const space = signer.did();

// Three child patterns of one shape, so a parent's argument and result
// schemas accept any child at any spot, and nothing but the guard can refuse
// one running over another's state.
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
 * A parent of `body`, which builds the children the result names. Every child
 * is bound by destructuring, so each keeps the positional cause the builder
 * numbers it with.
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

// The parent as deployed: one child, `a`.
const DEPLOYED = parentProgram([
  "  const [a] = [Counter({ label: 'a' })];",
  "  return { views: [a], aCount: a.count };",
].join("\n"));

// An unrelated sibling `s` inserted ahead of `a`, which puts `s` at the
// positional spot `DEPLOYED` gives `a`.
const WITH_SIBLING = parentProgram([
  "  const [s, a] = [Other({ label: 's' }), Counter({ label: 'a' })];",
  "  return { views: [s, a], aCount: a.count, sCount: s.count };",
].join("\n"));

// The parent as deployed with two children of one pattern, `a` and `b`.
const DEPLOYED_TWO = parentProgram([
  "  const [a, b] = [Counter({ label: 'a' }), Counter({ label: 'b' })];",
  "  return { views: [a, b], aCount: a.count, bCount: b.count };",
].join("\n"));

// `DEPLOYED` with a second `Counter` child, `b`, added after `a`.
const WITH_CHILD_ADDED = parentProgram([
  "  const [a, b] = [Counter({ label: 'a' }), Counter({ label: 'b' })];",
  "  return { views: [a, b], aCount: a.count, bCount: b.count };",
].join("\n"));

// `DEPLOYED_TWO` under a newer version of `Counter`'s own source.
const DEPLOYED_TWO_NEWER_COUNTER = parentProgram(
  [
    "  const [a, b] = [Counter({ label: 'a' }), Counter({ label: 'b' })];",
    "  return { views: [a, b], aCount: a.count, bCount: b.count };",
  ].join("\n"),
  `${COUNTER}// A newer version.\n`,
);

describe("positional-child-guard", () => {
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
   * A stopped parent named `name` that ran `deployed`, with `counts` written
   * to its result. By default it holds `a`'s count of 7.
   */
  const deployedParent = async (
    name: string,
    {
      deployed: deployedProgram = DEPLOYED,
      counts = { aCount: 7 },
    }: {
      deployed?: RuntimeProgram;
      counts?: Record<string, number>;
    } = {},
  ): Promise<Cell<Record<string, unknown>>> => {
    const deployed = await compile(deployedProgram);
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
    return cell;
  };

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

  // How many times a piece's start has failed to commit.
  const failedStarts = (): number =>
    (getLoggerCountsBreakdown()["runner"]?.["piece-start-commit-failed"] as
      | { error?: number }
      | undefined)?.error ?? 0;

  // The id of the child the parent at `cell` runs at the positional cause
  // `{ $generated: n }`.
  const positionalChild = (cell: Cell<unknown>, n: number): string => {
    const spot = getDerivedInternalCellLink(cell, {
      partialCause: deepFreeze({ $generated: n }),
    });
    return rt.getCell(space, {
      resultFor: { space: spot.space, id: spot.id, path: [] },
    }).getAsNormalizedFullLink().id;
  };

  describe("a positional child", () => {
    it("refuses an unrelated sibling inserted ahead of it, and leaves its state as it was", async () => {
      // Without the refusal, `s` would run on `a`'s stored state and `a`
      // would start fresh at the next positional spot.

      const cell = await deployedParent("sibling-inserted");

      const outcome = await update(cell, WITH_SIBLING).then(
        () => ({ refused: false }),
        (error: Error) => ({
          refused: /refusing to set up/.test(error.message),
        }),
      );
      await cell.pull();
      const result = cell.get() as Record<string, unknown>;

      expect({
        ...outcome,
        aCount: result.aCount,
        sCount: result.sCount,
      }).toStrictEqual({ refused: true, aCount: 7, sCount: undefined });
    });

    it("leaves its parent on the pattern it ran before when it refuses", async () => {
      const cell = await deployedParent("refusal-leaves-parent");
      const before = cell.getMetaRaw("patternSetupIdentity");

      await expect(update(cell, WITH_SIBLING)).rejects.toThrow(
        /refusing to set up/,
      );
      await cell.sync();

      expect(cell.getMetaRaw("patternSetupIdentity")).toEqual(before);
    });

    it("updates in place when two children of one pattern take a newer version of its source", async () => {
      const cell = await deployedParent("positional-same-pattern-newer", {
        deployed: DEPLOYED_TWO,
        counts: { aCount: 7, bCount: 9 },
      });

      const result = await update(cell, DEPLOYED_TWO_NEWER_COUNTER);

      expect({ aCount: result.aCount, bCount: result.bCount }).toEqual({
        aCount: 7,
        bCount: 9,
      });
    });

    it("refuses to set up over a child whose own pattern another positional spot sets up", async () => {
      const cell = await deployedParent("positional-moved");

      await expect(update(cell, WITH_SIBLING)).rejects.toThrow(
        /refusing to set up .*#Other for a positional spot over the child of .*#Counter: another positional spot of its parent sets up .*#Counter/,
      );
    });

    it("refuses to set up over a child of another pattern when a child of its own pattern runs at another positional spot", async () => {
      // `o` is deleted and a second `Counter` added after `a`, so no spot sets
      // up the `Other` that `a`'s new spot holds, and only `a`'s own pattern
      // running at the spot it left shows the move.

      const cell = await deployedParent("positional-incoming-elsewhere", {
        deployed: parentProgram([
          "  const [o, a] = [Other({ label: 'o' }), Counter({ label: 'a' })];",
          "  return { views: [o, a], aCount: a.count, oCount: o.count };",
        ].join("\n")),
      });

      await expect(update(
        cell,
        parentProgram([
          "  const [a, b] = [Counter({ label: 'a' }), Counter({ label: 'b' })];",
          "  return { views: [a, b], aCount: a.count, bCount: b.count };",
        ].join("\n")),
      )).rejects.toThrow(
        /refusing to set up .*#Counter for a positional spot over the child of .*#Other: a child of .*#Counter runs at another positional spot/,
      );
    });
  });

  describe("a child at a spot a result key names", () => {
    it("takes another pattern there without a refusal, beside positional children whose patterns were swapped", async () => {
      // A named spot cannot shift, so the swap at the positional spot beside
      // it is no sign that its child moved, as it would be for a positional
      // one.

      const keyed = (child: string, inline: string) =>
        parentProgram([
          `  const [i] = [${inline}({ label: 'i' })];`,
          `  return { shown: ${child}({ label: 'k' }), views: [i] };`,
        ].join("\n"));
      const cell = await deployedParent("keyed-spot", {
        deployed: keyed("Counter", "Other"),
        counts: {},
      });

      const result = await update(cell, keyed("Other", "Counter"));

      expect(result.shown).toBeDefined();
    });
  });

  describe("an independently managed child", () => {
    it("is resumed, not judged, when its parent updates beside a positional child of the pattern it started from", async () => {
      // The child sits at a positional spot, and its own source moved on
      // independently, so its identity is not the one its parent's node sets
      // up, while the positional sibling runs exactly that one.

      const target = (await Identity.fromPassphrase("independent child"))
        .did();
      const childPath = "/api/patterns/system/child.tsx";
      const parentPath = "/api/patterns/system/parent.tsx";
      const childSource = (marker: string) =>
        [
          "import { computed, pattern } from 'commonfabric';",
          "export default pattern<{ value: string }, { marker: string }>(",
          `  ({ value }) => ({ marker: computed(() => '${marker} ' + value) }),`,
          ");",
          "",
        ].join("\n");
      const parentProgramOf = (extra: string): RuntimeProgram => ({
        main: parentPath,
        files: [
          {
            name: parentPath,
            contents: [
              "import { pattern } from 'commonfabric';",
              "import Child from './child.tsx';",
              "export default pattern<Record<string, never>>(() => ({",
              "  views: [",
              `    Child.inSpace('${target}')({ value: 'parent' }),`,
              "    Child({ value: 'inline' }),",
              "  ],",
              extra,
              "}));",
              "",
            ].join("\n"),
          },
          { name: childPath, contents: childSource("original") },
        ],
      });
      const parentPattern = await compile(parentProgramOf(""));
      const cell = rt.getCell<Record<string, unknown>>(space, "independent");
      const tx = rt.edit();
      rt.runner.run(tx, parentPattern, {}, cell, {
        sourceOrigin: "system:system/parent.tsx",
      });
      rt.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await cell.pull();
      await rt.idle();
      const child = cell.key("views").key(0).resolveAsCell();
      await child.pull();
      expect(getPatternSource(child)).toBe("system:system/child.tsx");
      const candidate = await rt.patternManager.compilePattern({
        main: childPath,
        files: [{ name: childPath, contents: childSource("updated") }],
      }, { space: child.space });
      const expected = getPieceSourceSnapshot(child)!;
      await rt.runner.runSynced(child, candidate, { value: "owner" }, {
        pieceSourceTransition: {
          revisionId: crypto.randomUUID(),
          timestamp: Date.now(),
          operation: "origin-update",
          origin: expected.origin,
          expected,
          baseline: await preparePieceSourceTransitionBaseline(
            rt,
            child,
            expected,
          ),
        },
      });
      await rt.idle();
      rt.runner.stop(cell);

      await update(cell, parentProgramOf("  extra: 1,"));

      await child.pull();
      expect(child.key("marker").get()).toBe("updated owner");
    });
  });

  describe("a parent that runs whichever pattern a computation returns", () => {
    it("sets up the other pattern's positional children over the first's without a refusal", async () => {
      // `shown` runs `First` or `Second` on one cell. `Second`'s `Other` child
      // takes the spot `First`'s `Counter` child held, while another spot of
      // `Second` sets up `Counter`: a move, were `Second` a newer `First`.

      const program: RuntimeProgram = {
        main: "/main.tsx",
        files: [
          { name: "/counter.tsx", contents: COUNTER },
          { name: "/other.tsx", contents: OTHER },
          {
            name: "/first.tsx",
            contents: [
              "import { pattern } from 'commonfabric';",
              "import { Counter } from './counter.tsx';",
              "export default pattern<Record<string, never>>(() => {",
              "  const [x] = [Counter({ label: 'x' })];",
              "  return { views: [x], xCount: x.count };",
              "});",
              "",
            ].join("\n"),
          },
          {
            name: "/second.tsx",
            contents: [
              "import { pattern } from 'commonfabric';",
              "import { Counter } from './counter.tsx';",
              "import { Other } from './other.tsx';",
              "export default pattern<Record<string, never>>(() => {",
              "  const [y, z] = [Other({ label: 'y' }), Counter({ label: 'z' })];",
              "  return { views: [y, z], yCount: y.count, zCount: z.count };",
              "});",
              "",
            ].join("\n"),
          },
          {
            name: "/main.tsx",
            contents: [
              "import { computed, pattern } from 'commonfabric';",
              "import First from './first.tsx';",
              "import Second from './second.tsx';",
              "export default pattern<{ which: string }>(({ which }) => {",
              "  const shown = computed(() =>",
              "    which === 'first' ? First({}) : Second({})",
              "  );",
              "  return { shown };",
              "});",
              "",
            ].join("\n"),
          },
        ],
      };
      const host = await compile(program);
      const tx = rt.edit();
      const cell = rt.getCell<Record<string, unknown>>(
        space,
        "swapping-parent",
        undefined,
        tx,
      );
      const running = rt.run(tx, host, { which: "first" }, cell);
      await tx.commit().settled;
      await running.pull();
      await rt.idle();
      const shown = cell.key("shown") as Cell<Record<string, unknown>>;
      await shown.pull();
      expect(shown.get().xCount).toBe(0);
      const before = failedStarts();

      const swap = rt.edit();
      cell.getArgumentCell()!.withTx(swap).key("which").set("second");
      expect((await swap.commit().settled).error).toBeUndefined();
      await rt.idle();
      await shown.pull();

      expect({
        yCount: shown.get().yCount,
        zCount: shown.get().zCount,
        failedStarts: failedStarts() - before,
      }).toStrictEqual({ yCount: 0, zCount: 0, failedStarts: 0 });
    });
  });

  describe("what the guard reads", () => {
    // Records, until disposed, each child document the guard reads, by id.
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

    it("reads no child in a fresh parent's setup, and reads the stored child in an update", async () => {
      let fresh: string[];
      let cell: Cell<Record<string, unknown>>;
      {
        using reads = guardReads();
        cell = await deployedParent("reads-fresh-then-update");
        fresh = [...reads.ids];
      }

      using reads = guardReads();
      await update(cell, DEPLOYED_TWO_NEWER_COUNTER);

      expect({ fresh, update: [...new Set(reads.ids)] }).toStrictEqual({
        fresh: [],
        update: [positionalChild(cell, 0)],
      });
    });

    it("reads no child at a spot the parent's stored manifest does not record", async () => {
      // `b` is added at a spot no child of the deployed parent has held, and
      // `a` keeps its own pattern, so the guard reads `a`'s child alone.

      const cell = await deployedParent("reads-unrecorded-spot");

      using reads = guardReads();
      await update(cell, WITH_CHILD_ADDED);

      expect([...new Set(reads.ids)]).toStrictEqual([positionalChild(cell, 0)]);
    });
  });
});

/**
 * A named instance's carry-over where the patterns involved name what no
 * compiled pattern does: a child pattern with no pattern identity, an
 * instance name on a value no sub-pattern node produces, and a previous
 * pattern that places a child where the parent holds none.
 */

import { expect } from "@std/expect";

import { deepFreeze } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { getDerivedInternalCellLink } from "../src/link-utils.ts";
import { type MetaField, rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner-cov-c carry-over");
const space = signer.did();

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

const parentProgram = (body: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [
    { name: "/counter.tsx", contents: COUNTER },
    { name: "/other.tsx", contents: COUNTER.replace("Counter", "Other") },
    {
      name: "/main.tsx",
      contents: [
        "import { pattern, Writable } from 'commonfabric';",
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

// The parent as deployed: one child, `a`, at the positional spot 0.
const DEPLOYED = parentProgram([
  "  const [a] = [Counter({ label: 'a' })];",
  "  return { views: [a], aCount: a.count };",
].join("\n"));

describe("runner instance carry-over", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let rt: Runtime;
  let warnings: string[];
  let warn: typeof console.warn;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      experimental: { instanceNames: true },
      storageManager,
    });
    warnings = [];
    warn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
  });

  afterEach(async () => {
    console.warn = warn;
    await rt?.dispose();
    await storageManager?.close();
  });

  const compile = (program: RuntimeProgram) =>
    rt.patternManager.compilePattern(program, { space });

  // Writes each entry of `fields` to the meta field it names on `cell`.
  async function writeMeta(
    cell: Cell<unknown>,
    fields: Record<string, unknown>,
  ) {
    const tx = rt.edit();
    for (const [field, value] of Object.entries(fields)) {
      cell.withTx(tx).setMetaRaw(
        field as MetaField,
        value as never,
        rawMetaWriteAuthorization,
      );
    }
    expect((await tx.commit().settled).error).toBeUndefined();
  }

  /**
   * A stopped parent that ran `deployed` with `counts` written to its result,
   * whose pointer and setup marker name `setUp`, and which holds no setup
   * record.
   */
  async function deployedParent(
    name: string,
    setUp: { identity: string; symbol: string },
    { deployed = DEPLOYED, counts = { aCount: 7 } as Record<string, number> } =
      {},
  ): Promise<Cell<Record<string, unknown>>> {
    const pattern = await compile(deployed);
    const tx = rt.edit();
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      name,
      undefined,
      tx,
    );
    const running = rt.run(tx, pattern, {}, cell);
    await tx.commit().settled;
    await running.pull();
    const write = rt.edit();
    for (const [key, count] of Object.entries(counts)) {
      cell.withTx(write).key(key).set(count);
    }
    expect((await write.commit().settled).error).toBeUndefined();
    await rt.idle();
    rt.runner.stop(cell);
    await writeMeta(cell, {
      patternIdentity: setUp,
      patternSetupIdentity: setUp,
      patternSetupBuild: undefined,
    });
    return cell;
  }

  /** Sets the parent at `cell` up with `pattern`, returning its result. */
  async function update(
    cell: Cell<Record<string, unknown>>,
    pattern: Pattern,
  ): Promise<Record<string, unknown>> {
    const ref = rt.patternManager.getArtifactEntryRef(pattern);
    if (ref !== undefined) await writeMeta(cell, { patternIdentity: ref });
    await rt.runSynced(
      cell.withTx(),
      pattern,
      undefined,
      ref === undefined ? undefined : { expectedPatternIdentity: ref },
    );
    await rt.idle();
    await cell.pull();
    return cell.get() as Record<string, unknown>;
  }

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

  // The pattern identity `rt` compiled `program` under.
  async function refOf(program: RuntimeProgram) {
    return rt.patternManager.getArtifactEntryRef(await compile(program))!;
  }

  // The warnings reporting that the instance `name` started fresh.
  const freshStarts = (name: string) =>
    warnings.filter((line) =>
      line.includes(`instance \`"${name}"\``) && line.includes("starts fresh")
    );

  describe("with patterns the builder made at run time", () => {
    // The builder's patterns carry no pattern identity until the runtime runs
    // them, so a child pattern no run has started has none, and an instance
    // name may sit on a value no sub-pattern node produces.

    it("carries a child over at its own positional spot for an instance whose pattern has no identity, and starts fresh the instances the previous pattern does not place", async () => {
      const { commonfabric: cf } = createTrustedBuilder(rt);
      const Child = cf.pattern<{ label: string }, { count: number }>(() => {
        const count = cf.Writable.of<number>(0).for("count");
        return { count };
      });
      // The pattern the parent last set up, as this runtime loads it: a
      // positional child, an instance `x` on a plain cell, and an
      // instance `y` that took the place of no positional spot.
      const built = cf.pattern<Record<string, never>>(() => {
        const [p] = [Child({ label: "p" })];
        const x = cf.nameInstance(cf.Writable.of<number>(1), "x");
        const y = cf.nameInstance(Child({ label: "y" }), "y");
        return { views: [p, y], cells: [x] };
      });
      const previous = rt.unsafeTrustPattern(
        {
          ...built,
          derivedInternalCells: built.derivedInternalCells!.map((cell) => {
            const { legacyPartialCause: _legacy, ...rest } = cell;
            return (cell.partialCause as { $instance?: string })
                .$instance === "y"
              ? rest
              : cell;
          }),
        } as Pattern,
        { reason: "unit test fixture" },
      );
      const previousRef = {
        identity: "of:fid1:runner-cov-c-previous",
        symbol: "default",
      };
      rt.patternManager.associatePatternIdentity(previous, previousRef);
      const cell = await deployedParent("identityless child", previousRef);
      // `a` takes the place of spot 0, where the deployed child runs.
      const next = cf.pattern<Record<string, never>>(() => {
        const a = cf.nameInstance(Child({ label: "a" }), "a");
        const x = cf.nameInstance(Child({ label: "x" }), "x");
        const y = cf.nameInstance(Child({ label: "y" }), "y");
        const z = cf.nameInstance(cf.Writable.of<number>(2), "z");
        const s = Child({ label: "s" });
        return {
          views: [a, x, y, s],
          aCount: a.count,
          sCount: s.count,
          xCount: x.count,
          cells: [z],
        };
      });

      const result = await update(cell, next);

      expect({
        aCount: result.aCount,
        sCount: result.sCount,
        xCount: result.xCount,
      }).toEqual({ aCount: 7, sCount: 0, xCount: 0 });
      expect(freshStarts("a")).toEqual([]);
      for (const name of ["x", "y", "z"]) {
        expect(freshStarts(name).length).toBe(1);
      }
    });
  });

  describe("with compiled patterns", () => {
    it("starts fresh an instance that order places at a spot the previous pattern sets up and the parent holds no child at", async () => {
      // The pattern last set up places `a` at spot 1, which the parent, as
      // deployed, never filled.
      const previousRef = await refOf(parentProgram([
        "  const [b, a] = [Counter({ label: 'b' }), Counter({ label: 'a' })];",
        "  return { views: [b, a], aCount: a.count, bCount: b.count };",
      ].join("\n")));
      const cell = await deployedParent("empty spot", previousRef);

      const result = await update(
        cell,
        await compile(parentProgram([
          "  const [b] = [Counter({ label: 'b' })];",
          "  const a = Counter({ label: 'a' });",
          "  return { views: [b, a], aCount: a.count, bCount: b.count };",
        ].join("\n"))),
      );

      expect({ aCount: result.aCount, bCount: result.bCount }).toEqual({
        aCount: 0,
        bCount: 7,
      });
      expect(freshStarts("a").length).toBe(1);
      expect(freshStarts("b")).toEqual([]);
    });

    it("starts fresh, and reports the child as another instance's, an instance that order places at a child the parent records for another instance", async () => {
      const deployedRef = await refOf(DEPLOYED);
      const cell = await deployedParent("kept spot", deployedRef);
      const kept = positionalChild(cell, 0).getAsNormalizedFullLink();
      await writeMeta(cell, {
        instanceChildren: [{
          name: "other",
          child: { space: kept.space, id: kept.id, scope: kept.scope },
        }],
      });

      const result = await update(
        cell,
        await compile(parentProgram([
          "  const a = Counter({ label: 'a' });",
          "  return { views: [a], aCount: a.count };",
        ].join("\n"))),
      );

      expect(result.aCount).toBe(0);
      const reports = freshStarts("a");
      expect(reports.length).toBe(1);
      expect(reports[0]).toContain(kept.id);
      expect(reports[0]).toContain("is another instance's");
    });

    it("carries the child at its own positional spot, past the parent's named cells, where that child runs another pattern no node sets up", async () => {
      const deployed = parentProgram([
        "  const note = new Writable<number>(0).for('note');",
        "  const [a] = [Other({ label: 'a' })];",
        "  return { views: [a], aCount: a.count, note };",
      ].join("\n"));
      const cell = await deployedParent(
        "named cell beside",
        await refOf(deployed),
        { deployed },
      );

      const result = await update(
        cell,
        await compile(parentProgram([
          "  const note = new Writable<number>(0).for('note');",
          "  const a = Counter({ label: 'a' });",
          "  return { views: [a], aCount: a.count, note };",
        ].join("\n"))),
      );

      expect(result.aCount).toBe(7);
      expect(freshStarts("a")).toEqual([]);
    });
  });
});

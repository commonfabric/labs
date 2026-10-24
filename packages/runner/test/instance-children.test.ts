import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { deepFreeze } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { instancePartialCause } from "../src/builder/instance-name.ts";
import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { getDerivedInternalCellLink } from "../src/link-utils.ts";
import { type MetaField, rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("instance-children");
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
 * A parent of `body`, which builds the children its result names. A child
 * bound to a `const` is a named instance; one bound by destructuring keeps a
 * positional cause.
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

// The parent as deployed with two children, `a` and `b`, at positional
// spots.
const DEPLOYED_TWO = parentProgram([
  "  const [a, b] = [Counter({ label: 'a' }), Counter({ label: 'b' })];",
  "  return { views: [a, b], aCount: a.count, bCount: b.count };",
].join("\n"));

// The same parent with `a` bound to a `const`, which names it.
const NAMED = parentProgram([
  "  const a = Counter({ label: 'a' });",
  "  return { views: [a], aCount: a.count };",
].join("\n"));

// Two named children of one pattern, `a` and `b`.
const NAMED_TWO = parentProgram([
  "  const a = Counter({ label: 'a' });",
  "  const b = Counter({ label: 'b' });",
  "  return { views: [a, b], aCount: a.count, bCount: b.count };",
].join("\n"));

// `NAMED_TWO` under a newer version of `Counter`'s own source.
const NAMED_TWO_NEWER_COUNTER = parentProgram(
  [
    "  const a = Counter({ label: 'a' });",
    "  const b = Counter({ label: 'b' });",
    "  return { views: [a, b], aCount: a.count, bCount: b.count };",
  ].join("\n"),
  `${COUNTER}// A newer version.\n`,
);

// The parent with `a` removed and a positional `s` in its place, at the
// positional spot `DEPLOYED` gives `a`. It names no instance, so no child is
// carried over to one.
const POSITIONAL_SIBLING = parentProgram([
  "  const [s] = [Other({ label: 's' })];",
  "  return { views: [s], sCount: s.count };",
].join("\n"));

describe("instance-children", () => {
  // Every runtime here names instances, through the experimental flag that
  // turns naming on. Each case writes the parent's `instanceChildren` record
  // itself, save the one that shows what a parent with none carries over.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let rt: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { instanceNames: true },
    });
  });
  afterEach(async () => {
    await rt?.dispose();
    await storageManager?.close();
  });

  const compile = (program: RuntimeProgram) =>
    rt.patternManager.compilePattern(program, { space });

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

  // The `instanceChildren` entry that gives the instance `name` the child
  // result cell `child`.
  const entry = (name: string, child: Cell<unknown>) => {
    const { space, id, scope } = child.getAsNormalizedFullLink();
    return { name, child: { space, id, scope } };
  };

  /**
   * A stopped parent that ran `deployed`, holding `a`'s count of 7 at its
   * positional spot and, where `deployed` sets one up, `b`'s count of 9 at
   * its own, with its pattern pointers naming `named`, the source it runs.
   */
  const deployedParent = async (
    name: string,
    named: RuntimeProgram = NAMED,
    deployedProgram: RuntimeProgram = DEPLOYED,
  ): Promise<Cell<Record<string, unknown>>> => {
    const deployed = await compile(deployedProgram);
    const namedRef = rt.patternManager.getArtifactEntryRef(
      await compile(named),
    )!;
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
    cell.withTx(write).key("aCount").set(7);
    if (deployedProgram === DEPLOYED_TWO) {
      cell.withTx(write).key("bCount").set(9);
    }
    expect((await write.commit().settled).error).toBeUndefined();
    await rt.idle();
    rt.runner.stop(cell);
    const ref = { identity: namedRef.identity, symbol: namedRef.symbol };
    await writeMeta(cell, {
      patternIdentity: ref,
      patternSetupIdentity: ref,
    });
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
    await writeMeta(cell, {
      patternIdentity: { identity: ref.identity, symbol: ref.symbol },
    });
    await rt.runSynced(cell.withTx(), pattern, undefined, {
      expectedPatternIdentity: ref,
    });
    await rt.idle();
    await cell.pull();
    return cell.get() as Record<string, unknown>;
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

  describe("a named instance", () => {
    it("runs the child its parent's `instanceChildren` records for it, rather than the one it would carry over", async () => {
      const cell = await deployedParent("recorded-child", NAMED, DEPLOYED_TWO);
      await writeMeta(cell, {
        instanceChildren: [entry("a", positionalChild(cell, 1))],
      });

      const result = await update(cell, NAMED);

      expect(result.aCount).toBe(9);
    });

    it("carries over the child at its own positional spot when its parent's `instanceChildren` records none for it", async () => {
      const cell = await deployedParent(
        "no-recorded-child",
        NAMED,
        DEPLOYED_TWO,
      );

      const result = await update(cell, NAMED);

      expect(result.aCount).toBe(7);
    });

    it("binds a child of its own when it is named for an inherited member", async () => {
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

  describe("a parent's setup", () => {
    it("refuses to set up an instance over the child another instance set up, where the parent's `instanceChildren` points the one at the other's child", async () => {
      // The update is to a newer version of `Counter`, so the parent is one
      // its updater pointed at a new pattern, which the guard judges.

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
        partialCause: deepFreeze(instancePartialCause("b")),
      });
      await writeMeta(cell, {
        instanceChildren: [
          entry(
            "a",
            rt.getCell(space, {
              resultFor: { space: spot.space, id: spot.id, path: [] },
            }),
          ),
        ],
      });

      await expect(update(cell, NAMED_TWO_NEWER_COUNTER)).rejects.toThrow(
        /refusing to set up .*#Counter for instance "a" over the child of .*#Counter that instance "b" set up/,
      );
    });

    it("refuses to set up a positional instance over the child its `instanceChildren` records for a named instance", async () => {
      const cell = await deployedParent("positional-over-recorded");
      await writeMeta(cell, {
        instanceChildren: [entry("a", positionalChild(cell, 0))],
      });

      await expect(update(cell, POSITIONAL_SIBLING)).rejects.toThrow(
        /refusing to set up .*#Other for a positional spot over the child of .*#Counter that instance "a" carries/,
      );
    });

    it("refuses to set up a named instance over the child its `instanceChildren` records for another named instance as well", async () => {
      // The record gives one child to two instances, and neither instance's
      // own spot is in the parent's manifest, which is the shape a parent
      // has on the first setup that names its instances.

      const cell = await deployedParent("one-child-two-instances");
      const child = positionalChild(cell, 0);
      await writeMeta(cell, {
        instanceChildren: [entry("a", child), entry("b", child)],
      });

      await expect(update(cell, NAMED_TWO)).rejects.toThrow(
        /refusing to set up .*#Counter for instance "(a|b)" over the child of .*#Counter that instance "(a|b)" carries/,
      );
    });

    it("sets up a positional instance over a child its `instanceChildren` records for no instance", async () => {
      const cell = await deployedParent("positional-over-unrecorded");

      const result = await update(cell, POSITIONAL_SIBLING);

      expect(result.sCount).toBe(7);
    });
  });
  describe("an instance named for a key a record cannot hold or that an object inherits", () => {
    // `constructor` and `__proto__` are names the codec refuses as a stored
    // record's keys, and `toString` and `hasOwnProperty` are members every
    // object inherits. Each is an ordinary `const` name, so each has to
    // survive the record, the guard and a start.

    // `NAMED`, and `NAMED` with a positional sibling `s` inserted ahead of the
    // instance, which puts it at the positional spot `DEPLOYED` gives `a`,
    // with the instance bound to `name` in place of `a`.
    const namedAs = (name: string) =>
      parentProgram([
        `  const ${name} = Counter({ label: 'a' });`,
        `  return { views: [${name}], aCount: ${name}.count };`,
      ].join("\n"));
    const positionalSiblingOf = (name: string) =>
      parentProgram([
        "  const [s] = [Other({ label: 's' })];",
        `  const ${name} = Counter({ label: 'a' });`,
        `  return { views: [s, ${name}], aCount: ${name}.count, sCount: s.count };`,
      ].join("\n"));

    for (
      const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]
    ) {
      describe(`\`${name}\``, () => {
        it("runs the child its parent's `instanceChildren` records for it, and runs it again when the parent starts", async () => {
          const cell = await deployedParent(`recorded-${name}`, namedAs(name));
          await writeMeta(cell, {
            instanceChildren: [entry(name, positionalChild(cell, 0))],
          });

          const updated = await update(cell, namedAs(name));
          rt.runner.stop(cell);
          expect(await rt.runner.start(cell)).toBe(true);
          await rt.idle();
          await cell.pull();

          expect({
            updated: updated.aCount,
            started: (cell.get() as Record<string, unknown>).aCount,
          }).toEqual({ updated: 7, started: 7 });
        });

        it("refuses to set up a positional instance over the child its `instanceChildren` records for it", async () => {
          const cell = await deployedParent(
            `positional-over-${name}`,
            namedAs(name),
          );
          await writeMeta(cell, {
            instanceChildren: [entry(name, positionalChild(cell, 0))],
          });

          await expect(update(cell, positionalSiblingOf(name))).rejects
            .toThrow(`that instance "${name}" carries`);
        });
      });
    }
  });
});

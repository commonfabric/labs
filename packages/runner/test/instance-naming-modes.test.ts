/**
 * Runtimes that differ in their `instanceNames` experimental flag, over one
 * store. The first block holds that compiled code is never shared between the
 * two naming modes. The second reproduces what a runtime with naming off does
 * to a parent a runtime with naming on carried over: it is the regression
 * coverage for the boundary that has to be in place before the flag turns on
 * (`docs/development/EXPERIMENTAL_OPTIONS.md#instancenames`). Each runtime sits
 * on a storage manager of its own over one memory server, so it starts from
 * what it syncs, as a runtime in another process does.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { deepFreeze } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import { instancePartialCause } from "../src/builder/instance-name.ts";
import type { Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { getDerivedInternalCellLink } from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("instance-naming-modes");
const space = signer.did();

// A counter whose handler also records the `label` it was set up with, so a
// write shows which instance's arguments handled it.
const COUNTER = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "const bump = handler<",
  "  { by: number },",
  "  { count: Writable<number>; owner: Writable<string>; label: string }",
  ">((event, { count, owner, label }) => {",
  "  count.set(count.get() + event.by);",
  "  owner.set(label);",
  "});",
  "export const Counter = pattern<",
  "  { label: string },",
  "  {",
  "    count: Writable<number>;",
  "    owner: Writable<string>;",
  "    bump: Stream<{ by: number }>;",
  "  }",
  ">(({ label }) => {",
  "  const count = new Writable<number>(0).for('count');",
  "  const owner = new Writable<string>('').for('owner');",
  "  return { count, owner, bump: bump({ count, owner, label }) };",
  "});",
  "",
].join("\n");

const parentProgram = (body: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [
    { name: "/counter.tsx", contents: COUNTER },
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "import { Counter } from './counter.tsx';",
        "export default pattern<Record<string, never>>(() => {",
        body,
        "});",
        "",
      ].join("\n"),
    },
  ],
});

// The parent as deployed: one child, `a`, bound to a `const`.
const DEPLOYED = parentProgram([
  "  const a = Counter({ label: 'a' });",
  "  return { views: [a], aCount: a.count, aOwner: a.owner, aBump: a.bump };",
].join("\n"));

const WITH_SIBLING_BODY = [
  "  const s = Counter({ label: 's' });",
  "  const a = Counter({ label: 'a' });",
  "  return {",
  "    views: [s, a],",
  "    aCount: a.count,",
  "    sCount: s.count,",
  "    aOwner: a.owner,",
  "    sOwner: s.owner,",
  "    aBump: a.bump,",
  "    sBump: s.bump,",
  "  };",
].join("\n");

// A sibling `s` of the same pattern inserted ahead of `a`.
const WITH_SIBLING = parentProgram(WITH_SIBLING_BODY);

// `WITH_SIBLING` with a change to the parent's own source alone, so an update
// to it moves the parent's pointer while every child keeps its identity.
const WITH_SIBLING_EDITED = parentProgram(
  WITH_SIBLING_BODY.replace("views: [s, a],", "views: [s, a], edited: 1,"),
);

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

  // Writes back everything `runtime` holds and stops it, so that only the
  // runtime that follows runs the parent.
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
      const named = await naming.patternManager.compilePattern(WITH_SIBLING, {
        space,
      });
      const identity = naming.patternManager.getArtifactEntryRef(named)!
        .identity;
      await retire(naming);

      const positional = runtimeNaming(false);
      const loaded = await positional.patternManager.compilePattern(
        WITH_SIBLING,
        { space, knownEntryIdentity: identity },
      );

      expect({
        named: namesAnInstance(named),
        loaded: namesAnInstance(loaded),
      }).toEqual({ named: true, loaded: false });
    });

    it("is not shared from a runtime that does not name instances with one that does", async () => {
      const positional = runtimeNaming(false);
      const unnamed = await positional.patternManager.compilePattern(
        WITH_SIBLING,
        { space },
      );
      const identity = positional.patternManager.getArtifactEntryRef(unnamed)!
        .identity;
      await retire(positional);

      const naming = runtimeNaming(true);
      const loaded = await naming.patternManager.compilePattern(
        WITH_SIBLING,
        { space, knownEntryIdentity: identity },
      );

      expect({
        unnamed: namesAnInstance(unnamed),
        loaded: namesAnInstance(loaded),
      }).toEqual({ unnamed: false, loaded: true });
    });
  });

  describe("a parent a runtime with naming on carried over", () => {
    // `A` is the child the deployed parent set up at its positional spot
    // `{ $generated: 0 }`, `O` the spot `{ $generated: 1 }`, and `S` the
    // child of the named instance `s`. Each case writes through the
    // handlers, so a child's `owner` says whose arguments handled the write.

    const PARENT = "parent";

    // The result cell of the child `runtime`'s view of the parent holds
    // under `partialCause`.
    const childAt = (runtime: Runtime, partialCause: unknown) => {
      const parent = runtime.getCell(space, PARENT);
      const spot = getDerivedInternalCellLink(parent, {
        partialCause: deepFreeze(partialCause) as never,
      });
      return runtime.getCell(space, {
        resultFor: { space: spot.space, id: spot.id, path: [] },
      });
    };

    // The id of the document `cell` resolves to.
    const docOf = async (cell: Cell<unknown>) => {
      const resolved = cell.resolveAsCell();
      await resolved.sync();
      return resolved.getAsNormalizedFullLink().id;
    };

    // For each of the children `A`, `O` and `S`: the id of its `count`
    // document, whether it is set up, and the `label` its stored argument
    // holds.
    const children = async (runtime: Runtime) => {
      const out: Record<
        string,
        { countDoc: string; setUp: boolean; label: unknown }
      > = {};
      for (
        const [name, cause] of [
          ["A", { $generated: 0 }],
          ["O", { $generated: 1 }],
          ["S", instancePartialCause("s")],
        ] as const
      ) {
        const child = childAt(runtime, cause);
        await child.sync();
        const argument = child.getArgumentCell();
        await argument?.sync();
        out[name] = {
          countDoc: await docOf(child.key("count")),
          setUp: child.getRaw() !== undefined,
          label: (argument?.get() as { label?: unknown } | undefined)?.label,
        };
      }
      return out;
    };

    // What the parent shows of each instance: the document its count
    // resolves to, the count, and the `owner` its last write recorded.
    const shown = async (runtime: Runtime) => {
      const parent = runtime.getCell<Record<string, unknown>>(space, PARENT);
      await runtime.idle();
      await parent.pull();
      const value = parent.get() as Record<string, unknown>;
      const out: Record<
        string,
        { countDoc: string; count: unknown; owner: unknown }
      > = {};
      for (const name of ["a", "s"]) {
        if (!(`${name}Count` in value)) continue;
        out[name] = {
          countDoc: await docOf(parent.key(`${name}Count`)),
          count: value[`${name}Count`],
          owner: value[`${name}Owner`],
        };
      }
      return out;
    };

    const instanceChildren = async (runtime: Runtime) => {
      const parent = runtime.getCell(space, PARENT);
      await parent.sync();
      const raw = parent.getMetaRaw("instanceChildren") as
        | { name: string; child: { id: string } }[]
        | undefined;
      return raw === undefined ? undefined : Object.fromEntries(
        raw.map(({ name, child }) => [name, child.id]),
      );
    };

    const bump = async (runtime: Runtime, key: string, by: number) => {
      const parent = runtime.getCell(space, PARENT);
      await parent.sync();
      parent.key(key).send({ by });
      await runtime.idle();
    };

    const deploy = async (runtime: Runtime) => {
      const pattern = await runtime.patternManager.compilePattern(DEPLOYED, {
        space,
      });
      const tx = runtime.edit();
      const parent = runtime.getCell<Record<string, unknown>>(
        space,
        PARENT,
        undefined,
        tx,
      );
      const running = runtime.run(tx, pattern, {}, parent);
      expect((await tx.commit().settled).error).toBeUndefined();
      await running.pull();
      await runtime.idle();
    };

    // Moves the parent's pointer to `program` and sets it up, as its updater
    // does.
    const update = async (runtime: Runtime, program: RuntimeProgram) => {
      const parent = runtime.getCell<Record<string, unknown>>(space, PARENT);
      await parent.sync();
      const pattern = await runtime.patternManager.compilePattern(program, {
        space,
      });
      const ref = runtime.patternManager.getArtifactEntryRef(pattern)!;
      const stamp = runtime.edit();
      parent.withTx(stamp).setMetaRaw("patternIdentity", {
        identity: ref.identity,
        symbol: ref.symbol,
      }, rawMetaWriteAuthorization);
      expect((await stamp.commit().settled).error).toBeUndefined();
      await runtime.runSynced(parent.withTx(), pattern, undefined, {
        expectedPatternIdentity: ref,
      });
      await runtime.idle();
    };

    const reopen = async (runtime: Runtime) => {
      const parent = runtime.getCell(space, PARENT);
      await parent.sync();
      expect(await runtime.runner.start(parent)).toBe(true);
      await runtime.idle();
    };

    // The deployed parent, set up by a runtime with naming off and holding
    // `a`'s count of 7, then updated by a runtime with naming on to insert
    // `s` ahead of `a`, with a write through each handler. Returns the
    // children's count documents.
    const carriedOver = async () => {
      const positional = runtimeNaming(false);
      await deploy(positional);
      await bump(positional, "aBump", 7);
      await retire(positional);

      const naming = runtimeNaming(true);
      await update(naming, WITH_SIBLING);
      await bump(naming, "aBump", 1);
      await bump(naming, "sBump", 20);
      const before = await children(naming);
      expect({
        shown: await shown(naming),
        instanceChildren: await instanceChildren(naming),
      }).toEqual({
        shown: {
          a: { countDoc: before.A.countDoc, count: 8, owner: "a" },
          s: { countDoc: before.S.countDoc, count: 20, owner: "s" },
        },
        instanceChildren: {
          a: childAt(naming, { $generated: 0 }).getAsNormalizedFullLink().id,
        },
      });
      await retire(naming);
      return before;
    };

    it("keeps each child on its own document across starts, when every runtime names instances", async () => {
      // The control: no runtime with naming off ever opens the parent, so
      // `a` is named from its first setup and nothing is carried over.

      const first = runtimeNaming(true);
      await deploy(first);
      await bump(first, "aBump", 7);
      await retire(first);

      const second = runtimeNaming(true);
      await update(second, WITH_SIBLING);
      await bump(second, "aBump", 1);
      await bump(second, "sBump", 20);
      await retire(second);

      const third = runtimeNaming(true);
      await reopen(third);
      await bump(third, "aBump", 300);
      await bump(third, "sBump", 4000);
      const named = await docOf(
        childAt(third, instancePartialCause("a")).key("count"),
      );
      const all = await children(third);

      expect({
        shown: await shown(third),
        positionalSetUp: [all.A.setUp, all.O.setUp],
        instanceChildren: await instanceChildren(third),
      }).toEqual({
        shown: {
          a: { countDoc: named, count: 308, owner: "a" },
          s: { countDoc: all.S.countDoc, count: 4020, owner: "s" },
        },
        positionalSetUp: [false, false],
        instanceChildren: undefined,
      });
    });

    it("binds the inserted sibling to the carried child's document, and a fresh child to the named instance, when a runtime with naming off reopens it", async () => {
      // TODO(danfuzz): This pins the hazard the activation boundary exists to
      // exclude. Once a runtime whose naming mode differs from the parent's is
      // kept away from it, this case becomes a refusal, and the expectation
      // here changes with it.

      const before = await carriedOver();

      const positional = runtimeNaming(false);
      await reopen(positional);
      await bump(positional, "aBump", 300);
      await bump(positional, "sBump", 4000);
      const after = await children(positional);

      expect({
        shown: await shown(positional),
        A: { label: after.A.label },
        O: { setUp: after.O.setUp, label: after.O.label },
      }).toEqual({
        // What the parent shows still follows the links the naming runtime's
        // setup wrote, but the write to `a` was handled with `s`'s arguments.
        shown: {
          a: { countDoc: before.A.countDoc, count: 308, owner: "s" },
          s: { countDoc: before.S.countDoc, count: 4020, owner: "s" },
        },
        // `s` runs on `A` and has written its arguments there, and `a` runs
        // on a child nothing shows.
        A: { label: "s" },
        O: { setUp: true, label: "a" },
      });
    });

    it("binds each child back to its own document, when a runtime with naming on reopens it after one with naming off", async () => {
      const before = await carriedOver();
      const positional = runtimeNaming(false);
      await reopen(positional);
      await bump(positional, "aBump", 300);
      await retire(positional);

      const naming = runtimeNaming(true);
      await reopen(naming);
      await bump(naming, "aBump", 50000);
      await bump(naming, "sBump", 600000);
      const after = await children(naming);

      expect({
        shown: await shown(naming),
        A: { label: after.A.label },
      }).toEqual({
        shown: {
          a: { countDoc: before.A.countDoc, count: 50308, owner: "a" },
          s: { countDoc: before.S.countDoc, count: 600020, owner: "s" },
        },
        A: { label: "a" },
      });
    });

    it("shows the carried child's state under the inserted sibling, and a fresh one under the named instance, when a runtime with naming off updates it", async () => {
      // TODO(danfuzz): As above, this pins what the activation boundary has
      // to exclude: the update applies, with no refusal.

      const before = await carriedOver();

      const positional = runtimeNaming(false);
      await update(positional, WITH_SIBLING_EDITED);
      await bump(positional, "aBump", 300);
      await bump(positional, "sBump", 4000);
      const after = await children(positional);

      expect(await shown(positional)).toEqual({
        a: { countDoc: after.O.countDoc, count: 300, owner: "a" },
        s: { countDoc: before.A.countDoc, count: 4008, owner: "s" },
      });
    });
  });
});

/**
 * A named instance's carry-over when loading the pattern its parent last set
 * up fails.
 */

import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("runner-cov-b carry-over");
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

// `a` bound to a `const`, with an unrelated sibling inserted ahead of it.
const NAMED_WITH_SIBLING = parentProgram([
  "  const s = Other({ label: 's' });",
  "  const a = Counter({ label: 'a' });",
  "  return { views: [s, a], aCount: a.count, sCount: s.count };",
].join("\n"));

describe("runner instance carry-over", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let rt: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      experimental: { instanceNames: true },
      storageManager,
    });
  });

  afterEach(async () => {
    await rt?.dispose();
    await storageManager?.close();
  });

  const compile = (program: RuntimeProgram) =>
    rt.patternManager.compilePattern(program, { space });

  /**
   * A stopped parent that ran `DEPLOYED` with `a`'s count at 7, whose pointer
   * and setup marker name `setUp`, and which holds no setup record.
   */
  async function deployedParent(name: string, setUp: { identity: string }) {
    const deployed = await compile(DEPLOYED);
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
    expect((await write.commit().settled).error).toBeUndefined();
    await rt.idle();
    rt.runner.stop(cell);
    const stamp = rt.edit();
    for (const field of ["patternIdentity", "patternSetupIdentity"] as const) {
      cell.withTx(stamp).setMetaRaw(field, {
        identity: setUp.identity,
        symbol: "default",
      }, rawMetaWriteAuthorization);
    }
    cell.withTx(stamp).setMetaRaw(
      "patternSetupBuild",
      undefined,
      rawMetaWriteAuthorization,
    );
    expect((await stamp.commit().settled).error).toBeUndefined();
    return cell;
  }

  /** Updates the parent at `cell` to `program`, returning its result. */
  async function update(
    cell: Cell<Record<string, unknown>>,
    program: RuntimeProgram,
  ): Promise<Record<string, unknown>> {
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
  }

  it("carries a child over by its pattern identity, and logs why, when the pattern the parent last set up fails to load", async () => {
    const unloadable = "of:fid1:runner-cov-b-unloadable";
    const cell = await deployedParent("previous-load-fails", {
      identity: unloadable,
    });
    const manager = rt.patternManager;
    const load = manager.loadPatternByIdentity.bind(manager);
    let refused = 0;
    manager.loadPatternByIdentity = (identity, symbol, inSpace, options) => {
      if (identity !== unloadable) {
        return load(identity, symbol, inSpace, options);
      }
      refused++;
      return Promise.reject(new Error("The store is unreachable"));
    };
    const runnerLogger = getLogger("runner");
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => Deno.inspect(arg)).join(" "));
    };
    let result: Record<string, unknown>;
    try {
      result = await update(cell, NAMED_WITH_SIBLING);
    } finally {
      console.warn = warn;
    }

    expect(runnerLogger.level).toBe("warn");
    expect(refused).toBeGreaterThan(0);
    expect({ aCount: result.aCount, sCount: result.sCount }).toEqual({
      aCount: 7,
      sCount: 0,
    });
    const loadWarnings = warnings.filter((line) =>
      line.includes(`could not load ${unloadable}#default`)
    );
    expect(loadWarnings.length).toBeGreaterThan(0);
    expect(
      loadWarnings.every((line) => line.includes("The store is unreachable")),
    ).toBe(true);
  });
});

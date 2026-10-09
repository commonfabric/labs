import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
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

/**
 * A parent of `body`, which builds the children the result `{ views, aCount,
 * sCount? }` names. A child bound to a `const` is a named instance; one bound
 * by destructuring keeps the positional cause every child had before named
 * instances, which is how a deployed parent's stored state is reproduced.
 */
const parentProgram = (body: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [
    { name: "/counter.tsx", contents: COUNTER },
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

// An unrelated sibling `s` inserted ahead of `a`.
const NAMED_WITH_SIBLING = parentProgram([
  "  const s = Other({ label: 's' });",
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
   * A stopped parent holding `a`'s count of 7 at the positional spot the
   * deployed parent gave it, its pattern pointers naming `NAMED`, the source
   * it runs, unless `marker` is `"absent"`, which leaves no setup marker, as
   * a parent set up before the marker existed has none.
   */
  const deployedParent = async (
    name: string,
    marker: "named" | "absent" = "named",
  ): Promise<Cell<Record<string, unknown>>> => {
    const deployed = await compile(DEPLOYED);
    const named = await compile(NAMED);
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
    cell.withTx(write).key("aCount").set(7);
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

  it("keeps a deployed child's state when an unrelated sibling is inserted ahead of it", async () => {
    const cell = await deployedParent("sibling-inserted");

    const result = await update(cell, NAMED_WITH_SIBLING);

    expect(result.aCount).toBe(7);
    expect(result.sCount).toBe(0);
  });

  it("keeps a deployed child's state when the parent carries no setup marker", async () => {
    const cell = await deployedParent("no-setup-marker", "absent");

    const result = await update(cell, NAMED_WITH_SIBLING);

    expect(result.aCount).toBe(7);
    expect(result.sCount).toBe(0);
  });

  it("keeps the carried-over child across a further update", async () => {
    const cell = await deployedParent("further-update");
    await update(cell, NAMED_WITH_SIBLING);
    const write = rt.edit();
    cell.withTx(write).key("aCount").set(8);
    expect((await write.commit().settled).error).toBeUndefined();
    await rt.idle();

    const result = await update(cell, NAMED);

    expect(result.aCount).toBe(8);
  });

  it("refuses to set up a positional child over a child that has moved spots", async () => {
    const cell = await deployedParent("positional-moved");

    await expect(update(cell, POSITIONAL_WITH_SIBLING)).rejects.toThrow(
      /refusing to set up .*#Other over the child of .*#Counter/,
    );
  });
});

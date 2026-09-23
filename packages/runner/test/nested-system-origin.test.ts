import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { PATTERNS_ROUTE_PREFIX } from "../src/pattern-source-scheme.ts";
import { getPatternSource } from "../src/runner.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("runner-nested-system-origin");
const space = signer.did();

const PARENT_ORIGIN = "system:system/parent.tsx";

const childSource = [
  "import { computed, pattern } from 'commonfabric';",
  "export default pattern<Record<string, never>, { marker: string }>(() => ({",
  "  marker: computed(() => 'child'),",
  "}));",
  "",
].join("\n");

// A parent instantiating the child twice over: as a node of its own graph,
// and from a handler, in a space of the child's own.
const parentSource = [
  "import { handler, navigateTo, pattern, Writable } from 'commonfabric';",
  "import Child from './child.tsx';",
  "",
  "const spawn = handler<unknown, { spawned: Writable<unknown[]> }>(",
  "  (_, { spawned }) => {",
  "    spawned.push(Child.inSpace()({}));",
  "  },",
  ");",
  "",
  "// The same spawn, with a result the runtime starts only after the",
  "// handler's commit (a `navigateTo` result is commit-gated).",
  "const spawnAndGo = handler<unknown, { spawned: Writable<unknown[]> }>(",
  "  (_, { spawned }) => {",
  "    const child = Child.inSpace()({});",
  "    spawned.push(child);",
  "    return navigateTo(child);",
  "  },",
  ");",
  "",
  "export default pattern(() => {",
  "  const spawned = new Writable<unknown[]>([]).for('spawned');",
  "  const nested = Child({});",
  "  return {",
  "    nested, spawned,",
  "    spawn: spawn({ spawned }),",
  "    spawnAndGo: spawnAndGo({ spawned }),",
  "  };",
  "});",
  "",
].join("\n");

/** The program, with its modules named the way `dir` says. */
function program(dir: string): RuntimeProgram {
  return {
    main: `${dir}parent.tsx`,
    files: [
      { name: `${dir}parent.tsx`, contents: parentSource },
      { name: `${dir}child.tsx`, contents: childSource },
    ],
  };
}

const linkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  // deno-lint-ignore no-explicit-any
} as any;

describe("a child's origin", () => {
  let runtime: Runtime | undefined;
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;

  afterEach(async () => {
    await runtime?.dispose({ closeStorage: false });
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  /**
   * Runs the parent, with `origin` claimed for it or none, and returns the
   * origin its nested child and its handler-spawned child each record.
   */
  async function childOrigins(
    dir: string,
    origin: string | undefined,
    verb: "spawn" | "spawnAndGo" = "spawn",
  ): Promise<{ nested: string | undefined; spawned: string | undefined }> {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      // A `navigateTo` result asks the host to navigate; nobody is watching.
      navigateCallback: () => {},
    });
    const tx = runtime.edit();
    const parent = await runtime.patternManager.compilePattern(
      program(dir),
      { space, tx },
    );
    const resultCell = runtime.getCell<Record<string, unknown>>(
      space,
      `nested system origin ${dir} ${origin ?? "detached"}`,
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const run = runtime.runner.run(tx, parent as any, {}, resultCell, {
      ...(origin === undefined ? {} : { sourceOrigin: origin }),
    });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await run.pull();
    await runtime.idle();

    const spawnTx = runtime.edit();
    run.withTx(spawnTx).key(verb).send({});
    expect((await spawnTx.commit()).error).toBeUndefined();
    await run.pull();
    await runtime.idle();
    await run.pull();

    const nested = run.key("nested").resolveAsCell();
    const [spawnedLink] = run.key("spawned").asSchema(linkListSchema)
      // deno-lint-ignore no-explicit-any
      .get() as any[];
    expect(spawnedLink.getAsNormalizedFullLink().space).not.toBe(space);
    // Provenance belongs to the resolved child; inspecting it requires a
    // readable projection rather than the list's opaque reference schema.
    const spawnedHandle = runtime.getCellFromLink(
      spawnedLink.getAsNormalizedFullLink(),
      {},
    );
    await spawnedHandle.sync();
    const spawned = spawnedHandle.resolveAsCell();
    await spawned.sync();
    return {
      nested: getPatternSource(nested),
      spawned: getPatternSource(spawned),
    };
  }

  it("is the child module's `system:` ref for a child in a space of its own, under a parent that follows one from the patterns route; an in-space nested node claims none", async () => {
    const dir = `${PATTERNS_ROUTE_PREFIX}system/`;
    expect(await childOrigins(dir, PARENT_ORIGIN)).toEqual({
      nested: undefined,
      spawned: "system:system/child.tsx",
    });
  });

  it("is claimed as well for a child whose handler result the runtime starts after the commit", async () => {
    const dir = `${PATTERNS_ROUTE_PREFIX}system/`;
    expect(await childOrigins(dir, PARENT_ORIGIN, "spawnAndGo")).toEqual({
      nested: undefined,
      spawned: "system:system/child.tsx",
    });
  });

  it("is absent under a parent that follows no origin", async () => {
    const dir = `${PATTERNS_ROUTE_PREFIX}system/`;
    expect(await childOrigins(dir, undefined)).toEqual({
      nested: undefined,
      spawned: undefined,
    });
  });

  it("is absent when the child's module is not one the patterns route serves", async () => {
    expect(await childOrigins("/", PARENT_ORIGIN)).toEqual({
      nested: undefined,
      spawned: undefined,
    });
  });
});

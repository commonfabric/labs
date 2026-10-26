/**
 * Runtimes that differ in their `instanceNames` experimental flag, over one
 * store: compiled code is never shared between the two naming modes. Each
 * runtime sits on a storage manager of its own over one memory server, so it
 * starts from what it syncs, as a runtime in another process does.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import type { Pattern } from "../src/builder/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("instance-naming-modes");
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

// A parent with two `const`-bound children of one pattern.
const PARENT: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    { name: "/counter.tsx", contents: COUNTER },
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "import { Counter } from './counter.tsx';",
        "export default pattern<Record<string, never>>(() => {",
        "  const s = Counter({ label: 's' });",
        "  const a = Counter({ label: 'a' });",
        "  return { views: [s, a], aCount: a.count, sCount: s.count };",
        "});",
        "",
      ].join("\n"),
    },
  ],
};

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

  // Writes back everything `runtime` holds and stops it.
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
      const named = await naming.patternManager.compilePattern(PARENT, {
        space,
      });
      const identity = naming.patternManager.getArtifactEntryRef(named)!
        .identity;
      await retire(naming);

      const positional = runtimeNaming(false);
      const loaded = await positional.patternManager.compilePattern(PARENT, {
        space,
        knownEntryIdentity: identity,
      });

      expect({
        named: namesAnInstance(named),
        loaded: namesAnInstance(loaded),
      }).toEqual({ named: true, loaded: false });
    });

    it("is not shared from a runtime that does not name instances with one that does", async () => {
      const positional = runtimeNaming(false);
      const unnamed = await positional.patternManager.compilePattern(PARENT, {
        space,
      });
      const identity = positional.patternManager.getArtifactEntryRef(unnamed)!
        .identity;
      await retire(positional);

      const naming = runtimeNaming(true);
      const loaded = await naming.patternManager.compilePattern(PARENT, {
        space,
        knownEntryIdentity: identity,
      });

      expect({
        unnamed: namesAnInstance(unnamed),
        loaded: namesAnInstance(loaded),
      }).toEqual({ unnamed: false, loaded: true });
    });
  });
});

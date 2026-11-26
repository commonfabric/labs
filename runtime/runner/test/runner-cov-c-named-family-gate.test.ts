/**
 * The gate a named family's run passes before it runs without a name-sync
 * of its own, where the replica cannot say which absences it examined.
 */

import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { IStorageProvider } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("runner-cov-c named family gate");
const space = signer.did();

// Each row owns two cells of the session's own with no default to seed. A
// session that has not run the row holds no document for either, so once
// the root's pre-sync asked the store for them, a row's own name-sync could
// deliver nothing.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern, type PerSession, Writable } from 'commonfabric';",
      "type Item = { n: number };",
      "export const row = pattern<{ item: Item }, {",
      "  value: number;",
      "  note?: string;",
      "  draft?: string;",
      "}>(({ item }) => {",
      "  const note = computed(",
      "    (): PerSession<string | undefined> =>",
      "      item.n > 100 ? 'large' : undefined,",
      "  );",
      "  const draft = new Writable.perSession<string | undefined>(undefined);",
      "  return { value: computed(() => item.n * 2), note, draft };",
      "});",
      "export default pattern<{ items: Item[] }, {",
      "  rows: { value: number; note?: string; draft?: string }[];",
      "}>(({ items }) => ({",
      "  rows: items.map((item) => row({ item })),",
      "}));",
    ].join("\n"),
  }],
};

const ITEMS = [{ n: 1 }, { n: 2 }, { n: 3 }];

describe("runner named family gate", () => {
  let server: ReturnType<typeof newSharedServer>;
  let managers: EmulatedStorageManager[];
  let runtimes: Runtime[];

  beforeEach(() => {
    server = newSharedServer();
    managers = [];
    runtimes = [];
  });

  afterEach(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    for (const manager of managers) await manager.close();
    await server.close();
  });

  function replica(): { runtime: Runtime; manager: EmulatedStorageManager } {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    managers.push(manager);
    runtimes.push(runtime);
    return { runtime, manager };
  }

  /** Runs the tree under `cellId` until the store holds all of it. */
  async function authorTree(cellId: string): Promise<void> {
    const { runtime } = replica();
    const compiled = await runtime.patternManager.compilePattern(PROGRAM, {
      space,
    });
    const tx = runtime.edit();
    const authored = runtime.getCell<unknown>(
      space,
      cellId,
      compiled.resultSchema,
      tx,
    );
    runtime.run(tx, compiled, { items: ITEMS }, authored);
    await tx.commit().settled;
    await authored.pull();
    await runtime.settled();
    await runtime.patternManager.flushCompileCacheWrites();
    await runtime.storageManager.synced();
    await runtime.dispose({ closeStorage: false });
    runtimes.splice(runtimes.indexOf(runtime), 1);
  }

  /**
   * Resumes the tree at `cellId` on a runtime of its own, with `prepare`
   * applied to the replica first, and returns the result documents of the
   * families the resume paid a name-sync for.
   */
  async function resumeTree(
    cellId: string,
    prepare?: (manager: EmulatedStorageManager) => void,
  ): Promise<Set<string>> {
    const { runtime, manager } = replica();
    const pattern = await runtime.patternManager.compilePattern(PROGRAM, {
      space,
    });
    prepare?.(manager);
    const named = new Set<string>();
    runtime.runner.accessForTestingOnly.dependencySyncer = (
      resultCell,
      pattern,
      inputs,
      sync,
    ) => {
      named.add(resultCell.getAsNormalizedFullLink().id);
      return sync(resultCell, pattern, inputs);
    };
    const resumed = runtime.getCell<unknown>(
      space,
      cellId,
      pattern.resultSchema,
    );
    expect(await runtime.runner.start(resumed)).toBe(true);
    await resumed.pull();
    await runtime.settled();
    return named;
  }

  it("names only the root's family where the replica reports which absences it examined", async () => {
    await authorTree("gate examined");

    expect((await resumeTree("gate examined")).size).toBe(1);
  });

  it("names each element's families too where the provider cannot say which absences it examined", async () => {
    await authorTree("gate unexamined");

    const named = await resumeTree("gate unexamined", (manager) => {
      const provider: IStorageProvider = manager.open(space);
      Object.defineProperty(provider, "unexaminedAbsences", {
        value: undefined,
      });
    });

    // Each element runs the row inside the wrapper the map builds around it,
    // and each of the two is a family of its own.
    expect(named.size).toBe(1 + 2 * ITEMS.length);
  });
});

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { getLogger } from "@commonfabric/utils/logger";
import type { Pattern } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import {
  getDerivedInternalCellLink,
  getMetaLink,
  parseLink,
} from "../src/link-utils.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { trustExecutable } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("resume list children faults");
const space = signer.did();

type Emission = { level: "debug" | "warn"; key: string; parts: unknown[] };

/**
 * Record every `debug`/`warn` the runner's logger emits while `fn` runs,
 * resolving each call's lazy message thunk the way the logger itself does.
 */
const captureRunnerLog = async (
  fn: () => Promise<void>,
): Promise<Emission[]> => {
  const logger = getLogger("runner") as unknown as Record<
    "debug" | "warn",
    (key: string, ...messages: unknown[]) => void
  >;
  const emissions: Emission[] = [];
  const originals = { debug: logger.debug, warn: logger.warn };
  const record =
    (level: "debug" | "warn") => (key: string, ...messages: unknown[]) => {
      emissions.push({
        level,
        key,
        parts: messages.flatMap((message) => {
          const resolved = typeof message === "function" ? message() : message;
          return Array.isArray(resolved) ? resolved : [resolved];
        }),
      });
      originals[level].call(logger, key, ...messages);
    };
  logger.debug = record("debug");
  logger.warn = record("warn");
  try {
    await fn();
  } finally {
    logger.debug = originals.debug;
    logger.warn = originals.warn;
  }
  return emissions;
};

const listChildrenMessages = (emissions: Emission[]): string[] =>
  emissions
    .filter((emission) => emission.key === "resume-list-children")
    .map((emission) => `${emission.level}:${String(emission.parts[0])}`);

const childPattern: Pattern = {
  argumentSchema: {},
  resultSchema: {},
  result: {},
  nodes: [],
};

// A `map` node whose `list` input aliases a derived internal cell the
// pattern's manifest does not declare. Binding the node's inputs throws, so
// neither the slot rounds nor the children derivation can read past it.
const unbindableListPattern: Pattern = {
  argumentSchema: {},
  resultSchema: {},
  result: {},
  derivedInternalCells: [],
  nodes: [
    {
      description: "map over an alias the manifest does not declare",
      module: { type: "ref", implementation: "map" },
      inputs: {
        list: { $alias: { partialCause: "undeclared", path: [] } },
        op: childPattern,
        params: {},
      },
      outputs: { $alias: { cell: "result", path: ["rows"] } },
    },
  ],
} as unknown as Pattern;

// A `map` node whose outputs hold no write redirect: the plan has nothing to
// anchor the result container's identity on and refuses.
const unanchoredListPattern: Pattern = {
  argumentSchema: {},
  resultSchema: {},
  result: {},
  nodes: [
    {
      description: "map with no reserved output spot",
      module: { type: "ref", implementation: "map" },
      inputs: {
        list: { $alias: { cell: "argument", path: ["items"] } },
        op: childPattern,
        params: {},
      },
      outputs: {},
    },
  ],
} as unknown as Pattern;

// A map over a durable list, run for real: each element runs as a child
// piece of its own, with one derived internal cell (`item.n * 2`).
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { n: number }[] }>(({ items }) => {",
      "  return { doubled: items.map((item) => ({ value: item.n * 2 })) };",
      "});",
    ].join("\n"),
  }],
};

describe("resume-list-children-faults", () => {
  // The resume's list wave names what its coordinators will run, and it is
  // best-effort for node plans and values. Child metadata must load before
  // selecting an address format; a failed metadata load refuses resume.
  // Other exits are logged under
  // `resume-list-children`, at debug where the start that follows reports
  // the same failure itself and at warn where nothing else would.

  describe("a node the wave cannot read past", () => {
    // The fixtures resume a stored result cell (a seed run writes its
    // argument meta link first, so the walk treats the run as a resume). A
    // defect that binding hits rejects the start too; one the plan hits
    // surfaces in the coordinator's own run, so the start itself resolves.

    const resumeWith = async (
      pattern: Pattern,
      cause: string,
      rejectsWith?: RegExp,
    ): Promise<string[]> => {
      const storageManager = StorageManager.emulate({ as: signer });
      try {
        const seedRuntime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
        });
        const seedCell = seedRuntime.getCell(space, cause);
        await seedRuntime.runSynced(
          seedCell,
          trustExecutable(seedRuntime, childPattern),
          {},
        );
        await seedCell.pull();
        await seedRuntime.settled();
        await storageManager.synced();
        await seedRuntime.dispose({ closeStorage: false });

        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
        });
        const resultCell = runtime.getCell(space, cause);
        const emissions = await captureRunnerLog(async () => {
          const run = runtime.runSynced(
            resultCell,
            trustExecutable(runtime, pattern),
            {},
          );
          if (rejectsWith !== undefined) {
            await expect(run).rejects.toThrow(rejectsWith);
          } else {
            await run;
          }
        });
        await runtime.settled();
        await storageManager.synced();
        await runtime.dispose({ closeStorage: false });
        return listChildrenMessages(emissions);
      } finally {
        await storageManager.close();
      }
    };

    it("skips a node whose inputs do not bind, in both the slot rounds and the children derivation", async () => {
      const messages = await resumeWith(
        unbindableListPattern,
        "list-faults-unbindable",
        /Unknown derived internal cell/,
      );
      expect(messages).toContain(
        "debug:skipping a list node whose slots could not be resolved",
      );
      expect(messages).toContain(
        "debug:skipping a list node whose children could not be derived",
      );
    });

    it("skips a node whose plan cannot anchor its result container", async () => {
      const messages = await resumeWith(
        unanchoredListPattern,
        "list-faults-unanchored",
      );
      expect(messages).toContain(
        "debug:skipping a list node whose children could not be derived",
      );
      // The slot rounds read this node fine: its list input binds, and an
      // argument without `items` syncs the list's entity for the next round.
      expect(messages).not.toContain(
        "debug:skipping a list node whose slots could not be resolved",
      );
    });
  });

  describe("a document the wave cannot pull", () => {
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

    it("refuses unavailable child identity metadata and resumes after it can be loaded", async () => {
      const cellId = "list-faults-sync-failures";

      // CREATE: the durable list and its children, on one replica.
      const author = replica();
      const compiled = await author.runtime.patternManager.compilePattern(
        PROGRAM,
        { space },
      );
      const tx = author.runtime.edit();
      const authored = author.runtime.getCell<
        { doubled: { value: number }[] }
      >(space, cellId, compiled.resultSchema, tx);
      author.runtime.run(
        tx,
        compiled,
        { items: [{ n: 1 }, { n: 2 }] },
        authored,
      );
      await tx.commit();
      await authored.pull();
      await author.runtime.settled();
      await author.runtime.patternManager.flushCompileCacheWrites();
      await author.runtime.storageManager.synced();
      const container = authored.key("doubled").resolveAsCell();
      const slots = container.getRaw() as unknown[];
      const childIds: string[] = slots.flatMap((slot) => {
        const id = parseLink(slot, container)?.id;
        return id === undefined ? [] : [id as string];
      });
      expect(childIds.length).toBe(2);
      const elementPattern = (compiled.nodes[0].inputs as { op: Pattern }).op;
      const ownedIds: string[] = slots.flatMap((slot) => {
        const childLink = parseLink(slot, container);
        if (childLink === undefined) return [];
        const childCell = author.runtime.getCellFromLink(childLink);
        return (elementPattern.derivedInternalCells ?? []).map((descriptor) =>
          getDerivedInternalCellLink(childCell, descriptor).id as string
        );
      });
      expect(ownedIds.length).toBe(2);
      const argumentId = getMetaLink(authored, "argument")?.id;
      expect(argumentId).toBeDefined();
      await author.runtime.dispose({ closeStorage: false });
      runtimes.splice(runtimes.indexOf(author.runtime), 1);

      // RESUME: a cold replica whose syncs of exactly the wave's targets
      // fail — the children, their owned cells, and the slot resolutions
      // (element paths into the list's own document; the root wave's syncs
      // of that document at its root and at the list's path are left alone).
      const resumer = replica();
      await resumer.runtime.patternManager.compilePattern(PROGRAM, { space });
      const original = resumer.manager.syncCell.bind(resumer.manager);
      const refused: string[] = [];
      let refuseChildMetadata = true;
      resumer.manager.syncCell = ((cell, options) => {
        const link = cell.getAsNormalizedFullLink();
        const isSlotTarget = link.id === argumentId && link.path.length > 1;
        if (
          (refuseChildMetadata && childIds.includes(link.id)) ||
          ownedIds.includes(link.id) ||
          isSlotTarget
        ) {
          refused.push(link.id);
          return Promise.reject(new Error("injected sync failure"));
        }
        return original(cell, options);
      }) as typeof resumer.manager.syncCell;
      const resumed = resumer.runtime.getCell<
        { doubled: { value: number }[] }
      >(space, cellId, compiled.resultSchema);

      await expect(resumer.runtime.runner.start(resumed)).rejects.toThrow(
        "injected sync failure",
      );
      expect(refused.length).toBeGreaterThan(0);

      // Once metadata can load, value prefetch failures remain best-effort.
      refuseChildMetadata = false;
      const emissions = await captureRunnerLog(async () => {
        expect(await resumer.runtime.runner.start(resumed)).toBe(true);
      });
      const messages = listChildrenMessages(emissions);
      expect(messages).toContain(
        "warn:list slot resolution sync failed; resuming without it",
      );
      expect(messages).toContain(
        "warn:list child owned-cell sync failed; resuming without it",
      );
      resumer.manager.syncCell = original as typeof resumer.manager.syncCell;
      await resumed.pull();
      await resumer.runtime.settled();
      await resumer.runtime.storageManager.synced();
      expect(
        (resumed.key("doubled").getAsQueryResult() as { value: number }[])
          .map((row) => row.value),
      ).toEqual([2, 4]);
    });
  });
});

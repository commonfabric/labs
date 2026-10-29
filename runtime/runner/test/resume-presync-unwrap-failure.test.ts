import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import type { Pattern } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { trustExecutable } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("resume presync unwrap failure");
const space = signer.did();

const presyncWarns = () => {
  const counts = getLoggerCountsBreakdown()["runner"] ?? {};
  return (counts as Record<string, { total?: number }>)["resume-pre-sync"]
    ?.total ?? 0;
};

describe("resume pre-sync unwrap failure", () => {
  it("skips a node whose bindings do not unwrap, with a warn", async () => {
    // The resume pre-sync (`Runner.#syncCellsForRunningPatternInner()`)
    // unwraps each node's bindings before walking them for write redirects. A
    // node whose bindings cannot be bound — here a partialCause alias with no
    // matching derivedInternalCells descriptor — must be skipped with a warn
    // rather than breaking the pre-sync walk. (Instantiation then rejects the
    // same alias at bind time; that failure is the pattern's problem, not the
    // pre-sync's.)

    const storageManager = StorageManager.emulate({ as: signer });
    try {
      // Seed run: a trivial pattern whose setup writes the result cell's
      // argument meta link — without it the pre-sync skips the node walk
      // before reaching the unwrap.
      const seedPattern: Pattern = {
        argumentSchema: {},
        resultSchema: {},
        result: {},
        nodes: [],
      };
      const rt1 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const rc1 = rt1.getCell(space, "presync-unwrap-failure");
      await rt1.runSynced(rc1, trustExecutable(rt1, seedPattern), {});
      await rc1.pull();
      await rt1.dispose();

      const badPattern = {
        argumentSchema: {},
        resultSchema: {},
        derivedInternalCells: [{ partialCause: "known" }],
        result: {},
        nodes: [
          {
            module: { type: "javascript", implementation: () => 1 },
            inputs: {},
            outputs: { $alias: { partialCause: "unknown-cause", path: [] } },
          },
        ],
      } as Pattern;

      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const rc2 = rt2.getCell(space, "presync-unwrap-failure");
      const before = presyncWarns();
      try {
        await rt2.runSynced(rc2, trustExecutable(rt2, badPattern), {});
      } catch {
        // Bind-time unwrap rejects the same unknown partialCause; the
        // pre-sync must already have warned and skipped the node by then.
      }
      expect(presyncWarns()).toBeGreaterThan(before);
      await rt2.dispose();
    } finally {
      await storageManager.close();
    }
  });
});

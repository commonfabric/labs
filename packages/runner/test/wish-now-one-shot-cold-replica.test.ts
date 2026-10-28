/**
 * A one-shot `#now` whose capture sits under the key the wish node's full
 * cause makes, in a document a second session's replica has not loaded, is
 * carried over by that session rather than captured again from its clock:
 * the wish holds until the document has loaded, and commits without a
 * conflict.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  getLogger,
  getLoggerCountsBreakdown,
} from "@commonfabric/utils/logger";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { wishNowDiagnostics } from "../src/builtins/wish.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const user = await Identity.fromPassphrase("wish now one-shot cold replica");
const space = (await Identity.fromPassphrase("wish now one-shot cold space"))
  .did();

const CAUSE = "wish now one-shot cold replica piece";

type Result = { createdAt: unknown };

/** A piece whose `createdAt` is its one-shot `#now`. */
const program: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { pattern, wish } from "commonfabric";',
      "",
      "export default pattern<{}, { createdAt: unknown }>(",
      "  () => {",
      '    const now = wish<number>({ query: "#now" });',
      "    return { createdAt: now.result };",
      "  },",
      ");",
    ].join("\n"),
  }],
};

function commitConflictCount(): number {
  const counts = getLoggerCountsBreakdown()["storage.v2"] ?? {};
  return (counts as Record<string, { total?: number }>)["commit-conflict"]
    ?.total ?? 0;
}

describe("wish-now-one-shot-cold-replica", () => {
  let server: MemoryV2Server.Server;
  let storageA: EmulatedStorageManager;
  let storageB: EmulatedStorageManager;
  let a: Runtime;
  let b: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    storageA = EmulatedStorageManager.connectTo(server, { as: user });
    storageB = EmulatedStorageManager.connectTo(server, { as: user });
    a = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageA,
    });
    b = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageB,
    });
  });

  afterEach(async () => {
    await a?.dispose();
    await b?.dispose();
    await storageA?.close();
    await storageB?.close();
    await server?.close();
  });

  it("carries a capture under the earlier key over from a document the replica had not loaded", async () => {
    // The first session captures, and the capture is moved to the earlier
    // key's document, leaving the positional cell empty.
    const resultA = a.getCell<Result>(space, CAUSE);
    const compiledA = await a.patternManager.compilePattern(program, {
      space,
    });
    await a.runner.runSynced(resultA, compiledA, {});
    await a.idle();
    await resultA.pull();
    const captured = resultA.key("createdAt").get();
    expect(typeof captured).toBe("number");
    const cells = wishNowDiagnostics.lastOneShot;
    expect(cells?.legacy).toBeDefined();
    const earlier = (captured as number) - 60_000;
    a.runner.stop(resultA);
    const tx = a.edit();
    a.getCellFromLink(cells!.legacy!, undefined, tx).set(earlier);
    a.getCellFromLink(cells!.cell, undefined, tx).set(undefined);
    a.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await storageA.synced();

    // Past the coarsening boundary, so a capture from the clock would differ
    // from both instants. The second session's replica holds neither
    // document.
    await clock.tick(1100);
    getLogger("storage.v2").resetCounts();
    const conflictsBefore = commitConflictCount();
    const resultB = b.getCell<Result>(space, CAUSE);
    const compiledB = await b.patternManager.compilePattern(program, {
      space,
    });
    await b.runner.runSynced(resultB, compiledB, {});
    await b.idle();
    await storageB.synced();
    await resultB.pull();
    expect(resultB.key("createdAt").get()).toBe(earlier);
    expect(commitConflictCount()).toBe(conflictsBefore);
  });
});

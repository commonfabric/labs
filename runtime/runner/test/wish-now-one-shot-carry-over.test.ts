/**
 * A one-shot `#now` whose capture was written under the key the wish node's
 * full cause makes, inputs document included, is read from there when the
 * cell keyed by the node's piece and output spot is still empty, and copied
 * rather than taken from the clock again.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { wishNowDiagnostics } from "../src/builtins/wish.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const user = await Identity.fromPassphrase("wish now one-shot carry-over user");
const space =
  (await Identity.fromPassphrase("wish now one-shot carry-over space")).did();

const CAUSE = "wish now one-shot carry-over piece";

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

describe("wish-now-one-shot-carry-over", () => {
  let server: MemoryV2Server.Server;
  let storage: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    storage = EmulatedStorageManager.connectTo(server, { as: user });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storage?.close();
    await server?.close();
  });

  it("copies a capture keyed on the node's full cause into the empty positional cell", async () => {
    const result = runtime.getCell<Result>(space, CAUSE);
    const compiled = await runtime.patternManager.compilePattern(program, {
      space,
    });
    await runtime.runner.runSynced(result, compiled, {});
    await runtime.idle();
    await result.pull();
    const captured = result.key("createdAt").get();
    expect(typeof captured).toBe("number");
    const cells = wishNowDiagnostics.lastOneShot;
    expect(cells?.legacy).toBeDefined();

    // The capture as the earlier key held it: an older instant in the cell
    // the full cause names, and nothing in the positional cell.
    const earlier = (captured as number) - 60_000;
    runtime.runner.stop(result);
    const tx = runtime.edit();
    runtime.getCellFromLink(cells!.legacy!, undefined, tx).set(earlier);
    runtime.getCellFromLink(cells!.cell, undefined, tx).set(undefined);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();

    // Past the coarsening boundary, so a capture from the clock would differ
    // from both instants.
    await clock.tick(1100);
    await runtime.runner.runSynced(result, compiled, {});
    await runtime.idle();
    await storage.synced();
    await result.pull();
    expect(result.key("createdAt").get()).toBe(earlier);
  });
});

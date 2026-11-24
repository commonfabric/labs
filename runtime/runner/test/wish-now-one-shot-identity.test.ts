/**
 * One runtime runs a piece from one compilation of its pattern, then from a
 * second compilation that declares a wish's result under a schema that
 * differs, as a program compiled after a deploy does: the serialized inputs of
 * the wish node differ while its output slot is the same. The one-shot `#now`
 * the piece holds is its first-ever load time, and the second compilation
 * reads the capture the first one made.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const user = await Identity.fromPassphrase("wish now one-shot identity user");
const space =
  (await Identity.fromPassphrase("wish now one-shot identity space"))
    .did();

const CAUSE = "wish now one-shot identity piece";

type Result = { createdAt: unknown };

/**
 * A piece whose `createdAt` is its one-shot `#now`, declared as `resultType`,
 * beside a second wish whose declared result is what the two compilations
 * differ in.
 */
const program = (resultType: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { pattern, wish } from "commonfabric";',
      "",
      "export default pattern<{}, { createdAt: unknown }>(",
      "  () => {",
      `    const now = wish<${resultType}>({ query: "#now" });`,
      "    return { createdAt: now.result };",
      "  },",
      ");",
    ].join("\n"),
  }],
});

describe("wish-now-one-shot-identity", () => {
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

  it("keeps the first compilation's capture for a second whose wish inputs differ", async () => {
    const result = runtime.getCell<Result>(space, CAUSE);
    const first = await runtime.patternManager.compilePattern(
      program("number"),
      { space },
    );
    await runtime.runner.runSynced(result, first, {});
    await runtime.idle();
    await result.pull();
    const captured = result.key("createdAt").get();
    expect(typeof captured).toBe("number");

    // Past the capture's one-second coarsening, so a second capture would
    // show as a different value.
    runtime.runner.stop(result);
    await clock.tick(1100);

    // The same piece, from a compilation declaring the wish's result under a
    // wider type, so its wish node serializes different inputs to the same
    // output slot.
    const second = await runtime.patternManager.compilePattern(
      program("number | string"),
      { space },
    );
    await runtime.runner.runSynced(result, second, {});
    await runtime.idle();
    await result.pull();
    const read = result.key("createdAt").get();
    // The read above starts a load of the wish's state document under the
    // second compilation's schema; settle it before the runtime goes away.
    await runtime.idle();
    await storage.synced();
    expect(read).toBe(captured);
  });
});

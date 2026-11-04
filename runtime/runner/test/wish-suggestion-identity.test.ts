/**
 * Two sessions, each running a piece from its own compilation of the piece's
 * pattern, over one shared space. The piece's wish is a free-form query, which
 * the wish answers by sending its suggestion surface's cell into its output
 * slot. The two compilations declare the wish's result under schemas that
 * differ, as a program compiled before a deploy and one compiled after it do,
 * so the serialized inputs of the wish node differ while its output slot is
 * the same. Both name one suggestion cell.
 *
 * What this holds is the cell's identity. A run of the second compilation
 * moves the piece's pattern and the first session follows it, so the two
 * compilations do not stay live side by side here, and nothing about a loop
 * between two sessions holding one each is witnessed.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { parseLink } from "../src/link-utils.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const alice = await Identity.fromPassphrase("wish suggestion identity alice");
const bob = await Identity.fromPassphrase("wish suggestion identity bob");
const space = (await Identity.fromPassphrase("wish suggestion identity space"))
  .did();

const CAUSE = "wish suggestion identity piece";

type Result = { found: unknown };

/**
 * A piece whose wish is a free-form query, with the wish's result declared as
 * `resultType`.
 */
const program = (resultType: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { pattern, wish } from "commonfabric";',
      "",
      "export default pattern<{}, { found: unknown }>(",
      "  () => {",
      `    const found = wish<${resultType}>({ query: "something to find" });`,
      "    return { found };",
      "  },",
      ");",
    ].join("\n"),
  }],
});

describe("wish-suggestion-identity", () => {
  let server: MemoryV2Server.Server;
  let storageA: EmulatedStorageManager;
  let storageB: EmulatedStorageManager;
  let a: Runtime;
  let b: Runtime;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    // The suggestion surface's pattern is fetched from the patterns route.
    // Nothing serves it here, and the open reports that and keeps its
    // failure; the slot holds the surface's cell either way.
    originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("not found", { status: 404 }),
      )) as typeof fetch;
    server = newSharedServer();
    storageA = EmulatedStorageManager.connectTo(server, { as: alice });
    storageB = EmulatedStorageManager.connectTo(server, { as: bob });
    a = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storageA,
    });
    b = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storageB,
    });
  });

  afterEach(async () => {
    await a?.dispose();
    await b?.dispose();
    await storageA?.close();
    await storageB?.close();
    await server?.close();
    globalThis.fetch = originalFetch;
  });

  /** Syncs `runtime` with the server and refreshes `result` from it. */
  async function settle(
    runtime: Runtime,
    storage: EmulatedStorageManager,
    result: { pull(): Promise<unknown> },
  ): Promise<void> {
    await runtime.idle();
    await storage.synced();
    await result.pull();
  }

  /**
   * The cell `result`'s `found` slot links to: the slot is the wish node's
   * output document, and what it holds is the link the wish wrote.
   */
  async function slotLink(
    runtime: Runtime,
    result: Cell<Result>,
  ): Promise<NormalizedFullLink> {
    const slot = runtime.getCellFromLink(
      parseLink(result.key("found").getRaw(), result)!,
    );
    await slot.pull();
    return parseLink(slot.getRaw(), slot)!;
  }

  it("names one suggestion cell for two compilations whose wish inputs differ", async () => {
    // Alice's session creates the piece from a program declaring the wish's
    // result as `{ name: string }`.
    const txA = a.edit();
    const compiledA = await a.patternManager.compilePattern(
      program("{ name: string }"),
      { space, tx: txA },
    );
    const resultA = a.getCell<Result>(space, CAUSE, undefined, txA);
    a.run(txA, compiledA, {}, resultA);
    a.prepareTxForCommit(txA);
    expect((await txA.commit().settled).error).toBeUndefined();
    await settle(a, storageA, resultA);
    const linkA = await slotLink(a, resultA);

    // Bob's session runs the same piece from a program declaring the result
    // with one more member, so its wish node serializes different inputs to
    // the same output slot.
    const compiledB = await b.patternManager.compilePattern(
      program("{ name: string; avatar?: string }"),
      { space },
    );
    const resultB = b.getCell<Result>(space, CAUSE, compiledB.resultSchema);
    await b.runner.runSynced(resultB, compiledB, {});
    await b.settled();
    await settle(b, storageB, resultB);

    // One suggestion cell behind the shared slot, from both sides.
    expect((await slotLink(b, resultB)).id).toBe(linkA.id);
    await settle(a, storageA, resultA);
    expect((await slotLink(a, resultA)).id).toBe(linkA.id);
  });
});

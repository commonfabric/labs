/**
 * A member of the collection-naming exemplar board, read in a session that
 * never runs its board, shows the name the board's create allocated for it.
 *
 * Two client replicas share one loopback memory server, both with server
 * execution off, so each runs only what it reads. The first runs the board and
 * files two items through `addItem`, then goes away. The second opens the
 * second item by its own address, starts it, and reads its `title` and
 * `shortName`. It reads nothing of the board: not the item list, not the
 * namespace, and not the names table.
 *
 * The two-replica shape is what gives the assertion something to fail on. A
 * derived value is recomputed only where its owning piece runs and something
 * pulls it, and in one runtime a member reading its board's names table pulls
 * that table, so a pattern test in the single-runtime harness shows the name
 * whether the member stores it or looks it up. Here nothing in the second
 * replica runs the board, and nothing in the first pulled the table after the
 * creates, so a member that looked its name up in the table would read the
 * table as the first replica left it and show no name.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { NormalizedFullLink } from "@commonfabric/runner";
import { Runtime } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

const BOARD_PATH = fromFileUrl(
  new URL("../collection-naming/board.tsx", import.meta.url),
);
const ROOT_PATH = fromFileUrl(new URL("..", import.meta.url));
const signer = await Identity.fromPassphrase("collection naming member name");
const space = signer.did();

describe("a collection member's stored name", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let errors: string[];

  /** Opens a client replica against this test's memory server. */
  const open = () =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
      experimental: { lazyMaterialization: true, serverExecution: false },
      errorHandlers: [(error) => errors.push(String(error))],
    });

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    errors = [];
  });
  afterEach(async () => {
    await server.close();
  });

  /**
   * Runs the board in its own replica, files one item per title through
   * `addItem`, and returns the address of the item filed last, resolved to the
   * item's own result document. The replica is disposed before this returns.
   */
  const fileItems = async (
    titles: readonly string[],
  ): Promise<NormalizedFullLink> => {
    const runtime = open();
    try {
      const program = await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        { main: BOARD_PATH, root: ROOT_PATH },
      );
      const compiled = await runtime.patternManager.compilePattern(program, {
        space,
      });
      const argument = runtime.getCell<Record<string, unknown>>(
        space,
        "board-argument",
      );
      const result = runtime.getCell<Record<string, unknown>>(
        space,
        "board-result",
        compiled.resultSchema,
      );
      const seed = runtime.edit();
      argument.withTx(seed).set({ items: [], names: {} });
      expect((await seed.commit()).error).toBeUndefined();
      const setup = runtime.edit();
      runtime.run(setup, compiled, argument, result);
      runtime.prepareTxForCommit(setup);
      expect((await setup.commit()).error).toBeUndefined();

      await result.key("addItem").pull();
      for (const title of titles) {
        result.key("addItem").send({ title, agentName: "Sol" });
        await runtime.idle();
      }
      await runtime.storageManager.synced();

      // The stored argument, read raw: the list the creates appended to, and
      // nothing the board derives from it.
      const filed = argument.key("items").getRaw({ lastNode: "value" });
      expect(Array.isArray(filed) && filed.length).toBe(titles.length);
      const member = argument.key("items").key(titles.length - 1)
        .resolveAsCell().getAsNormalizedFullLink();
      // Settled before disposal, so no read this replica still has queued is
      // cut short when its client closes.
      await runtime.idle();
      await runtime.storageManager.synced();
      return member;
    } finally {
      await runtime.dispose();
    }
  };

  it("shows on a member read in a session that never runs its board", async () => {
    const member = await fileItems(["Glaze recipes", "Oven schedule"]);

    const runtime = open();
    try {
      const cell = runtime.getCellFromLink<Record<string, unknown>>(member);
      await cell.sync();
      expect(await runtime.start(cell)).toBe(true);
      await cell.key("shortName").pull();
      await runtime.storageManager.synced();
      await runtime.idle();
      await runtime.storageManager.synced();

      // The title is the control: it says the member loaded and ran here, so
      // a missing `shortName` would be the name's absence and not the read's.
      expect({
        title: cell.key("title").get(),
        shortName: cell.key("shortName").get(),
      }).toEqual({ title: "Oven schedule", shortName: "2" });
      expect(errors).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });
});

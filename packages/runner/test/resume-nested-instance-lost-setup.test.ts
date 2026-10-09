import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import {
  getLogger,
  getLoggerCountsBreakdown,
} from "@commonfabric/utils/logger";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { getMetaLink } from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase(
  "resume nested instance lost setup",
);
const space = signer.did();

// A nested sub-pattern holding a fetch node, the shape of a list element
// rendering a generated thumbnail. The fetch node keeps cells of its own,
// linked from its output and from nothing else; an empty URL fetches
// nothing, so the test touches no network.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { computed, fetchText, pattern } from 'commonfabric';",
        "",
        "type Fetched = { pending: boolean; result?: string; error?: unknown };",
        "",
        "export const art = pattern<{ prompt: string }, {",
        "  state: string;",
        "  fetched: Fetched;",
        "}>(({ prompt }) => {",
        "  const url = computed(() => (prompt.length > 0 ? '' : ''));",
        "  const fetched = fetchText({ url });",
        "  const state = computed(() => fetched.pending ? 'pending' : 'idle');",
        "  return { state, fetched };",
        "});",
        "",
        "export default pattern<{ prompt: string }, {",
        "  child: { state: string; fetched: Fetched };",
        "}>(({ prompt }) => {",
        "  const child = art({ prompt });",
        "  return { child };",
        "});",
      ].join("\n"),
    },
  ],
};

const RESULT_CAUSE = "resume nested instance lost setup parent";

function commitConflictCount(): number {
  const counts = getLoggerCountsBreakdown()["storage.v2"] ?? {};
  return (counts as Record<string, { total?: number }>)["commit-conflict"]
    ?.total ?? 0;
}

/**
 * A nested instance whose setup the store never received — its result
 * document holds no argument link — is set up fresh by its parent's start,
 * inline, and what its nodes read enters the parent's start commit. A
 * builtin's own cells, written by an earlier session in a transaction of
 * their own, are on the server all the same, so a start that reads them
 * cold stages a read at sequence zero and is refused. The resume pre-sync
 * plans such an instance against the inputs its parent binds it to and
 * loads what its nodes read before the start commits.
 */
describe("resume-nested-instance-lost-setup", () => {
  let server: MemoryV2Server.Server;
  let managerA: EmulatedStorageManager;
  let managerB: EmulatedStorageManager;

  beforeEach(() => {
    server = newSharedServer();
    managerA = EmulatedStorageManager.connectTo(server, { as: signer });
    managerB = EmulatedStorageManager.connectTo(server, { as: signer });
  });

  afterEach(async () => {
    await managerA?.close();
    await managerB?.close();
    await server?.close();
  });

  it("loads a setup-less nested instance's fetch cells before its parent's start commits, and commits without a conflict", async () => {
    // Two managers with their own replicas, loopback-connected to one
    // in-process server: the second session reads the first session's
    // documents cold, as a reload does.
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerA,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerB,
    });
    const held: Array<() => void> = [];
    const releaseHeld = () => {
      for (const release of held.splice(0)) release();
    };
    try {
      // Session 1 runs the piece, which sets up the nested instance and
      // writes the fetch node's cells.
      const tx1 = rt1.edit();
      const parent = await rt1.patternManager.compilePattern(PROGRAM, {
        space,
        tx: tx1,
      });
      const resultCell1 = rt1.getCell<Record<string, unknown>>(
        space,
        RESULT_CAUSE,
        undefined,
        tx1,
      );
      // deno-lint-ignore no-explicit-any
      const r1 = rt1.run(tx1, parent as any, { prompt: "soup" }, resultCell1);
      rt1.prepareTxForCommit(tx1);
      expect((await tx1.commit().settled).error).toBeUndefined();
      await r1.pull();
      await rt1.idle();
      await rt1.storageManager.synced();
      await rt1.idle();
      expect(r1.key("child").key("state").get()).toBe("idle");
      const child = r1.key("child");
      const fetched = child.key("fetched");
      // The fetch node's output document, which links its cells, and the
      // cells themselves: the documents the resumed instance's nodes read.
      const cellIds = new Set([
        fetched.resolveAsCell().getAsNormalizedFullLink().id,
        ...["pending", "result", "error"].map((name) =>
          fetched.key(name).resolveAsCell().getAsNormalizedFullLink().id
        ),
      ]);
      expect(cellIds.size).toBe(4);
      const nestedCell = child.resolveAsCell();
      const nestedLink = nestedCell.getAsNormalizedFullLink();
      const nestedArgument = getMetaLink(nestedCell, "argument");
      expect(nestedArgument).toBeDefined();

      // The store loses the nested instance's setup: its result and argument
      // documents are retracted, while the fetch node's cells, written in a
      // transaction of their own, remain.
      const retract = rt1.edit();
      for (const id of [nestedLink.id, nestedArgument!.id]) {
        retract.writeOrThrow(
          { space, id, type: "application/json", path: [] },
          undefined,
          { ...rawMetaWriteAuthorization, delete: true },
        );
      }
      expect((await retract.commit().settled).error).toBeUndefined();
      await rt1.patternManager.flushCompileCacheWrites();
      await rt1.storageManager.synced();

      // Session 2 resumes the piece on its own cold replica, with the loads
      // of the fetch node's documents held back.
      const sync = managerB.syncCell.bind(managerB);
      let holding = true;
      /** Resolves once the second session asks for a fetch document. */
      const firstHold = Promise.withResolvers<void>();
      using _sync = stub(managerB, "syncCell", (cell, options) => {
        if (!holding || !cellIds.has(cell.getAsNormalizedFullLink().id)) {
          return sync(cell, options);
        }
        const gate = Promise.withResolvers<void>();
        held.push(() => gate.resolve());
        firstHold.resolve();
        return gate.promise.then(() => sync(cell, options));
      });
      getLogger("storage.v2").resetCounts();
      const conflictsBefore = commitConflictCount();
      const parentCell2 = rt2.getCellFromLink(r1.getAsNormalizedFullLink());
      await parentCell2.sync();
      // The replica learns the retractions: the instance has no setup in the
      // store, as one whose setup never landed has none. A retracted load
      // settles without data, which the sync reports as a failure.
      for (const id of [nestedLink.id, nestedArgument!.id]) {
        await rt2.getCellFromLink({ space, id, path: [], scope: "space" })
          .sync().catch(() => undefined);
      }
      let started = false;
      const start = rt2.start(parentCell2).then((result) => {
        started = true;
        return result;
      });
      // A pre-sync that names the documents asks for them here and holds
      // the start; one that does not lets the start run to completion
      // instead, so the race ends either way.
      await Promise.race([firstHold.promise, start]);
      await rt2.scheduler.idle();
      expect(held.length).toBeGreaterThanOrEqual(1);
      expect(started).toBe(false);

      holding = false;
      releaseHeld();
      expect(await start).toBeTruthy();
      await rt2.idle();
      await rt2.storageManager.synced();
      await rt2.idle();
      const state2 = rt2.getCellFromLink(r1.getAsNormalizedFullLink())
        .key("child").key("state");
      await state2.pull();
      expect(state2.get()).toBe("idle");
      expect(
        commitConflictCount() - conflictsBefore,
        "a resumed parent must not commit-conflict over its nested instance's cells",
      ).toBe(0);
    } finally {
      releaseHeld();
      await rt1.dispose();
      await rt2.dispose();
    }
  });
});

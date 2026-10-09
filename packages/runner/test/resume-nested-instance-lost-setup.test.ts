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
import type { URI } from "../src/storage/interface.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase(
  "resume nested instance lost setup",
);
const space = signer.did();

// Two levels of nested sub-patterns, the inner one holding a fetch node:
// the shape of a list element rendering a generated thumbnail. The fetch
// node keeps cells of its own, linked from its output and from nothing else;
// an empty URL fetches nothing, so the test touches no network. The inner
// instance's input reaches a document two links away from the root's
// argument: the root's `item` links to one document, whose `ref` links to
// the one holding `name`, which only the inner instance reads.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { computed, fetchText, pattern } from 'commonfabric';",
        "",
        "type Named = { name: string };",
        "type Item = { ref: Named };",
        "type Fetched = { pending: boolean; result?: string; error?: unknown };",
        "type Art = { state: string; fetched: Fetched };",
        "",
        "export const art = pattern<{ prompt: string }, Art>(({ prompt }) => {",
        "  const url = computed(() => (prompt.length > 0 ? '' : ''));",
        "  const fetched = fetchText({ url });",
        "  const state = computed(() => fetched.pending ? 'pending' : 'idle');",
        "  return { state, fetched };",
        "});",
        "",
        "export const card = pattern<{ next: Named }, { state: string; art: Art }>(",
        "  ({ next }) => {",
        "    const a = art({ prompt: next.name });",
        "    const state = computed(() => a.state ?? '');",
        "    return { state, art: a };",
        "  },",
        ");",
        "",
        "export default pattern<{ item: Item }, {",
        "  child: { state: string; art: Art };",
        "}>(({ item }) => {",
        "  const child = card({ next: item.ref });",
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
 * plans such an instance against the inputs its parent binds it to, level
 * by level, so an instance below one with no setup is bound and planned as
 * well, and loads what their nodes read before the start commits.
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

  it("loads the fetch documents of a setup-less instance below another before the root's start commits, and commits without a conflict", async () => {
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
      // Session 1 runs the piece over two external documents, which sets up
      // both nested instances and writes the fetch node's cells.
      const tx1 = rt1.edit();
      const named = rt1.getCell<{ name: string }>(
        space,
        "external named doc",
        undefined,
        tx1,
      );
      named.set({ name: "soup" });
      const item = rt1.getCell<{ ref: { name: string } }>(
        space,
        "external item doc",
        undefined,
        tx1,
      );
      item.set({ ref: named });
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
      const r1 = rt1.run(tx1, parent as any, { item }, resultCell1);
      rt1.prepareTxForCommit(tx1);
      expect((await tx1.commit().settled).error).toBeUndefined();
      await r1.pull();
      await rt1.idle();
      await rt1.storageManager.synced();
      await rt1.idle();
      expect(r1.key("child").key("state").get()).toBe("idle");
      const child = r1.key("child");
      const grandchild = child.key("art");
      const fetched = grandchild.key("fetched");
      // What the inner instance's nodes read: the fetch node's output
      // document, which links its cells, the cells themselves, and the
      // document two links away that its input names.
      const cellIds = new Set([
        named.getAsNormalizedFullLink().id,
        fetched.resolveAsCell().getAsNormalizedFullLink().id,
        ...["pending", "result", "error"].map((name) =>
          fetched.key(name).resolveAsCell().getAsNormalizedFullLink().id
        ),
      ]);
      expect(cellIds.size).toBe(5);
      // The store loses both nested instances' setup: their result and
      // argument documents are retracted, while the fetch node's cells,
      // written in a transaction of their own, remain.
      const lost: URI[] = [];
      for (const nested of [child, grandchild]) {
        const cell = nested.resolveAsCell();
        const argument = getMetaLink(cell, "argument");
        expect(argument).toBeDefined();
        lost.push(cell.getAsNormalizedFullLink().id, argument!.id);
      }
      const retract = rt1.edit();
      for (const id of lost) {
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
      // The replica learns the retractions: the instances have no setup in
      // the store, as ones whose setup never landed have none. A retracted
      // load settles without data, which the sync reports as a failure.
      for (const id of lost) {
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
        "a resumed root must not commit-conflict over a nested instance's cells",
      ).toBe(0);
    } finally {
      releaseHeld();
      await rt1.dispose();
      await rt2.dispose();
    }
  });
});

/**
 * Own-write echo, end to end over a LIVE in-process server: a session's own
 * accepted patch-produced heads ride its covering frame as full post-apply
 * documents. The risk this suite pins is DOUBLE-APPLY — the echoed base swap
 * must not compose with a still-standing pending overlay — and the
 * notification contract: an echo fully shadowed by the write it confirms must
 * not re-notify the writer.
 *
 * Fan-out is gated manually and flushed explicitly, so which commits share a
 * fan-out batch — and therefore whether the dirty-origin survives as this
 * session's own — is deterministic, immune to any clock advancing a held
 * timer.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("own-write-echo-live");
const space = signer.did();

const stringListSchema = {
  type: "array",
  items: { type: "string" },
  // deno-lint-ignore no-explicit-any
} as any;

describe("own-write echo (live)", () => {
  let server: MemoryV2Server.Server;
  let storage1: EmulatedStorageManager;
  let storage2: EmulatedStorageManager;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    storage1 = EmulatedStorageManager.connectTo(server, { as: signer });
    storage2 = EmulatedStorageManager.connectTo(server, { as: signer });
  });

  afterEach(async () => {
    await storage1?.close();
    await storage2?.close();
    await server?.close();
  });

  it("applies its own patch echo exactly once and does not re-notify", async () => {
    // Pure echo: the only write in the batch is this session's own append, so
    // the dirty-origin survives and the covering frame carries the patch head
    // as a full post-apply document. The echoed base swap and the parked
    // promotion run in the same frame application; the list must come out
    // exactly once-appended, and the sink must not fire again for a frame that
    // confirms what the overlay already showed.

    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const tx0 = rt.edit();
      const seedCell = rt.getCell<string[]>(
        space,
        "echo-once-list",
        stringListSchema,
        tx0,
      );
      seedCell.set(["seed"]);
      await tx0.commit({ resolveAt: "verdict" });
      await server.flushSessions([space]);
      await clock.settle();
      await rt.storageManager.synced();

      const cell = rt.getCell<string[]>(
        space,
        "echo-once-list",
        stringListSchema,
      );
      await cell.sync();
      const seen: string[][] = [];
      const cancel = cell.sink((value) => {
        seen.push([...(value ?? [])]);
      });

      const txA = rt.edit();
      rt.getCell<string[]>(space, "echo-once-list", stringListSchema, txA)
        .push("A");
      await txA.commit({ resolveAt: "verdict" });
      // Let the optimistic notification land before baselining the count —
      // it rides a scheduler turn, not the commit await.
      await rt.idle();
      const notificationsAtVerdict = seen.length;
      expect(seen[seen.length - 1]).toEqual(["seed", "A"]);

      await server.flushSessions([space]);
      await clock.settle();
      await rt.storageManager.synced();
      await rt.idle();

      expect(cell.get()).toEqual(["seed", "A"]);
      // The echo confirmed exactly what the optimistic overlay already
      // showed; a second notification would be a spurious integrate.
      expect(seen.length).toBe(notificationsAtVerdict);
      expect(seen[seen.length - 1]).toEqual(["seed", "A"]);
      cancel();
    } finally {
      await rt.dispose();
    }
  });

  it("converges the writer to the merged list including elements it never observed", async () => {
    // Merged truth through frames: session 2 appends over a base that lacks
    // session 1's concurrent append. Both writes share the held batch, and the
    // delivered document is the server's merged head — session 2's own view
    // must converge to it, with its own layer applied exactly once.

    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, "echo-merge-list", stringListSchema, tx0)
        .set(["seed"]);
      await tx0.commit({ resolveAt: "verdict" });
      await server.flushSessions([space]);
      await clock.settle();
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(
        space,
        "echo-merge-list",
        stringListSchema,
      );
      await cell2.sync();
      await cell2.pull();
      expect(cell2.get()).toEqual(["seed"]);

      // Session 1 appends "A"; the held flush keeps it out of session 2's
      // replica, so session 2's append below is built over ["seed"].
      const txA = rt1.edit();
      rt1.getCell<string[]>(space, "echo-merge-list", stringListSchema, txA)
        .push("A");
      await txA.commit({ resolveAt: "verdict" });
      // The premise itself, asserted: the manual gate held "A" back. A
      // server whose option forwarding broke (any timed cadence) delivers
      // here and fails this, not just the merge assertions below.
      expect(cell2.get()).toEqual(["seed"]);

      const txB = rt2.edit();
      rt2.getCell<string[]>(space, "echo-merge-list", stringListSchema, txB)
        .push("B");
      await txB.commit({ resolveAt: "verdict" });

      await server.flushSessions([space]);
      await clock.settle();
      await rt1.storageManager.synced();
      await rt2.storageManager.synced();
      await rt1.idle();
      await rt2.idle();

      // Server-arrival order: A landed before B. Session 2 sees "A" — an
      // element it never pulled — and its own "B" exactly once.
      const cell1 = rt1.getCell<string[]>(
        space,
        "echo-merge-list",
        stringListSchema,
      );
      expect(cell1.get()).toEqual(["seed", "A", "B"]);
      expect(cell2.get()).toEqual(["seed", "A", "B"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});

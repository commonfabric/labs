/**
 * Own-write echo, end to end over a LIVE in-process server: a session's own
 * accepted patch-produced heads ride its covering frame as full post-apply
 * documents, except a head the engine applied over the very document the
 * patch named as its base, which the writer reproduces by replaying its own
 * patch. The risk this suite pins is DOUBLE-APPLY — the echoed base swap
 * must not compose with a still-standing pending overlay, and the promotion
 * that stands in for an elided echo must apply the patch once — and the
 * notification contract: a frame fully shadowed by the write it confirms must
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
import {
  type ClientCommit,
  PATCH_SEMANTICS_VERSION,
  type PatchOperation,
  type SessionEffectMessage,
} from "@commonfabric/memory/v2";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../src/cell.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import {
  newSharedServer,
  type ServerTap,
  tapServer,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("own-write-echo-live");
const space = signer.did();

const stringListSchema = {
  type: "array",
  items: { type: "string" },
  // deno-lint-ignore no-explicit-any
} as any;

/** Returns the documents sync frames carried for `id`, in the order sent. */
const deliveredDocs = (tap: ServerTap, id: string) =>
  tap.fromServer
    .filter((message) => message.type === "session/effect")
    .flatMap((message) => (message as SessionEffectMessage).effect.upserts)
    .filter((upsert) => upsert.id === id && upsert.doc !== undefined)
    .map((upsert) => upsert.doc);

/** Returns each patch of `id` a client committed, with its request's id. */
const sentPatches = (tap: ServerTap, id: string) =>
  tap.fromClients
    .filter((message) => message.type === "transact")
    .flatMap((message) => {
      const { requestId, commit } = message as {
        requestId: string;
        commit: ClientCommit;
      };
      return commit.operations
        .filter((operation): operation is PatchOperation =>
          operation.op === "patch" && operation.id === id
        )
        .map((operation) => ({ requestId, operation }));
    });

/** Returns the seq the verdict on the request `requestId` accepted at. */
const acceptedSeq = (tap: ServerTap, requestId: string) =>
  (tap.fromServer.find((message) =>
    message.type === "response" && message.requestId === requestId
  ) as { ok?: { seq?: number } } | undefined)?.ok?.seq;

/**
 * Returns `message` with `exactBase` taken off every revision of a transact
 * verdict, and any other message unchanged.
 */
const withoutExactBase = (
  message: Record<string, unknown>,
): Record<string, unknown> => {
  const ok = message.ok as
    | { revisions?: Record<string, unknown>[] }
    | undefined;
  if (message.type !== "response" || !Array.isArray(ok?.revisions)) {
    return message;
  }
  return {
    ...message,
    ok: {
      ...ok,
      revisions: ok.revisions.map(({ exactBase: _, ...revision }) => revision),
    },
  };
};

/**
 * Returns `message` with a `hello.ok` advertising `version` as the server's
 * patch replay version, and any other message unchanged.
 */
const advertisingReplayVersion =
  (version: number) =>
  (message: Record<string, unknown>): Record<string, unknown> =>
    message.type === "hello.ok"
      ? {
        ...message,
        flags: {
          ...(message.flags as Record<string, unknown>),
          patchReplayVersion: version,
        },
      }
      : message;

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

  /** Delivers held fan-out and waits for `rt` to take it in. */
  const settle = async (rt: Runtime) => {
    await server.flushSessions([space]);
    await clock.settle();
    await rt.storageManager.synced();
    await rt.idle();
  };

  /** Commits `write` to the list at `cause`, resolving at the verdict. */
  const commitList = async (
    rt: Runtime,
    cause: string,
    write: (cell: Cell<string[]>) => void,
  ) => {
    const tx = rt.edit();
    write(rt.getCell<string[]>(space, cause, stringListSchema, tx));
    await tx.commit({ resolveAt: "verdict" });
  };

  /**
   * Seeds the list at `cause` and then watches it, so the watch delivers the
   * seed and the replica holds it as the server stores it.
   */
  const seededThenWatched = async (rt: Runtime, cause: string) => {
    await commitList(rt, cause, (cell) => cell.set(["seed"]));
    await settle(rt);
    const cell = rt.getCell<string[]>(space, cause, stringListSchema);
    await cell.sync();
    return cell;
  };

  it("applies its own patch echo exactly once and does not re-notify", async () => {
    // Pure echo: the only write in the batch is this session's own append, so
    // the dirty-origin survives and the covering frame carries the patch head
    // as a full post-apply document. The document is watched before its seed
    // lands, so the seed's own set head is elided and promoted locally, and
    // the replica holds no delivered version for the append to name as the
    // base it replays over. The echoed base swap and the parked promotion run
    // in the same frame application; the list must come out exactly
    // once-appended, and the sink must not fire again for a frame that
    // confirms what the overlay already showed.

    const tap = tapServer(server);
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const cell = rt.getCell<string[]>(
        space,
        "echo-once-list",
        stringListSchema,
      );
      await cell.sync();
      await commitList(rt, "echo-once-list", (seed) => seed.set(["seed"]));
      await settle(rt);

      const seen: string[][] = [];
      const cancel = cell.sink((value) => {
        seen.push([...(value ?? [])]);
      });

      await commitList(rt, "echo-once-list", (list) => list.push("A"));
      // Let the optimistic notification land before baselining the count —
      // it rides a scheduler turn, not the commit await.
      await rt.idle();
      const notificationsAtVerdict = seen.length;
      expect(seen[seen.length - 1]).toEqual(["seed", "A"]);

      await settle(rt);

      const id = cell.getAsNormalizedFullLink().id;
      expect(cell.get()).toEqual(["seed", "A"]);
      expect(
        sentPatches(tap, id).map(({ operation }) => operation.replayBaseSeq),
      )
        .toEqual([undefined]);
      expect(deliveredDocs(tap, id)).toEqual([{ value: ["seed", "A"] }]);
      // The echo confirmed exactly what the optimistic overlay already
      // showed; a second notification would be a spurious integrate.
      expect(seen.length).toBe(notificationsAtVerdict);
      expect(seen[seen.length - 1]).toEqual(["seed", "A"]);
      cancel();
    } finally {
      await rt.dispose();
    }
  });

  it("applies its own patch once without an echo when the patch lands on the document the frame delivered", async () => {
    // The append names the delivered seed as the base its promotion replays
    // over. The engine applies it over that same head, so the covering frame
    // carries no copy, and the promotion alone must leave the list
    // once-appended without notifying again.

    const tap = tapServer(server);
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const cell = await seededThenWatched(rt, "exact-once-list");
      const seen: string[][] = [];
      const cancel = cell.sink((value) => {
        seen.push([...(value ?? [])]);
      });
      const id = cell.getAsNormalizedFullLink().id;
      const deliveredBeforeAppend = deliveredDocs(tap, id).length;

      await commitList(rt, "exact-once-list", (list) => list.push("A"));
      await rt.idle();
      const notificationsAtVerdict = seen.length;
      expect(seen[seen.length - 1]).toEqual(["seed", "A"]);

      await settle(rt);

      expect(cell.get()).toEqual(["seed", "A"]);
      const [append] = sentPatches(tap, id);
      expect(append.operation.replayBaseSeq).toBeGreaterThan(0);
      expect(deliveredDocs(tap, id).length).toBe(deliveredBeforeAppend);
      expect(seen.length).toBe(notificationsAtVerdict);
      cancel();
    } finally {
      await rt.dispose();
    }
  });

  it("names each own patch the server applied over its base as the next patch's base", async () => {
    // A promotion the server reported exact is the server's document at the
    // accepted seq, so a second append names that seq, and neither append's
    // head is sent back.

    const tap = tapServer(server);
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const cell = await seededThenWatched(rt, "exact-chain-list");
      const id = cell.getAsNormalizedFullLink().id;
      const deliveredBeforeAppends = deliveredDocs(tap, id).length;

      await commitList(rt, "exact-chain-list", (list) => list.push("A"));
      await settle(rt);
      await commitList(rt, "exact-chain-list", (list) => list.push("B"));
      await settle(rt);

      expect(cell.get()).toEqual(["seed", "A", "B"]);
      const [first, second] = sentPatches(tap, id);
      expect(first.operation.replayBaseSeq).toBeGreaterThan(0);
      expect(second.operation.replayBaseSeq).toBe(
        acceptedSeq(tap, first.requestId),
      );
      expect(deliveredDocs(tap, id).length).toBe(deliveredBeforeAppends);
    } finally {
      await rt.dispose();
    }
  });

  it("names no base over a promotion whose accept did not report the base it applied over", async () => {
    // The server still leaves the first append's head out of the frame, but
    // the verdict the replica reads says nothing about the base, so its
    // promotion is its own extrapolation, and the second append names no
    // base and is sent back whole.

    const tap = tapServer(server, withoutExactBase);
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const cell = await seededThenWatched(rt, "unreported-list");
      const id = cell.getAsNormalizedFullLink().id;
      const deliveredBeforeAppends = deliveredDocs(tap, id).length;

      await commitList(rt, "unreported-list", (list) => list.push("A"));
      await settle(rt);
      expect(deliveredDocs(tap, id).length).toBe(deliveredBeforeAppends);
      await commitList(rt, "unreported-list", (list) => list.push("B"));
      await settle(rt);

      expect(cell.get()).toEqual(["seed", "A", "B"]);
      const [first, second] = sentPatches(tap, id);
      expect(first.operation.replayBaseSeq).toBeGreaterThan(0);
      expect(second.operation.replayBaseSeq).toBeUndefined();
      expect(deliveredDocs(tap, id).slice(deliveredBeforeAppends)).toEqual([
        { value: ["seed", "A", "B"] },
      ]);
    } finally {
      await rt.dispose();
    }
  });

  it("names no base to a server applying patches at another semantics version", async () => {
    // The server would elide the head on the strength of the replay here
    // reproducing its document, which a replay at another version need not.

    const tap = tapServer(
      server,
      advertisingReplayVersion(PATCH_SEMANTICS_VERSION + 1),
    );
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const cell = await seededThenWatched(rt, "other-version-list");
      const id = cell.getAsNormalizedFullLink().id;

      await commitList(rt, "other-version-list", (list) => list.push("A"));
      await settle(rt);

      expect(cell.get()).toEqual(["seed", "A"]);
      expect(
        sentPatches(tap, id).map(({ operation }) => operation.replayBaseSeq),
      )
        .toEqual([undefined]);
      expect(deliveredDocs(tap, id).at(-1)).toEqual({ value: ["seed", "A"] });
    } finally {
      await rt.dispose();
    }
  });

  it("names no base for a patch built over a pending patch of its own", async () => {
    // The second append is built while the first is still pending, so it
    // replays over that pending layer rather than over a document the
    // server stores. Both land in one fan-out, whose frame carries the
    // second's head whole.

    const tap = tapServer(server);
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const cell = await seededThenWatched(rt, "pipelined-list");
      const id = cell.getAsNormalizedFullLink().id;

      await commitList(rt, "pipelined-list", (list) => list.push("A"));
      await commitList(rt, "pipelined-list", (list) => list.push("B"));
      await settle(rt);

      expect(cell.get()).toEqual(["seed", "A", "B"]);
      const [first, second] = sentPatches(tap, id);
      expect(first.operation.replayBaseSeq).toBeGreaterThan(0);
      expect(second.operation.replayBaseSeq).toBeUndefined();
      expect(deliveredDocs(tap, id).at(-1)).toEqual({
        value: ["seed", "A", "B"],
      });
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

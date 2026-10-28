/** Competing meeting bindings converge through the real Loom handler. */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import type { FabricValue } from "@commonfabric/data-model";
import { parseLinkOrThrow } from "@commonfabric/runner";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const PORTABLE = {
  scheme: "ical-uid-slot",
  item_key: "ff91746000eda3309fc01866704976f244a0f1832e418f51f1fab13968b8ccae",
  occurrence_key:
    "064701cd8b686840c32ef69ed46576a0c2726f140ccc6b31c8e64d27497f3aed",
};

/** Reads a reply cell from the session's synced storage. */
async function replyValue(session: MultiRuntimeSession, reply: FabricValue) {
  const link = parseLinkOrThrow(reply);
  await session.client().call("readAddress", { link: reply });
  return ((await session.rawRead({ id: link.id!, space: link.space! }))
    .value as {
      value?: unknown;
    })?.value;
}

describe("loom meeting across runtimes", () => {
  let harness: MultiRuntimeHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  it("adds portable identity to a matching legacy binding and preserves its metadata", async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: join(import.meta.dirname!, "..", "loom", "main.tsx"),
      rootPath: join(import.meta.dirname!, ".."),
      input: { meeting: { key: KEY, future: "keep" } },
      sessions: ["alice", "bob"],
      watchPaths: [["meeting"]],
      aclMode: "enforce",
    });
    const alice = harness.session("alice");
    const bob = harness.session("bob");
    const reply = await alice.createCell("portable meeting reply", {});
    await harness.settle();
    await alice.send("bindMeeting", {
      key: KEY,
      portableIdentity: PORTABLE,
      reply,
    });
    await harness.settle();
    const expected = { key: KEY, future: "keep", portableIdentity: PORTABLE };
    expect(await alice.read(["meeting", "portableIdentity"])).toEqual(PORTABLE);
    expect(await bob.read(["meeting", "portableIdentity"])).toEqual(PORTABLE);
    expect(await alice.readRaw(["meeting"])).toEqual(expected);
    expect(await bob.readRaw(["meeting"])).toEqual(expected);
    expect(await replyValue(alice, reply))
      .toEqual({ status: "already-bound", key: KEY });

    const later = await harness.addSession({
      label: "bob-later",
      identity: bob.identity,
    });
    await harness.settle();
    expect(await later.read(["meeting", "portableIdentity"])).toEqual(PORTABLE);
    expect(await later.readRaw(["meeting"])).toEqual(expected);

    await bob.send("bindMeeting", { key: KEY });
    await alice.send("bindMeeting", {
      key: OTHER,
      portableIdentity: PORTABLE,
      reply,
    });
    await harness.settle();
    expect(await alice.readRaw(["meeting"])).toEqual(expected);
    expect(await bob.readRaw(["meeting"])).toEqual(expected);
    expect(await replyValue(alice, reply))
      .toEqual({ status: "conflict", key: KEY });
  });

  it("returns invalid-key for malformed portable evidence without binding a meeting", async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: join(import.meta.dirname!, "..", "loom", "main.tsx"),
      rootPath: join(import.meta.dirname!, ".."),
      sessions: ["alice"],
      watchPaths: [["meeting"]],
      aclMode: "enforce",
    });
    const alice = harness.session("alice");
    const reply = await alice.createCell("invalid portable identity reply", {});
    const invalid: FabricValue[] = [
      null,
      true,
      "ical-uid-slot",
      [],
      {},
      { ...PORTABLE, scheme: "future-scheme" },
      { ...PORTABLE, item_key: PORTABLE.item_key.toUpperCase() },
      { ...PORTABLE, occurrence_key: `${PORTABLE.occurrence_key}\n` },
      { scheme: "ical-uid-slot", item_key: PORTABLE.item_key },
      { ...PORTABLE, occurrence_key: 123 },
    ];
    await harness.settle();
    for (const portableIdentity of invalid) {
      await alice.send("bindMeeting", { key: KEY, portableIdentity, reply });
      await harness.settle();
      expect(await replyValue(alice, reply))
        .toEqual({ status: "invalid-key" });
      expect(await alice.readRaw(["meeting"])).toEqual({});
    }
  });

  it("preserves unrecognized stored portable evidence while legacy replays still work", async () => {
    const meeting = {
      key: KEY,
      portableIdentity: {
        ...PORTABLE,
        scheme: "future-scheme",
        future: "keep",
      },
      future: "keep",
    };
    harness = await MultiRuntimeHarness.create({
      programPath: join(import.meta.dirname!, "..", "loom", "main.tsx"),
      rootPath: join(import.meta.dirname!, ".."),
      input: { meeting },
      sessions: ["alice"],
      watchPaths: [["meeting"]],
      aclMode: "enforce",
    });
    const alice = harness.session("alice");
    const reply = await alice.createCell("stored portable evidence reply", {});
    await harness.settle();
    await alice.send("bindMeeting", {
      key: KEY,
      portableIdentity: PORTABLE,
      reply,
    });
    await harness.settle();
    expect(await replyValue(alice, reply)).toEqual({ status: "invalid-state" });
    expect(await alice.readRaw(["meeting"])).toEqual(meeting);
    await alice.send("bindMeeting", { key: KEY, reply });
    await harness.settle();
    expect(await replyValue(alice, reply))
      .toEqual({ status: "already-bound", key: KEY });
    expect(await alice.readRaw(["meeting"])).toEqual(meeting);
  });

  it("retains one complete portable identity when two sessions enrich the same binding", async () => {
    const otherIdentity = {
      scheme: "ical-uid-slot",
      item_key: OTHER,
      occurrence_key: KEY,
    };
    harness = await MultiRuntimeHarness.create({
      programPath: join(import.meta.dirname!, "..", "loom", "main.tsx"),
      rootPath: join(import.meta.dirname!, ".."),
      input: { meeting: { key: KEY, future: "keep" } },
      sessions: ["alice", "bob"],
      watchPaths: [["meeting"]],
      aclMode: "enforce",
    });
    const alice = harness.session("alice");
    const bob = harness.session("bob");
    const aliceReply = await alice.createCell("alice portable reply", {});
    const bobReply = await bob.createCell("bob portable reply", {});
    await harness.settle();
    await Promise.all([
      alice.send(
        "bindMeeting",
        {
          key: KEY,
          portableIdentity: PORTABLE,
          reply: aliceReply,
        },
        undefined,
        { idle: false },
      ),
      bob.send(
        "bindMeeting",
        {
          key: KEY,
          portableIdentity: otherIdentity,
          reply: bobReply,
        },
        undefined,
        { idle: false },
      ),
    ]);
    await harness.settle();
    const winner = await alice.read(["meeting", "portableIdentity"]);
    expect([PORTABLE, otherIdentity]).toContainEqual(winner);
    expect(await bob.read(["meeting", "portableIdentity"])).toEqual(winner);
    const aliceWon = winner !== null && typeof winner === "object" &&
      "item_key" in winner && winner.item_key === PORTABLE.item_key;
    expect(await replyValue(alice, aliceReply))
      .toEqual({ status: aliceWon ? "already-bound" : "conflict", key: KEY });
    expect(await replyValue(bob, bobReply))
      .toEqual({ status: aliceWon ? "conflict" : "already-bound", key: KEY });
    expect(await alice.read(["meeting", "key"])).toBe(KEY);
    expect(await alice.readRaw(["meeting", "future"])).toBe("keep");
    await alice.send("bindMeeting", {
      key: KEY,
      portableIdentity: PORTABLE,
      reply: aliceReply,
    });
    await bob.send("bindMeeting", {
      key: KEY,
      portableIdentity: otherIdentity,
      reply: bobReply,
    });
    await harness.settle();
    expect(await alice.read(["meeting", "portableIdentity"])).toEqual(winner);
    expect(await bob.read(["meeting", "portableIdentity"])).toEqual(winner);
  });

  it("keeps the first admitted key when two sessions bind different meetings", async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: join(import.meta.dirname!, "..", "loom", "main.tsx"),
      rootPath: join(import.meta.dirname!, ".."),
      sessions: ["alice", "bob"],
      watchPaths: [["meeting"]],
      aclMode: "enforce",
    });
    const alice = harness.session("alice");
    const bob = harness.session("bob");
    const aliceReply = await alice.createCell("alice meeting reply", {});
    const bobReply = await bob.createCell("bob meeting reply", {});
    await harness.settle();
    expect(await alice.read(["meeting"])).toEqual({});
    expect(await bob.read(["meeting"])).toEqual({});

    await Promise.all([
      alice.send("bindMeeting", { key: KEY, reply: aliceReply }, undefined, {
        idle: false,
      }),
      bob.send("bindMeeting", { key: OTHER, reply: bobReply }, undefined, {
        idle: false,
      }),
    ]);
    await harness.settle();

    const winner = await alice.read(["meeting", "key"]);
    expect([KEY, OTHER]).toContain(winner);
    expect(await bob.read(["meeting", "key"])).toBe(winner);
    expect(await replyValue(alice, aliceReply))
      .toEqual({ status: winner === KEY ? "bound" : "conflict", key: winner });
    expect(await replyValue(bob, bobReply))
      .toEqual({
        status: winner === OTHER ? "bound" : "conflict",
        key: winner,
      });

    await alice.send("bindMeeting", { key: winner, reply: aliceReply });
    await bob.send("bindMeeting", { key: winner === KEY ? OTHER : KEY });
    await harness.settle();
    expect(await replyValue(alice, aliceReply))
      .toEqual({ status: "already-bound", key: winner });
    expect(await alice.read(["meeting", "key"])).toBe(winner);
    expect(await bob.read(["meeting", "key"])).toBe(winner);
  });
});

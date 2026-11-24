import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  createRandomImportedClaimedMessages,
  type ParticipantClaim,
  type PlainChatMessage,
} from "./logic.ts";

/** A random source that answers `values` in order. */
const scripted = (...values: number[]) => () => {
  const next = values.shift();
  if (next === undefined) throw new Error("the script ran out of values");
  return next;
};

const sent = (body: string, timestamp: number): PlainChatMessage<string> => ({
  origin: "sent",
  authorName: "alice",
  authorProfile: "alice-profile",
  body,
  timestamp,
});

const alice: ParticipantClaim<string> = {
  name: "alice",
  accentColor: "#2563eb",
  profile: "alice-profile",
};
const bob: ParticipantClaim<string> = { name: "bob", accentColor: "#059669" };

describe("createRandomImportedClaimedMessages()", () => {
  it("returns no messages when there are no participants", () => {
    expect(
      createRandomImportedClaimedMessages([sent("hi", 1_000)], [], scripted()),
    ).toEqual([]);
  });

  it("returns no messages when the thread is empty", () => {
    expect(createRandomImportedClaimedMessages([], [alice], scripted()))
      .toEqual([]);
  });

  it("imports one message per existing message, up to three", () => {
    const thread = [1_000, 2_000, 3_000, 4_000].map((timestamp) =>
      sent("hi", timestamp)
    );
    const imported = createRandomImportedClaimedMessages(
      thread.slice(0, 1),
      [alice],
      scripted(0, 0, 0.9),
    );
    expect(imported).toHaveLength(1);
    expect(
      createRandomImportedClaimedMessages(
        thread,
        [alice],
        scripted(0, 0, 0.9, 0, 0, 0.9, 0, 0, 0.9),
      ),
    ).toHaveLength(3);
  });

  it("claims the chosen participant's name, and its profile when it has one", () => {
    const [fromAlice, fromBob] = createRandomImportedClaimedMessages(
      [sent("one", 1_000), sent("two", 2_000)],
      [alice, bob],
      scripted(0, 0, 0.9, 0.5, 0.2, 0.9),
    );
    expect(fromAlice).toMatchObject({
      origin: "imported",
      authorName: "alice",
      authorProfile: "alice-profile",
      body: "Jumping in late here.",
    });
    expect(fromBob).toMatchObject({
      origin: "imported",
      authorName: "bob",
      body: "I think we already covered this above.",
    });
    expect(fromBob).not.toHaveProperty("authorProfile");
  });

  describe("timestamps", () => {
    // The third value of each import picks a slot among the thread's
    // messages: its whole part is the slot and its fraction the offset.

    it("places a message before the first one, offset by the fraction", () => {
      const [message] = createRandomImportedClaimedMessages(
        [sent("one", 1_000)],
        [alice],
        scripted(0, 0, 0.25),
      );
      expect(message?.timestamp).toBe(1_000 - 1 - 0.5);
    });

    it("places a message after the last one, offset by the fraction", () => {
      const [message] = createRandomImportedClaimedMessages(
        [sent("one", 1_000)],
        [alice],
        scripted(0, 0, 0.75),
      );
      expect(message?.timestamp).toBe(1_000 + 1 + 0.5);
    });

    it("places a message between two, at the fraction of the gap", () => {
      const [message] = createRandomImportedClaimedMessages(
        [sent("one", 1_000), sent("two", 2_000)],
        [alice],
        scripted(0, 0, 0.5, 0, 0, 0.9, 0, 0, 0.9),
      );
      expect(message?.timestamp).toBe(1_500);
    });

    it("places a message at the middle of the gap when the slot is whole", () => {
      const [message] = createRandomImportedClaimedMessages(
        [sent("one", 1_000), sent("two", 2_000)],
        [alice],
        scripted(0, 0, 1 / 3, 0, 0, 0.9),
      );
      expect(message?.timestamp).toBe(1_500);
    });

    it("places a message within a millisecond of two that share a timestamp", () => {
      const [message] = createRandomImportedClaimedMessages(
        [sent("one", 1_000), sent("two", 1_000)],
        [alice],
        scripted(0, 0, 0.5, 0.5, 0, 0, 0.9),
      );
      expect(message?.timestamp).toBe(1_000 + 0.5 * 0.001);
    });
  });
});

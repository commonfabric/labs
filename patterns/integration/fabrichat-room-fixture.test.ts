import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  authorOf,
  messageBody,
  messageHeading,
  reactedMessages,
  threadRoots,
  writerCount,
} from "./fabrichat-room-fixture.ts";

describe("fabrichat-room-fixture", () => {
  // The rooms these describe are built by the four-hourly benchmark workflow,
  // so a break here would otherwise surface a scheduled run later, on a chart
  // rather than in a test.

  describe("messageHeading", () => {
    it("returns the one-based message number between `Message ` and a period", () => {
      // The benchmarks wait for this exact string in the room, so the format
      // is part of the contract rather than a presentation choice.
      expect(messageHeading(6)).toBe("Message 7.");
    });

    it("returns a heading no other message of a 300-message room holds", () => {
      // A wait for the last message's heading must not be satisfied by any
      // other message on the page.
      const bodies = Array.from(
        { length: 300 },
        (_, index) => messageBody(index),
      );
      for (let index = 0; index < bodies.length; index++) {
        const heading = messageHeading(index);
        expect(
          bodies.filter((body) => body.includes(heading)),
        ).toEqual([bodies[index]]);
      }
    });
  });

  describe("authorOf", () => {
    it("returns each member a block of consecutive messages", () => {
      const authors = Array.from(
        { length: 30 },
        (_, index) => authorOf(index, 30, 12),
      );
      expect(authors).toEqual([...authors].sort((a, b) => a - b));
      expect(new Set(authors).size).toBe(12);
    });

    it("returns only members of the room", () => {
      for (const [messages, members] of [[10, 12], [30, 12], [300, 12]]) {
        for (let index = 0; index < messages; index++) {
          expect(authorOf(index, messages, members)).toBeLessThan(members);
        }
      }
    });
  });

  describe("writerCount", () => {
    it("returns every member when there are at least as many messages", () => {
      expect(writerCount(12, 12)).toBe(12);
      expect(writerCount(30, 12)).toBe(12);
      expect(writerCount(300, 12)).toBe(12);
    });

    it("returns one writer per message when there are fewer messages", () => {
      expect(writerCount(10, 12)).toBe(10);
    });
  });

  describe("reactedMessages", () => {
    it("returns every third message, the first included", () => {
      expect(reactedMessages(10, 12, 3)).toEqual([0, 3, 6, 9]);
    });

    it("returns none in a room of one member", () => {
      // The one member is the viewer, whose reaction a benchmark adds.
      expect(reactedMessages(30, 1, 3)).toEqual([]);
    });

    it("returns at least seven messages in the fixed-size room", () => {
      // `fabrichat-room.bench.ts` reacts to a different one on each of its
      // seven invocations of `react`.
      expect(reactedMessages(30, 12, 3).length).toBeGreaterThanOrEqual(7);
    });
  });

  describe("threadRoots", () => {
    it("returns the latest messages, newest first", () => {
      expect(threadRoots(30, 2)).toEqual([29, 28]);
    });

    it("returns no more roots than there are messages", () => {
      expect(threadRoots(1, 3)).toEqual([0]);
    });

    it("returns only roots among the room's latest hundred messages", () => {
      // The seed addresses a thread's root through the room's `latest`, which
      // holds the last hundred of its main conversation.
      const roots = threadRoots(300, 150);
      expect(roots).toHaveLength(100);
      expect(roots.at(-1)).toBe(200);
    });
  });
});

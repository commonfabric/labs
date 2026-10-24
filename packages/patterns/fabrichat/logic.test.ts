import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  isInMain,
  isSingleEmoji,
  THREAD_EXCERPT_LENGTH,
  threadExcerpt,
  type ViewItem,
  viewPlaces,
} from "./logic.ts";

describe("logic", () => {
  describe("isSingleEmoji()", () => {
    it("returns `true` for one emoji", () => {
      expect(isSingleEmoji("😺")).toBe(true);
    });

    it("returns `true` for an emoji with a skin-tone modifier", () => {
      expect(isSingleEmoji("👍🏽")).toBe(true);
    });

    it("returns `true` for a ZWJ sequence", () => {
      expect(isSingleEmoji("👩‍💻")).toBe(true);
    });

    it("returns `false` for two emoji", () => {
      expect(isSingleEmoji("😺😺")).toBe(false);
    });

    it("returns `false` for text", () => {
      expect(isSingleEmoji("cat")).toBe(false);
    });

    it("returns `false` for the empty string", () => {
      expect(isSingleEmoji("")).toBe(false);
    });

    it("returns `false` for a non-string", () => {
      expect(isSingleEmoji(42)).toBe(false);
    });
  });

  describe("views", () => {
    // `a` roots a thread holding `b`, `c` and `e`; `c` also shows in the main
    // conversation; `d` quotes `a` in the main conversation; `e` quotes `b`
    // in `a`'s thread.
    const items: ViewItem[] = [
      { key: "c", sentAt: 30n, replyTo: { thread: "a", shownIn: "both" } },
      { key: "a", sentAt: 10n },
      { key: "b", sentAt: 20n, replyTo: { thread: "a", shownIn: "thread" } },
      { key: "d", sentAt: 40n, replyTo: { quotes: "a", shownIn: "main" } },
      {
        key: "e",
        sentAt: 50n,
        replyTo: { thread: "a", quotes: "b", shownIn: "thread" },
      },
    ];

    it("returns `false` from `isInMain()` for a thread-only reply", () => {
      expect(isInMain(items[2])).toBe(false);
    });

    it("counts each thread's replies", () => {
      const places = viewPlaces(items);
      expect(items.map((item) => [item.key, places[item.key].replies]))
        .toEqual([["c", 0], ["a", 3], ["b", 0], ["d", 0], ["e", 0]]);
    });

    it("gives each thread's newest reply time, whatever the list's order", () => {
      const places = viewPlaces(items);
      expect(items.map((item) => [item.key, places[item.key].latestReplyAt]))
        .toEqual([
          ["c", undefined],
          ["a", 50n],
          ["b", undefined],
          ["d", undefined],
          ["e", undefined],
        ]);
    });

    it("places each message in the main conversation, in a thread, or both", () => {
      expect(viewPlaces(items)).toEqual({
        a: { inMain: true, replies: 3, latestReplyAt: 50n },
        b: { inMain: false, replies: 0, thread: "a" },
        c: { inMain: true, replies: 0, thread: "a" },
        d: { inMain: true, replies: 0 },
        e: { inMain: false, replies: 0, thread: "a" },
      });
    });
  });

  describe("threadExcerpt()", () => {
    it("returns text within the length as it stands", () => {
      const text = "x".repeat(THREAD_EXCERPT_LENGTH);
      expect(threadExcerpt(text)).toBe(text);
    });

    it("returns each run of whitespace as one space, and none at either end", () => {
      expect(threadExcerpt("  Lunch\n\non   Friday?\t")).toBe(
        "Lunch on Friday?",
      );
    });

    it("returns longer text cut after its last whole word, with an ellipsis", () => {
      const text =
        "Where should we go for the team lunch on Friday, and who is booking it?";
      const excerpt = threadExcerpt(text);
      expect(excerpt).toBe("Where should we go for the team lunch on Friday,…");
      expect(Array.from(excerpt).length).toBeLessThanOrEqual(
        THREAD_EXCERPT_LENGTH,
      );
    });

    it("returns longer text cut before a word the cut falls within", () => {
      // The cut falls within "afternoon", which is left out whole.
      const text =
        "Where should we go for the team lunch on Friday afternoon, and who books?";
      expect(threadExcerpt(text)).toBe(
        "Where should we go for the team lunch on Friday…",
      );
    });

    it("returns a word that ends right at the cut whole", () => {
      // 49 characters of whole words, then a space and more.
      const words = "aaaa ".repeat(9) + "bbbb";
      expect(Array.from(words).length).toBe(THREAD_EXCERPT_LENGTH - 1);
      expect(threadExcerpt(`${words} cccc`)).toBe(`${words}…`);
    });

    it("returns a first word longer than the length cut within it", () => {
      const excerpt = threadExcerpt("y".repeat(80));
      expect(excerpt).toBe(`${"y".repeat(THREAD_EXCERPT_LENGTH - 1)}…`);
    });

    it("returns no code point split by the cut", () => {
      const excerpt = threadExcerpt("😺".repeat(60));
      expect(excerpt).toBe(`${"😺".repeat(THREAD_EXCERPT_LENGTH - 1)}…`);
    });
  });
});

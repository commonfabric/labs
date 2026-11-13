import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  isInMain,
  isSingleEmoji,
  sameNameMarks,
  THREAD_EXCERPT_LENGTH,
  threadExcerpt,
  type ViewItem,
  viewPlaces,
  windowCount,
  windowSlice,
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

  describe("windowCount()", () => {
    it("returns the count requested, rounded down, up to the most", () => {
      expect(windowCount(3, 10)).toBe(3);
      expect(windowCount(3.7, 10)).toBe(3);
      expect(windowCount(30, 10)).toBe(10);
    });

    it("returns 0 for a count that is negative, not finite, or not a number", () => {
      for (const requested of [-1, Number.NaN, Infinity, "3", undefined]) {
        expect(windowCount(requested, 10)).toBe(0);
      }
    });
  });

  describe("windowSlice()", () => {
    it("returns the newest messages of a view for a window at its end", () => {
      expect(windowSlice(5, { before: "end" }, 2)).toEqual({
        start: 3,
        end: 5,
        hasOlder: true,
        hasNewer: false,
      });
    });

    it("returns the oldest messages of a view for a window at its start", () => {
      expect(windowSlice(5, { after: "start" }, 2)).toEqual({
        start: 0,
        end: 2,
        hasOlder: false,
        hasNewer: true,
      });
    });

    it("returns the whole view, with nothing beyond it, for a window as large as it or larger", () => {
      for (const anchor of [{ before: "end" }, { after: "start" }] as const) {
        expect(windowSlice(3, anchor, 7)).toEqual({
          start: 0,
          end: 3,
          hasOlder: false,
          hasNewer: false,
        });
      }
    });

    it("returns an empty window over an empty view", () => {
      expect(windowSlice(0, { before: "end" }, 4)).toEqual({
        start: 0,
        end: 0,
        hasOlder: false,
        hasNewer: false,
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

  describe("sameNameMarks()", () => {
    const ada = "did:key:z6MkAdaLovelaceAAAAAA";
    const otherAda = "did:key:z6MkAdaLovelaceBBBBBB";
    const grace = "did:key:z6MkGraceHopperCCCCCC";

    it("returns the empty string for each person whose name no one else shows", () => {
      expect(sameNameMarks([
        { principal: ada, name: "Ada Lovelace" },
        { principal: grace, name: "Grace Hopper" },
      ])).toStrictEqual({ [ada]: "", [grace]: "" });
    });

    it("returns the end of each principal for people showing the same name", () => {
      expect(sameNameMarks([
        { principal: ada, name: "Ada Lovelace" },
        { principal: otherAda, name: "Ada Lovelace" },
        { principal: grace, name: "Grace Hopper" },
      ])).toStrictEqual({
        [ada]: "…AAAAAA",
        [otherAda]: "…BBBBBB",
        [grace]: "",
      });
    });

    it("returns marks for names that differ only in case and surrounding space", () => {
      expect(sameNameMarks([
        { principal: ada, name: "Ada Lovelace" },
        { principal: otherAda, name: "  ada lovelace " },
      ])).toStrictEqual({ [ada]: "…AAAAAA", [otherAda]: "…BBBBBB" });
    });

    it("returns the empty string for people showing no name", () => {
      expect(sameNameMarks([
        { principal: ada, name: undefined },
        { principal: otherAda, name: "  " },
      ])).toStrictEqual({ [ada]: "", [otherAda]: "" });
    });
  });
});

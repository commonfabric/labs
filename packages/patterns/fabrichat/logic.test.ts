import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { isInMain, isSingleEmoji, type ViewItem, viewPlaces } from "./logic.ts";

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
    // `a` roots a thread holding `b` and `c`; `c` also shows in the main
    // conversation; `d` quotes `a` in the main conversation; `e` replies to
    // `b`, which is in `a`'s thread, so it joins that thread.
    const items: ViewItem[] = [
      { key: "c", sentAt: 30n, replyTo: { key: "a", shownIn: "both" } },
      { key: "a", sentAt: 10n },
      { key: "b", sentAt: 20n, replyTo: { key: "a", shownIn: "thread" } },
      { key: "d", sentAt: 40n, replyTo: { key: "a", shownIn: "main" } },
      { key: "e", sentAt: 50n, replyTo: { key: "b", shownIn: "thread" } },
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

    it("finds the root of a very long reply chain", () => {
      const chain: ViewItem[] = [
        { key: "0", sentAt: 0n },
        ...Array.from(
          { length: 20_000 },
          (_, index): ViewItem => ({
            key: String(index + 1),
            sentAt: BigInt(index + 1),
            replyTo: { key: String(index), shownIn: "thread" },
          }),
        ),
      ];
      const places = viewPlaces(chain);
      expect(places["20000"].thread).toBe("0");
      expect(places["0"].replies).toBe(20_000);
    });

    it("stops at a reply chain that loops", () => {
      const loop: ViewItem[] = [
        { key: "x", sentAt: 1n, replyTo: { key: "y", shownIn: "thread" } },
        { key: "y", sentAt: 2n, replyTo: { key: "x", shownIn: "thread" } },
      ];
      const places = viewPlaces(loop);
      expect(places.x.thread).toBeDefined();
      expect(places.x.replies + places.y.replies).toBeGreaterThan(0);
    });
  });
});

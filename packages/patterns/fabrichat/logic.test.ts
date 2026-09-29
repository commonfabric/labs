import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  chooseRecordedTime,
  isInMain,
  isSingleEmoji,
  mainView,
  threadReplyCounts,
  threadRootOf,
  threadView,
  type TimeBounds,
  type ViewItem,
  windowSlice,
} from "./logic.ts";

const BOUNDS: TimeBounds = {
  maxAgeNsec: 600n,
  maxLeadNsec: 10n,
  tickNsec: 100n,
};

const NOTHING_USED = () => false;

describe("logic", () => {
  describe("chooseRecordedTime()", () => {
    it("records a proposal before the clock as proposed", () => {
      expect(
        chooseRecordedTime(
          { proposed: 900n, clock: 1000n, isUsed: NOTHING_USED },
          BOUNDS,
        ),
      ).toBe(900n);
    });

    it("records a proposal after the clock at the clock", () => {
      expect(
        chooseRecordedTime(
          { proposed: 1005n, clock: 1000n, isUsed: NOTHING_USED },
          BOUNDS,
        ),
      ).toBe(1000n);
    });

    it("records the clock when nothing is proposed", () => {
      expect(
        chooseRecordedTime({ clock: 1000n, isUsed: NOTHING_USED }, BOUNDS),
      ).toBe(1000n);
    });

    it("returns `undefined` for a proposal older than the window", () => {
      expect(
        chooseRecordedTime(
          { proposed: 399n, clock: 1000n, isUsed: NOTHING_USED },
          BOUNDS,
        ),
      ).toBeUndefined();
    });

    it("returns `undefined` for a proposal further ahead than the lead", () => {
      expect(
        chooseRecordedTime(
          { proposed: 1011n, clock: 1000n, isUsed: NOTHING_USED },
          BOUNDS,
        ),
      ).toBeUndefined();
    });

    it("returns the smallest later unused time for a used one", () => {
      const used = new Set([900n, 901n, 903n]);
      expect(
        chooseRecordedTime(
          { proposed: 900n, clock: 1000n, isUsed: (t) => used.has(t) },
          BOUNDS,
        ),
      ).toBe(902n);
    });

    it("raises a reply's time past its target's", () => {
      expect(
        chooseRecordedTime(
          { proposed: 900n, clock: 1000n, after: 950n, isUsed: NOTHING_USED },
          BOUNDS,
        ),
      ).toBe(951n);
    });

    it("raises a reply's time past a target recorded ahead of the clock", () => {
      expect(
        chooseRecordedTime(
          { clock: 1000n, after: 1250n, isUsed: NOTHING_USED },
          BOUNDS,
        ),
      ).toBe(1251n);
    });

    it("returns `undefined` when the clock's tick has no time left", () => {
      expect(
        chooseRecordedTime(
          { proposed: 1098n, clock: 1000n, isUsed: (t) => t < 1100n },
          { ...BOUNDS, maxLeadNsec: 200n },
        ),
      ).toBeUndefined();
    });

    it("bumps a time within the clock's tick", () => {
      expect(
        chooseRecordedTime(
          { clock: 1000n, isUsed: (t) => t < 1099n },
          BOUNDS,
        ),
      ).toBe(1099n);
    });
  });

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

    it("lists the main conversation oldest first", () => {
      expect(mainView(items).map((item) => item.key)).toEqual(["a", "c", "d"]);
    });

    it("lists a thread with its root, oldest first, flattening replies", () => {
      expect(threadView(items, "a")?.map((item) => item.key)).toEqual([
        "a",
        "b",
        "c",
        "e",
      ]);
    });

    it("returns `undefined` for a thread rooted at a message in a thread", () => {
      expect(threadView(items, "b")).toBeUndefined();
    });

    it("returns `undefined` for a thread rooted at no message", () => {
      expect(threadView(items, "z")).toBeUndefined();
    });

    it("counts each thread's replies", () => {
      expect([...threadReplyCounts(items)]).toEqual([["a", 3]]);
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
      const byKey = new Map(chain.map((item) => [item.key, item]));
      expect(threadRootOf(chain[20_000], byKey)).toBe("0");
      expect(threadReplyCounts(chain).get("0")).toBe(20_000);
    });

    it("stops at a reply chain that loops", () => {
      const loop: ViewItem[] = [
        { key: "x", sentAt: 1n, replyTo: { key: "y", shownIn: "thread" } },
        { key: "y", sentAt: 2n, replyTo: { key: "x", shownIn: "thread" } },
      ];
      const byKey = new Map(loop.map((item) => [item.key, item]));
      expect(threadRootOf(loop[0], byKey)).toBeDefined();
      expect(threadReplyCounts(loop).size).toBeGreaterThan(0);
    });
  });

  describe("windowSlice()", () => {
    const view: ViewItem[] = [10n, 20n, 30n, 40n, 50n].map((sentAt) => ({
      key: String(sentAt),
      sentAt,
    }));

    it("places a window at the newest end", () => {
      expect(windowSlice(view, { before: "end" }, 2)).toEqual({
        start: 3,
        end: 5,
        hasOlder: true,
        hasNewer: false,
      });
    });

    it("places a window before a time", () => {
      expect(windowSlice(view, { before: 40n }, 2)).toEqual({
        start: 1,
        end: 3,
        hasOlder: true,
        hasNewer: true,
      });
    });

    it("places a window at the earliest end", () => {
      expect(windowSlice(view, { after: "start" }, 2)).toEqual({
        start: 0,
        end: 2,
        hasOlder: false,
        hasNewer: true,
      });
    });

    it("places a window after a time", () => {
      expect(windowSlice(view, { after: 30n }, 5)).toEqual({
        start: 3,
        end: 5,
        hasOlder: true,
        hasNewer: false,
      });
    });

    it("centers a window around a message", () => {
      expect(windowSlice(view, { around: 30n }, 3)).toEqual({
        start: 1,
        end: 4,
        hasOlder: true,
        hasNewer: true,
      });
    });

    it("fills a window around a message from the other side", () => {
      expect(windowSlice(view, { around: 50n }, 3)).toEqual({
        start: 2,
        end: 5,
        hasOlder: true,
        hasNewer: false,
      });
    });

    it("returns `undefined` around a time naming no message", () => {
      expect(windowSlice(view, { around: 35n }, 3)).toBeUndefined();
    });
  });
});

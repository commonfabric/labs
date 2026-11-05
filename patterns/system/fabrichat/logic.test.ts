import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addMemberOfferId,
  addMemberRequestIdOf,
  isInMain,
  isSingleEmoji,
  outcomeOnReport,
  THREAD_EXCERPT_LENGTH,
  threadExcerpt,
  type ViewItem,
  viewPlaces,
  withReadDeliveries,
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

  describe("outcomeOnReport()", () => {
    const report = (delivery: "offered" | "noticed" | "access-only") => ({
      requestId: "add-1",
      delivery,
    });

    it("takes the report's delivery for an add that holds none", () => {
      expect(outcomeOnReport({ status: "done" }, report("offered")))
        .toEqual({ status: "done", delivery: "offered" });
    });

    it("turns `offered` to `noticed`", () => {
      expect(
        outcomeOnReport(
          { status: "done", delivery: "offered" },
          report("noticed"),
        ),
      ).toEqual({ status: "done", delivery: "noticed" });
    });

    it("keeps the reason a manager's refusal gives", () => {
      expect(
        outcomeOnReport({ status: "done" }, {
          requestId: "add-1",
          delivery: "access-only",
          deliveryRefusal: "The room isn't among this user's chats.",
        }),
      ).toEqual({
        status: "done",
        delivery: "access-only",
        deliveryRefusal: "The room isn't among this user's chats.",
      });
    });

    it("changes nothing when the same report is heard again", () => {
      expect(
        outcomeOnReport(
          { status: "done", delivery: "offered" },
          report("offered"),
        ),
      ).toBeUndefined();
      expect(
        outcomeOnReport(
          { status: "done", delivery: "noticed" },
          report("noticed"),
        ),
      ).toBeUndefined();
    });

    it("leaves `noticed` standing when `offered` arrives after it", () => {
      expect(
        outcomeOnReport(
          { status: "done", delivery: "noticed" },
          report("offered"),
        ),
      ).toBeUndefined();
    });

    it("leaves `access-only` standing", () => {
      expect(
        outcomeOnReport(
          { status: "done", delivery: "access-only" },
          report("offered"),
        ),
      ).toBeUndefined();
    });

    it("leaves an add that was refused, or isn't recorded, as it is", () => {
      expect(
        outcomeOnReport(
          { status: "refused", reason: "No." },
          report("offered"),
        ),
      ).toBeUndefined();
      expect(outcomeOnReport(undefined, report("offered"))).toBeUndefined();
    });
  });

  describe("withReadDeliveries()", () => {
    it("takes what is read for an add with no `delivery` of its own", () => {
      expect(
        withReadDeliveries(
          { a: { status: "done" } },
          { a: { status: "done", delivery: "noticed" } },
        ),
      ).toEqual({ a: { status: "done", delivery: "noticed" } });
    });

    it("keeps a `delivery` the add holds over what is read", () => {
      expect(
        withReadDeliveries(
          { a: { status: "done", delivery: "offered" } },
          { a: { status: "done", delivery: "noticed" } },
        ),
      ).toEqual({ a: { status: "done", delivery: "offered" } });
    });

    it("keeps an add nothing is read for, with no read at all too", () => {
      const recorded = {
        a: { status: "done" },
        b: { status: "refused", reason: "No." },
      } as const;
      expect(withReadDeliveries(recorded, {})).toEqual(recorded);
      expect(withReadDeliveries(recorded, undefined)).toEqual(recorded);
    });

    it("keeps an add that was refused over what is read", () => {
      expect(
        withReadDeliveries(
          { a: { status: "refused", reason: "No." } },
          { a: { status: "done", delivery: "offered" } },
        ),
      ).toEqual({ a: { status: "refused", reason: "No." } });
    });
  });

  describe("addMemberRequestIdOf()", () => {
    it("returns the `requestId` that `addMemberOfferId()` composed", () => {
      expect(
        addMemberRequestIdOf(addMemberOfferId("did:a", "add-1"), "did:a"),
      ).toBe("add-1");
    });

    it("returns `undefined` for another room's add", () => {
      expect(
        addMemberRequestIdOf(addMemberOfferId("did:a", "add-1"), "did:b"),
      ).toBeUndefined();
    });

    it("returns `undefined` for an id that an add didn't compose", () => {
      for (
        const id of [
          "add-1",
          "",
          "[]",
          "null",
          JSON.stringify(["other", "did:a", "add-1"]),
          JSON.stringify(["addMember", "did:a"]),
          JSON.stringify(["addMember", "did:a", 1]),
          JSON.stringify(["addMember", "did:a", "add-1", "more"]),
        ]
      ) {
        expect(addMemberRequestIdOf(id, "did:a")).toBeUndefined();
      }
    });

    it("returns `undefined` for a room that names no space", () => {
      expect(
        addMemberRequestIdOf(addMemberOfferId("did:a", "add-1"), undefined),
      ).toBeUndefined();
    });
  });
});

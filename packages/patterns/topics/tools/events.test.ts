import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { changes, history } from "./events.ts";
import type { Topic, TopicComment } from "./mirror.ts";

/** A Topic with every field defaulted except those given. */
function topic(fields: Partial<Topic>): Topic {
  return {
    number: "1",
    address: "of:fid1:entry-1",
    piece: "of:fid1:piece-1",
    title: "Fryer",
    body: "Body.",
    createdAt: 100,
    createdBy: "Sol (agent)",
    lastActivityAt: 100,
    comments: [],
    links: [],
    mentions: [],
    ...fields,
  };
}

function comment(fields: Partial<TopicComment>): TopicComment {
  return { author: "Ada", body: "Hi.", sentAt: 200, removed: false, ...fields };
}

describe("events", () => {
  describe("changes()", () => {
    it("returns nothing for a board that did not change", () => {
      const board = [topic({ comments: [comment({})] })];

      expect(changes(board, board, 999)).toEqual([]);
    });

    it("returns a new Topic as filed, dated when it was created", () => {
      const filed = topic({ number: "2", createdAt: 500 });

      expect(changes([topic({})], [topic({}), filed], 999)).toEqual([
        { kind: "filed", topic: filed, at: 500 },
      ]);
    });

    it("returns renames, new bodies, and new mentions dated now", () => {
      const other = topic({ number: "2", address: "of:fid1:entry-2" });
      const before = topic({ mentions: ["of:fid1:entry-2"] });
      const after = topic({
        title: "Fryer fixed",
        body: "New body.",
        mentions: ["of:fid1:entry-2", "of:fid1:entry-3", "of:fid1:unknown"],
      });
      const third = topic({ number: "3", piece: "of:fid1:entry-3" });

      expect(
        changes([before, other, third], [after, other, third], 999),
      ).toEqual([
        { kind: "retitled", topic: after, before: "Fryer", at: 999 },
        { kind: "body", topic: after, before: "Body.", at: 999 },
        { kind: "mention", topic: after, other: third, at: 999 },
      ]);
    });

    it("returns comments added, edited, and retracted, oldest first, and not a retracted one added", () => {
      const before = topic({
        comments: [comment({ body: "One." }), comment({ body: "Two." })],
      });
      const added = comment({ body: "Three.", sentAt: 300 });
      const after = topic({
        comments: [
          comment({ body: "One!", editedAt: 400 }),
          comment({ body: "Two.", removed: true }),
          added,
          comment({ body: "Gone.", removed: true }),
        ],
      });

      expect(changes([before], [after], 999).map((e) => [e.kind, e.at]))
        .toEqual([["comment", 300], ["edited", 400], ["retracted", 999]]);
    });

    it("dates a Topic or a comment that has no timestamp of its own now", () => {
      const before = topic({ comments: [comment({})] });
      const after = topic({
        comments: [comment({ body: "Hi!" }), comment({ sentAt: 0 })],
      });
      const filed = topic({ number: "2", createdAt: 0 });

      expect(
        changes([before], [after, filed], 999).map((e) => [e.kind, e.at]),
      ).toEqual([["edited", 999], ["comment", 999], ["filed", 999]]);
    });

    it("returns links added, but not ones added already retracted", () => {
      const link = {
        kind: "pr",
        url: "https://x/1",
        label: "Fix",
        addedBy: "Sol",
        addedAt: 600,
        removed: false,
      };
      const after = topic({
        links: [link, { ...link, url: "https://x/2", removed: true }],
      });

      expect(changes([topic({})], [after], 999)).toEqual([
        { kind: "link", topic: after, link, at: 600 },
      ]);
    });
  });

  describe("changes() for links and references", () => {
    const link = {
      kind: "pr",
      url: "https://x/1",
      label: "Fix",
      addedBy: "Sol",
      addedAt: 600,
      removed: false,
    };

    it("returns a link taken back, dated now", () => {
      const after = topic({ links: [{ ...link, removed: true }] });

      expect(changes([topic({ links: [link] })], [after], 999)).toEqual([
        { kind: "unlinked", topic: after, link: after.links[0], at: 999 },
      ]);
    });

    it("returns a reference once the Topic it names is on the board, and not again", () => {
      const before = topic({ mentions: ["of:fid1:entry-2"] });
      const other = topic({ number: "2", address: "of:fid1:entry-2" });

      expect(changes([before], [before, other], 999)).toEqual([
        { kind: "filed", topic: other, at: 100 },
        { kind: "mention", topic: before, other, at: 999 },
      ]);
      expect(changes([before, other], [before, other], 999)).toEqual([]);
    });

    it("returns a reference removed, and nothing when only the Topic it named is gone", () => {
      const other = topic({ number: "2", address: "of:fid1:entry-2" });
      const before = topic({ mentions: ["of:fid1:entry-2"] });
      const after = topic({ mentions: [] });

      expect(changes([before, other], [after, other], 999)).toEqual([
        { kind: "unmentioned", topic: after, other, at: 999 },
      ]);
      expect(changes([before, other], [before], 999)).toEqual([]);
    });
  });

  describe("history()", () => {
    it("returns the newest Topics filed, comments, and links by their own times, oldest first", () => {
      const link = {
        kind: "web",
        url: "https://x",
        label: "",
        addedBy: "",
        addedAt: 250,
        removed: false,
      };
      const board = [
        topic({
          createdAt: 100,
          comments: [
            comment({ sentAt: 300 }),
            comment({ sentAt: 400, removed: true }),
            comment({ sentAt: 0 }),
          ],
          links: [link, { ...link, addedAt: undefined }],
        }),
        topic({ number: "2", createdAt: 0 }),
      ];

      expect(history(board, 10).map((e) => [e.kind, e.at])).toEqual([
        ["filed", 100],
        ["link", 250],
        ["comment", 300],
      ]);
      expect(history(board, 2).map((e) => e.at)).toEqual([250, 300]);
    });
  });
});

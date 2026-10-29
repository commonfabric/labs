import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { unicodeWidth } from "@std/cli/unicode-width";
import { stripAnsi } from "@commonfabric/cli/view/ansi";

import type { TopicEvent } from "./events.ts";
import type { Topic, TopicComment } from "./mirror.ts";
import {
  animating,
  type FeedItem,
  GLOW_MS,
  kindColor,
  markdown,
  render,
  type ScreenState,
} from "./screen.ts";

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

/** A Topic with every field defaulted except those given. */
function topic(fields: Partial<Topic>): Topic {
  return {
    number: "1",
    address: "of:fid1:entry-1",
    piece: "of:fid1:piece-1",
    title: "Flaky fryer test",
    body: "The fryer test fails.",
    createdAt: NOW - 86_400_000,
    createdBy: "Sol (agent)",
    lastActivityAt: NOW - 86_400_000,
    comments: [],
    links: [],
    mentions: [],
    ...fields,
  };
}

const COMMENT: TopicComment = {
  author: "Ada (person)",
  body: "Reproduced with **cold** oil; see `fryer.ts`.",
  sentAt: NOW,
  removed: false,
};

/** A state holding `topics` and `feed`, live. */
function state(fields: Partial<ScreenState>): ScreenState {
  return {
    space: "topics-space",
    topicLinks: "https://fabric.example/topics-space/top/",
    topics: [],
    feed: [],
    touched: new Map(),
    live: true,
    held: 1234,
    ...fields,
  };
}

/** A frame's rows as text, its styling taken out. */
function rows(frame: readonly string[]): string[] {
  return frame.map(stripAnsi);
}

/** The column at which `char` last appears in `row`, or -1. */
function columnOf(row: string, char: string): number {
  const at = row.lastIndexOf(char);
  return at < 0 ? -1 : unicodeWidth(row.slice(0, at));
}

/** `event` as a live card that arrived at `arrived`. */
function live(event: TopicEvent, arrived = NOW): FeedItem {
  return { event, arrived, live: true };
}

describe("screen", () => {
  describe("render()", () => {
    it("paints every row of the terminal to its full width", () => {
      const fryer = topic({ comments: [COMMENT] });
      const frame = render(
        state({
          topics: [fryer, topic({ number: "2", title: "日本語のタイトル" })],
          feed: [
            live({ kind: "comment", topic: fryer, comment: COMMENT, at: NOW }),
          ],
        }),
        100,
        30,
        NOW + 5000,
      );

      expect(rows(frame).length).toBe(30);
      for (const row of rows(frame)) expect(unicodeWidth(row)).toBe(100);
    });

    it("keeps the list's divider and a card's sides in their columns, whatever the text holds", () => {
      const wide = "✅ Done 日本語 cafe\u0301 ✔";
      const odd = topic({
        number: "2",
        title: Array(9).fill(wide).join(" "),
        comments: [{ ...COMMENT, body: `${wide} ${wide} ${wide}` }],
      });
      const text = rows(
        render(
          state({
            topics: [topic({}), odd],
            feed: [
              live({
                kind: "comment",
                topic: odd,
                comment: odd.comments[0],
                at: NOW,
              }),
            ],
          }),
          100,
          30,
          NOW + 9000,
        ),
      );
      const body = text.slice(1, -1);
      const card = body.filter((row) => /[║╗╝]/.test(row));

      expect(new Set(body.map((row) => columnOf(row, "│"))).size).toBe(1);
      expect(card.length).toBeGreaterThan(3);
      expect(
        new Set(
          card.map((row) =>
            Math.max(
              columnOf(row, "║"),
              columnOf(row, "╗"),
              columnOf(row, "╝"),
            )
          ),
        ).size,
      ).toBe(1);
    });

    it("shows a character the board holds that a terminal would act on as a glyph, and never sends it", () => {
      const sly = topic({ title: "Hi\x1b]0;owned\x07\x1b[2J \u202ethere" });
      const frame = render(state({ topics: [sly] }), 100, 20, NOW);
      const text = rows(frame).join("\n");

      expect(text).toContain("Hi␛]0;owned␇␛[2J ␦the");
      expect(frame.join("")).not.toContain("\x1b]0;");
      expect(frame.join("")).not.toContain("\x1b[2J");

      const long = topic({ title: "\x07".repeat(80) });
      const cut = rows(render(state({ topics: [long] }), 100, 20, NOW))
        .find((row) => row.includes("␇"));

      expect(cut).toMatch(/␇…/);
    });

    it("says how many Topics and documents, whether it is live, and when the last change came", () => {
      const quiet = rows(render(state({ live: false }), 80, 20, NOW));
      const busy = rows(
        render(
          state({ topics: [topic({})], lastChange: NOW }),
          80,
          20,
          NOW,
        ),
      );

      expect(quiet[0]).toContain("0 topics");
      expect(quiet[0]).toContain("○ connecting");
      expect(quiet.at(-1)).toContain("waiting for changes");
      expect(busy[0]).toContain("1 topic ");
      expect(busy[0]).toContain("● LIVE");
      expect(busy.at(-1)).toContain("holding 1,234 documents");
      expect(busy.at(-1)).toMatch(/last change \d\d:\d\d:\d\d/);
    });

    it("lists Topics most recently active first, the higher number first among equals, marking one that just changed", () => {
      const older = topic({ number: "7", title: "Older", lastActivityAt: 0 });
      const newer = topic({ number: "9", title: "Newer", lastActivityAt: 2 });
      const tied = topic({ number: "3", title: "Tied", lastActivityAt: 2 });
      const frame = (now: number) =>
        rows(
          render(
            state({
              topics: [older, tied, newer],
              touched: new Map([["7", {
                at: NOW,
                color: kindColor("comment"),
              }]]),
            }),
            80,
            20,
            now,
          ),
        );
      const fresh = frame(NOW + 100);

      const at = (title: string) =>
        fresh.findIndex((row) => row.includes(title));

      expect(at("Newer")).toBeLessThan(at("Tied"));
      expect(at("Tied")).toBeLessThan(at("Older"));
      expect(fresh.find((row) => row.includes("Older"))).toMatch(/^▌/);
      expect(fresh.find((row) => row.includes("Older"))).toMatch(/Older +│/);
      expect(frame(NOW + GLOW_MS).find((row) => row.includes("Older")))
        .toMatch(/^ /);
    });

    it("types a live card's content in, then shows it whole", () => {
      const fryer = topic({ comments: [COMMENT] });
      const frame = (now: number) =>
        rows(
          render(
            state({
              topics: [fryer],
              feed: [
                live({
                  kind: "comment",
                  topic: fryer,
                  comment: COMMENT,
                  at: NOW,
                }),
              ],
            }),
            100,
            24,
            now,
          ),
        ).join("\n");
      const typing = frame(NOW + 100);
      const typed = frame(NOW + 3000);

      expect(typed).toContain("● comment");
      expect(typed).toContain("top/1  Flaky fryer test");
      expect(typed).toContain("Ada (person)");
      expect(typed).toContain("Reproduced with cold oil; see fryer.ts.");
      expect(typing).toContain("▌");
      expect(typing).not.toContain("fryer.ts.");
      expect(typed).not.toMatch(/fryer\.ts\.▌/);
    });

    it("types a comment of several lines in line by line, its card keeping its height", () => {
      const fryer = topic({});
      const lines = {
        ...COMMENT,
        body: "First line.\n\nSecond line, longer.\n\nThird.",
      };
      const frame = (now: number) =>
        rows(
          render(
            state({
              topics: [fryer],
              feed: [
                live({
                  kind: "comment",
                  topic: fryer,
                  comment: lines,
                  at: NOW,
                }),
              ],
            }),
            100,
            24,
            now,
          ),
        );
      const typing = frame(NOW + 100);
      const typed = frame(NOW + 9000);
      const text = typing.join("\n");

      expect(text).toContain("First line.");
      expect(text).toMatch(/║ S[a-z]*▌/);
      expect(text).not.toContain("longer.");
      expect(text).not.toContain("Third.");
      expect(typed.join("\n")).toContain("Third.");
      expect(typing.findIndex((row) => row.includes("╚"))).toBe(
        typed.findIndex((row) => row.includes("╚")),
      );
    });

    it("shows earlier events whole, at once, as many as the terminal holds", () => {
      const fryer = topic({ comments: [COMMENT] });
      const seen = { ...COMMENT, body: "Seen *twice*." };
      const earlier = (comment: TopicComment): FeedItem => ({
        event: { kind: "comment", topic: fryer, comment, at: 1 },
        arrived: NOW,
        live: false,
      });
      const frame = render(
        state({
          topics: [fryer],
          feed: [earlier(seen), ...Array(20).fill(earlier(COMMENT))],
        }),
        100,
        24,
        NOW,
      );
      const text = rows(frame).join("\n");

      expect(text).toContain("Seen twice.");
      expect(frame.join("")).toContain("\x1b[3;38;2;");
      expect(text).toContain("Reproduced with cold oil; see fryer.ts.");
      expect(rows(frame).length).toBe(24);
    });

    it("draws each kind of event with what it changed", () => {
      const fryer = topic({ title: "Fryer fixed", body: "Line one\nLine new" });
      const other = topic({ number: "3", title: "Donuts" });
      const events: TopicEvent[] = [
        { kind: "filed", topic: fryer, at: NOW },
        { kind: "edited", topic: fryer, comment: COMMENT, at: NOW },
        { kind: "retracted", topic: fryer, comment: COMMENT, at: NOW },
        { kind: "retitled", topic: fryer, before: "Fryer", at: NOW },
        { kind: "body", topic: fryer, before: "Line one\nLine old", at: NOW },
        {
          kind: "link",
          topic: fryer,
          link: {
            kind: "pr",
            url: "https://x/1",
            label: "Fix",
            addedBy: "Sol",
            removed: false,
          },
          at: NOW,
        },
        { kind: "mention", topic: fryer, other, at: NOW },
        {
          kind: "unlinked",
          topic: fryer,
          link: {
            kind: "pr",
            url: "https://x/1",
            label: "Fix",
            addedBy: "Sol",
            removed: true,
          },
          at: NOW,
        },
        { kind: "unmentioned", topic: fryer, other, at: NOW },
      ];
      const text = (event: TopicEvent) =>
        rows(render(state({ feed: [live(event)] }), 100, 24, NOW + 9000))
          .join("\n");

      expect(text(events[0])).toMatch(
        /new topic[\s\S]*filed by Sol[\s\S]*Line one/,
      );
      expect(text(events[1])).toMatch(/comment edited[\s\S]*Ada \(person\)/);
      expect(text(events[2])).toContain("comment retracted");
      expect(text(events[3])).toMatch(
        /renamed[\s\S]*was Fryer[\s\S]*Fryer fixed/,
      );
      expect(text(events[4])).toMatch(
        /body rewritten[\s\S]*\+ Line new[\s\S]*− Line old/,
      );
      expect(text(events[4])).not.toContain("+ Line one");
      expect(text(events[5])).toMatch(
        /pr link added by Sol[\s\S]*Fix {2}https:\/\/x\/1/,
      );
      expect(text(events[6])).toMatch(/now references[\s\S]*top\/3 {2}Donuts/);
      expect(text(events[7])).toMatch(
        /link removed[\s\S]*pr link taken back[\s\S]*Fix {2}https:\/\/x\/1/,
      );
      expect(text(events[8])).toMatch(
        /mention removed[\s\S]*no longer references[\s\S]*top\/3 {2}Donuts/,
      );
    });

    it("links each Topic's number to where a browser opens it, in the list, a card, and a mention", () => {
      const fryer = topic({});
      const other = topic({ number: "3", title: "Donuts" });
      const frame = render(
        state({
          topics: [fryer],
          feed: [live({ kind: "mention", topic: fryer, other, at: NOW })],
        }),
        100,
        24,
        NOW + 9000,
      ).join("");
      const link = (number: string, text: string) =>
        `\x1b]8;;https://fabric.example/topics-space/top/${number}\x07${text}` +
        "\x1b]8;;\x07";

      expect(frame).toContain(link("1", "1"));
      expect(frame).toContain(link("1", "top/1"));
      expect(frame).toContain(link("3", "top/3"));
    });

    it("says when nothing has happened, and asks for a bigger terminal when it is too small", () => {
      expect(rows(render(state({}), 80, 20, NOW)).join("\n")).toContain(
        "Nothing has happened on the board yet.",
      );
      expect(rows(render(state({}), 40, 10, NOW)).join("\n")).toContain(
        "Make the terminal",
      );
    });

    it("cuts a long comment short, marking where it was cut", () => {
      const long = { ...COMMENT, body: Array(20).fill("line").join("\n\n") };
      const text = rows(
        render(
          state({
            feed: [
              live({
                kind: "comment",
                topic: topic({}),
                comment: long,
                at: NOW,
              }),
            ],
          }),
          100,
          40,
          NOW + 9000,
        ),
      ).join("\n");

      expect(text.match(/line/g)?.length).toBe(4);
      expect(text).toContain(" …");
    });
  });

  describe("animating()", () => {
    it("returns `true` while a live card or a changed Topic is still moving, and `false` after", () => {
      const moving = state({
        feed: [live({ kind: "filed", topic: topic({}), at: NOW })],
      });
      const touched = state({
        touched: new Map([["1", { at: NOW, color: kindColor("filed") }]]),
      });

      expect(animating(moving, NOW + 10)).toBe(true);
      expect(animating(touched, NOW + 10)).toBe(true);
      expect(animating(moving, NOW + GLOW_MS)).toBe(false);
      expect(animating(touched, NOW + GLOW_MS)).toBe(false);
      expect(animating(state({}), NOW)).toBe(false);
    });
  });

  describe("markdown()", () => {
    /** `text` drawn `width` wide, as plain text. */
    function plain(text: string, width = 30): string[] {
      return markdown(text, width).map((row) =>
        row.map((span) => span.text).join("")
      );
    }

    it("draws headings, lists, quotes, code, emphasis, and links without their markup", () => {
      expect(
        plain(
          "# Title\n\n- one **two**\n  1. three\n> quoted\n```\ncode()\n```\n*soft* [link](https://x)",
        ),
      ).toEqual([
        "Title",
        "",
        "• one two",
        "  1. three",
        "▎ quoted",
        "code()",
        "soft link",
      ]);
    });

    it("wraps at word boundaries, breaking a word longer than the width", () => {
      expect(plain("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
      expect(plain("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    });

    it("puts a character wider than the width on a row of its own, and keeps a long list number from taking the row", () => {
      expect(plain("a 日本 b", 1)).toEqual(["a", "日", "本", "b"]);
      expect(plain(`${"9".repeat(40)}. item`, 10)).toEqual([
        "99999… ite",
        "       m",
      ]);
    });

    it("draws an indented heading or quote as one", () => {
      expect(plain("  ## Head\n  > quoted")).toEqual(["Head", "▎ quoted"]);
    });

    it("measures an emoji of several code points as two columns, as terminals draw it", () => {
      for (const emoji of ["⚠️", "👨‍👩‍👧", "👍🏽", "🇺🇸"]) {
        expect(plain(emoji.repeat(3), 4)).toEqual([emoji.repeat(2), emoji]);
      }
    });

    it("wraps a word of a hundred thousand characters in one pass", () => {
      expect(plain("x".repeat(100_000), 50)).toEqual(
        Array(2000).fill("x".repeat(50)),
      );
    });

    it("wraps the lines of a paragraph together", () => {
      expect(plain("one two\nthree\nfour five", 10)).toEqual([
        "one two",
        "three four",
        "five",
      ]);
    });

    it("drops trailing blank lines and collapses runs of blank lines", () => {
      expect(plain("one\n\n\n\ntwo\n\n")).toEqual(["one", "", "two"]);
      expect(plain("\n\n")).toEqual([]);
      expect(plain("one\n\n```")).toEqual(["one"]);
    });
  });
});

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import {
  assembleTopic,
  DocReader,
  type Field,
  formatTopic,
  formatTopicLine,
  linkOf,
  type MirrorData,
  type Plain,
  searchTopics,
  storedAsExpected,
  type ThreadWindow,
  type Topic,
  topicPieces,
  topicRecord,
  toPlain,
} from "./mirror.ts";

const SPACE = "did:key:z6Mk-topics-tool-mirror";

/** A link as the copy holds one. */
function mark(id: string | undefined, path: string[] = [], space?: string) {
  return {
    $link: {
      ...(id === undefined ? {} : { id }),
      ...(space === undefined ? {} : { space }),
      path,
    },
  };
}

/** A copy holding `docs` at revision 1 each. */
function copyOf(docs: Record<string, Plain>): MirrorData {
  return {
    pieces: {},
    docs: Object.fromEntries(
      Object.entries(docs).map(([id, value]) => [id, { seq: 1, value }]),
    ),
  };
}

/** A Topic with every field defaulted except those given. */
function topic(fields: Partial<Topic>): Topic {
  return {
    number: "1",
    address: "of:entry-1",
    piece: "of:piece-1",
    title: "",
    body: "",
    createdAt: 0,
    createdBy: "",
    lastActivityAt: 0,
    comments: [],
    links: [],
    mentions: [],
    ...fields,
  };
}

describe("mirror", () => {
  describe("toPlain()", () => {
    it("returns scalars, arrays, and plain objects as they are", () => {
      expect(toPlain({ a: [1, "two", true, null], b: { c: "d" } })).toEqual({
        a: [1, "two", true, null],
        b: { c: "d" },
      });
    });

    it("returns a link envelope as a link mark carrying its id, space, and path", () => {
      expect(
        toPlain({
          "/": {
            "link@1": {
              id: "of:x",
              space: SPACE,
              path: ["a", 2],
              schema: { type: "string" },
              overwrite: "redirect",
            },
          },
        }),
      ).toEqual(mark("of:x", ["a", "2"], SPACE));
      expect(toPlain({ "/": { "link@1": {} } })).toEqual(mark(undefined));
    });

    it("drops byte sequences and other values with no plain form", () => {
      expect(
        toPlain({
          picture: new FabricBytes(new Uint8Array([1, 2])),
          name: "Ada",
          missing: undefined,
          infinite: Infinity,
          list: [new FabricBytes(new Uint8Array([3])), 4],
        }),
      ).toEqual({ name: "Ada", list: [null, 4] });
    });
  });

  describe("linkOf()", () => {
    it("returns the link a mark carries", () => {
      expect(linkOf(mark("of:x", ["a"]))).toEqual({ id: "of:x", path: ["a"] });
    });

    it("returns `undefined` for anything that is not exactly a mark", () => {
      expect(linkOf("of:x")).toBeUndefined();
      expect(linkOf({ $link: { id: "of:x" } })).toBeUndefined();
      expect(linkOf({ ...mark("of:x"), other: 1 })).toBeUndefined();
      expect(linkOf(undefined)).toBeUndefined();
    });
  });

  describe("DocReader", () => {
    it("follows links across documents, within a document, and along paths", () => {
      const data = copyOf({
        "of:a": {
          title: mark("of:b", ["names", "0"]),
          self: mark(undefined, ["own"]),
          own: "mine",
        },
        "of:b": { names: [mark("of:c")] },
        "of:c": "the title",
      });
      const reader = new DocReader(data, SPACE);
      const root = reader.root("of:a");

      expect(reader.text(root, "title")).toBe("the title");
      expect(reader.text(root, "self")).toBe("mine");
      expect([...reader.touched].sort()).toEqual(["of:a", "of:b", "of:c"]);
      expect(reader.missing.size).toBe(0);
    });

    it("records a document it needs and lacks as missing, and reads nothing there", () => {
      const reader = new DocReader(
        copyOf({ "of:a": { title: mark("of:b") } }),
        SPACE,
      );

      expect(reader.text(reader.root("of:a"), "title")).toBe("");
      expect([...reader.missing]).toEqual(["of:b"]);
    });

    it("reads a document the server lacks as nothing rather than missing", () => {
      const data = copyOf({ "of:a": { x: mark("of:gone") } });
      const reader = new DocReader(data, SPACE, new Set(["of:gone"]));

      expect(reader.text(reader.root("of:a"), "x")).toBe("");
      expect(reader.missing.size).toBe(0);
    });

    it("reads a link into another space as nothing", () => {
      const data = copyOf({
        "of:a": { x: mark("of:b", [], "did:key:other") },
        "of:b": "elsewhere",
      });
      const reader = new DocReader(data, SPACE);

      expect(reader.text(reader.root("of:a"), "x")).toBe("");
      expect(reader.missing.size).toBe(0);
    });

    it("accepts a link naming its own space", () => {
      const data = copyOf({
        "of:a": { x: mark("of:b", [], SPACE) },
        "of:b": "here",
      });

      expect(
        new DocReader(data, SPACE).text(
          new DocReader(data, SPACE).root("of:a"),
          "x",
        ),
      ).toBe("here");
    });

    it("throws on a cycle of links", () => {
      const data = copyOf({ "of:a": mark("of:b"), "of:b": mark("of:a") });

      expect(() => new DocReader(data, SPACE).root("of:a")).toThrow(/cycle/);
    });

    it("reads a non-numeric key of an array, and a key of a scalar, as nothing", () => {
      const reader = new DocReader(
        copyOf({ "of:a": { list: [1], n: 5 } }),
        SPACE,
      );
      const root = reader.root("of:a");

      expect(reader.child(reader.child(root, "list"), "length").value)
        .toBeUndefined();
      expect(reader.child(reader.child(root, "n"), "x").value).toBeUndefined();
      expect(reader.number(root, "n")).toBe(5);
      expect(reader.number(root, "list")).toBeUndefined();
      expect(reader.items(reader.child(root, "n"))).toEqual([]);
    });
  });

  describe("topicPieces()", () => {
    it("returns the document each numbered `names` entry links, without following it", () => {
      const reader = new DocReader(
        copyOf({
          "of:input": {
            names: {
              "1": mark("of:alias-1"),
              "2": mark("of:piece-2"),
              "3": "not a link",
              "04": mark("of:leading-zero"),
              "topic": mark("of:slug"),
            },
          },
        }),
        SPACE,
      );

      expect([...topicPieces(reader, "of:input")]).toEqual([
        ["1", "of:alias-1"],
        ["2", "of:piece-2"],
      ]);
      expect(reader.missing.size).toBe(0);
    });

    it("returns nothing for a board with no `names` map", () => {
      expect(
        topicPieces(
          new DocReader(copyOf({ "of:input": {} }), SPACE),
          "of:input",
        ).size,
      ).toBe(0);
    });
  });

  describe("assembleTopic()", () => {
    const PIECE = { piece: "of:piece", input: "of:input" };

    const data = copyOf({
      "of:input": {
        title: "Flaky fryer test",
        body: "The fryer test fails.",
        createdAt: 1000,
        createdBy: { kind: "agent", name: "Sol" },
        bodyUpdatedAt: 2000,
        titleUpdatedAt: 1500,
        comments: [
          mark("of:c1"),
          {
            authorName: "Old Bob",
            body: "Inline and legacy",
            sentAt: 3000,
            editedAt: 3500,
          },
          mark("of:c3"),
        ],
        links: [
          {
            kind: "pr",
            url: "https://example.com/pr/1",
            label: "Fix",
            addedAt: 4000,
            addedBy: { kind: "agent", name: "Sol" },
          },
          { url: "https://example.com/old", label: "", removedAt: 9000 },
        ],
        mentioned: [mark("of:other-entry"), "not a link"],
      },
      "of:c1": {
        author: { kind: "person", name: "Ada" },
        body: "Reproduced.",
        sentAt: 2500,
      },
      "of:c3": {
        author: { name: "Cy" },
        body: "Withdrawn",
        sentAt: 5000,
        removedAt: 8000,
      },
    });

    it("returns the title, body, author, comments, and links the documents hold", () => {
      const reader = new DocReader(data, SPACE);
      const assembled = assembleTopic(reader, "7", "of:entry", PIECE);

      expect(assembled).toEqual({
        number: "7",
        address: "of:entry",
        piece: "of:piece",
        title: "Flaky fryer test",
        body: "The fryer test fails.",
        createdAt: 1000,
        createdBy: "Sol (agent)",
        lastActivityAt: 9000,
        comments: [
          {
            author: "Ada (person)",
            body: "Reproduced.",
            sentAt: 2500,
            removed: false,
          },
          {
            author: "Old Bob",
            body: "Inline and legacy",
            sentAt: 3000,
            editedAt: 3500,
            removed: false,
          },
          { author: "Cy", body: "Withdrawn", sentAt: 5000, removed: true },
        ],
        links: [
          {
            kind: "pr",
            url: "https://example.com/pr/1",
            label: "Fix",
            addedBy: "Sol (agent)",
            addedAt: 4000,
            removed: false,
          },
          {
            kind: "web",
            url: "https://example.com/old",
            label: "",
            addedBy: "",
            removed: true,
          },
        ],
        mentions: ["of:other-entry"],
      });
      expect([...reader.touched].sort()).toEqual([
        "of:c1",
        "of:c3",
        "of:input",
      ]);
    });

    it("assembles a Topic whose records the copy lacks with those records empty, naming them missing", () => {
      const partial = copyOf({
        "of:input": {
          title: "T",
          createdByName: "Legacy Lu",
          comments: [mark("of:absent")],
        },
      });
      const reader = new DocReader(partial, SPACE);
      const assembled = assembleTopic(reader, "1", "of:entry", PIECE);

      expect(assembled.createdBy).toBe("Legacy Lu");
      expect(assembled.mentions).toEqual([]);
      expect(assembled.comments).toEqual([{
        author: "",
        body: "",
        sentAt: 0,
        removed: false,
      }]);
      expect([...reader.missing]).toEqual(["of:absent"]);
    });
  });

  describe("storedAsExpected()", () => {
    it("returns `true` for an input document holding a title, comments, and links", () => {
      const data = copyOf({
        "of:input": { title: mark("of:t"), comments: [], links: [] },
        "of:t": "Linked title",
      });

      expect(storedAsExpected(new DocReader(data, SPACE), "of:input")).toBe(
        true,
      );
    });

    it("returns `false` when any of the three is missing or of another type", () => {
      const values: Plain[] = [
        { comments: [], links: [] },
        { title: "T", comments: {}, links: [] },
        { title: "T", comments: [] },
      ];
      for (const value of values) {
        const reader = new DocReader(copyOf({ "of:input": value }), SPACE);

        expect(storedAsExpected(reader, "of:input")).toBe(false);
      }
    });
  });

  describe("searchTopics()", () => {
    const fryer = topic({
      number: "1",
      title: "Flaky fryer test",
      body: "Line one\nThe oil is cold here",
      lastActivityAt: 100,
      createdBy: "Sol (agent)",
      comments: [
        {
          author: "Ada (person)",
          body: "gone: cold oil again",
          sentAt: 1,
          removed: true,
        },
        {
          author: "Bo (agent)",
          body: "warm oil fixes it",
          sentAt: 2,
          removed: false,
        },
      ],
      links: [{
        kind: "pr",
        url: "https://example.com/pr/9",
        label: "Oil fix",
        addedBy: "Cy",
        removed: false,
      }],
    });
    const donut = topic({
      number: "2",
      title: "Donut glaze",
      body: "Sugar and oil",
      lastActivityAt: 200,
    });

    it("returns only the Topics matching every pattern, most recently active first", () => {
      expect(
        searchTopics([fryer, donut], [/oil/i]).map((hit) => hit.topic.number),
      ).toEqual(["2", "1"]);
      expect(
        searchTopics([fryer, donut], [/oil/i, /cold/i]).map((hit) =>
          hit.topic.number
        ),
      ).toEqual(["1"]);
      expect(searchTopics([fryer, donut], [/croissant/i])).toEqual([]);
    });

    it("returns every Topic for no patterns", () => {
      expect(searchTopics([fryer, donut], []).length).toBe(2);
    });

    it("returns the matching lines, labeled by where they are, numbering only present comments", () => {
      expect(searchTopics([fryer], [/oil/i])[0].snippets).toEqual([
        "body: The oil is cold here",
        "comment 1 (Bo (agent)): warm oil fixes it",
        "link: Oil fix https://example.com/pr/9",
      ]);
    });

    it("does not search a retracted comment", () => {
      expect(searchTopics([fryer], [/again/i])).toEqual([]);
    });

    it("matches an author's name without showing a line for it", () => {
      const [hit] = searchTopics([fryer], [/Bo \(agent\)/]);

      expect(hit.topic.number).toBe("1");
      expect(hit.snippets).toEqual([]);
      expect(searchTopics([fryer], [/Sol/]).length).toBe(1);
    });

    it("matches only in the parts `fields` names", () => {
      const numbers = (patterns: RegExp[], fields: Field[]) =>
        searchTopics([fryer, donut], patterns, { fields }).map((hit) =>
          hit.topic.number
        );

      expect(numbers([/oil/i], ["title"])).toEqual([]);
      expect(numbers([/fryer/i], ["title"])).toEqual(["1"]);
      expect(numbers([/oil/i], ["body"])).toEqual(["2", "1"]);
      expect(numbers([/warm/i], ["body", "links"])).toEqual([]);
      expect(numbers([/warm/i], ["comments"])).toEqual(["1"]);
      expect(numbers([/example\.com/], ["links"])).toEqual(["1"]);
      expect(numbers([/Cy/], ["authors"])).toEqual(["1"]);
      expect(numbers([/Cy/], ["title", "body", "comments", "links"]))
        .toEqual([]);
      expect(
        searchTopics([fryer], [/oil/i], { fields: ["comments"] })[0].snippets,
      ).toEqual(["comment 1 (Bo (agent)): warm oil fixes it"]);
    });

    it("leaves out the Topics whose titles match a pattern of `exclude`", () => {
      expect(
        searchTopics([fryer, donut], [/oil/i], { exclude: [/^donut/i] }).map((
          hit,
        ) => hit.topic.number),
      ).toEqual(["1"]);
      expect(
        searchTopics([fryer, donut], [], { exclude: [/sugar/i] }).length,
      ).toBe(2);
    });

    it("matches a global pattern in each Topic alike, as a term and in `exclude`", () => {
      const fryer = topic({ number: "1", title: "Oil fryer" });
      const glaze = topic({ number: "2", title: "Oil glaze" });

      expect(searchTopics([fryer, glaze], [/oil/gi]).length).toBe(2);
      expect(searchTopics([fryer, glaze], [], { exclude: [/oil/gi] }))
        .toEqual([]);
    });

    it("returns at most three lines per Topic", () => {
      const busy = topic({ body: "oil\noil\noil\noil" });

      expect(searchTopics([busy], [/oil/])[0].snippets.length).toBe(3);
    });

    it("cuts a long matching line to the stretch around its first match", () => {
      const long = topic({
        body: `${"a".repeat(300)} needle ${"b".repeat(300)}`,
      });
      const [snippet] = searchTopics([long], [/needle/])[0].snippets;

      expect(snippet).toMatch(/^body: …a+ needle b+…$/);
      expect(snippet.length).toBeLessThan(220);
      const start = topic({ body: `needle ${"b".repeat(300)}` });

      expect(searchTopics([start], [/needle/])[0].snippets[0]).toMatch(
        /^body: needle b+…$/,
      );
    });
  });

  describe("formatTopicLine()", () => {
    const NOW = Date.UTC(2026, 9, 26, 12, 0);
    const utc = { now: NOW, timeZone: "UTC" };

    /** The line for a Topic last active `at`, its time column alone. */
    function column(at: number, now = utc): string {
      return formatTopicLine(topic({ lastActivityAt: at, title: "T" }), now)
        .slice("top/1  ".length, -"  T".length);
    }

    it("returns the number, when the Topic was last active, the title, and the count of present comments", () => {
      const comment = { author: "", body: "", sentAt: 0, removed: false };

      expect(
        formatTopicLine(
          topic({
            number: "42",
            title: "T",
            lastActivityAt: Date.UTC(2026, 9, 18),
          }),
          utc,
        ),
      ).toBe("top/42  2026-10-18  T");
      expect(formatTopicLine(topic({ comments: [comment] }), utc)).toBe(
        "top/1  -             [1 comment]",
      );
      expect(
        formatTopicLine(
          topic({
            comments: [comment, comment, { ...comment, removed: true }],
          }),
          utc,
        ),
      ).toMatch(/\[2 comments\]$/);
    });

    it("gives activity within the last day as an age, in a column of its own width", () => {
      expect(column(NOW - 20_000)).toBe("just now  ");
      expect(column(NOW + 60_000)).toBe("just now  ");
      expect(column(NOW - 12 * 60_000)).toBe("12m ago   ");
      expect(column(NOW - 59 * 60_000)).toBe("59m ago   ");
      expect(column(NOW - 5 * 3_600_000 - 59 * 60_000)).toBe("5h ago    ");
      expect(column(NOW - 24 * 3_600_000 + 60_000)).toBe("23h ago   ");
    });

    it("gives older activity as the day it fell on in the time zone", () => {
      const lateEvening = Date.UTC(2026, 9, 20, 3, 0);

      expect(column(lateEvening)).toBe("2026-10-20");
      expect(
        column(lateEvening, { now: NOW, timeZone: "America/Los_Angeles" }),
      ).toBe("2026-10-19");
    });
  });

  describe("topicRecord()", () => {
    it("returns the Topic as plain data, with its present comments the window holds and its present links", () => {
      const record = topicRecord(
        topic({
          number: "7",
          address: "of:entry-7",
          title: "T",
          body: "B",
          createdAt: 1,
          createdBy: "Sol (agent)",
          lastActivityAt: 4,
          comments: [
            { author: "A", body: "One", sentAt: 2, removed: false },
            { author: "B", body: "Gone", sentAt: 3, removed: true },
            {
              author: "C",
              body: "Two",
              sentAt: 4,
              editedAt: 5,
              removed: false,
            },
          ],
          links: [
            {
              kind: "pr",
              url: "https://x/1",
              label: "Fix",
              addedBy: "Sol",
              addedAt: 3,
              removed: false,
            },
            {
              kind: "web",
              url: "https://x/2",
              label: "",
              addedBy: "",
              removed: true,
            },
          ],
          mentions: ["of:entry-2"],
        }),
        { last: 1 },
      );

      expect(record).toEqual({
        number: "7",
        address: "/of:entry-7",
        title: "T",
        body: "B",
        createdAt: 1,
        createdBy: "Sol (agent)",
        lastActivityAt: 4,
        comments: [
          { number: 2, author: "C", body: "Two", sentAt: 4, editedAt: 5 },
        ],
        links: [
          {
            kind: "pr",
            url: "https://x/1",
            label: "Fix",
            addedBy: "Sol",
            addedAt: 3,
          },
        ],
        mentions: ["of:entry-2"],
      });
    });
  });

  describe("formatTopic()", () => {
    it("returns the header, body, present links, and present comments as Markdown", () => {
      const at = Date.UTC(2026, 9, 18, 14, 31);
      const text = formatTopic(
        topic({
          number: "9",
          title: "Fryer",
          body: "Body text\n",
          createdAt: at,
          createdBy: "Sol (agent)",
          lastActivityAt: at,
          comments: [
            {
              author: "Ada (person)",
              body: "First",
              sentAt: at,
              removed: false,
            },
            { author: "Bo", body: "Gone", sentAt: at, removed: true },
            {
              author: "",
              body: "Edited",
              sentAt: at,
              editedAt: at,
              removed: false,
            },
          ],
          links: [
            {
              kind: "pr",
              url: "https://x/1",
              label: "Fix",
              addedBy: "Sol (agent)",
              removed: false,
            },
            {
              kind: "web",
              url: "https://x/2",
              label: "https://x/2",
              addedBy: "",
              removed: false,
            },
            {
              kind: "web",
              url: "https://x/3",
              label: "",
              addedBy: "",
              removed: true,
            },
          ],
        }),
        "/of:piece-9",
      );

      expect(text).toBe([
        "# top/9: Fryer",
        "",
        "Address: /of:piece-9",
        "Created 2026-10-18 14:31Z by Sol (agent); last activity 2026-10-18 14:31Z; 2 comments; 2 links.",
        "",
        "Body text",
        "",
        "## Links",
        "",
        "- [pr] Fix <https://x/1> (Sol (agent))",
        "- [web] <https://x/2>",
        "",
        "## Comments",
        "",
        "### 1. Ada (person), 2026-10-18 14:31Z",
        "",
        "First",
        "",
        "### 2. unknown, 2026-10-18 14:31Z, edited 2026-10-18 14:31Z",
        "",
        "Edited",
      ].join("\n"));
    });

    it("shows the comments a window holds, numbered in the whole thread, saying how many of them", () => {
      const thread = topic({
        comments: [1000, 2000, 3000, 4000].map((sentAt) => ({
          author: "A",
          body: `At ${sentAt}.`,
          sentAt,
          removed: false,
        })),
      });
      const shown = (window: ThreadWindow) =>
        [...formatTopic(thread, "/of:e", window).matchAll(/^### (\d+)\./gm)]
          .map((match) => match[1]);

      expect(shown({})).toEqual(["1", "2", "3", "4"]);
      expect(shown({ last: 2 })).toEqual(["3", "4"]);
      expect(shown({ since: 2000 })).toEqual(["2", "3", "4"]);
      expect(shown({ since: 2000, last: 1 })).toEqual(["4"]);
      expect(shown({ since: 9000 })).toEqual([]);
      expect(formatTopic(thread, "/of:e", { last: 2 })).toContain(
        "## Comments\n\n2 of 4 shown.\n\n### 3.",
      );
      expect(formatTopic(thread, "/of:e")).not.toContain("shown.");
    });

    it("lists comments oldest first, numbering them as a search labels them", () => {
      const later = {
        author: "B",
        body: "later oil",
        sentAt: 2000,
        removed: false,
      };
      const earlier = {
        author: "A",
        body: "earlier oil",
        sentAt: 1000,
        removed: false,
      };
      const unordered = topic({ comments: [later, earlier] });
      const text = formatTopic(unordered, "/of:entry-1");

      expect(text.indexOf("### 1. A,")).toBeLessThan(text.indexOf("### 2. B,"));
      expect(searchTopics([unordered], [/oil/])[0].snippets).toEqual([
        "comment 1 (A): earlier oil",
        "comment 2 (B): later oil",
      ]);
    });

    it("says when a Topic has no body, and leaves out empty sections", () => {
      expect(formatTopic(topic({}), "/of:piece-1")).toBe([
        "# top/1: ",
        "",
        "Address: /of:piece-1",
        "Created -; last activity -; 0 comments; 0 links.",
        "",
        "(no body)",
      ].join("\n"));
    });
  });
});

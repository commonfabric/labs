import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { Topic } from "./mirror.ts";
import {
  answer,
  authors,
  byQuery,
  families,
  family,
  parseQuery,
  references,
  settled,
} from "./query.ts";

/** A Topic with every field defaulted except those given. */
function topic(fields: Partial<Topic> & { number: string }): Topic {
  return {
    address: `of:entry-${fields.number}`,
    piece: `of:piece-${fields.number}`,
    title: "",
    body: "",
    createdAt: 0,
    updatedAt: 0,
    createdBy: "",
    lastActivityAt: 0,
    comments: [],
    links: [],
    mentions: [],
    ...fields,
  };
}

const TOPICS = [
  topic({
    number: "1",
    title: "Fryer test fails",
    body: "Cold oil; see top/2.",
    createdBy: "Sol (agent)",
    lastActivityAt: 30,
    comments: [
      { author: "Ada (person)", body: "Seen it.", sentAt: 30, removed: false },
      { author: "Cy (agent)", body: "Gone.", sentAt: 31, removed: true },
    ],
  }),
  topic({
    number: "2",
    title: "Glaze cracks",
    createdBy: "Egory L7 (agent)",
    lastActivityAt: 20,
    mentions: ["of:piece-1"],
  }),
  topic({
    number: "3",
    title: "[RESOLVED by #9] Old fryer",
    createdBy: "Egory-E1 (agent)",
    createdAt: 40,
    lastActivityAt: 40,
  }),
];

/** The numbers of what `text` asks for, settled Topics shown or not. */
function numbers(text: string, hideSettled = false, unread = "") {
  const { hits, hidden } = answer(TOPICS, parseQuery(text), {
    unread: (t) => unread.split(",").includes(t.number),
    hideSettled,
  });
  return { shown: hits.map((hit) => hit.topic.number), hidden };
}

describe("query", () => {
  describe("settled()", () => {
    it("returns `true` for a title beginning with a settled mark, and `false` otherwise", () => {
      expect(settled(TOPICS[2])).toBe(true);
      expect(settled(topic({ number: "9", title: "[DUP] x" }))).toBe(true);
      expect(settled(TOPICS[0])).toBe(false);
      expect(settled(topic({ number: "9", title: "Not [RESOLVED] yet" }))).toBe(
        false,
      );
    });
  });

  describe("parseQuery()", () => {
    it("reads words, authors, fields, states, and a number", () => {
      const query = parseQuery(
        'fry by:"Ada (person)" in:title,body is:unread #42 by:eg.ry',
      );

      expect(query.terms.map(String)).toEqual(["/fry/i", "/#42/i"]);
      expect(query.authors.map(String)).toEqual([
        "/^Ada \\(person\\)$/i",
        "/eg.ry/i",
      ]);
      expect(query.fields).toEqual(["title", "body"]);
      expect(query.is).toEqual(["unread"]);
      expect(query.number).toBe("42");
    });

    it("matches a quoted word literally, and one whose quote is not yet closed as typed so far", () => {
      const [closed] = parseQuery('"a.b"').terms;
      const [open] = parseQuery('"a.b c').terms;

      expect(closed.test("xa.by")).toBe(true);
      expect(closed.test("axb")).toBe(false);
      expect(open.test("a.b c d")).toBe(true);
      expect(parseQuery('by:"Ada').authors.map(String)).toEqual(["/Ada/i"]);
    });

    it("reads a backslash in quotes as standing for the character after it", () => {
      const name = 'Bo "the \\ fryer" (agent)';
      const [author] = parseQuery(byQuery(name, false)).authors;

      expect(author.test(name)).toBe(true);
      expect(author.test("Bo (agent)")).toBe(false);
    });

    it("takes a field the board does not have, an invalid regular expression, and an unknown state as plain words", () => {
      const query = parseQuery("in:titel a(b is:pending");

      expect(query.fields).toBeUndefined();
      expect(query.terms.map(String)).toEqual([
        "/in:titel/i",
        "/a\\(b/i",
        "/is:pending/i",
      ]);
      expect(query.is).toEqual([]);
    });

    it("asks nothing of an author still being typed", () => {
      expect(parseQuery("by:").authors).toEqual([]);
      expect(parseQuery("by:").terms).toEqual([]);
    });
  });

  describe("answer()", () => {
    it("returns the Topics every word matches, most recently active first", () => {
      expect(numbers("fryer").shown).toEqual(["3", "1"]);
      expect(numbers("fryer cold").shown).toEqual(["1"]);
    });

    it("keeps the Topics an author wrote on, leaving out a retracted comment's author", () => {
      expect(numbers("by:ada").shown).toEqual(["1"]);
      expect(numbers("by:cy").shown).toEqual([]);
      expect(numbers(byQuery("Egory", true)).shown).toEqual(["3", "2"]);
    });

    it("leaves settled Topics out when asked to, counting them, unless the query asks for them", () => {
      expect(numbers("", true)).toEqual({ shown: ["1", "2"], hidden: 1 });
      expect(numbers("is:settled", true)).toEqual({ shown: ["3"], hidden: 0 });
      expect(numbers("is:open").shown).toEqual(["1", "2"]);
    });

    it("keeps unread Topics, and puts a Topic its number names first, whatever else is asked", () => {
      expect(numbers("is:unread", false, "2").shown).toEqual(["2"]);
      expect(numbers("top/3", true).shown).toEqual(["3"]);
      expect(numbers("2").shown[0]).toBe("2");
    });
  });

  describe("authors()", () => {
    it("counts what each person wrote, most recently active first", () => {
      expect(authors(TOPICS).map((a) => [a.name, a.filed, a.comments, a.last]))
        .toEqual([
          ["Egory-E1 (agent)", 1, 0, 40],
          ["Ada (person)", 0, 1, 30],
          ["Egory L7 (agent)", 1, 0, 0],
          ["Sol (agent)", 1, 0, 0],
        ]);
    });
  });

  describe("family()", () => {
    it("returns a name's first word, less its kind", () => {
      expect(family("Egory L7 (agent)")).toBe("Egory");
      expect(family("Egory-E1 (agent)")).toBe("Egory");
      expect(family("Ada (person)")).toBe("Ada");
    });
  });

  describe("families()", () => {
    it("gathers authors into families, adding what they wrote", () => {
      const gathered = families(authors(TOPICS));

      expect(gathered.map((a) => [a.name, a.filed, [...a.topics].sort()]))
        .toEqual([
          ["Egory", 2, ["2", "3"]],
          ["Ada", 0, ["1"]],
          ["Sol", 1, ["1"]],
        ]);
    });
  });

  describe("byQuery()", () => {
    it("returns a query naming one author exactly, or a family by its first word", () => {
      expect(byQuery("Ada (person)", false)).toBe('by:"Ada (person)"');
      expect(byQuery('A"b\\c', false)).toBe('by:"A\\"b\\\\c"');
      expect(byQuery("a.b", true)).toBe("by:^a\\.b\\b");
    });
  });

  describe("references()", () => {
    it("returns which Topics mention or cite which, both ways", () => {
      const refs = references([
        ...TOPICS,
        topic({ number: "4", body: "top/4 and top/99 and top/3" }),
      ]);

      expect(refs.out.get("1")).toEqual(new Set(["2"]));
      expect(refs.out.get("2")).toEqual(new Set(["1"]));
      expect(refs.out.get("4")).toEqual(new Set(["3"]));
      expect(refs.in.get("3")).toEqual(new Set(["4"]));
      expect(refs.in.get("1")).toEqual(new Set(["2"]));
    });
  });
});

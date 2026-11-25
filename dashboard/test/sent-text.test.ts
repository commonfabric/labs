import { describe, it } from "@commonfabric/test-support/test";
import { expect } from "@std/expect";
import {
  MAX_EDITED_PIECES,
  receivedText,
  type SentText,
  textToSend,
} from "../sent-text.ts";

// What a reader holding `before` holds once it is sent the way to `after`.
const roundTrip = (before: string, after: string): string =>
  receivedText(before, textToSend(before, after));

describe("sent-text", () => {
  describe("textToSend()", () => {
    it("returns the whole text to a reader holding nothing", () => {
      expect(textToSend(undefined, "<p>new</p>")).toBe("<p>new</p>");
    });

    it("returns no edits when the text has not changed", () => {
      expect(textToSend("<p>same</p>", "<p>same</p>")).toEqual({
        from: 11,
        edits: [],
      });
    });

    it("returns edits that replace only the tags that changed in a long page", () => {
      const page = (row: string) =>
        Array.from({ length: 500 }, (_, i) => `<tr><td>${i === 250 ? row : i}</td></tr>`)
          .join("");
      const sent = textToSend(page("250"), page("two hundred and fifty"));
      expect(typeof sent).not.toBe("string");
      expect(JSON.stringify(sent).length).toBeLessThan(100);
      expect(receivedText(page("250"), sent)).toBe(page("two hundred and fifty"));
    });

    it("returns edits up to the most pieces it edits, and the whole text past them", () => {
      const grown = (count: number) => "<x>" + "<i>".repeat(count);
      const most = textToSend("<x>", grown(MAX_EDITED_PIECES));
      expect(most).toEqual({
        from: 3,
        edits: [[3, 0, "<i>".repeat(MAX_EDITED_PIECES)]],
      });
      expect(textToSend("<x>", grown(MAX_EDITED_PIECES + 1))).toBe(
        grown(MAX_EDITED_PIECES + 1),
      );
    });

    it("returns edits that rebuild a text whatever was inserted, dropped, or replaced, and where", () => {
      const cases: [string, string][] = [
        ["", "<a>"],
        ["<a>", ""],
        ["plain", "plain text"],
        ["<a>1<b>2<c>3", "<a>1<b>two<c>3"],
        ["<a>1<b>2<c>3", "<z><a>1<b>2<c>3"],
        ["<a>1<b>2<c>3", "<a>1<b>2<c>3<z>"],
        ["<a>1<b>2<c>3", "<b>2"],
        ["lead<a>1", "other<a>1"],
        ["<a><a><a>", "<a><b><a>"],
        ["<<<", "<<"],
      ];
      for (const [before, after] of cases) {
        expect(roundTrip(before, after)).toBe(after);
        expect(roundTrip(after, before)).toBe(before);
      }
    });

    it("returns edits that rebuild every one of a set of generated texts from every other", () => {
      // A fixed sequence of pseudorandom texts drawn from a few pieces that
      // repeat, which is where an alignment of pieces can go wrong.
      let seed = 1;
      const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
      const pieces = ["<a>", "<b>x", "<c>", "y", "<d>zz", "<"];
      const texts = Array.from(
        { length: 40 },
        () =>
          Array.from(
            { length: Math.floor(next() * 30) },
            () => pieces[Math.floor(next() * pieces.length)],
          ).join(""),
      );
      for (const before of texts) {
        for (const after of texts) expect(roundTrip(before, after)).toBe(after);
      }
    });
  });

  describe("receivedText()", () => {
    it("returns a whole text it is sent, whatever it held", () => {
      expect(receivedText("<p>old</p>", "<p>new</p>")).toBe("<p>new</p>");
    });

    it("returns the text it held when it is sent no edits", () => {
      expect(receivedText("<p>old</p>", { from: 10, edits: [] })).toBe("<p>old</p>");
    });

    it("applies each edit in turn and keeps what follows the last", () => {
      const edits: SentText = { from: 13, edits: [[3, 3, "new"], [4, 0, "!"]] };
      expect(receivedText("<p>old</p><i>", edits)).toBe("<p>new</p>!<i>");
    });

    it("throws a RangeError for edits made from a text of another length", () => {
      const edits = [[3, 0, "x"]] satisfies [number, number, string][];
      expect(() => receivedText("<p>", { from: 4, edits })).toThrow(RangeError);
      expect(() => receivedText("<p>", { from: 2, edits })).toThrow(RangeError);
      expect(receivedText("<p>", { from: 3, edits })).toBe("<p>x");
    });

    it("throws a RangeError for edits that reach past the end of the text it held", () => {
      expect(() => receivedText("<p>", { from: 3, edits: [[2, 2, "x"]] }))
        .toThrow(RangeError);
      expect(receivedText("<p>", { from: 3, edits: [[2, 1, "x"]] })).toBe("<px");
    });
  });
});

import { ChangeSet, Text } from "@codemirror/state";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { TextChange } from "@commonfabric/api";
import {
  applyTextChanges,
  codeMirrorTextChangesPayload,
} from "../v2/text-changes.ts";

/** The text CodeMirror makes of `text` under each update of `payload`. */
const appliedByCodeMirror = (text: string, payload: unknown): string => {
  const { updates } = payload as {
    updates: { changes: Parameters<typeof ChangeSet.fromJSON>[0] }[];
  };
  let document = Text.of(text.split("\n"));
  for (const update of updates) {
    document = ChangeSet.fromJSON(update.changes).apply(document);
  }
  return document.toString();
};

describe("text-changes", () => {
  describe("applyTextChanges()", () => {
    it("returns the text with an insertion, a replacement, and a deletion applied", () => {
      expect(
        applyTextChanges("hello world", [
          { from: 0, insert: "> " },
          { from: 5, to: 6, insert: ", " },
          { from: 10, to: 11 },
        ]),
      ).toBe("> hello, worl");
    });

    it("returns two insertions at one position in list order", () => {
      expect(
        applyTextChanges("ac", [{ from: 1, insert: "b" }, {
          from: 1,
          insert: "B",
        }]),
      ).toBe("abBc");
    });

    it("throws `RangeError` for a change past the end of the text", () => {
      expect(() => applyTextChanges("ab", [{ from: 3, insert: "c" }]))
        .toThrow(RangeError);
    });

    it("throws `RangeError` for changes out of order", () => {
      expect(() =>
        applyTextChanges("abcd", [{ from: 2, to: 3 }, { from: 1, insert: "x" }])
      ).toThrow(RangeError);
    });

    it("throws `RangeError` for a position that is not an integer", () => {
      expect(() => applyTextChanges("ab", [{ from: 0.5 }])).toThrow(
        RangeError,
      );
    });
  });

  describe("codeMirrorTextChangesPayload()", () => {
    const cases: { name: string; text: string; batches: TextChange[][] }[] = [
      {
        name: "an append on a line of its own",
        text: "# Notes\n- a",
        batches: [[{ from: 11, insert: "\n- b" }]],
      },
      {
        name: "a prepend on a line of its own",
        text: "# Notes",
        batches: [[{ from: 0, insert: "top\n" }]],
      },
      {
        name: "a replacement across lines and a deletion",
        text: "one\ntwo\nthree",
        batches: [[{ from: 2, to: 6, insert: "X\nY" }, { from: 9, to: 13 }]],
      },
      {
        name: "an insertion into empty text",
        text: "",
        batches: [[{ from: 0, insert: "first" }]],
      },
      {
        name: "two batches, the second against the first's result",
        text: "ac",
        batches: [[{ from: 1, insert: "b" }], [{ from: 3, insert: "d" }]],
      },
    ];

    for (const { name, text, batches } of cases) {
      it(`encodes ${name} as CodeMirror applies it`, () => {
        const expected = batches.reduce(applyTextChanges, text);
        const payload = codeMirrorTextChangesPayload(text, batches, "agent");

        expect(appliedByCodeMirror(text, payload)).toBe(expected);
      });
    }

    it("encodes a batch the way `ChangeSet.toJSON()` does", () => {
      const payload = codeMirrorTextChangesPayload(
        "# Notes\n- a",
        [[{ from: 11, insert: "\n- b" }]],
        "agent",
      );

      expect(payload).toEqual({
        updates: [{
          clientId: "agent",
          changes: ChangeSet.of({ from: 11, insert: "\n- b" }, 11).toJSON(),
        }],
      });
    });
  });
});

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  dedupeByDestination,
  labelForToken,
  MENTION_REF_KEY_SOURCE,
  MentionRefMapSchema,
  MentionRefSchema,
  mintRefKey,
} from "./mention-refs.ts";

describe("mention-refs", () => {
  describe("mintRefKey()", () => {
    it("returns a six-character key when nothing is taken", () => {
      expect(mintRefKey(new Set())).toMatch(/^[0-9a-z]{6}$/);
    });

    it("returns a key matching MENTION_REF_KEY_SOURCE", () => {
      const shape = new RegExp(`^${MENTION_REF_KEY_SOURCE}$`);
      for (let i = 0; i < 32; i++) {
        expect(mintRefKey(new Set())).toMatch(shape);
      }
    });

    it("returns a key nothing in the taken set holds", () => {
      const taken = new Set<string>();
      for (let i = 0; i < 64; i++) {
        const key = mintRefKey(taken);
        expect(taken.has(key)).toBe(false);
        taken.add(key);
      }
      expect(taken.size).toBe(64);
    });

    it("widens the key when every six-character sample is taken", () => {
      // Standing in for an exhausted length: the set claims every key of six
      // characters, so the mint has to reach seven to find a free one.
      const taken = {
        has: (key: string) => key.length === 6,
        get size() {
          return 36 ** 6;
        },
      } as unknown as ReadonlySet<string>;

      expect(mintRefKey(taken).length).toBe(7);
    });

    it("throws when no length up to the maximum is free", () => {
      const taken = {
        has: () => true,
        get size() {
          return Infinity;
        },
      } as unknown as ReadonlySet<string>;

      expect(() => mintRefKey(taken)).toThrow(
        /no free mention reference key/,
      );
    });
  });

  describe("labelForToken()", () => {
    it("returns an ordinary name unchanged", () => {
      expect(labelForToken("My Note")).toBe("My Note");
    });

    it("returns a name with no `]`, which the parser cannot read past", () => {
      expect(labelForToken("A]B")).toBe("A)B");
    });

    it("returns a name on one line", () => {
      expect(labelForToken("Two\nLines")).toBe("Two Lines");
      expect(labelForToken("Two\r\nLines")).toBe("Two Lines");
    });
  });

  describe("dedupeByDestination()", () => {
    const idOf = (piece: { id?: string }) => piece.id;

    it("returns a list with no duplicate destination", () => {
      const a = { id: "of:fid1:aaa" };
      expect(dedupeByDestination([a, { id: "of:fid1:bbb" }, a], idOf).length)
        .toBe(2);
    });

    it("returns the first of each destination", () => {
      const first = { id: "of:fid1:aaa", which: "first" };
      const second = { id: "of:fid1:aaa", which: "second" };
      expect(dedupeByDestination([first, second], idOf)[0].which).toBe("first");
    });

    it("returns everything the identity cannot name", () => {
      // Dropping these would lose a mention rather than deduplicate one.
      const plain = { name: "no identity" };
      expect(dedupeByDestination([plain, plain], () => undefined).length)
        .toBe(2);
    });

    it("returns an empty list unchanged", () => {
      expect(dedupeByDestination([], idOf)).toEqual([]);
    });
  });

  describe("MentionRefSchema", () => {
    it("reads destination as a cell rather than a value", () => {
      expect(MentionRefSchema.properties.destination.asCell).toEqual(["cell"]);
    });

    it("defaults modifiedTitle to false", () => {
      expect(MentionRefSchema.properties.modifiedTitle.default).toBe(false);
    });

    it("requires a destination", () => {
      expect(MentionRefSchema.required).toEqual(["destination"]);
    });
  });

  describe("MentionRefMapSchema", () => {
    it("shapes every entry as a MentionRef", () => {
      expect(MentionRefMapSchema.additionalProperties).toBe(MentionRefSchema);
    });
  });
});

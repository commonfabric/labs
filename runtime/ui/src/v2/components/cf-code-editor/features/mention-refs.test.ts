import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { EditorState } from "@codemirror/state";
import {
  findRefToken,
  mentionRefDecorations,
  mentionRefEditFilter,
  mentionRefField,
  type MentionRefInfo,
  mentionRefs,
  parseMentionRefs,
  refShortNameField,
  refShortNames,
  scanRefKeys,
  setKnownRefKeys,
  setRefShortNames,
  shortNameQueryAt,
} from "./mention-refs.ts";

const KEY = "a3f9zz";
const OTHER_KEY = "b7k2m1";

/** A headless state whose map holds `keys`. */
function createState(doc: string, keys: string[] = [KEY]): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [mentionRefField, mentionRefEditFilter, refShortNameField],
  });
  return state.update({ effects: setKnownRefKeys.of(keys) }).state;
}

/** `state`, with `names` announced as what its destinations call themselves. */
function withShortNames(
  state: EditorState,
  names: Record<string, string>,
): EditorState {
  return state.update({ effects: setRefShortNames.of(names) }).state;
}

/** Every pill a state's mentions take, in document order. */
function pills(
  state: EditorState,
  hasFocus = false,
): Array<{ from: number; to: number; shortName: string | undefined }> {
  const found: Array<
    { from: number; to: number; shortName: string | undefined }
  > = [];
  mentionRefDecorations(state, hasFocus).between(
    0,
    state.doc.length,
    (from, to, value) => {
      const spec = value.spec as {
        class?: string;
        attributes?: Record<string, string>;
      };
      if (spec.class !== "cm-mention-ref-pill") return;
      found.push({ from, to, shortName: spec.attributes?.["data-short-name"] });
    },
  );
  return found;
}

/** Every range a state's mentions hide from the reader, in document order. */
function hidden(
  state: EditorState,
  hasFocus = false,
): Array<{ from: number; to: number }> {
  const found: Array<{ from: number; to: number }> = [];
  mentionRefDecorations(state, hasFocus).between(
    0,
    state.doc.length,
    (from, to, value) => {
      if (value.spec.class !== undefined) return;
      found.push({ from, to });
    },
  );
  return found;
}

describe("mention-refs", () => {
  describe("parseMentionRefs()", () => {
    const known = new Set([KEY]);

    it("returns an empty array for an empty string", () => {
      expect(parseMentionRefs("", known)).toEqual([]);
    });

    it("returns an empty array when no key is known", () => {
      expect(parseMentionRefs(`See [Note][${KEY}].`, new Set())).toEqual([]);
    });

    it("parses a token whose key the map holds", () => {
      const refs = parseMentionRefs(`See [My Note][${KEY}] for more`, known);
      expect(refs).toHaveLength(1);

      const ref = refs[0];
      expect(ref.label).toBe("My Note");
      expect(ref.key).toBe(KEY);
      expect(ref.from).toBe(4);
      expect(ref.labelFrom).toBe(5);
      expect(ref.labelTo).toBe(12);
      expect(ref.to).toBe(21);
    });

    it("returns positions that slice back to the original token", () => {
      const doc = `x [My Note][${KEY}] y`;
      const ref = parseMentionRefs(doc, known)[0];
      expect(doc.slice(ref.from, ref.to)).toBe(`[My Note][${KEY}]`);
      expect(doc.slice(ref.labelFrom, ref.labelTo)).toBe("My Note");
    });

    it("returns nothing for a token whose key the map does not hold", () => {
      expect(parseMentionRefs("See [the docs][readme] here", known)).toEqual(
        [],
      );
    });

    it("returns nothing for a reference link with an over-long key", () => {
      const doc = "[label][averylongreferencename]";
      expect(parseMentionRefs(doc, new Set(["averylongreferencename"])))
        .toEqual([]);
    });

    it("parses several tokens in one string", () => {
      const doc = `[A][${KEY}] and [B][${OTHER_KEY}]`;
      const refs = parseMentionRefs(doc, new Set([KEY, OTHER_KEY]));
      expect(refs.map((ref: MentionRefInfo) => ref.label)).toEqual(["A", "B"]);
      expect(refs.map((ref: MentionRefInfo) => ref.key)).toEqual([
        KEY,
        OTHER_KEY,
      ]);
    });

    it("parses a token with an empty label", () => {
      const refs = parseMentionRefs(`[][${KEY}]`, known);
      expect(refs).toHaveLength(1);
      expect(refs[0].label).toBe("");
      expect(refs[0].labelFrom).toBe(refs[0].labelTo);
    });

    it("returns nothing for a label broken across lines", () => {
      expect(parseMentionRefs(`[My\nNote][${KEY}]`, known)).toEqual([]);
    });
  });

  describe("scanRefKeys()", () => {
    it("returns keys the map does not hold", () => {
      expect(scanRefKeys(`[A][${KEY}] [B][${OTHER_KEY}]`)).toEqual(
        new Set([KEY, OTHER_KEY]),
      );
    });

    it("returns an empty set for text with no reference links", () => {
      expect(scanRefKeys("plain prose")).toEqual(new Set());
    });
  });

  describe("findRefToken()", () => {
    it("returns the token's range and label", () => {
      const doc = `See [My Note][${KEY}] here`;
      const found = findRefToken(doc, KEY);
      expect(found).toEqual({ from: 4, to: 21, label: "My Note" });
      expect(doc.slice(found!.from, found!.to)).toBe(`[My Note][${KEY}]`);
    });

    it("returns a token whose label has been retyped since", () => {
      // The window an in-flight create leaves open: the label is editable, so
      // the key is the only durable handle on the token.
      expect(findRefToken(`[something else][${KEY}]`, KEY)?.label)
        .toBe("something else");
    });

    it("returns a token whose label is empty", () => {
      expect(findRefToken(`[][${KEY}]`, KEY)?.label).toBe("");
    });

    it("returns null when the key is not in the document", () => {
      expect(findRefToken(`[A][${OTHER_KEY}]`, KEY)).toBeNull();
      expect(findRefToken("no tokens here", KEY)).toBeNull();
    });

    it("returns the token for the key asked for, not another", () => {
      const doc = `[One][${KEY}] and [Two][${OTHER_KEY}]`;
      expect(findRefToken(doc, OTHER_KEY)?.label).toBe("Two");
    });
  });

  describe("mentionRefField", () => {
    it("holds no references until keys are announced", () => {
      const state = EditorState.create({
        doc: `[A][${KEY}]`,
        extensions: [mentionRefField],
      });
      expect(mentionRefs(state)).toEqual([]);
    });

    it("parses references once keys are announced", () => {
      expect(mentionRefs(createState(`[A][${KEY}]`))).toHaveLength(1);
    });

    it("drops a reference whose key leaves the map", () => {
      const state = createState(`[A][${KEY}]`);
      const narrowed = state.update({ effects: setKnownRefKeys.of([]) }).state;
      expect(mentionRefs(narrowed)).toEqual([]);
    });

    it("updates positions when text is inserted before a reference", () => {
      const state = createState(`x [A][${KEY}]`);
      expect(mentionRefs(state)[0].from).toBe(2);

      const moved = state.update({ changes: { from: 0, to: 0, insert: "yy" } });
      expect(mentionRefs(moved.state)[0].from).toBe(4);
    });

    it("detects a reference added by an edit", () => {
      const state = createState("Hello ", [KEY]);
      expect(mentionRefs(state)).toEqual([]);

      const typed = state.update({
        changes: { from: 6, to: 6, insert: `[New][${KEY}]` },
      });
      expect(mentionRefs(typed.state)).toHaveLength(1);
      expect(mentionRefs(typed.state)[0].label).toBe("New");
    });

    it("returns the same value for a selection-only transaction", () => {
      const state = createState(`[A][${KEY}]`);
      const before = state.field(mentionRefField);
      const after = state.update({ selection: { anchor: 2 } }).state.field(
        mentionRefField,
      );
      expect(after).toBe(before);
    });
  });

  describe("mentionRefEditFilter", () => {
    it("applies an edit outside every reference", () => {
      const state = createState(`Hello [A][${KEY}] end`);
      const edited = state.update({
        changes: { from: 0, to: 5, insert: "Hi" },
      });
      expect(edited.state.doc.toString()).toBe(`Hi [A][${KEY}] end`);
    });

    it("applies an edit inside the label", () => {
      const state = createState(`[Note][${KEY}]`);
      const edited = state.update({
        changes: { from: 3, to: 3, insert: "X" },
      });
      expect(edited.state.doc.toString()).toBe(`[NoXte][${KEY}]`);
    });

    it("drops an edit starting inside the key", () => {
      const state = createState(`[Note][${KEY}]`);
      const ref = mentionRefs(state)[0];
      const edited = state.update({
        changes: { from: ref.labelTo + 2, to: ref.labelTo + 3, insert: "X" },
      });
      expect(edited.state.doc.toString()).toBe(`[Note][${KEY}]`);
    });

    it("truncates an edit running from the label into the key", () => {
      const state = createState(`[Note][${KEY}]`);
      const ref = mentionRefs(state)[0];
      const edited = state.update({
        changes: { from: 4, to: ref.labelTo + 3, insert: "X" },
      });
      expect(edited.state.doc.toString()).toBe(`[NotX][${KEY}]`);
    });

    it("applies an edit deleting a whole reference", () => {
      const state = createState(`before [Note][${KEY}] after`);
      const ref = mentionRefs(state)[0];
      const edited = state.update({
        changes: { from: ref.from, to: ref.to, insert: "" },
      });
      expect(edited.state.doc.toString()).toBe("before  after");
      expect(mentionRefs(edited.state)).toEqual([]);
    });

    it("applies an edit inside a reference link the map does not hold", () => {
      const state = createState("[the docs][readme]");
      const edited = state.update({
        changes: { from: 12, to: 13, insert: "X" },
      });
      expect(edited.state.doc.toString()).toBe("[the docs][rXadme]");
    });

    it("leaves the caret outside the key when an edit into it is dropped", () => {
      const state = createState(`[Note][${KEY}]`);
      const ref = mentionRefs(state)[0];
      // What typing inside the hidden key looks like: a change plus the
      // selection it would have produced.
      const edited = state.update({
        changes: { from: ref.labelTo + 2, to: ref.labelTo + 2, insert: "X" },
        selection: { anchor: ref.labelTo + 3 },
      });
      const caret = edited.state.selection.main.head;
      expect(caret <= ref.labelTo || caret >= ref.to).toBe(true);
    });

    it("truncates an edit running from the label to the token's edge", () => {
      // The edge case a `toA < ref.to` bound misses: this deletes `][key]`
      // and leaves `[Note` behind.
      const state = createState(`[Note][${KEY}]`);
      const ref = mentionRefs(state)[0];
      const edited = state.update({
        changes: { from: 3, to: ref.to, insert: "" },
      });
      expect(edited.state.doc.toString()).toBe(`[No][${KEY}]`);
    });

    it("cuts at the first key when one edit reaches into a later one", () => {
      // The boundary has to be the earliest match: taking the last would move
      // the cut past the first mention's key and delete it.
      const state = createState(
        `[One][${KEY}] and [Two][${OTHER_KEY}]`,
        [KEY, OTHER_KEY],
      );
      const [first, second] = mentionRefs(state);
      const edited = state.update({
        changes: {
          from: first.labelFrom + 1,
          to: second.labelTo + 2,
          insert: "",
        },
      });
      // Both keys survive; only label text between them is gone.
      expect(edited.state.doc.toString()).toContain(`[${KEY}]`);
      expect(edited.state.doc.toString()).toContain(`[${OTHER_KEY}]`);
    });

    it("applies an edit covering the whole token", () => {
      const state = createState(`x [Note][${KEY}] y`);
      const ref = mentionRefs(state)[0];
      const edited = state.update({
        changes: { from: ref.from, to: ref.to, insert: "" },
      });
      expect(edited.state.doc.toString()).toBe("x  y");
    });

    it("keeps an outside change while dropping a key edit in the same transaction", () => {
      const state = createState(`prefix [A][${KEY}] suffix`);
      const ref = mentionRefs(state)[0];
      const edited = state.update({
        changes: [
          { from: 0, to: 6, insert: "pre" },
          { from: ref.labelTo + 2, to: ref.labelTo + 3, insert: "X" },
        ],
      });
      expect(edited.state.doc.toString()).toBe(`pre [A][${KEY}] suffix`);
    });
  });

  describe("refShortNameField", () => {
    it("returns no short names before any are announced", () => {
      expect(refShortNames(createState(`[A][${KEY}]`))).toEqual({});
    });

    it("returns an empty record for a state without the field", () => {
      const state = EditorState.create({
        doc: `[A][${KEY}]`,
        extensions: [mentionRefField],
      });
      expect(refShortNames(state)).toEqual({});
    });

    it("returns the short names last announced", () => {
      const state = withShortNames(createState(`[A][${KEY}]`), { [KEY]: "42" });
      expect(refShortNames(state)).toEqual({ [KEY]: "42" });
    });

    it("drops a name the newer announcement leaves out", () => {
      const named = withShortNames(createState(`[A][${KEY}]`), { [KEY]: "42" });
      expect(refShortNames(withShortNames(named, {}))).toEqual({});
    });

    it("keeps the short names across a document edit", () => {
      // A short name comes from the destination cell and not from the text,
      // so an edit neither produces one nor invalidates one.

      const named = withShortNames(createState(`[A][${KEY}]`), { [KEY]: "42" });
      const edited = named.update({
        changes: { from: 0, to: 0, insert: "x " },
      });
      expect(refShortNames(edited.state)).toEqual({ [KEY]: "42" });
    });
  });

  describe("mentionRefDecorations()", () => {
    it("returns a pill over the label of an unfocused mention", () => {
      const [pill] = pills(createState(`See [My Note][${KEY}].`));
      expect(pill.from).toBe(5);
      expect(pill.to).toBe(12);
      expect(pill.shortName).toBeUndefined();
    });

    it("returns a pill carrying the short name announced for its mention", () => {
      const state = withShortNames(createState(`[My Note][${KEY}]`), {
        [KEY]: "42",
      });
      expect(pills(state)[0].shortName).toBe("42");
    });

    it("returns a pill with no short name beside one that has it", () => {
      const state = withShortNames(
        createState(`[A][${KEY}] [B][${OTHER_KEY}]`, [KEY, OTHER_KEY]),
        { [KEY]: "42" },
      );
      expect(pills(state).map((pill) => pill.shortName)).toEqual([
        "42",
        undefined,
      ]);
    });

    it("returns a pill over a label the short name does not lengthen", () => {
      // The label in the document is the person's wording, and the number is
      // display: a mention that gains one covers the same range it did.

      const plain = createState(`[My Note][${KEY}]`);
      const named = withShortNames(plain, { [KEY]: "42" });
      expect(pills(named)[0].to).toBe(pills(plain)[0].to);
    });

    it("returns no pill for a mention the cursor is inside", () => {
      const state = withShortNames(createState(`[My Note][${KEY}]`), {
        [KEY]: "42",
      }).update({ selection: { anchor: 3 } }).state;
      expect(pills(state, true)).toEqual([]);
    });

    it("returns a pill for a mention the cursor is inside while unfocused", () => {
      const state = createState(`[My Note][${KEY}]`).update({
        selection: { anchor: 3 },
      }).state;
      expect(pills(state, false)).toHaveLength(1);
    });

    it("leaves a mention whose label is empty visible and unpilled", () => {
      // What a deleted label leaves is `[]`, and it stays on screen so it can
      // be typed back into: hiding it would leave a token the document holds
      // and nobody can see or reach.
      const state = createState(`[][${KEY}]`);
      expect(pills(state)).toEqual([]);
      expect(hidden(state)).toEqual([{ from: 2, to: 10 }]);
    });
  });

  describe("shortNameQueryAt()", () => {
    it("returns the digits typed after a sigil at the cursor", () => {
      expect(shortNameQueryAt("see #42")).toEqual({ from: 4, query: "42" });
    });

    it("returns a query for a sigil opening the line", () => {
      expect(shortNameQueryAt("#7")).toEqual({ from: 0, query: "7" });
    });

    it("returns a query for a sigil after a mention token", () => {
      expect(shortNameQueryAt(`[A][${KEY}]#3`)).toEqual({
        from: 11,
        query: "3",
      });
    });

    it("returns null for a sigil with no digits after it", () => {
      expect(shortNameQueryAt("# heading")).toBeNull();
      expect(shortNameQueryAt("a #")).toBeNull();
    });

    it("returns null for a sigil inside a word", () => {
      expect(shortNameQueryAt("issue#42")).toBeNull();
    });

    it("returns null for a sigil after a word in any script", () => {
      // A member's names are ASCII by the spec's decision; the prose around
      // them is not. JavaScript's `\w` is ASCII-only, so a boundary written
      // with it reads every non-Latin letter as a word break and opens a
      // query inside a word.
      expect(shortNameQueryAt("Ω#42")).toBeNull();
      expect(shortNameQueryAt("名#42")).toBeNull();
      expect(shortNameQueryAt("café#42")).toBeNull();
      expect(shortNameQueryAt("Привет#42")).toBeNull();
    });

    it("returns null for a sigil after a letter outside the basic plane", () => {
      // An astral letter is a surrogate PAIR, so a boundary that reads one
      // UTF-16 unit tests its low half, which matches no Unicode property and
      // reads as a word break.
      expect(shortNameQueryAt("\u{1D400}#42")).toBeNull();
      expect(shortNameQueryAt("\u{1D7DC}#42")).toBeNull();
    });

    it("returns a query for a sigil after an astral symbol", () => {
      // The other half: an astral code point that is NOT a letter, mark or
      // number is a boundary, so reading the pair whole must not reject it.
      expect(shortNameQueryAt("\u{1F642}#42")).toEqual({
        from: 2,
        query: "42",
      });
    });

    it("returns a query for a sigil after punctuation in any script", () => {
      // The other half: a boundary that rejected every non-ASCII character
      // would stop the sigil working after ordinary foreign punctuation.
      expect(shortNameQueryAt("見よ、#42")).toEqual({ from: 3, query: "42" });
    });

    it("returns null for a doubled sigil", () => {
      expect(shortNameQueryAt("##42")).toBeNull();
    });

    it("returns null for digits carrying no sigil", () => {
      expect(shortNameQueryAt("42")).toBeNull();
    });

    it("returns null where the digits do not end at the cursor", () => {
      expect(shortNameQueryAt("#42 and more")).toBeNull();
    });
  });
});

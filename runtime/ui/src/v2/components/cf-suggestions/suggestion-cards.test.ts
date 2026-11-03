import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { CellHandle, CellRef } from "@commonfabric/runtime-client";

import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import {
  drawnCards,
  isShownEntry,
  isUnobscuredEntry,
  lookOf,
  type SuggestionCard,
} from "./suggestion-cards.ts";

const SPACE = "did:key:list-space";

/** A handle on its own cell, standing in for a piece a card refers to. */
function piece(id: string, ref: Partial<CellRef> = {}): CellHandle {
  return createMockCellHandle<unknown>({}, {
    id: `of:${id}` as CellRef["id"],
    space: SPACE as CellRef["space"],
    ...ref,
  });
}

const here = piece("here");
const elsewhere = piece("elsewhere");

/** A row's `about`: the JSON of `links`, as intake stores it. */
function aboutOf(...links: unknown[]): string {
  return JSON.stringify(links);
}

/** A sigil link carrying `payload`. */
function link(payload: Record<string, unknown>): unknown {
  return { "/": { "link@1": payload } };
}

/** The ids of the cards drawn at `here` from `cards`. */
function drawnIds(
  cards: SuggestionCard[],
  options: { tags?: string[]; listSpace?: string } = {},
): string[] {
  return drawnCards(cards, here, options.tags, options.listSpace ?? SPACE)
    .map(({ card }) => card.id);
}

/** An observer entry reporting only the fields the element reads. */
function entry(
  fields: {
    isIntersecting: boolean;
    intersectionRatio: number;
    isVisible?: boolean;
  },
): IntersectionObserverEntry {
  return fields as unknown as IntersectionObserverEntry;
}

describe("suggestion-cards", () => {
  describe("drawnCards", () => {
    it("returns no cards when about is not a cell", () => {
      expect(drawnCards([{ id: "one", anchor: here }], {}, undefined, SPACE))
        .toEqual([]);
    });

    it("returns each drawn card with its position in the list", () => {
      const cards: SuggestionCard[] = [
        { id: "elsewhere", anchor: elsewhere },
        { id: "here", anchor: here },
      ];
      expect(drawnCards(cards, here, undefined, SPACE)).toEqual([
        { card: cards[1], index: 1 },
      ]);
    });

    it("draws by anchor, then the first link of about, then act_target", () => {
      expect(drawnIds([
        { id: "anchored", anchor: here },
        { id: "anchored-elsewhere", anchor: elsewhere, about: aboutOf() },
        { id: "shelf-only", anchor: null, act_target: here },
        { id: "first-about", about: aboutOf(here.toSigilLink()) },
        {
          id: "second-about",
          about: aboutOf(elsewhere.toSigilLink(), here.toSigilLink()),
        },
        { id: "act-target", act_target: here },
        {
          id: "about-ahead-of-act",
          about: aboutOf(elsewhere.toSigilLink()),
          act_target: here,
        },
        { id: "nothing" },
      ])).toEqual(["anchored", "first-about", "act-target"]);
    });

    it("skips a card without a string id and a repeated id", () => {
      expect(drawnIds([
        { title: "no id", anchor: here } as unknown as SuggestionCard,
        { id: 7, anchor: here } as unknown as SuggestionCard,
        { id: "one", title: "first", anchor: here },
        { id: "one", title: "second", anchor: here },
        undefined as unknown as SuggestionCard,
      ])).toEqual(["one"]);
    });

    it("draws a different handle on the same cell, in the same scope", () => {
      expect(drawnIds([
        { id: "same-cell", anchor: piece("here") },
        { id: "named-scope", anchor: piece("here", { scope: "space" }) },
        { id: "other-path", anchor: piece("here", { path: ["title"] }) },
        { id: "other-space", anchor: piece("here", { space: "did:key:x" }) },
      ] as SuggestionCard[])).toEqual(["same-cell", "named-scope"]);
    });

    it("reads a link in about with no space as in the list's space", () => {
      const cards: SuggestionCard[] = [
        { id: "spaceless", about: aboutOf(link({ id: "of:here" })) },
      ];
      expect(drawnIds(cards)).toEqual(["spaceless"]);
      expect(drawnIds(cards, { listSpace: "did:key:other" })).toEqual([]);
      expect(drawnCards(cards, here, undefined, undefined)).toEqual([]);
    });

    it("compares the scope and path a link in about names", () => {
      expect(drawnIds([
        {
          id: "space-scope",
          about: aboutOf(link({ id: "of:here", scope: "space", path: [] })),
        },
        {
          id: "with-path",
          about: aboutOf(link({ id: "of:here", path: ["title"] })),
        },
        { id: "no-id", about: aboutOf(link({ space: SPACE })) },
      ])).toEqual(["space-scope"]);
    });

    it("falls back to act_target when the first entry of about is not a link", () => {
      expect(drawnIds([
        { id: "not-json", about: "here", act_target: here },
        { id: "not-array", about: JSON.stringify({}), act_target: here },
        { id: "empty", about: aboutOf(), act_target: here },
        { id: "string", about: aboutOf("of:here"), act_target: here },
        { id: "array", about: aboutOf([]), act_target: here },
        { id: "no-envelope", about: aboutOf({ "/": 1 }), act_target: here },
        { id: "no-payload", about: aboutOf({ "/": {} }), act_target: here },
        { id: "bad-id", about: aboutOf(link({ id: 1 })), act_target: here },
        {
          id: "bad-space",
          about: aboutOf(link({ id: "of:here", space: 1 })),
          act_target: here,
        },
        {
          id: "bad-scope",
          about: aboutOf(link({ id: "of:here", scope: 1 })),
          act_target: here,
        },
        {
          id: "bad-path",
          about: aboutOf(link({ id: "of:here", path: [1] })),
          act_target: here,
        },
        {
          id: "path-not-array",
          about: aboutOf(link({ id: "of:here", path: "title" })),
          act_target: here,
        },
        { id: "neither", about: "here" },
      ])).toEqual([
        "not-json",
        "not-array",
        "empty",
        "string",
        "array",
        "no-envelope",
        "no-payload",
        "bad-id",
        "bad-space",
        "bad-scope",
        "bad-path",
        "path-not-array",
      ]);
    });

    it("draws only cards carrying one of the tags, when tags are given", () => {
      const cards: SuggestionCard[] = [
        { id: "tagged", anchor: here, tags: JSON.stringify(["food", "trip"]) },
        { id: "other-tag", anchor: here, tags: JSON.stringify(["work"]) },
        { id: "not-json", anchor: here, tags: "trip" },
        { id: "not-array", anchor: here, tags: JSON.stringify("trip") },
        { id: "untagged", anchor: here },
      ];
      expect(drawnIds(cards, { tags: ["trip"] })).toEqual(["tagged"]);
      expect(drawnIds(cards, { tags: [] })).toEqual([]);
      expect(drawnIds(cards)).toEqual([
        "tagged",
        "other-tag",
        "not-json",
        "not-array",
        "untagged",
      ]);
    });
  });

  describe("lookOf", () => {
    it("returns the same look for the same card at the same position", () => {
      const card: SuggestionCard = {
        id: "one",
        card_revision: "r1",
        title: "Plant",
        body: "Water it",
        act_target: here,
      };
      expect(lookOf(card, 0)).toBe(
        lookOf({ ...card, act_target: piece("here") }, 0),
      );
    });

    it("returns a different look when what a person sees or acts on changes", () => {
      const card: SuggestionCard = { id: "one", act_target: here };
      const look = lookOf(card, 0);
      expect([
        lookOf(card, 1),
        lookOf({ ...card, card_revision: "r2" }, 0),
        lookOf({ ...card, title: "Delete" }, 0),
        lookOf({ ...card, body: "Gone" }, 0),
        lookOf({ ...card, act_target: elsewhere }, 0),
        lookOf({ ...card, act_target: null }, 0),
      ]).not.toContain(look);
    });
  });

  describe("isShownEntry", () => {
    it("returns true only for an intersecting entry at least half on screen", () => {
      expect([
        isShownEntry(entry({ isIntersecting: true, intersectionRatio: 0.5 })),
        isShownEntry(entry({ isIntersecting: true, intersectionRatio: 0.49 })),
        isShownEntry(entry({ isIntersecting: false, intersectionRatio: 1 })),
      ]).toEqual([true, false, false]);
    });
  });

  describe("isUnobscuredEntry", () => {
    it("returns false only when the browser reports the card obscured", () => {
      const shown = { isIntersecting: true, intersectionRatio: 1 };
      expect([
        isUnobscuredEntry(entry({ ...shown, isVisible: true })),
        isUnobscuredEntry(entry({ ...shown, isVisible: false })),
        isUnobscuredEntry(entry(shown)),
      ]).toEqual([true, false, true]);
    });
  });
});

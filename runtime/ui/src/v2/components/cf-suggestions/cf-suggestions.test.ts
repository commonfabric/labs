// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import type { CellHandle, CellRef } from "@commonfabric/runtime-client";

import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import {
  CFSuggestions,
  type SuggestionCard,
  type SuggestionEventDetail,
} from "./index.ts";

/**
 * Stands in for the browser's `IntersectionObserver`, which happy-dom never
 * calls, so that a test reports what the browser would.
 */
class FakeIntersectionObserver implements IntersectionObserver {
  /** Every observer made since the test began. */
  static made: FakeIntersectionObserver[] = [];

  readonly root = null;
  readonly rootMargin = "0px";
  readonly scrollMargin = "0px";
  readonly thresholds: readonly number[] = [];
  readonly observed = new Set<Element>();

  constructor(readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.made.push(this);
  }

  observe(target: Element) {
    this.observed.add(target);
  }

  unobserve(target: Element) {
    this.observed.delete(target);
  }

  disconnect() {
    this.observed.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

/** How the browser reports one card. */
type Report = {
  /** The share of the card on screen. */
  ratio?: number;
  /** Whether nothing covers, fades, or transforms the card, where tracked. */
  isVisible?: boolean;
  /** When the browser took the report. */
  time?: number;
};

/** The browser's report on `target`. */
function entryFor(
  target: Element,
  { ratio = 1, isVisible, time = performance.now() }: Report,
): IntersectionObserverEntry {
  const rect = new DOMRect();
  const entry = {
    boundingClientRect: rect,
    intersectionRect: rect,
    rootBounds: null,
    target,
    time,
    intersectionRatio: ratio,
    isIntersecting: ratio > 0,
    isVisible,
  };
  return entry;
}

/**
 * Reports each card of `element` named in `reports` to the observers watching
 * it, in one batch, as the browser does.
 */
function report(element: CFSuggestions, reports: Record<string, Report>) {
  const entries = Object.entries(reports).map(([id, state]) =>
    entryFor(cardOf(element, id), state)
  );
  for (const observer of FakeIntersectionObserver.made) {
    const mine = entries.filter((entry) => observer.observed.has(entry.target));
    if (mine.length) observer.callback(mine, observer);
  }
}

/** A handle on its own cell, standing in for a piece a card refers to. */
function piece(id: string): CellHandle {
  return createMockCellHandle<unknown>({}, {
    id: `of:${id}` as CellRef["id"],
  });
}

const here = piece("here");
const elsewhere = piece("elsewhere");

/**
 * A handle on the element of a `.map()`, a cell holding a link to `here`.
 * `publish()` moves the link to another thing, as inserting an entry above
 * the element does.
 */
function mapElementLinkingToHere() {
  const element = createMockCellHandle<unknown>({}, {
    id: "of:mapped-list" as CellRef["id"],
    path: ["element"],
  });
  let current = here;
  const callbacks = new Set<(value: CellHandle) => void>();
  Object.assign(element, {
    resolveAsCell: () => Promise.resolve(current),
    asSchema: () => ({
      sync: () => Promise.resolve(current),
      subscribe(callback: (value: CellHandle) => void) {
        callback(current);
        callbacks.add(callback);
        return () => callbacks.delete(callback);
      },
    }),
  });
  const publish = (next: CellHandle) => {
    current = next;
    for (const callback of [...callbacks]) callback(next);
  };
  return { element, publish };
}

/**
 * Mounts the element over `items`, anchored at `about` (by default `here`),
 * and records the events it fires once `about` has resolved.
 */
async function suggestions(
  items: CellHandle<SuggestionCard[]> | SuggestionCard[],
  options: { tags?: string[]; about?: CellHandle } = {},
) {
  const element = new CFSuggestions();
  const taken: SuggestionEventDetail[] = [];
  const seen: SuggestionEventDetail[] = [];
  element.addEventListener("cf-suggestion-take", (event) => {
    if (event instanceof CustomEvent) taken.push(event.detail);
  });
  element.addEventListener("cf-suggestion-seen", (event) => {
    if (event instanceof CustomEvent) seen.push(event.detail);
  });
  element.items = items;
  element.about = options.about ?? here;
  element.tags = options.tags;
  await mount(element);
  await element.accessForTestingOnly.aboutResolved;
  await element.updateComplete;
  return { element, taken, seen };
}

const cardOf = (element: CFSuggestions, id: string) =>
  element.shadowRoot!.querySelector(`.card[data-card-id="${id}"]`)!;

const takeButtonOf = (element: CFSuggestions, id: string) =>
  cardOf(element, id).querySelector<HTMLButtonElement>(".take")!;

/** The ids of the cards the element draws, in order. */
const drawnIds = (element: CFSuggestions) =>
  Array.from(
    element.shadowRoot!.querySelectorAll<HTMLElement>(".card"),
    (card) => card.dataset.cardId,
  );

/** Clicks the take button of card `id` as a person would. */
function take(element: CFSuggestions, id: string) {
  const click = new MouseEvent("click", { bubbles: true, composed: true });
  // happy-dom marks no event trusted; a browser marks a person's click so.
  Object.defineProperty(click, "isTrusted", { value: true });
  takeButtonOf(element, id).dispatchEvent(click);
}

describe("cf-suggestions", () => {
  const { IntersectionObserver } = globalThis;

  beforeEach(() => {
    FakeIntersectionObserver.made = [];
    globalThis.IntersectionObserver = FakeIntersectionObserver;
  });

  afterEach(() => {
    document.body.replaceChildren();
    globalThis.IntersectionObserver = IntersectionObserver;
  });

  it("registers CFSuggestions as cf-suggestions", () => {
    expect(customElements.get("cf-suggestions")).toBe(CFSuggestions);
  });

  it("draws nothing and holds nothing takeable before it is bound", () => {
    const element = new CFSuggestions();
    const access = element.accessForTestingOnly;
    expect(access.drawn).toEqual([]);
    expect(access.isTakeable("one")).toBe(false);
    access.minimumShownMs = 0;
    expect(access.minimumShownMs).toBe(0);
  });

  it("emits no take for an untrusted event", () => {
    const element = new CFSuggestions();
    const taken: Event[] = [];
    element.addEventListener(
      "cf-suggestion-take",
      (event) => taken.push(event),
    );
    element.accessForTestingOnly.take(new Event("click"));
    expect(taken).toEqual([]);
  });

  describe("render()", () => {
    it("draws the cards anchored at `about`, in rank order, with their words", async () => {
      const { element } = await suggestions([
        { id: "one", title: "Book a table", body: "For two", anchor: here },
        { id: "elsewhere", anchor: elsewhere },
        { id: "two", anchor: here },
      ]);
      expect(drawnIds(element)).toEqual(["one", "two"]);
      expect(element.hasAttribute("empty")).toBe(false);
      expect(cardOf(element, "one").querySelector(".title")!.textContent)
        .toBe("Book a table");
      expect(cardOf(element, "one").querySelector(".body")!.textContent)
        .toBe("For two");
      expect(cardOf(element, "two").querySelector(".title")!.textContent)
        .toBe("");
      expect(takeButtonOf(element, "one").getAttribute("aria-label")).toBe(
        "Take: Book a table",
      );
      expect(takeButtonOf(element, "two").getAttribute("aria-label")).toBe(
        "Take",
      );
    });

    it("draws only cards carrying one of its tags", async () => {
      const { element } = await suggestions([
        { id: "tagged", anchor: here, tags: JSON.stringify(["travel"]) },
        { id: "other-tag", anchor: here, tags: JSON.stringify(["work"]) },
      ], { tags: ["travel"] });
      expect(drawnIds(element)).toEqual(["tagged"]);
    });

    it("marks itself empty while it draws no card", async () => {
      const { element } = await suggestions([
        { id: "elsewhere", anchor: elsewhere },
      ]);
      expect(drawnIds(element)).toEqual([]);
      expect(element.hasAttribute("empty")).toBe(true);
    });

    it("draws the cards a bound list holds", async () => {
      const list = createMockCellHandle<SuggestionCard[]>([
        { id: "one", anchor: here },
        { id: "two", anchor: elsewhere },
      ]);
      const { element } = await suggestions(list);
      expect(drawnIds(element)).toEqual(["one"]);
    });

    it("draws the cards of the thing `about`'s link moves to", async () => {
      const { element: about, publish } = mapElementLinkingToHere();
      const { element } = await suggestions([
        { id: "here", anchor: here },
        { id: "elsewhere", anchor: elsewhere },
      ], { about });
      expect(drawnIds(element)).toEqual(["here"]);
      publish(elsewhere);
      await element.accessForTestingOnly.aboutResolved;
      await element.updateComplete;
      expect(drawnIds(element)).toEqual(["elsewhere"]);
    });

    it("draws nothing once its items are unset", async () => {
      const { element } = await suggestions([{ id: "one", anchor: here }]);
      element.items = undefined;
      await element.updateComplete;
      expect(drawnIds(element)).toEqual([]);
    });
  });

  describe("cf-suggestion-seen", () => {
    it("fires once a card is shown, and only once", async () => {
      const { element, seen } = await suggestions([
        { id: "one", card_revision: "r1", title: "One", anchor: here },
        { id: "two", anchor: here },
      ]);
      report(element, { one: {}, two: { ratio: 0.4 } });
      expect(seen.map(({ id }) => id)).toEqual(["one"]);
      expect(seen[0].card_revision).toBe("r1");
      expect(seen[0].card).toMatchObject({ id: "one", title: "One" });

      report(element, { one: { ratio: 0 } });
      report(element, { one: {}, two: {} });
      expect(seen.map(({ id }) => id)).toEqual(["one", "two"]);
      expect("card_revision" in seen[1]).toBe(false);
    });

    it("fires for a card shown but obscured", async () => {
      const { element, seen } = await suggestions([{
        id: "one",
        anchor: here,
      }]);
      report(element, { one: { isVisible: false } });
      expect(seen.map(({ id }) => id)).toEqual(["one"]);
    });

    it("ignores a report taken before the card was drawn as it is", async () => {
      const { element, seen } = await suggestions([{
        id: "one",
        anchor: here,
      }]);
      report(element, { one: { time: -1 } });
      expect(seen).toEqual([]);
    });

    it("ignores a report on a card no longer anchored at `about`, before it is redrawn", async () => {
      const { element: about, publish } = mapElementLinkingToHere();
      const { element, seen } = await suggestions([
        { id: "one", anchor: here },
      ], { about });
      publish(elsewhere);
      report(element, { one: {} });
      expect(seen).toEqual([]);
    });

    it("fires for nothing where the browser cannot report visibility", async () => {
      const descriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        "IntersectionObserver",
      )!;
      Reflect.deleteProperty(globalThis, "IntersectionObserver");
      try {
        const { element, taken } = await suggestions([
          { id: "one", anchor: here },
        ]);
        expect(drawnIds(element)).toEqual(["one"]);
        element.accessForTestingOnly.minimumShownMs = 0;
        take(element, "one");
        expect(taken).toEqual([]);
        expect(element.accessForTestingOnly.isTakeable("one")).toBe(false);
      } finally {
        Object.defineProperty(globalThis, "IntersectionObserver", descriptor);
      }
    });
  });

  describe("cf-suggestion-take", () => {
    it("fires for a person's click on a card shown long enough", async () => {
      const { element, taken } = await suggestions([
        { id: "one", card_revision: "r1", anchor: here },
        { id: "two", anchor: here },
      ]);
      element.accessForTestingOnly.minimumShownMs = 0;
      report(element, { one: {}, two: { isVisible: true } });
      take(element, "two");
      take(element, "one");
      expect(taken.map(({ id }) => id)).toEqual(["two", "one"]);
      expect(taken[1].card_revision).toBe("r1");
      expect(taken[1].card).toMatchObject({ id: "one" });
    });

    it("fires for nothing before the browser has reported the card", async () => {
      const { element, taken } = await suggestions([
        { id: "one", anchor: here },
      ]);
      element.accessForTestingOnly.minimumShownMs = 0;
      take(element, "one");
      expect(taken).toEqual([]);
    });

    it("fires for nothing until the card has been shown for the minimum time", async () => {
      const { element, taken } = await suggestions([
        { id: "one", anchor: here },
      ]);
      report(element, { one: {} });
      expect(element.accessForTestingOnly.isTakeable("one")).toBe(true);
      take(element, "one");
      expect(taken).toEqual([]);
    });

    it("counts the minimum time from the first unobscured report", async () => {
      const { element, taken } = await suggestions([
        { id: "one", anchor: here },
      ]);
      element.accessForTestingOnly.minimumShownMs = 0;
      report(element, { one: {} });
      report(element, { one: { time: performance.now() + 10_000 } });
      take(element, "one");
      expect(taken.map(({ id }) => id)).toEqual(["one"]);
    });

    it("fires for nothing from a card obscured or taken off screen", async () => {
      const { element, taken } = await suggestions([
        { id: "one", anchor: here },
        { id: "two", anchor: here },
      ]);
      element.accessForTestingOnly.minimumShownMs = 0;
      report(element, { one: {}, two: {} });
      report(element, { one: { isVisible: false }, two: { ratio: 0.2 } });
      take(element, "one");
      take(element, "two");
      expect(taken).toEqual([]);
      expect(element.accessForTestingOnly.isTakeable("one")).toBe(false);
      expect(element.accessForTestingOnly.isTakeable("two")).toBe(false);
    });

    it("fires for nothing from a script's click", async () => {
      const { element, taken } = await suggestions([
        { id: "one", anchor: here },
      ]);
      element.accessForTestingOnly.minimumShownMs = 0;
      report(element, { one: {} });
      takeButtonOf(element, "one").click();
      expect(taken).toEqual([]);
    });

    it("fires for nothing from a trusted click that is not on a take button", async () => {
      const { element, taken } = await suggestions([
        { id: "one", anchor: here },
      ]);
      const click = new MouseEvent("click");
      Object.defineProperty(click, "isTrusted", { value: true });
      element.accessForTestingOnly.take(click);
      expect(taken).toEqual([]);
    });

    it("fires for nothing from a card no longer anchored at `about`, before it is redrawn", async () => {
      const { element: about, publish } = mapElementLinkingToHere();
      const { element, taken } = await suggestions([
        { id: "one", anchor: here },
      ], { about });
      element.accessForTestingOnly.minimumShownMs = 0;
      report(element, { one: {} });
      publish(elsewhere);
      take(element, "one");
      expect(taken).toEqual([]);
    });

    it("makes a rewritten card wait for a fresh report", async () => {
      const { element, taken } = await suggestions([
        { id: "one", title: "Before", anchor: here },
      ]);
      element.accessForTestingOnly.minimumShownMs = 0;
      report(element, { one: {} });
      element.items = [{ id: "one", title: "After", anchor: here }];
      await element.updateComplete;
      take(element, "one");
      expect(taken).toEqual([]);

      report(element, { one: {} });
      take(element, "one");
      expect(taken.map(({ id }) => id)).toEqual(["one"]);
    });

    it("keeps an unchanged card takeable across a redraw", async () => {
      const { element, taken } = await suggestions([
        { id: "one", anchor: here },
        { id: "two", anchor: elsewhere },
      ]);
      element.accessForTestingOnly.minimumShownMs = 0;
      report(element, { one: {} });
      element.items = [{ id: "one", anchor: here }];
      await element.updateComplete;
      take(element, "one");
      expect(taken.map(({ id }) => id)).toEqual(["one"]);
    });

    it("fires again only after a fresh report once the element is reattached", async () => {
      const { element, taken } = await suggestions([
        { id: "one", anchor: here },
      ]);
      element.accessForTestingOnly.minimumShownMs = 0;
      report(element, { one: {} });
      element.remove();
      expect(element.accessForTestingOnly.isTakeable("one")).toBe(false);

      document.body.append(element);
      await element.accessForTestingOnly.aboutResolved;
      await element.updateComplete;
      take(element, "one");
      expect(taken).toEqual([]);

      report(element, { one: {} });
      take(element, "one");
      expect(taken.map(({ id }) => id)).toEqual(["one"]);
    });
  });

  describe("accessForTestingOnly", () => {
    describe("nextReport()", () => {
      it("resolves once the browser next reports", async () => {
        const { element } = await suggestions([{ id: "one", anchor: here }]);
        let reported = false;
        const next = element.accessForTestingOnly.nextReport().then(() => {
          reported = true;
        });
        await Promise.resolve();
        expect(reported).toBe(false);
        report(element, { one: {} });
        await next;
        expect(reported).toBe(true);
      });
    });

    describe("drawn", () => {
      it("returns the cards drawn", async () => {
        const card = { id: "one", anchor: here };
        const { element } = await suggestions([card]);
        expect(element.accessForTestingOnly.drawn).toEqual([card]);
      });
    });
  });
});

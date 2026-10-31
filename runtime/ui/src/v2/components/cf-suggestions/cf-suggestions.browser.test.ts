import { expect } from "@std/expect";
import { pressKey } from "@commonfabric/deno-web-test/commands";
import {
  type CellHandle,
  type CellRef,
  isCellHandle,
} from "@commonfabric/runtime-client";

import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import {
  CFSuggestions,
  type SuggestionCard,
  type SuggestionEventDetail,
} from "./index.ts";

/** A handle on its own cell, standing in for a piece a card refers to. */
function piece(id: string): CellHandle {
  return createMockCellHandle<unknown>({}, {
    id: `of:${id}` as CellRef["id"],
  });
}

const here = piece("here");
const elsewhere = piece("elsewhere");
const suggester = piece("suggester");

/** The ids of the cards the element draws, in order. */
function drawnIds(element: CFSuggestions): (string | undefined)[] {
  return Array.from(
    element.shadowRoot?.querySelectorAll<HTMLElement>(".card") ?? [],
    (card) => card.dataset.cardId,
  );
}

/**
 * Mounts the element over `items`, anchored at `here`, and records the events
 * it fires. `hidden` mounts it off screen, and `faded` inside a translucent
 * ancestor.
 */
async function mount(
  items: CellHandle<SuggestionCard[]> | SuggestionCard[],
  options: { hidden?: boolean; faded?: boolean; tags?: string[] } = {},
) {
  const element = document.createElement("cf-suggestions") as CFSuggestions;
  const taken: SuggestionEventDetail[] = [];
  const seen: SuggestionEventDetail[] = [];
  element.addEventListener(
    "cf-suggestion-take",
    (event) => taken.push((event as CustomEvent).detail),
  );
  element.addEventListener(
    "cf-suggestion-seen",
    (event) => seen.push((event as CustomEvent).detail),
  );
  const container = document.createElement("div");
  // Pinned to the viewport, whatever the test page holds above it.
  Object.assign(container.style, {
    position: "fixed",
    top: options.hidden ? "200vh" : "0",
    left: "0",
    width: "100vw",
  });
  if (options.faded) container.style.opacity = "0.5";
  container.append(element);
  element.items = items;
  element.about = here;
  element.tags = options.tags;
  document.body.append(container);
  await element.updateComplete;
  return {
    element,
    taken,
    seen,
    [Symbol.dispose]: () => container.remove(),
  };
}

/** Resolves once the element has announced `count` cards as seen. */
function seenCount(element: CFSuggestions, count: number): Promise<void> {
  let total = 0;
  return new Promise((resolve) => {
    element.addEventListener("cf-suggestion-seen", () => {
      if (++total === count) resolve();
    });
  });
}

/** Takes the element's `index`th drawn card with a trusted Enter press. */
async function pressTake(element: CFSuggestions, index = 0): Promise<void> {
  element.shadowRoot!.querySelectorAll<HTMLButtonElement>(".take")[index]
    .focus();
  await pressKey("Enter");
}

Deno.test("cf-suggestions draws only the cards anchored at about, in rank order", async () => {
  using page = await mount([
    { id: "first-about", about: [here, elsewhere] },
    { id: "other-about", about: [elsewhere, here] },
    { id: "act-target", act: { target: here } },
    { id: "act-elsewhere", act: { target: elsewhere }, source: here },
    { id: "source", source: here },
    { id: "source-elsewhere", source: suggester },
    { id: "outside-source", source: "did:key:outside" },
    { id: "no-anchor" },
    { title: "no id", about: [here] } as unknown as SuggestionCard,
  ]);
  expect(page.element).toBeInstanceOf(CFSuggestions);
  expect(drawnIds(page.element)).toEqual([
    "first-about",
    "act-target",
    "source",
  ]);
});

Deno.test("cf-suggestions draws by a card's own anchor ahead of what it is about", async () => {
  using page = await mount([
    { id: "anchored-here", anchor: here, about: [elsewhere] },
    { id: "anchored-elsewhere", anchor: elsewhere, about: [here] },
  ]);
  expect(drawnIds(page.element)).toEqual(["anchored-here"]);
});

Deno.test("cf-suggestions draws a handle on the same cell as about", async () => {
  using page = await mount([{ id: "same-cell", about: [piece("here")] }]);
  expect(drawnIds(page.element)).toEqual(["same-cell"]);
});

Deno.test("cf-suggestions draws only cards carrying one of its tags, when it has tags", async () => {
  using page = await mount([
    { id: "tagged", about: [here], tags: ["food", "travel"] },
    { id: "other-tag", about: [here], tags: ["work"] },
    { id: "untagged", about: [here] },
  ], { tags: ["travel"] });
  expect(drawnIds(page.element)).toEqual(["tagged"]);
});

Deno.test("cf-suggestions hides itself while it draws no card", async () => {
  using page = await mount([{ id: "elsewhere", about: [elsewhere] }]);
  expect(page.element.hasAttribute("empty")).toBe(true);
  expect(getComputedStyle(page.element).display).toBe("none");
});

Deno.test("cf-suggestions announces a card seen once it is shown, and only once", async () => {
  const items: SuggestionCard[] = [
    { id: "one", revision: "r1", about: [here] },
    { id: "two", about: [here] },
    { id: "elsewhere", about: [elsewhere] },
  ];
  const element = document.createElement("cf-suggestions") as CFSuggestions;
  const shown = seenCount(element, 2);
  const seen: SuggestionEventDetail[] = [];
  element.addEventListener(
    "cf-suggestion-seen",
    (event) => seen.push((event as CustomEvent).detail),
  );
  element.items = items;
  element.about = here;
  const container = document.createElement("div");
  Object.assign(container.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100vw",
  });
  container.append(element);
  document.body.append(container);
  try {
    await shown;
    expect(seen).toEqual([
      { id: "one", revision: "r1", card: items[0] },
      { id: "two", card: items[1] },
    ]);
    // A card that comes back into view has already been seen.
    element.remove();
    const again = seenCount(element, 1);
    container.append(element);
    element.items = [...items, { id: "three", about: [here] }];
    await again;
    expect(seen.map(({ id }) => id)).toEqual(["one", "two", "three"]);
  } finally {
    container.remove();
  }
});

Deno.test("cf-suggestions announces no card seen while it is off screen", async () => {
  using page = await mount([{ id: "hidden", about: [here] }], {
    hidden: true,
  });
  await page.element.accessForTestingOnly.nextReport();
  expect(page.seen).toEqual([]);
  expect(drawnIds(page.element)).toEqual(["hidden"]);
});

Deno.test("cf-suggestions announces a take on a trusted click of a shown card", async () => {
  const items: SuggestionCard[] = [
    { id: "one", about: [here] },
    { id: "two", revision: "r2", about: [here] },
  ];
  using page = await mount(items);
  page.element.accessForTestingOnly.minimumShownMs = 0;
  await page.element.accessForTestingOnly.nextReport();
  await pressTake(page.element, 1);
  expect(page.taken).toEqual([{ id: "two", revision: "r2", card: items[1] }]);
});

Deno.test("cf-suggestions links a take to the card's entry in a bound list", async () => {
  const items = createMockCellHandle<SuggestionCard[]>([
    { id: "elsewhere", about: [elsewhere] },
    { id: "here", about: [here] },
  ]);
  using page = await mount(items);
  page.element.accessForTestingOnly.minimumShownMs = 0;
  await page.element.updateComplete;
  await page.element.accessForTestingOnly.nextReport();
  await pressTake(page.element);
  expect(page.taken.map(({ id }) => id)).toEqual(["here"]);
  const card = page.taken[0].card;
  expect(isCellHandle(card)).toBe(true);
  expect((card as CellHandle).ref().path).toEqual(["1"]);
});

Deno.test("cf-suggestions announces no take for a scripted click", async () => {
  using page = await mount([{ id: "one", about: [here] }]);
  page.element.accessForTestingOnly.minimumShownMs = 0;
  await page.element.accessForTestingOnly.nextReport();
  const button = page.element.shadowRoot!.querySelector<HTMLButtonElement>(
    ".take",
  )!;
  button.click();
  button.dispatchEvent(
    new MouseEvent("click", { bubbles: true, composed: true }),
  );
  page.element.accessForTestingOnly.take(new MouseEvent("click"));
  expect(page.taken).toEqual([]);
});

Deno.test("cf-suggestions announces no take for a trusted click on a card off screen", async () => {
  using page = await mount([{ id: "hidden", about: [here] }], {
    hidden: true,
  });
  page.element.accessForTestingOnly.minimumShownMs = 0;
  await page.element.accessForTestingOnly.nextReport();
  await pressTake(page.element);
  expect(page.taken).toEqual([]);
});

Deno.test("cf-suggestions announces a faded card seen but takes nothing from it", async () => {
  using page = await mount([{ id: "faded", about: [here] }], { faded: true });
  page.element.accessForTestingOnly.minimumShownMs = 0;
  await page.element.accessForTestingOnly.nextReport();
  await pressTake(page.element);
  expect(page.seen.map(({ id }) => id)).toEqual(["faded"]);
  expect(page.taken).toEqual([]);
});

Deno.test("cf-suggestions takes nothing from a card shown for less than half a second", async () => {
  using page = await mount([{ id: "one", about: [here] }]);
  await page.element.accessForTestingOnly.nextReport();
  expect(page.element.accessForTestingOnly.isTakeable("one")).toBe(true);
  await pressTake(page.element);
  expect(page.taken).toEqual([]);
});

Deno.test("cf-suggestions makes a rewritten card wait for a fresh report before it can be taken", async () => {
  using page = await mount([{ id: "one", title: "Plant", about: [here] }]);
  await page.element.accessForTestingOnly.nextReport();
  const access = page.element.accessForTestingOnly;
  expect(access.isTakeable("one")).toBe(true);
  page.element.items = [{ id: "one", title: "Delete", about: [here] }];
  await page.element.updateComplete;
  expect(access.isTakeable("one")).toBe(false);
  await page.element.accessForTestingOnly.nextReport();
  expect(access.isTakeable("one")).toBe(true);
});

Deno.test("cf-suggestions makes a moved card wait for a fresh report before it can be taken", async () => {
  const one: SuggestionCard = { id: "one", about: [here] };
  const two: SuggestionCard = { id: "two", about: [here] };
  using page = await mount([one, two]);
  await page.element.accessForTestingOnly.nextReport();
  const access = page.element.accessForTestingOnly;
  expect([access.isTakeable("one"), access.isTakeable("two")]).toEqual([
    true,
    true,
  ]);
  page.element.items = [two, one];
  await page.element.updateComplete;
  expect([access.isTakeable("one"), access.isTakeable("two")]).toEqual([
    false,
    false,
  ]);
});

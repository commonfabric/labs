// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import {
  createMockCellHandle,
  pushUpdate,
} from "../../test-utils/mock-cell-handle.ts";
import type { CFChip } from "../cf-chip/index.ts";
import { CFAttachmentsBar, type PinnedCell } from "./index.ts";

const PINNED: PinnedCell[] = [
  { path: "space/notes", name: "Notes" },
  { path: "space/todo", name: "Todo list" },
];

/** A mounted bar showing `pinnedCells`. */
const mountBar = async (
  pinnedCells: CFAttachmentsBar["pinnedCells"],
  removable = false,
): Promise<CFAttachmentsBar> => {
  const element = new CFAttachmentsBar();
  element.pinnedCells = pinnedCells;
  element.removable = removable;
  await mount(element);
  for (const chip of chipsOf(element)) await chip.updateComplete;
  return element;
};

const chipsOf = (element: CFAttachmentsBar): CFChip[] => [
  ...element.shadowRoot!.querySelectorAll<CFChip>("cf-chip"),
];

/** The names the chips in `element` show. */
const namesOf = (element: CFAttachmentsBar): string[] =>
  chipsOf(element).map((chip) => chip.textContent!.trim());

/** The details of the events named `type` that reach `element`. */
const eventsOf = (element: CFAttachmentsBar, type: string): unknown[] => {
  const details: unknown[] = [];
  element.addEventListener(
    type,
    (event) => details.push((event as CustomEvent).detail),
  );
  return details;
};

const emptyStateOf = (element: CFAttachmentsBar): string | undefined =>
  element.shadowRoot!.querySelector(".empty-state")?.textContent ?? undefined;

describe("CFAttachmentsBar", () => {
  afterEach(() => document.body.replaceChildren());

  it("registers the custom element", () => {
    expect(customElements.get("cf-attachments-bar")).toBe(CFAttachmentsBar);
  });

  it("renders an empty state when nothing is pinned", async () => {
    const element = await mount(new CFAttachmentsBar());
    expect(emptyStateOf(element)).toBe("No pinned cells");
    expect(chipsOf(element)).toEqual([]);
  });

  it("renders a chip naming each pinned cell", async () => {
    const element = await mountBar(PINNED);
    expect(emptyStateOf(element)).toBeUndefined();
    expect(namesOf(element)).toEqual(["Notes", "Todo list"]);
  });

  it("renders the pinned cells a bound cell holds, and follows its updates", async () => {
    const cell = createMockCellHandle<PinnedCell[]>([PINNED[0]]);
    const element = await mountBar(cell);
    expect(namesOf(element)).toEqual(["Notes"]);

    pushUpdate(cell, PINNED);
    await element.updateComplete;
    expect(namesOf(element)).toEqual(["Notes", "Todo list"]);

    pushUpdate(cell, []);
    await element.updateComplete;
    expect(emptyStateOf(element)).toBe("No pinned cells");
  });

  it("makes chips removable only when it is removable", async () => {
    expect(chipsOf(await mountBar(PINNED)).map((chip) => chip.removable))
      .toEqual([false, false]);
    expect(chipsOf(await mountBar(PINNED, true)).map((chip) => chip.removable))
      .toEqual([true, true]);
  });

  it("emits one `cf-click` naming the pinned cell when a chip is clicked", async () => {
    const element = await mountBar(PINNED);
    const clicks = eventsOf(element, "cf-click");
    chipsOf(element)[1].shadowRoot!.querySelector<HTMLElement>(
      ".chip-action",
    )!.click();
    expect(clicks).toEqual([{ path: "space/todo", name: "Todo list" }]);
  });

  it("emits one `cf-remove` naming the pinned cell, and no click, when a chip's remove button is clicked", async () => {
    const element = await mountBar(PINNED, true);
    const removals = eventsOf(element, "cf-remove");
    const clicks = eventsOf(element, "cf-click");
    chipsOf(element)[0].shadowRoot!.querySelector<HTMLElement>(
      ".chip-remove",
    )!.click();
    expect(removals).toEqual([{ path: "space/notes" }]);
    expect(clicks).toEqual([]);
  });
});

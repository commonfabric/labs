/**
 * Tests for what a reader actually sees on a mention pill: the short name the
 * editor's mention universe gives its destination, rendered beside the label,
 * and still clickable.
 *
 * The name reaches the pill as a `data-short-name` attribute a stylesheet
 * turns into generated content, so none of it is in the document text or in
 * `textContent` — a documented property of the form rather than a gap, which
 * `docs/mention-refs.md` states under the short name — and only a laid-out pill
 * can answer whether it is on screen. That is why these need a browser and run
 * under deno-web-test rather than `deno test`. The harness registers tests
 * through `Deno.test` and calls each one with no arguments, so the BDD
 * functions the rest of the repository uses are not available here.
 *
 * Every case here drives the component's whole path — a universe row carrying
 * `shortName`, the resolution pass that finds a mention's destination among
 * the rows, the effect that announces the row's name, the decoration that
 * carries it, and the stylesheet that draws it. Nothing dispatches the effect
 * by hand.
 *
 * One link is outside that: the mock cell network hands back whatever value a
 * handle holds, whatever schema it was read under, so nothing here would
 * notice `MentionableSchema` losing the property. `core/mentionable.test.ts`
 * is what pins that the schema carries it.
 */

import { assert, assertEquals, assertGreater } from "@std/assert";

import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { NAME } from "@commonfabric/runner/shared";
import type { CellHandle, CellRef } from "@commonfabric/runtime-client";

import type { MentionRefMap } from "../../core/mention-refs.ts";
import type { MentionableArray } from "../../core/mentionable.ts";
import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import { setRefShortNames } from "./features/mention-refs.ts";
import { CFCodeEditor } from "./index.ts";

const KEY = "a3f9zz";
const OTHER_KEY = "b7k2m1";

/** One mention in a mounted document, and what names its destination. */
interface MentionFixture {
  /** The key the mention's token carries. */
  key: string;

  /** The mention's label, which is also its destination's name. */
  label: string;

  /** The destination's cell id. */
  id: string;

  /**
   * What the universe row standing for the destination calls it. No row
   * stands for the destination where this is absent.
   */
  row?: string;

  /** The destination's own `shortName`, which it publishes where present. */
  published?: string;
}

interface Mounted {
  element: CFCodeEditor;
  destination: CellHandle<Record<string, unknown>>;
  done(): void;
}

/** The mention most cases hold, with whatever names it is given. */
function secondItem(names: Partial<MentionFixture> = {}): MentionFixture {
  return { key: KEY, label: "Second item", id: "of:item-42", ...names };
}

/**
 * An editor holding `mentions`, over a universe with a row for each one given
 * a `row` name, once those names are showing.
 *
 * Mounted rather than constructed: a pill has no width until it is laid out,
 * and width is what says whether a reader can see the name.
 */
async function mount(...mentions: MentionFixture[]): Promise<Mounted> {
  const element = new CFCodeEditor();
  element.value = `See ${
    mentions.map(({ label, key }) => `[${label}][${key}]`).join(" and ")
  } here.`;
  element.mode = "prose";
  document.body.appendChild(element);
  await element.updateComplete;
  assert(element.editorView, "the component builds an editor view");

  // Listening before anything is bound, so the announcement cannot arrive
  // ahead of the listener.
  const announced = nextAnnouncement(element);
  const destinations = mentions.map(destinationOf);
  element.mentionable = createMockCellHandle(
    mentions.flatMap(({ label, id, row }) =>
      row === undefined ? [] : [{
        [NAME]: label,
        shortName: row,
        piece: { "$link": { id, path: [] } },
      }]
    ),
    { id: "of:universe" } as Partial<CellRef>,
  ) as unknown as CellHandle<MentionableArray>;
  // Bound after the mount, which is also the order a host pattern's cells
  // arrive in: the map announces the keys, and the universe's resolution pass
  // finds each destination among its rows.
  await bindReferences(
    element,
    mentions.map(({ key }, index) => [key, destinations[index]] as const),
  );
  if (mentions.some(({ row }) => row !== undefined)) await announced;

  return {
    element,
    destination: destinations[0],
    done: () => element.remove(),
  };
}

/** The destination piece `mention` names, publishing what it publishes. */
function destinationOf(
  { label, id, published }: MentionFixture,
): CellHandle<Record<string, unknown>> {
  return createMockCellHandle<Record<string, unknown>>(
    {
      [NAME]: label,
      ...(published === undefined ? {} : { shortName: published }),
    },
    { id } as Partial<CellRef>,
  );
}

/** Point the editor's reference map at each key's destination. */
async function bindReferences(
  element: CFCodeEditor,
  destinations: ReadonlyArray<
    readonly [string, CellHandle<Record<string, unknown>>]
  >,
): Promise<void> {
  element.references = createMockCellHandle(
    Object.fromEntries(
      destinations.map((
        [key, destination],
      ) => [key, { destination, modifiedTitle: false }]),
    ),
  ) as unknown as CellHandle<MentionRefMap>;
  await element.updateComplete;
}

/**
 * The short names the editor next announces to its view.
 *
 * Heard through an update listener rather than read back after a pause. A
 * name follows the universe's resolution pass, which crosses the cell
 * connection and lands on no turn a test can name in advance. The listener
 * runs once the view has applied the announcement, so the pills carry it by
 * the time this resolves.
 */
function nextAnnouncement(
  element: CFCodeEditor,
): Promise<Readonly<Record<string, string>>> {
  const view = element.editorView;
  assert(view, "the component builds an editor view");
  const announced = Promise.withResolvers<Readonly<Record<string, string>>>();
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((update) => {
        for (const transaction of update.transactions) {
          for (const effect of transaction.effects) {
            if (effect.is(setRefShortNames)) announced.resolve(effect.value);
          }
        }
      }),
    ),
  });
  return announced.promise;
}

/** The rendered pill the editor draws over the mention labeled `label`. */
function pillOf(element: CFCodeEditor, label = "Second item"): HTMLElement {
  const pill = [
    ...(element.shadowRoot?.querySelectorAll(".cm-mention-ref-pill") ?? []),
  ].find((candidate) => candidate.textContent === label);
  assert(pill instanceof HTMLElement, `the mention ${label} renders as a pill`);
  return pill;
}

/** How wide the pill over `label` is on screen. */
function pillWidth(element: CFCodeEditor, label?: string): number {
  return pillOf(element, label).getBoundingClientRect().width;
}

Deno.test("a pill renders the short name its universe row carries, not its destination's own", async () => {
  const named = await mount(secondItem({ row: "42", published: "7" }));
  const bare = await mount(secondItem());
  try {
    assertEquals(pillOf(named.element).getAttribute("data-short-name"), "42");
    // Two pills over the same label in the same document, so the width
    // between them is the number and nothing else. Width is the assertion
    // because the name is generated content: it is in no text node, and a
    // computed `content` may hand back the unresolved `attr()` rather than
    // what it produced.
    assertGreater(pillWidth(named.element), pillWidth(bare.element));
  } finally {
    named.done();
    bare.done();
  }
});

Deno.test("a pill's width follows the short name it was given", async () => {
  const short = await mount(secondItem({ row: "4" }));
  const long = await mount(secondItem({ row: "4242" }));
  try {
    // Presence is not enough. A mis-resolved `attr()` would render some fixed
    // glyphs and widen both pills equally, so what is pinned here is that the
    // width tracks the VALUE: same label, same font, longer name, wider pill.
    assertEquals(pillOf(short.element).getAttribute("data-short-name"), "4");
    assertEquals(pillOf(long.element).getAttribute("data-short-name"), "4242");
    assertGreater(pillWidth(long.element), pillWidth(short.element));
  } finally {
    short.done();
    long.done();
  }
});

Deno.test("a pill whose destination no universe row stands for renders no marker, whatever it publishes", async () => {
  const { element, done } = await mount(
    secondItem({ published: "42" }),
    {
      key: OTHER_KEY,
      label: "Third item",
      id: "of:item-43",
      row: "43",
      published: "43",
    },
  );
  try {
    // The other mention's name is announced by the publication that decides
    // this one has none, so its arriving is what says the absence was decided
    // rather than not yet reached. Its destination publishes the name its row
    // carries, so that name arrives whichever of the two a pill reads, and
    // what the case turns on is the absence alone.
    assertEquals(
      pillOf(element, "Third item").getAttribute("data-short-name"),
      "43",
    );
    const pill = pillOf(element);
    assertEquals(pill.hasAttribute("data-short-name"), false);
    // No generated box at all rather than an empty one taking space: the
    // selector is attribute-gated, so a pill without a name gets no `::after`.
    assertEquals(globalThis.getComputedStyle(pill, "::after").content, "none");
  } finally {
    done();
  }
});

Deno.test("clicking the short name navigates to the destination", async () => {
  const { element, destination, done } = await mount(secondItem({ row: "42" }));
  try {
    const pill = pillOf(element);
    const label = document.createRange();
    label.selectNodeContents(pill);
    // The last pixel of the pill's content, which is the far end of the
    // generated number. Asserting it sits past where the label's own text
    // ends is what makes this a click on the NUMBER: with no number rendered
    // the content would end exactly where the label does, and this point
    // would be the label's own last pixel.
    const box = pill.getBoundingClientRect();
    const padding = parseFloat(globalThis.getComputedStyle(pill).paddingRight);
    const inTheNumber = box.right - padding - 1;
    assertGreater(inTheNumber, label.getBoundingClientRect().right);

    // The handler answers a click on the next turn, so the arrival to wait on
    // is the event it emits rather than any elapsed time.
    const navigated = Promise.withResolvers<CustomEvent>();
    element.addEventListener(
      "backlink-click",
      (event) => navigated.resolve(event as CustomEvent),
      { once: true },
    );
    pill.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        composed: true,
        cancelable: true,
        clientX: inTheNumber,
        clientY: box.top + box.height / 2,
      }),
    );

    const event = await navigated.promise;
    assertEquals(
      (event.detail.piece as CellHandle<unknown>).id(),
      destination.id(),
    );
  } finally {
    done();
  }
});

Deno.test("a pill drops the short name when its destination is replaced", async () => {
  // The first destination publishes the name its row carries, so the number
  // showing could have come from either; what replacing it does is what says
  // which one the pill reads.

  const { element, done } = await mount(
    secondItem({ row: "42", published: "42" }),
  );
  try {
    assertEquals(pillOf(element).getAttribute("data-short-name"), "42");
    const namedWidth = pillWidth(element);

    // The same key, pointed at a destination no universe row stands for,
    // which publishes a name of its own. The number was the row's for the
    // destination the mention used to name, so it goes with that destination,
    // and the new one's own name does not take its place.
    const announced = nextAnnouncement(element);
    await bindReferences(element, [[
      KEY,
      destinationOf(secondItem({ id: "of:item-none", published: "7" })),
    ]]);
    await announced;

    const pill = pillOf(element);
    assertEquals(pill.hasAttribute("data-short-name"), false);
    assertEquals(globalThis.getComputedStyle(pill, "::after").content, "none");
    assertGreater(namedWidth, pillWidth(element));
  } finally {
    done();
  }
});

// First, so that the document it installs is there when Lit loads.
import { mount, settle } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { defer } from "@commonfabric/async/defer";
import { NAVIGATE_EVENT, OPEN_EXTERNAL_EVENT } from "@commonfabric/navigation";
import type { CellHandle, CellRef } from "@commonfabric/runtime-client";

import { providePieceBoundary } from "../../../../../html/src/main/space-context.ts";
import { PIECE_MENU_OPEN_ATTRIBUTE } from "../cf-piece-menu/cf-piece-menu.ts";
import { createRenderableCellHandle } from "../../test-utils/mock-vdom-connection.ts";
import { CFRender, type UIVariant } from "./index.ts";

/**
 * A piece named by `id`, at the rest of its reference `ref`, that renders over
 * a mock VDOM session. Asked which variants it exports, it answers when
 * `exports` settles, with none; opening it settles as `opening` does.
 */
function pieceAt(
  id: `of:${string}`,
  {
    exports = Promise.resolve(undefined),
    opening = Promise.resolve(null),
    ref = {},
  }: {
    exports?: Promise<undefined>;
    opening?: Promise<null>;
    ref?: Partial<CellRef>;
  } = {},
) {
  const { cell, log } = createRenderableCellHandle<unknown>(undefined, {
    ...ref,
    id,
  });
  const asSchema = cell.asSchema.bind(cell);
  Object.assign(cell, {
    resolveAsCell: () => Promise.resolve(cell),
    asSchema: (...args: Parameters<typeof asSchema>) =>
      Object.assign(asSchema(...args), { sync: () => exports }),
  });
  Object.assign(cell.runtime(), {
    signal: new AbortController().signal,
    getPiece: () => opening,
  });
  return { cell, log };
}

/** A `cf-render` of `cell` at `variant`, mounted once its render settles. */
async function rendering(
  cell: CellHandle | undefined,
  variant?: UIVariant,
): Promise<CFRender> {
  const element = Object.assign(new CFRender(), { cell, variant });
  await mount(element);
  await settle();
  return element;
}

/** The chip a default chip render draws, if there is one. */
const defaultChip = (element: CFRender) =>
  element.shadowRoot!.querySelector(".render-container .chip-default cf-chip");

/** The default tile a tile render draws, if there is one. */
const defaultTile = (element: CFRender) =>
  element.shadowRoot!.querySelector(".render-container .tile-clip");

/**
 * Clicks `target` with `init`, and returns where it asked the host to go
 * through `event`. The host handles each request, cancelling it, so an
 * `OPEN_EXTERNAL_EVENT` opens no window.
 */
function navigationsFrom(
  target: Element,
  init: MouseEventInit = {},
  event = NAVIGATE_EVENT,
): unknown[] {
  const destinations: unknown[] = [];
  const listener = (request: Event) => {
    request.preventDefault();
    if (request instanceof CustomEvent) destinations.push(request.detail);
  };
  globalThis.addEventListener(event, listener);
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init }));
  globalThis.removeEventListener(event, listener);
  return destinations;
}

describe("CFRender", () => {
  afterEach(() => document.body.replaceChildren());

  describe("mounted", () => {
    it("draws a chip naming the piece at the chip variant, which navigates to it", async () => {
      const { cell } = pieceAt("of:fid1:piece-abcdef");
      const element = await rendering(cell, "chip");
      const chip = defaultChip(element);
      expect(chip?.textContent).toBe(" #abcdef");
      expect(navigationsFrom(chip!)).toEqual([{
        spaceDid: cell.space(),
        pieceId: "of:fid1:piece-abcdef",
      }]);
    });

    it("takes down a default chip, and its navigation, when the cell is cleared", async () => {
      const { cell } = pieceAt("of:fid1:piece-abcdef");
      const element = await rendering(cell, "chip");
      const chip = defaultChip(element)!;
      element.cell = undefined;
      await element.updateComplete;
      expect(defaultChip(element)).toBe(null);
      expect(navigationsFrom(chip)).toEqual([]);
    });

    it("renders again when its variant changes", async () => {
      const { cell, log } = pieceAt("of:fid1:piece-abcdef");
      const element = await rendering(cell, "full");
      expect(log.mounted.map(({ path }) => path)).toEqual([[]]);
      expect(defaultChip(element)).toBe(null);

      element.variant = "chip";
      await element.updateComplete;
      await settle();
      expect(defaultChip(element)?.textContent).toBe(" #abcdef");
      expect(log.unmounted).toHaveLength(1);
    });

    it("leaves the variant a cell no longer shown exports unrendered", async () => {
      const exports = defer<undefined>();
      const first = pieceAt("of:fid1:first-aaaaaa", {
        exports: exports.promise,
      });
      const element = Object.assign(new CFRender(), {
        cell: first.cell,
        variant: "chip",
      });
      await mount(element);
      const second = pieceAt("of:fid1:second-bbbbbb");
      element.cell = second.cell;
      await element.updateComplete;
      await settle();
      exports.resolve(undefined);
      await settle();
      const chips = element.shadowRoot!.querySelectorAll(".chip-default");
      expect([...chips].map((chip) => chip.textContent)).toEqual([
        " #bbbbbb",
      ]);
    });

    it("shows the piece when opening it fails", async () => {
      const { cell, log } = pieceAt("of:fid1:piece-abcdef", {
        opening: Promise.reject(new Error("no pattern identity")),
      });
      await rendering(cell);
      expect(log.mounted.map(({ path }) => path)).toEqual([[]]);
    });
  });

  describe("a click on the default tile", () => {
    it("navigates to the piece the tile renders", async () => {
      const { cell } = pieceAt("of:fid1:tile-piece");
      const element = await rendering(cell, "tile");
      expect(navigationsFrom(defaultTile(element)!)).toEqual([{
        spaceDid: cell.space(),
        pieceId: "of:fid1:tile-piece",
      }]);
    });

    it("keeps the piece's scope and path in the destination", async () => {
      const { cell } = pieceAt("of:fid1:tile-piece", {
        ref: { scope: "session", path: ["view", "a/b"] },
      });
      const element = await rendering(cell, "tile");
      expect(navigationsFrom(defaultTile(element)!)).toEqual([{
        spaceDid: cell.space(),
        pieceId: "of:fid1:tile-piece",
        pieceScope: "session",
        piecePath: ["view", "a/b"],
      }]);
    });

    it("offers the destination to the host as a new tab on a modifier-click", async () => {
      const { cell } = pieceAt("of:fid1:tile-piece");
      const element = await rendering(cell, "tile");
      const tile = defaultTile(element)!;
      const destination = {
        spaceDid: cell.space(),
        pieceId: "of:fid1:tile-piece",
      };
      for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
        expect(navigationsFrom(tile, modifier, OPEN_EXTERNAL_EVENT))
          .toEqual([destination]);
      }
    });

    it("logs a destination it cannot address, and navigates nowhere", async () => {
      const { cell } = pieceAt("of:fid1:tile-piece");
      const element = await rendering(cell, "tile");
      cell.space = () => {
        throw new Error("no space");
      };
      const errors: unknown[][] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => errors.push(args);
      try {
        expect(navigationsFrom(defaultTile(element)!)).toEqual([]);
      } finally {
        console.error = original;
      }
      expect(errors).toHaveLength(1);
    });
  });

  describe("a right-click", () => {
    it("opens the built-in menu over a nested piece, highlighting it rather than the renderer", async () => {
      const { cell: outer } = pieceAt("of:fid1:outer-piece");
      const element = await rendering(outer, "full");
      const { cell: inner } = pieceAt("of:fid1:inner-piece");
      const innerRoot = document.createElement("div");
      element.append(innerRoot);
      providePieceBoundary(innerRoot, inner);
      const click = new MouseEvent("contextmenu", {
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      innerRoot.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      const menu = document.querySelector("cf-piece-menu");
      expect(menu?.hasAttribute("hidden")).toBe(false);
      expect(element.hasAttribute(PIECE_MENU_OPEN_ATTRIBUTE)).toBe(false);
    });

    it("opens the built-in menu over the rendered piece, highlighting the renderer", async () => {
      const { cell } = pieceAt("of:fid1:outer-piece");
      const element = await rendering(cell, "full");
      element.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
      expect(element.hasAttribute(PIECE_MENU_OPEN_ATTRIBUTE)).toBe(true);
    });

    it("leaves a click with no cell to render to the platform menu", async () => {
      const element = await rendering(undefined);
      const click = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(false);
      const menu = document.querySelector("cf-piece-menu");
      expect(menu?.hasAttribute("hidden") ?? true).toBe(true);
    });
  });
});

// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import type { DID } from "@commonfabric/identity";
import { type AppView, NAVIGATE_EVENT } from "@commonfabric/navigation";

import type { PieceItem } from "../src/components/PieceList.ts";
import type { Command } from "../src/views/BaseView.ts";
import type { XHeaderView } from "../src/views/HeaderView.ts";
import { installBrowserGlobals, installGlobals } from "./browser-globals.ts";
import { templateListenerOn, templateMarkup } from "./lit-template-markup.ts";

const PAGE_HREF = "http://localhost:8000/My%20notes/current";
const SPACE: DID = "did:key:z6MkheaderMenuSpace";

/**
 * The header's own state these tests set and read, which the class keeps
 * TypeScript-`private`; everything public is read through the class's type.
 */
interface HeaderState {
  rt: unknown;
  keyStore: unknown;
  menuOpen: boolean;
  pieceListExpanded: boolean;
  headerPieceDropdownOpen: boolean;
}

/** A clipboard that records what it was given, or refuses. */
function clipboardThat(refuses: boolean) {
  const written: string[] = [];
  return {
    written,
    writeText(text: string): Promise<void> {
      if (refuses) return Promise.reject(new Error("clipboard denied"));
      written.push(text);
      return Promise.resolve();
    },
  };
}

/** A page document whose root element holds the attributes set on it. */
class TestDocument extends EventTarget {
  readonly #attributes = new Map<string, string>();

  /** The `<html>` element, which holds the `data-theme` attribute. */
  get documentElement() {
    const attributes = this.#attributes;
    return {
      style: {},
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) =>
        attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
    };
  }

  /** Returns a stand-in element, which holds nothing. */
  createElement() {
    return { style: {}, setAttribute() {}, append() {}, appendChild() {} };
  }

  /** Returns a stand-in tree walker, which walks nothing. */
  createTreeWalker() {
    return {};
  }
}

/**
 * Installs the browser globals with a clipboard (refusing where `refuses`), a
 * document that holds its attributes, and storage that holds what is written
 * to it, and returns them alongside the restore step.
 */
function installPage({ refuses = false }: { refuses?: boolean } = {}) {
  const clipboard = clipboardThat(refuses);
  const document = new TestDocument();
  const storage = new Map<string, string>();
  const restoreBrowser = installBrowserGlobals(PAGE_HREF);
  const restorePage = installGlobals({
    document,
    navigator: { platform: "", userAgent: "deno", clipboard },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    matchMedia: undefined,
  });
  return {
    clipboard,
    document,
    storage,
    restore() {
      restorePage();
      restoreBrowser();
    },
  };
}

/** The header on the piece `current` in the space named "My notes". */
async function header(): Promise<{ view: XHeaderView; state: HeaderState }> {
  const { XHeaderView } = await import("../src/views/HeaderView.ts");
  const view = new XHeaderView();
  view.view = { spaceName: "My notes", pieceId: "current" };
  view.space = SPACE;
  view.pieceId = "current";
  view.pieceTitle = "Current piece";
  return { view, state: view as unknown as HeaderState };
}

/**
 * Connects `view` the way a page does, except that updates do nothing, since
 * there is no DOM to render into. Its render root hands out one element per
 * selector, each recording when it is focused into `focused`.
 */
function connect(view: XHeaderView) {
  const focused: string[] = [];
  const elements = new Map<string, object>();
  const element = (selector: string) => {
    let found = elements.get(selector);
    if (!found) {
      found = { focus: () => focused.push(selector) };
      elements.set(selector, found);
    }
    return found;
  };
  Object.defineProperty(view, "performUpdate", { value: () => {} });
  Object.defineProperty(view, "renderRoot", {
    value: { querySelector: element },
  });
  view.connectedCallback();
  return { focused, element };
}

/** Clicks the `element` holding `text` in what `view` renders. */
function click(
  view: XHeaderView,
  element: string,
  text: string,
): unknown {
  const listener = templateListenerOn(
    view.render(),
    "click",
    view,
    element,
    text,
  );
  return listener(new Event("click"));
}

/** An Escape keypress, as the page dispatches one. */
function escape(): Event {
  return Object.assign(new Event("keydown", { cancelable: true }), {
    key: "Escape",
    isComposing: false,
  });
}

/** The commands `view` dispatches while `act` runs. */
async function commandsDuring(
  view: XHeaderView,
  act: () => unknown,
): Promise<Command[]> {
  const { SHELL_COMMAND } = await import("../src/views/BaseView.ts");
  const commands: Command[] = [];
  const record = (event: Event) => {
    if (event instanceof CustomEvent) commands.push(event.detail);
  };
  view.addEventListener(SHELL_COMMAND, record);
  try {
    await act();
  } finally {
    view.removeEventListener(SHELL_COMMAND, record);
  }
  return commands;
}

/** The views navigated to while `act` runs. */
async function navigationsDuring(act: () => unknown): Promise<AppView[]> {
  const navigations: AppView[] = [];
  const record = (event: Event) => {
    if (event instanceof CustomEvent) navigations.push(event.detail);
  };
  globalThis.addEventListener(NAVIGATE_EVENT, record);
  try {
    await act();
  } finally {
    globalThis.removeEventListener(NAVIGATE_EVENT, record);
  }
  return navigations;
}

/** Collects what `console[level]` is handed while `act` runs. */
async function loggedDuring(
  level: "warn" | "error",
  act: () => unknown,
): Promise<unknown[]> {
  const logged: unknown[] = [];
  const original = console[level];
  console[level] = (...args: unknown[]) => logged.push(args[0]);
  try {
    await act();
  } finally {
    console[level] = original;
  }
  return logged;
}

/**
 * A runtime whose favorites subscription delivers `entries` as the server's
 * list, where given, recording each write, and failing every write where
 * `failWrite` is set.
 */
function favoritesRuntime(
  { entries, failWrite = false }: {
    entries?: readonly unknown[];
    failWrite?: boolean;
  } = {},
) {
  const writes: { op: string; args: unknown[] }[] = [];
  const write = (op: string) => (...args: unknown[]) => {
    writes.push({ op, args });
    return failWrite ? Promise.reject(new Error("write failed")) : undefined;
  };
  return {
    writes,
    signal: new AbortController().signal,
    favorites: () => ({
      subscribeFavorites(deliver: (favorites: readonly unknown[]) => void) {
        if (entries) deliver(entries);
        return () => {};
      },
      addFavorite: write("add"),
      removeFavorite: write("remove"),
    }),
  };
}

const ADDRESS = { space: SPACE, pieceId: "current", scope: "space" } as const;

describe("XHeaderView menu", () => {
  let page: ReturnType<typeof installPage>;

  beforeEach(() => {
    page = installPage();
  });

  afterEach(() => {
    page.restore();
  });

  describe("opening and closing", () => {
    it("opens from the logo and moves focus to the close button", async () => {
      const { view, state } = await header();
      const { focused } = connect(view);
      try {
        click(view, "button", 'aria-label="Open menu"');
        expect(state.menuOpen).toBe(true);
        await view.updateComplete;
        expect(focused).toEqual([".menu-close"]);
      } finally {
        view.disconnectedCallback();
      }
    });

    it("closes from the close button, collapsing the piece list and returning focus to the logo", async () => {
      const { view, state } = await header();
      const { focused } = connect(view);
      try {
        state.menuOpen = true;
        state.pieceListExpanded = true;
        click(view, "button", 'aria-label="Close menu"');
        expect(state.menuOpen).toBe(false);
        expect(state.pieceListExpanded).toBe(false);
        await view.updateComplete;
        expect(focused).toEqual([".nav-picker"]);
      } finally {
        view.disconnectedCallback();
      }
    });

    it("closes when the backdrop is clicked, returning focus to the logo", async () => {
      const { view, state } = await header();
      const { focused } = connect(view);
      try {
        state.menuOpen = true;
        state.pieceListExpanded = true;
        click(view, "div", 'class="menu-backdrop"');
        expect(state.menuOpen).toBe(false);
        expect(state.pieceListExpanded).toBe(false);
        await view.updateComplete;
        expect(focused).toEqual([".nav-picker"]);
      } finally {
        view.disconnectedCallback();
      }
    });

    it("closes on an Escape pressed anywhere while connected, and not once disconnected", async () => {
      const { view, state } = await header();
      const { focused } = connect(view);
      state.menuOpen = true;
      state.pieceListExpanded = true;
      const pressed = escape();
      globalThis.dispatchEvent(pressed);
      expect(pressed.defaultPrevented).toBe(true);
      expect(state.menuOpen).toBe(false);
      expect(state.pieceListExpanded).toBe(false);
      await view.updateComplete;
      expect(focused).toEqual([".nav-picker"]);

      view.disconnectedCallback();
      state.menuOpen = true;
      globalThis.dispatchEvent(escape());
      expect(state.menuOpen).toBe(true);
    });

    it("leaves an Escape alone while nothing is open", async () => {
      const { view } = await header();
      connect(view);
      try {
        const pressed = escape();
        globalThis.dispatchEvent(pressed);
        expect(pressed.defaultPrevented).toBe(false);
      } finally {
        view.disconnectedCallback();
      }
    });

    it("expands and collapses the piece list from the title row", async () => {
      const { view, state } = await header();
      click(view, "button", 'class="piece-title-row"');
      expect(state.pieceListExpanded).toBe(true);
      click(view, "button", 'class="piece-title-row"');
      expect(state.pieceListExpanded).toBe(false);
    });

    it("opens and closes the breadcrumb's piece switcher from its trigger", async () => {
      const { view, state } = await header();
      click(view, "button", 'class="header-piece-trigger"');
      expect(state.headerPieceDropdownOpen).toBe(true);
      click(view, "button", 'class="header-piece-trigger"');
      expect(state.headerPieceDropdownOpen).toBe(false);
    });

    it("closes the piece switcher on a click outside it, and not on one inside it", async () => {
      const { view, state } = await header();
      const { element } = connect(view);
      try {
        state.headerPieceDropdownOpen = true;
        const inside = new Event("click");
        Object.defineProperty(inside, "composedPath", {
          value: () => [element(".header-piece-wrapper")],
        });
        globalThis.dispatchEvent(inside);
        expect(state.headerPieceDropdownOpen).toBe(true);

        globalThis.dispatchEvent(new Event("click"));
        expect(state.headerPieceDropdownOpen).toBe(false);
      } finally {
        view.disconnectedCallback();
      }
    });
  });

  describe("resizing", () => {
    let time: FakeTime;

    beforeEach(() => {
      time = new FakeTime();
    });

    afterEach(() => {
      time.restore();
    });

    it("marks the header as resizing until 150 ms pass with no further resize", async () => {
      const { view } = await header();
      connect(view);
      try {
        globalThis.dispatchEvent(new Event("resize"));
        expect(view.classList.contains("resizing")).toBe(true);
        time.tick(100);
        globalThis.dispatchEvent(new Event("resize"));
        time.tick(100);
        expect(view.classList.contains("resizing")).toBe(true);
        time.tick(50);
        expect(view.classList.contains("resizing")).toBe(false);
      } finally {
        view.disconnectedCallback();
      }
    });

    it("cancels the pending end of a resize when disconnected", async () => {
      const { view } = await header();
      connect(view);
      globalThis.dispatchEvent(new Event("resize"));
      view.disconnectedCallback();
      time.tick(150);
      expect(view.classList.contains("resizing")).toBe(true);

      // Disconnected, the header no longer hears resizes at all.
      view.classList.remove("resizing");
      globalThis.dispatchEvent(new Event("resize"));
      expect(view.classList.contains("resizing")).toBe(false);
    });
  });

  describe("entries", () => {
    it("signs out by clearing the key store and the identity, and closes", async () => {
      const { view, state } = await header();
      const cleared: string[] = [];
      state.keyStore = {
        clear: () => {
          cleared.push("cleared");
          return Promise.resolve();
        },
      };
      state.menuOpen = true;
      const commands = await commandsDuring(
        view,
        () => click(view, "button", "Sign out"),
      );
      expect(cleared).toEqual(["cleared"]);
      expect(commands).toEqual([{ type: "set-identity", identity: undefined }]);
      expect(state.menuOpen).toBe(false);
    });

    it("signs out without a key store, warning that there was none to clear", async () => {
      const { view, state } = await header();
      let commands: Command[] = [];
      const warnings = await loggedDuring("warn", async () => {
        commands = await commandsDuring(
          view,
          () => click(view, "button", "Sign out"),
        );
      });
      expect(warnings).toEqual(["Could not clear keystore."]);
      expect(commands).toEqual([{ type: "set-identity", identity: undefined }]);
      expect(state.menuOpen).toBe(false);
    });

    it("asks for the debugger to be shown when hidden, and hidden when shown", async () => {
      const { view, state } = await header();
      for (const shown of [false, true]) {
        view.showDebuggerView = shown;
        state.menuOpen = true;
        const commands = await commandsDuring(
          view,
          () => click(view, "button", "Toggle debug mode"),
        );
        expect(commands).toEqual([
          { type: "set-config", key: "showDebuggerView", value: !shown },
        ]);
        expect(state.menuOpen).toBe(false);
      }
    });

    it("switches the page to the other theme and offers the way back", async () => {
      const { view, state } = await header();
      state.menuOpen = true;
      click(view, "button", "Switch to dark mode");
      expect(page.storage.get("cf-theme-preference")).toBe("dark");
      expect(page.document.documentElement.getAttribute("data-theme"))
        .toBe("dark");
      expect(state.menuOpen).toBe(false);

      click(view, "button", "Switch to light mode");
      expect(page.storage.get("cf-theme-preference")).toBe("light");
      expect(templateMarkup(view.render(), { elideListeners: true })).toContain(
        "Switch to dark mode",
      );
    });

    it("goes back to the space from a piece", async () => {
      const { view, state } = await header();
      state.menuOpen = true;
      const navigations = await navigationsDuring(() =>
        click(view, "button", "Back to My notes")
      );
      expect(navigations).toEqual([{ spaceName: "My notes" }]);
      expect(state.menuOpen).toBe(false);
      expect(globalThis.location.href).toBe(PAGE_HREF);
    });

    it("goes home from the space's own page", async () => {
      const { view, state } = await header();
      view.isViewingDefaultPattern = true;
      state.menuOpen = true;
      expect(templateMarkup(view.render(), { elideListeners: true })).not
        .toContain("Back to");
      const navigations = await navigationsDuring(() =>
        click(view, "button", "Go Home")
      );
      expect(navigations).toEqual([]);
      expect(globalThis.location.href).toBe("/");
      expect(state.menuOpen).toBe(false);
    });

    it("copies the page's address and closes", async () => {
      const { view, state } = await header();
      state.menuOpen = true;
      await click(view, "button", "Copy link");
      expect(page.clipboard.written).toEqual([PAGE_HREF]);
      expect(state.menuOpen).toBe(false);
    });

    it("warns and closes when the clipboard refuses the page's address", async () => {
      page.restore();
      page = installPage({ refuses: true });
      const { view, state } = await header();
      state.menuOpen = true;
      const warnings = await loggedDuring(
        "warn",
        () => click(view, "button", "Copy link"),
      );
      expect(warnings).toEqual(["Failed to copy link to clipboard"]);
      expect(page.clipboard.written).toEqual([]);
      expect(state.menuOpen).toBe(false);
    });

    it("opens nothing for a piece picked while the header has no view", async () => {
      const { view, state } = await header();
      view.view = undefined;
      state.menuOpen = true;
      state.headerPieceDropdownOpen = true;
      const navigations = await navigationsDuring(() =>
        view.accessForTestingOnly.handlePieceSelected(
          new CustomEvent<PieceItem>("piece-selected", {
            detail: { id: "picked", name: "Picked" },
          }),
        )
      );
      expect(navigations).toEqual([]);
      expect(state.menuOpen).toBe(false);
      expect(state.headerPieceDropdownOpen).toBe(false);
    });
  });

  describe("favorite entry", () => {
    it("is absent until the piece's address is known", async () => {
      const { view } = await header();
      expect(templateMarkup(view.render(), { elideListeners: true })).not
        .toContain("Favorites");
    });

    it("adds a piece that is not a favorite, under the space's name", async () => {
      const { view, state } = await header();
      const rt = favoritesRuntime();
      state.rt = rt;
      view.pieceAddress = ADDRESS;
      await click(view, "button", "Add to Favorites");
      expect(rt.writes).toEqual([
        { op: "add", args: [ADDRESS, undefined, "My notes"] },
      ]);
      expect(templateMarkup(view.render(), { elideListeners: true })).toContain(
        "Remove from Favorites",
      );
    });

    it("removes a piece that is a favorite", async () => {
      const { view, state } = await header();
      const rt = favoritesRuntime({
        entries: [{
          cell: {
            ref: () => ({ id: "of:current", space: SPACE, scope: "space" }),
          },
        }],
      });
      state.rt = rt;
      view.pieceAddress = ADDRESS;
      view.accessForTestingOnly.ensureFavoritesSubscription();
      await click(view, "button", "Remove from Favorites");
      expect(rt.writes).toEqual([{ op: "remove", args: [ADDRESS] }]);
      expect(templateMarkup(view.render(), { elideListeners: true })).toContain(
        "Add to Favorites",
      );
    });

    it("reports a failed write and shows the favorite as it was", async () => {
      const { view, state } = await header();
      state.rt = favoritesRuntime({ failWrite: true });
      view.pieceAddress = ADDRESS;
      const errors = await loggedDuring(
        "error",
        () => click(view, "button", "Add to Favorites"),
      );
      expect(errors).toEqual(["[HeaderView] Error toggling favorite:"]);
      expect(view.accessForTestingOnly.isFavorite()).toBe(false);
      expect(templateMarkup(view.render(), { elideListeners: true })).toContain(
        "Add to Favorites",
      );
    });
  });

  describe("piece list", () => {
    it("lists nothing for a space whose piece registry holds no list", async () => {
      const { view, state } = await header();
      state.rt = {
        synced: () => Promise.resolve(),
        getPiecesListCell: () =>
          Promise.resolve({
            sync: () => Promise.resolve(),
            get: () => undefined,
          }),
      };
      state.headerPieceDropdownOpen = true;
      const { pieces } = view.accessForTestingOnly;
      await pieces.run();
      expect(pieces.value).toEqual([]);
    });

    it("leaves out a piece whose name read fails other than by refusal", async () => {
      const { view, state } = await header();
      state.rt = {
        synced: () => Promise.resolve(),
        getPiecesListCell: () =>
          Promise.resolve({
            sync: () => Promise.resolve(),
            get: () => [{ $ID: "readable" }, { $ID: "broken" }],
          }),
        getPattern: (_space: string, id: string) =>
          Promise.resolve({
            id: () => id,
            cell: () => ({
              asSchema: () => ({
                sync: () =>
                  id === "broken"
                    ? Promise.reject(new Error("decode failed"))
                    : Promise.resolve({ $NAME: "Readable" }),
              }),
            }),
          }),
      };
      state.headerPieceDropdownOpen = true;
      const { pieces } = view.accessForTestingOnly;
      await pieces.run();
      expect(pieces.value).toEqual([{ id: "readable", name: "Readable" }]);
    });
  });
});

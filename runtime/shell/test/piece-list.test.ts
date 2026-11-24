// deno-lint-ignore-file cf-imports/no-inline-module-import -- the component
// extends a bare HTMLElement as it loads, so it can only load once the test
// has installed one.

/**
 * The piece list's three faces: loading, empty, and the pieces themselves with
 * the active one marked; and that choosing a piece announces that piece.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { PieceItem } from "../src/components/PieceList.ts";
import { templateMarkup } from "./lit-template-markup.ts";

interface PieceListLike extends EventTarget {
  pieces: PieceItem[];
  loading: boolean;
  activePieceId: string | undefined;
  render(): unknown;
}

function installBrowserGlobals(): () => void {
  const originals = new Map<string, PropertyDescriptor | undefined>();

  function setGlobal(name: string, value: unknown): void {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }

  class TestHTMLElement extends EventTarget {}

  setGlobal("window", globalThis);
  setGlobal("HTMLElement", TestHTMLElement);
  setGlobal("customElements", {
    define() {},
    get() {},
    whenDefined: () => Promise.resolve(),
  });
  setGlobal("document", {
    documentElement: { style: {} },
    createElement: () => ({
      style: {},
      setAttribute() {},
      append() {},
      appendChild() {},
    }),
    createTreeWalker: () => ({}),
  });

  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}

async function makeList(): Promise<PieceListLike> {
  const { XPieceList } = await import("../src/components/PieceList.ts");
  return new XPieceList() as unknown as PieceListLike;
}

const PIECES: PieceItem[] = [
  { id: "aaaaaa", name: "First" },
  { id: "bbbbbb", name: "Second" },
];

/** The first function bound anywhere in a template result: a handler. */
function boundHandler(value: unknown): ((e: Event) => void) | undefined {
  if (typeof value === "function") return value as (e: Event) => void;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = boundHandler(item);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === "object" && "values" in value) {
    return boundHandler((value as { values: unknown[] }).values);
  }
  return undefined;
}

describe("XPieceList", () => {
  it("shows a loading status before any pieces are known", async () => {
    const restore = installBrowserGlobals();
    try {
      const list = await makeList();
      list.loading = true;
      const markup = templateMarkup(list.render());
      expect(markup).toContain("Loading pieces…");
      expect(markup).toContain('role="status"');
      expect(markup).not.toContain("No pieces found");
    } finally {
      restore();
    }
  });

  it("says when a loaded space has no pieces", async () => {
    const restore = installBrowserGlobals();
    try {
      const list = await makeList();
      const markup = templateMarkup(list.render());
      expect(markup).toContain("No pieces found");
      expect(markup).not.toContain("Loading pieces");
    } finally {
      restore();
    }
  });

  it("lists every piece by name and marks the active one", async () => {
    const restore = installBrowserGlobals();
    try {
      const list = await makeList();
      list.pieces = PIECES;
      list.activePieceId = "bbbbbb";
      const markup = templateMarkup(list.render());
      expect(markup).toContain("First");
      expect(markup).toContain("Second");
      expect(markup).toContain('data-piece-id="bbbbbb"');
      expect(markup.match(/piece-item active/g)?.length).toBe(1);
      expect(markup).not.toContain("No pieces found");
    } finally {
      restore();
    }
  });

  it("announces the chosen piece, and nothing for a click beside one", async () => {
    const restore = installBrowserGlobals();
    try {
      const list = await makeList();
      list.pieces = PIECES;
      const chosen: PieceItem[] = [];
      list.addEventListener("piece-selected", (e) => {
        chosen.push((e as CustomEvent<PieceItem>).detail);
      });
      const handler = boundHandler(list.render());
      expect(handler).toBeDefined();
      const clickOn = (row: { dataset: { pieceId: string } } | null) =>
        ({
          target: { closest: () => row },
          preventDefault() {},
          stopPropagation() {},
        }) as unknown as Event;

      handler!.call(list, clickOn({ dataset: { pieceId: "bbbbbb" } }));
      handler!.call(list, clickOn(null));
      handler!.call(list, clickOn({ dataset: { pieceId: "unknown" } }));
      expect(chosen).toEqual([{ id: "bbbbbb", name: "Second" }]);
    } finally {
      restore();
    }
  });
});

// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

/**
 * The header's offer to copy a piece's portable reference: when it is there to
 * take, and that what it writes is the reference itself.
 *
 * A reference travels — into a commit message, a chat, another space's
 * pattern — and nothing downstream can tell a wrong one from a right one, so
 * what reaches the clipboard is checked against what was handed in rather than
 * against the shape of a reference.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

/**
 * What these tests set and read. `pieceReference` and `render` are public;
 * the handler is reached through the class's own testing accessor, which
 * types it as the class does — a cast would type it as this file finds
 * convenient, and a renamed member would read `undefined` and pass.
 */
interface HeaderViewLike {
  pieceReference: string | undefined;
  menuOpen: boolean;
  render(): unknown;
  readonly accessForTestingOnly: {
    copyReference(event: Event): Promise<void>;
  };
}

/** A clipboard that records what it was given, or refuses. */
function clipboardThat(refuses = false) {
  const written: string[] = [];
  return {
    written,
    api: {
      writeText: (text: string) => {
        if (refuses) return Promise.reject(new Error("clipboard denied"));
        written.push(text);
        return Promise.resolve();
      },
    },
  };
}

function installBrowserGlobals(clipboard: unknown): () => void {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  function setGlobal(name: string, value: unknown): void {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  class TestHTMLElement extends EventTarget {
    attachShadow() {
      return { adoptedStyleSheets: [], appendChild() {}, append() {} };
    }
  }
  setGlobal("window", globalThis);
  setGlobal("HTMLElement", TestHTMLElement);
  setGlobal("customElements", {
    define() {},
    get() {},
    whenDefined: () => Promise.resolve(),
  });
  setGlobal("document", {
    documentElement: { style: {} },
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({
      style: {},
      setAttribute() {},
      append() {},
      appendChild() {},
    }),
    createTreeWalker: () => ({}),
  });
  setGlobal("devicePixelRatio", 1);
  setGlobal("screen", { deviceXDPI: 1, logicalXDPI: 1 });
  setGlobal("navigator", { platform: "", userAgent: "deno", clipboard });
  setGlobal("location", {
    protocol: "http:",
    host: "localhost:8000",
    hostname: "localhost",
    href: "http://localhost:8000/naming-demo/top/42",
  });
  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}

/** Return the rendered text of nested Lit template results. */
function templateText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(templateText).join("");
  if (typeof value !== "object") return String(value);
  const template = value as {
    strings?: readonly string[];
    values?: readonly unknown[];
  };
  const strings = template.strings ?? [];
  const values = template.values ?? [];
  let text = "";
  for (let index = 0; index < strings.length; index++) {
    text += strings[index];
    if (index < values.length) text += templateText(values[index]);
  }
  return text;
}

/** A click, as the menu entry dispatches one. */
function click(): Event {
  return { preventDefault() {}, stopPropagation() {} } as unknown as Event;
}

const REFERENCE = "/@naming-demo/top/42";

describe("HeaderView piece reference", () => {
  it("copies the reference it was handed, character for character", async () => {
    const clipboard = clipboardThat();
    const restore = installBrowserGlobals(clipboard.api);
    try {
      const { XHeaderView } = await import("../src/views/HeaderView.ts");
      const view = new XHeaderView() as unknown as HeaderViewLike;
      view.pieceReference = REFERENCE;
      view.menuOpen = true;

      await view.accessForTestingOnly.copyReference(click());

      expect(clipboard.written).toEqual([REFERENCE]);
      // Taking the offer closes the menu, as every other entry does.
      expect(view.menuOpen).toBe(false);
    } finally {
      restore();
    }
  });

  it("shows the reference beside the entry that copies it", async () => {
    const clipboard = clipboardThat();
    const restore = installBrowserGlobals(clipboard.api);
    try {
      const { XHeaderView } = await import("../src/views/HeaderView.ts");
      const view = new XHeaderView() as unknown as HeaderViewLike;
      view.pieceReference = REFERENCE;

      // Shown as well as copied: a reader who cannot paste — reading over a
      // shoulder, or off a screenshot — can still retype it.
      expect(templateText(view.render())).toContain(REFERENCE);
    } finally {
      restore();
    }
  });

  it("offers nothing for a piece that has no member reference", async () => {
    const clipboard = clipboardThat();
    const restore = installBrowserGlobals(clipboard.api);
    try {
      const { XHeaderView } = await import("../src/views/HeaderView.ts");
      const view = new XHeaderView() as unknown as HeaderViewLike;
      view.pieceReference = undefined;
      view.menuOpen = true;

      expect(templateText(view.render())).not.toContain("Copy reference");
      // And nothing reaches the clipboard if the entry is driven anyway,
      // rather than an empty string landing there.
      await view.accessForTestingOnly.copyReference(click());
      expect(clipboard.written).toEqual([]);
      expect(view.menuOpen).toBe(true);
    } finally {
      restore();
    }
  });

  it("survives a clipboard that refuses", async () => {
    const clipboard = clipboardThat(true);
    const restore = installBrowserGlobals(clipboard.api);
    const warnings: unknown[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args[0]);
    try {
      const { XHeaderView } = await import("../src/views/HeaderView.ts");
      const view = new XHeaderView() as unknown as HeaderViewLike;
      view.pieceReference = REFERENCE;
      view.menuOpen = true;

      // A browser can deny clipboard access outright. The control reports it
      // and closes, rather than rejecting into a click handler where nothing
      // is listening.
      await view.accessForTestingOnly.copyReference(click());

      expect(warnings).toEqual([
        "Failed to copy reference to clipboard",
      ]);
      expect(view.menuOpen).toBe(false);
    } finally {
      console.warn = realWarn;
      restore();
    }
  });
});

// deno-lint-ignore-file cf-imports/no-inline-module-import -- the components
// extend a bare HTMLElement as they load, so they can only load once the test
// has installed one.

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { installBrowserGlobals } from "./browser-globals.ts";

/** Each custom element defined while the entry loaded, by tag. */
const defined = new Map<string, unknown>();

describe("library-components", () => {
  let restore: () => void;
  beforeAll(async () => {
    restore = installBrowserGlobals("http://localhost:8000/");
    Object.defineProperty(globalThis, "customElements", {
      configurable: true,
      writable: true,
      value: {
        define: (tag: string, element: unknown) => defined.set(tag, element),
        get: (tag: string) => defined.get(tag),
        whenDefined: () => Promise.resolve(),
      },
    });
    await import("../src/library-components.ts");
  });
  afterAll(() => restore());

  it("defines the components an embedding host renders patterns with", () => {
    // An embedding host loads this entry beside the library to render
    // patterns, so the components a rendered pattern reaches for have to
    // be there once it loads.

    expect(
      ["cf-render", "cf-map", "cf-code-editor"].filter((tag) =>
        !defined.has(tag)
      ),
    ).toEqual([]);
  });

  it("defines none of the shell's own views", () => {
    expect([...defined.keys()].filter((tag) => tag.startsWith("x-")))
      .toEqual([]);
  });
});

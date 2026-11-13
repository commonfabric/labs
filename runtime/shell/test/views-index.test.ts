// deno-lint-ignore-file cf-imports/no-inline-module-import -- the views' module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { installBrowserGlobals } from "./browser-globals.ts";

/** Each custom element defined so far, by tag. */
const defined = new Map<string, unknown>();

/** Each custom element defined by loading the barrel, by tag. */
let definedByBarrel: Map<string, unknown>;

describe("views/index", () => {
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
    await import("../src/views/index.ts");
    definedByBarrel = new Map(defined);
  });
  afterAll(() => restore());

  it("defines each of the shell's top-level views under its tag", async () => {
    const views = {
      "x-app-view": (await import("../src/views/AppView.ts")).XAppView,
      "x-body-view": (await import("../src/views/BodyView.ts")).XBodyView,
      "x-debugger-view":
        (await import("../src/views/DebuggerView.ts")).XDebuggerView,
      "x-header-view": (await import("../src/views/HeaderView.ts")).XHeaderView,
      "x-login-view": (await import("../src/views/LoginView.ts")).XLoginView,
      "x-root-view": (await import("../src/views/RootView.ts")).XRootView,
    };

    const undefinedTags = Object.entries(views)
      .filter(([tag, view]) => definedByBarrel.get(tag) !== view)
      .map(([tag]) => tag);

    expect(undefinedTags).toEqual([]);
  });
});

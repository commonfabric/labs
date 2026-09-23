// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";

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
  class TestHTMLElement extends EventTarget {
    attachShadow() {
      return {
        adoptedStyleSheets: [],
        appendChild() {},
        append() {},
      };
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
  setGlobal("navigator", { platform: "", userAgent: "deno" });
  setGlobal("location", {
    protocol: "http:",
    host: "localhost:8000",
    hostname: "localhost",
    href: "http://localhost:8000/named",
  });

  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}

describe("XAppView named-space preparation", () => {
  it("renders the selected nested view rather than its document root", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XBodyView } = await import("../src/views/BodyView.ts");
      const nested = { target: "nested view" };
      const root = {
        key: (key: string) => {
          expect(key).toBe("detail");
          return nested;
        },
      };
      const body = new XBodyView();
      body.activePattern = {
        id: () => "of:fid1:root",
        cell: () => root,
      } as never;
      (body as unknown as { piecePath: string[] }).piecePath = ["detail"];
      const contains = (value: unknown, wanted: unknown): boolean => {
        if (value === wanted) return true;
        if (Array.isArray(value)) {
          return value.some((child) => contains(child, wanted));
        }
        if (value && typeof value === "object" && "values" in value) {
          return contains(value.values, wanted);
        }
        return false;
      };
      const rendered = body.render();
      expect(contains(rendered, nested)).toBe(true);
      expect(contains(rendered, root)).toBe(false);
    } finally {
      restore();
    }
  });

  it("prepares the named space before root and selected pattern tasks", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const space = "did:key:z6Mk-shell-app-view-named" as DID;
      const names: string[] = [];
      const root = { id: () => "root" };
      const view = new XAppView();
      view.app = {
        view: { spaceName: "notebook" },
      } as never;
      view.space = space;
      view.rt = {
        signal: new AbortController().signal,
        resolveSpaceName: (name: string) => {
          names.push(name);
          return Promise.resolve(space);
        },
        getSpaceRootPattern: () => Promise.resolve(root),
      } as never;

      view._spaceRootPattern.run();
      await view._spaceRootPattern.taskComplete;
      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;

      expect(view._spaceRootPattern.value).toBe(root);
      expect(names).toEqual(["notebook", "notebook"]);
    } finally {
      restore();
    }
  });

  it("loads nothing while the view's space is still being resolved", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const space = "did:key:z6Mk-shell-app-view-second-space" as DID;
      const names: string[] = [];
      const root = { id: () => "root" };
      const view = new XAppView();
      // RootView hands the view and its space over together, so a view that
      // names a space RootView has not resolved yet arrives with no space.
      view.app = {
        view: { spaceName: "atlas" },
      } as never;
      view.space = undefined;
      view.rt = {
        signal: new AbortController().signal,
        resolveSpaceName: (name: string) => {
          names.push(name);
          return Promise.resolve(space);
        },
        getSpaceRootPattern: () => Promise.resolve(root),
      } as never;

      view._spaceRootPattern.run();
      await view._spaceRootPattern.taskComplete;
      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;

      // No space, so no load and nothing to disagree about.
      expect(view._spaceRootPattern.value).toBeUndefined();
      expect(names).toEqual([]);

      // Once the name resolves, the pair agrees and the root pattern loads.
      view.space = space;
      view._spaceRootPattern.run();
      await view._spaceRootPattern.taskComplete;
      expect(view._spaceRootPattern.value).toBe(root);
      expect(names).toEqual(["atlas"]);
    } finally {
      restore();
    }
  });

  it("does not request the space root for a piece-focused view", async () => {
    const restore = installBrowserGlobals();
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const space = "did:key:z6Mk-shell-piece-without-root" as DID;
      let rootRequests = 0;
      const view = new XAppView();
      view.app = {
        view: { spaceName: "notebook", pieceId: "of:piece" },
      } as never;
      view.space = space;
      view.rt = {
        signal: new AbortController().signal,
        resolveSpaceName: () => Promise.resolve(space),
        getSpaceRootPattern: () => {
          rootRequests++;
          return Promise.reject(new Error("space root must stay untouched"));
        },
      } as never;

      view._spaceRootPattern.run();
      await view._spaceRootPattern.taskComplete;

      expect(view._spaceRootPattern.value).toBeUndefined();
      expect(rootRequests).toBe(0);
    } finally {
      restore();
    }
  });

  it("reports a name that resolves to a space other than the one given", async () => {
    const { prepareNamedSpace } = await import("../src/lib/named-space.ts");
    const atlas = "did:key:z6Mk-shell-named-space-atlas" as DID;
    const notebook = "did:key:z6Mk-shell-named-space-notebook" as DID;

    await expect(
      prepareNamedSpace(
        { view: { spaceName: "atlas" } } as never,
        { resolveSpaceName: () => Promise.resolve(atlas) },
        notebook,
      ),
    ).rejects.toThrow("resolved inconsistently");
  });
});

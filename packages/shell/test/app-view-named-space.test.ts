// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";

import { installBrowserGlobals } from "./browser-globals.ts";

const PAGE_HREF = "http://localhost:8000/named";

/** The value bound right after a template part ending in `marker`. */
function boundAfter(value: unknown, marker: string): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = boundAfter(item, marker);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const template = value as {
    strings?: readonly string[];
    values?: readonly unknown[];
  };
  if (!template.strings || !template.values) return undefined;
  const at = template.strings.findIndex((part) => part.endsWith(marker));
  if (at >= 0) return template.values[at];
  return boundAfter(template.values, marker);
}

describe("XAppView named-space loading", () => {
  it("tells the render it opened the active piece, and not a view at a path inside it", async () => {
    // A path inside the piece may lead to another piece, which the shell did
    // not open; the render opens that one.
    const restore = installBrowserGlobals(PAGE_HREF);
    try {
      const { XBodyView } = await import("../src/views/BodyView.ts");
      const nested = { ref: () => ({ path: ["detail"] }) };
      const root = { ref: () => ({ path: [] }), key: () => nested };
      const body = new XBodyView();
      body.activePattern = {
        id: () => "of:fid1:root",
        cell: () => root,
      } as never;
      expect(boundAfter(body.render(), '.hostOpened="')).toBe(true);
      (body as unknown as { piecePath: string[] }).piecePath = ["detail"];
      expect(boundAfter(body.render(), '.hostOpened="')).toBe(false);
    } finally {
      restore();
    }
  });

  it("renders the selected nested view rather than its document root", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    try {
      const { XBodyView } = await import("../src/views/BodyView.ts");
      const nested = {
        target: "nested view",
        ref: () => ({ path: ["detail"] }),
      };
      const root = {
        ref: () => ({ path: [] }),
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

  it("loads a named view's root from the space it was given", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const space = "did:key:z6Mk-shell-app-view-named" as DID;
      const requested: DID[] = [];
      const root = { id: () => "root" };
      const view = new XAppView();
      view.app = {
        view: { spaceName: "notebook" },
      } as never;
      view.space = space;
      view.rt = {
        signal: new AbortController().signal,
        getSpaceRootPattern: (asked: DID) => {
          requested.push(asked);
          return Promise.resolve(root);
        },
      } as never;

      view._spaceRootPattern.run();
      await view._spaceRootPattern.taskComplete;
      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;

      expect(view._spaceRootPattern.value).toBe(root);
      expect(requested).toEqual([space]);
    } finally {
      restore();
    }
  });

  it("loads nothing while the view's space is still being resolved", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const space = "did:key:z6Mk-shell-app-view-second-space" as DID;
      const requested: DID[] = [];
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
        getSpaceRootPattern: (asked: DID) => {
          requested.push(asked);
          return Promise.resolve(root);
        },
      } as never;

      view._spaceRootPattern.run();
      await view._spaceRootPattern.taskComplete;
      view._selectedPattern.run();
      await view._selectedPattern.taskComplete;

      // No space, so no load.
      expect(view._spaceRootPattern.value).toBeUndefined();
      expect(requested).toEqual([]);

      // Once the name resolves, the root pattern loads from that space.
      view.space = space;
      view._spaceRootPattern.run();
      await view._spaceRootPattern.taskComplete;
      expect(view._spaceRootPattern.value).toBe(root);
      expect(requested).toEqual([space]);
    } finally {
      restore();
    }
  });

  it("does not request the space root for a piece-focused view", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
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
});

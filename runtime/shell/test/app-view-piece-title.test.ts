// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";
import { CFC_POLICY_PLACEHOLDER_TEXT } from "@commonfabric/html/client";
import { UPDATE_PAGE_TITLE_EVENT } from "@commonfabric/navigation";
import {
  $conn,
  $onCellRefused,
  $onCellUpdate,
  CellHandle,
  type CellHandleRead,
  type CellRef,
  type RuntimeClient,
} from "@commonfabric/runtime-client";

import { installBrowserGlobals } from "./browser-globals.ts";
import { templateBindings } from "./lit-template-markup.ts";

const PAGE_HREF = "http://localhost:8000/piece-title";
const SPACE = "did:key:z6Mk-shell-app-view-piece-title" as DID;

/** The document a piece's name is read from. */
const NAME_REF: CellRef = {
  id: "of:root",
  space: SPACE,
  scope: "space",
  path: ["$NAME"],
  schema: { type: "string" },
};

/** A worker connection that accepts every subscription and answers nothing. */
const client = {
  [$conn]: () => ({
    request: () => Promise.resolve({}),
    subscribe: () => Promise.resolve(),
    unsubscribe: () => Promise.resolve(),
    peersOf: () => [],
    signal: new AbortController().signal,
  }),
} as unknown as RuntimeClient;

/**
 * A runtime whose space root is a piece whose name reads as `read`. Each read
 * of the name makes a fresh handle on the same document, holding `read`, and
 * `names` holds every handle made, so a test can report a change through the
 * one the view follows.
 */
function stubRuntime(read: CellHandleRead<string>) {
  const names: CellHandle<string>[] = [];
  const piece = {
    id: () => "of:root",
    cell: () => ({
      key: () => ({
        asSchema: () => {
          const name = new CellHandle<string>(client, NAME_REF, read);
          names.push(name);
          return name;
        },
      }),
      ref: () => ({ space: SPACE, scope: "space" }),
    }),
  };
  return {
    names,
    rt: {
      signal: new AbortController().signal,
      getSpaceRootPattern: () => Promise.resolve(piece),
    },
  };
}

/** A view of the space's root under `runtime`, with that root loaded. */
async function viewShowingRoot(runtime: ReturnType<typeof stubRuntime>) {
  const { XAppView } = await import("../src/views/AppView.ts");
  const view = new XAppView();
  view.app = { identity: {}, config: {}, view: { spaceDid: SPACE } } as never;
  view.space = SPACE;
  view.rt = runtime.rt as never;
  view._spaceRootPattern.run();
  await view._spaceRootPattern.taskComplete;
  view._patterns.run();
  await view._patterns.taskComplete;
  return view;
}

describe("XAppView piece title", () => {
  it("hands its header the name of the piece on screen, as its name reads", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    try {
      const titles = [];
      for (
        const read of [
          { value: "Pottery" },
          { refused: { refusedBy: "display-ceiling" } },
          { unread: true },
        ] as CellHandleRead<string>[]
      ) {
        const view = await viewShowingRoot(stubRuntime(read));
        titles.push(templateBindings(view.render(), "pieceTitle"));
      }

      // A refused name shows the placeholder a render shows in its place,
      // rather than reading as a piece with no name.
      expect(titles).toEqual([
        ["Pottery"],
        [CFC_POLICY_PLACEHOLDER_TEXT],
        [undefined],
      ]);
    } finally {
      restore();
    }
  });

  it("follows each change to the name of the piece on screen", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    try {
      const runtime = stubRuntime({ value: "Pottery" });
      const view = await viewShowingRoot(runtime);
      view.render();
      const [name] = runtime.names;

      name[$onCellUpdate]("Glazes");
      const renamed = view.pieceTitle;
      name[$onCellRefused]({ refusedBy: "display-ceiling" });

      expect({ renamed, refused: view.pieceTitle }).toEqual({
        renamed: "Glazes",
        refused: CFC_POLICY_PLACEHOLDER_TEXT,
      });
    } finally {
      restore();
    }
  });

  it("keeps following the name it follows across renders of the same piece", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    try {
      const runtime = stubRuntime({ value: "Pottery" });
      const view = await viewShowingRoot(runtime);
      view.render();
      runtime.names[0][$onCellUpdate]("Glazes");

      // The second render reads the name afresh, as `Pottery`, and is still
      // looking at the same document: the change already followed stands.
      const title = templateBindings(view.render(), "pieceTitle");
      runtime.names[0][$onCellUpdate]("Kilns");

      expect({ title, followed: view.pieceTitle }).toEqual({
        title: ["Glazes"],
        followed: "Kilns",
      });
    } finally {
      restore();
    }
  });

  it("shows `Untitled`, and follows no name, once no piece is on screen", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    try {
      const runtime = stubRuntime({ value: "Pottery" });
      const view = await viewShowingRoot(runtime);
      view.render();

      // The view moves to a piece it has not loaded yet.
      view.app = {
        identity: {},
        config: {},
        view: { spaceDid: SPACE, pieceId: "fid1:elsewhere" },
      } as never;
      view._patterns.run();
      await view._patterns.taskComplete;
      const title = templateBindings(view.render(), "pieceTitle");
      runtime.names[0][$onCellUpdate]("Glazes");

      expect({ title, after: view.pieceTitle }).toEqual({
        title: ["Untitled"],
        after: "Untitled",
      });
    } finally {
      restore();
    }
  });

  it("hands its header the whole address of the piece on screen once it has loaded", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const loading = new XAppView();
      loading.app = {
        identity: {},
        config: {},
        view: { spaceDid: SPACE },
      } as never;
      loading.space = SPACE;
      const view = await viewShowingRoot(stubRuntime({ value: "Pottery" }));

      const handed = (from: { render(): unknown }) => ({
        pieceId: templateBindings(from.render(), "pieceId"),
        pieceAddress: templateBindings(from.render(), "pieceAddress"),
      });
      expect({ loading: handed(loading), loaded: handed(view) }).toEqual({
        loading: { pieceId: [undefined], pieceAddress: [undefined] },
        loaded: {
          pieceId: ["of:root"],
          pieceAddress: [{ space: SPACE, pieceId: "of:root", scope: "space" }],
        },
      });
    } finally {
      restore();
    }
  });

  it("asks the host to title the page after the piece when its title changes, and only then", async () => {
    const restore = installBrowserGlobals(PAGE_HREF);
    const asked: unknown[] = [];
    const listener = (event: Event) => {
      asked.push((event as CustomEvent<string>).detail);
    };
    globalThis.addEventListener(UPDATE_PAGE_TITLE_EVENT, listener);
    try {
      const { XAppView } = await import("../src/views/AppView.ts");
      const view = new XAppView();
      view.pieceTitle = "Pottery";
      view.updated(new Map([["pieceTitle", undefined]]));
      view.updated(new Map([["space", undefined]]));
      view.pieceTitle = undefined;
      view.updated(new Map([["pieceTitle", "Pottery"]]));

      expect(asked).toEqual(["Pottery", ""]);
    } finally {
      globalThis.removeEventListener(UPDATE_PAGE_TITLE_EVENT, listener);
      restore();
    }
  });
});

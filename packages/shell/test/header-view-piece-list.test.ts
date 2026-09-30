// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

/**
 * The header's piece switcher loads piece names on demand. Nothing is read
 * until a switcher is open; each name is the canonical name projection of an
 * unstarted piece, never its full result; the names are cached until the
 * space changes; and a load the header abandons (switcher closed, space
 * switched, header removed) leaves nothing behind for the next open to show.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { TaskStatus } from "@lit/task";
import { nameSchema } from "@commonfabric/runner/schemas";
import { NAME } from "@commonfabric/runner/shared";

import type { XHeaderView as HeaderViewClass } from "../src/views/HeaderView.ts";
import { templateMarkup } from "./lit-template-markup.ts";

/**
 * What these tests set and read. The switcher flags are the view's own state,
 * reached as a click would leave them; the task is reached through the class's
 * testing accessor, which types it as the class does.
 */
interface HeaderViewLike {
  rt: unknown;
  space: string | undefined;
  spaceName: string | undefined;
  pieceId: string | undefined;
  pieceTitle: string | undefined;
  menuOpen: boolean;
  pieceListExpanded: boolean;
  headerPieceDropdownOpen: boolean;
  readonly accessForTestingOnly: HeaderViewClass["accessForTestingOnly"];
  willUpdate(changed: Map<string, unknown>): void;
  disconnectedCallback(): void;
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
  setGlobal("devicePixelRatio", 1);
  setGlobal("navigator", { platform: "", userAgent: "deno" });
  setGlobal("location", {
    protocol: "http:",
    host: "localhost:8000",
    hostname: "localhost",
    href: "http://localhost:8000/menu-test/named",
  });

  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}

/**
 * A runtime whose registry holds three pieces: one named, one with no name,
 * one that fails to resolve. Every name read waits on a per-space gate the
 * test releases, so a load can be left pending while the header moves on.
 * Counts registry reads and full (unprojected) result reads, and records the
 * schema each projected read carried and the start option each resolve was
 * given. `arrived` resolves once a space's name reads are waiting at the gate,
 * so a test can abandon a load that has already done its reading.
 */
function makeRuntime() {
  const latches = (): (space: string) => PromiseWithResolvers<void> => {
    const map = new Map<string, PromiseWithResolvers<void>>();
    return (space) => {
      let latch = map.get(space);
      if (!latch) {
        latch = Promise.withResolvers<void>();
        map.set(space, latch);
      }
      return latch;
    };
  };
  const gate = latches();
  const arrival = latches();
  const rt = {
    reads: [] as Array<{ space: string; schema: unknown }>,
    starts: [] as unknown[],
    registryReads: 0,
    fullReads: 0,
    release(space: string) {
      gate(space).resolve();
    },
    arrived(space: string): Promise<void> {
      return arrival(space).promise;
    },
    synced: () => Promise.resolve(),
    getPiecesListCell() {
      rt.registryReads++;
      return Promise.resolve({
        sync: () => Promise.resolve(),
        get: () => [
          { id: () => "named" },
          { $ID: "untitled" },
          { $ID: "unavailable" },
        ],
      });
    },
    getPattern(space: string, id: string, options: unknown) {
      rt.starts.push(options);
      if (id === "unavailable") {
        return Promise.reject(new Error("Piece unavailable"));
      }
      const value = id === "named" ? { [NAME]: `${space} title` } : {};
      return Promise.resolve({
        id: () => id,
        name: () => "Unprojected name",
        cell: () => ({
          sync: () => {
            rt.fullReads++;
            return Promise.resolve(value);
          },
          asSchema: (schema: unknown) => ({
            sync: async () => {
              rt.reads.push({ space, schema });
              arrival(space).resolve();
              await gate(space).promise;
              return value;
            },
          }),
        }),
      });
    },
  };
  return rt;
}

/** The header as it stands on a piece in a space, with the runtime up. */
async function mountHeader(rt: unknown): Promise<HeaderViewLike> {
  const { XHeaderView } = await import("../src/views/HeaderView.ts");
  const view = new XHeaderView() as unknown as HeaderViewLike;
  view.rt = rt;
  view.space = "did:key:first";
  view.spaceName = "Menu test";
  view.pieceTitle = "Current piece";
  view.pieceId = "named";
  return view;
}

const namesIn = (space: string) => [
  { id: "named", name: `${space} title` },
  { id: "untitled", name: "Piece #untitl" },
];

/** How many rendered piece lists are showing their loading state. */
function loadingLists(markup: string): number {
  return markup.match(/\.loading="true"/g)?.length ?? 0;
}

describe("HeaderView piece list", () => {
  it("reads nothing until a switcher opens, then only the names of unstarted pieces", async () => {
    const restore = installBrowserGlobals();
    try {
      const rt = makeRuntime();
      rt.release("did:key:first");
      const view = await mountHeader(rt);
      const { pieces } = view.accessForTestingOnly;

      // Runtime and space present, both switchers closed: no read at all.
      await pieces.run();
      expect(pieces.value).toEqual([]);
      expect(rt.registryReads).toBe(0);

      // Desktop switcher open: one registry read, one projected name read per
      // piece under the canonical name schema, no piece started, no full
      // result read, and the unresolvable piece dropped rather than fatal.
      view.headerPieceDropdownOpen = true;
      await pieces.run();
      expect(pieces.value).toEqual(namesIn("did:key:first"));
      expect(rt.registryReads).toBe(1);
      expect(rt.fullReads).toBe(0);
      expect(rt.starts).toEqual([
        { start: false },
        { start: false },
        { start: false },
      ]);
      expect(rt.reads.length).toBe(2);
      expect(rt.reads.every((read) => read.schema === nameSchema)).toBe(true);

      // Closing and reopening, on either surface, serves the cached names.
      view.headerPieceDropdownOpen = false;
      await pieces.run();
      expect(pieces.value).toEqual([]);
      view.headerPieceDropdownOpen = true;
      await pieces.run();
      expect(pieces.value).toEqual(namesIn("did:key:first"));
      view.headerPieceDropdownOpen = false;
      view.menuOpen = true;
      view.pieceListExpanded = true;
      await pieces.run();
      expect(pieces.value).toEqual(namesIn("did:key:first"));
      expect(rt.registryReads).toBe(1);
    } finally {
      restore();
    }
  });

  it("renders both lists as loading until the first names arrive", async () => {
    const restore = installBrowserGlobals();
    try {
      const rt = makeRuntime();
      const view = await mountHeader(rt);
      const { pieces } = view.accessForTestingOnly;
      view.headerPieceDropdownOpen = true;
      view.menuOpen = true;
      view.pieceListExpanded = true;

      const load = pieces.run();
      expect(pieces.status).toBe(TaskStatus.PENDING);
      let markup = templateMarkup(view.render());
      expect(loadingLists(markup)).toBe(2);
      expect(markup).not.toContain("did:key:first title");

      rt.release("did:key:first");
      await load;
      markup = templateMarkup(view.render());
      expect(loadingLists(markup)).toBe(0);
      expect(markup).toContain("did:key:first title");
      expect(markup).toContain("Piece #untitl");
    } finally {
      restore();
    }
  });

  it("closing the switcher abandons a pending load, and the next open loads again", async () => {
    const restore = installBrowserGlobals();
    try {
      const rt = makeRuntime();
      const view = await mountHeader(rt);
      const { pieces } = view.accessForTestingOnly;

      view.headerPieceDropdownOpen = true;
      const abandoned = pieces.run();
      await rt.arrived("did:key:first");
      // Closing re-runs the task with the switcher hidden, which aborts the
      // load mid-read; its late answer must not become the cache.
      view.headerPieceDropdownOpen = false;
      const closed = pieces.run();
      rt.release("did:key:first");
      await Promise.all([abandoned, closed]);
      expect(pieces.status).toBe(TaskStatus.COMPLETE);
      expect(pieces.value).toEqual([]);

      view.headerPieceDropdownOpen = true;
      const reopened = pieces.run();
      expect(templateMarkup(view.render())).toContain('.loading="true"');
      await reopened;
      expect(pieces.value).toEqual(namesIn("did:key:first"));
      expect(rt.registryReads).toBe(2);
    } finally {
      restore();
    }
  });

  it("a space switch drops the cache and keeps the old space's late names out", async () => {
    const restore = installBrowserGlobals();
    try {
      const rt = makeRuntime();
      const view = await mountHeader(rt);
      const { pieces } = view.accessForTestingOnly;

      view.headerPieceDropdownOpen = true;
      const first = pieces.run();
      await rt.arrived("did:key:first");
      // The space changes while the first load is mid-read: the view drops
      // the cache and the task re-runs for the new space, aborting the old
      // load.
      view.space = "did:key:second";
      view.willUpdate(new Map([["space", "did:key:first"]]));
      const second = pieces.run();
      rt.release("did:key:second");
      await second;
      expect(pieces.value).toEqual(namesIn("did:key:second"));

      // The first space's names arrive after the switch and go nowhere.
      rt.release("did:key:first");
      await first;
      await pieces.run();
      expect(pieces.value).toEqual(namesIn("did:key:second"));
      expect(templateMarkup(view.render())).not.toContain(
        "did:key:first title",
      );
      expect(rt.registryReads).toBe(2);
    } finally {
      restore();
    }
  });

  it("removing the header aborts a pending load and closes both switchers", async () => {
    const restore = installBrowserGlobals();
    try {
      const rt = makeRuntime();
      const view = await mountHeader(rt);
      const { pieces } = view.accessForTestingOnly;

      view.headerPieceDropdownOpen = true;
      view.menuOpen = true;
      view.pieceListExpanded = true;
      const pending = pieces.run();
      await rt.arrived("did:key:first");
      view.disconnectedCallback();
      rt.release("did:key:first");
      await pending;
      expect(pieces.status).toBe(TaskStatus.ERROR);
      expect(view.headerPieceDropdownOpen).toBe(false);
      expect(view.pieceListExpanded).toBe(false);
      expect(templateMarkup(view.render())).not.toContain(
        "did:key:first title",
      );

      // Reconnected and reopened: a fresh load, not the aborted one.
      view.headerPieceDropdownOpen = true;
      await pieces.run();
      expect(pieces.value).toEqual(namesIn("did:key:first"));
      expect(rt.registryReads).toBe(2);
    } finally {
      restore();
    }
  });
});

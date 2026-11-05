// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

import { assert, assertEquals, assertFalse } from "@std/assert";

import type { XHeaderView as HeaderViewClass } from "../src/views/HeaderView.ts";

// Exercises the lazy favorites-subscription paths in HeaderView. The header
// resolves the home space's default pattern only when its favorites surface is
// first opened (menu open or favorite toggle), not at login, so the home
// pattern's one-time creation does not contend with the user's first write.

// The members the tests drive, typed loosely so fakes can stand in for the
// runtime; the private steps and state are reached through the accessor.
interface HeaderViewLike {
  rt: unknown;
  space: unknown;
  pieceId: unknown;
  pieceAddress: unknown;
  menuOpen: boolean;
  accessForTestingOnly: HeaderViewClass["accessForTestingOnly"];
  willUpdate(changed: Map<string, unknown>): void;
  disconnectedCallback(): void;
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
    href: "http://localhost:8000/common-knowledge",
  });

  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  };
}

/** A stored favorite as the header reads one: an entry over a cell handle. */
function favoriteOf(ref: { id: string; space: string; scope: string }) {
  return { cell: { ref: () => ref } };
}

/** A write the header made: which one, and the address it named. */
interface FavoriteWrite {
  op: "add" | "remove";
  piece: { space: string; pieceId: string; scope: string };
}

/**
 * A stand-in for the runtime's favorites surface. Counts subscriptions so a
 * test can assert when (and how often) the header asks for favorites, delivers
 * `entries` as the stored favorites, records each write with the address it
 * named, and can reject writes to simulate a disposed runtime.
 */
function makeRuntime(
  opts: {
    aborted?: boolean;
    failWrite?: boolean;
    entries?: readonly unknown[];
  } = {},
) {
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  const writes: FavoriteWrite[] = [];
  const write = (op: FavoriteWrite["op"]) => (piece: unknown) => {
    writes.push({ op, piece: piece as FavoriteWrite["piece"] });
    return opts.failWrite
      ? Promise.reject(new Error("write cancelled"))
      : Promise.resolve();
  };
  const favorites = {
    subscribeFavorites(cb: (favorites: readonly unknown[]) => void) {
      subscribeCount++;
      cb(opts.entries ?? []);
      return () => {
        unsubscribeCount++;
      };
    },
    addFavorite: write("add"),
    removeFavorite: write("remove"),
  };
  return {
    favorites: () => favorites,
    signal: { aborted: opts.aborted ?? false },
    writes,
    get subscribeCount() {
      return subscribeCount;
    },
    get writeCount() {
      return writes.length;
    },
    get unsubscribeCount() {
      return unsubscribeCount;
    },
  };
}

const fakeEvent = () =>
  ({ preventDefault() {}, stopPropagation() {} }) as unknown as Event;

Deno.test("favorites stay unsubscribed until a runtime exists and a surface opens", async () => {
  const restore = installBrowserGlobals();
  try {
    const { XHeaderView } = await import("../src/views/HeaderView.ts");
    const view = new XHeaderView() as unknown as HeaderViewLike;
    const rt = makeRuntime();

    // No runtime yet: requesting the subscription is a no-op.
    view.accessForTestingOnly.ensureFavoritesSubscription();
    assertEquals(rt.subscribeCount, 0);

    // Runtime present: the first request subscribes exactly once.
    view.rt = rt;
    view.accessForTestingOnly.ensureFavoritesSubscription();
    assertEquals(rt.subscribeCount, 1);

    // Idempotent: a repeat request does not subscribe again.
    view.accessForTestingOnly.ensureFavoritesSubscription();
    assertEquals(rt.subscribeCount, 1);
  } finally {
    restore();
  }
});

Deno.test("a new runtime re-arms the lazy subscription", async () => {
  const restore = installBrowserGlobals();
  try {
    const { XHeaderView } = await import("../src/views/HeaderView.ts");

    // Menu closed when the runtime arrives: stay unsubscribed until it opens.
    const closed = new XHeaderView() as unknown as HeaderViewLike;
    const first = makeRuntime();
    closed.rt = first;
    closed.accessForTestingOnly.ensureFavoritesSubscription();
    assertEquals(first.subscribeCount, 1);

    // Swapping the runtime tears down the old subscription; with the menu
    // closed nothing resubscribes yet, but the next open does.
    closed.willUpdate(new Map([["rt", undefined]]));
    assertEquals(first.unsubscribeCount, 1);
    closed.accessForTestingOnly.ensureFavoritesSubscription();
    assertEquals(first.subscribeCount, 2);

    // Menu already open when the runtime arrives: subscribe immediately.
    const open = new XHeaderView() as unknown as HeaderViewLike;
    const second = makeRuntime();
    open.menuOpen = true;
    open.rt = second;
    open.willUpdate(new Map([["rt", undefined]]));
    assertEquals(second.subscribeCount, 1);
  } finally {
    restore();
  }
});

Deno.test("opening the header menu requests the favorites subscription", async () => {
  const restore = installBrowserGlobals();
  try {
    const { XHeaderView } = await import("../src/views/HeaderView.ts");
    const view = new XHeaderView() as unknown as HeaderViewLike;
    const rt = makeRuntime();
    view.rt = rt;

    view.accessForTestingOnly.handleLogoClick(fakeEvent());
    assert(view.menuOpen);
    assertEquals(rt.subscribeCount, 1);
  } finally {
    restore();
  }
});

Deno.test("toggling a favorite requests the subscription and swallows a disposal race", async () => {
  const restore = installBrowserGlobals();
  try {
    const { XHeaderView } = await import("../src/views/HeaderView.ts");

    // A successful toggle subscribes and releases the in-flight guard: a
    // second toggle writes again.
    const ok = new XHeaderView() as unknown as HeaderViewLike;
    const okRt = makeRuntime();
    ok.rt = okRt;
    ok.pieceAddress = {
      space: "did:key:test",
      pieceId: "piece-1",
      scope: "space",
    };
    await ok.accessForTestingOnly.handleToggleFavorite(fakeEvent());
    assertEquals(okRt.subscribeCount, 1);
    assertEquals(okRt.writeCount, 1);
    await ok.accessForTestingOnly.handleToggleFavorite(fakeEvent());
    assertEquals(okRt.writeCount, 2);

    // A write cancelled by a disposed runtime is swallowed, not surfaced,
    // and releases the guard the same way.
    const racing = new XHeaderView() as unknown as HeaderViewLike;
    const racingRt = makeRuntime({ failWrite: true, aborted: true });
    racing.rt = racingRt;
    racing.pieceAddress = {
      space: "did:key:test",
      pieceId: "piece-2",
      scope: "space",
    };
    await racing.accessForTestingOnly.handleToggleFavorite(fakeEvent());
    assertEquals(racingRt.writeCount, 1);
    await racing.accessForTestingOnly.handleToggleFavorite(fakeEvent());
    assertEquals(racingRt.writeCount, 2);

    // A piece whose scope the view does not yet know has no address to be
    // favorited at, and the toggle writes nothing rather than favoriting
    // whichever document the space scope holds.
    const unresolved = new XHeaderView() as unknown as HeaderViewLike;
    const unresolvedRt = makeRuntime();
    unresolved.rt = unresolvedRt;
    unresolved.space = "did:key:test";
    unresolved.pieceId = "piece-3";
    await unresolved.accessForTestingOnly.handleToggleFavorite(fakeEvent());
    assertEquals(unresolvedRt.writeCount, 0);
  } finally {
    restore();
  }
});

Deno.test("an optimistic favorite says nothing about another scope of the same id", async () => {
  const restore = installBrowserGlobals();
  try {
    const { XHeaderView } = await import("../src/views/HeaderView.ts");
    const view = new XHeaderView() as unknown as HeaderViewLike;
    const rt = makeRuntime();
    view.rt = rt;
    // Subscribed up front so that the toggle's own request is a no-op: what
    // this pins is the window before any server list arrives.
    view.accessForTestingOnly.ensureFavoritesSubscription();

    const userScoped = { space: "did:key:test", pieceId: "p", scope: "user" };
    view.pieceId = "p";
    view.pieceAddress = userScoped;
    await view.accessForTestingOnly.handleToggleFavorite(fakeEvent());
    assertEquals(rt.writes.length, 1);
    assertEquals(rt.writes[0].op, "add");
    assert(view.accessForTestingOnly.isFavorite());

    // The header moves to the space-scoped document of that same id, which is
    // the update a scope change makes: the address changed and the id did not.
    view.pieceAddress = { space: "did:key:test", pieceId: "p", scope: "space" };
    view.willUpdate(new Map([["pieceAddress", userScoped]]));

    // The click above was about the user-scoped document, so it answers for
    // that one alone...
    assertFalse(view.accessForTestingOnly.isFavorite());

    // ...and the next toggle adds the document now on screen rather than
    // removing it.
    await view.accessForTestingOnly.handleToggleFavorite(fakeEvent());
    assertEquals(rt.writes.length, 2);
    assertEquals(rt.writes[1].op, "add");
    assertEquals(rt.writes[1].piece.scope, "space");
  } finally {
    restore();
  }
});

Deno.test("a favorite matches only in the scope the piece's address names", async () => {
  const restore = installBrowserGlobals();
  try {
    const { XHeaderView } = await import("../src/views/HeaderView.ts");
    const view = new XHeaderView() as unknown as HeaderViewLike;
    view.rt = makeRuntime({
      entries: [
        favoriteOf({ id: "of:p", space: "did:key:test", scope: "user" }),
      ],
    });
    view.accessForTestingOnly.ensureFavoritesSubscription();

    view.pieceAddress = {
      space: "did:key:test",
      pieceId: "p",
      scope: "user",
    };
    assert(view.accessForTestingOnly.isFavorite());

    // The same id in the space scope is another document, whose favorite this
    // one's is not.
    view.pieceAddress = {
      space: "did:key:test",
      pieceId: "p",
      scope: "space",
    };
    assertFalse(view.accessForTestingOnly.isFavorite());
  } finally {
    restore();
  }
});

Deno.test("a favorite matches only in the space the piece's address names", async () => {
  const restore = installBrowserGlobals();
  try {
    const { XHeaderView } = await import("../src/views/HeaderView.ts");
    const view = new XHeaderView() as unknown as HeaderViewLike;
    view.rt = makeRuntime({
      entries: [
        favoriteOf({ id: "of:p", space: "did:key:test", scope: "space" }),
      ],
    });
    view.accessForTestingOnly.ensureFavoritesSubscription();

    view.pieceAddress = {
      space: "did:key:test",
      pieceId: "p",
      scope: "space",
    };
    assert(view.accessForTestingOnly.isFavorite());

    // Favorites are one list across every space, so an id favorited in one
    // says nothing about the same id in another.
    view.pieceAddress = {
      space: "did:key:other",
      pieceId: "p",
      scope: "space",
    };
    assertFalse(view.accessForTestingOnly.isFavorite());
  } finally {
    restore();
  }
});

Deno.test("favorites re-subscribe after the header disconnects and reopens", async () => {
  const restore = installBrowserGlobals();
  try {
    const { XHeaderView } = await import("../src/views/HeaderView.ts");
    const view = new XHeaderView() as unknown as HeaderViewLike;
    const rt = makeRuntime();
    view.rt = rt;

    // Opening the menu subscribes.
    view.accessForTestingOnly.ensureFavoritesSubscription();
    assertEquals(rt.subscribeCount, 1);

    // Disconnecting tears the subscription down.
    view.disconnectedCallback();
    assertEquals(rt.unsubscribeCount, 1);

    // Reopening after reconnect must subscribe again, not skip on stale state.
    view.accessForTestingOnly.ensureFavoritesSubscription();
    assertEquals(rt.subscribeCount, 2);
  } finally {
    restore();
  }
});

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { GlobalShortcutsController } from "../src/lib/global-shortcuts-controller.ts";

// Exercises the shell's global keyboard shortcut: Alt+W navigates to the space
// the current view addresses. It goes through a single document keydown
// listener, so the tests drive that listener directly with synthetic events.

// The controller reads `navigator.platform` and attaches to `document`, and
// `navigate` dispatches on `globalThis`. Deno has none of those shaped the way
// a browser does, so stand in for them around each test and restore after.
function withStubbedEnv<T>(
  run: (env: {
    dispatch: (
      init: Partial<Omit<KeyboardEventLike, "composedPath">>,
    ) => KeyboardEventLike;
    navigations: unknown[];
    disconnect: () => void;
  }) => T,
  view: unknown = { spaceName: "my-space" },
): T {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  function setGlobal(name: string, value: unknown): void {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }

  let listener: ((e: KeyboardEventLike) => void) | undefined;
  setGlobal("navigator", { platform: "MacIntel" });
  setGlobal("document", {
    addEventListener(type: string, fn: (e: KeyboardEventLike) => void) {
      if (type === "keydown") listener = fn;
    },
    removeEventListener(type: string) {
      if (type === "keydown") listener = undefined;
    },
  });

  const navigations: unknown[] = [];
  const onNavigate = (e: Event) => {
    navigations.push((e as CustomEvent).detail);
  };
  globalThis.addEventListener("cf-navigate", onNavigate);

  const controller = new GlobalShortcutsController(
    makeHost(view) as never,
  );
  controller.hostConnected();

  try {
    return run({
      dispatch: (init) => {
        const event = makeEvent(init);
        listener?.(event);
        return event;
      },
      navigations,
      disconnect: () => {
        controller.hostDisconnected();
        expect(listener).toBeUndefined();
      },
    });
  } finally {
    globalThis.removeEventListener("cf-navigate", onNavigate);
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      // deno-lint-ignore no-explicit-any
      else delete (globalThis as any)[name];
    }
  }
}

// The slice of the host the controller touches: it registers itself and reads
// the current view off the app state.
function makeHost(view: unknown) {
  return {
    addController() {},
    app: { view },
  };
}

// The slice of KeyboardEvent the controller reads, plus a `preventDefault` that
// records the call the way the real event does. `path` stands in for the
// composed path, innermost node first, and ends in the two non-element nodes a
// real path ends in.
interface KeyboardEventLike {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
  path: unknown[];
  composedPath(): unknown[];
  preventDefault(): void;
}

function makeEvent(
  init: Partial<Omit<KeyboardEventLike, "composedPath">>,
): KeyboardEventLike {
  const event: KeyboardEventLike = {
    code: "KeyA",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    path: [],
    composedPath: () => [...event.path, { nodeType: 9 }, {}],
    preventDefault() {
      event.defaultPrevented = true;
    },
    ...init,
  };
  return event;
}

describe("GlobalShortcutsController", () => {
  it("navigates to the current space on Alt+W", () => {
    withStubbedEnv(({ dispatch, navigations }) => {
      const event = dispatch({ code: "KeyW", altKey: true });
      expect(navigations).toEqual([{ spaceName: "my-space" }]);
      expect(event.defaultPrevented).toBe(true);
    });
  });

  it("ignores Alt+W carrying any other modifier", () => {
    withStubbedEnv(({ dispatch, navigations }) => {
      dispatch({ code: "KeyW", altKey: true, shiftKey: true });
      dispatch({ code: "KeyW", altKey: true, metaKey: true });
      dispatch({ code: "KeyW", altKey: true, ctrlKey: true });
      dispatch({ code: "KeyW" });
      expect(navigations).toEqual([]);
    });
  });

  it("skips shortcuts aimed at a text-entry element", () => {
    for (
      const target of [
        { tagName: "INPUT" },
        { tagName: "TEXTAREA" },
        { tagName: "SELECT" },
        { tagName: "DIV", isContentEditable: true },
      ]
    ) {
      withStubbedEnv(({ dispatch, navigations }) => {
        const path = [target, { tagName: "BODY" }];
        dispatch({ code: "KeyW", altKey: true, path });
        expect(navigations).toEqual([]);
      });
    }
  });

  it("skips a text-entry element inside a shadow root", () => {
    withStubbedEnv(({ dispatch, navigations }) => {
      // A keydown that crosses a shadow boundary reports the host as its
      // target, so only the composed path still names the input.
      const path = [
        { tagName: "INPUT" },
        { tagName: "X-APP-VIEW" },
        { tagName: "BODY" },
      ];
      dispatch({ code: "KeyW", altKey: true, path });
      expect(navigations).toEqual([]);
    });
  });

  it("still fires for a plain element target", () => {
    withStubbedEnv(({ dispatch, navigations }) => {
      dispatch({
        code: "KeyW",
        altKey: true,
        path: [
          { tagName: "DIV", isContentEditable: false },
          { tagName: "X-APP-VIEW" },
          { tagName: "BODY" },
        ],
      });
      expect(navigations).toHaveLength(1);
    });
  });

  it("skips auto-repeat and events something else already handled", () => {
    withStubbedEnv(({ dispatch, navigations }) => {
      dispatch({ code: "KeyW", altKey: true, repeat: true });
      dispatch({ code: "KeyW", altKey: true, defaultPrevented: true });
      expect(navigations).toEqual([]);
    });
  });

  it("navigates to the space DID when the view addresses one", () => {
    withStubbedEnv(({ dispatch, navigations }) => {
      dispatch({ code: "KeyW", altKey: true });
      expect(navigations).toEqual([{ spaceDid: "did:key:zSpaceX" }]);
    }, { spaceDid: "did:key:zSpaceX", pieceId: "fid1:pieceX" });
  });

  it("falls back to the common knowledge space from the home view", () => {
    withStubbedEnv(({ dispatch, navigations }) => {
      dispatch({ code: "KeyW", altKey: true });
      expect(navigations).toEqual([{ spaceName: "common-knowledge" }]);
    }, { builtin: "home" });
  });

  it("stops listening once the host disconnects", () => {
    withStubbedEnv(({ dispatch, navigations, disconnect }) => {
      disconnect();
      dispatch({ code: "KeyW", altKey: true });
      expect(navigations).toEqual([]);
    });
  });
});

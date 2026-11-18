import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type NavigationCommand,
  openInNewTab,
  openInNewTabWhenReady,
} from "@commonfabric/navigation";

// Exercises the `openInNewTab` helper that backs modifier-click ("open in new
// tab") navigation for cf-cell-link, cf-profile-badge and cf-render (CT-1830).
// The helper dispatches a cancellable `cf-open-external` event before building
// a fabric URL; a host cancels it via `preventDefault()` to apply its own URL
// scheme, otherwise the default (`globalThis.open`) runs.

// `openInNewTab` reads `globalThis.location.href` and calls `globalThis.open`.
// Deno has neither unless configured, so stub both around the call and restore.
function withStubbedEnv<T>(
  href: string,
  run: (calls: { openArgs: unknown[][] }) => T,
): T {
  const calls = { openArgs: [] as unknown[][] };
  const hadLocation = "location" in globalThis &&
    globalThis.location !== undefined;
  // deno-lint-ignore no-explicit-any
  const origLocation = (globalThis as any).location;
  // deno-lint-ignore no-explicit-any
  const origOpen = (globalThis as any).open;
  Object.defineProperty(globalThis, "location", {
    value: { href },
    configurable: true,
    writable: true,
  });
  // deno-lint-ignore no-explicit-any
  (globalThis as any).open = (...args: unknown[]) => {
    calls.openArgs.push(args);
    return null;
  };
  try {
    return run(calls);
  } finally {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).open = origOpen;
    if (hadLocation) {
      Object.defineProperty(globalThis, "location", {
        value: origLocation,
        configurable: true,
        writable: true,
      });
    } else {
      // deno-lint-ignore no-explicit-any
      delete (globalThis as any).location;
    }
  }
}

describe("navigate", () => {
  describe("openInNewTab", () => {
    const view: NavigationCommand = {
      spaceDid: "did:key:zSpaceX",
      pieceId: "fid1:pieceX",
    };

    it("dispatches a cancellable cf-open-external with the navigation target", () => {
      let captured: NavigationCommand | undefined;
      let cancelable = false;
      const onOpen = (e: Event) => {
        captured = (e as CustomEvent<NavigationCommand>).detail;
        cancelable = e.cancelable;
      };
      globalThis.addEventListener("cf-open-external", onOpen);
      try {
        withStubbedEnv("http://localhost:8000/home", () => openInNewTab(view));
      } finally {
        globalThis.removeEventListener("cf-open-external", onOpen);
      }
      expect(captured).toEqual(view);
      expect(cancelable).toBe(true);
    });

    it("falls through to globalThis.open when the event is not cancelled", () => {
      const { openArgs } = withStubbedEnv(
        "http://localhost:8000/home",
        (calls) => {
          openInNewTab(view);
          return calls;
        },
      );
      expect(openArgs.length).toBe(1);
      const [url, target, features] = openArgs[0];
      expect(String(url)).toContain("fid1:pieceX");
      expect(target).toBe("_blank");
      expect(features).toBe("noopener");
    });

    it("preventDefault() on the event suppresses globalThis.open", () => {
      const onOpen = (e: Event) => e.preventDefault();
      globalThis.addEventListener("cf-open-external", onOpen);
      let openArgs: unknown[][];
      try {
        ({ openArgs } = withStubbedEnv(
          "http://localhost:8000/home",
          (calls) => {
            openInNewTab(view);
            return calls;
          },
        ));
      } finally {
        globalThis.removeEventListener("cf-open-external", onOpen);
      }
      expect(openArgs.length).toBe(0);
    });
  });

  describe("openInNewTabWhenReady", () => {
    const view: NavigationCommand = {
      spaceDid: "did:key:zSpaceX",
      pieceId: "fid1:pieceX",
    };

    /** A tab `globalThis.open` hands back, recording what is done to it. */
    function fakeTab() {
      return {
        opener: {} as unknown,
        location: { href: "" },
        closed: false,
        close() {
          this.closed = true;
        },
      };
    }

    /**
     * Runs `act` with `globalThis.location` at `href` and `globalThis.open`
     * answering each call with the next of `tabs` (null once they run out),
     * and restores both after `act` settles.
     */
    async function withOpen(
      tabs: (ReturnType<typeof fakeTab> | null)[],
      act: (openArgs: unknown[][]) => Promise<void>,
    ): Promise<void> {
      const openArgs: unknown[][] = [];
      // deno-lint-ignore no-explicit-any
      const scope = globalThis as any;
      const hadLocation = "location" in globalThis &&
        globalThis.location !== undefined;
      const origLocation = scope.location;
      const origOpen = scope.open;
      Object.defineProperty(globalThis, "location", {
        value: { href: "http://localhost:8000/home" },
        configurable: true,
        writable: true,
      });
      scope.open = (...args: unknown[]) => {
        openArgs.push(args);
        return tabs.shift() ?? null;
      };
      try {
        await act(openArgs);
      } finally {
        scope.open = origOpen;
        if (hadLocation) {
          Object.defineProperty(globalThis, "location", {
            value: origLocation,
            configurable: true,
            writable: true,
          });
        } else {
          delete scope.location;
        }
      }
    }

    it("reserves a tab within the call, and points it at the target once it lands", async () => {
      const tab = fakeTab();
      await withOpen([tab], async (openArgs) => {
        let land!: (command: NavigationCommand) => void;
        const opening = openInNewTabWhenReady(
          new Promise((resolve) => land = resolve),
        );
        expect(openArgs).toEqual([["", "_blank"]]);
        land(view);
        await opening;
      });
      expect(tab.location.href).toContain("fid1:pieceX");
      expect(tab.opener).toBe(null);
      expect(tab.closed).toBe(false);
    });

    it("dispatches the cancellable cf-open-external once the target lands", async () => {
      const seen: NavigationCommand[] = [];
      const onOpen = (e: Event) =>
        seen.push((e as CustomEvent<NavigationCommand>).detail);
      globalThis.addEventListener("cf-open-external", onOpen);
      try {
        await withOpen([fakeTab()], async () => {
          await openInNewTabWhenReady(Promise.resolve(view));
        });
      } finally {
        globalThis.removeEventListener("cf-open-external", onOpen);
      }
      expect(seen).toEqual([view]);
    });

    it("closes the reserved tab when a host takes the event", async () => {
      const tab = fakeTab();
      const onOpen = (e: Event) => e.preventDefault();
      globalThis.addEventListener("cf-open-external", onOpen);
      try {
        await withOpen([tab], async () => {
          await openInNewTabWhenReady(Promise.resolve(view));
        });
      } finally {
        globalThis.removeEventListener("cf-open-external", onOpen);
      }
      expect(tab.closed).toBe(true);
      expect(tab.location.href).toBe("");
    });

    it("closes the reserved tab when there is no target", async () => {
      const tab = fakeTab();
      await withOpen([tab], async () => {
        await openInNewTabWhenReady(Promise.resolve(undefined));
      });
      expect(tab.closed).toBe(true);
    });

    it("closes the reserved tab, and rejects, when finding the target fails", async () => {
      const tab = fakeTab();
      await withOpen([tab], async () => {
        await expect(openInNewTabWhenReady(Promise.reject(new Error("boom"))))
          .rejects.toThrow("boom");
      });
      expect(tab.closed).toBe(true);
    });

    it("opens the target as openInNewTab does when no tab could be reserved", async () => {
      await withOpen([null], async (openArgs) => {
        await openInNewTabWhenReady(Promise.resolve(view));
        expect(openArgs.length).toBe(2);
        const [url, target, features] = openArgs[1];
        expect(String(url)).toContain("fid1:pieceX");
        expect(target).toBe("_blank");
        expect(features).toBe("noopener");
      });
    });
  });
});

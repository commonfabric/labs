import { expect } from "@std/expect";

import {
  type NavigationCommand,
  newTabReservationEnabled,
  type OpenExternalEvent,
  openInNewTab,
  openInNewTabWhenReady,
  setNewTabReservation,
} from "@commonfabric/navigation";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

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

    // The cases below are a host that has turned reserving on, as the shell
    // does; the cases for one that has not turn it off themselves.
    beforeEach(() => setNewTabReservation(true));
    afterEach(() => setNewTabReservation(false));

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

    /** A pending target, with the function that settles it. */
    function pendingTarget() {
      let land!: (command: NavigationCommand | undefined) => void;
      let fail!: (error: Error) => void;
      const promise = new Promise<NavigationCommand | undefined>(
        (resolve, reject) => {
          land = resolve;
          fail = reject;
        },
      );
      return { promise, land, fail };
    }

    /** Lets a timer due now, and what it leads to, run. */
    const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

    it("reserves nothing while reserving is off: a slow target opens as openInNewTab does once it lands", async () => {
      setNewTabReservation(false);
      await withOpen([fakeTab()], async (openArgs) => {
        const target = pendingTarget();
        const opening = openInNewTabWhenReady(target.promise, {
          reserveAfterMs: 0,
        });
        await nextTask();
        expect(openArgs).toEqual([]);
        target.land(view);
        await opening;
        expect(openArgs.length).toBe(1);
        const [url, tabTarget, features] = openArgs[0];
        expect(String(url)).toContain("fid1:pieceX");
        expect(tabTarget).toBe("_blank");
        expect(features).toBe("noopener");
      });
    });

    it("hands a host that takes the event a slow target with no reserved tab while reserving is off", async () => {
      setNewTabReservation(false);
      const seen: unknown[] = [];
      const onOpen = (e: Event) => {
        e.preventDefault();
        seen.push((e as OpenExternalEvent).claimReservedTab);
      };
      globalThis.addEventListener("cf-open-external", onOpen);
      try {
        await withOpen([fakeTab()], async (openArgs) => {
          const target = pendingTarget();
          const opening = openInNewTabWhenReady(target.promise, {
            reserveAfterMs: 0,
          });
          await nextTask();
          target.land(view);
          await opening;
          expect(openArgs).toEqual([]);
        });
      } finally {
        globalThis.removeEventListener("cf-open-external", onOpen);
      }
      expect(seen).toEqual([undefined]);
    });

    it("opens a target that lands before the deadline as openInNewTab does, reserving nothing", async () => {
      await withOpen([], async (openArgs) => {
        await openInNewTabWhenReady(Promise.resolve(view), {
          reserveAfterMs: 60_000,
        });
        expect(openArgs.length).toBe(1);
        const [url, target, features] = openArgs[0];
        expect(String(url)).toContain("fid1:pieceX");
        expect(target).toBe("_blank");
        expect(features).toBe("noopener");
      });
    });

    it("reserves a tab once the deadline passes, and points it at the target once it lands", async () => {
      const tab = fakeTab();
      await withOpen([tab], async (openArgs) => {
        const target = pendingTarget();
        const opening = openInNewTabWhenReady(target.promise, {
          reserveAfterMs: 0,
        });
        await nextTask();
        expect(openArgs).toEqual([["", "_blank"]]);
        target.land(view);
        await opening;
      });
      expect(tab.location.href).toContain("fid1:pieceX");
      expect(tab.opener).toBe(null);
      expect(tab.closed).toBe(false);
    });

    it("offers the reserved tab to a host that takes the event", async () => {
      const tab = fakeTab();
      const onOpen = (e: Event) => {
        e.preventDefault();
        const claimed = (e as OpenExternalEvent).claimReservedTab!();
        claimed.location.href = "loom://piece/fid1:pieceX";
      };
      globalThis.addEventListener("cf-open-external", onOpen);
      try {
        await withOpen([tab], async () => {
          const target = pendingTarget();
          const opening = openInNewTabWhenReady(target.promise, {
            reserveAfterMs: 0,
          });
          await nextTask();
          target.land(view);
          await opening;
        });
      } finally {
        globalThis.removeEventListener("cf-open-external", onOpen);
      }
      expect(tab.location.href).toBe("loom://piece/fid1:pieceX");
      expect(tab.closed).toBe(false);
      // Cut from this page, as a tab opened with `noopener` is.
      expect(tab.opener).toBe(null);
    });

    it("dispatches the cancellable cf-open-external with the target, reserved tab or not", async () => {
      const seen: { detail: NavigationCommand; cancelable: boolean }[] = [];
      const onOpen = (e: Event) =>
        seen.push({
          detail: (e as CustomEvent<NavigationCommand>).detail,
          cancelable: e.cancelable,
        });
      globalThis.addEventListener("cf-open-external", onOpen);
      try {
        await withOpen([fakeTab()], async () => {
          await openInNewTabWhenReady(Promise.resolve(view), {
            reserveAfterMs: 60_000,
          });
          const target = pendingTarget();
          const opening = openInNewTabWhenReady(target.promise, {
            reserveAfterMs: 0,
          });
          await nextTask();
          target.land(view);
          await opening;
        });
      } finally {
        globalThis.removeEventListener("cf-open-external", onOpen);
      }
      expect(seen).toEqual([
        { detail: view, cancelable: true },
        { detail: view, cancelable: true },
      ]);
    });

    it("closes the reserved tab when a host takes the event without claiming it", async () => {
      const tab = fakeTab();
      const onOpen = (e: Event) => e.preventDefault();
      globalThis.addEventListener("cf-open-external", onOpen);
      try {
        await withOpen([tab], async () => {
          const target = pendingTarget();
          const opening = openInNewTabWhenReady(target.promise, {
            reserveAfterMs: 0,
          });
          await nextTask();
          target.land(view);
          await opening;
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
        const target = pendingTarget();
        const opening = openInNewTabWhenReady(target.promise, {
          reserveAfterMs: 0,
        });
        await nextTask();
        target.land(undefined);
        await opening;
      });
      expect(tab.closed).toBe(true);
    });

    it("closes the reserved tab, and rejects, when finding the target fails", async () => {
      const tab = fakeTab();
      await withOpen([tab], async () => {
        const target = pendingTarget();
        const opening = openInNewTabWhenReady(target.promise, {
          reserveAfterMs: 0,
        });
        await nextTask();
        target.fail(new Error("boom"));
        await expect(opening).rejects.toThrow("boom");
      });
      expect(tab.closed).toBe(true);
    });

    it("reserves nothing for a target that is not there, or fails, before the deadline", async () => {
      await withOpen([], async (openArgs) => {
        await openInNewTabWhenReady(Promise.resolve(undefined), {
          reserveAfterMs: 60_000,
        });
        await expect(
          openInNewTabWhenReady(Promise.reject(new Error("boom")), {
            reserveAfterMs: 60_000,
          }),
        ).rejects.toThrow("boom");
        expect(openArgs).toEqual([]);
      });
    });

    it("opens the target as openInNewTab does when the browser opened no reserved tab", async () => {
      await withOpen([null], async (openArgs) => {
        const target = pendingTarget();
        const opening = openInNewTabWhenReady(target.promise, {
          reserveAfterMs: 0,
        });
        await nextTask();
        target.land(view);
        await opening;
        expect(openArgs.length).toBe(2);
        const [url, tabTarget, features] = openArgs[1];
        expect(String(url)).toContain("fid1:pieceX");
        expect(tabTarget).toBe("_blank");
        expect(features).toBe("noopener");
      });
    });
  });

  describe("setNewTabReservation", () => {
    it("is off until a host turns it on, and off again once it turns it off", () => {
      expect(newTabReservationEnabled()).toBe(false);
      setNewTabReservation(true);
      expect(newTabReservationEnabled()).toBe(true);
      setNewTabReservation(false);
      expect(newTabReservationEnabled()).toBe(false);
    });
  });
});

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type NavigationCommand, openInNewTab } from "@commonfabric/navigation";

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
});

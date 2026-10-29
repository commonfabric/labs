import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  consoleMount,
  consolePath,
  liveCanonicalRedirect,
  pageMount,
} from "../../../console/src/mount.ts";

describe("console/src/mount", () => {
  describe("consoleMount()", () => {
    it("is the root for the console's own page at its own origin", () => {
      expect(consoleMount("/")).toBe("");
    });

    it("is the root for a live pane at the console's own origin", () => {
      expect(consoleMount("/live/session-1")).toBe("");
      expect(consoleMount("/live/session-1/")).toBe("");
    });

    it("is the host's prefix for the console's page served under one", () => {
      // loom's daemon fronts the console at /harness-console on its origin.
      expect(consoleMount("/harness-console/")).toBe("/harness-console");
      expect(consoleMount("/harness-console")).toBe("/harness-console");
    });

    it("is the host's prefix for a live pane served under one", () => {
      expect(consoleMount("/harness-console/live/session-1")).toBe(
        "/harness-console",
      );
      expect(consoleMount("/harness-console/live/session%2F1/")).toBe(
        "/harness-console",
      );
    });

    it("keeps a deeper prefix whole", () => {
      expect(consoleMount("/a/b/live/session-1")).toBe("/a/b");
      expect(consoleMount("/a/b/")).toBe("/a/b");
    });

    it("returns a canonical mount with no trailing slash from a doubled path", () => {
      // `consolePath` hangs every route off the mount, so a mount ending in
      // a slash would build `/a//api`. The mount is canonicalized instead.
      expect(consoleMount("/a//live/session-1")).toBe("/a");
      expect(consolePath(consoleMount("/a//live/session-1"), "/api/x")).toBe(
        "/a/api/x",
      );
    });
  });

  describe("consolePath()", () => {
    it("addresses a console path under the mount", () => {
      expect(consolePath("", "/api/events?sessionId=s")).toBe(
        "/api/events?sessionId=s",
      );
      expect(consolePath("/harness-console", "/api/task")).toBe(
        "/harness-console/api/task",
      );
    });
  });

  describe("pageMount()", () => {
    it("is the root outside a page, where there is no address", () => {
      // Deno runs these tests without a location; every path stays as it was
      // before mounts existed.
      expect(pageMount()).toBe("");
    });

    it("reads the mount off the page's own address when there is one", () => {
      // The real path the browser is on — a page served under a host prefix
      // sees its prefix here, which is what prepends to every fetch/stream.
      const original = Reflect.getOwnPropertyDescriptor(globalThis, "location");
      try {
        for (
          const [path, mount] of [
            ["/", ""],
            ["/harness-console/", "/harness-console"],
            ["/harness-console/live/session-1", "/harness-console"],
          ] as const
        ) {
          Object.defineProperty(globalThis, "location", {
            value: { pathname: path },
            configurable: true,
          });
          expect(pageMount()).toBe(mount);
        }
      } finally {
        if (original) Object.defineProperty(globalThis, "location", original);
        else Reflect.deleteProperty(globalThis, "location");
      }
    });
  });

  describe("liveCanonicalRedirect()", () => {
    it("sends the trailing-slash live address one level up, relatively", () => {
      // Relative so it resolves under any mount on the client: from
      // <mount>/live/session-1/ to <mount>/live/session-1.
      expect(liveCanonicalRedirect("/live/session-1/")).toBe("../session-1");
      expect(liveCanonicalRedirect("/live/session%2F1/")).toBe(
        "../session%2F1",
      );
    });

    it("carries the address's query through the redirect", () => {
      expect(liveCanonicalRedirect("/live/session-1/", "?turn=t1")).toBe(
        "../session-1?turn=t1",
      );
      expect(
        liveCanonicalRedirect(
          "/live/session-1/",
          "?turn=t1&piecesBase=http%3A%2F%2Fh%2Fpattern-pane",
        ),
      ).toBe("../session-1?turn=t1&piecesBase=http%3A%2F%2Fh%2Fpattern-pane");
      expect(liveCanonicalRedirect("/live/session-1/", "")).toBe(
        "../session-1",
      );
    });

    it("leaves every other address alone", () => {
      expect(liveCanonicalRedirect("/live/session-1")).toBeUndefined();
      expect(liveCanonicalRedirect("/live/")).toBeUndefined();
      expect(liveCanonicalRedirect("/")).toBeUndefined();
      expect(liveCanonicalRedirect("/live/session-1/turn-1")).toBeUndefined();
    });
  });
});

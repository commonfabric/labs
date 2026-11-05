/**
 * Unit tests for the Browser Access lease contract: CDP origin normalization
 * and lease freshness validation.
 */

import { describe, it } from "@std/testing/bdd";

import { expect } from "@std/expect";

import {
  normalizeCdpOrigin,
  redactCdpEndpoint,
  validateBrowserAccessLeaseFreshness,
} from "../src/contracts/browser-access.ts";

describe("browser-access", () => {
  describe("normalizeCdpOrigin", () => {
    it("returns the origin for an http local endpoint with an explicit port", () => {
      expect(normalizeCdpOrigin("http://127.0.0.1:9222")).toBe(
        "http://127.0.0.1:9222",
      );
      expect(normalizeCdpOrigin("http://localhost:9362/")).toBe(
        "http://localhost:9362",
      );
      expect(normalizeCdpOrigin("http://host.docker.internal:9362")).toBe(
        "http://host.docker.internal:9362",
      );
      expect(normalizeCdpOrigin("http://[::1]:9222")).toBe(
        "http://[::1]:9222",
      );
    });

    it("returns undefined for undefined and for unparseable endpoints", () => {
      expect(normalizeCdpOrigin(undefined)).toBeUndefined();
      expect(normalizeCdpOrigin("not a url")).toBeUndefined();
    });

    it("returns undefined for non-http schemes", () => {
      expect(normalizeCdpOrigin("https://127.0.0.1:9222")).toBeUndefined();
      expect(normalizeCdpOrigin("ws://127.0.0.1:9222")).toBeUndefined();
    });

    it("returns undefined for hosts that are not local", () => {
      expect(normalizeCdpOrigin("http://browser.example.com:9222"))
        .toBeUndefined();
      expect(normalizeCdpOrigin("http://10.0.0.5:9222")).toBeUndefined();
    });

    it("returns undefined without an explicit valid port", () => {
      expect(normalizeCdpOrigin("http://127.0.0.1")).toBeUndefined();
      expect(normalizeCdpOrigin("http://127.0.0.1:0")).toBeUndefined();
    });

    it("returns undefined when a path, query, or fragment rides along", () => {
      expect(normalizeCdpOrigin("http://127.0.0.1:9222/devtools"))
        .toBeUndefined();
      expect(normalizeCdpOrigin("http://127.0.0.1:9222/?a=b")).toBeUndefined();
      expect(normalizeCdpOrigin("http://127.0.0.1:9222/#frag")).toBeUndefined();
    });
  });

  describe("redactCdpEndpoint", () => {
    it("scrubs verbatim, URL-encoded, and bare host:port echoes", () => {
      const origin = "http://localhost:9362";
      expect(redactCdpEndpoint("connect http://localhost:9362 now", origin))
        .toBe("connect <lease endpoint> now");
      expect(
        redactCdpEndpoint("err=http%3A%2F%2Flocalhost%3A9362", origin),
      ).toBe("err=<lease endpoint>");
      expect(redactCdpEndpoint("dial tcp localhost:9362 refused", origin))
        .toBe("dial tcp <lease endpoint> refused");
    });

    it("leaves text without an echo unchanged", () => {
      expect(
        redactCdpEndpoint(
          "open http://localhost:8000/piece",
          "http://localhost:9362",
        ),
      ).toBe("open http://localhost:8000/piece");
    });
  });

  describe("validateBrowserAccessLeaseFreshness", () => {
    it("accepts an absent or blank expiry", () => {
      expect(validateBrowserAccessLeaseFreshness(undefined)).toBeUndefined();
      expect(validateBrowserAccessLeaseFreshness("  ")).toBeUndefined();
    });

    it("rejects an unparseable expiry", () => {
      expect(validateBrowserAccessLeaseFreshness("not a time")).toBe(
        "Browser Access lease expiry is invalid",
      );
    });

    it("rejects an expiry at or before now", () => {
      const now = new Date("2026-08-20T12:00:00.000Z");
      expect(
        validateBrowserAccessLeaseFreshness("2026-08-20T12:00:00.000Z", {
          now,
        }),
      ).toBe("Browser Access lease has expired");
    });

    it("accepts an expiry after now", () => {
      const now = new Date("2026-08-20T12:00:00.000Z");
      expect(
        validateBrowserAccessLeaseFreshness("2026-08-20T12:00:01.000Z", {
          now,
        }),
      ).toBeUndefined();
    });
  });
});

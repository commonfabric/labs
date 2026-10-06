import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fabricAuthorityMatchesSpaceHost,
  namesApiOrigin,
  normalizeSpaceHost,
  parseMemoryUrl,
  readMemoryUrl,
  spaceHostFromFabricAuthority,
  SpaceHostValidationError,
} from "../src/space-host.ts";

/** Returns the `Error` thrown by `run`. */
function captureError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected call to throw");
}

/** Returns a URL whose `.href` getter throws `cause`. */
function urlWithThrowingHref(cause: Error): URL {
  const host = new URL("https://route.example/");
  Object.defineProperty(host, "href", {
    get() {
      throw cause;
    },
  });
  return host;
}

describe("space-host", () => {
  describe("normalizeSpaceHost()", () => {
    it("returns the canonical HTTP or HTTPS origin", () => {
      expect(normalizeSpaceHost("HTTPS://ROUTE.EXAMPLE:443").toString()).toBe(
        "https://route.example/",
      );
      expect(
        normalizeSpaceHost(new URL("http://route.example:8080")).toString(),
      )
        .toBe("http://route.example:8080/");
    });

    it("throws for every component beyond the origin", () => {
      for (
        const host of [
          "https://@route.example/",
          "https://:@route.example/",
          "https://user@route.example/",
          "https://user:secret@route.example/",
          "https://route.example/api",
          "https://route.example/api/..",
          "https://route.example/%2e%2e/",
          "https://route.example/?region=west",
          "https://route.example/?",
          "https://route.example/#primary",
          "https://route.example/#",
        ]
      ) {
        expect(() => normalizeSpaceHost(host)).toThrow();
      }
    });

    it("throws for protocols that cannot serve shared space routes", () => {
      for (
        const host of [
          "ws://route.example/",
          "wss://route.example/",
          "ftp://route.example/",
        ]
      ) {
        expect(() => normalizeSpaceHost(host)).toThrow(
          "Unsupported space host protocol",
        );
      }
    });

    it("propagates errors while reading URL objects unchanged", () => {
      for (
        const cause of [
          new Error("unexpected URL read failure"),
          new TypeError("unexpected URL read type failure"),
        ]
      ) {
        expect(
          captureError(() => normalizeSpaceHost(urlWithThrowingHref(cause))),
        )
          .toBe(cause);
      }
    });

    it("throws a sanitized validation error for malformed strings", () => {
      const secret = "parser-password-sentinel";
      const error = captureError(() =>
        normalizeSpaceHost(`https://user:${secret}@[`)
      );
      expect(error).toBeInstanceOf(SpaceHostValidationError);
      expect(error.message).toBe("Invalid space host URL");
      expect(error.message).not.toContain(secret);
    });
  });

  describe("spaceHostFromFabricAuthority()", () => {
    it("returns an HTTPS origin for a bare fabric authority", () => {
      expect(spaceHostFromFabricAuthority("ROUTE.EXAMPLE:443").toString()).toBe(
        "https://route.example/",
      );
      expect(spaceHostFromFabricAuthority("localhost:8787").toString()).toBe(
        "https://localhost:8787/",
      );
    });

    it("returns an HTTP origin for a requested loopback route", () => {
      for (
        const authority of [
          "localhost:8787",
          "localhost.:8787",
          "127.0.0.1:8787",
          "[::1]:8787",
        ]
      ) {
        expect(
          spaceHostFromFabricAuthority(authority, {
            useLoopbackHttp: true,
          }).protocol,
        ).toBe("http:");
      }
      for (const authority of ["route.example:8787", "route.example.:8787"]) {
        expect(
          spaceHostFromFabricAuthority(authority, {
            useLoopbackHttp: true,
          }).protocol,
        ).toBe("https:");
      }
      expect(
        spaceHostFromFabricAuthority("localhost:443", {
          useLoopbackHttp: true,
        }).toString(),
      ).toBe("http://localhost:443/");
    });

    it("throws for authority components beyond the origin", () => {
      for (
        const authority of [
          "user@route.example",
          "route.example/api",
          "route.example?region=west",
          "route.example#primary",
        ]
      ) {
        expect(() => spaceHostFromFabricAuthority(authority)).toThrow();
      }
    });
  });

  describe("fabricAuthorityMatchesSpaceHost()", () => {
    it("compares an authority using the route's configured transport", () => {
      expect(
        fabricAuthorityMatchesSpaceHost(
          "ROUTE.EXAMPLE:80",
          "http://route.example/",
        ),
      ).toBe(true);
      expect(
        fabricAuthorityMatchesSpaceHost(
          "ROUTE.EXAMPLE:443",
          "https://route.example/",
        ),
      ).toBe(true);
      expect(
        fabricAuthorityMatchesSpaceHost(
          "other.example",
          "https://route.example/",
        ),
      ).toBe(false);
    });

    it("throws for non-authority components", () => {
      for (const authority of ["user@route.example", "route.example/api"]) {
        expect(() =>
          fabricAuthorityMatchesSpaceHost(
            authority,
            "https://route.example/",
          )
        ).toThrow();
      }
    });
  });

  describe("parseMemoryUrl", () => {
    const apiUrl = new URL("https://app.example/base/");

    it("reads an origin of another host, and none for the API host's own", () => {
      expect(parseMemoryUrl("https://router.example", apiUrl)?.href).toBe(
        "https://router.example/",
      );
      for (const none of [undefined, "", "https://app.example"]) {
        expect(parseMemoryUrl(none, apiUrl)).toBeUndefined();
      }
    });

    it("returns none for the API URL itself, path and all, before the origin rule applies", () => {
      // A client with no memory URL hands on the host its storage opened on,
      // which is the API URL as it stands.
      for (
        const value of [
          "https://app.example/base/",
          new URL("https://app.example/base/"),
          "https://app.example/other?q",
        ]
      ) {
        expect(parseMemoryUrl(value, apiUrl)).toBeUndefined();
      }
      // Without an API URL to compare with, the origin rule decides.
      expect(captureError(() => parseMemoryUrl("https://app.example/base/")))
        .toBeInstanceOf(SpaceHostValidationError);
    });

    it("refuses what is not an origin, calling it a memory URL", () => {
      for (
        const [value, message] of [
          ["router.example", "Invalid memory URL"],
          ["wss://router.example", "Unsupported memory URL protocol"],
          [
            "https://u@router.example",
            "Memory URL must not include credentials",
          ],
          ["https://router.example/api", "Memory URL must not include a path"],
          ["https://router.example/?a", "Memory URL must not include a query"],
          [
            "https://router.example/#a",
            "Memory URL must not include a fragment",
          ],
          [
            "https://router.example\\",
            "Memory URL must contain only an origin",
          ],
        ]
      ) {
        const error = captureError(() => parseMemoryUrl(value, apiUrl));
        expect(error).toBeInstanceOf(SpaceHostValidationError);
        expect(error.message, value).toBe(message);
      }
    });

    it("leaves a space host's refusals worded for a space host", () => {
      expect(
        captureError(() => normalizeSpaceHost("https://h.example/api")).message,
      )
        .toBe("Space host must not include a path");
    });
  });

  describe("readMemoryUrl", () => {
    it("returns the reason it refuses a value rather than throwing", () => {
      expect(readMemoryUrl("https://router.example/api")).toEqual({
        refused: "Memory URL must not include a path",
      });
      expect(readMemoryUrl(42)).toEqual({ refused: "expected a string" });
      expect(readMemoryUrl(null)).toEqual({ memoryUrl: undefined });
      expect(readMemoryUrl("https://router.example")).toEqual({
        memoryUrl: new URL("https://router.example/"),
      });
    });
  });

  describe("namesApiOrigin", () => {
    it("compares origins, so a path on the API URL is the same host", () => {
      const apiUrl = new URL("https://app.example/base/");
      expect(namesApiOrigin(new URL("https://app.example"), apiUrl)).toBe(true);
      expect(namesApiOrigin(new URL("https://app.example:8443"), apiUrl))
        .toBe(false);
      expect(namesApiOrigin(new URL("http://app.example"), apiUrl)).toBe(false);
    });

    it("names nothing with an opaque origin", () => {
      expect(namesApiOrigin(new URL("memory://a"), new URL("memory://b")))
        .toBe(false);
    });

    it("names nothing with a URL that is not HTTP or HTTPS, even one that reports the API URL's origin", () => {
      const apiUrl = new URL("https://app.example/");
      const blob = new URL("blob:https://app.example/x");
      expect(blob.origin).toBe(apiUrl.origin);
      expect(namesApiOrigin(blob, apiUrl)).toBe(false);
    });
  });
});

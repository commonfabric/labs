import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  normalizePatternSource,
  resolveSystemPatternSource,
  systemPatternSource,
} from "../src/pattern-source-scheme.ts";

const HOST = "http://toolshed.test";

describe("resolveSystemPatternSource", () => {
  it("expands a ref to its patterns route", () => {
    expect(
      resolveSystemPatternSource(systemPatternSource("lunch-poll/main.tsx")),
    ).toBe("/api/patterns/lunch-poll/main.tsx");
    expect(resolveSystemPatternSource("system:system/default-app.tsx"))
      .toBe("/api/patterns/system/default-app.tsx");
  });

  it("refuses everything that is not a well-formed ref", () => {
    // The whitelist is the point. Each of these either did produce a fetch
    // under the old "any same-origin path" rule, or would under a looser one.
    for (
      const source of [
        "cf:published-pattern",
        "/api/patterns/system/home.tsx", // the pre-scheme spelling, unrewritten
        "/participant-identity-card.tsx", // a file-tree module name
        "/main.tsx",
        "http://toolshed.test/api/patterns/system/home.tsx",
        "system:", // no path
        "system:/leading-slash.tsx",
        "system:main.tsx?identity=", // the updater adds the query, not the ref
        "system:main.tsx#frag",
        "",
      ]
    ) {
      expect(resolveSystemPatternSource(source)).toBeUndefined();
    }
  });

  it("refuses a ref that climbs out of the patterns route", () => {
    expect(resolveSystemPatternSource("system:../secrets.tsx")).toBeUndefined();
    expect(resolveSystemPatternSource("system:system/../../etc/passwd"))
      .toBeUndefined();
    // The URL parser normalizes `%2e%2e` into a double-dot segment, but never
    // decodes `%2f`, so an encoded separator survives normalization as one
    // opaque segment and passes a bare prefix check.
    expect(resolveSystemPatternSource("system:%2e%2e/%2e%2e/x.tsx"))
      .toBeUndefined();
    expect(resolveSystemPatternSource("system:..%2f..%2fetc/passwd"))
      .toBeUndefined();
    // A malformed escape cannot be decoded, so it cannot be cleared either.
    expect(resolveSystemPatternSource("system:%")).toBeUndefined();
    // Climbing back in is fine — it still addresses the route.
    expect(resolveSystemPatternSource("system:system/../system/home.tsx"))
      .toBe("/api/patterns/system/home.tsx");
  });

  it("rethrows a decoder's `TypeError` unchanged", () => {
    const failure = new TypeError("Unexpected decoding failure");
    using _decode = stub(globalThis, "decodeURIComponent", () => {
      throw failure;
    });
    let caught: unknown;
    try {
      resolveSystemPatternSource("system:system/home.tsx");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
  });
});

describe("normalizePatternSource", () => {
  it("rewrites the rooted route path a system root was stamped with", () => {
    expect(normalizePatternSource("/api/patterns/system/home.tsx"))
      .toBe("system:system/home.tsx");
    expect(normalizePatternSource("/api/patterns/custom/my-app.tsx", HOST))
      .toBe("system:custom/my-app.tsx");
  });

  it("rewrites the absolute form only for the space's own host", () => {
    expect(
      normalizePatternSource(`${HOST}/api/patterns/system/home.tsx`, HOST),
    ).toBe("system:system/home.tsx");
    // Another host's route is not this host's to re-point at.
    expect(
      normalizePatternSource("http://elsewhere.test/api/patterns/x.tsx", HOST),
    ).toBe("http://elsewhere.test/api/patterns/x.tsx");
    // This host, but not the patterns route: nothing to rewrite it into.
    expect(normalizePatternSource(`${HOST}/api/other/thing.tsx`, HOST))
      .toBe(`${HOST}/api/other/thing.tsx`);
    // With no host there is nothing to compare against.
    expect(normalizePatternSource(`${HOST}/api/patterns/system/home.tsx`))
      .toBe(`${HOST}/api/patterns/system/home.tsx`);
  });

  it("drops a query or fragment rather than minting an unusable ref", () => {
    // The patterns route serves a file by path, so neither selects anything;
    // keeping either would name a ref the resolver rejects, leaving the piece
    // with provenance nothing would follow again.
    expect(normalizePatternSource("/api/patterns/custom/my-app.tsx?v=2", HOST))
      .toBe("system:custom/my-app.tsx");
    expect(normalizePatternSource(`${HOST}/api/patterns/x.tsx#frag`, HOST))
      .toBe("system:x.tsx");
  });

  it("refuses a legacy locator that names another host", () => {
    // Each of these has a local-looking pathname but an authority of its own,
    // so rewriting it would move the piece onto this toolshed's copy.
    for (
      const source of [
        "//elsewhere.test/api/patterns/x.tsx",
        "/\\elsewhere.test/api/patterns/x.tsx",
        "http://elsewhere.test/api/patterns/x.tsx",
      ]
    ) {
      expect(normalizePatternSource(source, HOST)).toBe(source);
    }
  });

  it("refuses a legacy locator that does not address a file on the route", () => {
    // Climbing, an empty path, and a doubled separator each denote a ref that
    // cannot resolve, so the locator is left as authored instead.
    for (
      const source of [
        "/api/patterns/../../etc/passwd",
        "/api/patterns/",
        "/api/patterns//x.tsx",
        "/api/patterns/..%2f..%2fx.tsx",
      ]
    ) {
      expect(normalizePatternSource(source, HOST)).toBe(source);
    }
  });

  it("never returns a rewrite its own resolver would reject", () => {
    // The invariant the two functions have to keep between them: whatever
    // normalization hands back is either the input or a usable ref.
    for (
      const source of [
        "/api/patterns/system/home.tsx",
        "/api/patterns/x?v=2",
        "/api/patterns/x#f",
        "/api/patterns/",
        "/api/patterns//x",
        "/api/patterns/../..",
        "/api/patterns/..%2fx",
        "/api/patterns/%",
        "/main.tsx",
        "/",
        `${HOST}/api/patterns/system/home.tsx`,
        `${HOST}/api/patterns/`,
        `${HOST}/api/other/x.tsx`,
        "http://elsewhere.test/api/patterns/x.tsx",
        "cf:published-pattern",
        "system:system/home.tsx",
        "",
      ]
    ) {
      const normalized = normalizePatternSource(source, HOST);
      if (normalized === source) continue;
      expect(resolveSystemPatternSource(normalized)).toBeDefined();
    }
  });

  it("leaves everything else exactly as it found it", () => {
    for (
      const source of [
        "cf:published-pattern",
        "system:system/home.tsx",
        "/main.tsx",
        "/api/other/thing.tsx",
        `${HOST}/api/other/thing.tsx`,
        "not an origin",
      ]
    ) {
      expect(normalizePatternSource(source, HOST)).toBe(source);
    }
  });
});

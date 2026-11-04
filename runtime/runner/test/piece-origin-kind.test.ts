import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { classifyPieceOriginString } from "../src/piece-origin-kind.ts";
import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";

// The fabric branch parses specifiers through the sync parse internals, which
// sit below the async flow boundaries that normally load the compiler stack.
await ensureCompilerStack();

const HASH = "Avcny13Rj8q-2ClANy_-k0ikWWQcXx7QTdsiqGfrC1c";
const HOST = "https://toolshed.example";

describe("piece-origin-kind", () => {
  describe("classifyPieceOriginString", () => {
    it("returns the route a system ref addresses", () => {
      expect(
        classifyPieceOriginString("system:system/default-app/default-app.tsx"),
      )
        .toEqual({
          kind: "system",
          ref: "system:system/default-app/default-app.tsx",
          route: "/api/patterns/system/default-app/default-app.tsx",
        });
    });

    it("ignores surrounding whitespace", () => {
      expect(classifyPieceOriginString("  system:a/b.tsx\n")).toEqual({
        kind: "system",
        ref: "system:a/b.tsx",
        route: "/api/patterns/a/b.tsx",
      });
    });

    it("returns unusable for a system ref that climbs out of the route", () => {
      expect(classifyPieceOriginString("system:../../etc/passwd").kind)
        .toBe("unusable");
    });

    it("returns unusable for an empty origin", () => {
      const kind = classifyPieceOriginString("   ");
      expect(kind).toEqual({ kind: "unusable", reason: "the origin is empty" });
    });

    it("returns fabric-entity for an unpinned fabric ref", () => {
      const kind = classifyPieceOriginString("cf:/kitchen/todo-list");
      expect(kind.kind).toBe("fabric-entity");
    });

    it("returns fabric-pattern with the identity a pin fixes", () => {
      const kind = classifyPieceOriginString(`cf:todo-list@${HASH}`);
      expect(kind.kind).toBe("fabric-pattern");
      expect(kind.kind === "fabric-pattern" ? kind.identity : undefined)
        .toBe(HASH);
    });

    it("returns fabric-pattern for content-addressed source", () => {
      const kind = classifyPieceOriginString(`cf:pattern:${HASH}`);
      expect(kind.kind).toBe("fabric-pattern");
      expect(kind.kind === "fabric-pattern" ? kind.identity : undefined)
        .toBe(HASH);
    });

    it("returns unusable for a fabric ref the parser refuses", () => {
      const kind = classifyPieceOriginString("cf://");
      expect(kind.kind).toBe("unusable");
      expect(kind.kind === "unusable" ? kind.reason : "")
        .toContain("not a usable fabric URL");
    });

    it("returns the system ref a legacy route path names", () => {
      expect(classifyPieceOriginString("/api/patterns/system/home/home.tsx"))
        .toEqual({
          kind: "legacy-path",
          path: "/api/patterns/system/home/home.tsx",
          ref: "system:system/home/home.tsx",
        });
    });

    it("returns a legacy path with no ref for a path off the route", () => {
      expect(classifyPieceOriginString("/participant-card.tsx")).toEqual({
        kind: "legacy-path",
        path: "/participant-card.tsx",
      });
    });

    it("returns unusable for a network-path reference", () => {
      // A leading `//` opens an authority rather than a path, so the string
      // names no scheme and nothing can resolve it. A malformed authority is
      // the case that reads as a path right up to the URL parser.
      expect(classifyPieceOriginString("//[").kind).toBe("unusable");
      expect(
        classifyPieceOriginString("//evil.example/api/patterns/x.tsx")
          .kind,
      ).toBe("unusable");
    });

    it("returns unusable for an absolute external endpoint", () => {
      expect(classifyPieceOriginString("https://elsewhere.example/p.tsx"))
        .toEqual({
          kind: "unusable",
          reason:
            "https://elsewhere.example/p.tsx is an external endpoint, which " +
            "is not a source origin",
        });
    });

    it("returns unusable for a scheme that serves no program", () => {
      const kind = classifyPieceOriginString("file:///tmp/p.tsx");
      expect(kind).toEqual({
        kind: "unusable",
        reason: "file:///tmp/p.tsx names no program",
      });
    });

    it("returns unusable for a relative locator", () => {
      const kind = classifyPieceOriginString("./p.tsx");
      expect(kind).toEqual({
        kind: "unusable",
        reason: "./p.tsx is not an absolute URL",
      });
    });

    it("returns legacy-path for the route spelled against the space's host", () => {
      expect(
        classifyPieceOriginString(
          `${HOST}/api/patterns/system/home/home.tsx`,
          HOST,
        ),
      ).toEqual({
        kind: "legacy-path",
        path: `${HOST}/api/patterns/system/home/home.tsx`,
        ref: "system:system/home/home.tsx",
      });
    });

    it("returns unusable for the same route on another host", () => {
      const source = "https://other.example/api/patterns/system/home/home.tsx";
      expect(classifyPieceOriginString(source, HOST)).toEqual({
        kind: "unusable",
        reason:
          `${source} is an external endpoint, which is not a source origin`,
      });
    });

    it("returns unusable for the route spelled absolutely with no host to compare", () => {
      const source = `${HOST}/api/patterns/system/home/home.tsx`;
      expect(classifyPieceOriginString(source)).toEqual({
        kind: "unusable",
        reason:
          `${source} is an external endpoint, which is not a source origin`,
      });
    });
  });
});

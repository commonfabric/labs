import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { asSpaceSegment, parseFabricUrl } from "../src/fabric-url.ts";

const HASH = "V2tROHl4KsExx5M0fYnkQaOryFwjVUkqXIlcdMWz7SQ";
const SPACE = "did:key:z6MkpXpeKbhbddoVvxQndKtnNZmGfpSbXXmVw88bswFy2hHh";
const HOSTS = ["fabric.example", "localhost:8000"];

describe("fabric-url", () => {
  describe("parseFabricUrl()", () => {
    describe("a tagged hash on its own", () => {
      it("returns the id for a bare hash", () => {
        expect(parseFabricUrl(`fid1:${HASH}`)).toEqual({
          id: `of:fid1:${HASH}`,
          path: [],
        });
      });

      it("returns the id for a schemed hash", () => {
        expect(parseFabricUrl(`of:fid1:${HASH}`)).toEqual({
          id: `of:fid1:${HASH}`,
          path: [],
        });
      });

      it("preserves a scheme that is not `of:`", () => {
        expect(parseFabricUrl(`computed:fid1:${HASH}`)?.id).toBe(
          `computed:fid1:${HASH}`,
        );
      });

      it("returns the id for a hash whose colon is percent-encoded", () => {
        expect(parseFabricUrl(`fid1%3A${HASH}`)?.id).toBe(`of:fid1:${HASH}`);
      });

      it("returns undefined for prose that merely says fid1", () => {
        expect(parseFabricUrl("fid1")).toBeUndefined();
        expect(parseFabricUrl("fid1:short")).toBeUndefined();
      });
    });

    it("trims identifier padding while preserving path whitespace", () => {
      expect(parseFabricUrl(`  of:fid1:${HASH}  `)?.id).toBe(`of:fid1:${HASH}`);
      expect(parseFabricUrl(`/of:fid1:${HASH}/title `)?.path).toEqual([
        "title ",
      ]);
    });

    it("trims rooted ID padding without trimming path keys", () => {
      for (const prefix of ["/", `//${SPACE}/`, `/@${SPACE}/`]) {
        const ref = `${prefix}of:fid1:${HASH}`;
        expect(parseFabricUrl(`  ${ref}  `)?.id).toBe(`of:fid1:${HASH}`);
        expect(parseFabricUrl(`${ref}/title `)?.path).toEqual(["title "]);
        expect(parseFabricUrl(`${ref}/ `)?.path).toEqual([" "]);
        expect(parseFabricUrl(`${ref}/`)?.path).toEqual([""]);
      }
    });

    describe("a rooted link", () => {
      it("returns the id", () => {
        expect(parseFabricUrl(`/of:fid1:${HASH}`)).toEqual({
          space: undefined,
          id: `of:fid1:${HASH}`,
          path: [],
        });
      });

      it("returns the path below the cell", () => {
        expect(parseFabricUrl(`/of:fid1:${HASH}/summary/text`)?.path).toEqual([
          "summary",
          "text",
        ]);
      });

      it("returns the space when the link carries one", () => {
        const target = parseFabricUrl(`/@${SPACE}/of:fid1:${HASH}/summary`);
        expect(target?.space).toBe(SPACE);
        expect(target?.id).toBe(`of:fid1:${HASH}`);
        expect(target?.path).toEqual(["summary"]);
      });

      it("reads complete references, members, scopes, and empty path keys", () => {
        expect(
          parseFabricUrl(`//${SPACE}/of:fid1:${HASH}#argument@scope=user//`),
        ).toEqual({
          space: SPACE,
          id: `of:fid1:${HASH}`,
          member: "argument",
          scope: "user",
          path: ["", ""],
        });
        expect(parseFabricUrl(`/of:fid1:${HASH}/a%2Fb`)?.path).toEqual(["a/b"]);
        expect(parseFabricUrl(`/of:fid1:${HASH}@owner`)).toBeUndefined();
      });

      it("returns undefined for a rooted path naming no id", () => {
        expect(parseFabricUrl("/notes/mine")).toBeUndefined();
      });

      it("returns undefined for a bare slash", () => {
        expect(parseFabricUrl("/")).toBeUndefined();
      });
    });

    describe("a page URL", () => {
      const options = { hosts: HOSTS };

      it("returns the space and id", () => {
        expect(
          parseFabricUrl(
            `https://fabric.example/work/of:fid1:${HASH}`,
            options,
          ),
        )
          .toEqual({ space: "work", id: `of:fid1:${HASH}`, path: [] });
      });

      it("returns the id for a bare hash in the path", () => {
        expect(
          parseFabricUrl(`https://fabric.example/work/fid1:${HASH}`, options)
            ?.id,
        )
          .toBe(`of:fid1:${HASH}`);
      });

      it("returns a slug when the last segment is not an id", () => {
        expect(parseFabricUrl("https://fabric.example/work/my-note", options))
          .toEqual({ space: "work", slug: "my-note", path: [] });
      });

      it("returns the path below the piece", () => {
        expect(
          parseFabricUrl("https://fabric.example/work/my-note/summary", options)
            ?.path,
        ).toEqual(["summary"]);
      });

      it("accepts a host carrying a port", () => {
        expect(
          parseFabricUrl(`http://localhost:8000/work/fid1:${HASH}`, options),
        )
          .toBeDefined();
      });

      it("returns undefined for a host that is not ours", () => {
        expect(parseFabricUrl(`https://example.com/work/fid1:${HASH}`, options))
          .toBeUndefined();
      });

      it("returns undefined when no hosts are configured", () => {
        expect(parseFabricUrl(`https://fabric.example/work/fid1:${HASH}`))
          .toBeUndefined();
      });

      it("returns undefined for our own host's shorter pages", () => {
        expect(parseFabricUrl("https://fabric.example/work", options))
          .toBeUndefined();
        expect(parseFabricUrl("https://fabric.example/", options))
          .toBeUndefined();
      });

      it("returns undefined for a segment that is not a valid slug", () => {
        // `slugIdForSpace` validates, and would throw on these — the id it
        // derived would name something the space cannot hold.
        expect(parseFabricUrl("https://fabric.example/work/Hello", options))
          .toBeUndefined();
        expect(parseFabricUrl("https://fabric.example/work/a--b", options))
          .toBeUndefined();
      });

      it("returns undefined for a slug segment carrying a colon it cannot use", () => {
        expect(
          parseFabricUrl("https://fabric.example/work/not:a:slug", options),
        )
          .toBeUndefined();
      });
    });

    describe("escaping", () => {
      it("returns a path key that arrived JSON Pointer-escaped", () => {
        // `createLLMFriendlyLink` writes a key holding `/` as `~1`.
        expect(parseFabricUrl(`/of:fid1:${HASH}/foo~1bar/~0tilde`)?.path)
          .toEqual(["foo/bar", "~tilde"]);
      });

      it("returns a path key that arrived percent-encoded", () => {
        expect(parseFabricUrl(`/of:fid1:${HASH}/a%20b`)?.path).toEqual(["a b"]);
      });

      it("returns undefined for a malformed percent escape", () => {
        // The contract is that an unreadable URL names no cell, not that
        // asking about it throws.
        expect(parseFabricUrl(`/of:fid1:${HASH}/%ZZ`)).toBeUndefined();
        expect(parseFabricUrl("%ZZ")).toBeUndefined();
        expect(
          parseFabricUrl(`https://fabric.example/${SPACE}/${HASH}/%ZZ`, {
            hosts: HOSTS,
          }),
        )
          .toBeUndefined();
        expect(
          parseFabricUrl("https://fabric.example/%ZZ/thing", { hosts: HOSTS }),
        )
          .toBeUndefined();
      });
    });

    describe("everything else", () => {
      it("returns undefined for an ordinary web page", () => {
        expect(parseFabricUrl("https://example.com/blog/post"))
          .toBeUndefined();
      });

      it("returns undefined for an empty string", () => {
        expect(parseFabricUrl("")).toBeUndefined();
        expect(parseFabricUrl("   ")).toBeUndefined();
      });

      it("returns undefined for a malformed URL", () => {
        expect(parseFabricUrl("https://")).toBeUndefined();
      });
    });
  });

  describe("asSpaceSegment()", () => {
    // Exported for `urlToAppView` (`packages/navigation/src/view.ts`), which
    // reads the same mark out of a page URL. Both of the answers below that a
    // caller could mistake for each other — the empty string and `undefined`
    // — are load-bearing there, so both are pinned here rather than left to
    // whichever caller happens to depend on them.

    it("returns the space behind the mark", () => {
      expect(asSpaceSegment("@space")).toBe("space");
      expect(asSpaceSegment(`@${SPACE}`)).toBe(SPACE);
    });

    it("returns undefined for a segment carrying no mark", () => {
      expect(asSpaceSegment("space")).toBeUndefined();
      expect(asSpaceSegment("")).toBeUndefined();
    });

    it("returns the space for a mark that arrived percent-encoded", () => {
      // `%40` is an equivalent encoding of a path `@`, so it marks the space
      // the same way, and what it marks is decoded along with it.
      expect(asSpaceSegment("%40space")).toBe("space");
      expect(asSpaceSegment("@a%20b")).toBe("a b");
    });

    it("returns undefined for a malformed percent escape", () => {
      // The contract the rest of this module holds: a segment this cannot
      // read carries no space, rather than asking about it throwing.
      expect(asSpaceSegment("%ZZ")).toBeUndefined();
      expect(asSpaceSegment("@%ZZ")).toBeUndefined();
    });

    it("returns the empty string for a segment that is nothing but the mark", () => {
      // Not `undefined`: the segment says it is the space and names none,
      // which is what lets a caller tell it from one that never said it was.
      expect(asSpaceSegment("@")).toBe("");
      expect(asSpaceSegment("%40")).toBe("");
    });
  });
});

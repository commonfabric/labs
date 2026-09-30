import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  parseCellReference,
  parsePieceSegment,
  parseReferenceContext,
  parseRelativeReference,
  type ReferenceContext,
  type ReferenceParts,
  renderCellReference,
  renderReferenceContext,
} from "../src/cell-reference.ts";

const context: ReferenceContext = {
  space: "bakery",
  id: "glaze-tracker",
  scope: "user",
  path: ["items", "0"],
};

describe("cell-reference", () => {
  describe("parsePieceSegment()", () => {
    it("reads a piece boundary without resolving its scope", () => {
      expect(parsePieceSegment("glaze-tracker#argument@inherit")).toEqual({
        id: "glaze-tracker",
        member: "argument",
        scope: "inherit",
      });
      expect(parsePieceSegment("glaze~0tracker@scope=user")).toEqual({
        id: "glaze~tracker",
        scope: "user",
      });
      expect(() => parsePieceSegment("glaze-tracker/title"))
        .toThrow(/one piece segment/);
    });
  });
  describe("parseRelativeReference()", () => {
    it("separates leading climbs from literal dot and empty keys", () => {
      const cases = [
        ["../b", 1, ["b"]],
        ["a/../b", 0, ["a", "..", "b"]],
        ["./..", 0, [".."]],
        [".././..", 1, [".."]],
        ["../.././../", 2, ["..", ""]],
        ["./", 0, [""]],
        ["a~1b/~0/..", 0, ["a/b", "~", ".."]],
      ] as const;
      for (const [text, climbs, path] of cases) {
        expect(parseRelativeReference(text)).toEqual({ climbs, path });
      }
    });

    it("leaves member and scope selection unresolved for a route reader", () => {
      expect(parseRelativeReference("../..#argument@inherit/a#argument"))
        .toEqual({
          climbs: 2,
          member: "argument",
          scope: "inherit",
          path: ["a#argument"],
        });
      expect(() => parseRelativeReference("/piece/a")).toThrow(
        /piece-relative/,
      );
      expect(() => parseRelativeReference("")).toThrow(/empty reference/);
    });
  });

  describe("parseCellReference()", () => {
    it("reads complete and space-relative locations without changing their names", () => {
      for (const space of ["bakery", "did:key:z6MkBakery", "user"]) {
        expect(parseCellReference(`//${space}/glaze-tracker/items/0`)).toEqual({
          space,
          id: "glaze-tracker",
          path: ["items", "0"],
        });
      }
      expect(parseCellReference("/glaze-tracker")).toEqual({
        id: "glaze-tracker",
        path: [],
      });
      expect(parseCellReference("/other/items", context)).toEqual({
        space: "bakery",
        id: "other",
        scope: "user",
        path: ["items"],
      });
      expect(parseCellReference("//other/other", context)).toEqual({
        space: "other",
        id: "other",
        scope: "user",
        path: [],
      });
    });

    it("reads the spec's rooted examples as their listed cells", () => {
      const handle = "of:fid1:Glaze";
      const pin = "a".repeat(43);
      const fixtures: [string, Partial<ReferenceParts>][] = [
        [`/${handle}`, { id: handle }],
        ["/glaze-tracker", {}],
        ["/glaze-tracker/items/0/title", { path: ["items", "0", "title"] }],
        ["/glaze-tracker@user", { scope: "user" }],
        ["/glaze-tracker@scope=user", { scope: "user" }],
        ["/glaze-tracker@session/items", { scope: "session", path: ["items"] }],
        ["//bakery/glaze-tracker", { space: "bakery" }],
        [`//did:key:z6MkBakery/${handle}`, {
          space: "did:key:z6MkBakery",
          id: handle,
        }],
        [`/glaze-tracker@pin=${pin}`, { pin }],
        [`/glaze-tracker@user@pin=${pin}`, { scope: "user", pin }],
        ["/glaze-tracker#argument", { member: "argument" }],
        ["/glaze-tracker#argument@user/items", {
          member: "argument",
          scope: "user",
          path: ["items"],
        }],
        ["/glaze-tracker/issue#12", { path: ["issue#12"] }],
        ["/glaze-tracker/items/0#argument", { path: ["items", "0#argument"] }],
        ["/glaze-tracker/", { path: [""] }],
      ];
      for (const [text, parts] of fixtures) {
        const parsed = parseCellReference(text);
        expect({ ...parsed, scope: parsed.scope ?? "space" }).toEqual({
          id: "glaze-tracker",
          scope: "space",
          path: [],
          ...parts,
        });
      }
    });

    it("preserves the DID alias and refuses retired named-space prefixes", () => {
      const space = "did:key:z6MkBakery";
      expect(parseCellReference(`/@${space}/glaze-tracker`)).toEqual(
        parseCellReference(`//${space}/glaze-tracker`),
      );
      expect(() => parseCellReference("/@bakery/glaze-tracker"))
        .toThrow(/retired; use `\/\/bakery\//);
    });

    it("reads scopes and pins in either qualifier order", () => {
      for (const scope of ["space", "user", "session"] as const) {
        expect(parseCellReference(`/glaze-tracker@scope=${scope}`)).toEqual(
          parseCellReference(`/glaze-tracker@${scope}`),
        );
      }
      const pin = "a".repeat(43);
      for (const qualifiers of [`@user@pin=${pin}`, `@pin=${pin}@scope=user`]) {
        expect(parseCellReference(`/glaze-tracker${qualifiers}/items`)).toEqual(
          {
            id: "glaze-tracker",
            scope: "user",
            pin,
            path: ["items"],
          },
        );
      }
      expect(parseCellReference("/glaze-tracker@inherit", context).scope).toBe(
        "user",
      );
      expect(parseCellReference("/glaze-tracker@inherit", {}).scope).toBe(
        "space",
      );
    });

    it("reads the spec's relative examples against the position", () => {
      const fixtures: [string, string[], string?][] = [
        ["title", ["items", "0", "title"]],
        ["./title", ["items", "0", "title"]],
        [".", ["items", "0"]],
        ["./items@user", ["items", "0", "items@user"]],
        ["../1/title", ["items", "1", "title"]],
        [".@session/title", ["items", "0", "title"], "session"],
        [".@space", ["items", "0"], "space"],
        [".@user/../title", ["items", "0", "..", "title"]],
        ["..@user/title", ["items", "title"]],
        ["../..", []],
        [".././..", ["items", ".."]],
        ["./", ["items", "0", ""]],
        ["...", ["items", "0", "..."]],
        [".h", ["items", "0", ".h"]],
        ["a/../../b", ["items", "0", "a", "..", "..", "b"]],
      ];
      for (const [text, path, scope = "user"] of fixtures) {
        expect(parseCellReference(text, context)).toEqual({
          id: context.id,
          space: context.space,
          scope,
          path,
        });
      }
    });

    it("selects members on the piece and resets the path on a document switch", () => {
      expect(parseCellReference("/glaze-tracker#argument@user/items")).toEqual({
        id: "glaze-tracker",
        member: "argument",
        scope: "user",
        path: ["items"],
      });
      expect(parseCellReference(".#argument/items", context)).toEqual({
        id: context.id,
        space: context.space,
        member: "argument",
        scope: "user",
        path: ["items"],
      });
      const argumentsContext: ReferenceContext = {
        ...context,
        member: "argument",
      };
      expect(parseCellReference(".#result/title", argumentsContext).path)
        .toEqual(["title"]);
      expect(parseCellReference(".#argument/title", argumentsContext).path)
        .toEqual(["items", "0", "title"]);
      expect(parseCellReference("title", argumentsContext).member).toBe(
        "argument",
      );
      expect(parseCellReference("/glaze-tracker", argumentsContext).member)
        .toBeUndefined();
    });

    it("preserves empty keys, pointer escapes, and structural characters inside keys", () => {
      expect(
        parseCellReference("/glaze-tracker//a~1b/~0/issue#12/items@user/").path,
      )
        .toEqual(["", "a/b", "~", "issue#12", "items@user", ""]);
      expect(parseCellReference("/glaze-tracker/").path).toEqual([""]);
      expect(parseCellReference("/glaze-tracker/last ").path).toEqual([
        "last ",
      ]);
    });

    it("refuses malformed references with the relevant grammar rule", () => {
      const fixtures: [string, RegExp, ReferenceContext?][] = [
        ["/glaze-tracker@owner", /@name=value/],
        ["/glaze-tracker@user@user", /Duplicate qualifier/],
        ["/glaze-tracker@scope=user@session", /Duplicate qualifier/],
        ["/glaze-tracker@color=pink", /Registered qualifiers/],
        ["/glaze-tracker@pin=x", /43 base64url/],
        ["//bakery", /piece handle/],
        ["/glaze-tracker#items", /#argument.*#result/],
        ["/glaze-tracker#argument#result", /#argument.*#result/],
        ["/glaze-tracker@user#argument", /piece segment/],
        ["items/0", /context piece/],
        ["../../../title", /above the piece/, context],
        ["..#argument/a", /above the piece/, context],
        ["/glaze-tracker@inherit", /requires a reference context/],
        ["//bad@space/glaze-tracker", /Invalid space/],
        ["//bad:space/glaze-tracker", /Invalid space/],
        ["//bad#space/glaze-tracker", /Invalid space/],
        ["///glaze-tracker", /Invalid space/],
        ["", /empty reference/, context],
      ];
      for (const [text, message, base] of fixtures) {
        expect(() => parseCellReference(text, base)).toThrow(message);
      }
    });

    it("reads every head over three climb depths and up to three special keys", () => {
      const base: ReferenceContext = {
        space: "bakery",
        id: "glaze-tracker",
        path: ["a", "b", "c"],
      };
      const keys = ["", ".", "..", "x", "...", ".h"];
      const paths: string[][] = [[]];
      for (let length = 1; length <= 3; length++) {
        paths.push(
          ...paths.filter((path) => path.length === length - 1).flatMap((
            path,
          ) => keys.map((key) => [...path, key])),
        );
      }
      const meanings = new Map<string, string>();
      for (let climbs = 0; climbs <= 3; climbs++) {
        for (const path of paths) {
          const run = Array(climbs).fill("..").join("/");
          const head = climbs === 0 ? "." : `${run}/.`;
          const text = head + (path.length ? "/" + path.join("/") : "");
          const expected = [...base.path!.slice(0, 3 - climbs), ...path];
          expect(parseCellReference(text, base).path).toEqual(expected);
          const prior = meanings.get(text);
          if (prior !== undefined) expect(prior).toBe(JSON.stringify(expected));
          meanings.set(text, JSON.stringify(expected));
        }
        if (climbs) {
          expect(
            parseCellReference(Array(climbs).fill("..").join("/"), base).path,
          )
            .toEqual(base.path!.slice(0, 3 - climbs));
        }
      }
    });
  });

  describe("renderCellReference()", () => {
    it("refuses spaces that would change the reference structure", () => {
      for (
        const space of ["", "foo/bar", "foo@user", "foo#argument", "foo:bar"]
      ) {
        expect(() => renderCellReference({ space, id: "glaze", path: [] }))
          .toThrow(/Invalid space/);
      }
    });

    it("keeps an unscoped cell in base scope under a scoped context", () => {
      const link = { space: "bakery", id: "glaze", path: [] };
      for (const scope of ["user", "session"] as const) {
        const context = { space: "bakery", scope };
        const rendered = renderCellReference(link, context);
        expect(rendered).toBe("/glaze@space");
        expect(parseCellReference(rendered, context).scope).toBe("space");
      }
    });

    it("refuses malformed pins before emitting a reference", () => {
      for (const pin of ["", "short", "a".repeat(42) + "/"]) {
        expect(() => renderCellReference({ id: "glaze", path: [], pin }))
          .toThrow(/43 base64url/);
      }
      const pin = "a".repeat(43);
      expect(
        parseCellReference(renderCellReference({ id: "glaze", path: [], pin }))
          .pin,
      )
        .toBe(pin);
    });

    it("preserves an unresolved space without letting a context fill it", () => {
      const link = { id: "glaze-tracker", scope: "space" as const, path: [""] };
      expect(renderCellReference(link)).toBe("/glaze-tracker@space/");
      expect(parseCellReference(renderCellReference(link))).toEqual(link);
      expect(() => renderCellReference(link, { space: "bakery" })).toThrow(
        /unresolved reference space/,
      );
    });
    it("writes only equal context parts implicitly and falls back on a location difference", () => {
      const link = {
        space: "bakery",
        id: "glaze-tracker",
        scope: "space" as const,
        path: ["items"],
      };
      expect(renderCellReference(link)).toBe(
        "//bakery/glaze-tracker@space/items",
      );
      expect(renderCellReference(link, { space: "bakery", scope: "space" }))
        .toBe("/glaze-tracker/items");
      expect(renderCellReference({ ...link, scope: "user" }, context)).toBe(
        "..",
      );
      expect(
        renderCellReference({ ...link, id: "other", scope: "user" }, context),
      ).toBe("/other/items");
      expect(
        renderCellReference(
          { ...link, member: "argument", scope: "user" },
          context,
        ),
      ).toBe(".#argument/items");
    });

    it("preserves a literal `#argument` path key independently of the member", () => {
      for (const member of ["result", "argument"] as const) {
        const link = {
          space: "bakery",
          id: "glaze-tracker",
          member,
          scope: "space" as const,
          path: ["a#argument"],
        };
        const ref = renderCellReference(link);
        expect(ref).toBe(
          `//bakery/glaze-tracker${
            member === "argument" ? "#argument" : ""
          }@space/a#argument`,
        );
        expect(parseCellReference(ref)).toEqual({
          ...link,
          ...(member === "result" ? { member: undefined } : {}),
        });
      }
    });

    it("round-trips generated links across empty, partial, and positioned contexts", () => {
      const keys = [
        "",
        ".",
        "..",
        "x",
        "...",
        ".h",
        "a/b",
        "a~b",
        "issue#12",
        "a#argument",
        "#argument",
        "items@user",
        ".@user",
        "..#result",
      ];
      const paths: string[][] = [[]];
      for (let depth = 1; depth <= 3; depth++) {
        paths.push(
          ...paths.filter((path) => path.length === depth - 1).flatMap((path) =>
            keys.map((key) => [...path, key])
          ),
        );
      }
      const contexts: ReferenceContext[] = [
        {},
        { scope: "session" },
        { space: "other" },
        { space: "bakery", scope: "space" },
        { ...context, id: "other" },
        context,
        { ...context, member: "argument" },
        { space: "bakery", id: "glaze-tracker", path: [".", "..", ""] },
      ];
      for (const path of paths) {
        for (const scope of ["space", "user", "session"] as const) {
          for (const member of ["result", "argument"] as const) {
            for (const base of contexts) {
              const link = {
                space: "bakery",
                id: "glaze-tracker",
                path,
                scope,
                member,
              };
              const text = renderCellReference(link, base);
              const parsed = parseCellReference(text, base);
              expect({
                ...parsed,
                member: parsed.member ?? "result",
                scope: parsed.scope ?? "space",
              }).toEqual(link);
            }
          }
        }
      }
    });
  });

  describe("reference contexts", () => {
    it("round-trips textual contexts without inventing a scope", () => {
      for (
        const text of [
          "",
          "//bakery",
          "//bakery/glaze-tracker",
          "//bakery/glaze-tracker@user",
          "//bakery/glaze-tracker#argument@session/items/0",
          "//bakery/glaze-tracker/",
        ]
      ) {
        expect(renderReferenceContext(parseReferenceContext(text))).toBe(text);
      }
      expect(parseReferenceContext("//bakery/glaze-tracker").scope)
        .toBeUndefined();
    });
    it("refuses incomplete textual contexts and pins", () => {
      expect(() => parseReferenceContext("/glaze-tracker")).toThrow(/complete/);
      expect(() =>
        parseReferenceContext("//bakery/glaze-tracker@pin=" + "a".repeat(43))
      ).toThrow(/pin/);
      expect(() => renderReferenceContext({ scope: "user" })).toThrow(
        /text form/,
      );
      expect(() => renderReferenceContext({ space: "bakery", scope: "user" }))
        .toThrow(/scope in text/);
    });
  });
});

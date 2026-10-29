import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { parseMountedCallablePath } from "../callable-path.ts";

describe("parseMountedCallablePath()", () => {
  it("returns `null` for a path that is empty or only slashes", () => {
    expect(parseMountedCallablePath("")).toBeNull();
    expect(parseMountedCallablePath("///")).toBeNull();
  });

  it("ignores leading and trailing slashes around a callable path", () => {
    expect(parseMountedCallablePath("/home/pieces/notes/add.handler/"))
      .toEqual({
        spaceName: "home",
        rootKind: "pieces",
        rootName: "notes",
        cellProp: "result",
        cellKey: "add",
        callableKind: "handler",
        rootLevel: true,
      });
  });

  describe("at the root level of a piece or entity", () => {
    it("returns `null` when the root name is empty", () => {
      expect(parseMountedCallablePath("home/pieces//add.handler")).toBeNull();
    });

    it("returns `null` for a root kind other than `pieces` or `entities`", () => {
      expect(parseMountedCallablePath("home/spaces/notes/add.handler"))
        .toBeNull();
    });

    it("returns `null` when the callable's cell key decodes to empty", () => {
      expect(parseMountedCallablePath("home/pieces/notes/%_empty.handler"))
        .toBeNull();
    });
  });

  describe("under a piece or entity's `input` or `result` cell", () => {
    it("returns `null` when the root name is empty", () => {
      expect(parseMountedCallablePath("home/pieces//result/add.handler"))
        .toBeNull();
    });

    it("returns `null` for a root kind other than `pieces` or `entities`", () => {
      expect(parseMountedCallablePath("home/spaces/notes/result/add.handler"))
        .toBeNull();
    });

    it("returns `null` for a cell other than `input` or `result`", () => {
      expect(parseMountedCallablePath("home/pieces/notes/meta/add.handler"))
        .toBeNull();
    });

    it("returns `null` when the callable's cell key decodes to empty", () => {
      expect(
        parseMountedCallablePath("home/pieces/notes/input/%_empty.tool"),
      ).toBeNull();
    });
  });
});

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { FILE_MODE_RX, SYMLINK_MODE } from "../platform.ts";
import { nodeMode, nodeSize } from "../stat.ts";
import type { FsNode } from "../types.ts";

describe("stat", () => {
  describe("nodeMode()", () => {
    it("returns the symlink mode for a symlink, writable or not", () => {
      const node: FsNode = { kind: "symlink", target: "../notes", mtime: 0 };

      expect(nodeMode(node)).toBe(SYMLINK_MODE);
      expect(nodeMode(node, true)).toBe(SYMLINK_MODE);
    });

    it("returns read and execute bits without write for a tool", () => {
      const node: FsNode = {
        kind: "callable",
        callableKind: "tool",
        cellKey: "search",
        cellProp: "result",
        script: new Uint8Array(),
        mtime: 0,
      };

      expect(nodeMode(node)).toBe(FILE_MODE_RX);
    });
  });

  describe("nodeSize()", () => {
    it("returns the byte length of a file's content", () => {
      const node: FsNode = {
        kind: "file",
        content: new TextEncoder().encode("héllo"),
        jsonType: "string",
        mtime: 0,
      };

      expect(nodeSize(node)).toBe(6);
    });

    it("returns the length of a symlink's target", () => {
      const node: FsNode = { kind: "symlink", target: "../notes", mtime: 0 };

      expect(nodeSize(node)).toBe(8);
    });

    it("returns zero for a directory, whatever it holds", () => {
      const node: FsNode = {
        kind: "dir",
        children: new Map([["child", 2n]]),
        mtime: 0,
      };

      expect(nodeSize(node)).toBe(0);
    });
  });
});

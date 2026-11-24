import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { render, safeStringify } from "../lib/render.ts";

describe("render", () => {
  describe("render()", () => {
    let written: string;
    let writeSync: typeof Deno.stdout.writeSync;

    beforeEach(() => {
      written = "";
      writeSync = Deno.stdout.writeSync;
      Deno.stdout.writeSync = (bytes) => {
        written += new TextDecoder().decode(bytes);
        return bytes.length;
      };
    });

    afterEach(() => {
      Deno.stdout.writeSync = writeSync;
    });

    it("writes text as it is, followed by a newline", () => {
      render('{"not": "reformatted"}');

      expect(written).toBe('{"not": "reformatted"}\n');
    });

    it("writes a string as JSON with `json`", () => {
      render("text", { json: true });

      expect(written).toBe('"text"\n');
    });

    it("writes a value that is not a string as JSON, with or without `json`", () => {
      render({ count: 1 });
      render([null]);

      expect(written).toBe('{\n  "count": 1\n}\n[\n  null\n]\n');
    });

    it("writes a value as indented JSON with `json`", () => {
      render({ count: 2n, items: ["a"] }, { json: true });

      expect(written).toBe(
        '{\n  "count": {\n    "$bigint": "2"\n  },\n  "items": [\n    "a"\n  ]\n}\n',
      );
    });
  });

  describe("safeStringify()", () => {
    it("marks a value it has already written, rather than recursing", () => {
      const circular: Record<string, unknown> = { name: "loop" };
      circular.self = circular;

      expect(JSON.parse(safeStringify(circular))).toEqual({
        name: "loop",
        self: "<circular reference>",
      });
    });

    it("marks a value nested past the depth limit", () => {
      expect(JSON.parse(safeStringify({ a: { b: { c: 1 } } }, 1))).toEqual({
        a: { b: "<max depth reached>" },
      });
    });

    it("throws naming the failure when a value cannot be read", () => {
      const unreadable = {
        get field(): never {
          throw new Error("storage is gone");
        },
      };

      expect(() => safeStringify(unreadable)).toThrow(
        "Could not serialize JSON output: ",
      );
      expect(() => safeStringify(unreadable)).toThrow("storage is gone");
    });
  });
});

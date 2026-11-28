import { expect } from "@std/expect";
import { describe, it } from "@commonfabric/test-support/test";

import { createWriterConsole } from "../lib/json-output.ts";

const decoder = new TextDecoder();

describe("json-output", () => {
  describe("createWriterConsole()", () => {
    it("writes every console method's output through the writer", () => {
      const written: string[] = [];
      const writerConsole = createWriterConsole((bytes) => {
        written.push(decoder.decode(bytes));
      });

      writerConsole.log("to stdout");
      writerConsole.error("to stderr");

      expect(written).toEqual(["to stdout\n", "to stderr\n"]);
    });

    it("drops a chunk the writer throws on and offers it the next", () => {
      const written: string[] = [];
      let calls = 0;
      const writerConsole = createWriterConsole((bytes) => {
        calls++;
        if (calls === 1) throw new Error("write failed");
        written.push(decoder.decode(bytes));
      });

      expect(() => writerConsole.log("lost")).not.toThrow();
      writerConsole.warn("kept");
      writerConsole.log("also kept");

      expect(calls).toBe(3);
      expect(written).toEqual(["kept\n", "also kept\n"]);
    });

    it("accepts timeStamp() and writes nothing for it", () => {
      const written: string[] = [];
      const writerConsole = createWriterConsole((bytes) => {
        written.push(decoder.decode(bytes));
      });

      expect(() => writerConsole.timeStamp("label")).not.toThrow();

      expect(written).toEqual([]);
    });
  });
});

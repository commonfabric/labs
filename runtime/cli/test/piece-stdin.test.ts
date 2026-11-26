import { expect } from "@std/expect";

import { drainStdin } from "../commands/piece.ts";
import { readTerminalLine, type TerminalStreams } from "../lib/piece.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** A terminal whose input arrives in `chunks`, recording what was written. */
function terminal(chunks: string[]): TerminalStreams & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    input: streamOf(chunks),
    output: {
      write: (bytes) => {
        written.push(new TextDecoder().decode(bytes));
        return Promise.resolve(bytes.length);
      },
    },
  };
}

/** A stream that delivers `chunks` and ends. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("piece-stdin", () => {
  describe("readTerminalLine()", () => {
    it("writes the prompt and returns the first line, across chunks and without its line ending", async () => {
      const term = terminal(["RELE", "ASE\r\n", "ignored\n"]);

      expect(await readTerminalLine("Type RELEASE: ", term)).toBe("RELEASE");
      expect(term.written).toEqual(["Type RELEASE: "]);
    });

    it("returns what was typed before the input ended without a line ending", async () => {
      expect(await readTerminalLine("> ", terminal(["partial"]))).toBe(
        "partial",
      );
    });

    it("returns `null` for input that ends before anything is typed", async () => {
      expect(await readTerminalLine("> ", terminal([]))).toBeNull();
    });

    it("leaves the input unlocked for the next reader", async () => {
      const term = terminal(["first\n"]);

      await readTerminalLine("> ", term);

      expect(term.input.locked).toBe(false);
    });
  });

  describe("drainStdin()", () => {
    it("returns the JSON value the whole input spells, across chunks", async () => {
      expect(await drainStdin(streamOf(['{"foo":', " 5}"]))).toEqual({
        foo: 5,
      });
    });

    it("throws quoting input that is not JSON", async () => {
      await expect(drainStdin(streamOf(["{oops"]))).rejects.toThrow(
        'Could not parse STDIN as JSON: "{oops".',
      );
    });
  });
});
